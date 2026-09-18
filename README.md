# Releviz

A large-group meeting planner with roster import, weighted two-channel availability, continuous-time
recommendations, durable invitations, and versioned aggregate snapshots. One event supports up to
1,000 people and 1,000 authoritative time slots.

![Releviz Screenshot](Screenshoot.png)

## How to Use

### 1. Create an Active Event

Go to the home page and fill out the event form:

- **Event Name** — give your meeting a title
- **Meeting Type** — In-Person (requires a location), Virtual, or Mixed
- **Time Range** — set 15- or 30-minute slots; an earlier end time creates an overnight window
- **Meeting Duration** — 15–480 minutes, aligned to the slot size and contained in one time group
- **Days** — pick which days of the week are options (defaults to Mon-Fri)
- **Access** — Invite only (default) or Open link

Create an account or log in before creating an event. New events are active immediately and can
accept responses as soon as participants join; creating an event by itself does not send email.

### 2. Build the Roster

The Roster tab accepts `.xlsx`, `.csv`, or pasted CSV/TSV. Map the required `name` and `email`
columns and optional `group`, `weight`, and `included` columns, preview and correct rows, then commit
as:

- **Merge** — add/update people while preserving existing schedules and delivery history. Newly
  added or restored people receive an invitation automatically.
- **Rebuild** — type the event code to destructively replace the roster, schedules, invitations,
  temporary sessions, and pending deliveries. Every person in the rebuilt roster receives a new
  invitation.

Adding a person or committing an import atomically creates the roster changes and durable invitation
jobs. The HTTP request returns as soon as those jobs are committed; the Roster tab shows
provider-handoff progress and allows retrying failed recipients. Closed, finalized, and archived
events must be reactivated before their roster can change.

Invite-only links are visible only to the organizer, existing participants, temporary recipients
using their event-scoped code flow, or full accounts whose verified email matches an invitation.
Open-link events retain code-based joining, subject to the 1,000-person cap.

### 3. Participants Fill In Availability

Each participant:

1. Signs in and clicks **Join**
2. Chooses a level with the **Busy / If needed / Available** control (0, 0.5, 1)
3. Clicks, drags, touches, or uses the keyboard on the **schedule grid** to paint 15- or 30-minute
   slots with that availability level
4. Clicks **Submit Schedule** when done

The grid uses color coding plus text cues: hatched red (busy) -> yellow ◐ (if needed) -> green ✓
(available). Virtual channels use a red -> purple -> blue scale.

Depending on the event's visibility setting, participants can see the latest published group
snapshot. While a newer response is being calculated, the UI labels the result as refreshing and
shows the previous snapshot's generation time.

### 4. Organizer Dashboard

Access the organizer view from the account that created the event. It is split into Overview,
Roster, Results, and Finalize. The organizer can:

- search/filter a server-paginated roster (50 rows by default, 100 maximum);
- load one person's schedule only when its edit drawer opens;
- co-edit a temporary participant while the event is active, until that identity upgrades to a
  verified full account;
- apply group/filter/selection weight and included changes, then override an individual;
- view the top ten meeting-duration candidates ranked by weighted availability, unweighted
  availability, fully available count, and configured-time order;
- finalize one authoritative continuous interval, queue stable-UID iCalendar `REQUEST`/`CANCEL`
  notifications, and download the calendar file.

For a multi-slot meeting, each person's candidate score is their minimum availability across the
whole interval. The weighted score is `sum(person_score * weight) / sum(positive weights)` across
included submitted people. Weight zero still contributes to the unweighted score. There are no
required/mandatory participants.

## Tech Stack

