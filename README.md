# Scheduler

A group meeting scheduler with weighted availability and real-time aggregation. Create an event, share the link, and find the best time for everyone.

![Scheduler Screenshot](Screenshoot.png)

## How to Use

### 1. Create an Event

Go to the home page and fill out the event form:

- **Event Name** — give your meeting a title
- **Meeting Type** — In-Person (requires a location) or Virtual
- **Time Range** — set the start and end hours to consider
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
3. Clicks and drags on the **schedule grid** to paint time slots with that availability level
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

| Layer          | Technology                                                                           |
| -------------- | ------------------------------------------------------------------------------------ |
| Frontend       | [Next.js 15](https://nextjs.org/) (App Router) + React 18 + Material Web components |
| Backend        | [Django 5](https://www.djangoproject.com/) + DRF + SimpleJWT                         |
| Database       | PostgreSQL/RDS in deployed environments; SQLite for local development                |
| Infrastructure | AWS ECS Fargate behind ALB (path-based routing)                                      |
| IaC            | Terraform (S3 remote state + AWS lock table)                                         |
| CI/CD          | GitHub Actions (lint, test, build, Docker build check, staging deploy)                |

## Project Structure

```
scheduler-monorepo/
  frontend/         # Next.js 15 — UI only, no API routes
  backend/          # Django — API server, account auth, admin
  infra/
    prod/           # Production Terraform (single ECS service, disabled)
    staging/        # Staging Terraform (2 ECS services, ALB path routing)
    bootstrap/      # Terraform state backend setup
  scripts/
    quality-gate.sh # Full lint + test + build for both workspaces
  .github/workflows/
    ci.yml          # Parallel CI for both workspaces
    deploy-staging.yml
```

## Local Development

```bash
npm install          # install all workspace dependencies
python3 -m pip install -r backend/requirements/local.txt
npm run dev          # start backend (4000) + frontend (3000)
npm run dev:backend  # backend only
npm run dev:frontend # frontend only
```

The frontend proxies `/api/*` and `/authn/*` requests to `http://localhost:4000` in dev via `next.config.js` rewrites.

Run checks:

```bash
npm --workspace=backend run lint
npm --workspace=frontend run lint
python backend/src/manage.py test --settings=config.settings.test
npm --workspace=backend run test
npm --workspace=frontend run test
npm --workspace=frontend run build
npm run quality-gate               # all of the above
```

## Runtime Environment Variables

### Backend

- `PORT` (default: `4000`)
- `DJANGO_SETTINGS_MODULE` (local default: `config.settings.local`, deployed default: `config.settings.production`)
- `DJANGO_SECRET_KEY`
- `DJANGO_FIELD_ENCRYPTION_KEY` — encrypts AWS SES IAM secrets stored from admin
- `DJANGO_ALLOWED_HOSTS`
- `FRONTEND_URL`
- `BACKEND_URL`
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

### Frontend

- `NEXT_PUBLIC_API_BASE_URL` — API base URL (empty = relative paths via proxy)
- `BACKEND_URL` — dev proxy target (default: `http://localhost:4000`)

Authentication is handled by the Django backend using email/password accounts, email verification codes, JWT access/refresh tokens, and a Django/Unfold admin at `/admin/`.

Email delivery is configured in Django admin under **Email Delivery**. Add an active AWS SES provider with region, sender email, IAM access key id, and IAM secret access key. The secret is encrypted in the database and is not stored in Terraform or GitHub secrets. SES identities/domains and IAM permissions must already be configured in AWS.

## Docker

```bash
# Backend
docker build -t scheduler-backend:local ./backend
docker run --rm -p 4000:4000 \
  -e DJANGO_SETTINGS_MODULE=config.settings.local \
  scheduler-backend:local

# Frontend
docker build -t scheduler-frontend:local ./frontend
docker run --rm -p 3000:3000 scheduler-frontend:local
```

## Deployment

### Staging

Staging deploys automatically via `deploy-staging.yml` after CI passes on `main`. Architecture:

- **ALB** routes `/api/*`, `/authn/*`, `/admin/*`, and `/static/*` to backend ECS service, everything else to frontend
- **2 ECS Fargate services** (backend on port 4000, frontend on port 3000)
- **PostgreSQL RDS** for accounts, admin data, events, participants, weights, and dashboard links
- **EventBridge** runs the reminder command every 15 minutes
- Legacy NoSQL tables remain in Terraform for backup only; the app no longer receives their names or permissions.

### Production

Production workflows are disabled (`.yml.disabled` suffix). Cutover from the monolith is planned separately.

### GitHub Actions Variables

- `AWS_REGION` — `us-west-2`
- `AWS_ROLE_ARN` — OIDC deploy role ARN
- `ECR_STAGING_BACKEND` — `scheduler-staging-backend`
- `ECR_STAGING_FRONTEND` — `scheduler-staging-frontend`
- `STAGING_DJANGO_SUPERUSER_EMAIL` — optional bootstrap admin email
- `STAGING_CREATE_DEFAULT_ADMIN` — `true` to create/update the bootstrap admin during deploy

### GitHub Actions Secrets

- `STAGING_DB_PASSWORD`
- `STAGING_DJANGO_SECRET_KEY`
- `STAGING_DJANGO_FIELD_ENCRYPTION_KEY`
- `STAGING_DJANGO_SUPERUSER_PASSWORD` — required only when `STAGING_CREATE_DEFAULT_ADMIN=true`
