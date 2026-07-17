# Observability and Alert Response

## Structured Application Logs

Application logs are one-line JSON. Every record contains `timestamp`, `level`, `logger`, and a
bounded `event` name. Request records additionally use a UUID `request_id`, HTTP method, resolver
route template, status, and duration. A valid incoming `X-Request-ID` is preserved; otherwise the
backend creates one and returns it in the response.

The formatter only admits an explicit safe-field allowlist: UUID/domain identifiers, operation and
message types, bounded counts, statuses, attempts, response status, duration, and exception type.
It rejects arbitrary logger extras. Exception stacks contain file, line, and function only; the
exception message is omitted. Django's default request logger is normalized to the fixed
`django_request` event so raw paths are not copied into logs.

Never log request or response bodies, headers, cookies, passwords, codes, invitation/access tokens,
event codes, raw URLs/query strings, names, email addresses, IP addresses, availability values,
locations, or feedback text.

Operationally important event names include:

- `request_completed`
- `request_exception`
- `django_request`
- `email_delivery_failed`
- `feedback_submitted`
- security events emitted through `releviz.security`

## Error Tracking

Sentry is disabled unless `SENTRY_DSN` is set. When enabled:

- default PII collection is disabled
- request bodies are never captured
- breadcrumbs are disabled
- request, user, breadcrumb, extra, and tag objects are removed before sending
- environment, release, and trace sampling come from deployment variables

Use `SENTRY_RELEASE` as an immutable image digest or Git revision. Configure project retention to
30 days or less and restrict project access to the on-call engineering group. A Sentry DSN is not a
substitute for the private metrics bearer token.

## Metrics and Alarms

Production Terraform provides:

- ALB-generated 5xx alarm
- application-target 5xx alarm
- ECS running-task alarm
- JSON-log metric and alarm for `request_exception`
- JSON-log metric and alarm for `email_delivery_failed` with `status=permanent_failure`

Set `alarm_action_arns` to one or more monitored SNS topics. An empty list creates alarm resources
without paging anyone and is not sufficient for a live production launch.

Product metrics are documented in [product-analytics.md](product-analytics.md). Access
`GET /api/metrics` with the dedicated bearer token:

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $METRICS_BEARER_TOKEN" \
  https://scheduler.example/api/metrics
```

## Runbooks

For target 5xx or request exceptions:

1. Record the alarm time, release, request IDs, affected route templates, and exception types.
2. Check `/api/health/live` and the database-aware `/api/health`.
3. Inspect the ECS deployment state and task exits.
4. Correlate with the most recent deployment and migrations.
5. Roll back the application revision when a release regression is likely, following
   [deployment-rollback.md](deployment-rollback.md).
6. Do not copy request payloads or capability URLs into tickets.

For ECS running-task alarms:

1. Inspect stopped-task reasons, target-group health, image pull/startup errors, and database
   connectivity.
2. Confirm that the deployment circuit breaker completed or rolled back.
3. Avoid reducing the minimum healthy percentage to force a rollout.

For permanent email failures:

1. Inspect failed jobs in Django admin by job ID, message type, attempts, and provider status.
2. Check provider configuration and SES account/identity status.
3. Correct the provider problem, then dispatch due jobs. Do not manually create duplicate jobs.
4. Treat authentication-code failures as time-sensitive; superseded/expired jobs must remain
   canceled.

For a metrics scrape failure:

1. Confirm that `METRICS_BEARER_TOKEN` is configured and the caller uses the dedicated token.
2. Check database readiness and query duration.
3. Rotate a disclosed token through the deployment secret path and restart tasks.

CloudWatch log retention is 30 days. Alarm notifications and the external Sentry project require
account-level configuration and must be tested in the target AWS account before launch.
