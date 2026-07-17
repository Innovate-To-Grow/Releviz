mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/terraform-test"
      user_id    = "AIDATEST"
    }
  }

  mock_data "aws_route53_zone" {
    defaults = {
      name    = "releviz.com."
      zone_id = "Z0123456789TEST"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
      domain_validation_options = [
        {
          domain_name           = "releviz.com"
          resource_record_name  = "_test.releviz.com"
          resource_record_type  = "CNAME"
          resource_record_value = "_test.acm-validations.aws"
        }
      ]
    }
  }

  mock_resource "aws_acm_certificate_validation" {
    defaults = {
      certificate_arn = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    }
  }
}

run "staging_plan" {
  command = plan

  variables {
    backend_image_tag           = "test"
    frontend_image_tag          = "test"
    db_password                 = "test-database-password"
    django_secret_key           = "test-django-secret"
    django_field_encryption_key = "test-field-encryption-key"
    metrics_bearer_token        = "test-metrics-token-at-least-32-characters"
  }

  assert {
    condition     = aws_lb_target_group.backend.health_check[0].path == "/api/health"
    error_message = "The backend target group must use the database-aware readiness endpoint."
  }

  assert {
    condition     = aws_db_instance.app.storage_encrypted && !aws_db_instance.app.publicly_accessible
    error_message = "The staging database must be encrypted and private."
  }

  assert {
    condition = (
      aws_ecs_service.backend.deployment_minimum_healthy_percent == 100 &&
      aws_ecs_service.backend.deployment_circuit_breaker[0].enable &&
      aws_ecs_service.backend.deployment_circuit_breaker[0].rollback &&
      aws_ecs_service.frontend.deployment_minimum_healthy_percent == 100 &&
      aws_ecs_service.frontend.deployment_circuit_breaker[0].enable &&
      aws_ecs_service.frontend.deployment_circuit_breaker[0].rollback
    )
    error_message = "Staging must preserve healthy capacity and roll back failed ECS deployments."
  }
}
