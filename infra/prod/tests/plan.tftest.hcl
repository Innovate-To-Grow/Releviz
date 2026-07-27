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

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = {
      id   = "pl-cloudfront"
      name = "com.amazonaws.global.cloudfront.origin-facing"
      entries = [
        {
          cidr        = "203.0.113.0/24"
          description = "mock CloudFront IPv4"
        },
        {
          cidr        = "2001:db8::/48"
          description = "mock CloudFront IPv6"
        },
      ]
    }
  }

  mock_data "aws_kms_alias" {
    defaults = {
      arn            = "arn:aws:kms:us-west-2:123456789012:alias/aws/mock"
      target_key_arn = "arn:aws:kms:us-west-2:123456789012:key/test"
      target_key_id  = "test"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn         = "arn:aws:acm:us-west-2:123456789012:certificate/origin"
      domain_name = "origin.releviz.com"
      domain_validation_options = [{
        domain_name           = "origin.releviz.com"
        resource_record_name  = "_validation.origin.releviz.com"
        resource_record_type  = "CNAME"
        resource_record_value = "_validation.acm-validations.aws"
      }]
    }
  }

  mock_resource "aws_acm_certificate_validation" {
    defaults = {
      certificate_arn = "arn:aws:acm:us-west-2:123456789012:certificate/origin"
    }
  }

  override_resource {
    target = aws_amplify_app.frontend
    values = {
      arn            = "arn:aws:amplify:us-west-2:123456789012:apps/dtest"
      default_domain = "dtest.amplifyapp.com"
      id             = "dtest"
    }
  }

  override_resource {
    target = aws_amplify_branch.candidate
    values = {
      arn = "arn:aws:amplify:us-west-2:123456789012:apps/dtest/branches/candidate"
    }
  }

  override_resource {
    target = aws_amplify_branch.production
    values = {
      arn = "arn:aws:amplify:us-west-2:123456789012:apps/dtest/branches/main"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/releviz-prod/test"
      arn_suffix = "app/releviz-prod/test"
      dns_name   = "releviz-prod-alb.us-west-2.elb.amazonaws.com"
      id         = "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/releviz-prod/test"
      zone_id    = "ZALB123456"
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
    amplify_app_id                  = "dtest"
    custom_domain                   = "production.releviz.com"
    route53_zone_id                 = "Z1234567890"
    enable_amplify_domain           = true
    restrict_origin_to_cloudfront   = true
    trust_cloudfront_proxy_chain    = true
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
      length(aws_amplify_domain_association.frontend) == 1 &&
      aws_amplify_domain_association.frontend[0].domain_name == var.custom_domain &&
      one(aws_amplify_domain_association.frontend[0].sub_domain).branch_name == "main" &&
      one(aws_amplify_domain_association.frontend[0].sub_domain).prefix == ""
    )
    error_message = "The reviewed Amplify cutover must associate only the production branch with the canonical hostname."
  }

  assert {
    condition = (
      aws_amplify_app.frontend.name == "releviz-prod-frontend" &&
      aws_amplify_app.frontend.platform == "WEB" &&
      !aws_amplify_app.frontend.enable_branch_auto_build &&
      aws_amplify_app.frontend.cache_config[0].type == "AMPLIFY_MANAGED" &&
      !aws_amplify_branch.candidate.enable_auto_build &&
      !aws_amplify_branch.production.enable_auto_build &&
      aws_amplify_branch.candidate.stage == "BETA" &&
      aws_amplify_branch.production.stage == "PRODUCTION"
    )
    error_message = "Amplify must be a cookie-aware static WEB app with manual candidate and production branches."
  }

  assert {
    condition = (
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/authn/login|https://origin.releviz.com/authn/login/|200"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/authn/login/|https://origin.releviz.com/authn/login/|200"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/api/<*>|https://origin.releviz.com/api/<*>|200"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/admin|/admin/|301"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/static/<*>|https://origin.releviz.com/static/<*>|200"
      ) &&
      alltrue([
        for route in local.amplify_static_routes :
        contains(
          [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
          "/${route}/|/${route}|301"
        )
      ]) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/sign-in|/login|301"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/sign-in/|/login|301"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/sign-in/<*>|/login|301"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/sign-up|/signup|301"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/sign-up/|/signup|301"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/sign-up/<*>|/signup|301"
      )
    )
    error_message = "Amplify must preserve exported-page, auth trailing-slash, and legacy sign-in semantics while proxying API, auth, admin, and static paths over HTTPS."
  }

  assert {
    condition = (
      aws_route53_record.origin.name == "origin.releviz.com" &&
      aws_route53_record.origin.alias[0].name == aws_lb.app.dns_name &&
      aws_lb_listener_certificate.origin.certificate_arn == aws_acm_certificate_validation.origin.certificate_arn
    )
    error_message = "The Amplify origin must have a stable ALB alias and a validated SNI certificate."
  }

  assert {
    condition = (
      aws_security_group.alb.description ==
      "Allow public HTTP and HTTPS ingress to the load balancer"
    )
    error_message = "The attached production ALB security group must retain its deployed ForceNew description."
  }

  assert {
    condition = (
      length([
        for rule in aws_security_group.alb.ingress : rule
        if contains(coalesce(rule.prefix_list_ids, []), data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id)
      ]) == 1 &&
      length([
        for rule in aws_security_group.alb.ingress : rule
        if contains(coalesce(rule.cidr_blocks, []), "0.0.0.0/0") && rule.from_port == 443
      ]) == 0 &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "AUTH_TRUSTED_PROXY_COUNT"
      ]) == "2" &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "AUTH_TRUSTED_PROXY_CIDR_HOPS"
      ]) == "1" &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "AUTH_TRUSTED_PROXY_CIDRS"
      ]) == "2001:db8::/48,203.0.113.0/24" &&
      aws_lb.app.xff_header_processing_mode == "append" &&
      !aws_lb.app.enable_xff_client_port &&
      output.origin_restricted_to_cloudfront &&
      output.trust_cloudfront_proxy_chain
    )
    error_message = "Post-cutover HTTPS must keep the CloudFront rule, remove public ingress, and trust the two-hop proxy chain."
  }

  assert {
    condition = (
      strcontains(
        one([
          for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
          environment.value if environment.name == "DJANGO_ALLOWED_HOSTS"
        ]),
        "origin.releviz.com"
      ) &&
      strcontains(
        one([
          for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
          environment.value if environment.name == "CSRF_TRUSTED_ORIGINS"
        ]),
        "https://candidate.dtest.amplifyapp.com"
      )
    )
    error_message = "Django must trust the origin hostname and both Amplify branch origins during smoke testing."
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.backend_target_5xx.alarm_actions) > 0 &&
      length(aws_cloudwatch_metric_alarm.frontend_target_5xx.alarm_actions) > 0 &&
      length(aws_cloudwatch_metric_alarm.amplify_5xx.alarm_actions) > 0 &&
      contains(aws_cloudwatch_metric_alarm.backend_target_5xx.alarm_actions, var.alarm_action_arns[0]) &&
      contains(aws_cloudwatch_metric_alarm.frontend_target_5xx.alarm_actions, var.alarm_action_arns[0]) &&
      contains(aws_cloudwatch_metric_alarm.amplify_5xx.alarm_actions, var.alarm_action_arns[0]) &&
      aws_cloudwatch_metric_alarm.amplify_5xx.namespace == "AWS/AmplifyHosting" &&
      aws_cloudwatch_metric_alarm.amplify_5xx.metric_name == "5xxErrors" &&
      strcontains(aws_cloudwatch_log_metric_filter.request_exceptions.pattern, "request_exception") &&
      strcontains(aws_cloudwatch_log_metric_filter.permanent_email_failures.pattern, "email_delivery_failed") &&
      strcontains(aws_cloudwatch_log_metric_filter.permanent_email_failures.pattern, "permanent_failure")
    )
    error_message = "Production must page monitored SNS actions for both services, request exceptions, and permanent email failures."
  }

  assert {
    condition = (
      jsondecode(aws_cloudwatch_event_target.event_reminders.input)
      .containerOverrides[0].command
      == ["python", "manage.py", "send_due_event_reminders", "--window-minutes=20"]
    )
    error_message = "The scheduled reminder task must invoke manage.py at the backend image workdir."
  }
}

