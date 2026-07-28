# Authentication Security

## Session Design

Releviz uses a short-lived bearer access token plus a server-tracked refresh session:

- access tokens live for 10 minutes and exist only in frontend module memory
- refresh credentials live for 7 days in an `HttpOnly` cookie
- the cookie uses `SameSite=Lax`, path `/authn/`, and `Secure` in production
- every access token contains a server-session UUID and is rejected when that session is revoked,
  expired, missing, or belongs to another member
- server sessions have a 30-day absolute lifetime, so refresh rotation cannot extend them forever

The frontend removes the legacy `releviz.auth` value from both `localStorage` and `sessionStorage`.
No refresh credential is returned in JSON or made available to frontend JavaScript.

Deploying the secure-session migration invalidates legacy access/refresh tokens because they do not
contain a valid server-session UUID. Users with legacy credentials must sign in again.

## Password Transport

Password-bearing frontend requests first read `/authn/public-key/`. When the deployment requires
encrypted passwords, the browser imports the active RSA public key and encrypts each password field
with RSA-OAEP/SHA-256 before sending the request. The backend decrypts registration, password login,
password reset, password change, and account-deletion credentials with the selected active key.

Production requires this negotiation by default. Local and ordinary unit-test settings can leave it
disabled; the end-to-end settings force it on so the real browser/PostgreSQL account lifecycle
exercises encrypted payloads.

## Rotation and Lost-Response Recovery

Successful refresh calls rotate and blacklist the presented refresh token. The session stores the
current and immediately previous token identifiers.

If a response is lost after the backend committed a rotation, the previous token can recover the
already-issued current token once within 30 seconds, and only from the same normalized client IP and
user agent. The recovery is security-logged. A third use, a different client, an expired grace
period, a missing current token, or a mismatched session is rejected.

Invalid refresh responses delete the cookie so the browser does not loop indefinitely. The
frontend uses one in-flight refresh promise per loaded application instance and retries an API call
at most once after a 401.

Production refresh cookies are issued by `https://api.releviz.com` and remain host-scoped to that
API hostname. During the first switch from frontend-proxied authentication to the API subdomain,
the browser does not copy an existing frontend-host cookie to the new host. A user with an old
session can therefore be asked to sign in again when the in-memory access token expires.

## Revocation

Users can:

- sign out the current device
- list active sessions
- revoke another session
- sign out all devices

Password changes, password resets, and account deletion revoke every server session and blacklist
outstanding refresh tokens. Administrators can revoke selected sessions in Django admin.

## Recovery and Deletion

The public recovery flow uses the same non-enumerating response for known and unknown addresses.
Reset codes are encrypted in the durable email queue, expire after delivery, and can be used once.
A successful reset changes the password and revokes every existing device.

Authenticated users can change their password from settings. Account deletion requires the current
password and the exact confirmation text `DELETE`. Deletion revokes all sessions, disables the
member, removes contact records and authentication jobs/challenges, clears profile and staff data,
scrubs retained email recipients, and replaces participant/invitation identifiers while preserving
referential integrity for retained scheduling records.

## Cookie Request Protection

Cookie-authenticated mutation endpoints validate `Origin` when it is present. Allowed origins come
from the frontend URL, backend URL, configured CSRF trusted origins, and the request origin. Rejected
origins are security-logged.

Production sends browser API and authentication requests directly from `https://releviz.com` to
`https://api.releviz.com`. The two origins are different but remain same-site siblings. Django
allows the reviewed frontend and Amplify branch origins through credentialed CORS and CSRF origin
checks; the frontend CSP explicitly permits the API origin. Business endpoints have no `/api`
prefix. Django admin and its static assets are served by the backend at
`https://api.releviz.com/admin/` and `https://api.releviz.com/static/`, not through Amplify.

The public ALB terminates API TLS and appends its actual requester to the right side of
`X-Forwarded-For` without a client-port suffix. Production trusts exactly that one appended hop and
never trusts an earlier, caller-supplied address. The ECS backend has no public IP and accepts
application traffic only from the ALB security group.

## Abuse Controls

Rate-limit counters are persisted in PostgreSQL, updated under row locks, and keyed with an
HMAC-derived value rather than plaintext email addresses or IP/identity combinations.

Default production limits include:

| Scope                   |      IP limit |                                     Identity limit |
| ----------------------- | ------------: | -------------------------------------------------: |
| registration            |       10/hour |                                             5/hour |
| code request/resend     |       20/hour |                                             5/hour |
| code verification       | 30/10 minutes |                                      10/10 minutes |
| password login requests |  30/5 minutes |                                      15/15 minutes |
| password-login failures |             — | 20/hour, plus 5 per identity/IP pair in 15 minutes |
| refresh/logout          |    120/minute |                                                  — |
| admin login             |  20/5 minutes |                                      10/15 minutes |
| invitation requests     |       60/hour |                              20/hour per organizer |
| invitation recipients   |     1,000/day |                              500/day per organizer |
| reminder requests       |       30/hour |                              10/hour per organizer |
| reminder recipients     |     1,000/day |                              500/day per organizer |

Invitation batches are capped at 100 recipients and an event at 500 invitation recipients. Manual
reminder requests are capped at 500 recipients. Recipient quotas are weighted by recipient count,
not only request count.

Password authentication performs constant-work hashing for unknown and blocked identities.
Verification challenges expire, have bounded attempts, permit only one pending challenge per
member/purpose/channel, and cannot be replayed after use. Public registration, resend, login-code,
and password-reset responses avoid confirming whether an account exists.

## Idempotency and Replay Protection

Invitation and reminder requests require a UUID idempotency key. Reusing a key with changed content
returns a conflict. Per-recipient delivery jobs also use deterministic keys:

- invitation jobs are keyed by event, invitation, and stable message/calendar content
- reminder jobs are keyed by event, invitation, and response-deadline cycle

This prevents duplicate delivery even if a client accidentally retries with a new request key.

## Security Logging and Retention

Structured `releviz.security` events cover session issue/rotation/recovery/revocation, password-login
success/failure, request limits, cookie-origin rejection, idempotency conflicts, and invitation or
reminder request creation.

The scheduled reminder command also removes:

- stale rate-limit buckets after 7 days
- expired or long-revoked session records after 30 days
- expired SimpleJWT outstanding-token records
- stale undelivered authentication challenges and their pending delivery jobs

`AUTH_TRUSTED_PROXY_COUNT` remains the compatibility depth for environments with a fixed trusted
proxy chain. Production fixes it at `1`, leaves CIDR-hop trust disabled, and keeps the ALB in XFF
`append` mode with client-port suffixes disabled. Django therefore uses the immediate requester
that the ALB appended and cannot be tricked by an arbitrary forwarded prefix. Requests reach the
API ALB directly rather than through an Amplify reverse proxy, so that trusted hop represents the
ALB-observed requester. Identity-keyed controls remain the primary abuse boundary.

A future private-ingress design must replace the public API ALB boundary with a documented private
connection, such as API Gateway with a VPC Link. It must establish an explicit trusted proxy
boundary rather than inferring a multi-hop client identity.

## Remaining Scope

Authentication verification, welcome, login-alert, and password-reset messages now use encrypted,
durable, non-enumerating delivery jobs. Real provider-side SES delivery, bounce, and complaint
behavior remains externally unverified.
