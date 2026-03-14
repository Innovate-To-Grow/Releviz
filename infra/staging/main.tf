provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  prefix = "${var.app_name}-${var.environment}"
  common_tags = {
    Project     = var.app_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# --- Networking ---

resource "aws_vpc" "app" {
  cidr_block           = "10.1.0.0/16"
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
  cidr_block              = "10.1.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = var.availability_zones[0]
  tags                    = merge(local.common_tags, { Name = "${local.prefix}-public-a" })
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = "10.1.2.0/24"
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

# --- Security Groups ---

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
    from_port       = var.backend_port
    to_port         = var.backend_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

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

  tags = merge(local.common_tags, { Name = "${local.prefix}-ecs-sg" })
}

# --- DynamoDB ---

resource "aws_dynamodb_table" "events" {
  name         = var.events_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "eventCode"

  attribute {
    name = "eventCode"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
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

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
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

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
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

# --- CloudWatch ---

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${local.prefix}-backend"
  retention_in_days = 14
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "frontend" {
  name              = "/ecs/${local.prefix}-frontend"
  retention_in_days = 14
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

resource "aws_iam_role_policy" "ecs_task_dynamodb" {
  name = "${local.prefix}-ecs-task-dynamodb"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
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
    }]
  })
}

# --- ALB ---

resource "aws_lb" "app" {
  name               = "${local.prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  tags               = local.common_tags
}

resource "aws_lb_target_group" "backend" {
  name        = "${local.prefix}-backend-tg"
  port        = var.backend_port
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

resource "aws_lb_target_group" "frontend" {
  name        = "${local.prefix}-frontend-tg"
  port        = var.frontend_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.app.id

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
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
}

# --- ECS ---

resource "aws_ecs_cluster" "app" {
  name = "${local.prefix}-cluster"
  tags = local.common_tags
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${local.prefix}-backend-task"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "${local.prefix}-backend"
    image     = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_backend_repository}:${var.backend_image_tag}"
    essential = true
    portMappings = [{
      containerPort = var.backend_port
      hostPort      = var.backend_port
      protocol      = "tcp"
    }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(var.backend_port) },
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
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([{
    name      = "${local.prefix}-frontend"
    image     = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_frontend_repository}:${var.frontend_image_tag}"
    essential = true
    portMappings = [{
      containerPort = var.frontend_port
      hostPort      = var.frontend_port
      protocol      = "tcp"
    }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(var.frontend_port) }
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

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200

  network_configuration {
    assign_public_ip = true
    subnets          = [aws_subnet.public_a.id, aws_subnet.public_b.id]
    security_groups  = [aws_security_group.ecs.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "${local.prefix}-backend"
    container_port   = var.backend_port
  }

  depends_on = [aws_lb_listener.http]
  tags       = local.common_tags
}

resource "aws_ecs_service" "frontend" {
  name            = "${local.prefix}-frontend-service"
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.frontend.arn
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
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "${local.prefix}-frontend"
    container_port   = var.frontend_port
  }

  depends_on = [aws_lb_listener.http]
  tags       = local.common_tags
}

# --- CloudWatch Alarms ---

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

resource "aws_cloudwatch_metric_alarm" "ecs_backend_tasks" {
  alarm_name          = "${local.prefix}-ecs-backend-running-task"
  alarm_description   = "Backend ECS service running tasks dropped below 1"
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
    ServiceName = aws_ecs_service.backend.name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_frontend_tasks" {
  alarm_name          = "${local.prefix}-ecs-frontend-running-task"
  alarm_description   = "Frontend ECS service running tasks dropped below 1"
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
    ServiceName = aws_ecs_service.frontend.name
  }

  tags = local.common_tags
}
