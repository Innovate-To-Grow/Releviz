provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_kms_alias" "rds" {
  name = "alias/aws/rds"
}

data "aws_kms_alias" "secretsmanager" {
  name = "alias/aws/secretsmanager"
}

locals {
  prefix                    = "${var.app_name}-${var.environment}"
  app_url                   = "https://${var.custom_domain}"
  origin_url                = "https://${var.origin_domain}"
  backend_image_uri         = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_backend_repository}:${var.backend_image_tag}"
  frontend_image_uri        = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_frontend_repository}:${var.frontend_image_tag}"
  availability_zones        = length(var.availability_zones) >= 2 ? var.availability_zones : slice(data.aws_availability_zones.available.names, 0, 2)
  amplify_production_branch = "main"
  amplify_candidate_branch  = "candidate"
  amplify_production_url    = "https://${local.amplify_production_branch}.${aws_amplify_app.frontend.default_domain}"
  amplify_candidate_url     = "https://${local.amplify_candidate_branch}.${aws_amplify_app.frontend.default_domain}"
  amplify_route_manifest    = jsondecode(file("${path.module}/../../src/frontend/amplify-routes.json"))
  amplify_custom_headers = [
    {
      pattern = "**"
      headers = [
        {
          key   = "Strict-Transport-Security"
          value = "max-age=31536000; includeSubDomains"
        },
        {
          key   = "X-Content-Type-Options"
          value = "nosniff"
        },
        {
          key   = "X-Frame-Options"
          value = "DENY"
        },
        {
          key   = "Referrer-Policy"
          value = "no-referrer"
        },
        {
          key   = "Content-Security-Policy"
          value = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com https://esm.run blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com;"
        },
      ]
    },
  ]
  backend_allowed_hosts = join(",", [
    var.custom_domain,
    var.origin_domain,
    aws_lb.app.dns_name,
    "${local.amplify_production_branch}.${aws_amplify_app.frontend.default_domain}",
    "${local.amplify_candidate_branch}.${aws_amplify_app.frontend.default_domain}",
  ])
  browser_trusted_origins = join(",", [
    local.app_url,
    local.amplify_production_url,
    local.amplify_candidate_url,
  ])
  amplify_proxy_origin = local.origin_url
  amplify_authn_routes = [
    "public-key",
    "register",
    "register/verify-code",
    "register/resend-code",
    "login",
    "login/request-code",
    "login/verify-code",
    "email-auth/request-code",
    "email-auth/verify-code",
    "phone-auth/request-code",
    "phone-auth/verify-code",
    "logout",
    "refresh",
    "profile",
    "sessions",
    "account-emails",
    "contact-phones",
    "password-reset/request-code",
    "password-reset/verify-code",
    "password-reset/confirm",
    "change-password",
    "delete-account",
  ]
  amplify_authn_rewrites = flatten([
    for route in local.amplify_authn_routes : [
      {
        source = "/authn/${route}"
        target = "${local.amplify_proxy_origin}/authn/${route}/"
      },
      {
        source = "/authn/${route}/"
        target = "${local.amplify_proxy_origin}/authn/${route}/"
      },
    ]
  ])
  amplify_static_routes = local.amplify_route_manifest.static_routes
  amplify_legacy_auth_redirects = flatten([
    for source, target in local.amplify_route_manifest.legacy_redirects : [
      {
        source = "/${source}"
        target = "/${target}"
      },
      {
        source = "/${source}/"
        target = "/${target}"
      },
      {
        source = "/${source}/<*>"
        target = "/${target}"
      },
    ]
  ])
  common_tags = {
    Project     = var.app_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
  application_secret_arns = compact([
    var.django_secret_key_arn,
    var.django_field_encryption_key_arn,
    var.metrics_bearer_token_arn,
    var.sentry_dsn_secret_arn,
  ])
}

# --- Networking ---

resource "aws_vpc" "app" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.common_tags, { Name = "${local.prefix}-vpc" })
}

resource "aws_internet_gateway" "app" {
  vpc_id = aws_vpc.app.id
  tags   = merge(local.common_tags, { Name = "${local.prefix}-igw" })
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = local.availability_zones[0]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-public-a" })
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.0.2.0/24"
  map_public_ip_on_launch = true
  availability_zone       = local.availability_zones[1]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-public-b" })
}

