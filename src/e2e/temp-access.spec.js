const { randomUUID } = require("node:crypto");
const { expect, test } = require("@playwright/test");
const {
  expectAccessible,
  expectNoHorizontalScroll,
} = require("./helpers/accessibility");
const {
  BACKEND_URL,
  FRONTEND_URL,
  apiJson,
  beforeUnloadIsBlocked,
  createEvent,
  differentCode,
  emailsSentTo,
  finalizeViaApi,
  freshResults,
  invitationLinkFromEmail,
  latestEmailFor,
  latestVerificationCode,
  newRunId,
  registerAccount,
  registerAccountViaApi,
  runDjangoJson,
  runDjangoScript,
  setLifecycleViaApi,
  slotIndex,
  submitResponse,
  tempAccessSessionState,
  temporaryAccessPathFromEmail,
} = require("./helpers/releviz");
const {
  addPersonApi,
  invitationEmail,
  requestRecorder,
  rosterByEmail,
} = require("./helpers/participants");
const { joinEventInBrowser } = require("./helpers/workspace");

// Temporary event access from the invited person's side: the invitation
// link, which opens the schedule by itself (the token's trip from the address
// bar into the tab, a link that is not active, a failed or throttled open,
// the uniform open API), the event-scoped session cookie (resume, scope,
// Origin checks), the temporary editor (painting, both channels, conflicts,
// failed saves), signing out, the ways access ends, the upgrade page's error
// states, and the participant pages at 320px. Organizers, events and
// invitations are seeded through the API; the browser drives the behaviour
// under test.

const TEMP_COOKIE = "releviz_temp_event";
const TEMP_COOKIE_LIFETIME_S = 7 * 24 * 60 * 60;
// A link that matches no live temporary invitation: every cause gets the
// same answer and the same page.
const INACTIVE_LINK = "This invitation link isn't active";
const INACTIVE_LINK_EXPLAINED =
  "It may have been replaced by a newer invitation, or the organizer changed the address it was sent to. Ask the organizer to send it again, or sign in if you have a Releviz account.";
const INACTIVE_BODY = {
  error: "This invitation link is not active.",
  errorCode: "temp_invitation_inactive",
};
const OPEN_FAILED_TITLE = "Invitation not opened";
const OPEN_FAILED =
  "We could not open your invitation. Check your connection and try again.";
const OPEN_THROTTLED = "Too many attempts. Wait a moment and try again.";
const LINK_REQUIRED = "Access link required";
const OPEN_THE_LINK =
  "Open the temporary access link in your invitation email.";
const LINK_FOR_ITS_EVENT =
  "Open the temporary access link in your invitation email. The link only works for its event.";
const DRAFT_SAVED = "Draft saved. Submit when you are ready.";
const SAVE_UNAVAILABLE = "Saving is unavailable right now.";
const FOREIGN_ORIGIN = "https://evil.example";
const ORIGIN_REFUSED = { detail: "Request origin is not allowed." };
// The synchronous Django helpers block Node's event loop, so an idle
// keep-alive socket the server closed meanwhile can still look reusable and
// fail with ECONNRESET ("socket hang up") on the next call. Direct API calls
// retry that one network error; the server never saw the failed attempt.
const STALE_SOCKET_RETRIES = 2;

function heading(page, name) {
  return page.getByRole("heading", { level: 1, name, exact: true });
}

// Next.js mounts its own role=alert route announcer, so page alerts are read
// from inside the page's <main>.
function mainAlert(page, text) {
  return page.getByRole("main").getByRole("alert").filter({ hasText: text });
}

function mainStatus(page, text) {
  return page.getByRole("main").getByRole("status").filter({ hasText: text });
}

function invitationStorageKey(code) {
  return `releviz.temp-access.invitation:${code}`;
}

function storedInvitation(page, code) {
  return page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    invitationStorageKey(code),
  );
}

// The event cookie as the browser holds it. Its path is the temp-access API,
// so it is looked up by a URL under that path.
async function tempCookie(context) {
  return (await context.cookies(`${BACKEND_URL}/events/temp-access/`)).find(
    (cookie) => cookie.name === TEMP_COOKIE,
  );
}

const SAVE_ROUTE = /\/events\/temp-access\/participant\?/;
const SESSION_ROUTE = /\/events\/temp-access\/session\?/;
const LOGOUT_ROUTE = /\/events\/temp-access\/logout$/;
const OPEN_ROUTE = /\/events\/temp-access\/open$/;

function isOpen(request) {
  return request.method() === "POST" && OPEN_ROUTE.test(request.url());
}

// The next answer to opening an invitation link (POST events/temp-access/open).
function nextOpen(page) {
  return page.waitForResponse((response) => isOpen(response.request()));
}

function isTempSave(request) {
  return request.method() === "PUT" && SAVE_ROUTE.test(request.url());
}

// The next temporary-access save (PUT events/temp-access/participant).
function nextTempSave(page, predicate = () => true) {
  return page.waitForResponse(
    (response) =>
      isTempSave(response.request()) && predicate(response.request()),
  );
}

// Answers a routed cross-origin API call with an error the page can read
// (the CORS headers let fetch resolve instead of failing as a network error).
async function fulfillError(route, status, body) {
  const origin = await route.request().headerValue("origin");
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "Access-Control-Allow-Origin": origin || new URL(FRONTEND_URL).origin,
      "Access-Control-Allow-Credentials": "true",
    },
    body: JSON.stringify(body),
  });
}

// A route handler that answers `method` requests with that error and lets
// anything else through, such as a CORS preflight a browser may route.
function failRequests(method, status, body) {
  return (route) =>
    route.request().method() === method
      ? fulfillError(route, status, body)
      : route.fallback();
}

// PUT events/temp-access/participant with the page's own cookie, as another
// tab of the same person would.
function tempAccessPut(page, code, body) {
  return page.evaluate(
    async ({ url, data }) => {
      const response = await fetch(url, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return { status: response.status, payload: await response.json() };
    },
    {
      url: `${BACKEND_URL}/events/temp-access/participant?code=${code}`,
      data: body,
    },
  );
}

// POST events/temp-access/<path> with the page's own cookie, as the app's
// pages do. A 204 has no payload.
function tempAccessPost(page, path, body) {
  return page.evaluate(
    async ({ url, data }) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const text = await response.text();
      return {
        status: response.status,
        payload: text ? JSON.parse(text) : null,
      };
    },
    { url: `${BACKEND_URL}/events/temp-access/${path}`, data: body },
  );
}

// A route handler that holds temporary-access saves until release() is
// called; `entered` resolves once one is being held.
function holdTempSaves() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const handler = async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    entered();
    await gate;
    await route.continue();
  };
  return { held: { handler, entered: enteredPromise }, release };
}

// An organizer (API) and one active event of theirs.
async function organizerEvent(request, label, overrides = {}) {
  const runId = newRunId();
  const organizer = await registerAccountViaApi(
    request,
    `${label}-org-${runId}@example.com`,
    "Olive",
    "Organizer",
  );
  const event = await createEvent(request, organizer.access, {
    name: `${label} ${runId}`,
    ...overrides,
  });
  return { runId, token: organizer.access, event };
}

// Adds a person with no account and emails them the invitation (the stack's
// email worker delivers it). Returns the link's path and its token.
async function inviteTemporaryPerson(request, token, event, name, email) {
  const invitedAt = Date.now() - 1000;
  await addPersonApi(request, event.code, token, {
    name,
    email,
    sendInvitation: true,
  });
  const body = await latestEmailFor(
    email,
    invitedAt,
    invitationEmail(event.code),
  );
  const path = temporaryAccessPathFromEmail(body);
  const invitation = new URL(path, "http://link.invalid").searchParams.get(
    "invitation",
  );
  expect(invitation).toMatch(/^[0-9a-f-]{36}$/);
  return { path, invitation };
}

// Opens an invitation link, which by itself opens the person's schedule.
// Resolves to the open request's answer.
async function openTemporaryAccess(page, event, path, name) {
  const opened = nextOpen(page);
  await page.goto(path);
  const response = await opened;
  expect(response.status()).toBe(200);
  await expect(heading(page, event.name)).toBeVisible();
  await expect(page.getByText(`You are responding as ${name}`)).toBeVisible();
  return response;
}

// This person's temporary sessions on one event (Django read).
function tempSessions(email, code) {
  return runDjangoJson(
    `
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.scheduling.models import TemporaryEventSession

member_id = ContactEmail.objects.get(email_address__iexact=data["email"]).member_id
sessions = TemporaryEventSession.objects.filter(
    member_id=member_id, participant__event__code=data["code"]
).order_by("created_at")
print(json.dumps([
    {
        "id": str(session.pk),
        "active": session.active,
        "revoked": session.revoked_at is not None,
        "participantMember": str(session.participant.member_id),
        "memberId": str(member_id),
        "lifetimeSeconds": (session.expires_at - session.created_at).total_seconds(),
    }
    for session in sessions
]))
`,
    { email, code },
  );
}

// Moves this person's temporary sessions past their expiry, as if a week
// had gone by. Only this test's own rows are written.
function expireTempSessions(email) {
  runDjangoScript(
    `
from datetime import timedelta

from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.scheduling.models import TemporaryEventSession

member_id = ContactEmail.objects.get(email_address__iexact=data["email"]).member_id
updated = TemporaryEventSession.objects.filter(
    member_id=member_id, revoked_at__isnull=True
).update(expires_at=timezone.now() - timedelta(minutes=1))
assert updated >= 1, updated
`,
    { email },
  );
}

// How many emailed codes were ever issued to these addresses for temporary
// access (opening a link issues none).
function tempAccessChallenges(emails) {
  return runDjangoJson(
    `
from apps.authn.models import EmailAuthChallenge

print(json.dumps({
    email: EmailAuthChallenge.objects.filter(
        target_email__iexact=email,
        purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
    ).count()
    for email in data["emails"]
}))
`,
    { emails },
  );
}

