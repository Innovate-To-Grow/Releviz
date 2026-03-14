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
  default = "prod"
}

variable "image_tag" {
  type        = string
  description = "Docker image tag to deploy"
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "task_cpu" {
  type    = number
  default = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "github_repository" {
  type        = string
  description = "GitHub repository in owner/repo form"
  default     = ""

  validation {
    condition     = !var.create_github_oidc_resources || var.github_repository != ""
    error_message = "github_repository is required when create_github_oidc_resources is true."
  }
}

variable "ecr_repository_name" {
  type    = string
  default = "scheduler-prod"
}

variable "events_table_name" {
  type    = string
  default = "scheduler-prod-events"
}

variable "participants_table_name" {
  type    = string
  default = "scheduler-prod-participants"
}

variable "weights_table_name" {
  type    = string
  default = "scheduler-prod-weights"
}

variable "users_table_name" {
  type    = string
  default = "scheduler-prod-users"
}

variable "user_events_table_name" {
  type    = string
  default = "scheduler-prod-user-events"
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "health_check_path" {
  type    = string
  default = "/api/health"
}

variable "custom_domain" {
  type    = string
  default = "scheduler.i2g.ucmerced.edu"
}

variable "route53_zone_id" {
  type    = string
  default = "Z05097751AKPBGN5RW5GR"
}

variable "enable_https" {
  type    = bool
  default = true

  validation {
    condition = !var.enable_https || (
      trimspace(var.custom_domain) != "" &&
      trimspace(var.route53_zone_id) != ""
    )
    error_message = "custom_domain and route53_zone_id are required when enable_https is true."
  }
}

variable "existing_acm_certificate_arn" {
  type    = string
  default = ""
}

variable "github_oidc_provider_arn" {
  type    = string
  default = ""
}

variable "create_github_oidc_resources" {
  type    = bool
  default = false
}

variable "availability_zones" {
  type = list(string)
  default = [
    "us-west-2a",
    "us-west-2b",
  ]
}
