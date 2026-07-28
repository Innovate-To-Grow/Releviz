variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "app_name" {
  type    = string
  default = "releviz"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "backend_image_tag" {
  type        = string
  description = "Immutable 40-character Git commit SHA for the backend image"

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.backend_image_tag))
    error_message = "backend_image_tag must be a lowercase 40-character Git SHA."
  }
}

variable "frontend_image_tag" {
  type        = string
  description = "Immutable 40-character Git commit SHA for the frontend image"

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.frontend_image_tag))
    error_message = "frontend_image_tag must be a lowercase 40-character Git SHA."
  }
}

variable "backend_port" {
  type    = number
  default = 4000
}

variable "frontend_port" {
  type    = number
  default = 3000
}

variable "backend_task_cpu" {
  type    = number
  default = 512
}

variable "backend_task_memory" {
  type    = number
  default = 1024
}

variable "frontend_task_cpu" {
  type    = number
  default = 512
}

variable "frontend_task_memory" {
  type    = number
  default = 1024
}

variable "desired_count" {
  type        = number
  default     = 2
  description = "Steady-state task count for each production service"

  validation {
    condition     = var.desired_count >= 2
    error_message = "Production services require at least two tasks."
  }
}

variable "autoscaling_max_count" {
  type        = number
  default     = 6
  description = "Maximum task count for each production service"

  validation {
    condition     = var.autoscaling_max_count >= var.desired_count
    error_message = "autoscaling_max_count must be at least desired_count."
  }
}

variable "autoscaling_cpu_target" {
  type        = number
  default     = 60
  description = "Target average ECS CPU utilization percentage"

  validation {
    condition     = var.autoscaling_cpu_target >= 20 && var.autoscaling_cpu_target <= 80
    error_message = "autoscaling_cpu_target must be between 20 and 80."
  }
}

variable "ecr_backend_repository" {
  type    = string
  default = "releviz-prod-backend"
}

variable "ecr_frontend_repository" {
  type    = string
  default = "releviz-prod-frontend"
}

variable "events_table_name" {
  type    = string
  default = "releviz-prod-events"
}

variable "participants_table_name" {
  type    = string
  default = "releviz-prod-participants"
}

variable "weights_table_name" {
  type    = string
  default = "releviz-prod-weights"
}

variable "users_table_name" {
  type    = string
  default = "releviz-prod-users"
}

variable "user_events_table_name" {
  type    = string
  default = "releviz-prod-user-events"
}

variable "db_name" {
  type    = string
  default = "releviz"
}

variable "db_username" {
  type    = string
  default = "releviz"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_max_allocated_storage" {
  type    = number
  default = 200
}

variable "db_backup_retention_days" {
  type        = number
  default     = 30
  description = "Number of days to retain automated production PostgreSQL backups"

  validation {
    condition     = var.db_backup_retention_days >= 7 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 7 and 35."
  }
}

variable "django_secret_key_arn" {
  type        = string
  description = "Secrets Manager ARN containing the Django secret key"

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:", var.django_secret_key_arn))
    error_message = "django_secret_key_arn must be a Secrets Manager ARN."
  }
}

variable "django_field_encryption_key_arn" {
  type        = string
  description = "Secrets Manager ARN containing the Django field-encryption key"

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:", var.django_field_encryption_key_arn))
    error_message = "django_field_encryption_key_arn must be a Secrets Manager ARN."
  }
}

variable "metrics_bearer_token_arn" {
  type        = string
  description = "Secrets Manager ARN containing the private metrics bearer token"

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:", var.metrics_bearer_token_arn))
    error_message = "metrics_bearer_token_arn must be a Secrets Manager ARN."
  }
}

variable "sentry_dsn_secret_arn" {
  type        = string
  default     = ""
  description = "Optional Secrets Manager ARN containing the Sentry DSN"

  validation {
    condition = (
      var.sentry_dsn_secret_arn == "" ||
      can(regex("^arn:aws[a-z-]*:secretsmanager:", var.sentry_dsn_secret_arn))
    )
    error_message = "sentry_dsn_secret_arn must be empty or a Secrets Manager ARN."
  }
}