resource "aws_subnet" "app_a" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.0.11.0/24"
  map_public_ip_on_launch = false
  availability_zone       = local.availability_zones[0]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-app-a" })
}

resource "aws_subnet" "app_b" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.0.12.0/24"
  map_public_ip_on_launch = false
  availability_zone       = local.availability_zones[1]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-app-b" })
}

resource "aws_subnet" "db_a" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.0.21.0/24"
  map_public_ip_on_launch = false
  availability_zone       = local.availability_zones[0]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-db-a" })
}

resource "aws_subnet" "db_b" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.0.22.0/24"
  map_public_ip_on_launch = false
  availability_zone       = local.availability_zones[1]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-db-b" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.app.id
  tags   = merge(local.common_tags, { Name = "${local.prefix}-public-rt" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.app.id
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat_a" {
  domain = "vpc"
  tags   = merge(local.common_tags, { Name = "${local.prefix}-nat-a" })

  depends_on = [aws_internet_gateway.app]
}

resource "aws_eip" "nat_b" {
  domain = "vpc"
  tags   = merge(local.common_tags, { Name = "${local.prefix}-nat-b" })

  depends_on = [aws_internet_gateway.app]
}

resource "aws_nat_gateway" "a" {
  allocation_id = aws_eip.nat_a.id
  subnet_id     = aws_subnet.public_a.id
  tags          = merge(local.common_tags, { Name = "${local.prefix}-nat-a" })
}

resource "aws_nat_gateway" "b" {
  allocation_id = aws_eip.nat_b.id
  subnet_id     = aws_subnet.public_b.id
  tags          = merge(local.common_tags, { Name = "${local.prefix}-nat-b" })
}

resource "aws_route_table" "app_a" {
  vpc_id = aws_vpc.app.id
  tags   = merge(local.common_tags, { Name = "${local.prefix}-app-a-rt" })
}

resource "aws_route_table" "app_b" {
  vpc_id = aws_vpc.app.id
  tags   = merge(local.common_tags, { Name = "${local.prefix}-app-b-rt" })
}

resource "aws_route" "app_a_internet" {
  route_table_id         = aws_route_table.app_a.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.a.id
}

resource "aws_route" "app_b_internet" {
  route_table_id         = aws_route_table.app_b.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.b.id
}

resource "aws_route_table_association" "app_a" {
  subnet_id      = aws_subnet.app_a.id
  route_table_id = aws_route_table.app_a.id
}

resource "aws_route_table_association" "app_b" {
  subnet_id      = aws_subnet.app_b.id
  route_table_id = aws_route_table.app_b.id
}

# --- Security groups ---

resource "aws_security_group" "alb" {
  name = "${local.prefix}-alb-sg"
  # AWS treats a security-group description change as ForceNew. Keep the
  # deployed description stable so the Amplify cutover only updates rules.
  description = "Allow public HTTP and HTTPS ingress to the load balancer"
  vpc_id      = aws_vpc.app.id

  lifecycle {
    prevent_destroy = true
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Amplify Hosting external 200 rewrites do not use the CloudFront
  # origin-facing managed prefix list. Keep HTTPS public so the supported
  # reverse-proxy path remains reachable.
  ingress {
    # Keep the deployed rule description stable so Terraform preserves this
    # exact set element while removing the unsupported prefix-list rule.
    description = "Public HTTPS before Amplify cutover and during rollback"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.prefix}-alb-sg" })
}

resource "aws_security_group" "backend" {
  name        = "${local.prefix}-backend-sg"
  description = "Allow only the ALB to reach the backend service"
  vpc_id      = aws_vpc.app.id

  ingress {
    from_port       = var.backend_port
    to_port         = var.backend_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.prefix}-backend-sg" })
}

resource "aws_security_group" "frontend" {
  name        = "${local.prefix}-frontend-sg"
  description = "Allow only the ALB to reach the frontend service"
  vpc_id      = aws_vpc.app.id

  ingress {
    from_port       = var.frontend_port
    to_port         = var.frontend_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.prefix}-frontend-sg" })
}

resource "aws_security_group" "db" {
  name        = "${local.prefix}-db-sg"
  description = "Allow only backend tasks to reach PostgreSQL"
  vpc_id      = aws_vpc.app.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.backend.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.prefix}-db-sg" })
}

# --- Legacy DynamoDB backup tables ---

resource "aws_dynamodb_table" "events" {
  name                        = var.events_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "eventCode"
  deletion_protection_enabled = true

  attribute {
    name = "eventCode"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  tags = local.common_tags

  lifecycle { prevent_destroy = true }
}

resource "aws_dynamodb_table" "participants" {
  name                        = var.participants_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "eventCode"
  range_key                   = "participantId"
  deletion_protection_enabled = true

  attribute {
    name = "eventCode"
    type = "S"
  }

  attribute {
    name = "participantId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  tags = local.common_tags

  lifecycle { prevent_destroy = true }
}

resource "aws_dynamodb_table" "weights" {
  name                        = var.weights_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "eventCode"
  range_key                   = "participantId"
  deletion_protection_enabled = true

  attribute {
    name = "eventCode"
    type = "S"
  }

  attribute {
    name = "participantId"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  tags = local.common_tags

  lifecycle { prevent_destroy = true }
}

resource "aws_dynamodb_table" "users" {
  name                        = var.users_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "userId"
  deletion_protection_enabled = true

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "email"
    type = "S"
  }

  global_secondary_index {
    name            = "email-index"
    hash_key        = "email"
    projection_type = "ALL"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  tags = local.common_tags

  lifecycle { prevent_destroy = true }
}

resource "aws_dynamodb_table" "user_events" {
  name                        = var.user_events_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "userId"
  range_key                   = "eventCode"
  deletion_protection_enabled = true

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "eventCode"
    type = "S"
  }

  global_secondary_index {
    name            = "eventCode-index"
    hash_key        = "eventCode"
    projection_type = "ALL"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  tags = local.common_tags

  lifecycle { prevent_destroy = true }
}

# --- PostgreSQL ---

resource "aws_db_subnet_group" "app" {
  name       = "${local.prefix}-db-subnets"
  subnet_ids = [aws_subnet.db_a.id, aws_subnet.db_b.id]
  tags       = local.common_tags
}

resource "aws_db_instance" "app" {
  identifier                    = "${local.prefix}-postgres"
  engine                        = "postgres"
  engine_version                = "16"
  instance_class                = var.db_instance_class
  allocated_storage             = var.db_allocated_storage
  max_allocated_storage         = var.db_max_allocated_storage
  storage_type                  = "gp3"
  db_name                       = var.db_name
  username                      = var.db_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = data.aws_kms_alias.secretsmanager.target_key_arn
  db_subnet_group_name          = aws_db_subnet_group.app.name
  vpc_security_group_ids        = [aws_security_group.db.id]
  storage_encrypted             = true
  kms_key_id                    = data.aws_kms_alias.rds.target_key_arn
  publicly_accessible           = false
  multi_az                      = true
  backup_retention_period       = var.db_backup_retention_days
  backup_window                 = "03:00-04:00"
  maintenance_window            = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot         = true
  delete_automated_backups      = false
  auto_minor_version_upgrade    = true
  skip_final_snapshot           = false
  final_snapshot_identifier     = "${local.prefix}-postgres-final"
  deletion_protection           = true
  apply_immediately             = false
  performance_insights_enabled  = true
  tags                          = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

# --- CloudWatch logs ---

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${local.prefix}-backend"
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "frontend" {
  name              = "/ecs/${local.prefix}-frontend"
  retention_in_days = 30
  tags              = local.common_tags
}

# --- IAM ---

resource "aws_iam_role" "ecs_execution" {
  name = "${local.prefix}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "${local.prefix}-ecs-secrets"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = concat(
          local.application_secret_arns,
          [aws_db_instance.app.master_user_secret[0].secret_arn]
        )
      }],
      var.secret_kms_key_arn == "" ? [] : [{
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.secret_kms_key_arn]
      }]
    )
  })
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.prefix}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role" "eventbridge_reminders" {
  name = "${local.prefix}-eventbridge-reminders-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "eventbridge_reminders" {
  name = "${local.prefix}-eventbridge-reminders-policy"
  role = aws_iam_role.eventbridge_reminders.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = aws_ecs_task_definition.backend.arn
      },
      {
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          aws_iam_role.ecs_execution.arn,
          aws_iam_role.ecs_task.arn,
        ]
      },
    ]
  })
}