// The account behind this address: its names, whether it has a password
// and whether it is still temporary.
function accountDetails(email) {
  return runDjangoJson(
    `
from apps.authn.models import ContactEmail

member = ContactEmail.objects.select_related("member").get(
    email_address__iexact=data["email"]
).member
print(json.dumps({
    "firstName": member.first_name,
    "lastName": member.last_name,
    "usablePassword": member.has_usable_password(),
    "accessLevel": member.access_level,
}))
`,
    { email },
  );
}

// Fills the temporary-access open quota ("temp_access_open") for this event
// and link to its configured limit, so the next real request crosses the
// threshold; `clear` removes the bucket again. Only this test's own (event,
// link) bucket is written, never the per-IP budget every test shares.
function setTempAccessQuota(scope, code, token, { clear = false } = {}) {
  return runDjangoJson(
    `
from django.utils import timezone

from apps.authn.models import AuthRateLimitBucket
from apps.authn.security.helpers import _key_hash, _limit_config, normalize_security_identity
from apps.scheduling.services.temporary_access import temporary_access_rate_identity

scope = data["scope"]
identity = normalize_security_identity(
    temporary_access_rate_identity(data["code"], data["token"])
)
key = {"scope": f"{scope}:identity", "key_hash": _key_hash(scope, "identity", identity)}
if data["clear"]:
    print(json.dumps(AuthRateLimitBucket.objects.filter(**key).delete()[0]))
else:
    limit = _limit_config("AUTH_RATE_LIMITS", scope, "identity")["limit"]
    AuthRateLimitBucket.objects.update_or_create(
        **key,
        defaults={
            "window_started_at": timezone.now(),
            "request_count": limit,
            "blocked_until": None,
        },
    )
    print(json.dumps(limit))
`,
    { scope, code, token, clear },
  );
}

// The organizer's view of one invitation (GET /events/invitations).
async function invitationFor(request, token, code, email) {
  const { response, payload } = await apiJson(
    request,
    "GET",
    `/events/invitations?code=${code}`,
    token,
  );
  expect(response.status()).toBe(200);
  return payload.invitations.find(
    (invitation) => invitation.email === email.toLowerCase(),
  );
}

function tempEditorControls(page) {
  const brush = page.getByRole("group", { name: "Availability status" });
  return {
    brush: (label) => brush.getByRole("button", { name: label, exact: true }),
    applyToAll: page.getByRole("button", { name: "Apply to all" }),
    submit: page.getByRole("button", {
      name: /^(Submit|Update) availability$/,
    }),
    signOut: page
      .getByRole("navigation", { name: "Site" })
      .getByRole("button", { name: /^Sign(ing)? out/ }),
    upgrade: page.getByRole("link", {
      name: /^(Upgrade to full access|Saving before upgrade…)$/,
    }),
  };
}

