# Product Analytics

## Purpose and Boundary

Releviz computes product metrics from authoritative domain timestamps rather than sending schedule
details to a separate behavioral-event store. Reports contain aggregate counts, rates, and durations
only. They do not expose event codes, invitation tokens, names, email addresses, IP addresses,
availability values, meeting locations, free-text feedback, or individual user histories.

The implementation is in `apps.core.analytics`. A report covers the inclusive interval from
`as_of - window_days` through `as_of`. Timestamps after `as_of` are not counted. Current response
validity and current delivery-job status are used, so an old `--as-of` report is a deterministic
cutoff report over the current database snapshot, not a fully event-sourced historical replay.

## Data Dictionary

| Product event                       | Authoritative source                             | Timestamp or rule                                                                                                     |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Event created                       | `scheduling.Event`                               | `created_at`                                                                                                          |
| Invitation sent                     | `scheduling.EventInvitation`                     | `first_sent_at`, set on first successful delivery                                                                     |
| Invitation opened                   | `scheduling.EventInvitation`                     | first `opened_at`                                                                                                     |
| Participant joined                  | invitation and participant records               | first `joined_at`; participant `created_at` for completion cohorts                                                    |
| Draft saved                         | invitation and participant records               | first `draft_saved_at` / `first_draft_saved_at`                                                                       |
| Valid availability submitted        | invitation and participant records               | first `submitted_at` / `first_submitted_at`; official validity still comes from authoritative response classification |
| Final time confirmed                | `scheduling.FinalMeeting`                        | `confirmed_at`                                                                                                        |
| Event closed                        | `scheduling.Event`                               | `closed_at`                                                                                                           |
| Organizer created a second event    | organizer's ordered `Event.created_at` values    | second creation within 60 days of first                                                                               |
| Retry or permanent delivery failure | `messaging.EmailDeliveryJob`                     | `attempt_count` and current `status`                                                                                  |
| Error                               | privacy-safe structured logs and optional Sentry | `request_exception`, target 5xx, and security/domain events                                                           |
| Abandonment                         | derived                                          | a reached stage without the next stage by report time                                                                 |
| Feedback submitted                  | `core.FeedbackSubmission`                        | `created_at`; message text is never included in metrics                                                               |

First-occurrence timestamps are write-once where the product action may repeat. Repeated autosaves,
submissions, invitation deliveries, and retries therefore do not move the start of a duration.

## Metric Definitions

- Event invitation activation: events created in the reporting window that have at least one
  invitation successfully delivered by `as_of`, divided by all events created in the window.
- Invitation-to-valid-submission conversion: invitations whose first successful delivery is in the
  reporting window and whose submission timestamp is at or before `as_of`, divided by all such
  delivered invitations.
- Finalization rate: events created in the reporting window that currently have at least two valid,
  counted responses and a final-meeting confirmation at or before `as_of`, divided by all events in
  that currently eligible cohort.
- Closure rate: events created in the reporting window with `closed_at <= as_of`, divided by events
  created in the window.
- Creation-to-first-invitation time: median seconds from event creation to the earliest successful
  invitation delivery, for activated event-cohort members.
- Participant completion time: median seconds from participant-record creation to first valid
  submission for participants who joined in the reporting window.
- Invitation abandonment:
  - opened but not joined
  - joined but neither draft-saved nor submitted
  - draft-saved but not submitted
- Participant draft abandonment: participant records created in the window that have a first draft
  timestamp but no first submission by `as_of`.
- Organizer 60-day repeat creation: organizers whose first-ever event was created between 120 and
  60 days before `as_of` and who created a second event within 60 days of the first, divided by all
  organizers in that eligible cohort.
- Email retry rate: jobs created in the window with more than one attempt, divided by jobs with at
  least one attempt.
- Email permanent-failure rate: jobs created in the window currently in `permanent_failure`, divided
  by jobs with at least one attempt.

Every rate includes its numerator and denominator. Undefined zero-denominator rates are `null` in
JSON and `NaN` in Prometheus output rather than being represented as zero.

## Access and Execution

Generate a reviewable JSON report:

```bash
python backend/src/manage.py product_metrics \
  --days=30 \
  --settings=config.settings.production
```

Generate a deterministic cutoff report:

```bash
python backend/src/manage.py product_metrics \
  --days=30 \
  --as-of=2026-07-16T12:00:00+00:00 \
  --settings=config.settings.production
```

Prometheus-compatible metrics are available from `GET /api/metrics`. Production requires a
dedicated `METRICS_BEARER_TOKEN`; normal user JWTs do not authorize this endpoint. Responses are
private and `no-store`. Scrape at a low frequency because metrics perform authoritative domain
classification and are intended for product review, not high-frequency request telemetry.

## Internal Traffic, Privacy, and Retention

- Events organized by staff or superusers, and their invitations, responses, and event-linked email
  jobs, are excluded.
- Staff/superuser member feedback and member-linked delivery jobs are excluded.
- Anonymous feedback is included as a count only.
- Test automation should run in a separate environment. If it must run in a shared environment,
  organizer accounts must be marked staff or superuser before creating test records.
- Feedback text is visible only to authorized Django administrators and is automatically deleted
  after 730 days by the scheduled operations command. `FEEDBACK_SUBMISSION_RETENTION_DAYS` can
  shorten that period.
- CloudWatch application logs are retained for 30 days by production Terraform. Configure any
  external Sentry project to retain events for no more than 30 days.
- Scheduling records remain product records rather than analytics copies. Organizers can delete
  events, and account deletion applies the documented identifier-scrubbing rules.

Do not add raw email addresses, names, event codes, invitation/access tokens, IP addresses, user
agents, availability arrays, location text, feedback text, request bodies, or URL query strings to
metrics, logs, error-tracking tags, or dimensions.
