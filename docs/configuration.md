# Configuration

## Backend environment variables

### Core

| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `4000`) |
| `DJANGO_SETTINGS_MODULE` | `config.settings.local` locally, `config.settings.production` when deployed |
| `DJANGO_SECRET_KEY` | Django signing key |
| `DJANGO_FIELD_ENCRYPTION_KEY` | Encrypts stored SES credentials and queued authentication email content |
| `DJANGO_ALLOWED_HOSTS` | Allowed hostnames |
| `FRONTEND_URL` | Frontend origin |
| `BACKEND_URL` | Canonical backend origin (`https://api.releviz.com` in production) |
| `CORS_ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS` | Cross-origin and CSRF allow lists |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` | PostgreSQL connection (`DB_PORT` defaults to `5432`) |

### Startup and administrator

| Variable | Purpose |
|---|---|
| `DJANGO_MIGRATE_ON_START` | `1` in worker tasks: run advisory-locked migrations before the watch command |
| `DJANGO_SKIP_STARTUP_TASKS` | `1` in worker tasks: skip static file collection and administrator bootstrap |
| `DJANGO_CREATE_DEFAULT_ADMIN` | `1` creates the administrator on container start (legacy; `0` in production) |
| `DJANGO_SUPERUSER_EMAIL`, `DJANGO_SUPERUSER_PASSWORD` | Administrator created by the bootstrap |

### Email

| Variable | Purpose |
|---|---|
| `USE_SES_EMAIL_PROVIDER` | `1` when deployed; local and test email backends bypass SES |
| `PRINT_EMAILS_TO_TERMINAL` | `1` prints outgoing email instead of sending it. Local only: production rejects it and E2E forces it off |
| `EMAIL_WORKER_BATCH_SIZE`, `EMAIL_WORKER_CONCURRENCY`, `EMAIL_WORKER_RATE_PER_SECOND`, `EMAIL_WORKER_POLL_SECONDS` | Email worker tuning (defaults `100`, `10`, `10`, `1`) |

### Results worker

| Variable | Purpose |
|---|---|
| `RESULT_WORKER_BATCH_SIZE`, `RESULT_WORKER_POLL_SECONDS` | Batch size and poll interval (defaults `100`, `1`) |
| `RESULT_SNAPSHOT_LOCK_TIMEOUT_SECONDS`, `RESULT_FAILURE_RETRY_DELAY_SECONDS` | Lock timeout and retry delay (defaults `60`, `30`) |

### Security and observability

| Variable | Purpose |
|---|---|
| `REQUIRE_ENCRYPTED_PASSWORDS` | `1` by default in production: passwords are sent RSA-OAEP/SHA-256 encrypted with the server's public key |
| `AUTH_TRUSTED_PROXY_COUNT` | Number of trusted proxies used to find the client IP (`1` in production, for the ALB) |
| `METRICS_BEARER_TOKEN` | Required in production; protects the private metrics endpoint |
| `APP_LOG_LEVEL` | JSON log level (default `INFO`) |
| `SENTRY_DSN` | Optional; error tracking is off when empty |
| `SENTRY_ENVIRONMENT` | Sentry environment name |
| `SENTRY_RELEASE` | Release identifier (an image digest or Git SHA); also reported as `release` by the health endpoints |
| `SENTRY_TRACES_SAMPLE_RATE` | Trace sampling from `0` to `1` (default `0.05`) |

## Frontend environment variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | API origin: `https://api.releviz.com` in production, `http://localhost:4000` locally |
| `AMPLIFY_STATIC_EXPORT` | Set by `build:amplify` to export to `src/web/out`; leave unset for the local Next server |

## Architecture notes

**Hosting.** Amplify serves the static UI at `https://releviz.com`, and the browser calls the API
directly at `https://api.releviz.com`. Endpoints have no `/api` prefix (for example `/health` and
`/events`). The public ALB terminates TLS; the ECS backend has no public IP and accepts traffic only
from the ALB. Django admin is at `https://api.releviz.com/admin/`, not on the frontend.

**Authentication.** The Django backend handles email/password accounts, emailed verification codes,
short-lived in-memory JWT access tokens, an `HttpOnly` refresh cookie tied to a revocable server
session, optional browser-side password encryption, account recovery, and session management.

**Response ownership.** The organizer may enter a full account's response only until that person
claims it by joining, saving or submitting their own response, or upgrading from a temporary
identity (`Participant.response_claimed_at`, never cleared while the row exists). Organizer-managed
people are backed by a temporary member with no contact email; phone numbers are display-only (no
SMS and no phone login).

**Email delivery.** Configure providers in Django admin under **Email Delivery**: add an active AWS
SES provider with its region, sender address, and IAM access key. Authentication email, invitations,
reminders, and final notifications are stored as retryable jobs. Requests return once the jobs are
queued, and the email worker makes the provider calls. Provider secrets and queued authentication
content are encrypted in the database, not stored in Terraform or GitHub. SES identities and IAM
permissions must already exist in AWS.
