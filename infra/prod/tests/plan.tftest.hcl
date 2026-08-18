mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:role/terraform-test"
      user_id    = "AROATEST"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
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

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn         = "arn:aws:acm:us-west-2:123456789012:certificate/api"
      domain_name = "api.releviz.com"
      domain_validation_options = [{
        domain_name           = "api.releviz.com"
        resource_record_name  = "_validation.api.releviz.com"
        resource_record_type  = "CNAME"
        resource_record_value = "_validation.acm-validations.aws"
      }]
    }
  }

  mock_resource "aws_acm_certificate_validation" {
    defaults = {
      certificate_arn = "arn:aws:acm:us-west-2:123456789012:certificate/api"
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

  override_resource {
    target = aws_iam_role.ecs_execution
    values = {
      arn = "arn:aws:iam::123456789012:role/releviz-prod-ecs-execution-role"
    }
  }

  override_resource {
    target = aws_iam_role.ecs_task
    values = {
      arn = "arn:aws:iam::123456789012:role/releviz-prod-ecs-task-role"
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
    backend_image_tag                 = "0123456789abcdef0123456789abcdef01234567"
    frontend_image_tag                = "0123456789abcdef0123456789abcdef01234567"
    django_secret_key_arn             = "arn:aws:secretsmanager:us-west-2:123456789012:secret:django"
    django_field_encryption_key_arn   = "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key"
    metrics_bearer_token_arn          = "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics"
    default_admin_password_secret_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:releviz/prod/default-admin-password-Ab12Cd"
    alarm_action_arns                 = ["arn:aws:sns:us-west-2:123456789012:production-alerts"]
    amplify_app_id                    = "dtest"
    custom_domain                     = "production.releviz.com"
    route53_zone_id                   = "Z1234567890"
    enable_amplify_domain             = true
    existing_acm_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/test"
  }

  assert {
    condition = (
      aws_lb_target_group.backend.health_check[0].path == "/health" &&
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
    condition = alltrue([
      for service in [aws_ecs_service.result_worker, aws_ecs_service.email_worker] :
      service.desired_count == 1 &&
      service.deployment_minimum_healthy_percent == 100 &&
      service.deployment_maximum_percent == 200 &&
      service.deployment_circuit_breaker[0].enable &&
      service.deployment_circuit_breaker[0].rollback &&
      !service.network_configuration[0].assign_public_ip
    ])
    error_message = "Both durable workers must run as private, self-healing single-task ECS services."
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
      length(jsondecode(aws_iam_role_policy.eventbridge_reminders.policy).Statement) == 2 &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.eventbridge_reminders.policy).Statement :
        statement.Action if contains(statement.Action, "ecs:RunTask")
      ])) == toset(["ecs:RunTask"]) &&
      one([
        for statement in jsondecode(aws_iam_role_policy.eventbridge_reminders.policy).Statement :
        statement if contains(statement.Action, "ecs:RunTask")
      ]).Resource == "arn:aws:ecs:us-west-2:123456789012:task-definition/releviz-prod-backend-task:*" &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.eventbridge_reminders.policy).Statement :
        statement.Action if contains(statement.Action, "iam:PassRole")
      ])) == toset(["iam:PassRole"]) &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.eventbridge_reminders.policy).Statement :
        statement if contains(statement.Action, "iam:PassRole")
        ]).Resource) == toset([
        aws_iam_role.ecs_execution.arn,
        aws_iam_role.ecs_task.arn,
      ])
    )
    error_message = "EventBridge may run only the reviewed backend task family and pass only the two ECS task roles."
  }

  assert {
    condition = (
      length(aws_amplify_domain_association.frontend) == 1 &&
      aws_amplify_domain_association.frontend[0].domain_name == var.custom_domain &&
      !aws_amplify_domain_association.frontend[0].wait_for_verification &&
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
      jsondecode(aws_amplify_app.frontend.custom_headers).customHeaders == local.amplify_custom_headers &&
      length(local.amplify_custom_headers) == 1 &&
      one(local.amplify_custom_headers).pattern == "**" &&
      length(one(local.amplify_custom_headers).headers) == 5 &&
      toset([
        for header in one(local.amplify_custom_headers).headers :
        "${header.key}|${header.value}"
        ]) == toset([
        "Strict-Transport-Security|max-age=31536000; includeSubDomains",
        "X-Content-Type-Options|nosniff",
        "X-Frame-Options|DENY",
        "Referrer-Policy|no-referrer",
        "Content-Security-Policy|default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.releviz.com https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; form-action 'self'; upgrade-insecure-requests;",
      ])
    )
    error_message = "Amplify custom headers must use the reviewed semantic policy and preserve all five production security headers."
  }

  assert {
    condition = (
      alltrue([
        for rule in aws_amplify_app.frontend.custom_rule :
        !startswith(rule.target, "https://") &&
        !contains(["/api", "/api/<*>", "/authn", "/authn/<*>", "/admin", "/admin/<*>", "/static", "/static/<*>"], rule.source)
      ]) &&
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
    error_message = "Amplify must preserve static-route redirects without proxying API, auth, admin, or static backend paths."
  }

  assert {
    condition = (
      aws_route53_record.api.name == "api.releviz.com" &&
      aws_route53_record.api.alias[0].name == aws_lb.app.dns_name &&
      aws_lb_listener_certificate.api.certificate_arn == aws_acm_certificate_validation.api.certificate_arn &&
      toset(one(aws_lb_listener_rule.backend_api_host.condition).host_header[0].values) == toset(["api.releviz.com"]) &&
      length(aws_lb_listener_rule.backend) == 0 &&
      length(aws_route53_record.origin) == 0
    )
    error_message = "The API hostname must have an ALB alias, validated SNI certificate, and host-wide backend routing without legacy origin resources."
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
        if contains(coalesce(rule.cidr_blocks, []), "0.0.0.0/0") && rule.from_port == 443
      ]) == 1 &&
      length([
        for rule in aws_security_group.alb.ingress : rule
        if length(coalesce(rule.prefix_list_ids, [])) > 0
      ]) == 0 &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "AUTH_TRUSTED_PROXY_COUNT"
      ]) == "1" &&
      length([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment if contains(
          ["AUTH_TRUSTED_PROXY_CIDRS", "AUTH_TRUSTED_PROXY_CIDR_HOPS"],
          environment.name
        )
      ]) == 0 &&
      aws_lb.app.xff_header_processing_mode == "append" &&
      !aws_lb.app.enable_xff_client_port
    )
    error_message = "Amplify reverse proxy traffic requires public HTTPS and a single non-forgeable ALB-appended XFF hop."
  }

  assert {
    condition = (
      strcontains(
        one([
          for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
          environment.value if environment.name == "DJANGO_ALLOWED_HOSTS"
        ]),
        "api.releviz.com"
      ) &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "BACKEND_URL"
      ]) == "https://api.releviz.com" &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "ENABLE_LEGACY_API_PREFIX"
      ]) == "0" &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment :
        environment.value if environment.name == "BACKEND_URL"
      ]) == "https://api.releviz.com" &&
      strcontains(
        one([
          for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
          environment.value if environment.name == "CSRF_TRUSTED_ORIGINS"
        ]),
        "https://candidate.dtest.amplifyapp.com"
      )
    )
    error_message = "Django must use the API hostname, disable the legacy prefix, and trust both frontend branch origins during smoke testing."
  }

  assert {
    condition = (
      aws_ecs_task_definition.default_admin.family == "releviz-prod-default-admin-task" &&
      aws_ecs_task_definition.default_admin.execution_role_arn == aws_iam_role.ecs_execution.arn &&
      aws_ecs_task_definition.default_admin.task_role_arn == null &&
      aws_ecs_task_definition.default_admin.requires_compatibilities == toset(["FARGATE"]) &&
      jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].name == "releviz-prod-default-admin" &&
      jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].image == local.backend_image_uri &&
      jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].command == [
        "python",
        "manage.py",
        "ensure_default_admin",
        "--yes",
        "--create-only",
      ] &&
      jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].portMappings == [] &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].environment :
        environment.value if environment.name == "DJANGO_SKIP_STARTUP_TASKS"
      ]) == "1" &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].environment :
        environment.value if environment.name == "DJANGO_CREATE_DEFAULT_ADMIN"
      ]) == "0" &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].environment :
        environment.value if environment.name == "DJANGO_SUPERUSER_EMAIL"
      ]) == "admin@releviz.com" &&
      length([
        for environment in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].environment :
        environment if environment.name == "ENABLE_LEGACY_API_PREFIX"
      ]) == 0
    )
    error_message = "The default administrator must run through a dedicated role-free Fargate task definition with the immutable backend image and create-only command."
  }

  assert {
    condition = (
      aws_ecs_task_definition.result_worker.family == "releviz-prod-result-worker-task" &&
      aws_ecs_task_definition.email_worker.family == "releviz-prod-email-worker-task" &&
      aws_ecs_task_definition.result_worker.execution_role_arn == aws_iam_role.ecs_execution.arn &&
      aws_ecs_task_definition.email_worker.execution_role_arn == aws_iam_role.ecs_execution.arn &&
      aws_ecs_task_definition.result_worker.task_role_arn == aws_iam_role.ecs_task.arn &&
      aws_ecs_task_definition.email_worker.task_role_arn == aws_iam_role.ecs_task.arn &&
      jsondecode(aws_ecs_task_definition.result_worker.container_definitions)[0].image == local.backend_image_uri &&
      jsondecode(aws_ecs_task_definition.email_worker.container_definitions)[0].image == local.backend_image_uri &&
      jsondecode(aws_ecs_task_definition.result_worker.container_definitions)[0].command == [
        "python",
        "manage.py",
        "recompute_event_results",
        "--watch",
        "--poll-interval=1",
      ] &&
      jsondecode(aws_ecs_task_definition.email_worker.container_definitions)[0].command == [
        "python",
        "manage.py",
        "dispatch_email_jobs",
        "--watch",
        "--limit=1000",
        "--concurrency=10",
        "--rate-limit=10",
        "--poll-interval=1",
      ]
    )
    error_message = "Both worker task definitions must use the immutable backend image, reviewed roles, and durable watch commands."
  }

  assert {
    condition = alltrue([
      for task in [aws_ecs_task_definition.result_worker, aws_ecs_task_definition.email_worker] :
      jsondecode(task.container_definitions)[0].stopTimeout == 120 &&
      jsondecode(task.container_definitions)[0].healthCheck == local.worker_health_check &&
      jsondecode(task.container_definitions)[0].portMappings == [] &&
      one([
        for environment in jsondecode(task.container_definitions)[0].environment :
        environment.value if environment.name == "DJANGO_SKIP_STARTUP_TASKS"
      ]) == "1" &&
      one([
        for environment in jsondecode(task.container_definitions)[0].environment :
        environment.value if environment.name == "DJANGO_MIGRATE_ON_START"
      ]) == "1" &&
      one([
        for environment in jsondecode(task.container_definitions)[0].environment :
        environment.value if environment.name == "DJANGO_CREATE_DEFAULT_ADMIN"
      ]) == "0" &&
      toset([
        for secret in jsondecode(task.container_definitions)[0].secrets : secret.name
        ]) == toset([
        "DJANGO_SECRET_KEY",
        "DJANGO_FIELD_ENCRYPTION_KEY",
        "METRICS_BEARER_TOKEN",
        "DB_PASSWORD",
      ])
    ])
    error_message = "Workers must run locked migrations before skipping web startup mutations, receive only backend secrets, expose no ports, drain gracefully, and report database health."
  }

  assert {
    condition = (
      length(jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].secrets) == 5 &&
      length(distinct([
        for secret in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].secrets :
        secret.name
      ])) == 5 &&
      toset([
        for secret in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].secrets :
        secret.name
        ]) == toset([
        "DJANGO_SECRET_KEY",
        "DJANGO_FIELD_ENCRYPTION_KEY",
        "METRICS_BEARER_TOKEN",
        "DB_PASSWORD",
        "DJANGO_SUPERUSER_PASSWORD",
      ]) &&
      one([
        for secret in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].secrets :
        secret.valueFrom if secret.name == "DJANGO_SUPERUSER_PASSWORD"
      ]) == "${var.default_admin_password_secret_arn}:password::" &&
      length([
        for secret in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].secrets :
        secret if secret.name == "DJANGO_SUPERUSER_PASSWORD"
      ]) == 0 &&
      length([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment if environment.name == "DJANGO_SUPERUSER_EMAIL"
      ]) == 0 &&
      anytrue([
        for statement in jsondecode(aws_iam_role_policy.ecs_execution_secrets.policy).Statement :
        contains(statement.Action, "secretsmanager:GetSecretValue") &&
        contains(statement.Resource, var.default_admin_password_secret_arn)
      ])
    )
    error_message = "Only the one-off task may receive the administrator password and email, while the execution role must be able to retrieve that exact secret."
  }

  assert {
    condition = (
      !aws_ecs_task_definition.backend.enable_fault_injection &&
      !aws_ecs_task_definition.default_admin.enable_fault_injection &&
      !aws_ecs_task_definition.result_worker.enable_fault_injection &&
      !aws_ecs_task_definition.email_worker.enable_fault_injection &&
      !aws_ecs_task_definition.frontend.enable_fault_injection &&
      jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].mountPoints == [] &&
      jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].systemControls == [] &&
      jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].volumesFrom == [] &&
      jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].mountPoints == [] &&
      jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].systemControls == [] &&
      jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].volumesFrom == [] &&
      jsondecode(aws_ecs_task_definition.result_worker.container_definitions)[0].mountPoints == [] &&
      jsondecode(aws_ecs_task_definition.result_worker.container_definitions)[0].systemControls == [] &&
      jsondecode(aws_ecs_task_definition.result_worker.container_definitions)[0].volumesFrom == [] &&
      jsondecode(aws_ecs_task_definition.email_worker.container_definitions)[0].mountPoints == [] &&
      jsondecode(aws_ecs_task_definition.email_worker.container_definitions)[0].systemControls == [] &&
      jsondecode(aws_ecs_task_definition.email_worker.container_definitions)[0].volumesFrom == [] &&
      jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].mountPoints == [] &&
      jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].systemControls == [] &&
      jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].volumesFrom == []
    )
    error_message = "All ECS task definitions must explicitly match provider-canonical fault-injection and empty container defaults."
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.backend_target_5xx.alarm_actions) > 0 &&
      length(aws_cloudwatch_metric_alarm.frontend_target_5xx.alarm_actions) > 0 &&
      length(aws_cloudwatch_metric_alarm.amplify_5xx.alarm_actions) > 0 &&
      contains(aws_cloudwatch_metric_alarm.backend_target_5xx.alarm_actions, var.alarm_action_arns[0]) &&
      contains(aws_cloudwatch_metric_alarm.frontend_target_5xx.alarm_actions, var.alarm_action_arns[0]) &&
      contains(aws_cloudwatch_metric_alarm.amplify_5xx.alarm_actions, var.alarm_action_arns[0]) &&
      contains(aws_cloudwatch_metric_alarm.result_worker_running_tasks.alarm_actions, var.alarm_action_arns[0]) &&
      contains(aws_cloudwatch_metric_alarm.email_worker_running_tasks.alarm_actions, var.alarm_action_arns[0]) &&
      aws_cloudwatch_metric_alarm.result_worker_running_tasks.treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.email_worker_running_tasks.treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.result_worker_running_tasks.dimensions.ServiceName == aws_ecs_service.result_worker.name &&
      aws_cloudwatch_metric_alarm.email_worker_running_tasks.dimensions.ServiceName == aws_ecs_service.email_worker.name &&
      contains(aws_cloudwatch_metric_alarm.permanent_email_failures.alarm_actions, var.alarm_action_arns[0]) &&
      contains(aws_cloudwatch_metric_alarm.uncertain_email_outcomes.alarm_actions, var.alarm_action_arns[0]) &&
      aws_cloudwatch_metric_alarm.permanent_email_failures.treat_missing_data == "notBreaching" &&
      aws_cloudwatch_metric_alarm.uncertain_email_outcomes.treat_missing_data == "notBreaching" &&
      aws_cloudwatch_log_metric_filter.permanent_email_failures.log_group_name == aws_cloudwatch_log_group.email_worker.name &&
      aws_cloudwatch_log_metric_filter.uncertain_email_outcomes.log_group_name == aws_cloudwatch_log_group.email_worker.name &&
      aws_cloudwatch_metric_alarm.amplify_5xx.namespace == "AWS/AmplifyHosting" &&
      aws_cloudwatch_metric_alarm.amplify_5xx.metric_name == "5xxErrors" &&
      strcontains(aws_cloudwatch_log_metric_filter.request_exceptions.pattern, "request_exception") &&
      strcontains(aws_cloudwatch_log_metric_filter.permanent_email_failures.pattern, "permanent_failure") &&
      strcontains(aws_cloudwatch_log_metric_filter.uncertain_email_outcomes.pattern, "email_delivery_outcome_uncertain") &&
      strcontains(aws_cloudwatch_log_metric_filter.uncertain_email_outcomes.pattern, "uncertain")
    )
    error_message = "Production must page monitored SNS actions for web services, durable workers, request exceptions, permanent email failures, and uncertain email outcomes."
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
    backend_image_tag                 = "0123456789abcdef0123456789abcdef01234567"
    frontend_image_tag                = "0123456789abcdef0123456789abcdef01234567"
    django_secret_key_arn             = "arn:aws:secretsmanager:us-west-2:123456789012:secret:django"
    django_field_encryption_key_arn   = "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key"
    metrics_bearer_token_arn          = "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics"
    default_admin_password_secret_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:releviz/prod/default-admin-password-Ab12Cd"
    alarm_action_arns                 = ["arn:aws:sns:us-west-2:123456789012:production-alerts"]
    amplify_app_id                    = "dtest"
    custom_domain                     = "releviz.com"
    route53_zone_id                   = "Z1234567890"
    enable_amplify_domain             = false
    existing_acm_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/test"
  }

  assert {
    condition = (
      length(aws_amplify_domain_association.frontend) == 0 &&
      aws_route53_record.api.name == "api.releviz.com" &&
      length(aws_route53_record.origin) == 0
    )
    error_message = "The initial apply must leave the frontend domain unassociated while provisioning the stable API hostname."
  }

  assert {
    condition = (
      length([
        for rule in aws_security_group.alb.ingress : rule
        if contains(coalesce(rule.cidr_blocks, []), "0.0.0.0/0") && rule.from_port == 443
      ]) == 1 &&
      length([
        for rule in aws_security_group.alb.ingress : rule
        if length(coalesce(rule.prefix_list_ids, [])) > 0
      ]) == 0 &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "AUTH_TRUSTED_PROXY_COUNT"
      ]) == "1" &&
      length([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment if contains(
          ["AUTH_TRUSTED_PROXY_CIDRS", "AUTH_TRUSTED_PROXY_CIDR_HOPS"],
          environment.name
        )
      ]) == 0 &&
      aws_lb.app.xff_header_processing_mode == "append" &&
      !aws_lb.app.enable_xff_client_port
    )
    error_message = "The pre-cutover API must use public HTTPS and one trusted ALB hop."
  }
}