# --- Amplify Hosting ---

# The app and release branches are created once by an administrator with
# infra/bootstrap/provision-amplify.sh. Config-driven imports let the protected
# production workflow adopt those exact IDs without granting GitHub any
# CreateApp, CreateBranch, or TagResource permission.
import {
  to = aws_amplify_app.frontend
  id = var.amplify_app_id
}

import {
  to = aws_amplify_branch.candidate
  id = "${var.amplify_app_id}/${local.amplify_candidate_branch}"
}

import {
  to = aws_amplify_branch.production
  id = "${var.amplify_app_id}/${local.amplify_production_branch}"
}

resource "aws_amplify_app" "frontend" {
  name        = "${local.prefix}-frontend"
  description = "Releviz production static frontend deployed manually from the protected release workflow"
  platform    = "WEB"

  enable_auto_branch_creation = false
  enable_basic_auth           = false
  enable_branch_auto_build    = false
  enable_branch_auto_deletion = false

  # The managed cache mode includes cookies in the cache key. Authentication
  # and CSRF cookies must reach the same-origin reverse proxy unchanged.
  cache_config {
    type = "AMPLIFY_MANAGED"
  }

  # Preserve the no-trailing-slash compatibility contract from next.config.js.
  # Django rejects POST redirects generated by APPEND_SLASH, so both public
  # spellings are proxied directly to the canonical trailing-slash endpoint.
  dynamic "custom_rule" {
    for_each = local.amplify_authn_rewrites

    content {
      source = custom_rule.value.source
      target = custom_rule.value.target
      status = "200"
    }
  }

  custom_rule {
    source = "/api"
    target = "${local.amplify_proxy_origin}/api/"
    status = "200"
  }

  custom_rule {
    source = "/api/<*>"
    target = "${local.amplify_proxy_origin}/api/<*>"
    status = "200"
  }

  custom_rule {
    source = "/authn"
    target = "${local.amplify_proxy_origin}/authn/"
    status = "200"
  }

  custom_rule {
    source = "/authn/"
    target = "${local.amplify_proxy_origin}/authn/"
    status = "200"
  }

  custom_rule {
    source = "/authn/<*>"
    target = "${local.amplify_proxy_origin}/authn/<*>"
    status = "200"
  }

  custom_rule {
    source = "/admin"
    target = "/admin/"
    status = "301"
  }

  custom_rule {
    source = "/admin/"
    target = "${local.amplify_proxy_origin}/admin/"
    status = "200"
  }

  custom_rule {
    source = "/admin/<*>"
    target = "${local.amplify_proxy_origin}/admin/<*>"
    status = "200"
  }

  custom_rule {
    source = "/static"
    target = "${local.amplify_proxy_origin}/static/"
    status = "200"
  }

  custom_rule {
    source = "/static/"
    target = "${local.amplify_proxy_origin}/static/"
    status = "200"
  }

  custom_rule {
    source = "/static/<*>"
    target = "${local.amplify_proxy_origin}/static/<*>"
    status = "200"
  }

  # Next static export writes /route.html. Amplify resolves /route cleanly,
  # but /route/ requires /route/index.html, which Next does not emit. Preserve
  # the previous Next server's trailing-slash route contract with a canonical
  # redirect; Amplify keeps the original query string on 301 responses.
  dynamic "custom_rule" {
    for_each = toset(local.amplify_static_routes)

    content {
      source = "/${custom_rule.value}/"
      target = "/${custom_rule.value}"
      status = "301"
    }
  }

  dynamic "custom_rule" {
    for_each = local.amplify_legacy_auth_redirects

    content {
      source = custom_rule.value.source
      target = custom_rule.value.target
      status = "301"
    }
  }

  custom_headers = jsonencode(local.amplify_custom_headers)

  tags = local.common_tags

  lifecycle {
    prevent_destroy = true

    # Amplify rewrites equivalent JSON/YAML and whitespace on read, so Terraform
    # cannot compare this string reliably. Ignore only the provider-normalized
    # representation; the postcondition below still rejects semantic drift.
    ignore_changes = [custom_headers]

    postcondition {
      condition     = self.id == var.amplify_app_id
      error_message = "The managed Amplify app must match the explicitly provisioned amplify_app_id."
    }

    postcondition {
      condition = try(
        jsonencode(try(
          yamldecode(self.custom_headers).customHeaders,
          yamldecode(self.custom_headers),
        )) == jsonencode(local.amplify_custom_headers),
        false,
      )
      error_message = "The live Amplify custom headers must semantically match the reviewed production security policy."
    }
  }
}

