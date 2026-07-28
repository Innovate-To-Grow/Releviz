# Releviz Production-Candidate Goal Progress

Last updated: 2026-07-16 20:57 UTC

## Current Phase

Final engineering validation and external-validation handoff.

The production-candidate engineering contract is implemented and has been exercised through the
consolidated quality gate, PostgreSQL, browser automation, dependency audits, non-root Docker
images, Terraform mocked plans, deployment/rollback simulations, and an exact backup/restore drill.
No known P0 engineering defect or unaccepted high/critical production dependency vulnerability
remains. The next work requires target AWS access and real target users rather than more claims from
repository-only evidence.

## Current Product Maturity

`production candidate — engineering validation complete; external product validation pending`

This is not a claim that the product is production ready, externally validated, or proven to have
repeat usage. Real-user task success, SUS, real SES behavior, target-account operations, and the
60-day repeat-use cohort remain pending.

## Verified Facts

### Scheduling Correctness, Privacy, and Concurrency

- Official weighted and unweighted availability comes from one backend implementation.
- Only valid submitted responses from counted participants enter official results. Unsubmitted,
  hidden, excluded, removed, and invalid responses are classified but do not become zero-valued
  availability.
- Results report counted, unanswered, excluded, weighted/unweighted basis, and
  required-participant conflict totals.
- `own_only`, `all_after_submit`, and `realtime` participant-read semantics are enforced by backend
  permissions across direct, result, participant, and invitation access paths.
- Sensitive participant/result responses are private, `no-store`, and authorization-dependent.
- Events use centralized `draft`, `open`, `finalized`, `closed`, and `archived` lifecycle rules,
  backend-enforced deadlines, optimistic versions, legal transition checks, and stale-write
  recovery payloads.
- Availability saves/submissions are versioned and idempotent. Concurrent stale edits and lifecycle
  races return explicit conflicts rather than silently overwriting newer state.
- Events use backend-authored 15- or 30-minute slots, IANA timezones, weekly or specific dates,
  cross-midnight windows, and a maximum of 1,000 authoritative slots.
- Native JSON availability is validated against the authoritative slot count. Stringified JSON and
  malformed values are rejected.
- The legacy hourly-data migration preserves selected-day order and full-day events, expands values
  to 30-minute slots, handles DST-specific dates, and quarantines malformed records.
- Ambiguous or nonexistent DST wall-clock final times are rejected unless the supplied offset
  identifies a real event-timezone instant.
- Finalization is organizer-only, versioned, and idempotent. It previews attendance/conflicts, locks
  responses, transitions lifecycle state, and produces calendar messages with a stable UID and
  increasing sequence across cancellation and reconfirmation.

### Complete User Outcomes

- A user can register, verify email, log in by password or code, recover an account, change a
  password, update a profile, inspect/revoke sessions, sign out all devices, and delete an account
  with password plus destructive confirmation.
- An organizer can create and configure an event, invite by email or link, observe
  invited/opened/joined/draft/submitted/reminder status, manage visibility and weights, inspect the
  calculation basis, use ranked recommendations, preview/confirm a final time, reopen/reconfirm,
  close, archive, edit, reset responses, duplicate, and delete.
- A participant can open the correct invitation, join, inspect timezone/deadline/location/privacy,
  enter availability at a 320px viewport using touch and keyboard, use bulk actions, observe
  saving/saved/failure state, submit, modify or withdraw while permitted, and see only authorized
  shared information.
- Final confirmation and cancellation create durable per-recipient notifications and valid
  calendar content.
- Dashboard event management and the complete organizer/participant lifecycle are verified against
  the running frontend, backend, and PostgreSQL rather than mocks alone.

### Authentication, Abuse Prevention, and Email Reliability

- Access credentials live for 10 minutes in memory only. Refresh credentials are seven-day
  `HttpOnly`, `SameSite=Lax` cookies (`Secure` in production) bound to revocable server sessions
  with a 30-day absolute lifetime.
- Every access token requires an active server-session UUID. Logout, all-device logout, individual
  revocation, password change/reset, account deletion, and administrator revocation invalidate
  sessions server-side.
- Refresh rotation rejects replay and supports one bounded same-client recovery for a lost rotation
  response.
- Password-bearing browser requests negotiate RSA-OAEP/SHA-256 encryption when production requires
  encrypted payloads.
- Registration, login, verification, reset, refresh, admin login, feedback, invitations, and
  reminders use persisted rate/attempt controls, request and recipient quotas, expiry/replay
  protection, non-enumerating responses, and structured security events.