run "production_api_subdomain_transition" {
  command = plan

  variables {
    backend_image_tag                 = "0123456789abcdef0123456789abcdef01234567"
    frontend_image_tag                = "0123456789abcdef0123456789abcdef01234567"
    django_secret_key_arn             = "arn:aws:secretsmanager:us-west-2:123456789012:secret:django"
    django_field_encryption_key_arn   = "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key"
    metrics_bearer_token_arn          = "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics"
    default_admin_password_secret_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:releviz/prod/default-admin-password-Ab12Cd"
    alarm_action_arns                 = ["arn:aws:sns:us-west-2:123456789012:production-alerts"]
    amplify_app_id                    = "dtest"
    custom_domain                     = "releviz.com"
    route53_zone_id                   = "Z1234567890"
    enable_amplify_domain             = true
    enable_legacy_api_compatibility   = true
    existing_acm_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/test"
  }

  assert {
    condition = (
      aws_lb_target_group.backend.health_check[0].path == "/api/health" &&
      length(aws_lb_listener_rule.backend) == 1 &&
      length(aws_route53_record.origin) == 1 &&
      aws_route53_record.origin[0].name == "origin.releviz.com" &&
      aws_route53_record.api.name == "api.releviz.com"
    )
    error_message = "The migration plan must preserve the old health path and origin while adding the API hostname."
  }

  assert {
    condition = (
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/api/<*>|https://origin.releviz.com/api/<*>|200"
      ) &&
      contains(
        [for rule in aws_amplify_app.frontend.custom_rule : "${rule.source}|${rule.target}|${rule.status}"],
        "/admin/<*>|https://origin.releviz.com/admin/<*>|200"
      ) &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
        environment.value if environment.name == "ENABLE_LEGACY_API_PREFIX"
      ]) == "1" &&
      length([
        for environment in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].environment :
        environment if environment.name == "ENABLE_LEGACY_API_PREFIX"
      ]) == 0 &&
      one([
        for environment in jsondecode(aws_ecs_task_definition.default_admin.container_definitions)[0].environment :
        environment.value if environment.name == "BACKEND_URL"
      ]) == "https://api.releviz.com"
      && one([
        for environment in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment :
        environment.value if environment.name == "BACKEND_URL"
      ]) == "https://releviz.com"
      && contains(
        split(
          ",",
          one([
            for environment in jsondecode(aws_ecs_task_definition.backend.container_definitions)[0].environment :
            environment.value if environment.name == "DJANGO_ALLOWED_HOSTS"
          ]),
        ),
        "releviz.com",
      )
    )
    error_message = "The migration plan must preserve the frontend host, old Amplify rollback routes, and the Django /api alias until the new frontend passes smoke tests."
  }
}

run "reject_reused_default_admin_secret" {
  command = plan

  variables {
    backend_image_tag                 = "0123456789abcdef0123456789abcdef01234567"
    frontend_image_tag                = "0123456789abcdef0123456789abcdef01234567"
    django_secret_key_arn             = "arn:aws:secretsmanager:us-west-2:123456789012:secret:releviz/prod/default-admin-password-Ab12Cd"
    django_field_encryption_key_arn   = "arn:aws:secretsmanager:us-west-2:123456789012:secret:field-key"
    metrics_bearer_token_arn          = "arn:aws:secretsmanager:us-west-2:123456789012:secret:metrics"
    default_admin_password_secret_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:releviz/prod/default-admin-password-Ab12Cd"
    alarm_action_arns                 = ["arn:aws:sns:us-west-2:123456789012:production-alerts"]
    amplify_app_id                    = "dtest"
    custom_domain                     = "releviz.com"
    route53_zone_id                   = "Z1234567890"
    existing_acm_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/test"
  }

  expect_failures = [check.application_secret_arns_are_distinct]
}
