# Production bootstrap

The GitHub production role deliberately cannot create, tag, or delete Amplify
apps and branches. Provision those resources once with administrator
credentials, then bind the role to the resulting exact app ID.

## Production application secrets

Before enabling production CD, an administrator must create four application
secrets in AWS Secrets Manager:

- Django signing key
- Django field-encryption key
- metrics bearer token
- default administrator password (`releviz/prod/default-admin-password`)

Generate the administrator password with a cryptographically secure generator,
using at least 32 characters and a mix of uppercase, lowercase, digits, and
symbols. Its SecretString must be a JSON object with exactly one string field
named `password`; do not store it as raw plaintext. Create the fourth secret
with administrator credentials and secret-safe tooling (for example, the
Secrets Manager console); never pass or print its value in Terraform, a GitHub
variable, shell history, CI logs, or this repository.

Add all four exact, unique secret ARNs to `production_secret_arns` in the
bootstrap production tfvars, then re-apply the remote bootstrap state:

```bash
terraform -chdir=infra/bootstrap init \
  -backend-config="bucket=<production-state-bucket>" \
  -backend-config="key=bootstrap/terraform.tfstate" \
  -backend-config="region=us-west-2" \
  -backend-config="use_lockfile=true"
terraform -chdir=infra/bootstrap apply -var-file=production.tfvars
```

The bootstrap role can read metadata for only those exact secret ARNs; it
cannot read their values. Store the fourth ARN—not the password—as the protected
GitHub Production environment variable
`PROD_DEFAULT_ADMIN_PASSWORD_SECRET_ARN`. Re-applying bootstrap is required
before running production CD so its OIDC role can validate that secret and run
the tightly scoped `releviz-prod-default-admin-task` task family in
`releviz-prod-cluster`. Every such task must be launched with exactly the
`Project=releviz`, `Environment=prod`, and
`Purpose=default-admin-bootstrap` tags. The role's compensating `StopTask`
permission is limited to tasks in that cluster carrying the same three resource
tags, so the workflow can clean up a still-running bootstrap task after a
failure or cancellation without gaining permission to stop the application
service's tasks. Its `iam:PassRole` permissions are separate from role
management: only the exact production ECS roles may be passed to
`ecs-tasks.amazonaws.com`, and only the reminder invocation role may be passed
to `events.amazonaws.com`.

## Initial Amplify provisioning

1. With administrator credentials for the production account, run:

   ```bash
   export EXPECTED_AWS_ACCOUNT_ID="<12-digit-production-account-id>"
   amplify_app_id="$(infra/bootstrap/provision-amplify.sh)"
   ```

   The script creates or verifies `releviz-prod-frontend` and its `candidate`
   and `main` branches. Before any Amplify read or write, it verifies the active
   administrator identity with AWS STS and refuses an account other than
   `EXPECTED_AWS_ACCOUNT_ID`. It also refuses ambiguous names, unexpected
   stages, or resources without the `Project=releviz`, `Environment=prod`, and
   `ManagedBy=terraform` ownership tags. It never deletes or retags resources.

2. Re-apply this bootstrap state with the exact ID:

   ```bash
   terraform -chdir=infra/bootstrap apply \
     -var-file=production.tfvars \
     -var="production_amplify_app_id=${amplify_app_id}"
   ```

3. Store the same value as the protected GitHub Production environment variable
   `PROD_AMPLIFY_APP_ID`. Production Terraform consumes it as
   `TF_VAR_amplify_app_id`.

The `infra/prod` import blocks then adopt the app and both branches on the first
production plan. Leaving `production_amplify_app_id` empty is safe before
provisioning because it grants the GitHub role no Amplify API permissions, but
the production workflow must not run in that state.

After the exact ID is configured, the GitHub role can refresh and update only
that app, its `candidate` and `main` branches, their deployment jobs, and the
canonical domain association. It has no Amplify `CreateApp`, `CreateBranch`,
`TagResource`, `UntagResource`, or delete actions.
