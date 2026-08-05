# Result and Delivery Worker Runbook

Releviz has two database-backed workers. They do not require Redis or an in-memory broker:

- the result worker coalesces event revisions and publishes versioned aggregate snapshots;
- the email worker claims durable outbox jobs and hands messages to the configured Django/SES
  provider.

Run both workers whenever the API accepts traffic. The commands handle `SIGINT`/`SIGTERM`, stop
claiming new work, finish the active bounded batch, release database connections, and exit.

This document describes application operation only. It does not authorize ECS/Terraform changes or
real SES validation for the 1,000-person release.

## Local commands

Ordinary SQLite development:

```bash
python3 src/backend/manage.py recompute_event_results \
  --watch --limit=100 --poll-interval=1 \
  --settings=config.settings.local

python3 src/backend/manage.py dispatch_email_jobs \
  --watch --limit=1000 --concurrency=10 --rate-limit=10 --poll-interval=1 \
  --settings=config.settings.local
```

For the isolated PostgreSQL performance environment, export the same `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, and `DB_PASSWORD` used by the API and replace the settings module with
`config.settings.test_postgres`.

One-shot maintenance:

```bash
# Recompute all due snapshots once.
python3 src/backend/manage.py recompute_event_results --limit=100 \
  --settings=config.settings.local

# Force one event even when its current snapshot is fresh.
python3 src/backend/manage.py recompute_event_results --event-code ABCD1234 \
  --settings=config.settings.local

# Dispatch one bounded email batch.
python3 src/backend/manage.py dispatch_email_jobs --limit=1000 \
  --concurrency=10 --rate-limit=10 \
  --settings=config.settings.local
```

Worker option guards:

- result `--limit`: 1–1,000; `--poll-interval`: 0.1–300 seconds;
- email `--limit`: 1–1,000; `--concurrency`: 1–64; `--rate-limit`: 0–1,000 messages/second;
  `--poll-interval`: 0.1–300 seconds.

`--rate-limit=0` disables application-side pacing. Use a positive rate that is no greater than the
provider/account allowance. Ten workers/messages per second can hand 1,000 invitations to the
provider in roughly 100 seconds in an error-free local/provider simulation, comfortably inside the
15-minute acceptance boundary; measure the real environment rather than treating that arithmetic
as delivery evidence.

## Result snapshot lifecycle

Every result-affecting transaction increments `Event.results_revision` and changes the associated
snapshot to `refreshing`. This includes submitted/draft availability changes, organizer proxy
edits, hide/include/weight changes, and roster commits.

The result worker:

1. Claims an event snapshot with a UUID lock token and records the requested revision.
2. Calculates weighted/unweighted channel arrays and the top ten continuous-duration candidates.
3. Locks the event and snapshot again before publication.
4. Publishes only if the event revision still equals the computed target revision.
5. Leaves the snapshot `refreshing` when a newer write won, or `failed` with a bounded error when
   computation itself failed.

A lock older than 15 minutes is reclaimable after process failure. Multiple writes to the same
event are coalesced: there is one snapshot row and the worker computes the newest requested revision
instead of one task per write.

`GET /events/results?code=...` returns:

```json
{
  "status": "fresh",
  "requestedRevision": 42,
  "computedRevision": 42,
  "generatedAt": "2026-08-05T03:00:00+00:00",
  "lastError": "",
  "results": {}
}
```

The frontend polls while `status` is `refreshing`, preserves the last published payload, and shows
its generation time. A `failed` snapshot is not silently represented as fresh. Diagnose the stored
error, correct the cause, and rerun a one-shot event recomputation or leave retry enabled in the
watcher. Use `--no-retry-failed` only during an incident where an uncontrolled failure loop would
make diagnosis harder.

## Email request lifecycle

Publishing an event (`POST /events/launch`), invitations, reminders, final confirmation, and final
cancellation all commit an `EmailDeliveryRequest` and its recipient jobs in the same database
operation. Their HTTP responses are `202 Accepted`; they never wait for SES or another backend.
Creating a temporary participant or importing a roster does not send mail.

Delivery request progress is available to the organizer:

```http
GET /events/delivery-requests/{requestId}
```

The response groups jobs by `pending`, `processing`, `retry`, `sent`, `permanentFailure`, and
`canceled`. Retry only the permanently failed recipients with:

```http
POST /events/delivery-requests/{requestId}
```

The retry operation resets only failed jobs and returns `202`; it does not duplicate successful
recipients.

The email worker atomically claims jobs, uses configurable thread concurrency and a shared rate
limiter, and updates each job independently. The default job budget is five attempts with 1, 2, 4,
and 8 minute delays. A `processing` lock older than 15 minutes is reclaimable. Stable idempotency
keys and RFC `Message-ID` values reduce duplicates, but provider delivery is at least once: a
process can fail after provider acceptance and before the database commit.

Final calendar messages preserve a stable UID and increment `SEQUENCE`; confirmation/update uses
`METHOD:REQUEST`, and reopening/cancellation uses `METHOD:CANCEL`. Final notifications include only
people still on the roster whose initial invitation was successfully handed to the provider. The
organizer can also download the current `.ics` representation from the finalization calendar
endpoint.

## Triage checklist

When snapshots remain `refreshing` beyond ten seconds:

1. Confirm the result worker is running against the same database/settings as the API.
2. Read the worker's latest attempted/published/failed/skipped summary.
3. Inspect `Event.results_revision` and the snapshot's requested/computed revision and lock time.
4. Check whether schedule writes are still arriving; a moving revision deliberately prevents stale
   publication.
5. Force one event after writes stop and investigate any persisted `last_error`.

When invitations do not drain:

1. Read the delivery request progress rather than relying on the API's `202`.
2. Confirm the email worker is running, provider pacing is appropriate, and its database clock is
   consistent.
3. Inspect `next_attempt_at`, attempt count, lock age, and last error in Django admin.
4. Correct provider/configuration errors; use the delivery request retry endpoint for permanent
   failures.
5. Do not mark provider acceptance as inbox delivery. Real SES identity, sandbox, quota, bounce,
   complaint, and downstream-client evidence are separate release checks.

## Safe shutdown and restart

Send `SIGTERM` and allow the process its batch timeout. Do not kill database sessions as a normal
shutdown mechanism. If a process is force-killed, its current locks become reclaimable after 15
minutes; do not manually clear them unless the owning process is known to be gone. Starting more
worker processes increases database/provider concurrency, so keep the aggregate rate—not only each
process's `--rate-limit`—within the approved bound.