test.describe("Temporary access link", () => {
  test("a missing link, a code with no invitation or session, and an unknown invitation all reveal nothing about the event", async ({
    page,
    request,
  }) => {
    const { event } = await organizerEvent(request, "temp-missing");

    await page.goto("/temp-access");
    await expect(page).toHaveTitle("Temporary event access · Releviz");
    await expect(heading(page, LINK_REQUIRED)).toBeVisible();
    await expect(page.getByText(OPEN_THE_LINK, { exact: true })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );

    // A code without an invitation or a session: unknown or real, the page
    // says the same thing.
    for (const code of ["NOPE0000", event.code]) {
      await page.goto(`/temp-access?code=${code}`);
      await expect(heading(page, LINK_REQUIRED)).toBeVisible();
      await expect(
        page.getByText(LINK_FOR_ITS_EVENT, { exact: true }),
      ).toBeVisible();
    }

    // An invitation token the server does not know opens nothing, and the
    // page says so without naming the event or the reason.
    const opened = nextOpen(page);
    await page.goto(
      `/temp-access?code=${event.code}&invitation=${randomUUID()}`,
    );
    const answer = await opened;
    expect(answer.status()).toBe(404);
    expect(await answer.json()).toEqual(INACTIVE_BODY);
    await expect(heading(page, INACTIVE_LINK)).toBeVisible();
    await expect(
      page.getByText(INACTIVE_LINK_EXPLAINED, { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/temp-access\\?code=${event.code}$`),
    );
    await expect(page.getByRole("heading", { name: event.name })).toHaveCount(
      0,
    );
  });

  test("an invitation link moves its token from the address bar into this tab and opens the event by itself, with an HttpOnly event cookie, one session and an opened invitation that the person's own first save accepts", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(request, "temp-open");
    const email = `temp-open-tia-${runId}@example.com`;
    const { path, invitation } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Tia Temporary",
      email,
    );
    expect(
      (await invitationFor(request, token, event.code, email)).status,
    ).toBe("invited");

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // The open is held, so the page can be seen while it is on its way.
      const heldOpens = [];
      const holdFirstOpen = (route) => {
        if (route.request().method() === "POST" && heldOpens.length === 0) {
          heldOpens.push(route);
        } else {
          route.fallback();
        }
      };
      await page.route(OPEN_ROUTE, holdFirstOpen);
      const openedAt = Date.now();
      await page.goto(path);
      await expect.poll(() => heldOpens.length).toBe(1);
      expect(heldOpens[0].request().postDataJSON()).toEqual({
        code: event.code,
        invitationToken: invitation,
      });
      await expect(heading(page, "Opening event access…")).toBeVisible();
      await expect(page.getByText("Opening your invitation…")).toBeVisible();
      // The token leaves the address bar (and so the history and any
      // shared screenshot) and waits in this tab's session storage.
      await expect(page).toHaveURL(
        new RegExp(`/temp-access\\?code=${event.code}$`),
      );
      expect(await storedInvitation(page, event.code)).toBe(invitation);
      // Nothing is opened or signed in until the server answers.
      expect(tempSessions(email, event.code)).toEqual([]);
      expect(await tempCookie(context)).toBeUndefined();
      expect(
        (await invitationFor(request, token, event.code, email)).status,
      ).toBe("invited");

      // Session storage belongs to the tab: another tab has no token and
      // no session, so it only asks for the link.
      const otherTab = await context.newPage();
      await otherTab.goto(`/temp-access?code=${event.code}`);
      await expect(heading(otherTab, LINK_REQUIRED)).toBeVisible();
      await otherTab.close();

      const opened = nextOpen(page);
      await heldOpens[0].continue();
      const openedResponse = await opened;
      await page.unroute(OPEN_ROUTE, holdFirstOpen);
      expect(openedResponse.status()).toBe(200);
      const payload = await openedResponse.json();
      expect(payload.email).toBe(email);
      expect(payload.event.code).toBe(event.code);
      expect(payload.participant.name).toBe("Tia Temporary");
      await expect(heading(page, event.name)).toBeVisible();
      await expect(
        page.getByText("You are responding as Tia Temporary"),
      ).toBeVisible();
      await expect(
        page
          .getByRole("navigation", { name: "Site" })
          .getByText("Temporary event access"),
      ).toBeVisible();
      // The link was the credential: nothing was emailed and no code issued.
      expect(await emailsSentTo(email, openedAt)).toEqual([]);
      expect(tempAccessChallenges([email])).toEqual({ [email]: 0 });

      // The token is gone from the tab once it has done its job.
      expect(await storedInvitation(page, event.code)).toBeNull();
      await expect(page).toHaveURL(
        new RegExp(`/temp-access\\?code=${event.code}$`),
      );

      // One event-scoped session, carried by an HttpOnly cookie that only
      // the temporary-access API receives and that names that session.
      const sessions = tempSessions(email, event.code);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ active: true, revoked: false });
      expect(sessions[0].participantMember).toBe(sessions[0].memberId);
      expect(sessions[0].lifetimeSeconds).toBeCloseTo(
        TEMP_COOKIE_LIFETIME_S,
        -1,
      );
      const cookie = await tempCookie(context);
      expect(cookie).toMatchObject({
        httpOnly: true,
        path: "/events/temp-access/",
      });
      expect(cookie.value.split(".")[0]).toBe(sessions[0].id);
      const secondsLeft = cookie.expires - Date.now() / 1000;
      expect(secondsLeft).toBeGreaterThan(TEMP_COOKIE_LIFETIME_S - 300);
      expect(secondsLeft).toBeLessThanOrEqual(TEMP_COOKIE_LIFETIME_S + 60);
      const session = await tempAccessSessionState(page, event.code);
      expect(session.status).toBe(200);
      expect(session.payload.email).toBe(email);

      // Opening records that the link was opened. It is not an acceptance:
      // the organizer still sees the invitation as sent.
      let invited = await invitationFor(request, token, event.code, email);
      expect(invited.status).toBe("opened");
      expect(invited.openedAt).toBeTruthy();
      expect(invited.acceptedAt).toBeNull();
      expect(
        (await rosterByEmail(request, event.code, token)).get(email)
          .invitationStatus,
      ).toBe("sent");

      // A reload resumes from the cookie without opening the link again.
      const opens = requestRecorder(page, isOpen);
      await page.reload();
      await expect(
        page.getByText("You are responding as Tia Temporary"),
      ).toBeVisible();
      expect(opens.entries).toEqual([]);

      // Opening the same link again in this browser keeps its session and
      // its cookie.
      await openTemporaryAccess(page, event, path, "Tia Temporary");
      expect(tempSessions(email, event.code)).toHaveLength(1);
      expect((await tempCookie(context))?.value).toBe(cookie.value);
      expect(
        (await invitationFor(request, token, event.code, email)).openedAt,
      ).toBe(invited.openedAt);

      // The person's own first save is what accepts the invitation.
      const saved = nextTempSave(page);
      await page
        .getByRole("grid", { name: "Availability" })
        .locator('[data-cell-idx="0"]')
        .click();
      expect((await saved).status()).toBe(200);
      invited = await invitationFor(request, token, event.code, email);
      expect(invited.status).toBe("draft_saved");
      expect(invited.acceptedAt).toBeTruthy();
      expect(
        (await rosterByEmail(request, event.code, token)).get(email)
          .invitationStatus,
      ).toBe("accepted");
    } finally {
      await context.close();
    }
  });

  test("an open that fails on the way or is throttled says so and keeps the link, a reload reads it back, and Try again opens the event once it can", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(request, "temp-retry");
    const email = `temp-retry-cai-${runId}@example.com`;
    const { path, invitation } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Cai Retry",
      email,
    );

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const tryAgain = page.getByRole("button", { name: "Try again" });

      // The first open fails on the way: the page keeps the link and offers
      // to try again. The handler fails one open each time it is armed.
      let failNextOpen = true;
      const failArmedOpen = async (route) => {
        if (route.request().method() === "POST" && failNextOpen) {
          failNextOpen = false;
          await fulfillError(route, 503, { detail: "Service unavailable." });
          return;
        }
        await route.fallback();
      };
      await page.route(OPEN_ROUTE, failArmedOpen);
      await page.goto(path);
      await expect(heading(page, OPEN_FAILED_TITLE)).toBeVisible();
      await expect(mainAlert(page, OPEN_FAILED)).toBeVisible();
      await expect(tryAgain).toBeFocused();
      await expect(page).toHaveURL(
        new RegExp(`/temp-access\\?code=${event.code}$`),
      );
      expect(await storedInvitation(page, event.code)).toBe(invitation);
      expect(tempSessions(email, event.code)).toEqual([]);

      // A reload reads the kept link back from this tab's session storage
      // and opens it again from a fresh document, without the token in the
      // address bar; the failure is replayed, so nothing opens yet.
      failNextOpen = true;
      const reloaded = page.waitForRequest(isOpen);
      await page.reload();
      expect((await reloaded).postDataJSON()).toEqual({
        code: event.code,
        invitationToken: invitation,
      });
      await expect(heading(page, OPEN_FAILED_TITLE)).toBeVisible();
      await expect(mainAlert(page, OPEN_FAILED)).toBeVisible();
      await expect(page).toHaveURL(
        new RegExp(`/temp-access\\?code=${event.code}$`),
      );
      expect(await storedInvitation(page, event.code)).toBe(invitation);
      expect(tempSessions(email, event.code)).toEqual([]);
      await page.unroute(OPEN_ROUTE, failArmedOpen);

      // Too many opens of this link: Try again says to wait, and opens
      // nothing.
      expect(
        setTempAccessQuota("temp_access_open", event.code, invitation),
      ).toBeGreaterThan(0);
      const throttled = nextOpen(page);
      await tryAgain.click();
      const throttledAnswer = await throttled;
      expect(throttledAnswer.status()).toBe(429);
      expect(Number(throttledAnswer.headers()["retry-after"])).toBeGreaterThan(
        0,
      );
      await expect(heading(page, OPEN_FAILED_TITLE)).toBeVisible();
      await expect(mainAlert(page, OPEN_THROTTLED)).toBeVisible();
      expect(tempSessions(email, event.code)).toEqual([]);
      expect(
        (await invitationFor(request, token, event.code, email)).status,
      ).toBe("invited");

      // Once that quota lapses, Try again opens the event with the link it
      // kept.
      setTempAccessQuota("temp_access_open", event.code, invitation, {
        clear: true,
      });
      const opened = nextOpen(page);
      await tryAgain.click();
      expect((await opened).status()).toBe(200);
      await expect(heading(page, event.name)).toBeVisible();
      await expect(
        page.getByText("You are responding as Cai Retry"),
      ).toBeVisible();
      expect(await storedInvitation(page, event.code)).toBeNull();
      expect(tempSessions(email, event.code)).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});

test.describe("Temporary access API", () => {
  test("open answers every link that is not a live temporary invitation with the same 404 and opens nothing, opens a sent one, emails nobody, and is throttled per event and link", async ({
    browserName,
    playwright,
    request,
  }) => {
    test.skip(
      browserName !== "chromium",
      "API-level test: the browser does not matter, so one project runs it",
    );
    const { runId, token, event } = await organizerEvent(request, "temp-api");
    const { code } = event;
    const sentEmail = `temp-api-sent-${runId}@example.com`;
    const unsentEmail = `temp-api-unsent-${runId}@example.com`;
    const fullEmail = `temp-api-full-${runId}@example.com`;
    const inactiveEmail = `temp-api-off-${runId}@example.com`;
    await registerAccountViaApi(request, fullEmail, "Fern", "Full");

    const invitedAt = Date.now() - 1000;
    for (const [name, email, sendInvitation] of [
      ["Sid Sent", sentEmail, true],
      ["Una Unsent", unsentEmail, false],
      ["Fern Full", fullEmail, true],
      ["Ida Inactive", inactiveEmail, true],
    ]) {
      await addPersonApi(request, code, token, { name, email, sendInvitation });
    }
    const linkToken = (link) =>
      new URL(link, "http://link.invalid").searchParams.get("invitation");
    const sentToken = linkToken(
      temporaryAccessPathFromEmail(
        await latestEmailFor(sentEmail, invitedAt, invitationEmail(code)),
      ),
    );
    const inactiveToken = linkToken(
      temporaryAccessPathFromEmail(
        await latestEmailFor(inactiveEmail, invitedAt, invitationEmail(code)),
      ),
    );
    // A full account's invitation opens /event instead.
    const fullToken = linkToken(
      invitationLinkFromEmail(
        await latestEmailFor(fullEmail, invitedAt, (body) =>
          body.includes(`/event?code=${code}&invitation=`),
        ),
      ),
    );
    const { unsentToken, unsentSent } = runDjangoJson(
      `
from apps.authn.models import Member
from apps.scheduling.models import EventInvitation

unsent = EventInvitation.objects.get(event__code=data["code"], email__iexact=data["unsent"])
off = EventInvitation.objects.get(event__code=data["code"], email__iexact=data["inactive"])
Member.objects.filter(pk=off.member_id).update(is_active=False)
print(json.dumps({
    "unsentToken": str(unsent.access_token),
    "unsentSent": unsent.first_sent_at is not None,
}))
`,
      { code, unsent: unsentEmail, inactive: inactiveEmail },
    );
    expect(unsentSent).toBe(false);

    // A fresh request context per call, so no cookie from an earlier open
    // rides along.
    const openLink = async (body) => {
      const client = await playwright.request.newContext();
      try {
        const response = await client.post(
          `${BACKEND_URL}/events/temp-access/open`,
          { maxRetries: STALE_SOCKET_RETRIES, data: body },
        );
        return {
          status: response.status(),
          payload: await response.json(),
          headers: response.headers(),
        };
      } finally {
        await client.dispose();
      }
    };

    const openedAt = Date.now();
    const refusedLinks = {
      "an unknown event": { code: "NOPE0000", invitationToken: sentToken },
      "a malformed token": { code, invitationToken: "not-a-token" },
      "an unknown token": { code, invitationToken: randomUUID() },
      "an unsent invitation": { code, invitationToken: unsentToken },
      "a full account's invitation": { code, invitationToken: fullToken },
      "an inactive identity": { code, invitationToken: inactiveToken },
    };
    for (const [what, body] of Object.entries(refusedLinks)) {
      const response = await openLink(body);
      expect(response.status, what).toBe(404);
      expect(response.payload, what).toEqual(INACTIVE_BODY);
      expect(response.headers["cache-control"], what).toMatch(/no-store/);
      expect(response.headers["cache-control"], what).toMatch(/private/);
      expect(response.headers["set-cookie"], what).toBeUndefined();
    }
    // None of them was marked opened.
    for (const email of [unsentEmail, fullEmail, inactiveEmail]) {
      expect((await invitationFor(request, token, code, email)).status).toBe(
        "invited",
      );
    }

    // The sent invitation to an active temporary identity opens: a session
    // and its cookie, and the invitation is marked opened.
    const opened = await openLink({ code, invitationToken: sentToken });
    expect(opened.status).toBe(200);
    expect(opened.payload.email).toBe(sentEmail);
    expect(opened.payload.participant.name).toBe("Sid Sent");
    expect(opened.headers["cache-control"]).toMatch(/no-store/);
    expect(opened.headers["set-cookie"]).toMatch(
      new RegExp(`^${TEMP_COOKIE}=`),
    );
    expect(tempSessions(sentEmail, code)).toMatchObject([{ active: true }]);
    for (const [email, status] of [
      [sentEmail, "opened"],
      [unsentEmail, "invited"],
      [fullEmail, "invited"],
      [inactiveEmail, "invited"],
    ]) {
      expect((await invitationFor(request, token, code, email)).status).toBe(
        status,
      );
    }
    // No link emails anything or issues a code.
    expect(
      tempAccessChallenges([sentEmail, unsentEmail, fullEmail, inactiveEmail]),
    ).toEqual({
      [sentEmail]: 0,
      [unsentEmail]: 0,
      [fullEmail]: 0,
      [inactiveEmail]: 0,
    });
    for (const email of [sentEmail, unsentEmail, fullEmail, inactiveEmail]) {
      expect(await emailsSentTo(email, openedAt), email).toEqual([]);
    }

    // Opens are throttled per event and link, whether or not the link is
    // live. The same link spelled differently shares the quota; another
    // link does not.
    setTempAccessQuota("temp_access_open", code, sentToken);
    const throttled = await openLink({ code, invitationToken: sentToken });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(throttled.headers["set-cookie"]).toBeUndefined();
    const respelled = await openLink({
      code: code.toLowerCase(),
      invitationToken: sentToken.toUpperCase(),
    });
    expect(respelled.status).toBe(429);
    expect(
      (await openLink({ code, invitationToken: unsentToken })).status,
    ).toBe(404);
    expect(tempSessions(sentEmail, code)).toHaveLength(1);
    // A link that is not live is rationed the same way, before it is looked
    // up: once its quota is spent, the 404 gives way to the 429, so a link
    // cannot be guessed at faster than a real one can be opened.
    setTempAccessQuota("temp_access_open", code, unsentToken);
    const unsentThrottled = await openLink({
      code,
      invitationToken: unsentToken,
    });
    expect(unsentThrottled.status).toBe(429);
    expect(Number(unsentThrottled.headers["retry-after"])).toBeGreaterThan(0);
    expect(unsentThrottled.headers["set-cookie"]).toBeUndefined();
    setTempAccessQuota("temp_access_open", code, unsentToken, { clear: true });
    expect(
      (await openLink({ code, invitationToken: unsentToken })).status,
    ).toBe(404);
    setTempAccessQuota("temp_access_open", code, sentToken, { clear: true });
    const reopened = await openLink({ code, invitationToken: sentToken });
    expect(reopened.status).toBe(200);
    expect(reopened.payload.email).toBe(sentEmail);
  });

  test("open, saves, sign-out and upgrade registration refuse a foreign Origin, and the opened cookie is HttpOnly, SameSite=Lax and scoped to the temporary-access API", async ({
    browserName,
    playwright,
    request,
  }) => {
    test.skip(
      browserName !== "chromium",
      "API-level test: the browser does not matter, so one project runs it",
    );
    const { runId, token, event } = await organizerEvent(
      request,
      "temp-origin",
    );
    const { code } = event;
    const email = `temp-origin-oda-${runId}@example.com`;
    const { invitation } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Oda Origin",
      email,
    );
    const foreign = { Origin: FOREIGN_ORIGIN };
    const own = { Origin: new URL(FRONTEND_URL).origin };
    const temp = await playwright.request.newContext();
    try {
      const url = (path) => `${BACKEND_URL}/events/temp-access/${path}`;
      const sessionState = async () => {
        const response = await temp.get(url(`session?code=${code}`), {
          maxRetries: STALE_SOCKET_RETRIES,
        });
        return { status: response.status(), payload: await response.json() };
      };
      const link = { code, invitationToken: invitation };

      // Login CSRF: a cross-site page cannot plant the event cookie, and the
      // refused attempt opens nothing.
      let response = await temp.post(url("open"), {
        maxRetries: STALE_SOCKET_RETRIES,
        data: link,
        headers: foreign,
      });
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual(ORIGIN_REFUSED);
      expect(response.headers()["set-cookie"]).toBeUndefined();
      expect((await sessionState()).status).toBe(401);
      expect(tempSessions(email, code)).toEqual([]);
      expect((await invitationFor(request, token, code, email)).status).toBe(
        "invited",
      );

      response = await temp.post(url("open"), {
        maxRetries: STALE_SOCKET_RETRIES,
        data: link,
        headers: own,
      });
      expect(response.status()).toBe(200);
      const setCookie = response
        .headersArray()
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value);
      expect(setCookie).toHaveLength(1);
      expect(setCookie[0]).toMatch(
        new RegExp(`^${TEMP_COOKIE}=[0-9a-f-]{36}\\.[A-Za-z0-9_-]{20,};`),
      );
      expect(setCookie[0]).toMatch(/;\s*HttpOnly(;|$)/i);
      expect(setCookie[0]).toMatch(/;\s*SameSite=Lax(;|$)/i);
      expect(setCookie[0]).toMatch(/;\s*Path=\/events\/temp-access\/(;|$)/);
      const maxAge = Number(setCookie[0].match(/Max-Age=(\d+)/i)?.[1]);
      expect(maxAge).toBeGreaterThan(TEMP_COOKIE_LIFETIME_S - 300);
      expect(maxAge).toBeLessThanOrEqual(TEMP_COOKIE_LIFETIME_S);
      let session = await sessionState();
      expect(session.status).toBe(200);
      const { version, availabilityInperson } = session.payload.participant;

      // A cross-site save is refused and changes nothing.
      const busy = Array(event.slotCount).fill(0);
      response = await temp.put(url(`participant?code=${code}`), {
        maxRetries: STALE_SOCKET_RETRIES,
        data: { availabilityInperson: busy, expectedVersion: version },
        headers: foreign,
      });
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual(ORIGIN_REFUSED);
      session = await sessionState();
      expect(session.payload.participant.version).toBe(version);
      expect(session.payload.participant.availabilityInperson).toEqual(
        availabilityInperson,
      );

      // So is a cross-site upgrade registration.
      response = await temp.post(url(`upgrade-registration?code=${code}`), {
        maxRetries: STALE_SOCKET_RETRIES,
        data: { first_name: "Oda", last_name: "Origin" },
        headers: foreign,
      });
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual(ORIGIN_REFUSED);

      // A cross-site sign-out cannot end the session either.
      response = await temp.post(url("logout"), {
        maxRetries: STALE_SOCKET_RETRIES,
        data: { code },
        headers: foreign,
      });
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual(ORIGIN_REFUSED);
      expect((await sessionState()).status).toBe(200);

      // From the app's own origin both work.
      response = await temp.put(url(`participant?code=${code}`), {
        maxRetries: STALE_SOCKET_RETRIES,
        data: { availabilityInperson: busy, expectedVersion: version },
        headers: own,
      });
      expect(response.status()).toBe(200);
      expect((await response.json()).participant.version).toBe(version + 1);
      response = await temp.post(url("logout"), {
        maxRetries: STALE_SOCKET_RETRIES,
        data: { code },
        headers: own,
      });
      expect(response.status()).toBe(204);
      expect(response.headers()["set-cookie"]).toMatch(
        new RegExp(`^${TEMP_COOKIE}="?"?;.*Max-Age=0`, "i"),
      );
      session = await sessionState();
      expect(session.status).toBe(401);
      expect(session.payload.errorCode).toBe("temp_session_inactive");
    } finally {
      await temp.dispose();
    }
  });
});

test.describe("Temporary session", () => {
  test("the event cookie reopens the event after a reload and in a second tab, another person's invitation link takes priority over it, and it does not open another event", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(
      request,
      "temp-resume",
    );
    const other = await createEvent(request, token, {
      name: `temp-resume other ${runId}`,
    });
    const piaEmail = `temp-resume-pia-${runId}@example.com`;
    const quinnEmail = `temp-resume-quinn-${runId}@example.com`;
    const pia = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Pia Resume",
      piaEmail,
    );
    const quinn = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Quinn Second",
      quinnEmail,
    );
    // Quinn is on the other event too, as the same temporary identity.
    await addPersonApi(request, other.code, token, {
      name: "Quinn Second",
      email: quinnEmail,
    });

    const context = await browser.newContext();
    try {
      const tab = await context.newPage();
      await openTemporaryAccess(tab, event, pia.path, "Pia Resume");
      const opens = requestRecorder(tab, isOpen);

      // A reload resumes from the cookie without opening the link again.
      const resumed = tab.waitForResponse(
        (response) =>
          SESSION_ROUTE.test(response.url()) &&
          response.request().method() === "GET",
      );
      await tab.reload();
      expect((await resumed).status()).toBe(200);
      await expect(heading(tab, event.name)).toBeVisible();
      await expect(
        tab.getByText("You are responding as Pia Resume"),
      ).toBeVisible();
      expect(opens.entries).toEqual([]);

      // So does a second tab, which has no invitation of its own.
      const secondTab = await context.newPage();
      await secondTab.goto(`/temp-access?code=${event.code}`);
      await expect(heading(secondTab, event.name)).toBeVisible();
      await expect(
        secondTab.getByText("You are responding as Pia Resume"),
      ).toBeVisible();
      expect(await storedInvitation(secondTab, event.code)).toBeNull();

      // Someone else's invitation opened on this device is their identity
      // choice: it opens Quinn's own schedule instead of reusing Pia's
      // cookie.
      const quinnOpen = secondTab.waitForRequest(isOpen);
      await secondTab.goto(quinn.path);
      expect((await quinnOpen).postDataJSON().invitationToken).toBe(
        quinn.invitation,
      );
      await expect(
        secondTab.getByText("You are responding as Quinn Second"),
      ).toBeVisible();
      await expect(
        secondTab.getByText("You are responding as Pia Resume"),
      ).toHaveCount(0);
      expect(tempSessions(quinnEmail, event.code)).toMatchObject([
        { active: true },
      ]);
      // Quinn's session took this browser's cookie; Pia's was not revoked.
      expect(tempSessions(piaEmail, event.code)).toMatchObject([
        { active: true },
      ]);

      // The cookie belongs to its event: Quinn's other event asks for a
      // link, and the miss neither revokes the session nor clears the cookie.
      const quinnCookie = await tempCookie(context);
      await secondTab.goto(`/temp-access?code=${other.code}`);
      await expect(heading(secondTab, LINK_REQUIRED)).toBeVisible();
      await expect(
        secondTab.getByText(LINK_FOR_ITS_EVENT, { exact: true }),
      ).toBeVisible();
      await expect(secondTab.getByText("Quinn Second")).toHaveCount(0);
      expect(tempSessions(quinnEmail, event.code)).toMatchObject([
        { active: true, revoked: false },
      ]);
      expect(tempSessions(quinnEmail, other.code)).toEqual([]);
      expect((await tempCookie(context))?.value).toBe(quinnCookie.value);
      await secondTab.goto(`/temp-access?code=${event.code}`);
      await expect(
        secondTab.getByText("You are responding as Quinn Second"),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("another event's page, saves, upgrade and sign-out are refused as if signed out but keep this event's cookie, which still opens its event until the session expires", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(request, "temp-keep");
    const other = await createEvent(request, token, {
      name: `temp-keep other ${runId}`,
    });
    const email = `temp-keep-kit-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Kit Keep",
      email,
    );
    const context = await browser.newContext();
    try {
      const tab = await context.newPage();
      await openTemporaryAccess(tab, event, path, "Kit Keep");
      const cookie = await tempCookie(context);
      expect(cookie).toBeDefined();
      const cookieValue = async () => (await tempCookie(context))?.value;

      // A second tab opens the other event without an invitation: it asks
      // for a link, and Kit's cookie for this event stays.
      const otherTab = await context.newPage();
      const missed = otherTab.waitForResponse(
        (response) =>
          SESSION_ROUTE.test(response.url()) &&
          response.request().method() === "GET",
      );
      await otherTab.goto(`/temp-access?code=${other.code}`);
      expect((await missed).status()).toBe(401);
      await expect(heading(otherTab, LINK_REQUIRED)).toBeVisible();
      expect(await cookieValue()).toBe(cookie.value);

      // The other event's save and upgrade get the signed-out answer, and
      // signing out of it ends nothing; none of them touch the cookie.
      const inactive = {
        error: "Temporary event access is not active.",
        errorCode: "temp_session_inactive",
      };
      const save = await tempAccessPut(otherTab, other.code, {
        availabilityInperson: Array(other.slotCount).fill(0),
        expectedVersion: 1,
      });
      expect(save).toEqual({ status: 401, payload: inactive });
      expect(
        await tempAccessPost(
          otherTab,
          `upgrade-registration?code=${other.code}`,
          {},
        ),
      ).toEqual({ status: 401, payload: inactive });
      expect(
        await tempAccessPost(otherTab, "logout", { code: other.code }),
      ).toEqual({ status: 204, payload: null });
      expect(await cookieValue()).toBe(cookie.value);
      expect(tempSessions(email, event.code)).toMatchObject([
        { active: true, revoked: false },
      ]);

      // Kit's own event still opens from the cookie.
      await tab.reload();
      await expect(heading(tab, event.name)).toBeVisible();
      await expect(
        tab.getByText("You are responding as Kit Keep"),
      ).toBeVisible();

      // Once the session is really gone, even the other event's page clears
      // the cookie.
      expireTempSessions(email);
      const expired = otherTab.waitForResponse(
        (response) =>
          SESSION_ROUTE.test(response.url()) &&
          response.request().method() === "GET",
      );
      await otherTab.reload();
      expect((await expired).status()).toBe(401);
      await expect(heading(otherTab, LINK_REQUIRED)).toBeVisible();
      await expect.poll(cookieValue).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  test("Sign out on an event whose cookie another event's link has since replaced leaves that event signed in, and its own Sign out still ends it", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(request, "temp-swap");
    const other = await createEvent(request, token, {
      name: `temp-swap other ${runId}`,
    });
    const email = `temp-swap-sam-${runId}@example.com`;
    const first = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Sam Swap",
      email,
    );
    // Sam is invited to the other event too, as the same temporary identity.
    const second = await inviteTemporaryPerson(
      request,
      token,
      other,
      "Sam Swap",
      email,
    );
    const context = await browser.newContext();
    try {
      const tab = await context.newPage();
      await openTemporaryAccess(tab, event, first.path, "Sam Swap");

      // A second tab opens the other event's link; its cookie replaces this
      // event's, while the first tab still shows this event's editor.
      const otherTab = await context.newPage();
      await openTemporaryAccess(otherTab, other, second.path, "Sam Swap");
      const otherCookie = await tempCookie(context);
      expect(otherCookie).toBeDefined();
      expect(tempSessions(email, other.code)).toMatchObject([
        { active: true, revoked: false },
      ]);

      // Sign out on the first tab names its own event, so the other event's
      // session and the cookie that holds it stay.
      const signedOut = tab.waitForResponse(
        (response) =>
          LOGOUT_ROUTE.test(response.url()) &&
          response.request().method() === "POST",
      );
      await tempEditorControls(tab).signOut.click();
      const logout = await signedOut;
      expect(logout.request().postDataJSON()).toEqual({ code: event.code });
      expect(logout.status()).toBe(204);
      await expect(heading(tab, "You are signed out")).toBeVisible();
      expect((await tempCookie(context))?.value).toBe(otherCookie.value);
      expect(tempSessions(email, other.code)).toMatchObject([
        { active: true, revoked: false },
      ]);
      await otherTab.reload();
      await expect(heading(otherTab, other.name)).toBeVisible();
      await expect(
        otherTab.getByText("You are responding as Sam Swap"),
      ).toBeVisible();

      // The other event's own Sign out ends its session and clears the
      // cookie.
      await tempEditorControls(otherTab).signOut.click();
      await expect(heading(otherTab, "You are signed out")).toBeVisible();
      expect(await tempCookie(context)).toBeUndefined();
      expect(tempSessions(email, other.code)).toMatchObject([
        { active: false, revoked: true },
      ]);
    } finally {
      await context.close();
    }
  });

  test("Sign out saves a pending change first, stays put when that save or the revoke fails, then ends only this device's session and clears its cookie", async ({
    browser,
    playwright,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(
      request,
      "temp-logout",
    );
    const email = `temp-logout-lou-${runId}@example.com`;
    const { path, invitation } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Lou Logout",
      email,
    );
    const context = await browser.newContext();
    // The same person on a second device, signed in through the API.
    const device = await playwright.request.newContext();
    try {
      const page = await context.newPage();
      await openTemporaryAccess(page, event, path, "Lou Logout");
      // The second device opens the same link and gets a session of its own.
      expect(
        (
          await device.post(`${BACKEND_URL}/events/temp-access/open`, {
            maxRetries: STALE_SOCKET_RETRIES,
            data: { code: event.code, invitationToken: invitation },
          })
        ).status(),
      ).toBe(200);
      const deviceSession = async () => {
        const response = await device.get(
          `${BACKEND_URL}/events/temp-access/session?code=${event.code}`,
          { maxRetries: STALE_SOCKET_RETRIES },
        );
        return { status: response.status(), payload: await response.json() };
      };
      expect(tempSessions(email, event.code)).toMatchObject([
        { active: true },
        { active: true },
      ]);

      const { signOut } = tempEditorControls(page);
      const grid = page.getByRole("grid", { name: "Availability" });
      const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);
      const order = requestRecorder(
        page,
        (sent) =>
          isTempSave(sent) ||
          (sent.method() === "POST" && LOGOUT_ROUTE.test(sent.url())),
      );

      // A change that cannot be saved keeps the person here.
      await page.route(
        SAVE_ROUTE,
        failRequests("PUT", 503, { error: SAVE_UNAVAILABLE }),
      );
      const failed = nextTempSave(page);
      await cell(0).click();
      expect((await failed).status()).toBe(503);
      await expect(mainAlert(page, SAVE_UNAVAILABLE)).toBeVisible();
      order.clear();
      await signOut.click();
      await expect(
        mainAlert(
          page,
          "Your latest changes could not be saved. Resolve the save error before signing out.",
        ),
      ).toBeVisible();
      await expect(heading(page, event.name)).toBeVisible();
      await expect(signOut).toHaveText("Sign out");
      expect(order.entries.filter((entry) => LOGOUT_ROUTE.test(entry))).toEqual(
        [],
      );
      await page.unroute(SAVE_ROUTE);

      // The save now goes through, but the revoke fails: the person stays
      // on the event and is told the session may still be active.
      await page.route(
        LOGOUT_ROUTE,
        failRequests("POST", 500, { detail: "Server error." }),
      );
      order.clear();
      await signOut.click();
      await expect(
        mainAlert(
          page,
          "Sign out could not be confirmed. This temporary session may still be active; try again before leaving this device.",
        ),
      ).toBeVisible();
      await expect(heading(page, event.name)).toBeVisible();
      expect(order.entries.map((entry) => entry.split(" ")[0])).toEqual([
        "PUT",
        "POST",
      ]);
      await page.unroute(LOGOUT_ROUTE);
      expect(
        (await deviceSession()).payload.participant.availabilityInperson[0],
      ).toBe(0);

      // A change made just before signing out is saved first.
      expect(await tempCookie(context)).toBeDefined();
      order.clear();
      await cell(1).click();
      await signOut.click();
      await expect(heading(page, "You are signed out")).toBeVisible();
      await expect(
        page.getByText(
          "Open the link in your invitation email whenever you need to access this event again.",
        ),
      ).toBeVisible();
      expect(order.entries.map((entry) => entry.split(" ")[0])).toEqual([
        "PUT",
        "POST",
      ]);

      // Only this browser's session ended; its cookie is gone.
      expect(await tempCookie(context)).toBeUndefined();
      const ended = await tempAccessSessionState(page, event.code);
      expect(ended.status).toBe(401);
      expect(ended.payload.errorCode).toBe("temp_session_inactive");
      expect(
        tempSessions(email, event.code).map((session) => session.active),
      ).toEqual([false, true]);
      const other = await deviceSession();
      expect(other.status).toBe(200);
      expect(
        other.payload.participant.availabilityInperson.slice(0, 3),
      ).toEqual([0, 0, 1]);
      await page.reload();
      await expect(heading(page, LINK_REQUIRED)).toBeVisible();

      // The person stays on the event.
      expect((await rosterByEmail(request, event.code, token)).has(email)).toBe(
        true,
      );
    } finally {
      await device.dispose();
      await context.close();
    }
  });

  test("a save after the session expired ends temporary access and clears the cookie", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(
      request,
      "temp-expired",
    );
    const email = `temp-expired-eve-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Eve Expired",
      email,
    );
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openTemporaryAccess(page, event, path, "Eve Expired");
      expireTempSessions(email);
      // The browser still holds the cookie; only the server knows it lapsed.
      expect(await tempCookie(context)).toBeDefined();

      const rejected = nextTempSave(page);
      await page
        .getByRole("grid", { name: "Availability" })
        .locator('[data-cell-idx="0"]')
        .click();
      const response = await rejected;
      expect(response.status()).toBe(401);
      expect(await response.json()).toMatchObject({
        errorCode: "temp_session_inactive",
      });
      await expect(heading(page, "Temporary access ended")).toBeVisible();
      await expect(
        page.getByText(
          "This temporary session has expired. Open the link in your invitation email again to continue.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("grid", { name: "Availability" }),
      ).toHaveCount(0);
      expect(await tempCookie(context)).toBeUndefined();
      // The refused paint is dropped, so leaving is not blocked.
      expect(await beforeUnloadIsBlocked(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("upgrading revokes every temporary session, and the next save from a stale tab ends temporary access with the full-account message and clears the cookie", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(
      request,
      "temp-upgraded",
    );
    const email = `temp-upgraded-uma-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Uma Upgrade",
      email,
    );
    const context = await browser.newContext();
    try {
      const tab = await context.newPage();
      await openTemporaryAccess(tab, event, path, "Uma Upgrade");

      // The second tab opens the event from the shared cookie and upgrades.
      const upgradeTab = await context.newPage();
      await upgradeTab.goto(`/temp-access?code=${event.code}`);
      await expect(heading(upgradeTab, event.name)).toBeVisible();
      await tempEditorControls(upgradeTab).upgrade.click();
      await expect(upgradeTab).toHaveURL(/\/signup\?upgrade=temporary&/);
      await expect(upgradeTab.getByLabel("Email")).toHaveValue(email);
      await upgradeTab.getByLabel("First name").fill("Uma");
      await upgradeTab.getByLabel("Last name").fill("Upgrade");
      await upgradeTab
        .getByLabel("Password", { exact: true })
        .fill("Upgrade-Pass-2026!");
      await upgradeTab
        .getByLabel("Confirm password")
        .fill("Upgrade-Pass-2026!");
      const upgradeAt = Date.now() - 1000;
      await upgradeTab
        .getByRole("button", { name: "Send verification code" })
        .click();
      await expect(
        upgradeTab.getByText("Enter the email verification code."),
      ).toBeVisible();
      const upgradeCode = await latestVerificationCode(
        email,
        upgradeAt,
        "register",
      );
      await upgradeTab.getByLabel("Verification code").fill(upgradeCode);
      await upgradeTab
        .getByRole("button", { name: "Verify and continue" })
        .click();
      await expect(upgradeTab).toHaveURL(
        new RegExp(`/event\\?code=${event.code}$`),
      );
      // The upgrade itself revoked the session, but the browser still holds
      // its cookie.
      expect(tempSessions(email, event.code)).toMatchObject([
        { active: false, revoked: true },
      ]);
      expect(await tempCookie(context)).toBeDefined();

      // The first tab only learns on its next write.
      const rejected = nextTempSave(tab);
      await tempEditorControls(tab).applyToAll.click();
      const response = await rejected;
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({
        errorCode: "temp_account_upgraded",
      });
      await expect(heading(tab, "Temporary access ended")).toBeVisible();
      await expect(
        tab.getByText(
          "This account now has full access. Sign in with the full account to continue.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(await tempCookie(context)).toBeUndefined();
      await expect(tab.getByRole("grid", { name: "Availability" })).toHaveCount(
        0,
      );

      // Uma answers with the account now, so the old link opens nothing and
      // says no more than any other link that matches no invitation.
      const refusedOpen = nextOpen(tab);
      await tab.goto(path);
      expect((await refusedOpen).status()).toBe(404);
      await expect(heading(tab, INACTIVE_LINK)).toBeVisible();
      await expect(heading(tab, event.name)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("Temporary editor", () => {
  test("paints single cells in both channels, copies a channel, marks everything Available, and submits into a Submitted state with Update availability and the saved values", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(request, "temp-edit", {
      mode: "mixed",
    });
    const email = `temp-edit-mia-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Mia Mixed",
      email,
    );
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openTemporaryAccess(page, event, path, "Mia Mixed");
      const { brush, submit } = tempEditorControls(page);
      const inperson = page.getByRole("grid", { name: "In-Person" });
      const virtual = page.getByRole("grid", { name: "Virtual" });
      const at = (grid, index) => grid.locator(`[data-cell-idx="${index}"]`);
      const mon9 = slotIndex(event, "weekday:1", "09:00");
      const mon930 = slotIndex(event, "weekday:1", "09:30");
      const tue10 = slotIndex(event, "weekday:2", "10:00");
      const wed11 = slotIndex(event, "weekday:3", "11:00");
      const allAvailable = Array(event.slotCount).fill(1);
      const withValues = (values) => {
        const schedule = [...allAvailable];
        for (const [index, value] of Object.entries(values))
          schedule[index] = value;
        return schedule;
      };
      // Paints and returns the body of the save it triggers.
      const saveAfter = async (action) => {
        const saved = nextTempSave(page);
        await action();
        await expect(mainStatus(page, "Saving draft…")).toBeVisible();
        const response = await saved;
        expect(response.status()).toBe(200);
        await expect(mainStatus(page, DRAFT_SAVED)).toBeVisible();
        return response.request().postDataJSON();
      };

      // Everyone starts Available here, so the brush starts on Busy.
      await expect(
        page.getByText(
          "Every time starts as Available. Paint Busy over the times that do not work for you.",
        ),
      ).toBeVisible();
      await expect(brush("Busy")).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("tab", { name: "In person" }),
      ).toHaveAttribute("aria-selected", "true");

      let body = await saveAfter(() => at(inperson, mon9).click());
      expect(body).toEqual({
        availabilityInperson: withValues({ [mon9]: 0 }),
        availabilityVirtual: allAvailable,
        submitted: 0,
        expectedVersion: expect.any(Number),
      });
      await expect(at(inperson, mon9)).toHaveAttribute(
        "data-availability",
        "busy",
      );

      await brush("If needed").click();
      body = await saveAfter(() => at(inperson, mon930).click());
      expect(body.availabilityInperson).toEqual(
        withValues({ [mon9]: 0, [mon930]: 0.5 }),
      );
      await expect(at(inperson, mon930)).toHaveAttribute(
        "data-availability",
        "partial",
      );

      // The virtual channel keeps its own schedule.
      await page.getByRole("tab", { name: "Virtual" }).click();
      await expect(virtual).toBeVisible();
      await expect(at(virtual, mon9)).toHaveAttribute(
        "data-availability",
        "free",
      );
      body = await saveAfter(() => at(virtual, tue10).click());
      expect(body.availabilityVirtual).toEqual(withValues({ [tue10]: 0.5 }));
      expect(body.availabilityInperson).toEqual(
        withValues({ [mon9]: 0, [mon930]: 0.5 }),
      );

      // Copying over the painted in-person schedule asks first.
      await page
        .getByRole("button", { name: "Copy Virtual to In-Person" })
        .click();
      const replace = page.getByRole("alertdialog", {
        name: "Replace In-Person availability?",
      });
      await expect(replace).toBeVisible();
      body = await saveAfter(() =>
        replace.getByRole("button", { name: "Replace schedule" }).click(),
      );
      expect(body.availabilityInperson).toEqual(withValues({ [tue10]: 0.5 }));
      expect(body.availabilityVirtual).toEqual(withValues({ [tue10]: 0.5 }));
      await expect(
        page.getByRole("tab", { name: "In person" }),
      ).toHaveAttribute("aria-selected", "true");

      // Mark all resets both channels to the starting level.
      body = await saveAfter(() =>
        page.getByRole("button", { name: "Mark all Available" }).click(),
      );
      expect(body.availabilityInperson).toEqual(allAvailable);
      expect(body.availabilityVirtual).toEqual(allAvailable);

      await page.getByRole("tab", { name: "Virtual" }).click();
      await brush("Busy").click();
      body = await saveAfter(() => at(virtual, wed11).click());
      expect(body.availabilityVirtual).toEqual(withValues({ [wed11]: 0 }));

      // Submitting marks the response Submitted and relabels the button.
      const yourSchedule = page.getByRole("region", { name: "Your schedule" });
      await expect(
        yourSchedule.getByText("Submitted", { exact: true }),
      ).toHaveCount(0);
      await expect(submit).toHaveText("Submit availability");
      const submitted = nextTempSave(
        page,
        (sent) => sent.postDataJSON().submitted === 1,
      );
      await submit.click();
      expect((await submitted).status()).toBe(200);
      await expect(mainStatus(page, "Schedule submitted.")).toBeVisible();
      await expect(
        yourSchedule.getByText("Submitted", { exact: true }),
      ).toBeVisible();
      await expect(submit).toHaveText("Update availability");

      // The saved response, as the server now has it.
      const session = await tempAccessSessionState(page, event.code);
      expect(session.payload.participant).toMatchObject({
        submitted: 1,
        availabilityInperson: allAvailable,
        availabilityVirtual: withValues({ [wed11]: 0 }),
      });
      expect(
        (await rosterByEmail(request, event.code, token)).get(email).submitted,
      ).toBeTruthy();

      // A reload shows the same state.
      await page.reload();
      await expect(
        yourSchedule.getByText("Submitted", { exact: true }),
      ).toBeVisible();
      await expect(submit).toHaveText("Update availability");
      await page.getByRole("tab", { name: "Virtual" }).click();
      await expect(at(virtual, wed11)).toHaveAttribute(
        "data-availability",
        "busy",
      );
    } finally {
      await context.close();
    }
  });

  test("a save that lost to another session locks editing until Reload latest response, which falls back to the conflict's copy, and a failed save offers Retry and blocks Submit", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(
      request,
      "temp-conflict",
    );
    const email = `temp-conflict-cora-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Cora Conflict",
      email,
    );
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openTemporaryAccess(page, event, path, "Cora Conflict");
      const { submit, applyToAll } = tempEditorControls(page);
      const grid = page.getByRole("grid", { name: "Availability" });
      const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);
      const reloadLatest = page.getByRole("button", {
        name: "Reload latest response",
      });
      const retry = page.getByRole("button", { name: "Retry save" });
      const EDIT_CONFLICT =
        "This schedule changed somewhere else. Reload the latest response before editing again.";

      // Another tab of the same person saves first.
      const otherTab = await context.newPage();
      await otherTab.goto(`/temp-access?code=${event.code}`);
      const otherSave = nextTempSave(otherTab);
      await otherTab
        .getByRole("grid", { name: "Availability" })
        .locator('[data-cell-idx="5"]')
        .click();
      expect((await otherSave).status()).toBe(200);
      await otherTab.close();

      // This page's save still carries the older version.
      const conflicted = nextTempSave(page);
      await cell(0).click();
      const conflict = await conflicted;
      expect(conflict.status()).toBe(409);
      expect((await conflict.json()).errorCode).toBe(
        "participant_version_conflict",
      );
      await expect(mainAlert(page, EDIT_CONFLICT)).toBeVisible();
      await expect(reloadLatest).toBeVisible();
      await expect(retry).toHaveCount(0);
      await expect(grid).toHaveAttribute("aria-readonly", "true");
      await expect(submit).toBeDisabled();

      const reread = page.waitForResponse((response) =>
        SESSION_ROUTE.test(response.url()),
      );
      await reloadLatest.click();
      expect((await reread).status()).toBe(200);
      await expect(mainStatus(page, DRAFT_SAVED)).toBeVisible();
      await expect(cell(5)).toHaveAttribute("data-availability", "busy");
      await expect(cell(0)).toHaveAttribute("data-availability", "free");
      await expect(grid).not.toHaveAttribute("aria-readonly");
      await expect(submit).toBeEnabled();

      // Another write behind the page's back, and this time the re-read
      // fails: the page takes the copy the conflict returned.
      let latest = (await tempAccessSessionState(page, event.code)).payload
        .participant;
      const behind = [...latest.availabilityInperson];
      behind[6] = 0;
      expect(
        (
          await tempAccessPut(page, event.code, {
            availabilityInperson: behind,
            expectedVersion: latest.version,
          })
        ).status,
      ).toBe(200);
      const secondConflict = nextTempSave(page);
      await cell(1).click();
      expect((await secondConflict).status()).toBe(409);
      await expect(mainAlert(page, EDIT_CONFLICT)).toBeVisible();
      await page.route(
        SESSION_ROUTE,
        failRequests("GET", 503, { detail: "Service unavailable." }),
        { times: 1 },
      );
      await reloadLatest.click();
      await expect(mainStatus(page, DRAFT_SAVED)).toBeVisible();
      await expect(cell(6)).toHaveAttribute("data-availability", "busy");
      await expect(cell(1)).toHaveAttribute("data-availability", "free");
      // That copy's version is current, so the next save goes through.
      const accepted = nextTempSave(page);
      await cell(2).click();
      expect((await accepted).status()).toBe(200);
      await expect(mainStatus(page, DRAFT_SAVED)).toBeVisible();

      // Submitting against a newer version is refused the same way.
      latest = (await tempAccessSessionState(page, event.code)).payload
        .participant;
      const newer = [...latest.availabilityInperson];
      newer[7] = 0;
      expect(
        (
          await tempAccessPut(page, event.code, {
            availabilityInperson: newer,
            expectedVersion: latest.version,
          })
        ).status,
      ).toBe(200);
      const refusedSubmit = nextTempSave(page);
      await submit.click();
      expect((await refusedSubmit).status()).toBe(409);
      await expect(
        mainAlert(
          page,
          "This schedule changed somewhere else. Reload the latest response before submitting.",
        ),
      ).toBeVisible();
      await expect(submit).toBeDisabled();
      await reloadLatest.click();
      await expect(cell(7)).toHaveAttribute("data-availability", "busy");
      await expect(submit).toBeEnabled();

      // A save that fails for another reason offers Retry, and Submit
      // refuses to go ahead while it is unresolved.
      await page.route(
        SAVE_ROUTE,
        failRequests("PUT", 503, { error: SAVE_UNAVAILABLE }),
      );
      const failed = nextTempSave(page);
      await cell(3).click();
      expect((await failed).status()).toBe(503);
      await expect(mainAlert(page, SAVE_UNAVAILABLE)).toBeVisible();
      await expect(retry).toBeVisible();
      await expect(reloadLatest).toHaveCount(0);
      await expect(grid).not.toHaveAttribute("aria-readonly");
      const submitAttempts = requestRecorder(
        page,
        (sent) => isTempSave(sent) && sent.postDataJSON().submitted === 1,
      );
      await submit.click();
      await expect(
        mainAlert(page, "Resolve the draft save before submitting."),
      ).toBeVisible();
      expect(submitAttempts.entries).toEqual([]);
      await page.unroute(SAVE_ROUTE);

      const retried = nextTempSave(page);
      await retry.click();
      expect((await retried).status()).toBe(200);
      await expect(mainStatus(page, DRAFT_SAVED)).toBeVisible();
      await expect(retry).toHaveCount(0);
      await submit.click();
      await expect(mainStatus(page, "Schedule submitted.")).toBeVisible();
      await expect(applyToAll).toBeEnabled();
      const saved = (await tempAccessSessionState(page, event.code)).payload
        .participant;
      expect(saved.submitted).toBe(1);
      expect(
        [0, 1, 2, 3, 4, 5, 6, 7].map(
          (index) => saved.availabilityInperson[index],
        ),
      ).toEqual([1, 1, 0, 0, 1, 0, 0, 0]);
    } finally {
      await context.close();
    }
  });

  test("Upgrade to full access with a pending change saves it before leaving, and a failed save keeps the person and the change on the event", async ({
    browser,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(request, "temp-flush");
    const email = `temp-flush-fay-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Fay Flush",
      email,
    );
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openTemporaryAccess(page, event, path, "Fay Flush");
      const { upgrade } = tempEditorControls(page);
      const grid = page.getByRole("grid", { name: "Availability" });
      const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);
      await expect(upgrade).toHaveAttribute(
        "href",
        `/signup?upgrade=temporary&code=${event.code}&next=%2Fevent%3Fcode%3D${event.code}`,
      );

      // The save fails: the upgrade tries it again and does not leave.
      await page.route(
        SAVE_ROUTE,
        failRequests("PUT", 503, { error: SAVE_UNAVAILABLE }),
      );
      const failed = nextTempSave(page);
      await cell(0).click();
      expect((await failed).status()).toBe(503);
      const failedAgain = nextTempSave(page);
      await upgrade.click();
      expect((await failedAgain).status()).toBe(503);
      await page.unroute(SAVE_ROUTE);
      // Still here, with the change: Retry saves it on this page.
      const retried = nextTempSave(page);
      await page.getByRole("button", { name: "Retry save" }).click();
      expect((await retried).status()).toBe(200);
      await expect(mainStatus(page, DRAFT_SAVED)).toBeVisible();
      await expect(page).toHaveURL(/\/temp-access\?code=/);
      await expect(cell(0)).toHaveAttribute("data-availability", "busy");

      // A fresh change is pending when the upgrade starts: the page does
      // not leave until that save has been answered.
      const { held, release } = holdTempSaves();
      await page.route(SAVE_ROUTE, held.handler);
      const steps = [];
      page.on("response", (response) => {
        if (isTempSave(response.request())) steps.push("save answered");
      });
      page.on("request", (sent) => {
        if (sent.isNavigationRequest() && /\/signup\?/.test(sent.url()))
          steps.push("left for signup");
      });
      const saved = nextTempSave(page);
      await cell(1).click();
      await upgrade.click();
      await held.entered;
      await expect(page).toHaveURL(/\/temp-access\?code=/);
      release();
      const savedResponse = await saved;
      expect(savedResponse.status()).toBe(200);
      expect(
        savedResponse.request().postDataJSON().availabilityInperson.slice(0, 3),
      ).toEqual([0, 0, 1]);
      await expect(page).toHaveURL(/\/signup\?upgrade=temporary&/);
      expect(steps).toEqual(["save answered", "left for signup"]);
      await expect(
        page.getByRole("heading", { name: "Upgrade your account" }),
      ).toBeVisible();
      await expect(page.getByLabel("Email")).toHaveValue(email);
      const session = await tempAccessSessionState(page, event.code);
      expect(
        session.payload.participant.availabilityInperson.slice(0, 3),
      ).toEqual([0, 0, 1]);
    } finally {
      await context.close();
    }
  });

  test("Upgrade to full access says it is saving first and explains a failed save", async ({
    browser,
    request,
  }) => {
    // With a change pending, the Upgrade link saves it itself rather than
    // through the shared autosave navigation guard, so it says it is saving,
    // locks the editor meanwhile, and explains a failed save.
    const { runId, token, event } = await organizerEvent(
      request,
      "temp-flush-ui",
    );
    const email = `temp-flush-ui-fin-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Fin Feedback",
      email,
    );
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openTemporaryAccess(page, event, path, "Fin Feedback");
      const { upgrade, signOut, submit } = tempEditorControls(page);
      const grid = page.getByRole("grid", { name: "Availability" });
      const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);

      await page.route(
        SAVE_ROUTE,
        failRequests("PUT", 503, { error: SAVE_UNAVAILABLE }),
      );
      const failed = nextTempSave(page);
      await cell(0).click();
      expect((await failed).status()).toBe(503);
      await upgrade.click();
      await expect(
        mainAlert(
          page,
          "Your latest changes could not be saved. Resolve the save error before upgrading.",
        ),
      ).toBeVisible({ timeout: 5_000 });
      await expect(upgrade).toHaveText("Upgrade to full access");
      await page.unroute(SAVE_ROUTE);

      const { held, release } = holdTempSaves();
      await page.route(SAVE_ROUTE, held.handler);
      await cell(1).click();
      await upgrade.click();
      await held.entered;
      await expect(upgrade).toHaveText("Saving before upgrade…");
      await expect(upgrade).toHaveAttribute("aria-disabled", "true");
      await expect(signOut).toBeDisabled();
      await expect(submit).toBeDisabled();
      await expect(grid).toHaveAttribute("aria-readonly", "true");
      release();
      await expect(page).toHaveURL(/\/signup\?upgrade=temporary&/);
    } finally {
      await context.close();
    }
  });
});

test.describe("Upgrade page errors", () => {
  test("explains an incomplete link and an unverifiable session, keeps next on Continue with email, refuses mismatched passwords and a wrong code, and sets the new password and name only with the emailed code", async ({
    browser,
    page,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(
      request,
      "temp-signup",
    );
    const sendCode = page.getByRole("button", {
      name: "Send verification code",
    });

    await page.goto("/signup?upgrade=temporary");
    await expect(heading(page, "Upgrade your account")).toBeVisible();
    await expect(
      mainAlert(
        page,
        "This upgrade link is incomplete. Reopen the event from your temporary access link.",
      ),
    ).toBeVisible();
    await expect(sendCode).toBeDisabled();
    await expect(
      page.getByRole("link", { name: "Continue with email" }),
    ).toHaveAttribute("href", "/login?next=%2Fdashboard");

    // A real event, but this browser has no temporary session for it.
    const next = `/event?code=${event.code}`;
    await page.goto(
      `/signup?upgrade=temporary&code=${event.code}&next=${encodeURIComponent(next)}`,
    );
    await expect(
      mainAlert(
        page,
        "We could not verify this temporary session. Reopen your event access link and try again.",
      ),
    ).toBeVisible();
    await expect(sendCode).toBeDisabled();
    await expect(page.getByLabel("Email")).toHaveValue("");
    const continueWithEmail = page.getByRole("link", {
      name: "Continue with email",
    });
    await expect(continueWithEmail).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(next)}`,
    );
    await continueWithEmail.click();
    await expect(page).toHaveURL(
      new RegExp(`/login\\?next=${encodeURIComponent(next)}$`),
    );
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    // With a verified temporary session.
    const email = `temp-signup-sal-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Sal Signup",
      email,
    );
    const context = await browser.newContext();
    try {
      const temp = await context.newPage();
      await openTemporaryAccess(temp, event, path, "Sal Signup");
      await tempEditorControls(temp).upgrade.click();
      await expect(heading(temp, "Upgrade your account")).toBeVisible();
      await expect(temp.getByLabel("Email")).toHaveValue(email);
      await expect(temp.getByLabel("Email")).toHaveAttribute("readonly", "");
      const registrations = requestRecorder(
        temp,
        (sent) =>
          sent.method() === "POST" &&
          sent.url().includes("/events/temp-access/upgrade-registration"),
      );
      await temp.getByLabel("First name").fill("Sal");
      await temp.getByLabel("Last name").fill("Signup");
      await temp
        .getByLabel("Password", { exact: true })
        .fill("Signup-Pass-2026!");
      await temp.getByLabel("Confirm password").fill("Signup-Pass-2027!");
      const tempSend = temp.getByRole("button", {
        name: "Send verification code",
      });
      await tempSend.click();
      await expect(mainAlert(temp, "Passwords do not match.")).toBeVisible();
      await expect(
        temp.getByText("Set up your Releviz account."),
      ).toBeVisible();
      expect(registrations.entries).toEqual([]);

      await temp.getByLabel("Confirm password").fill("Signup-Pass-2026!");
      const upgradeAt = Date.now() - 1000;
      await tempSend.click();
      await expect(
        temp.getByText("Enter the email verification code."),
      ).toBeVisible();
      await expect(mainAlert(temp, "Passwords do not match.")).toHaveCount(0);
      expect(registrations.entries).toHaveLength(1);
      // Holding the link is not enough to choose the full account's password
      // or name: until the emailed code comes back, the account is unchanged.
      const temporaryAccount = accountDetails(email);
      expect(temporaryAccount).toMatchObject({
        usablePassword: false,
        accessLevel: "temporary",
      });
      expect(temporaryAccount.firstName).not.toBe("Sal");
      const upgradeCode = await latestVerificationCode(
        email,
        upgradeAt,
        "register",
      );
      const verify = temp.getByRole("button", { name: "Verify and continue" });
      await temp
        .getByLabel("Verification code")
        .fill(differentCode(upgradeCode));
      await verify.click();
      await expect(
        mainAlert(temp, "Verification code is invalid or has expired."),
      ).toBeVisible();
      await expect(temp).toHaveURL(/\/signup\?upgrade=temporary&/);
      expect(accountDetails(email)).toEqual(temporaryAccount);

      // The wrong code did not use up the right one, which sets the
      // password and the name sent with it.
      await temp.getByLabel("Verification code").fill(upgradeCode);
      await verify.click();
      await expect(temp).toHaveURL(new RegExp(`/event\\?code=${event.code}$`));
      expect(accountDetails(email)).toEqual({
        firstName: "Sal",
        lastName: "Signup",
        usablePassword: true,
        accessLevel: "full",
      });
    } finally {
      await context.close();
    }
  });
});

test.describe("Participant pages at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 } });

  test("the temporary access status, inactive link, failed open, editor, submitted, locked, ended and signed-out pages pass WCAG A/AA checks and do not scroll sideways", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(request, "temp-a11y");
    const email = `temp-a11y-ada-${runId}@example.com`;
    const { path } = await inviteTemporaryPerson(
      request,
      token,
      event,
      "Ada Access",
      email,
    );
    const tryAgain = page.getByRole("button", { name: "Try again" });
    const check = async (label) => {
      await expectNoHorizontalScroll(page, label);
      await expectAccessible(page, label);
    };

    await page.goto("/temp-access");
    await expect(heading(page, LINK_REQUIRED)).toBeVisible();
    await check("temporary access without a link");

    await page.goto(
      `/temp-access?code=${event.code}&invitation=${randomUUID()}`,
    );
    await expect(heading(page, INACTIVE_LINK)).toBeVisible();
    await check("temporary access with a link that isn't active");

    // The real link's first open fails on the way; Try again opens it.
    let failNextOpen = true;
    const failFirstOpen = async (route) => {
      if (route.request().method() === "POST" && failNextOpen) {
        failNextOpen = false;
        await fulfillError(route, 503, { detail: "Service unavailable." });
        return;
      }
      await route.fallback();
    };
    await page.route(OPEN_ROUTE, failFirstOpen);
    await page.goto(path);
    await expect(heading(page, OPEN_FAILED_TITLE)).toBeVisible();
    await expect(mainAlert(page, OPEN_FAILED)).toBeVisible();
    await check("temporary access, invitation not opened");
    await tryAgain.click();
    await expect(heading(page, event.name)).toBeVisible();
    await page.unroute(OPEN_ROUTE, failFirstOpen);
    await check("temporary editor");

    const { submit, applyToAll, brush, upgrade } = tempEditorControls(page);
    await submit.click();
    await expect(mainStatus(page, "Schedule submitted.")).toBeVisible();
    await check("temporary editor, submitted");

    // Closed by the organizer behind the page's back: the next save is
    // refused, and the page keeps the server's reason and locks every
    // control that edits. A reload explains the lock from the event status.
    const grid = page.getByRole("grid", { name: "Availability" });
    const expectLocked = async (message) => {
      await expect(mainStatus(page, message)).toHaveText(message);
      await expect(grid).toHaveAttribute("aria-readonly", "true");
      for (const control of [
        submit,
        applyToAll,
        page.getByRole("button", { name: "Mark all Available" }),
        brush("Busy"),
        brush("If needed"),
        brush("Available"),
      ]) {
        await expect(control).toBeDisabled();
      }
      await expect(upgrade).not.toHaveAttribute("aria-disabled", "true");
    };
    await setLifecycleViaApi(request, token, event.code, "closed");
    const refused = nextTempSave(page);
    await grid.locator('[data-cell-idx="0"]').click();
    expect((await refused).status()).toBe(409);
    await expectLocked("Responses cannot change while the event is closed.");
    // The refused paint is replaced by the saved response.
    await expect(grid.locator('[data-cell-idx="0"]')).toHaveAttribute(
      "data-availability",
      "free",
    );
    await check("temporary editor, locked by the server");
    await page.reload();
    await expectLocked("Responses are locked while this event is closed.");
    await check("temporary editor, locked");

    // Active again, the session expires before the next save.
    await setLifecycleViaApi(request, token, event.code, "active");
    await page.reload();
    await expect(submit).toBeEnabled();
    expireTempSessions(email);
    await grid.locator('[data-cell-idx="0"]').click();
    await expect(heading(page, "Temporary access ended")).toBeVisible();
    await check("temporary access ended");

    // Opened again from the link, then signed out.
    await openTemporaryAccess(page, event, path, "Ada Access");
    await tempEditorControls(page).signOut.click();
    await expect(heading(page, "You are signed out")).toBeVisible();
    await check("temporary access signed out");
  });

  test("an account participant's join panel, editor, locked view and confirmed meeting pass WCAG A/AA checks and do not scroll sideways", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await organizerEvent(request, "join-a11y", {
      accessMode: "open_link",
    });
    await registerAccount(
      page,
      `join-a11y-jo-${runId}@example.com`,
      "Jo",
      "Joiner",
    );
    const check = async (label) => {
      await expectNoHorizontalScroll(page, label);
      await expectAccessible(page, label);
    };

    await page.goto(`/event?code=${event.code}`);
    await expect(
      page.getByRole("heading", { name: "Join Event" }),
    ).toBeVisible();
    await check("join panel");
    await joinEventInBrowser(page, event.code, "Jo Joiner");
    await expect(
      page.getByRole("grid", { name: "Availability" }),
    ).toBeVisible();
    await check("participant editor");

    // Someone else's answer, so the meeting can be finalized later.
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, token, event, {
      name: "Rae Response",
      email: `join-a11y-rae-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    await setLifecycleViaApi(request, token, event.code, "closed");
    await page.reload();
    await expect(
      page.getByText("Responses are locked while this event is closed."),
    ).toBeVisible();
    await check("participant editor, locked");

    const results = await freshResults(request, token, event.code);
    await finalizeViaApi(
      request,
      token,
      event.code,
      results.recommendations[0],
    );
    await page.reload();
    await expect(
      page.locator("dl[aria-label='Confirmed meeting']"),
    ).toBeVisible();
    await check("participant confirmed meeting");
  });
});
