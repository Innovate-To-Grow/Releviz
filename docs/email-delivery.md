# Durable Email Delivery

## Current Scope

Final-meeting confirmations/cancellations, invitations, reminders, authentication verification,
welcome messages, login alerts, and password-reset codes use a transactional outbox. The relevant
domain change and delivery job are committed before any provider call occurs.

Authentication challenge jobs are linked to the member and challenge. Login alerts are linked to
the member and issued server session. Welcome delivery is committed in the same transaction that
activates registration.

## Delivery States

`EmailDeliveryJob` records are operator-visible in Django admin and use these states:

- `pending`: committed and ready for a first attempt
- `processing`: claimed by one dispatcher
- `retry`: failed and waiting for exponential backoff
- `sent`: provider/backend accepted the message
- `permanent_failure`: bounded retries were exhausted
- `canceled`: the work is no longer valid, such as a verification code superseded by a resend

The default maximum is five attempts. Retry delays are 1, 2, 4, and 8 minutes after successive
failures. Authentication challenge jobs use four attempts within their one-hour pending-delivery
window. A `processing` job with no lock timestamp, or a lock older than 15 minutes, can be reclaimed
after a process restart.

## Dispatch Procedures

Application APIs attempt newly committed jobs immediately after commit. A provider failure does not
roll back the accepted domain operation or alter a public non-enumerating account response; the job
remains persisted for retry.

Dispatch all due jobs manually:

```bash
python backend/src/manage.py dispatch_email_jobs --limit=100 \
  --settings=config.settings.production
```

The existing scheduled reminder command also dispatches up to 100 due jobs, so the deployed
15-minute reminder schedule creates due reminder jobs and recovers all pending delivery work without
a separate in-memory queue:

```bash
python backend/src/manage.py send_due_event_reminders --window-minutes=20 \
  --settings=config.settings.production
```

Inspect job status, attempts, next-attempt time, last error, event, invitation, member, challenge,
and session in Django admin under `Messaging > Email delivery jobs`. Request-level invitation and
reminder keys and recipient counts are under `Messaging > Email delivery requests`.

## Authentication-Code Safety

Authentication email bodies are encrypted at rest with `DJANGO_FIELD_ENCRYPTION_KEY`; the
dispatcher decrypts them only when attempting delivery. The challenge model continues to store only
a password hash of the six-digit code.

A new email challenge initially has a one-hour pending-delivery window. Successful delivery sets
`last_sent_at` and starts a fresh 10-minute verification window, so a delayed retry does not deliver
an already-expired code. Creating a replacement challenge expires the old challenge and cancels its
pending, retrying, or processing job. The scheduled security cleanup also expires stale undelivered
challenges and cancels their jobs.

## Idempotency and Duplicate Boundary

Each recipient operation has one unique delivery-job key and one stable RFC `Message-ID`.

- final messages are keyed by event, calendar sequence, operation, and recipient
- invitations are keyed by event, invitation, and stable content
- reminders are keyed by event, invitation, and response-deadline cycle
- verification jobs are keyed by challenge UUID
- welcome jobs are keyed by member UUID
- login alerts are keyed by the issued auth session or admin-session login event

Invitation/reminder APIs also require UUID request keys. Reusing a request key with changed input is
rejected, while a new request key still cannot create a duplicate per-recipient job. Calendar
updates reuse the event UID and increment `SEQUENCE`.

Delivery is intentionally at least once. A provider may accept a message immediately before the
application process dies, leaving the job reclaimable. A later attempt could therefore produce a
duplicate provider delivery, although the stable `Message-ID` gives receiving systems a deduplication
signal. AWS SES does not provide a general send idempotency key, so exactly-once delivery cannot be
claimed.

## Calendar Semantics

Final attachments use CRLF line endings, RFC line folding, UTC `DTSTART`/`DTEND`, the event IANA
timezone, a stable UID, increasing sequence, organizer and recipient fields, and `REQUEST` or
`CANCEL` method/status semantics.

## Verified Automated Scenarios

- complete provider failure leaves retryable jobs
- timeout uses bounded exponential backoff
- one recipient can fail while others succeed
- successful retry transitions to `sent`
- final attempt transitions to `permanent_failure`
- stale `processing` jobs recover after a simulated restart
- duplicate enqueue and confirmation requests create no duplicate work
- repeated invitation/reminder requests with the same or a new key create no duplicate work
- invitation/reminder provider timeout leaves retryable persisted jobs
- successful invitation/reminder delivery updates the corresponding delivery timestamp
- invitation/reminder request and recipient bulk limits are enforced
- reopening emits a cancellation with the same UID and a higher sequence
- reconfirmation keeps the UID and advances the sequence again
- provider failure during registration-code, welcome, login-alert, contact-verification, and
  password-reset delivery leaves encrypted retryable jobs
- known-account code and reset requests preserve the same public response during provider timeout
- delayed challenge delivery starts a fresh verification window
- superseded, consumed, and expired challenge jobs are canceled instead of sending stale codes

Real SES credentials and provider-side delivery evidence have not yet been validated.
