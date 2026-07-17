aws_region              = "us-west-2"
app_name                = "scheduler"
environment             = "prod"
ecr_repository_name     = "scheduler-prod"
events_table_name       = "scheduler-prod-events"
participants_table_name = "scheduler-prod-participants"
weights_table_name      = "scheduler-prod-weights"

# Set this to your repository, e.g. "your-org/scheduler"
github_repository = "replace-me/repository"

# Optional: use an existing OIDC provider ARN if one already exists in your account.
# github_oidc_provider_arn = "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"

# Supply secrets at plan/apply time or through an uncommitted tfvars file:
# db_password, django_secret_key, django_field_encryption_key, metrics_bearer_token.
#
# Optional operational integrations:
# sentry_dsn       = "https://..."
# sentry_release   = "git-sha-or-image-tag"
# alarm_action_arns = ["arn:aws:sns:us-west-2:<account-id>:releviz-prod-alerts"]
