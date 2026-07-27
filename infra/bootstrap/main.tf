terraform {
  required_version = ">= 1.15.0"

  # Bootstrap starts with `terraform init -backend=false` while the bucket is
  # created, then its local state is migrated to bootstrap/terraform.tfstate.
  # Keeping the backend declaration here prevents future bootstrap work from
  # silently falling back to untracked local state.
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.56"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "state_bucket_name" {
  type    = string
  default = "releviz-prod-terraform-state"
}

variable "lock_table_name" {
  type    = string
  default = "releviz-prod-terraform-locks"
}

variable "github_repository" {
  type        = string
  default     = "Innovate-To-Grow/releviz"
  description = "GitHub owner/repository allowed to request production deployment credentials"
}

variable "github_environment" {
  type        = string
  default     = "Production"
  description = "Protected GitHub Environment included in the OIDC subject"
}

variable "existing_github_oidc_provider_arn" {
  type        = string
  description = "Existing account-wide GitHub Actions OIDC provider ARN; bootstrap never creates or deletes this shared resource"

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.existing_github_oidc_provider_arn))
    error_message = "existing_github_oidc_provider_arn must be the account's GitHub Actions OIDC provider ARN."
  }
}

variable "production_deploy_role_name" {
  type    = string
  default = "releviz-production-github-deploy"
}

variable "production_route53_zone_id" {
  type        = string
  description = "Route53 hosted-zone ID the production deployment may update"
}

variable "production_domain_name" {
  type        = string
  default     = "releviz.com"
  description = "Canonical domain that the production Amplify deployment role may associate"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.production_domain_name))
    error_message = "production_domain_name must be a lowercase fully qualified hostname."
  }
}

variable "production_amplify_app_id" {
  type        = string
  default     = ""
  description = "Exact production Amplify app ID. Leave empty only during the administrator-run provisioning phase; re-apply bootstrap with the prod amplify_app_id output before enabling GitHub deployments."

  validation {
    condition     = var.production_amplify_app_id == "" || can(regex("^d[a-z0-9]{1,19}$", var.production_amplify_app_id))
    error_message = "production_amplify_app_id must be empty or an Amplify app ID matching d[a-z0-9]+ (maximum 20 characters)."
  }
}

variable "production_secret_arns" {
  type        = list(string)
  description = "Application secret ARNs the production workflow may validate"

  validation {
    condition     = length(var.production_secret_arns) >= 3
    error_message = "Provide the Django key, field-encryption key, and metrics-token secret ARNs."
  }
}

variable "production_ecr_repository_prefix" {
  type        = string
  default     = "releviz-prod-"
  description = "Prefix limiting ECR repositories managed by the production deployment role"
}

data "aws_caller_identity" "current" {}

# Older local bootstrap state may still contain the account-wide OIDC provider
# that this module used to create. Forget that legacy state address without
# destroying the shared provider; I2G and other repositories may depend on it.
removed {
  from = aws_iam_openid_connect_provider.github

  lifecycle {
    destroy = false
  }
}

resource "aws_s3_bucket" "terraform_state" {
  bucket        = var.state_bucket_name
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "terraform_state_tls_only" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.terraform_state.arn,
        "${aws_s3_bucket.terraform_state.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.terraform_state]
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  github_oidc_provider_arn   = var.existing_github_oidc_provider_arn
  production_role_prefix_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/releviz-prod-*"
  production_ecr_arn         = "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/${var.production_ecr_repository_prefix}*"
  rds_managed_secret_arn     = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:rds!db-*"
  terraform_state_bucket_arn = "arn:aws:s3:::${var.state_bucket_name}"
  production_amplify_app_arn = "arn:aws:amplify:${var.aws_region}:${data.aws_caller_identity.current.account_id}:apps/${var.production_amplify_app_id}"
  production_amplify_branch_arns = [
    "${local.production_amplify_app_arn}/branches/candidate",
    "${local.production_amplify_app_arn}/branches/main",
  ]
  production_amplify_job_arns = [
    for branch_arn in local.production_amplify_branch_arns : "${branch_arn}/jobs/*"
  ]
  production_amplify_domain_arn = "${local.production_amplify_app_arn}/domains/${var.production_domain_name}"
}

