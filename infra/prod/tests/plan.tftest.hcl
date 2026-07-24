mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:role/terraform-test"
      user_id    = "AROATEST"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-west-2a", "us-west-2b", "us-west-2c"]
    }
  }

  mock_data "aws_kms_alias" {
    defaults = {
      arn            = "arn:aws:kms:us-west-2:123456789012:alias/aws/mock"
      target_key_arn = "arn:aws:kms:us-west-2:123456789012:key/test"
      target_key_id  = "test"
    }
  }

  mock_resource "aws_db_instance" {
    defaults = {
      address = "production-db.example.internal"
      port    = 5432
      master_user_secret = [{
        kms_key_id    = "arn:aws:kms:us-west-2:123456789012:key/test"
        secret_arn    = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rds-master"
        secret_status = "active"
      }]
    }
  }
}

run "production_plan" {
  command = plan

  variables {
    backend_image_tag               = "0123456789abcdef0123456789abcdef01234567"
    frontend_image_tag              = "0123456789abcdef0123456789abcdef01234567"
    django_secret_key_arn           = "arn:aws:secretsmanager:us-west-2:123456789012:secret:django"
    django_field_encryption_key_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key"
    metrics_bearer_token_arn        = "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics"
    alarm_action_arns               = ["arn:aws:sns:us-west-2:123456789012:production-alerts"]
    custom_domain                   = "production.releviz.com"
    route53_zone_id                 = "Z1234567890"
    manage_dns                      = true
    existing_acm_certificate_arn    = "arn:aws:acm:us-west-2:123456789012:certificate/test"
  }

  assert {
    condition = (
      aws_lb_target_group.backend.health_check[0].path == "/api/health" &&
      aws_lb_target_group.frontend.health_check[0].path == "/"
    )
    error_message = "Production must health-check the database-aware backend endpoint and the frontend root."
  }

  assert {
    condition = (
      aws_db_instance.app.storage_encrypted &&
      aws_db_instance.app.kms_key_id == data.aws_kms_alias.rds.target_key_arn &&
      aws_db_instance.app.multi_az &&
      !aws_db_instance.app.publicly_accessible &&
      aws_db_instance.app.manage_master_user_password &&
      aws_db_instance.app.master_user_secret_kms_key_id == data.aws_kms_alias.secretsmanager.target_key_arn &&
      aws_db_instance.app.deletion_protection &&
      !aws_db_instance.app.skip_final_snapshot &&
      !aws_db_instance.app.delete_automated_backups &&
      aws_db_instance.app.instance_class == "db.t4g.medium" &&
      aws_db_instance.app.backup_retention_period == 30 &&
      aws_db_instance.app.copy_tags_to_snapshot
    )
    error_message = "Production PostgreSQL must use the db.t4g.medium baseline, be private, Multi-AZ, encrypted, deletion-protected, and retain automated and final backups."
  }

  assert {
    condition = alltrue([
      for service in [aws_ecs_service.backend, aws_ecs_service.frontend] :
      service.desired_count >= 2 &&
      service.deployment_minimum_healthy_percent == 100 &&
      service.deployment_maximum_percent == 200 &&
      service.deployment_circuit_breaker[0].enable &&
      service.deployment_circuit_breaker[0].rollback &&
      !service.network_configuration[0].assign_public_ip
    ])
    error_message = "Both production services must run redundantly in private subnets and automatically roll back failed revisions."
  }

  assert {
    condition = (
      aws_appautoscaling_target.backend.min_capacity >= 2 &&
      aws_appautoscaling_target.frontend.min_capacity >= 2 &&
      aws_appautoscaling_target.backend.max_capacity > aws_appautoscaling_target.backend.min_capacity &&
      aws_appautoscaling_target.frontend.max_capacity > aws_appautoscaling_target.frontend.min_capacity
    )
    error_message = "Both production services must have bounded horizontal autoscaling above their redundant baseline."
  }

  assert {
    condition = (
      endswith(
        local.backend_image_uri,
        "/releviz-prod-backend:0123456789abcdef0123456789abcdef01234567"
      ) &&
      endswith(
        local.frontend_image_uri,
        "/releviz-prod-frontend:0123456789abcdef0123456789abcdef01234567"
      )
    )
    error_message = "Backend and frontend task definitions must use separate repositories and immutable Git SHA tags."
  }

  assert {
    condition = (
      length(aws_route53_record.app) == 1 &&
      aws_route53_record.app[0].allow_overwrite
    )
    error_message = "The reviewed DNS cutover must explicitly replace the prior production alias."
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.backend_target_5xx.alarm_actions) > 0 &&
      length(aws_cloudwatch_metric_alarm.frontend_target_5xx.alarm_actions) > 0 &&
      contains(aws_cloudwatch_metric_alarm.backend_target_5xx.alarm_actions, var.alarm_action_arns[0]) &&
      contains(aws_cloudwatch_metric_alarm.frontend_target_5xx.alarm_actions, var.alarm_action_arns[0]) &&
      strcontains(aws_cloudwatch_log_metric_filter.request_exceptions.pattern, "request_exception") &&
      strcontains(aws_cloudwatch_log_metric_filter.permanent_email_failures.pattern, "email_delivery_failed") &&
      strcontains(aws_cloudwatch_log_metric_filter.permanent_email_failures.pattern, "permanent_failure")
    )
    error_message = "Production must page monitored SNS actions for both services, request exceptions, and permanent email failures."
  }
}

run "production_plan_without_dns" {
  command = plan

  variables {
    backend_image_tag               = "0123456789abcdef0123456789abcdef01234567"
    frontend_image_tag              = "0123456789abcdef0123456789abcdef01234567"
    django_secret_key_arn           = "arn:aws:secretsmanager:us-west-2:123456789012:secret:django"
    django_field_encryption_key_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key"
    metrics_bearer_token_arn        = "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics"
    alarm_action_arns               = ["arn:aws:sns:us-west-2:123456789012:production-alerts"]
    custom_domain                   = "releviz.com"
    route53_zone_id                 = "Z1234567890"
    manage_dns                      = false
    existing_acm_certificate_arn    = "arn:aws:acm:us-west-2:123456789012:certificate/test"
  }

  assert {
    condition     = length(aws_route53_record.app) == 0
    error_message = "The pre-cutover production apply must not modify Route53."
  }
}
