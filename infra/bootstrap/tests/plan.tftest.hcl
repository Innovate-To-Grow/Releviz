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
    production_domain_name            = "releviz.com"
    production_amplify_app_id         = "dsecure123"
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    production_secret_arns = [
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:django",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:default-admin-password",
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
      length(local.production_kms_policy) <= 10240 &&
      length(local.production_deploy_policy) + length(local.production_kms_policy) < 10240 &&
      !strcontains(local.production_deploy_policy, "AdministratorAccess") &&
      !strcontains(local.production_deploy_policy, "iam:*")
    )
    error_message = "The production deploy and KMS inline policies must individually fit, and collectively stay below, the 10,240-character per-role AWS limit while remaining narrower than administrator IAM access."
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
      strcontains(local.production_deploy_policy, "secretsmanager:CreateSecret") &&
      strcontains(local.production_deploy_policy, "secretsmanager:TagResource") &&
      strcontains(local.production_deploy_policy, "arn:aws:secretsmanager:us-west-2:123456789012:secret:rds!db-*")
    )
    error_message = "The production role must create only RDS-managed master-password secrets."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action
        if statement.Sid == "ApplicationSecretsMetadata"
        ]) == [
        "secretsmanager:DescribeSecret",
      ] &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "ApplicationSecretsMetadata"
        ]) == [
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:django",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:default-admin-password",
      ]
    )
    error_message = "The production role must be limited to metadata reads for the four exact application secrets."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action
        if statement.Sid == "RunProductionDefaultAdminTask"
        ]) == [
        "ecs:RunTask",
      ] &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "RunProductionDefaultAdminTask"
      ]) == "arn:aws:ecs:us-west-2:123456789012:task-definition/releviz-prod-default-admin-task:*" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.ArnEquals["ecs:cluster"]
        if statement.Sid == "RunProductionDefaultAdminTask"
      ]) == "arn:aws:ecs:us-west-2:123456789012:cluster/releviz-prod-cluster" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["aws:RequestTag/Project"]
        if statement.Sid == "RunProductionDefaultAdminTask"
      ]) == "releviz" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["aws:RequestTag/Environment"]
        if statement.Sid == "RunProductionDefaultAdminTask"
      ]) == "prod" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["aws:RequestTag/Purpose"]
        if statement.Sid == "RunProductionDefaultAdminTask"
      ]) == "default-admin-bootstrap" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]
        if statement.Sid == "RunProductionDefaultAdminTask"
        ]) == [
        "Project",
        "Environment",
        "Purpose",
      ]
    )
    error_message = "The production role may run only the tagged default-admin task family and only in the exact production cluster."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action
        if statement.Sid == "StopProductionDefaultAdminTask"
        ]) == [
        "ecs:StopTask",
      ] &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "StopProductionDefaultAdminTask"
      ]) == "arn:aws:ecs:us-west-2:123456789012:task/releviz-prod-cluster/*" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.ArnEquals["ecs:cluster"]
        if statement.Sid == "StopProductionDefaultAdminTask"
      ]) == "arn:aws:ecs:us-west-2:123456789012:cluster/releviz-prod-cluster" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["aws:ResourceTag/Project"]
        if statement.Sid == "StopProductionDefaultAdminTask"
      ]) == "releviz" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["aws:ResourceTag/Environment"]
        if statement.Sid == "StopProductionDefaultAdminTask"
      ]) == "prod" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["aws:ResourceTag/Purpose"]
        if statement.Sid == "StopProductionDefaultAdminTask"
      ]) == "default-admin-bootstrap"
    )
    error_message = "Compensating cleanup may stop only tagged default-admin bootstrap tasks in the exact production cluster."
  }

  assert {
    condition = (
      !contains(one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action
        if statement.Sid == "ProductionPlatform"
      ]), "ecs:RunTask") &&
      !contains(one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action
        if statement.Sid == "ProductionPlatform"
      ]), "ecs:StopTask")
    )
    error_message = "Broad production platform permissions must not include RunTask or StopTask."
  }

  assert {
    condition = (
      strcontains(local.production_deploy_policy, "application-autoscaling:ListTagsForResource") &&
      strcontains(local.production_deploy_policy, "elasticloadbalancing:AddListenerCertificates") &&
      strcontains(local.production_deploy_policy, "elasticloadbalancing:RemoveListenerCertificates") &&
      strcontains(local.production_deploy_policy, "amplify:CreateDeployment") &&
      strcontains(local.production_deploy_policy, "amplify:StartDeployment") &&
      strcontains(local.production_deploy_policy, "amplify:CreateDomainAssociation") &&
      strcontains(local.production_deploy_policy, "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/branches/candidate") &&
      strcontains(local.production_deploy_policy, "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/branches/main") &&
      strcontains(local.production_deploy_policy, "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/domains/releviz.com") &&
      !strcontains(local.production_deploy_policy, "arn:aws:amplify:us-west-2:123456789012:apps/*") &&
      !strcontains(local.production_deploy_policy, "\"amplify:CreateApp\"") &&
      !strcontains(local.production_deploy_policy, "\"amplify:CreateBranch\"") &&
      !strcontains(local.production_deploy_policy, "\"amplify:TagResource\"") &&
      !strcontains(local.production_deploy_policy, "\"amplify:UntagResource\"") &&
      !strcontains(local.production_deploy_policy, "\"amplify:StartJob\"") &&
      !strcontains(local.production_deploy_policy, "amplify:DeleteApp") &&
      !strcontains(local.production_deploy_policy, "amplify:DeleteBranch") &&
      !strcontains(local.production_deploy_policy, "amplify:DeleteDomainAssociation") &&
      strcontains(local.production_kms_policy, "kms:CreateGrant") &&
      strcontains(local.production_kms_policy, "rds.us-west-2.amazonaws.com") &&
      strcontains(local.production_kms_policy, "secretsmanager.us-west-2.amazonaws.com")
    )
    error_message = "The production role must deploy Amplify branches, read autoscaling tags, and use KMS through RDS and Secrets Manager."
  }

  assert {
    condition     = aws_iam_role.production_deploy.max_session_duration == 10800
    error_message = "The production OIDC role must outlive the bounded two-hour release workflow."
  }

  assert {
    condition = (
      alltrue([
        for action in [
          "amplify:CreateDeployment",
          "amplify:StartDeployment",
        ] :
        contains(one([
          for statement in jsondecode(local.production_deploy_policy).Statement :
          statement.Action
          if statement.Sid == "ManageExactProductionAmplifyBranches"
        ]), action) &&
        contains(one([
          for statement in jsondecode(local.production_deploy_policy).Statement :
          statement.Action
          if statement.Sid == "ManageExactProductionAmplifyDeployments"
        ]), action)
      ]) &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "ManageExactProductionAmplifyDeployments"
        ]) == [
        "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/branches/candidate/deployments/*",
        "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/branches/main/deployments/*",
      ] &&
      contains(one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action
        if statement.Sid == "ManageExactProductionAmplifyBranches"
      ]), "amplify:ListJobs") &&
      contains(one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action
        if statement.Sid == "ManageExactProductionAmplifyJobs"
      ]), "amplify:ListJobs") &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "ManageExactProductionAmplifyApp"
      ]) == "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["aws:ResourceTag/Project"]
        if statement.Sid == "ManageExactProductionAmplifyApp"
      ]) == "releviz" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["aws:ResourceTag/Environment"]
        if statement.Sid == "ManageExactProductionAmplifyApp"
      ]) == "prod" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "ManageExactProductionAmplifyBranches"
        ]) == [
        "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/branches/candidate",
        "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/branches/main",
      ]
    )
    error_message = "The steady-state role must manage only the exact pre-provisioned app and its two release branches."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "ManageExactProductionAmplifyJobs"
        ]) == [
        "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/branches/candidate/jobs/*",
        "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/branches/main/jobs/*",
      ] &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "ManageExactProductionAmplifyDomain"
      ]) == "arn:aws:amplify:us-west-2:123456789012:apps/dsecure123/domains/releviz.com"
    )
    error_message = "Manual deployment and ListJobs actions must cover documented and live runtime scopes while remaining limited to the exact release resources."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action
        if statement.Sid == "DiscoverProductionRoute53HostedZones"
      ]) == ["route53:ListHostedZones"] &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource
        if statement.Sid == "DiscoverProductionRoute53HostedZones"
      ]) == "*"
    )
    error_message = "Amplify domain association must discover Route53 hosted zones with only the required account-level list action."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource if statement.Sid == "ProductionIamRoles"
      ]) == "arn:aws:iam::123456789012:role/releviz-prod-*" &&
      !contains(one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action if statement.Sid == "ProductionIamRoles"
      ]), "iam:PassRole") &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action if statement.Sid == "PassExactProductionEcsRoles"
      ]) == ["iam:PassRole"] &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource if statement.Sid == "PassExactProductionEcsRoles"
        ]) == [
        "arn:aws:iam::123456789012:role/releviz-prod-ecs-execution-role",
        "arn:aws:iam::123456789012:role/releviz-prod-ecs-task-role",
      ] &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["iam:PassedToService"]
        if statement.Sid == "PassExactProductionEcsRoles"
      ]) == "ecs-tasks.amazonaws.com" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Action if statement.Sid == "PassExactProductionEventBridgeRole"
      ]) == ["iam:PassRole"] &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Resource if statement.Sid == "PassExactProductionEventBridgeRole"
      ]) == "arn:aws:iam::123456789012:role/releviz-prod-eventbridge-reminders-role" &&
      one([
        for statement in jsondecode(local.production_deploy_policy).Statement :
        statement.Condition.StringEquals["iam:PassedToService"]
        if statement.Sid == "PassExactProductionEventBridgeRole"
      ]) == "events.amazonaws.com"
    )
    error_message = "Role management must exclude PassRole; only exact ECS and EventBridge roles may be passed to their trusted services."
  }
}

run "bootstrap_plan_before_amplify_provisioning" {
  command = plan

  variables {
    state_bucket_name                 = "releviz-prod-terraform-state-123456789012"
    production_route53_zone_id        = "Z1234567890"
    production_domain_name            = "releviz.com"
    production_amplify_app_id         = ""
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    production_secret_arns = [
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:django",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:default-admin-password",
    ]
  }

  assert {
    condition = (
      length(local.production_amplify_policy_statements) == 0 &&
      !strcontains(local.production_deploy_policy, "\"amplify:")
    )
    error_message = "Before the exact app ID is registered, the GitHub role must have no Amplify API permissions."
  }
}

run "reject_duplicate_production_secret_arns" {
  command = plan

  variables {
    production_route53_zone_id        = "Z1234567890"
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    production_secret_arns = [
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:django",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics",
    ]
  }

  expect_failures = [var.production_secret_arns]
}

run "reject_invalid_production_secret_arn" {
  command = plan

  variables {
    production_route53_zone_id        = "Z1234567890"
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    production_secret_arns = [
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:django",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics",
      "not-a-secrets-manager-arn",
    ]
  }

  expect_failures = [var.production_secret_arns]
}