resource "aws_amplify_branch" "candidate" {
  app_id       = aws_amplify_app.frontend.id
  branch_name  = local.amplify_candidate_branch
  display_name = local.amplify_candidate_branch
  description  = "Pre-production branch for the exact release artifact"
  framework    = "Next.js - Static"
  stage        = "BETA"

  enable_auto_build           = false
  enable_basic_auth           = false
  enable_notification         = false
  enable_performance_mode     = false
  enable_pull_request_preview = false

  tags = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_amplify_branch" "production" {
  app_id       = aws_amplify_app.frontend.id
  branch_name  = local.amplify_production_branch
  display_name = local.amplify_production_branch
  description  = "Production branch promoted from the smoke-tested candidate artifact"
  framework    = "Next.js - Static"
  stage        = "PRODUCTION"

  enable_auto_build           = false
  enable_basic_auth           = false
  enable_notification         = false
  enable_performance_mode     = false
  enable_pull_request_preview = false

  tags = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_amplify_domain_association" "frontend" {
  count = var.enable_amplify_domain ? 1 : 0

  app_id                 = aws_amplify_app.frontend.id
  domain_name            = var.custom_domain
  enable_auto_sub_domain = false
  # The protected workflow owns the bounded, fail-closed availability gate.
  # Returning after the API create prevents an asynchronous service failure
  # from tainting a successfully persisted association in Terraform state.
  wait_for_verification = false

  certificate_settings {
    type = "AMPLIFY_MANAGED"
  }

  sub_domain {
    branch_name = aws_amplify_branch.production.branch_name
    prefix      = ""
  }

  # An accidental false value after cutover must fail safely instead of
  # disassociating the public production domain.
  lifecycle {
    prevent_destroy = true
  }
}