locals {
  # Amplify app and branch creation is deliberately excluded from the GitHub
  # role. An administrator creates them with provision-amplify.sh, records the
  # resulting app ID, and re-applies this bootstrap module with that exact ID.
  # Until then, the production role receives no Amplify permissions.
  production_amplify_policy_statements = [
    for statement in jsondecode(jsonencode([
      {
        Sid    = "ManageExactProductionAmplifyApp"
        Effect = "Allow"
        Action = [
          "amplify:GetApp",
          "amplify:ListBranches",
          "amplify:ListDomainAssociations",
          "amplify:ListTagsForResource",
          "amplify:UpdateApp",
        ]
        Resource = local.production_amplify_app_arn
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Project"     = "releviz"
            "aws:ResourceTag/Environment" = "prod"
          }
        }
      },
      {
        Sid    = "ManageExactProductionAmplifyBranches"
        Effect = "Allow"
        Action = [
          "amplify:CreateDeployment",
          "amplify:GetBranch",
          "amplify:ListJobs",
          "amplify:ListTagsForResource",
          "amplify:StartDeployment",
          "amplify:UpdateBranch",
        ]
        Resource = local.production_amplify_branch_arns
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Project"     = "releviz"
            "aws:ResourceTag/Environment" = "prod"
          }
        }
      },
      {
        # Amplify jobs do not expose resource-tag condition keys, so constrain
        # them to the exact app and the two release branches.
        Sid    = "ManageExactProductionAmplifyJobs"
        Effect = "Allow"
        Action = [
          "amplify:GetJob",
          "amplify:StartJob",
          "amplify:StopJob",
        ]
        Resource = local.production_amplify_job_arns
      },
      {
        # The protected release performs the one-time canonical-domain cutover
        # only after both exact artifacts pass smoke tests. This write remains
        # limited to one domain on one pre-provisioned app.
        Sid    = "ManageExactProductionAmplifyDomain"
        Effect = "Allow"
        Action = [
          "amplify:CreateDomainAssociation",
          "amplify:GetDomainAssociation",
          "amplify:ListTagsForResource",
          "amplify:UpdateDomainAssociation",
        ]
        Resource = local.production_amplify_domain_arn
      },
    ])) : statement if var.production_amplify_app_id != ""
  ]
}

resource "aws_iam_role" "production_deploy" {
  name                 = var.production_deploy_role_name
  max_session_duration = 10800

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = local.github_oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${var.github_environment}"
        }
      }
    }]
  })
}

