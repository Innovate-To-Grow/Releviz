# AGENTS.md

This file describes the current repository for coding agents. Releviz is a Django/Next.js
monorepo; references to the retired Express/DynamoDB implementation are obsolete.

## Commands

Run commands from the repository root unless noted otherwise.
Backend commands require Python 3.12 or newer; activate the backend virtual environment first.

```bash
npm install
python3 -m pip install -r src/backend/requirements/local.txt

npm run dev                              # Django :4000 + Next.js :3000
npm run dev:backend                      # Django only
npm run dev:frontend                     # Next.js only

npm --workspace=releviz-backend run lint
npm --workspace=releviz-backend run format:check
npm --workspace=releviz-backend run test
npm --workspace=releviz-frontend run lint
npm --workspace=releviz-frontend run format:check
npm --workspace=releviz-frontend run test
npm --workspace=releviz-frontend run build

npm run test:db                          # PostgreSQL suite (Docker by default)
npm run test:e2e                         # Chromium, Firefox, and WebKit
npm run quality-gate                     # complete local gate
python3 src/backend/manage.py makemigrations --check --dry-run \
  --settings=config.settings.test
```

## Architecture

The npm workspaces live under `src/`:

- `src/backend/` — Django 6, Django REST Framework, SimpleJWT, PostgreSQL in deployed/test-db
  environments, and SQLite for ordinary local development.
- `src/frontend/` — Next.js 16 App Router, React 19, Material Web, and a production static export.
- `src/e2e/` — Playwright coverage for the real browser workflow.

Business routes have no `/api` prefix. The backend is mounted directly at paths such as `/events`,
`/events/roster`, and `/health`. The frontend calls `NEXT_PUBLIC_API_BASE_URL` directly; it does not
contain Next.js API routes.

### Backend

Backend code is divided into three Django apps:

- `apps/authn/` — `Member`, verified contact identities, password/code flows, revocable JWT
  sessions, temporary-to-full upgrades, and authentication throttling.
- `apps/scheduling/` — events, participants, invitations, weights, roster imports, authoritative
  slots, lifecycle/finalization, aggregation snapshots, and temporary event sessions.
- `apps/messaging/` — provider configuration, durable delivery requests/jobs, templates, retry,
  iCalendar attachments, and delivery logs.

Important scheduling modules:

- `models.py` — relational domain model. Event access defaults to `invite_only`; new events start in
  `draft`. An event has at most 1,000 participants and 1,000 authoritative slots.
- `slots.py` — authoritative 15/30-minute slot groups, overnight windows, IANA timezones, and DST.
- `roster_imports.py` / `roster_views.py` — CSV/XLSX/paste previews, merge/rebuild commits, paginated
  roster reads, on-demand schedules, and individual/bulk updates.
- `aggregation.py` / `recommendations.py` — weighted and unweighted results plus continuous-window
  ranking. `Weight` contains only `weight` and `included`; there is no `required` concept.
- `result_snapshots.py` — revisioned, coalesced result computation that rejects stale publication.
- `views.py` / `operations_views.py` — event, response, launch, delivery, result, and finalization
  HTTP boundaries.

Long-running local workers:

```bash
python3 src/backend/manage.py recompute_event_results --watch --poll-interval=1 \
  --settings=config.settings.local
python3 src/backend/manage.py dispatch_email_jobs --watch --limit=1000 \
  --concurrency=10 --rate-limit=10 --poll-interval=1 \
  --settings=config.settings.local
```

Launch, invitation, reminder, and final-notification endpoints only commit durable jobs and return
`202`; they must not wait for a provider call. Authentication emails retain their own security
delivery behavior. See `docs/worker-runbook.md` and `docs/email-delivery.md`.

### Frontend

The App Router pages live in `src/frontend/app/`. Client UI and API helpers are in
`src/frontend/components/` and `src/frontend/lib/api/`.

The organizer surface is split into Overview, Roster, Results, and Finalize. Roster data is
server-paginated (50 by default, 100 maximum); do not restore an all-participant schedule grid.
Load a person's full two-channel schedule only when their edit drawer opens. Results are snapshots;
the UI polls while the status is `refreshing`.

### Data model and reset boundary

PostgreSQL is authoritative outside ordinary local development. The roster-scale migration is a
clean-data release: old users, events, feedback, provider settings, and delivery configuration are
not data-compatible release artifacts. No historical-data migration or data rollback is promised.
Do not delete a developer database without resolving the exact target and obtaining the operator's
intent, even though the production cutover itself assumes a new empty database.

Uploaded roster files are request-scoped and are never persisted. Normalized preview rows live for
at most 24 hours and are deleted on commit/cancel; receipts contain counts and hashes, not roster
PII.

## API conventions

- Organizer/private responses use `Cache-Control: private, no-store` and vary on authorization.
- Mutating operations use explicit event/participant versions and return `409` on stale writes.
- Bulk and delivery operations use idempotency keys; preserve request fingerprints.
- Email addresses are normalized to lowercase. Verified full identities are reused; unverified
  formal identities must not be silently claimed.
- Invite-only event details and joining require organizer, existing participant, or verified-email
  invitation access. Open-link events preserve code-based joining up to the participant cap.
- Any response/weight/inclusion change advances `results_revision`; publish a snapshot only when
  its target revision still matches the event.

## Testing and performance

Backend tests use Django's test runner. PostgreSQL-specific migration and locking behavior runs via
`scripts/run-db-tests.sh`. Frontend tests use Jest; browser tests use Playwright. CI additionally
checks strict coverage, migration drift, static export, dependency/security reports, Terraform,
and Docker images.

The local performance tools are intentionally separate from the normal test suite:

```bash
python3 scripts/performance/benchmark_aggregation.py --runs 3 \
  --assert-p95-seconds 10
python3 scripts/performance/prepare_scale_scenario.py --event-code PERF1000 \
  --confirm-code PERF1000
python3 scripts/performance/run_http_scale_scenario.py \
  --manifest /tmp/releviz-perf1000-manifest.json \
  --event-code PERF1000 --confirm-code PERF1000
```

The HTTP fixture tool refuses remote/non-performance PostgreSQL targets by default and writes a
mode-`0600` short-lived token manifest outside the repository. Never commit that manifest. See
`docs/performance-benchmarks.md` for the complete setup and acceptance interpretation.

## Infrastructure boundary

Production uses an Amplify static frontend and a private ECS Fargate backend behind a public TLS
ALB, with RDS PostgreSQL and Terraform under `infra/`. Deployment is protected and manual. The
1,000-person scheduling change does not authorize applying Terraform, creating a university pilot
environment, configuring OAuth calendar/storage integrations, or validating real SES delivery.