# --- ALB, TLS, and DNS ---

resource "aws_lb" "app" {
  name                       = "${local.prefix}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  enable_deletion_protection = true
  enable_xff_client_port     = false
  drop_invalid_header_fields = true
  xff_header_processing_mode = "append"
  tags                       = local.common_tags
}

resource "aws_acm_certificate" "app" {
  count = var.existing_acm_certificate_arn == "" ? 1 : 0

  domain_name       = var.custom_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.common_tags
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.existing_acm_certificate_arn == "" ? {
    for option in aws_acm_certificate.app[0].domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "app" {
  count = var.existing_acm_certificate_arn == "" ? 1 : 0

  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]

  timeouts {
    create = "20m"
  }
}

resource "aws_acm_certificate" "origin" {
  domain_name       = var.origin_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.common_tags
}

resource "aws_route53_record" "origin_cert_validation" {
  for_each = {
    for option in aws_acm_certificate.origin.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "origin" {
  certificate_arn         = aws_acm_certificate.origin.arn
  validation_record_fqdns = [for record in aws_route53_record.origin_cert_validation : record.fqdn]

  timeouts {
    create = "20m"
  }
}

locals {
  https_certificate_arn = (
    var.existing_acm_certificate_arn != "" ?
    var.existing_acm_certificate_arn :
    aws_acm_certificate_validation.app[0].certificate_arn
  )
}

# The previous configuration conditionally managed the apex ALB alias with
# count. Turning that count off deleted production DNS before the second apply.
# Forget the old address while leaving its physical record live; Amplify only
# replaces it after the tested production branch is explicitly associated.
removed {
  from = aws_route53_record.app

  lifecycle {
    destroy = false
  }
}

resource "aws_route53_record" "origin" {
  allow_overwrite = true
  name            = var.origin_domain
  type            = "A"
  zone_id         = var.route53_zone_id

  alias {
    evaluate_target_health = true
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
  }
}

resource "aws_lb_target_group" "backend" {
  name                 = "${local.prefix}-backend-tg"
  port                 = var.backend_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.app.id
  deregistration_delay = 30

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  tags = local.common_tags
}

resource "aws_lb_target_group" "frontend" {
  name                 = "${local.prefix}-frontend-tg"
  port                 = var.frontend_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.app.id
  deregistration_delay = 30

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200-399"
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      host        = "#{host}"
      path        = "/#{path}"
      port        = "443"
      protocol    = "HTTPS"
      query       = "#{query}"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = local.https_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_lb_listener_certificate" "origin" {
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.origin.certificate_arn
}

resource "aws_lb_listener_rule" "backend" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }

  condition {
    path_pattern {
      values = ["/api/*", "/authn/*", "/admin/*", "/static/*"]
    }
  }
}

# --- ECS ---

resource "aws_ecs_cluster" "app" {
  name = "${local.prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${local.prefix}-backend-task"
  cpu                      = var.backend_task_cpu
  memory                   = var.backend_task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "${local.prefix}-backend"
    image     = local.backend_image_uri
    essential = true
    portMappings = [{
      containerPort = var.backend_port
      hostPort      = var.backend_port
      protocol      = "tcp"
    }]
    environment = [
      { name = "DJANGO_SETTINGS_MODULE", value = "config.settings.production" },
      { name = "PORT", value = tostring(var.backend_port) },
      { name = "DJANGO_ALLOWED_HOSTS", value = local.backend_allowed_hosts },
      # The public ALB appends the actual requester to the right side of XFF.
      # Trust only that hop so a direct origin caller cannot forge its identity.
      { name = "AUTH_TRUSTED_PROXY_COUNT", value = "1" },
      { name = "USE_SES_EMAIL_PROVIDER", value = "1" },
      { name = "REQUIRE_ENCRYPTED_PASSWORDS", value = "1" },
      { name = "FRONTEND_URL", value = local.app_url },
      { name = "BACKEND_URL", value = local.app_url },
      { name = "CORS_ALLOWED_ORIGINS", value = local.browser_trusted_origins },
      { name = "CSRF_TRUSTED_ORIGINS", value = local.browser_trusted_origins },
      { name = "DB_NAME", value = var.db_name },
      { name = "DB_USER", value = var.db_username },
      { name = "DB_HOST", value = aws_db_instance.app.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.app.port) },
      { name = "DB_SSLMODE", value = "require" },
      { name = "DJANGO_CREATE_DEFAULT_ADMIN", value = "0" },
      { name = "DEFAULT_FROM_EMAIL", value = var.default_from_email },
      { name = "SENTRY_ENVIRONMENT", value = var.environment },
      { name = "SENTRY_RELEASE", value = var.backend_image_tag },
      { name = "SENTRY_TRACES_SAMPLE_RATE", value = tostring(var.sentry_traces_sample_rate) },
    ]
    secrets = concat(
      [
        { name = "DJANGO_SECRET_KEY", valueFrom = var.django_secret_key_arn },
        { name = "DJANGO_FIELD_ENCRYPTION_KEY", valueFrom = var.django_field_encryption_key_arn },
        { name = "METRICS_BEARER_TOKEN", valueFrom = var.metrics_bearer_token_arn },
        { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.app.master_user_secret[0].secret_arn}:password::" },
      ],
      var.sentry_dsn_secret_arn == "" ? [] : [
        { name = "SENTRY_DSN", valueFrom = var.sentry_dsn_secret_arn },
      ]
    )
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.backend.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${local.prefix}-frontend-task"
  cpu                      = var.frontend_task_cpu
  memory                   = var.frontend_task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([{
    name      = "${local.prefix}-frontend"
    image     = local.frontend_image_uri
    essential = true
    portMappings = [{
      containerPort = var.frontend_port
      hostPort      = var.frontend_port
      protocol      = "tcp"
    }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(var.frontend_port) },
      { name = "HOSTNAME", value = "0.0.0.0" },
      { name = "BACKEND_URL", value = local.app_url },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.frontend.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_service" "backend" {
  name            = "${local.prefix}-backend-service"
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 120

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    subnets          = [aws_subnet.app_a.id, aws_subnet.app_b.id]
    security_groups  = [aws_security_group.backend.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "${local.prefix}-backend"
    container_port   = var.backend_port
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener_rule.backend]
  tags       = local.common_tags
}

resource "aws_ecs_service" "frontend" {
  name            = "${local.prefix}-frontend-service"
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 120

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    subnets          = [aws_subnet.app_a.id, aws_subnet.app_b.id]
    security_groups  = [aws_security_group.frontend.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "${local.prefix}-frontend"
    container_port   = var.frontend_port
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]
  tags       = local.common_tags
}

# --- Service autoscaling ---

resource "aws_appautoscaling_target" "backend" {
  max_capacity       = var.autoscaling_max_count
  min_capacity       = var.desired_count
  resource_id        = "service/${aws_ecs_cluster.app.name}/${aws_ecs_service.backend.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "backend_cpu" {
  name               = "${local.prefix}-backend-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.backend.resource_id
  scalable_dimension = aws_appautoscaling_target.backend.scalable_dimension
  service_namespace  = aws_appautoscaling_target.backend.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_target" "frontend" {
  max_capacity       = var.autoscaling_max_count
  min_capacity       = var.desired_count
  resource_id        = "service/${aws_ecs_cluster.app.name}/${aws_ecs_service.frontend.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "frontend_cpu" {
  name               = "${local.prefix}-frontend-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.frontend.resource_id
  scalable_dimension = aws_appautoscaling_target.frontend.scalable_dimension
  service_namespace  = aws_appautoscaling_target.frontend.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# --- Scheduled reminder task ---

resource "aws_cloudwatch_event_rule" "event_reminders" {
  name                = "${local.prefix}-event-reminders"
  description         = "Send due Releviz event reminder emails"
  schedule_expression = "rate(15 minutes)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "event_reminders" {
  rule     = aws_cloudwatch_event_rule.event_reminders.name
  arn      = aws_ecs_cluster.app.arn
  role_arn = aws_iam_role.eventbridge_reminders.arn

  ecs_target {
    launch_type         = "FARGATE"
    task_count          = 1
    task_definition_arn = aws_ecs_task_definition.backend.arn

    network_configuration {
      assign_public_ip = false
      subnets          = [aws_subnet.app_a.id, aws_subnet.app_b.id]
      security_groups  = [aws_security_group.backend.id]
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "${local.prefix}-backend"
      command = ["python", "manage.py", "send_due_event_reminders", "--window-minutes=20"]
      environment = [{
        name  = "DJANGO_SKIP_STARTUP_TASKS"
        value = "1"
      }]
    }]
  })
}

# --- CloudWatch alarms ---

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.prefix}-alb-5xx"
  alarm_description   = "ALB generated 5xx responses"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "amplify_5xx" {
  alarm_name          = "${local.prefix}-amplify-5xx"
  alarm_description   = "Amplify Hosting returned 5xx responses"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "5xxErrors"
  namespace           = "AWS/AmplifyHosting"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    App = aws_amplify_app.frontend.id
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "backend_target_5xx" {
  alarm_name          = "${local.prefix}-backend-target-5xx"
  alarm_description   = "Backend targets returned 5xx responses"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "frontend_target_5xx" {
  alarm_name          = "${local.prefix}-frontend-target-5xx"
  alarm_description   = "Frontend targets returned 5xx responses"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
    TargetGroup  = aws_lb_target_group.frontend.arn_suffix
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "backend_running_tasks" {
  alarm_name          = "${local.prefix}-backend-running-tasks"
  alarm_description   = "Backend running task count dropped below its production minimum"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Average"
  threshold           = var.desired_count
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    ClusterName = aws_ecs_cluster.app.name
    ServiceName = aws_ecs_service.backend.name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "frontend_running_tasks" {
  alarm_name          = "${local.prefix}-frontend-running-tasks"
  alarm_description   = "Frontend running task count dropped below its production minimum"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Average"
  threshold           = var.desired_count
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    ClusterName = aws_ecs_cluster.app.name
    ServiceName = aws_ecs_service.frontend.name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_log_metric_filter" "request_exceptions" {
  name           = "${local.prefix}-request-exceptions"
  pattern        = "{ $.event = \"request_exception\" }"
  log_group_name = aws_cloudwatch_log_group.backend.name

  metric_transformation {
    name          = "RequestExceptions"
    namespace     = "Releviz/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "request_exceptions" {
  alarm_name          = "${local.prefix}-request-exceptions"
  alarm_description   = "Unhandled backend request exceptions were logged"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "RequestExceptions"
  namespace           = "Releviz/${var.environment}"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  tags = local.common_tags
}

resource "aws_cloudwatch_log_metric_filter" "permanent_email_failures" {
  name           = "${local.prefix}-permanent-email-failures"
  pattern        = "{ $.event = \"email_delivery_failed\" && $.status = \"permanent_failure\" }"
  log_group_name = aws_cloudwatch_log_group.backend.name

  metric_transformation {
    name          = "PermanentEmailFailures"
    namespace     = "Releviz/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "permanent_email_failures" {
  alarm_name          = "${local.prefix}-permanent-email-failures"
  alarm_description   = "Email delivery jobs exhausted their retry budget"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "PermanentEmailFailures"
  namespace           = "Releviz/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  tags = local.common_tags
}
