mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:role/bootstrap-test"
      user_id    = "AROATEST"
    }
  }
}

run "bootstrap_plan" {
  command = plan

  variables {
    state_bucket_name                 = "releviz-prod-terraform-state-123456789012"
    production_route53_zone_id        = "Z1234567890"
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    production_secret_arns = [
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:django",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics",
    ]
  }

  assert {
    condition = (
      aws_s3_bucket_versioning.terraform_state.versioning_configuration[0].status == "Enabled" &&
      alltrue([
        for rule in aws_s3_bucket_server_side_encryption_configuration.terraform_state.rule :
        alltrue([
          for encryption in rule.apply_server_side_encryption_by_default :
          encryption.sse_algorithm == "AES256"
        ])
      ]) &&
      aws_s3_bucket_public_access_block.terraform_state.block_public_acls &&
      aws_s3_bucket_public_access_block.terraform_state.block_public_policy &&
      aws_s3_bucket_public_access_block.terraform_state.ignore_public_acls &&
      aws_s3_bucket_public_access_block.terraform_state.restrict_public_buckets
    )
    error_message = "Terraform state must be versioned, encrypted, and private."
  }

  assert {
    condition = (
      strcontains(aws_iam_role.production_deploy.assume_role_policy, "repo:Innovate-To-Grow/releviz:environment:Production") &&
      strcontains(aws_iam_role.production_deploy.assume_role_policy, "sts.amazonaws.com") &&
      strcontains(aws_iam_role.production_deploy.assume_role_policy, var.existing_github_oidc_provider_arn)
    )
    error_message = "The production role must trust only the repository's Production Environment through the shared GitHub OIDC provider."
  }

  assert {
    condition = (
      length(local.production_deploy_policy) <= 10240 &&
      !strcontains(local.production_deploy_policy, "AdministratorAccess") &&
      !strcontains(local.production_deploy_policy, "iam:*")
    )
    error_message = "The production inline policy must fit AWS limits and remain narrower than administrator IAM access."
  }

  assert {
    condition = (
      strcontains(local.production_deploy_policy, "s3:GetEncryptionConfiguration") &&
      !strcontains(local.production_deploy_policy, "s3:GetBucketEncryption")
    )
    error_message = "The production role must use the IAM action required to inspect state-bucket encryption."
  }

  assert {
    condition = (
      strcontains(local.production_deploy_policy, "servicequotas:GetServiceQuota") &&
      strcontains(local.production_deploy_policy, "arn:aws:servicequotas:us-west-2:123456789012:ec2/L-0263D0A3")
    )
    error_message = "The production role must read the regional EC2-VPC Elastic IP quota used by deployment preflight."
  }

  assert {
    condition = (
      strcontains(local.production_deploy_policy, "application-autoscaling:ListTagsForResource") &&
      strcontains(local.production_kms_policy, "kms:CreateGrant") &&
      strcontains(local.production_kms_policy, "rds.us-west-2.amazonaws.com") &&
      strcontains(local.production_kms_policy, "secretsmanager.us-west-2.amazonaws.com")
    )
    error_message = "The production role must read autoscaling tags and use KMS through RDS and Secrets Manager."
  }
}