- Authentication, invitation, reminder, final-confirmation, and cancellation messages use durable,
  retryable delivery jobs with stale-lock recovery, bounded exponential backoff, permanent-failure
  state, deterministic per-recipient keys, and stable RFC `Message-ID` values.
- Authentication email content is encrypted at rest. Delayed delivery starts a fresh verification
  window; superseded, consumed, and expired challenges cancel stale work.

### Accessibility and Responsive Interaction

- Playwright exercises the participant flow at a 320 by 720 viewport, including a real touchscreen
  tap, keyboard activation, focus state, ARIA selection state, autosave, and submission.
- Public entry, privacy, terms, support, and feedback pages pass automated WCAG A/AA checks at
  320px without horizontal overflow.
- Keyboard-only focus reaches primary login controls with a visible indicator.
- Schedule cells expose labels, selected/read-only/disabled semantics, and support mouse drag,
  touch movement, keyboard activation, and bulk actions.
- Automated accessibility evidence validates applicable screen-reader semantics. A real assistive
  technology participant session remains part of external validation.

### Operations, Observability, Analytics, and Feedback

- The static frontend is served at `https://releviz.com`; the browser calls the Django backend
  directly at `https://api.releviz.com`, and business endpoints have no `/api` prefix.
- `https://api.releviz.com/health/live` is process liveness;
  `https://api.releviz.com/health` is database-aware readiness.
- Django admin is served by the backend at `https://api.releviz.com/admin/`, not by Amplify.
- Startup migrations use a PostgreSQL advisory lock through `migrate_safely`.
- Application logs are structured JSON with request IDs and a privacy-safe field allowlist.
- Optional Sentry integration removes PII, bodies, user data, breadcrumbs, extras, and arbitrary
  tags before sending.
- Production Terraform defines ALB/application 5xx, ECS running-task, request-exception, and
  permanent-email-failure monitoring plus 30-day log retention.
- Product metrics derive from authoritative domain timestamps and expose aggregate rates,
  durations, abandonment, repeat-creation cohorts, delivery reliability, and feedback counts
  without schedule content or identifiers.
- The metrics endpoint requires a dedicated production bearer token; ordinary user JWTs do not
  authorize it.
- Feedback has an accessible public entry point, rate-limited API, administrator review surface,
  privacy boundaries, and configurable retention. Privacy, terms, and support pages are present.
- Executable deployment, rollback, backup, restore, email dispatch, and recovery runbooks are in
  `docs/`.

## Final Automated Evidence

| Gate                      | Result                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- |
| Backend lint/format       | Ruff clean; 122 files formatted                                                   |
| Backend isolated suite    | 141 tests passed                                                                  |
| Backend coverage          | 4,340 statements and 1,136 branches; 100%                                         |
| PostgreSQL integration    | All 141 tests passed on PostgreSQL 16.14                                          |
| Frontend behavioral suite | 9 suites and 80 tests passed                                                      |
| Frontend coverage         | 90.48% statements, 79.49% branches, 85.18% functions, 91.56% lines                |
| Frontend production build | Next.js 15.5.20; all 16 routes generated                                          |
| Browser E2E               | 9 Chromium tests passed in 37.0 seconds                                           |
| Django migrations/checks  | No model drift; local/test and production deploy checks clean                     |
| Node dependency audit     | 0 known vulnerabilities at `--audit-level=low`                                    |
| Python dependency audit   | 0 known vulnerabilities in production requirements                                |
| Frontend Docker           | Built, audited, and runtime-smoked as non-root `nextjs`                           |
| Backend Docker            | Built as non-root `appuser`                                                       |
| Terraform                 | 1.15.8 format/validate/mock tests passed for bootstrap and production             |
| Repository audit          | Required runtime/test/deployment resources present and legacy auth surface absent |

The consolidated command passed after repeating backend coverage, frontend lint/format/coverage and
build, repository audit, PostgreSQL integration, and browser E2E:

```bash
PATH="$PWD/.venv/bin:$PATH" \
DB_TEST_SKIP_DOCKER=1 \
E2E_SKIP_DOCKER=1 \
npm run quality-gate
```

### Build and Recovery Artifacts

- Frontend image:
  `sha256:d30436aced6932ebaa2a06536ffabcae5072f3aae79d7fc4c4a5454d12b3983f`
- Backend image:
  `sha256:373c82c4752bafdd0e093f8f1224333c812788507a83e03723a64c1646818240`
