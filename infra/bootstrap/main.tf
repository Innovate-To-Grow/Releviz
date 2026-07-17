terraform {
  required_version = ">= 1.15.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
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
  default = "scheduler-prod-terraform-state"
}

variable "lock_table_name" {
  type    = string
  default = "scheduler-prod-terraform-locks"
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
  default     = ""
  description = "Existing account-wide GitHub Actions OIDC provider ARN, when already provisioned"
}

variable "production_deploy_role_name" {
  type    = string
  default = "scheduler-production-github-deploy"
}

variable "production_route53_zone_id" {
  type        = string
  description = "Route53 hosted-zone ID the production deployment may update"
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
  default     = "scheduler-prod-"
  description = "Prefix limiting ECR repositories managed by the production deployment role"
}

data "aws_caller_identity" "current" {}

data "tls_certificate" "github" {
  count = var.existing_github_oidc_provider_arn == "" ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
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

resource "aws_iam_openid_connect_provider" "github" {
  count = var.existing_github_oidc_provider_arn == "" ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github[0].certificates[0].sha1_fingerprint]
}

locals {
  github_oidc_provider_arn = (
    var.existing_github_oidc_provider_arn != "" ?
    var.existing_github_oidc_provider_arn :
    aws_iam_openid_connect_provider.github[0].arn
  )
  production_role_prefix_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/scheduler-prod-*"
  production_ecr_arn         = "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/${var.production_ecr_repository_prefix}*"
  terraform_state_bucket_arn = "arn:aws:s3:::${var.state_bucket_name}"
}

resource "aws_iam_role" "production_deploy" {
  name                 = var.production_deploy_role_name
  max_session_duration = 3600

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
    Statement = [
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
            ]
          }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "production_deploy" {
  name   = "scheduler-production-deploy"
  role   = aws_iam_role.production_deploy.id
  policy = local.production_deploy_policy
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