locals {
  production_deploy_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid    = "TerraformStateBucket"
        Effect = "Allow"
        Action = [
          "s3:GetEncryptionConfiguration",
          "s3:GetBucketLocation",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketVersioning",
          "s3:ListBucket",
        ]
        Resource = local.terraform_state_bucket_arn
      },
      {
        Sid    = "TerraformStateObjects"
        Effect = "Allow"
        Action = [
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:PutObject",
        ]
        Resource = "${local.terraform_state_bucket_arn}/prod/*"
      },
      {
        Sid      = "IdentityAndEcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken", "sts:GetCallerIdentity"]
        Resource = "*"
      },
      ], local.production_amplify_policy_statements, [
      {
        Sid    = "ImmutableProductionImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:CreateRepository",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:ListImages",
          "ecr:PutImage",
          "ecr:PutImageScanningConfiguration",
          "ecr:PutImageTagMutability",
          "ecr:TagResource",
          "ecr:UploadLayerPart",
        ]
        Resource = local.production_ecr_arn
      },
      {
        Sid      = "ApplicationSecretsMetadata"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret"]
        Resource = var.production_secret_arns
      },
      {
        Sid    = "RdsManagedMasterSecret"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:TagResource",
        ]
        Resource = local.rds_managed_secret_arn
      },
      {
        Sid    = "ProductionNetwork"
        Effect = "Allow"
        Action = [
          "ec2:AllocateAddress",
          "ec2:AssociateRouteTable",
          "ec2:AttachInternetGateway",
          "ec2:AuthorizeSecurityGroupEgress",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:CreateInternetGateway",
          "ec2:CreateNatGateway",
          "ec2:CreateRoute",
          "ec2:CreateRouteTable",
          "ec2:CreateSecurityGroup",
          "ec2:CreateSubnet",
          "ec2:CreateTags",
          "ec2:CreateVpc",
          "ec2:DeleteInternetGateway",
          "ec2:DeleteNatGateway",
          "ec2:DeleteRoute",
          "ec2:DeleteRouteTable",
          "ec2:DeleteSecurityGroup",
          "ec2:DeleteSubnet",
          "ec2:DeleteTags",
          "ec2:DeleteVpc",
          "ec2:Describe*",
          "ec2:DetachInternetGateway",
          "ec2:DisassociateRouteTable",
          "ec2:GetManagedPrefixListEntries",
          "ec2:ModifySubnetAttribute",
          "ec2:ModifyVpcAttribute",
          "ec2:ReleaseAddress",
          "ec2:ReplaceRoute",
          "ec2:RevokeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress",
        ]
        Resource = "*"
      },
      {
        Sid    = "ProductionPlatform"
        Effect = "Allow"
        Action = [
          "acm:AddTagsToCertificate",
          "acm:DeleteCertificate",
          "acm:DescribeCertificate",
          "acm:ListTagsForCertificate",
          "acm:RemoveTagsFromCertificate",
          "acm:RequestCertificate",
          "application-autoscaling:DeleteScalingPolicy",
          "application-autoscaling:DeregisterScalableTarget",
          "application-autoscaling:DescribeScalingPolicies",
          "application-autoscaling:DescribeScalableTargets",
          "application-autoscaling:ListTagsForResource",
          "application-autoscaling:PutScalingPolicy",
          "application-autoscaling:RegisterScalableTarget",
          "application-autoscaling:TagResource",
          "application-autoscaling:UntagResource",
          "cloudwatch:DeleteAlarms",
          "cloudwatch:DescribeAlarms",
          "cloudwatch:ListTagsForResource",
          "cloudwatch:PutMetricAlarm",
          "cloudwatch:TagResource",
          "cloudwatch:UntagResource",
          "dynamodb:CreateTable",
          "dynamodb:DeleteTable",
          "dynamodb:DescribeContinuousBackups",
          "dynamodb:DescribeTable",
          "dynamodb:DescribeTimeToLive",
          "dynamodb:ListTagsOfResource",
          "dynamodb:TagResource",
          "dynamodb:UntagResource",
          "dynamodb:UpdateContinuousBackups",
          "dynamodb:UpdateTable",
          "ecs:CreateCluster",
          "ecs:CreateService",
          "ecs:DeleteCluster",
          "ecs:DeleteService",
          "ecs:DeregisterTaskDefinition",
          "ecs:Describe*",
          "ecs:List*",
          "ecs:RegisterTaskDefinition",
          "ecs:TagResource",
          "ecs:UntagResource",
          "ecs:UpdateClusterSettings",
          "ecs:UpdateService",
          "elasticloadbalancing:AddTags",
          "elasticloadbalancing:AddListenerCertificates",
          "elasticloadbalancing:CreateListener",
          "elasticloadbalancing:CreateLoadBalancer",
          "elasticloadbalancing:CreateRule",
          "elasticloadbalancing:CreateTargetGroup",
          "elasticloadbalancing:DeleteListener",
          "elasticloadbalancing:DeleteLoadBalancer",
          "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:Describe*",
          "elasticloadbalancing:ModifyListener",
          "elasticloadbalancing:ModifyLoadBalancerAttributes",
          "elasticloadbalancing:ModifyRule",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
          "elasticloadbalancing:RemoveTags",
          "elasticloadbalancing:RemoveListenerCertificates",
          "elasticloadbalancing:SetSecurityGroups",
          "elasticloadbalancing:SetSubnets",
          "events:DeleteRule",
          "events:DescribeRule",
          "events:ListTagsForResource",
          "events:ListTargetsByRule",
          "events:PutRule",
          "events:PutTargets",
          "events:RemoveTargets",
          "events:TagResource",
          "events:UntagResource",
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:DeleteMetricFilter",
          "logs:DescribeLogGroups",
          "logs:DescribeMetricFilters",
          "logs:ListTagsForResource",
          "logs:PutMetricFilter",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource",
          "rds:AddTagsToResource",
          "rds:CreateDBInstance",
          "rds:CreateDBSubnetGroup",
          "rds:DeleteDBInstance",
          "rds:DeleteDBSubnetGroup",
          "rds:Describe*",
          "rds:ListTagsForResource",
          "rds:ModifyDBInstance",
          "rds:ModifyDBSubnetGroup",
          "rds:RemoveTagsFromResource",
        ]
        Resource = "*"
      },
      {
        Sid    = "ProductionDns"
        Effect = "Allow"
        Action = [
          "route53:ChangeResourceRecordSets",
          "route53:GetChange",
          "route53:GetHostedZone",
          "route53:ListResourceRecordSets",
          "route53:ListTagsForResource",
        ]
        Resource = [
          "arn:aws:route53:::hostedzone/${var.production_route53_zone_id}",
          "arn:aws:route53:::change/*",
        ]
      },
      {
        Sid    = "ProductionIamRoles"
        Effect = "Allow"
        Action = [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole",
          "iam:ListRolePolicies",
          "iam:PassRole",
          "iam:PutRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
        ]
        Resource = local.production_role_prefix_arn
      },
      {
        Sid      = "RequiredServiceLinkedRoles"
        Effect   = "Allow"
        Action   = "iam:CreateServiceLinkedRole"
        Resource = "*"
        Condition = {
          StringEquals = {
            "iam:AWSServiceName" = [
              "ecs.amazonaws.com",
              "elasticloadbalancing.amazonaws.com",
              "rds.amazonaws.com",
              "ecs.application-autoscaling.amazonaws.com",
              "amplify.amazonaws.com",
            ]
          }
        }
      },
    ])
  })
}

resource "aws_iam_role_policy" "production_deploy" {
  name   = "releviz-production-deploy"
  role   = aws_iam_role.production_deploy.id
  policy = local.production_deploy_policy
}

locals {
  production_kms_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DiscoverRegionalKmsKeys"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey", "kms:ListAliases"]
        Resource = "*"
      },
      {
        Sid    = "UseKmsThroughManagedServices"
        Effect = "Allow"
        Action = [
          "kms:CreateGrant",
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = [
              "rds.${var.aws_region}.amazonaws.com",
              "secretsmanager.${var.aws_region}.amazonaws.com",
            ]
          }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "production_deploy_kms" {
  name   = "releviz-production-deploy-kms"
  role   = aws_iam_role.production_deploy.id
  policy = local.production_kms_policy
}

output "state_bucket_name" {
  value = aws_s3_bucket.terraform_state.bucket
}

output "lock_table_name" {
  value = aws_dynamodb_table.terraform_locks.name
}

output "production_deploy_role_arn" {
  value = aws_iam_role.production_deploy.arn
}

output "production_amplify_app_id" {
  value       = var.production_amplify_app_id
  description = "Exact Amplify app ID authorized for the production GitHub role; empty until the administrator completes provisioning"
}