- Frontend standalone lock:
  `aa545acff9ae5256c93381a56b3f824b2836eb0bee4beda79b85610286436f62`
- Monorepo lock:
  `a177cdbe3df9bcdece24d6680515e8e0011f34980e8a4d93110bb11928552ebb`
- Backend HTML coverage: `src/backend/htmlcov/index.html`
- Frontend HTML coverage: `src/frontend/coverage/lcov-report/index.html`
- Backup/restore evidence: `.artifacts/backup-restore/20260716T201425Z/evidence.json`
- Logical backup SHA-256:
  `1b402e697f46d41c571d9f4679336c6e83e04075bc93a04c1a5266fe3e4d5706`
- Source/restored manifest SHA-256:
  `42650e35417420b2700460ae1aa8063e5af89110b7150a7892e653873cf4785a`
- Database manifest SHA-256:
  `0a4db1c6f0c82976f46147f56f9138857bc0369e8969842b4817d90d8997f110`
- Backup/restore drill: 33 tables matched exactly; checksum, archive, migrations, system check, and
  temporary-database removal passed.
- Simulated guarded deploy evidence:
  `/tmp/releviz-rollout-deploy/evidence.json`
  (`4e1081bc9c9e81583978458535d2bb2a2f755f5cf77d9237181ab65818336bd7`)
- Simulated guarded rollback evidence:
  `/tmp/releviz-rollout-rollback/evidence.json`
  (`dabe450e79fe5863ea9c44337cff4c69e795c06ce0cb65a6358d205e91b8600c`)

## Executed Validation Commands

```text
PATH="$PWD/.venv/bin:$PATH" npm --workspace=releviz-backend run lint
PATH="$PWD/.venv/bin:$PATH" npm --workspace=releviz-backend run format:check
PATH="$PWD/.venv/bin:$PATH" npm --workspace=releviz-backend run test:coverage
npm --workspace=releviz-frontend run lint
npm --workspace=releviz-frontend run format:check
npm --workspace=releviz-frontend run test:coverage
npm --workspace=releviz-frontend run build
npm run test:audit
PATH="$PWD/.venv/bin:$PATH" DB_TEST_SKIP_DOCKER=1 npm run test:db
PATH="$PWD/.venv/bin:$PATH" E2E_SKIP_DOCKER=1 npm run test:e2e
npm audit --audit-level=low
uvx --from pip-audit==2.10.1 pip-audit -r src/backend/requirements/production.txt
scripts/docker-build-frontend.sh releviz-frontend:validation
docker build -t releviz-backend:validation src/backend
PATH="/tmp/releviz-tools/terraform-1.15.8:$PATH" scripts/terraform-check.sh
PATH="$PWD/.venv/bin:$PATH" scripts/backup-restore-drill.sh
python src/backend/manage.py makemigrations --check --dry-run --settings=config.settings.test
python src/backend/manage.py check --deploy --settings=config.settings.production
git diff --check
```

The frontend image was also started locally, fetched over HTTP, and inspected to confirm the
`nextjs` user and `node server.js` command.

## Failures Found and Root Causes

- The initial PostgreSQL wrapper used system Python without `psycopg`. Running through the locked
  project environment fixed the invocation; both database suites then passed.
- An early secure-cookie E2E run exposed a redirected refresh request whose browser response was
  lost after server-side rotation. The redirect was removed and one bounded same-client rotation
  recovery was implemented.
- A calendar idempotency test exposed a time-varying `DTSTAMP`. Calendar revision timestamps now
  derive from persisted meeting/event revisions.
- The feedback page initially failed static generation because `useSearchParams` lacked a Suspense
  boundary. The page was split into a Suspense-wrapped client body.
- A production `check --deploy` run exposed missing HSTS policy. Production now enables one-year
  HSTS, subdomains, and preload; the deploy check passes with no warnings.
- A repository test asserted an obsolete CI job label after the frontend gate was made
  core-inclusive. The assertion now follows the actual protected gate name.
- A Terraform mock initially asserted a provider field with the wrong shape. The assertion was
  corrected to the generated plan representation, after which both environment tests passed.
- The first complete E2E invitation-status run selected the wrong recipient link because Django's
  file backend stored multiple MIME messages in one file. The test helper now splits messages and
  matches the exact `To` header before extracting a link.
