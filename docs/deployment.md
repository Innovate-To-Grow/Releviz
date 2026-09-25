# Deployment

Production runs on AWS: Amplify serves the static frontend, and a public TLS ALB fronts a private
ECS Fargate backend with separate result and email workers, backed by RDS PostgreSQL. Staging has
been retired.

## Release workflow

`release.yml` (**Releviz Production Release**) runs after every successful `CI` run on `main`. It
releases only the surfaces whose files changed:

| Surface | Releases | GitHub environment (AWS role) | Triggered by changes to |
|---|---|---|---|
| backend (`release-backend.yml`) | API image, all production Terraform (ECS services, workers, and the rest of AWS), default admin | `AWS ECS - Prod` (`releviz-production-github-deploy`) | `src/api/**`, `infra/prod/**` |
| frontend (`release-frontend.yml`) | Amplify static site and the ECS fallback frontend image | `AWS Amplify - Prod` (`releviz-production-frontend-github-deploy`) | `src/web/**`, root `package*.json`, Amplify deploy scripts, export validator, custom headers |

**Scope.** A credential-free `scope` job compares the commit with each surface's last successful
release (`scripts/ci/last-successful-release.sh`). Unchanged surfaces are skipped without an
approval prompt; if nothing changed, the run stops there.

**Approval.** The affected surfaces run side by side, so a reviewer approves both environments in a
single **Review pending deployments** dialog. Only after approval does each job get short-lived AWS
credentials through GitHub OIDC. Each role trusts exactly one environment, so approving the frontend
never grants backend permissions.

**Preflight.** A shared action checks that the commit passed `CI Result`, validates the
environment's configuration, assumes its role and confirms the identity (the frontend role must not
reach ECS), and, for the backend, checks the Terraform remote state.

**Manual runs.** Dispatch `release.yml` with any subset of surfaces, or dispatch a single surface
workflow to redeploy or roll back. Both require typing `DEPLOY` to confirm. Changes to the release
workflows themselves are exercised this way.

### Backend release

1. Installs the reviewed Amplify security headers and builds and pushes the SHA-tagged API image.
2. Plans Terraform for the whole production stack. The plan guard refuses destroys and any change to
   the live Amplify branches or domain; everything else is applied from the saved plan and listed in
   the run summary.
3. Waits for the backend, both workers, and the fallback frontend. It verifies their task
   definitions and worker commands, checks ALB target health, and smoke-tests the API and the live
   site's security headers, routes, and 404 page.
4. Runs a one-off private task that creates or verifies `admin@releviz.com`. The password comes only
   from AWS Secrets Manager; an existing valid administrator is left unchanged, and an unexpected
   state fails the release.

A change to `infra/prod` alone also rolls the backend onto an image built from that commit. The
workers share the backend image, run the same migrations before starting, shut down gracefully, and
roll back automatically on failure; alarms fire if they stop running or if email delivery fails
permanently.

### Frontend release

1. Builds one SHA-identified static ZIP from `src/web/out`, which must match
   `src/web/amplify-routes.json`, and pushes the ECS fallback frontend image.
2. Requires `releviz.com` to already be an active Amplify domain serving `main`, and refuses to start
   while another Amplify job is running.
3. Deploys the ZIP to the Amplify `candidate` branch and smoke-tests it: routes, redirects,
   JavaScript, CORS, authentication, and a Django admin POST on the API hostname.
4. Promotes the same ZIP to `main` and smoke-tests `releviz.com`. If that fails, the previous ZIP is
   redeployed automatically.

The Amplify app is not connected to GitHub; every release is a manual deployment.

### Checking and rolling back

- The live frontend commit is in `/release.json`. The live backend commit is the `release` field of
  `https://api.releviz.com/health`.
- Each Amplify ZIP and its SHA256 are kept as a workflow artifact for 90 days. A failed release
  republishes the previous one after verifying it. After 90 days, recover with a revert or
  roll-forward that passes CI.
- The ECS fallback frontend is kept at the last successfully released frontend commit.

## First-time setup

Follow [infra/bootstrap/README.md](../infra/bootstrap/README.md) to:

1. Create the versioned Terraform state bucket and the two OIDC deploy roles. Supply the existing
   account-wide GitHub OIDC provider ARN; bootstrap never creates or deletes it. For the first apply,
   initialize with `-backend=false`, then migrate the state to `bootstrap/terraform.tfstate` in the
   new bucket.
2. Create the four application secrets in Secrets Manager, including
   `releviz/prod/default-admin-password`.
3. Provision the Amplify app with `infra/bootstrap/provision-amplify.sh` and re-apply bootstrap with
   its ID.

Never store long-lived AWS keys or secret values in GitHub; GitHub holds only role and secret ARNs.

## GitHub environment variables

Both environments require reviewer approval and allow deployments only from `main`. The
repository-level variable `AWS_REGION` is `us-west-2`.

### `AWS ECS - Prod` (backend)

| Variable | Value |
|---|---|
| `AWS_PROD_ROLE_ARN` | `production_deploy_role_arn` output of `infra/bootstrap` |
| `PROD_TF_STATE_BUCKET` | State bucket created by `infra/bootstrap` |
| `PROD_AMPLIFY_APP_ID` | Amplify app ID from `provision-amplify.sh` (used as `TF_VAR_amplify_app_id`) |
| `ECR_PROD_BACKEND` | `releviz-prod-backend` |
| `ECR_PROD_FRONTEND` | `releviz-prod-frontend` (ECS fallback frontend) |
| `PROD_DOMAIN` | `releviz.com` |
| `PROD_API_DOMAIN` | `api.releviz.com` |
| `PROD_ROUTE53_ZONE_ID` | Hosted zone ID for `releviz.com` |
| `PROD_DJANGO_SECRET_KEY_ARN`, `PROD_DJANGO_FIELD_ENCRYPTION_KEY_ARN`, `PROD_METRICS_BEARER_TOKEN_ARN` | Secrets Manager ARNs |
| `PROD_DEFAULT_ADMIN_PASSWORD_SECRET_ARN` | ARN of `releviz/prod/default-admin-password` |
| `PROD_DEFAULT_ADMIN_EMAIL` | Optional; must be `admin@releviz.com` |
| `PROD_ALARM_ACTION_ARNS_JSON` | Non-empty JSON array of SNS topic ARNs for alarms |
| `PROD_DEFAULT_FROM_EMAIL` | Verified sender address |
| `PROD_SENTRY_DSN_SECRET_ARN`, `PROD_SECRET_KMS_KEY_ARN`, `PROD_ACM_CERTIFICATE_ARN` | Optional |

### `AWS Amplify - Prod` (frontend)

| Variable | Value |
|---|---|
| `AWS_PROD_FRONTEND_ROLE_ARN` | `production_frontend_deploy_role_arn` output of `infra/bootstrap` |
| `PROD_AMPLIFY_APP_ID` | Same app ID as above |
| `PROD_DOMAIN` | `releviz.com` |
| `PROD_API_DOMAIN` | `api.releviz.com` |
| `PROD_ROUTE53_ZONE_ID` | Hosted zone ID for `releviz.com` (read only) |
| `ECR_PROD_FRONTEND` | `releviz-prod-frontend` |

## Future work

The API load balancer is public HTTPS; the ECS tasks behind it are private. Making the API private
would need a separately reviewed migration, preferably to API Gateway with a VPC Link.
