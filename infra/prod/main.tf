provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  prefix     = "${var.app_name}-${var.environment}"
  common_tags = {
    Project     = var.app_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_vpc" "app" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, { Name = "${local.prefix}-vpc" })
}

resource "aws_internet_gateway" "app" {
  vpc_id = aws_vpc.app.id
  tags   = merge(local.common_tags, { Name = "${local.prefix}-igw" })
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = var.availability_zones[0]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-public-a" })
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.0.2.0/24"
  map_public_ip_on_launch = true
  availability_zone       = var.availability_zones[1]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-public-b" })
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

resource "aws_security_group" "alb" {
  name        = "${local.prefix}-alb-sg"
  description = "Allow HTTP ingress"
  vpc_id      = aws_vpc.app.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = var.enable_https ? [1] : []
    content {
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.prefix}-alb-sg" })
}

resource "aws_security_group" "ecs" {
  name        = "${local.prefix}-ecs-sg"
  description = "Allow ALB to reach ECS"
  vpc_id      = aws_vpc.app.id

  ingress {
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.prefix}-ecs-sg" })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.prefix}"
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_dynamodb_table" "events" {
  name         = var.events_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "eventCode"

  attribute {
    name = "eventCode"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = local.common_tags
}

resource "aws_dynamodb_table" "participants" {
  name         = var.participants_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "eventCode"
  range_key    = "participantName"

  attribute {
    name = "eventCode"
    type = "S"
  }

  attribute {
    name = "participantName"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = local.common_tags
}

resource "aws_dynamodb_table" "weights" {
  name         = var.weights_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "eventCode"
  range_key    = "participantName"

  attribute {
    name = "eventCode"
    type = "S"
  }

  attribute {
    name = "participantName"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = local.common_tags
}

resource "aws_dynamodb_table" "users" {
  name         = var.users_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

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
}

resource "aws_dynamodb_table" "user_events" {
  name         = var.user_events_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "eventCode"

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
}

resource "aws_ecs_cluster" "app" {
  name = "${local.prefix}-cluster"
  tags = local.common_tags
}

resource "aws_iam_role" "ecs_execution" {
  name = "${local.prefix}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.prefix}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "ecs_task_dynamodb" {
  name = "${local.prefix}-ecs-task-dynamodb"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:BatchWriteItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem"
        ]
        Resource = [
          aws_dynamodb_table.events.arn,
          aws_dynamodb_table.participants.arn,
          aws_dynamodb_table.weights.arn,
          aws_dynamodb_table.users.arn,
          "${aws_dynamodb_table.users.arn}/index/*",
          aws_dynamodb_table.user_events.arn,
          "${aws_dynamodb_table.user_events.arn}/index/*"
        ]
      }
    ]
  })
}

resource "aws_lb" "app" {
  name               = "${local.prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]

  tags = local.common_tags
}

resource "aws_lb_target_group" "app" {
  name        = "${local.prefix}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.app.id

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200-399"
  }

  tags = local.common_tags
}

resource "aws_acm_certificate" "custom_domain" {
  count = var.enable_https && var.existing_acm_certificate_arn == "" ? 1 : 0

  domain_name       = var.custom_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.common_tags
}

resource "aws_route53_record" "acm_validation" {
  for_each = var.enable_https && var.existing_acm_certificate_arn == "" ? {
    for dvo in aws_acm_certificate.custom_domain[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "custom_domain" {
  count = var.enable_https && var.existing_acm_certificate_arn == "" ? 1 : 0

  certificate_arn         = aws_acm_certificate.custom_domain[0].arn
  validation_record_fqdns = [for record in aws_route53_record.acm_validation : record.fqdn]

  timeouts {
    create = "15m"
  }
}

locals {
  https_certificate_arn = var.enable_https ? (
    var.existing_acm_certificate_arn != "" ?
    var.existing_acm_certificate_arn :
    aws_acm_certificate_validation.custom_domain[0].certificate_arn
  ) : ""
}

resource "aws_route53_record" "custom_domain_a" {
  count = var.enable_https ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "custom_domain_aaaa" {
  count = var.enable_https ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = "AAAA"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = var.enable_https ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = var.enable_https ? [] : [1]
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.app.arn
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.https_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.prefix}-task"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name  = "${local.prefix}-container"
      image = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_repository_name}:${var.image_tag}"
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.container_port) },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "DDB_EVENTS_TABLE", value = aws_dynamodb_table.events.name },
        { name = "DDB_PARTICIPANTS_TABLE", value = aws_dynamodb_table.participants.name },
        { name = "DDB_WEIGHTS_TABLE", value = aws_dynamodb_table.weights.name },
        { name = "DDB_USERS_TABLE", value = aws_dynamodb_table.users.name },
        { name = "DDB_USER_EVENTS_TABLE", value = aws_dynamodb_table.user_events.name },
        { name = "JWT_SECRET", value = var.jwt_secret }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  tags = local.common_tags
}

resource "aws_ecs_service" "app" {
  name            = "${local.prefix}-service"
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200

  network_configuration {
    assign_public_ip = true
    subnets          = [aws_subnet.public_a.id, aws_subnet.public_b.id]
    security_groups  = [aws_security_group.ecs.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "${local.prefix}-container"
    container_port   = var.container_port
  }

  depends_on = [aws_lb_listener.http]

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.prefix}-alb-5xx"
  alarm_description   = "ALB has 5xx responses"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks" {
  alarm_name          = "${local.prefix}-ecs-running-task"
  alarm_description   = "ECS service running tasks dropped below 1"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.app.name
    ServiceName = aws_ecs_service.app.name
  }

  tags = local.common_tags
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_resources && var.github_oidc_provider_arn == "" ? 1 : 0

  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1"
  ]
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_actions_deploy" {
  count = var.create_github_oidc_resources ? 1 : 0

  name = "${local.prefix}-github-actions-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = [
              "repo:${var.github_repository}:ref:refs/heads/main",
              "repo:${var.github_repository}:environment:prod",
              "repo:${var.github_repository}:environment:AWS ECS - Prod"
            ]
          }
        }
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "github_actions_admin" {
  count = var.create_github_oidc_resources ? 1 : 0

  role       = aws_iam_role.github_actions_deploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
