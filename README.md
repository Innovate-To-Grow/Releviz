# Releviz

A group meeting planning app with weighted availability and real-time aggregation. Create an event, share the link, and find the best time for everyone.

![Releviz Screenshot](Screenshoot.png)

## How to Use

### 1. Create an Event

Go to the home page and fill out the event form:

- **Event Name** — give your meeting a title
- **Meeting Type** — In-Person (requires a location) or Virtual
- **Time Range** — set 15- or 30-minute slots; an earlier end time creates an overnight window
- **Days** — pick which days of the week are options (defaults to Mon-Fri)

Create an account or log in before creating an event. After creating, you'll be redirected to the organizer view.

### 2. Share the Link

Click **Copy Share Link** in the top-right corner to get a link like:

```
https://yoursite.com/event?code=j9eaFNJH
```

Send this to everyone who should participate. Everyone who opens the link logs in before viewing the event or submitting availability.

### 3. Participants Fill In Availability

Each participant:

1. Signs in and clicks **Join**
2. Uses the **Availability Slider** to pick a level (0 = Busy, 1 = Free, with 0.25 steps)
3. Clicks, drags, touches, or uses the keyboard on the **schedule grid** to paint 15- or 30-minute
   slots with that availability level
4. Clicks **Submit Schedule** when done

The grid uses color coding: red (busy) -> yellow (partial) -> green (free).

After submitting, participants can see the **Group Availability** table showing aggregated scores, plus each person's **Individual Schedule** below it.

### 4. Organizer Dashboard

Access the organizer view from the account that created the event. The organizer can:

- **Set their own availability** on the same grid
- **Send email invitations and deadline reminders** with calendar attachments
- **Adjust participant weights** (0.0-1.0) — higher weight means more influence on the group average
- **Include/exclude participants** from the aggregate calculation
- **Remove participants** from the event
- **View the weighted group average** in real time, updated as weights change

The weighted average formula: for each time slot, `sum(availability * weight) / sum(weights)` across all included participants.

## Tech Stack

