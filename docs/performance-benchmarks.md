# 1,000-Person Performance Benchmarks

The release acceptance shape is one mixed-mode event with 1,000 participants, 1,000 authoritative
slots, and up to 100 concurrent schedule submissions. The application targets:

- organizer roster first-page p95 at or below 3 seconds;
- schedule-write p95 at or below 2 seconds;
- a fresh aggregate snapshot within 10 seconds of the last concentrated write;
- 1,000 invitation jobs handed to the configured provider within 15 minutes.

These are environment results, not properties proven by unit tests. Record hardware/container
limits, PostgreSQL version/configuration, API/worker process counts, commit SHA, date, and raw output
with every result. Do not compare laptop SQLite numbers to the PostgreSQL acceptance target.

The tools in `scripts/performance/` do not deploy infrastructure, call real SES, or alter Terraform.
They require Python 3.12 or newer. Activate the backend virtual environment before using the
`python3` commands below.

## Pure calculation benchmark

`benchmark_aggregation.py` builds a deterministic 25-date × 40-slot event (exactly 1,000 slots),
1,000 submitted response pairs, varied weights including zero, and a 60-minute continuous meeting.
It runs the same authoritative slot builder and sliding-window recommendation function used by the
application. Database and HTTP time are intentionally excluded.

```bash
python3 scripts/performance/benchmark_aggregation.py \
  --runs 3 --assert-p95-seconds 10
```

Use `--json` for a stored result. Fixture construction is reported separately because production
responses already reside in PostgreSQL. The measured phase covers both channel aggregate arrays and
top-ten continuous-window ranking. Three samples are useful for a local smoke check, not a
statistically strong capacity claim; increase to 10–20 runs on the designated benchmark host.

## Isolated PostgreSQL/HTTP scenario

The fixture command writes data. It is guarded as follows:

- PostgreSQL is mandatory;
- the database host must be loopback/local socket unless explicitly overridden;
- the database name must contain `test` or `perf` unless explicitly overridden;
- the confirmation code must exactly match the target event;
- replacement deletes only the event with that exact code, never the database;
- the bearer-token manifest defaults to `/tmp`, mode `0600`, and is refused inside the repository.

Use the disposable Postgres service:

```bash
docker compose -f docker-compose.e2e.yml up -d postgres

export DB_HOST=127.0.0.1
export DB_PORT=5433
export DB_NAME=releviz_test
export DB_USER=releviz
export DB_PASSWORD=releviz

scripts/wait-for-postgres.sh
python3 src/backend/manage.py migrate --noinput \
  --settings=config.settings.test_postgres
```

The disposable compose service starts PostgreSQL with `max_connections=200`, leaving headroom for
the 100 simultaneous request workers plus API and result-worker connections. Keep that setting in
the container command: the database uses tmpfs, so `ALTER SYSTEM` changes do not survive a restart.

Create 1,000 full test identities, participants, 1,000-slot empty schedules, weights, revocable
sessions, and a short-lived credential manifest:

```bash
python3 scripts/performance/prepare_scale_scenario.py \
  --settings config.settings.test_postgres \
  --event-code PERF1000 --confirm-code PERF1000 \
  --manifest /tmp/releviz-perf1000-manifest.json
```

The configured access token lifetime is short (10 minutes by default). Start the API and worker
with the same settings/environment, then run the load immediately.

Terminal 1 — API (production-style WSGI concurrency rather than Django's development server):

```bash
DJANGO_SETTINGS_MODULE=config.settings.test_postgres \
  src/backend/.venv/bin/gunicorn --chdir src/backend \
  --bind 127.0.0.1:4100 --workers 8 --threads 16 \
  config.wsgi:application
```

Terminal 2 — result worker:

```bash
python3 src/backend/manage.py recompute_event_results \
  --watch --limit=100 --poll-interval=0.25 \
  --settings=config.settings.test_postgres
```

Terminal 3 — load driver:

```bash
python3 scripts/performance/run_http_scale_scenario.py \
  --manifest /tmp/releviz-perf1000-manifest.json \
  --base-url http://127.0.0.1:4100 \
  --event-code PERF1000 --confirm-code PERF1000 \
  --request-count 1000 --concurrency 100 \
  --roster-reads 20 \
  --assert-roster-p95-ms 3000 \
  --assert-write-p95-ms 2000 \
  --freshness-timeout-seconds 10 \
  --json
```

The runner prepares request JSON before timing, reads the organizer's paginated 50-row first page,
sends all 1,000 two-channel submissions with at most 100 in flight, and polls the versioned result
endpoint until `status=fresh` and `requestedRevision=computedRevision`. Non-2xx responses fail the
run. The freshness timer begins after the final write completes, so retain worker logs if you also
want first-write-to-publication timing.

For a quick plumbing check, lower `--request-count`; such a run is not acceptance evidence. For a
repeat at full scale, recreate the exact event and obtain fresh versions/tokens:

```bash
python3 scripts/performance/prepare_scale_scenario.py \
  --event-code PERF1000 --confirm-code PERF1000 --replace
```

The tool's remote override exists for an explicitly isolated benchmark database/API only. It must
not be aimed at production, a university pilot, or any environment with data that matters.

## Email drain measurement

Invitation/reminder/final HTTP latency measures enqueueing, not provider acceptance. After creating
the guarded `PERF1000` fixture above, run the automated local provider simulation:

```bash
python3 scripts/performance/benchmark_email_drain.py \
  --settings config.settings.test_postgres \
  --event-code PERF1000 --confirm-code PERF1000 \
  --concurrency 10 --rate-limit 10 \
  --assert-seconds 900 --json
```

The driver refuses non-PostgreSQL databases, remote hosts, database names without `test`/`perf`,
SES mode, and non-simulator email backends. It creates a new idempotent delivery request for the
fixture's exact 1,000 participants, drains it through the production durable-job worker functions,
and fails unless all 1,000 jobs reach `sent`, none are permanent failures, and provider handoff
finishes within 15 minutes. Enqueue time and handoff time are reported separately.

The local provider/backend result proves worker throughput and progress accounting, not real SES
delivery. SES identity verification, account sandbox/quota, provider message IDs, bounce/complaint
handling, and inbox/calendar-client behavior remain separate out-of-scope validation.

## Cleanup

The manifest contains active short-lived bearer tokens. Delete it after every run:

```bash
rm /tmp/releviz-perf1000-manifest.json
```

Or pass `--delete-manifest-on-success` to the runner. When the entire disposable database is no
longer needed:

```bash
docker compose -f docker-compose.e2e.yml down -v
```

The compose database uses a temporary filesystem, but treat `down -v` as destructive and verify
the exact compose file before running it.

## Result record template

```text
Commit SHA:
Date/time and timezone:
Host/container CPU and memory:
PostgreSQL version/settings:
API processes/threads:
Result worker processes/poll interval:
Email worker processes/concurrency/rate:

Pure aggregation p50/p95/max:
Roster first-page p50/p95/max:
Schedule write count/failures/p50/p95/p99/max:
Result requested/computed revision and freshness seconds:
Email terminal counts and provider-handoff seconds:

Pass/fail against each threshold:
Known deviations or noise:
Raw output/log location:
```