- The first standalone frontend Docker build tried to reuse the monorepo workspace lock as a
  standalone lock, which `npm ci` correctly rejected. The frontend now has an audited dedicated
  Docker lock and a reproducible build helper; CI no longer copies the incompatible root lock.
- The generated Docker lock was initially included in source formatting checks. It is now excluded
  from Prettier and remains validated by standalone `npm ci`, audit, and the image build.
- The baseline Node audit found 11 vulnerabilities, including six high findings. Dependency
  upgrades/overrides and lock regeneration reduced the final audit to zero known vulnerabilities.

## Unverified Assumptions and External Dependencies

- Real AWS SES acceptance, timeout, duplicate, bounce, complaint, suppression-list, and
  provider-message behavior have not been exercised with production credentials.
- A real target-account ECS deploy/rollback, SNS alarm delivery, RDS snapshot/PITR restore, object
  store backup upload, and production traffic cutover have not been performed from this workspace.
- Automated Chromium and semantic accessibility evidence does not replace testing with real target
  users, multiple assistive technologies, and broader production browser/device combinations.
- Product usefulness, independent task success, SUS, repeat-use intent, and observed 60-day repeat
  event creation remain unknown until the documented study is run.

## Remaining Risks

- Email is intentionally at least once. A provider acceptance immediately before process death can
  produce a duplicate retry; stable `Message-ID` values provide a deduplication signal but do not
  prove exactly-once delivery.
- Refresh lost-response recovery and rate attribution depend on correct
  `AUTH_TRUSTED_PROXY_COUNT` configuration at the public API ALB boundary.
- The first API-subdomain cutover can require users to sign in again because the previous
  frontend-host refresh cookie is not transferred to `api.releviz.com`.
- Alarm resources do not page anyone until monitored SNS action ARNs are configured and tested in
  the target account.
- RPO/RTO values are planning targets until measured on representative encrypted RDS data.
- `CreateEvent`, `ParticipantView`, and the organizer controller/panel surface remain sizeable.
  Organizer rendering is now split into focused panels, and all primary components are in the
  behavioral coverage surface, but further decomposition would reduce maintenance risk.
- A dedicated frontend Docker lock must be regenerated whenever frontend dependency declarations
  change; CI's clean image build is the enforcement point.

## Next Highest-Priority Task

Execute the external launch-readiness sequence:

1. Deploy the immutable images to the target AWS account through the guarded rollout procedure.
2. Verify real SES, SNS alarms, health/metrics, a representative RDS snapshot/PITR restore, and a
   rollback while retaining the resulting artifacts.
3. Run the private-beta study with at least five independent target users, including mobile,
   keyboard, and assistive-technology evidence.
4. Report independent task completion and SUS, then measure the defined 60-day repeat-creation
   cohort without prompting artificial second events.

## Goal Completion Checklist

- [x] All known P0 correctness, authorization, security, and data-reliability requirements are
      implemented and behaviorally verified.
- [x] Complete organizer lifecycle, including edit, reset, duplicate, archive, and delete, is
      verified.
- [x] Complete participant lifecycle, including invitation, touch/keyboard availability, autosave,
      submission, modification, withdrawal, and final-time access, is verified.
- [x] Critical scheduling, permissions, lifecycle, aggregation, time, and finalization rules are
      enforced by backend/domain implementations.
- [x] Desktop, 320px mobile, touch, keyboard-only, and applicable screen-reader semantics have
      automated evidence.
- [x] Unit, 100% backend branch coverage, core-inclusive frontend coverage, PostgreSQL, E2E,
      accessibility, dependency, build, Docker, and Terraform gates pass.
- [x] Email, migration, deployment, rollback, backup, and restore procedures are executable and
      engineering-verified; target-account execution is explicitly pending.
- [x] Analytics, feedback, metric definitions, retention boundaries, and a real-user validation plan
      are implemented.
- [x] No known unresolved P0 defect, high-risk data exposure, or unaccepted high/critical production
      dependency vulnerability remains.
- [x] Completion claims have command output, coverage reports, hashes, runtime checks, database
      verification, or local evidence artifacts.
- [x] Product maturity is limited to
      `production candidate — engineering validation complete; external product validation pending`.

### External Product and Target-Account Follow-Up

- [ ] Validate real SES delivery and provider failure/bounce/complaint behavior.
- [ ] Validate a real AWS deploy, alarm notification, rollback, and RDS snapshot/PITR recovery.
- [ ] Complete independent target-user sessions and meet the documented task-success/SUS criteria.
- [ ] Observe and review the 60-day repeat-creation cohort.
