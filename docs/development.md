# Development

## Setup

Use Python 3.12–3.14 (Django 6 and the hashed backend lock files require it). `npm run setup:api`
replaces `src/api/.venv` with a clean environment; set `PYTHON_BIN` if `python3` is not the right
interpreter.

```bash
npm install
npm run setup:api
source src/api/.venv/bin/activate
python src/api/manage.py migrate --settings=config.settings.local
npm run dev      # backend (4000) + frontend (3000)
npm run dev:api  # backend only
npm run dev:web  # frontend only
```

`src/api/.env.example` lists the local overrides. Django does not load it automatically, so export
only the values you need. See [configuration.md](configuration.md) for every variable.

The frontend calls the Django API directly at `http://localhost:4000` by default; set
`NEXT_PUBLIC_API_BASE_URL` to use another origin. Endpoints have no `/api` prefix, so the local
health check is `http://localhost:4000/health`.

Production serves the API with gunicorn running uvicorn workers (`-k uvicorn_worker.UvicornWorker`,
see `src/api/Dockerfile`). gunicorn's own ASGI worker is not used because it drops a request that
arrives on a kept-alive connection while Django is still finishing the previous one. Under ASGI,
Django reads a request body before routing or authenticating it, so the server refuses bodies over
50 MiB (twice the 25 MiB pasted-roster limit, which JSON escaping can double) with a 413.

`npm run dev` runs the API on SQLite under `runserver`, where the organizer workspace's pushed
change stream is unavailable and the workspace falls back to polling; push needs PostgreSQL and an
ASGI server. To exercise it locally, run Postgres and start the API with
`DJANGO_SETTINGS_MODULE=config.settings.e2e npm --workspace=releviz-api run start` with the `DB_*`
variables set, or run the e2e suite (`npm run test:e2e`), which brings up that stack itself.

## Background workers

Results and email are processed by two workers. Run them in separate terminals when working on
organizer results or email delivery:

```bash
python src/api/manage.py recompute_event_results --watch --poll-interval=1 \
  --settings=config.settings.local
python src/api/manage.py dispatch_email_jobs --watch --limit=1000 \
  --concurrency=10 --rate-limit=10 --poll-interval=1 \
  --settings=config.settings.local
```

Set `PRINT_EMAILS_TO_TERMINAL=1` to print outgoing email to the server terminal instead of sending
it.

## Backend dependencies

Dependency intent lives in `src/api/requirements/*.in`. After changing those files, run
`npm run lock:api` and commit all three hashed `.txt` lock files. CI checks that the locks still
reproduce on Python 3.12–3.14.

## Tests and checks

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

The scale tools in `scripts/perf` import from `src/api`, so run them with the backend virtualenv
active, for example `python scripts/perf/benchmark_aggregation.py`. The database and HTTP scenarios
ask for confirmation and refuse to run against anything but a loopback or test database.

## CI

Every pull request, push to `main`, and manual dispatch runs the full `ci.yml` suite, including for
documentation-only changes, and reports a single required `CI Result` check. The suite covers:

- backend tests with strict coverage, plus PostgreSQL migration and app tests
- frontend tests, coverage, bundle-size budgets, and the Amplify static-export build
- Playwright E2E in Chromium, Firefox, and WebKit
- dependency, secret, and static-analysis scans, SBOM and license reports
- Terraform tests and Docker image scans (high and critical findings fail the build)

## Docker

```bash
# Backend
docker build -t releviz-api:local ./src/api
docker run --rm -p 4000:4000 \
  -e DJANGO_SETTINGS_MODULE=config.settings.local \
  releviz-api:local

# Frontend fallback image (production traffic is served by Amplify)
scripts/deploy/docker-build-frontend.sh releviz-web:local
docker run --rm -p 3000:3000 releviz-web:local
```
