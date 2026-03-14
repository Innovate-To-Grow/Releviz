variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "app_name" {
  type    = string
  default = "scheduler"
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "backend_image_tag" {
  type        = string
  description = "Docker image tag for backend"
}

variable "frontend_image_tag" {
  type        = string
  description = "Docker image tag for frontend"
}

variable "backend_port" {
  type    = number
  default = 4000
}

variable "frontend_port" {
  type    = number
  default = 3000
}

variable "task_cpu" {
  type    = number
  default = 256
}

variable "task_memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "ecr_backend_repository" {
  type    = string
  default = "scheduler-staging-backend"
}

variable "ecr_frontend_repository" {
  type    = string
  default = "scheduler-staging-frontend"
}

variable "events_table_name" {
  type    = string
  default = "scheduler-staging-events"
}

variable "participants_table_name" {
  type    = string
  default = "scheduler-staging-participants"
}

variable "weights_table_name" {
  type    = string
  default = "scheduler-staging-weights"
}

variable "users_table_name" {
  type    = string
  default = "scheduler-staging-users"
}

variable "user_events_table_name" {
  type    = string
  default = "scheduler-staging-user-events"
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "health_check_path" {
  type    = string
  default = "/api/health"
}

variable "availability_zones" {
  type = list(string)
  default = [
    "us-west-2a",
    "us-west-2b",
  ]
}