variable "secret_kms_key_arn" {
  type        = string
  default     = ""
  description = "Optional customer-managed KMS key used by application secrets"

  validation {
    condition     = var.secret_kms_key_arn == "" || can(regex("^arn:aws[a-z-]*:kms:", var.secret_kms_key_arn))
    error_message = "secret_kms_key_arn must be empty or a KMS key ARN."
  }
}

variable "sentry_traces_sample_rate" {
  type        = number
  default     = 0.05
  description = "Fraction of requests sampled for Sentry tracing"

  validation {
    condition     = var.sentry_traces_sample_rate >= 0 && var.sentry_traces_sample_rate <= 1
    error_message = "sentry_traces_sample_rate must be between 0 and 1."
  }
}

variable "alarm_action_arns" {
  type        = list(string)
  description = "SNS topic ARNs notified when production alarms change state"

  validation {
    condition     = length(var.alarm_action_arns) > 0 && alltrue([for arn in var.alarm_action_arns : can(regex("^arn:aws[a-z-]*:sns:", arn))])
    error_message = "Production requires at least one valid SNS alarm action ARN."
  }
}

variable "default_from_email" {
  type        = string
  default     = "noreply@releviz.com"
  description = "Verified production sender address"

  validation {
    condition     = can(regex("^[^@]+@[^@]+\\.[^@]+$", var.default_from_email)) && !endswith(var.default_from_email, ".local")
    error_message = "default_from_email must be a routable email address."
  }
}

variable "health_check_path" {
  type    = string
  default = "/health"
}

variable "custom_domain" {
  type        = string
  description = "Production hostname; must be selected explicitly to prevent accidental DNS takeover"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.custom_domain))
    error_message = "custom_domain must be a lowercase fully qualified hostname."
  }
}

variable "route53_zone_id" {
  type        = string
  description = "Route53 hosted-zone ID for custom_domain"

  validation {
    condition     = length(trimspace(var.route53_zone_id)) > 0
    error_message = "route53_zone_id is required."
  }
}

variable "api_domain" {
  type        = string
  default     = "api.releviz.com"
  description = "Canonical public hostname for the Django API and admin"

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.api_domain)) &&
      var.api_domain != var.custom_domain &&
      var.api_domain == "api.releviz.com"
    )
    error_message = "api_domain must be the reviewed hostname api.releviz.com and distinct from custom_domain."
  }
}

variable "legacy_origin_domain" {
  type        = string
  default     = "origin.releviz.com"
  description = "Temporary ALB hostname retained while existing rollback points still use the Amplify proxy"

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.legacy_origin_domain)) &&
      var.legacy_origin_domain != var.custom_domain &&
      var.legacy_origin_domain != var.api_domain
    )
    error_message = "legacy_origin_domain must be a lowercase hostname distinct from custom_domain and api_domain."
  }
}

variable "enable_legacy_api_compatibility" {
  type        = bool
  default     = false
  description = "Temporarily preserve the old /api routes and Amplify/ALB proxy during API-subdomain cutover"
}

variable "enable_amplify_domain" {
  type        = bool
  default     = false
  description = "Associate custom_domain with the Amplify production branch after both manual-deploy artifacts pass smoke tests"
}

variable "amplify_app_id" {
  type        = string
  description = "Exact Amplify app ID created by infra/bootstrap/provision-amplify.sh and adopted through Terraform import blocks"

  validation {
    condition     = can(regex("^d[a-z0-9]{1,19}$", var.amplify_app_id))
    error_message = "amplify_app_id must match d[a-z0-9]+ and contain at most 20 characters."
  }
}

variable "existing_acm_certificate_arn" {
  type        = string
  default     = ""
  description = "Optional existing ACM certificate ARN for custom_domain"

  validation {
    condition     = var.existing_acm_certificate_arn == "" || can(regex("^arn:aws[a-z-]*:acm:", var.existing_acm_certificate_arn))
    error_message = "existing_acm_certificate_arn must be empty or an ACM certificate ARN."
  }
}

variable "availability_zones" {
  type        = list(string)
  default     = []
  description = "Optional explicit AZ pair; defaults to the first two available AZs in aws_region"

  validation {
    condition     = length(var.availability_zones) == 0 || length(var.availability_zones) >= 2
    error_message = "availability_zones must be empty or contain at least two zones."
  }
}