run "production_plan_before_amplify_domain_cutover" {
  command = plan

  variables {
    backend_image_tag               = "0123456789abcdef0123456789abcdef01234567"
    frontend_image_tag              = "0123456789abcdef0123456789abcdef01234567"
    django_secret_key_arn           = "arn:aws:secretsmanager:us-west-2:123456789012:secret:django"
    django_field_encryption_key_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key"
    metrics_bearer_token_arn        = "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics"
    alarm_action_arns               = ["arn:aws:sns:us-west-2:123456789012:production-alerts"]
    amplify_app_id                  = "dtest"
    custom_domain                   = "releviz.com"
    route53_zone_id                 = "Z1234567890"
    enable_amplify_domain           = false
    restrict_origin_to_cloudfront   = false
    trust_cloudfront_proxy_chain    = false
    existing_acm_certificate_arn    = "arn:aws:acm:us-west-2:123456789012:certificate/test"
  }

  assert {
    condition = (
      length(aws_amplify_domain_association.frontend) == 0 &&
      aws_route53_record.origin.name == "origin.releviz.com"
    )
    error_message = "The initial apply must leave the canonical domain unassociated while provisioning the stable origin."
  }

  assert {
    condition = (
      length([
        for rule in aws_security_group.alb.ingress : rule
        if contains(coalesce(rule.cidr_blocks, []), "0.0.0.0/0") && rule.from_port == 443
      ]) == 1 &&
      length([
        for rule in aws_security_group.alb.ingress : rule
        if contains(coalesce(rule.prefix_list_ids, []), data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id)
      ]) == 1 &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "AUTH_TRUSTED_PROXY_COUNT"
      ]) == "1" &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "AUTH_TRUSTED_PROXY_CIDR_HOPS"
      ]) == "1" &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "AUTH_TRUSTED_PROXY_CIDRS"
      ]) == "2001:db8::/48,203.0.113.0/24" &&
      aws_lb.app.xff_header_processing_mode == "append" &&
      !aws_lb.app.enable_xff_client_port &&
      !output.origin_restricted_to_cloudfront &&
      !output.trust_cloudfront_proxy_chain
    )
    error_message = "Before cutover, public and CloudFront HTTPS must coexist with CIDR-aware proxy parsing and the legacy one-hop rollback count."
  }
}

run "rejects_trusting_cloudfront_while_origin_is_public" {
  command = plan

  variables {
    backend_image_tag               = "0123456789abcdef0123456789abcdef01234567"
    frontend_image_tag              = "0123456789abcdef0123456789abcdef01234567"
    django_secret_key_arn           = "arn:aws:secretsmanager:us-west-2:123456789012:secret:django"
    django_field_encryption_key_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key"
    metrics_bearer_token_arn        = "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics"
    alarm_action_arns               = ["arn:aws:sns:us-west-2:123456789012:production-alerts"]
    amplify_app_id                  = "dtest"
    custom_domain                   = "releviz.com"
    route53_zone_id                 = "Z1234567890"
    enable_amplify_domain           = false
    restrict_origin_to_cloudfront   = false
    trust_cloudfront_proxy_chain    = true
    existing_acm_certificate_arn    = "arn:aws:acm:us-west-2:123456789012:certificate/test"
  }

  expect_failures = [var.trust_cloudfront_proxy_chain]
}