| Layer          | Technology                                                                               |
| -------------- | ---------------------------------------------------------------------------------------- |
| Frontend       | [Next.js 16](https://nextjs.org/) static export + React 19 + Bootstrap 5.3 (Sass theme)  |
| Backend        | [Django 6](https://www.djangoproject.com/) + DRF + SimpleJWT                             |
| Database       | PostgreSQL/RDS in deployed environments; SQLite for local development                    |
| Infrastructure | AWS Amplify frontend; public TLS ALB; private ECS Fargate API and durable workers       |
| IaC            | Terraform (versioned encrypted S3 state with native lock files)                          |
| CI/CD          | GitHub Actions (required CI; Amplify/ECS production CD on green `main`, reviewer-approved) |

The Active-status release intentionally purges existing scheduling events, rosters, responses,
invitations, temporary event identities, and event-owned delivery work during its coordinated
maintenance cutover. Full accounts, administrator access, AWS credentials, email providers, and
non-scheduling mail history are retained. There is no historical scheduling-data compatibility
layer. This code change does not itself deploy an environment, apply Terraform, or validate real
SES delivery.

## Project Structure

```
releviz-monorepo/
  src/
    web/            # Next.js 16 — statically exported UI, no API routes
    api/            # Django — API server, account auth, admin
    e2e/            # Playwright browser tests
  infra/
    prod/           # Amplify frontend, public TLS ALB, private HA ECS backend, RDS, DNS, and monitoring
    bootstrap/      # Protected state backend and GitHub OIDC deploy role
  scripts/
    quality-gate.sh # Full lint + test + build for both workspaces
    deploy/         # Bounded manual Amplify artifact deployment helper
    perf/           # Pure aggregation and guarded PostgreSQL/HTTP scale tools
  .github/workflows/
    ci.yml          # Parallel CI for both workspaces
    release-backend.yml        # API image, ECS rollout, workers, default admin
    release-frontend.yml       # Amplify static release with candidate smoke and rollback
    release-infrastructure.yml # Terraform for everything else in AWS
  .github/actions/
    release-scope/     # Skips a release when its paths did not change (no credentials)
    release-preflight/ # DEPLOY confirmation, CI Result, configuration, OIDC, remote state
```

## Local Development

Use Python 3.12-3.14 (Django 6 and the hashed backend locks require it). The setup command replaces
`src/api/.venv` with a clean environment; set `PYTHON_BIN` if `python3` is not the right interpreter.

```bash
npm install
npm run setup:api
source src/api/.venv/bin/activate
python src/api/manage.py migrate --settings=config.settings.local
npm run dev      # backend (4000) + frontend (3000)
npm run dev:api  # backend only
npm run dev:web  # frontend only
```

`src/api/.env.example` documents current local overrides; Django does not implicitly load it, so
export only the values you need. Backend dependency intent lives in `requirements/*.in`; run
`npm run lock:api` after changing those inputs and commit all three hashed `.txt` locks. CI checks
that the locks still reproduce for Python 3.12-3.14 with the pinned resolver.

The frontend calls the Django service directly. Local development defaults to
`http://localhost:4000`; override `NEXT_PUBLIC_API_BASE_URL` when the backend uses another origin.
Business endpoints do not have an `/api` prefix, so the local readiness endpoint is
`http://localhost:4000/health`.

Run the coalescing result worker and durable email worker in separate terminals when exercising
organizer results or delivery flows:

```bash
python src/api/manage.py recompute_event_results --watch --poll-interval=1 \
  --settings=config.settings.local
python src/api/manage.py dispatch_email_jobs --watch --limit=1000 \
  --concurrency=10 --rate-limit=10 --poll-interval=1 \
  --settings=config.settings.local
```

Run checks:

```bash
npm --workspace=releviz-api run lint
npm --workspace=releviz-web run lint
python src/api/manage.py test --settings=config.settings.test
npm --workspace=releviz-api run test
npm --workspace=releviz-web run test
npm --workspace=releviz-web run build
npm --workspace=releviz-web run build:amplify
npm run quality-gate               # all of the above
```

The guarded scale tools resolve application imports from `src/api`. Run them with the activated
backend environment, for example `python scripts/perf/benchmark_aggregation.py`; database and HTTP
scenarios retain their explicit confirmation and loopback/test-database safeguards.

Every pull request, every push to `main` or `master`, and every manual GitHub Actions dispatch runs
the complete backend, frontend, E2E, security, supply-chain, container, and Terraform suite and
produces one stable `CI Result` check. The pipeline includes workflow/configuration preflight
checks, strict aggregate
backend coverage, PostgreSQL migration and app tests, frontend coverage and bundle budgets, a
required Amplify static-export build, dependency/secret/SAST scans, SBOM and license reports,
Terraform tests, and Docker image scans. The normal Next build and frontend Docker scan remain as
development/E2E and migration-fallback validation; production frontend releases use the static
artifact. Chromium, Firefox, and WebKit E2E runs and high/critical container findings block
`CI Result`. Documentation-only changes run the same full matrix, so a green result never means
that an application, browser, infrastructure, or security area was skipped.

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
- `DJANGO_MIGRATE_ON_START` (`1` in worker tasks to run only advisory-locked migrations before
  starting the watch command)
- `DJANGO_SKIP_STARTUP_TASKS` (`1` in worker tasks so they skip static collection and administrator
  bootstrap when ECS replaces a worker)
- `DJANGO_CREATE_DEFAULT_ADMIN` (`1` enables legacy container-start bootstrap; production keeps
  this at `0`)
- `DJANGO_SUPERUSER_EMAIL`
- `DJANGO_SUPERUSER_PASSWORD`
- `USE_SES_EMAIL_PROVIDER` (`1` in deployed environments; local/test email backends bypass SES)
- `PRINT_EMAILS_TO_TERMINAL` (`1` prints every outgoing email to the server terminal instead of
  delivering it; local development only, rejected by production settings and forced off in E2E)
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
- `EMAIL_WORKER_BATCH_SIZE`, `EMAIL_WORKER_CONCURRENCY`, `EMAIL_WORKER_RATE_PER_SECOND`, and
  `EMAIL_WORKER_POLL_SECONDS` (defaults: `100`, `10`, `10`, and `1`)
- `RESULT_WORKER_BATCH_SIZE`, `RESULT_WORKER_POLL_SECONDS`,
  `RESULT_SNAPSHOT_LOCK_TIMEOUT_SECONDS`, and `RESULT_FAILURE_RETRY_DELAY_SECONDS` (defaults:
  `100`, `1`, `60`, and `30`)

### Frontend

- `NEXT_PUBLIC_API_BASE_URL` — API origin; defaults to `https://api.releviz.com` in production and
  `http://localhost:4000` in local development
- `AMPLIFY_STATIC_EXPORT` — set by `build:amplify` to produce `src/web/out`; do not set for the
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
`https://api.releviz.com/admin/`; it is not a frontend route.

The first production switch to the API hostname can require users to sign in again. Refresh
cookies previously issued on the frontend hostname are host-scoped and are not transferred to
`api.releviz.com`.

Availability uses backend-authored 15/30-minute slot groups with explicit timezone and DST
semantics, and continuous recommendations use the configured meeting duration.

The roster source format, preview/merge/rebuild flow, duplicate rules, and paginated roster APIs
are implemented in the scheduling app.

Temporary/full identity rules, the restricted link session, shared versioned editing, upgrade, and
rollback behavior are enforced by the authn app.

Email delivery is configured in Django admin under **Email Delivery**. Authentication messages,
final notifications, invitations, and reminders use persisted retryable jobs. Roster mutation,
invitation, reminder, and finalization requests return after enqueueing; the email worker performs
provider calls. Add an active AWS SES provider with region, sender email, IAM access key id, and IAM
secret access key. Provider secrets and queued authentication content are encrypted in the database
and are not stored in Terraform or GitHub secrets. SES identities/domains and IAM permissions must
already be configured in AWS.

## Docker

```bash
# Backend
docker build -t releviz-api:local ./src/api
docker run --rm -p 4000:4000 \
  -e DJANGO_SETTINGS_MODULE=config.settings.local \
  releviz-api:local

# Frontend development/migration-fallback image (production traffic uses Amplify)
scripts/deploy/docker-build-frontend.sh releviz-web:local
docker run --rm -p 3000:3000 releviz-web:local
```

## Deployment

### Production

Production CD is three protected workflows on `main`, one per release surface, so a change only
releases what it touched:

| Workflow | Releases | Environment (role) | Paths that trigger it |
|---|---|---|---|
| `release-backend.yml` | SHA-tagged API image, ECS backend/worker rollout, default admin | `AWS ECS - Prod` (`releviz-production-github-deploy`) | `src/api/**` |
| `release-frontend.yml` | Amplify static site (candidate → production) and the ECS fallback image | `AWS Amplify - Prod` (`releviz-production-frontend-github-deploy`) | `src/web/**`, root `package*.json`, Amplify deploy scripts, export validator, custom headers |
| `release-infrastructure.yml` | Terraform for everything else in AWS | `AWS ECS - Prod` (`releviz-production-github-deploy`) | `infra/prod/**` |

Every successful `CI` run for a push to `main` offers the commit to all three. Each workflow first
runs a credential-free `scope` job that compares the commit with that workflow's last successful
release (or, before its first release, the retired single workflow's last release); when none of
its paths changed, the run ends there without an approval prompt. Changes to the workflows
themselves are exercised by a manual dispatch. Otherwise the release job waits in its protected
GitHub environment until a configured reviewer approves it, and only then receives short-lived
AWS credentials for that environment's role: backend and infrastructure releases wait in
`AWS ECS - Prod` and assume the production role, which owns Terraform state, ECS, and the
application secrets' metadata; frontend releases wait in `AWS Amplify - Prod` and assume the
frontend-only role, which can deploy the two Amplify release branches, push the fallback image,
and read the canonical alias, and nothing else. Each role trusts exactly one environment's OIDC
subject, so a frontend approval can never carry backend permissions. Any workflow can also be
dispatched manually for a redeploy or rollback, which additionally requires the exact
confirmation `DEPLOY`. A shared preflight action verifies that the immutable commit passed
`CI Result`, validates the scope's environment configuration, assumes that scope's role through
GitHub OIDC, confirms the assumed identity (and, for the frontend, that it cannot reach ECS), and
(for the Terraform releases) checks the protected remote state.

The backend release builds and pushes the SHA-tagged backend image, plans Terraform with only the
application runtime allowed to change (task definitions, services, autoscaling, alarms, logs, the
reminder schedule — anything else is refused and belongs to the infrastructure release), applies
the exact plan, waits for the backend, both durable workers, and the fallback frontend, verifies
their task definitions and the worker commands, checks target health and API smoke, and runs the
default-administrator one-off task. The ECS fallback frontend is held at the latest successfully
released frontend commit. The infrastructure release plans with both application images held at
their latest successful releases, refuses outright destroys and any change to the live Amplify
branches or domain (the Amplify app may only change its redirect rules), and applies the exact plan.

The frontend release builds one SHA-identified static ZIP from `src/web/out` and pushes the
ECS-fallback frontend image. It requires `releviz.com` to already be an available Amplify domain
serving the `main` branch at the apex (the split workflows operate only on the completed
Amplify-domain, API-subdomain topology and fail closed otherwise; the one-time cutover and its
apex-restore machinery were retired with the single release workflow), refuses to start while an
Amplify job is active, captures the live release and its retained rollback artifact, deploys the
exact ZIP to the Amplify `candidate` branch, verifies the frontend plus the direct
`https://api.releviz.com` CORS/auth/admin boundary, promotes the same ZIP to Amplify `main`, and
smokes the canonical domain. If the canonical smoke fails, the previous ZIP is redeployed to
`main` automatically. The reviewed infrastructure plan preserves the public TLS ALB
and private ECS boundary and keeps the backend on a fixed one-hop ALB trust model. Separate private
result and email ECS services use the same immutable backend release, database-aware health checks,
graceful 120-second shutdown, circuit-breaker rollback, retained logs, and fail-closed running-task
alarms; permanent and uncertain email outcomes also page from the email-worker log stream. Each
worker completes the same advisory-locked migrations before its watch command, without running
web-only static or administrator startup tasks. CD waits for both workers and verifies their selected
task definitions and exact watch commands on every backend image release. The Amplify app is not
connected to GitHub and does not use a PAT or an auto-build webhook.

The static build must match `src/web/amplify-routes.json`. Candidate smoke tests exercise
clean and trailing-slash routes, deployed JavaScript, query-preserving redirects, credentialed
CORS, protected non-GET auth requests, and a cookie/CSRF Django admin POST directly on the API
hostname. Unknown paths serve the exported 404 document through a final Amplify catch-all rule.
During the first API-subdomain cutover only, the workflow temporarily preserves the old
frontend proxy and `/api` prefix while the last-known-good ECS frontend remains the hot fallback.
After the API-aware Amplify release passes canonical smoke, the final reviewed plan advances the
ECS fallback to the current SHA, waits for it to become healthy, and removes that compatibility
surface plus the legacy `origin.releviz.com` DNS/certificate.

After the backend service is stable and its direct smoke tests pass, CD runs exactly one dedicated
private Fargate task to create or verify `admin@releviz.com`. The task receives its initial
password only from AWS Secrets Manager and exits before any Amplify release begins. Existing,
valid administrators are verified without changing their password or profile; an unexpected
existing identity or invalid privilege state fails the deployment closed. Long-running backend
and reminder tasks never receive the administrator password.

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
retry. Review the deployment procedures before every live release.

Keeping the API load balancer private requires a separately reviewed architecture migration. The
preferred direction is API Gateway with a VPC Link, or another documented private ingress design.
The current `api.releviz.com` boundary is public HTTPS at the ALB; ECS tasks remain private.

Run `infra/bootstrap` once with an administrator to create the versioned state bucket and the two
repository/environment-scoped OIDC roles. Supply the existing account-wide GitHub OIDC provider ARN;
bootstrap never creates or deletes that shared provider. Initialize with `-backend=false` for the
first apply, then migrate the local bootstrap state to `bootstrap/terraform.tfstate` in the new
bucket. Set its `production_deploy_role_arn` output as `AWS_PROD_ROLE_ARN` in the `AWS ECS - Prod`
environment and its `production_frontend_deploy_role_arn` output as `AWS_PROD_FRONTEND_ROLE_ARN` in
the `AWS Amplify - Prod` environment; do not store long-lived production AWS keys in GitHub.

Before enabling production CD, create `releviz/prod/default-admin-password` in AWS Secrets Manager
with a cryptographically generated password of at least 32 characters containing uppercase,
lowercase, numeric, and special characters. Store the secret as a JSON object with exactly one
string field named `password` (not as a raw plaintext SecretString); ECS selects that field
without exposing the rest of the secret. Supply its ARN as the fourth
`production_secret_arns` entry when applying `infra/bootstrap`; never put the password value in
Terraform inputs, GitHub, shell history, CI logs, or this repository.

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

Both protected environments require reviewer approval and allow deployments only from `main`.
Repository-level:

- `AWS_REGION` — `us-west-2`

`AWS ECS - Prod` (backend and infrastructure releases):

- `AWS_PROD_ROLE_ARN` — `production_deploy_role_arn` output of `infra/bootstrap`; trusted only
  for the `AWS ECS - Prod` Environment
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
- `PROD_DEFAULT_ADMIN_EMAIL` — optional override constrained to the reviewed
  `admin@releviz.com` address
- `PROD_DEFAULT_ADMIN_PASSWORD_SECRET_ARN` — exact ARN of
  `releviz/prod/default-admin-password`, whose SecretString is the documented JSON object with a
  `password` field; never the password value
- `PROD_ALARM_ACTION_ARNS_JSON` — non-empty JSON array of monitored SNS topic ARNs
- `PROD_SENTRY_DSN_SECRET_ARN`, `PROD_SECRET_KMS_KEY_ARN`, and
  `PROD_ACM_CERTIFICATE_ARN` — optional
- `PROD_DEFAULT_FROM_EMAIL` — verified production sender address

`AWS Amplify - Prod` (frontend releases; nothing backend-related belongs here):

- `AWS_PROD_FRONTEND_ROLE_ARN` — `production_frontend_deploy_role_arn` output of
  `infra/bootstrap`; trusted only for the `AWS Amplify - Prod` Environment
- `PROD_AMPLIFY_APP_ID` — the same exact app ID as above
- `PROD_DOMAIN` — `releviz.com`
- `PROD_API_DOMAIN` — must be the reviewed hostname `api.releviz.com`
- `PROD_ROUTE53_ZONE_ID` — hosted-zone ID for `releviz.com`; the frontend role may only read it
- `ECR_PROD_FRONTEND` — `releviz-prod-frontend`

Staging was permanently retired. Production application secret values live in AWS Secrets Manager;
GitHub holds only their ARNs in the protected `AWS ECS - Prod` Environment.
