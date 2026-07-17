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
  default = 4000
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

variable "db_name" {
  type    = string
  default = "releviz"
}

variable "db_username" {
  type    = string
  default = "releviz"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_backup_retention_days" {
  type        = number
  description = "Number of days to retain automated production PostgreSQL backups"
  default     = 30

  validation {
    condition     = var.db_backup_retention_days >= 7 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 7 and 35."
  }
}

variable "django_secret_key" {
  type      = string
  sensitive = true
}

variable "django_field_encryption_key" {
  type      = string
  sensitive = true
}

variable "metrics_bearer_token" {
  type        = string
  description = "Dedicated bearer credential for the private product-metrics endpoint"
  sensitive   = true

  validation {
    condition     = length(trimspace(var.metrics_bearer_token)) >= 32
    error_message = "metrics_bearer_token must contain at least 32 non-whitespace characters."
  }
}

variable "sentry_dsn" {
  type        = string
  description = "Optional Sentry DSN; leave empty to disable external error tracking"
  default     = ""
  sensitive   = true
}

variable "sentry_release" {
  type        = string
  description = "Optional Sentry release identifier; defaults to image_tag"
  default     = ""
}

variable "sentry_traces_sample_rate" {
  type        = number
  description = "Fraction of requests sampled for Sentry tracing when Sentry is enabled"
  default     = 0.05

  validation {
    condition     = var.sentry_traces_sample_rate >= 0 && var.sentry_traces_sample_rate <= 1
    error_message = "sentry_traces_sample_rate must be between 0 and 1."
  }
}

variable "alarm_action_arns" {
  type        = list(string)
  description = "Optional SNS topic ARNs notified when production alarms change state"
  default     = []
}

variable "django_superuser_email" {
  type    = string
  default = ""
}

variable "django_superuser_password" {
  type      = string
  default   = ""
  sensitive = true
}

variable "django_create_default_admin" {
  type    = bool
  default = false
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