| Layer          | Technology                                                                               |
| -------------- | ---------------------------------------------------------------------------------------- |
| Frontend       | [Next.js 16](https://nextjs.org/) static export + React 19 + Material Web components     |
| Backend        | [Django 5](https://www.djangoproject.com/) + DRF + SimpleJWT                             |
| Database       | PostgreSQL/RDS in deployed environments; SQLite for local development                    |
| Infrastructure | AWS Amplify frontend; `api.releviz.com` on a public TLS ALB; private ECS Fargate backend |
| IaC            | Terraform (versioned encrypted S3 state with native lock files)                          |
| CI/CD          | GitHub Actions (required CI and protected manual Amplify/ECS production CD)              |

## Project Structure

```
releviz-monorepo/
  src/
    frontend/       # Next.js 16 — statically exported UI, no API routes
    backend/        # Django — API server, account auth, admin
    e2e/            # Playwright browser tests
  infra/
    prod/           # Amplify frontend, public TLS ALB, private HA ECS backend, RDS, DNS, and monitoring
    bootstrap/      # Protected state backend and GitHub OIDC deploy role
  scripts/
    quality-gate.sh # Full lint + test + build for both workspaces
    deploy/         # Bounded manual Amplify artifact deployment helper
  .github/workflows/
    ci.yml          # Parallel CI for both workspaces
    deploy-prod.yml # Protected, operator-confirmed production release
```

## Local Development

```bash
npm install          # install all workspace dependencies
python3 -m pip install -r src/backend/requirements/local.txt
npm run dev          # start backend (4000) + frontend (3000)
npm run dev:backend  # backend only
npm run dev:frontend # frontend only
```

The frontend calls the Django service directly. Local development defaults to
`http://localhost:4000`; override `NEXT_PUBLIC_API_BASE_URL` when the backend uses another origin.
Business endpoints do not have an `/api` prefix, so the local readiness endpoint is
`http://localhost:4000/health`.

Run checks:

```bash
npm --workspace=releviz-backend run lint
npm --workspace=releviz-frontend run lint
python src/backend/manage.py test --settings=config.settings.test
npm --workspace=releviz-backend run test
npm --workspace=releviz-frontend run test
npm --workspace=releviz-frontend run build
npm --workspace=releviz-frontend run build:amplify
npm run quality-gate               # all of the above
```

Pull requests use diff-scoped GitHub Actions jobs for the backend, frontend, E2E, and Terraform
areas. Every push to `main` runs the full suite and produces one stable `CI Result` check. The
pipeline includes workflow/configuration preflight checks, strict aggregate
backend coverage, PostgreSQL migration and app tests, frontend coverage and bundle budgets, a
required Amplify static-export build, dependency/secret/SAST scans, SBOM and license reports,
Terraform tests, and Docker image scans. The normal Next build and frontend Docker scan remain as
development/E2E and migration-fallback validation; production frontend releases use the static
artifact. Chromium, Firefox, and WebKit E2E runs and high/critical container findings block
`CI Result`. The workflow runs for every pull request, including documentation-only changes, so
branch protection always receives the same required check.

## Runtime Environment Variables

### Backend

- `PORT` (default: `4000`)
- `DJANGO_SETTINGS_MODULE` (local default: `config.settings.local`, deployed default: `config.settings.production`)
- `DJANGO_SECRET_KEY`
- `DJANGO_FIELD_ENCRYPTION_KEY` — encrypts AWS SES IAM secrets and queued authentication-email
  content
- `DJANGO_ALLOWED_HOSTS`
- `FRONTEND_URL`
- `BACKEND_URL` — canonical backend origin; production uses `https://api.releviz.com`
- `CORS_ALLOWED_ORIGINS`
- `CSRF_TRUSTED_ORIGINS`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_HOST`
- `DB_PORT` (default: `5432`)
- `DJANGO_CREATE_DEFAULT_ADMIN` (`1` to run default admin bootstrap at container start)
- `DJANGO_SUPERUSER_EMAIL`
- `DJANGO_SUPERUSER_PASSWORD`
- `USE_SES_EMAIL_PROVIDER` (`1` in deployed environments; local/test email backends bypass SES)
- `REQUIRE_ENCRYPTED_PASSWORDS` (`1` by default in production; password-bearing API requests
  negotiate the active RSA public key and use RSA-OAEP/SHA-256)
- `AUTH_TRUSTED_PROXY_COUNT` (number of trusted proxies used to resolve the client IP; production
  fixes this at `1` so only the public ALB's appended requester is trusted)
- `METRICS_BEARER_TOKEN` (required in production; dedicated credential for the private product
  metrics endpoint)
- `FEEDBACK_SUBMISSION_RETENTION_DAYS` (default: `730`; scheduled deletion boundary for feedback
  text)
- `APP_LOG_LEVEL` (default: `INFO`; structured JSON application log threshold)
- `SENTRY_DSN` (optional; external error tracking remains disabled when empty)
- `SENTRY_ENVIRONMENT`
- `SENTRY_RELEASE` (use an immutable image digest or Git revision)
- `SENTRY_TRACES_SAMPLE_RATE` (default: `0.05`, range `0` through `1`)

### Frontend

- `NEXT_PUBLIC_API_BASE_URL` — API origin; defaults to `https://api.releviz.com` in production and
  `http://localhost:4000` in local development
- `AMPLIFY_STATIC_EXPORT` — set by `build:amplify` to produce `src/frontend/out`; do not set for the
  local standalone Next server

Production builds set `NEXT_PUBLIC_API_BASE_URL=https://api.releviz.com`. Amplify serves only the
static UI at `https://releviz.com`; browser API and authentication requests go directly to the API
hostname. Business endpoints are rooted at that hostname, for example
`https://api.releviz.com/health` and `https://api.releviz.com/events`. The public ALB terminates
TLS, while the ECS backend has no public IP and accepts application traffic only from the ALB
security group.

Authentication is handled by the Django backend using email/password accounts, email verification
codes, short-lived in-memory JWT access credentials, an `HttpOnly` refresh cookie bound to a
revocable server session, browser-side public-key encryption when required by the deployment,
account recovery and session controls. Django admin is served directly at
`https://api.releviz.com/admin/`; it is not a frontend route. See
[`docs/auth-security.md`](docs/auth-security.md).

The first production switch to the API hostname can require users to sign in again. Refresh
cookies previously issued on the frontend hostname are host-scoped and are not transferred to
`api.releviz.com`.

Availability uses backend-authored 15/30-minute slot groups with explicit timezone and DST
semantics. See [`docs/scheduling-slots.md`](docs/scheduling-slots.md).

Email delivery is configured in Django admin under **Email Delivery**. Authentication messages,
final notifications, invitations, and reminders use persisted retryable jobs. Add an active AWS SES
provider with region, sender email, IAM access key id, and IAM secret access key. Provider secrets
and queued authentication content are encrypted in the database and are not stored in Terraform or
GitHub secrets. SES identities/domains and IAM permissions must already be configured in AWS.

Operational procedures and product evidence definitions:

- [`docs/observability.md`](docs/observability.md)
- [`docs/product-analytics.md`](docs/product-analytics.md)
- [`docs/backup-restore.md`](docs/backup-restore.md)
- [`docs/deployment-rollback.md`](docs/deployment-rollback.md)
- [`docs/real-user-validation-plan.md`](docs/real-user-validation-plan.md)

## Docker

```bash
# Backend
docker build -t releviz-backend:local ./src/backend
docker run --rm -p 4000:4000 \
  -e DJANGO_SETTINGS_MODULE=config.settings.local \
  releviz-backend:local

# Frontend development/migration-fallback image (production traffic uses Amplify)
scripts/docker-build-frontend.sh releviz-frontend:local
docker run --rm -p 3000:3000 releviz-frontend:local
```

## Deployment

### Production

Production CD is a protected manual workflow on `main`. It requires the exact confirmation
`DEPLOY`, verifies that the selected immutable commit passed `CI Result`, assumes the production
AWS role through GitHub OIDC, builds and pushes SHA-tagged backend and ECS-fallback frontend
images, and creates one SHA-identified static ZIP from `src/frontend/out`. The workflow manually
deploys that exact ZIP to an Amplify `candidate` branch, verifies the frontend plus the direct
`https://api.releviz.com` CORS/auth/admin boundary, promotes the same ZIP to Amplify `main`, and
only then associates `releviz.com`. The reviewed infrastructure plan preserves the public TLS ALB
and private ECS boundary and keeps the backend on a fixed one-hop ALB trust model. The Amplify app
is not connected to GitHub and does not use a PAT or an auto-build webhook.

The static build must match `src/frontend/amplify-routes.json`. Candidate smoke tests exercise
clean and trailing-slash routes, deployed JavaScript, query-preserving redirects, credentialed
CORS, protected non-GET auth requests, and a cookie/CSRF Django admin POST directly on the API
hostname. During the first API-subdomain cutover only, the workflow temporarily preserves the old
frontend proxy and `/api` prefix while the last-known-good ECS frontend remains the hot fallback.
After the API-aware Amplify release passes canonical smoke, the final reviewed plan advances the
ECS fallback to the current SHA, waits for it to become healthy, and removes that compatibility
surface plus the legacy `origin.releviz.com` DNS/certificate.

The current SHA-tagged ECS frontend remains a hot migration fallback. The workflow also retains
each Amplify ZIP and SHA256 file for 90 days and checks `/release.json` against the exact selected
SHA at candidate, production-default, and canonical stages. If a release fails after replacing
Amplify `main`, CD
downloads the previous release's trusted Actions artifact, verifies its SHA256 and embedded
`release.json`, and republishes it with Amplify `CreateDeployment` and `StartDeployment`. It does
not retry completed Amplify job metadata, because this manually deployed,
repository-disconnected app requires a freshly uploaded deployment. GitHub retains these rollback
artifacts for 90 days; after that boundary, an old Amplify job record alone is not a recoverable
release artifact, so recovery requires a reviewed roll-forward or revert that passes current CI.
The first cutover also snapshots the exact Route 53 ALB alias so it can atomically restore that
alias if migration fails. The protected Amplify domain association remains available for a safe
retry. Review
[`docs/deployment-rollback.md`](docs/deployment-rollback.md) before every live release.

Keeping the API load balancer private requires a separately reviewed architecture migration. The
preferred direction is API Gateway with a VPC Link, or another documented private ingress design.
The current `api.releviz.com` boundary is public HTTPS at the ALB; ECS tasks remain private.

Run `infra/bootstrap` once with an administrator to create the versioned state bucket and the
repository/environment-scoped OIDC role. Supply the existing account-wide GitHub OIDC provider ARN;
bootstrap never creates or deletes that shared provider. Initialize with `-backend=false` for the
first apply, then migrate the local bootstrap state to `bootstrap/terraform.tfstate` in the new
bucket. Set its `production_deploy_role_arn` output as `AWS_PROD_ROLE_ARN`; do not store long-lived
production AWS keys in GitHub.

Existing installations must first run the administrator-only command:

```bash
export EXPECTED_AWS_ACCOUNT_ID="<12-digit-production-account-id>"
amplify_app_id="$(infra/bootstrap/provision-amplify.sh)"
```

Then re-apply `infra/bootstrap` with that exact `production_amplify_app_id` before the first
Amplify release. The script verifies the active administrator identity with AWS STS before any
Amplify read or write. This binds the scoped production role to the one approved app and its
release resources.

### GitHub Actions Variables

- `AWS_REGION` — `us-west-2`
- `AWS_PROD_ROLE_ARN` — output of `infra/bootstrap`; trusted only for the `Production` Environment
- `PROD_TF_STATE_BUCKET` — protected state bucket created by `infra/bootstrap`
- `PROD_AMPLIFY_APP_ID` — exact administrator-provisioned `releviz-prod-frontend` app ID authorized
  by bootstrap and consumed as `TF_VAR_amplify_app_id`
- `ECR_PROD_BACKEND` — `releviz-prod-backend`
- `ECR_PROD_FRONTEND` — `releviz-prod-frontend`; stores the current-SHA ECS migration fallback
- `PROD_DOMAIN` — `releviz.com`
- `PROD_API_DOMAIN` — must be the reviewed hostname `api.releviz.com`
- `PROD_LEGACY_ORIGIN_DOMAIN` — `origin.releviz.com`; used only during the one-time compatibility
  phase and removed after the new frontend/API boundary passes production smoke tests
- `PROD_ROUTE53_ZONE_ID` — hosted-zone ID for `releviz.com`
- `PROD_DJANGO_SECRET_KEY_ARN`, `PROD_DJANGO_FIELD_ENCRYPTION_KEY_ARN`, and
  `PROD_METRICS_BEARER_TOKEN_ARN` — Secrets Manager ARNs, not secret values
- `PROD_ALARM_ACTION_ARNS_JSON` — non-empty JSON array of monitored SNS topic ARNs
- `PROD_SENTRY_DSN_SECRET_ARN`, `PROD_SECRET_KMS_KEY_ARN`, and
  `PROD_ACM_CERTIFICATE_ARN` — optional
- `PROD_DEFAULT_FROM_EMAIL` — verified production sender address

Staging was permanently retired. Production application secret values live in AWS Secrets Manager;
GitHub holds only their ARNs in the protected `Production` Environment.
