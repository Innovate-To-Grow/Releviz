mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/terraform-test"
      user_id    = "AIDATEST"
    }
  }
}

run "production_plan" {
  command = plan

  variables {
    image_tag                   = "test"
    db_password                 = "test-database-password"
    django_secret_key           = "test-django-secret"
    django_field_encryption_key = "test-field-encryption-key"
    metrics_bearer_token        = "test-metrics-token-at-least-32-characters"
    enable_https                = false
  }

  assert {
    condition     = aws_lb_target_group.app.health_check[0].path == "/api/health"
    error_message = "The production target group must use the database-aware readiness endpoint."
  }

  assert {
    condition = (
      aws_db_instance.app.storage_encrypted &&
      !aws_db_instance.app.publicly_accessible &&
      aws_db_instance.app.deletion_protection &&
      !aws_db_instance.app.skip_final_snapshot &&
      !aws_db_instance.app.delete_automated_backups &&
      aws_db_instance.app.backup_retention_period == 30 &&
      aws_db_instance.app.copy_tags_to_snapshot
    )
    error_message = "Production PostgreSQL must be private, encrypted, deletion-protected, and retain automated and final backups."
  }

  assert {
    condition = (
      aws_ecs_service.app.deployment_minimum_healthy_percent == 100 &&
      aws_ecs_service.app.deployment_maximum_percent == 200 &&
      aws_ecs_service.app.deployment_circuit_breaker[0].enable &&
      aws_ecs_service.app.deployment_circuit_breaker[0].rollback
    )
    error_message = "Production deployments must retain healthy capacity and automatically roll back failed task revisions."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.target_5xx.metric_name == "HTTPCode_Target_5XX_Count" &&
      aws_cloudwatch_log_metric_filter.request_exceptions.pattern == "{ $.event = \"request_exception\" }" &&
      aws_cloudwatch_log_metric_filter.permanent_email_failures.pattern == "{ $.event = \"email_delivery_failed\" && $.status = \"permanent_failure\" }"
    )
    error_message = "Production must monitor target 5xx responses, request exceptions, and permanent email failures."
  }
}
