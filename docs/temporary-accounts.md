# Temporary Accounts and Shared Schedules

## Organizer Flow

Participant Manager accepts a required display name and email at
`POST /events/participants/managed?code=...`. The transaction normalizes the email and reuses an
existing global Member only when it is either `temporary` or a `full` account whose matched contact
email is verified. A matched but unverified `full` contact is rejected without creating any event
records. Otherwise it creates an active `temporary` Member with an unusable password and unverified
primary contact, then creates or reuses the event's single Participant, Dashboard link, and unsent
invitation. No email is sent by this operation.

The organizer uses `POST /events/invitations` to send or resend. Participant responses expose email,
`accountAccess`, normalized invitation state, and `canOrganizerEditAvailability` only to the
organizer. Temporary rows have a schedule drawer; full-account rows never do. Organizer edits to a
temporary participant's event name, availability, and submitted flag update the same Participant
record used by the invitee and require `expectedVersion`. A stale write returns `409` with the
latest Participant. Invitations whose first send has not completed are excluded from manual and
scheduled reminders as well as final-meeting notifications.

## Temporary Recipient Flow

The emailed `/temp-access?code=...&invitation=...` link starts a non-enumerating code request. The
six-digit challenge lasts ten minutes after delivery and permits five failed attempts. Verification
creates a seven-day, event-scoped opaque cookie session. The recipient can read the current event,
edit or submit the same Participant record, see results under the event's existing visibility rule,
log out, or start an upgrade. No global application navigation or ordinary authenticated API is
available to this cookie.

Cookie-authenticated writes validate the request origin. Event state, deadline, exclusion, schedule
shape, and version checks are identical to ordinary participant writes. The server never merges two
stale drafts or silently chooses the last writer.

## Upgrade and Rollback

“Upgrade to full access” opens standard registration with only the upgrade mode, event code, and
post-registration destination in the URL; the email is never placed in the URL or browser history.
The registration page reads the email from the event-scoped temporary cookie session and keeps it
locked. `POST /events/temp-access/upgrade-registration?code=...` validates that same session and
request origin, applies registration rate limits by IP and Member, and supplies the Member's email
server-side regardless of client input. If the session cannot be resolved, registration remains
disabled. The public registration endpoint cannot mutate a temporary Member merely because its
email was supplied. It may issue a separately scoped mailbox-claim code without changing the
temporary identity; the caller must resubmit the registration details with that code, and only
successful verification may authorize the in-place upgrade. This lets the real mailbox owner claim
an address even if an organizer created it but never sent an event invitation.

The ordinary registration verification endpoint then completes the selected server-scoped
challenge on the same Member UUID. Only successful verification changes the member to `full`; it
also verifies the contact, revokes temporary sessions, expires temporary challenges, cancels queued
temporary-link email work, preserves all participants and weights, adds existing events to
Dashboard, and synchronizes the formal name to every event Participant. The organizer's next
attempted co-edit is rejected with the latest full account state.

The migrations are additive: `Member.access_level`, challenge scope/purpose, and
`TemporaryEventSession`. Rolling application code back leaves temporary members as active accounts
with unusable passwords and unverified contacts, so ordinary login remains unavailable and all
scheduling records remain intact. If the previous code completes an ordinary registration against a
temporary identity during the rollback window, the forward version recognizes its verified contact
and valid password on the next login, upgrades the same UUID, and runs the normal scheduling/session
cleanup. Restoring temporary-link access itself requires redeploying the forward version.

## API Surface

- `POST /events/participants/managed?code=`
- `POST /events/invitations?code=`
- `POST /events/temp-access/request-code`
- `POST /events/temp-access/verify`
- `GET /events/temp-access/session?code=`
- `POST /events/temp-access/upgrade-registration?code=`
- `PUT /events/temp-access/participant?code=`
- `POST /events/temp-access/logout`
