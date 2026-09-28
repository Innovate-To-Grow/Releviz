const { expect, test } = require("@playwright/test");
const {
  BACKEND_URL,
  FRONTEND_URL,
  apiJson,
  createEvent,
  differentCode,
  encryptPasswordFields,
  expectDashboard,
  expireResendCooldown,
  latestAuthLink,
  latestVerificationCode,
  newRunId,
  openAccountMenu,
  passwordLoginViaApi,
  readSession,
  registerAccountViaApi,
  requestEmailCode,
  runDjangoJson,
  setAccountPassword,
} = require("./helpers/releviz");
const {
  LIVE_SYNC_TIMEOUT_MS,
  addPersonApi,
  gotoParticipants,
  openPersonPanel,
  participantRow,
  rosterByEmail,
} = require("./helpers/participants");
const { wakeLiveSync } = require("./helpers/workspace");

// The sign-in edges the happy-path helpers skip: the email-code panel's
// controls, refused and throttled codes, the emailed one-click links on
// another device and their error states, the sign-in redirects of protected
// pages and the open-redirect guards on next, password mode and its lockout,
// recovery and the settings password, deletion and profile forms, deleting an
// account that organizes and answers events, a renamed account's name on the
// participant lists it answers, the refresh endpoint's 401s, the API client's
// refresh-and-retry, session revalidation on focus, and the legacy sign-in
// routes. Every test works on its own accounts and events.

const INVALID_CODE = "Verification code is invalid or has expired.";
const TOO_MANY_CODES =
  "Too many verification attempts. Please try again later.";
const INCOMPLETE_LINK =
  "This verification link is incomplete or invalid. Request a new code to continue.";
const CODE_SENT = "Check your email for a verification code.";
const RESET_SENT =
  "If an account exists for that email, a reset code has been sent. Check your inbox.";
// DRF's own wording for a durable auth throttle.
const THROTTLED =
  /^Request was throttled\. Expected available in \d+ seconds?\.$/;

// Next.js mounts its own role=alert route announcer, so page alerts and
// statuses are read from inside the page's <main>.
function mainAlert(page) {
  return page.getByRole("main").getByRole("alert");
}

function mainStatus(page) {
  return page.getByRole("main").getByRole("status");
}

function heading(page, name) {
  return page.getByRole("heading", { level: 1, name, exact: true });
}

function continueButton(page) {
  return page.getByRole("button", { name: "Continue", exact: true });
}

// A route/response matcher for one API endpoint, whatever its query string.
function isApiPath(pathname) {
  return (url) => new URL(url).pathname === pathname;
}

function apiResponse(page, pathname, method = "POST") {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname === pathname,
  );
}

// A stubbed backend answer. The web app calls the API cross-origin with
// credentials, so the stub carries the CORS headers the real API sends.
function fulfillJson(route, status, body) {
  const origin =
    route.request().headers().origin || new URL(FRONTEND_URL).origin;
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify(body),
  });
}

// Waits out one macrotask in the page. Work a handler starts with promises
// only (getAccessToken, then fetch) has run by then.
function flushPageTask(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      }),
  );
}

// Clicks a submit button until its POST goes out (Firefox on CI has dropped a
// submit made right after hydration) and resolves to the response.
async function clickUntilPosted(page, button, pathname) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const posted = page
      .waitForRequest(
        (sent) =>
          sent.method() === "POST" && new URL(sent.url()).pathname === pathname,
        { timeout: 5_000 },
      )
      .catch(() => null);
    await button.click();
    const sent = await posted;
    if (sent) return sent.response();
  }
  throw new Error(`No POST ${pathname} after three clicks`);
}

// Enters a code on the panel's code step and resolves to the verify response.
async function submitCode(page, code) {
  await page.getByLabel("Verification code").fill(code);
  const verified = apiResponse(page, "/authn/email-auth/verify-code/");
  await continueButton(page).click();
  return verified;
}

async function switchToPasswordMode(page) {
  await page
    .getByRole("button", { name: "Sign in with password instead" })
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
}

async function signInWithPassword(page, email, password) {
  await switchToPasswordMode(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
}

// The refresh cookie as an API request context holds it (it is scoped to
// /authn/ on the backend).
async function refreshCookieValue(context) {
  const { cookies } = await context.storageState();
  return cookies.find((cookie) => cookie.name === "releviz_refresh")?.value;
}

// A Set-Cookie header that expires the refresh cookie.
function clearsRefreshCookie(response) {
  return response
    .headersArray()
    .some(
      ({ name, value }) =>
        name.toLowerCase() === "set-cookie" &&
        /^releviz_refresh=(""|);/.test(value) &&
        /max-age=0/i.test(value),
    );
}

// Moves this address's pending codes past their expiry (only its own rows).
function expireEmailChallenges(email) {
  return runDjangoJson(
    `
from datetime import timedelta
from django.utils import timezone
from apps.authn.models import EmailAuthChallenge
updated = EmailAuthChallenge.objects.filter(
    target_email__iexact=data["email"], status="pending"
).update(expires_at=timezone.now() - timedelta(seconds=1))
print(json.dumps(updated))
`,
    { email },
  );
}

// The attempts and status of this address's newest code for a purpose.
function latestChallengeState(email, purpose) {
  return runDjangoJson(
    `
from apps.authn.models import EmailAuthChallenge
challenge = EmailAuthChallenge.objects.filter(
    target_email__iexact=data["email"], purpose=data["purpose"]
).order_by("-created_at").first()
print(json.dumps({"attempts": challenge.attempts, "status": challenge.status}))
`,
    { email, purpose },
  );
}

// Records `count` sign-in codes sent to this account within the last hour, so
// the hourly cap is reached without ten real round trips and cooldowns.
function seedSentLoginCodes(email, count) {
  runDjangoJson(
    `
from django.utils import timezone
from apps.authn.models import ContactEmail, EmailAuthChallenge
member = ContactEmail.objects.get(email_address__iexact=data["email"]).member
now = timezone.now()
EmailAuthChallenge.objects.bulk_create([
    EmailAuthChallenge(
        member=member,
        purpose="login",
        target_email=data["email"].lower(),
        expires_at=now,
        status="expired",
        last_sent_at=now,
    )
    for _ in range(data["count"])
])
print(json.dumps(True))
`,
    { email, count },
  );
}

// Blocks (or clears) the durable auth bucket that one identity (an email
// address, as the unauthenticated auth endpoints key it) has in a scope:
// "code_request", "code_verify" or "password_login_failure". The E2E limits
// are too high to reach, and only this test's own address is touched, never
// the per-IP buckets every test shares.
function setIdentityBlock(scope, identity, { blocked = true } = {}) {
  return runDjangoJson(
    `
from datetime import timedelta
from django.utils import timezone
from apps.authn.models import AuthRateLimitBucket
from apps.authn.security.helpers import _key_hash, normalize_security_identity
scope = data["scope"]
key_hash = _key_hash(scope, "identity", normalize_security_identity(data["identity"]))
if data["blocked"]:
    now = timezone.now()
    AuthRateLimitBucket.objects.update_or_create(
        scope=f"{scope}:identity",
        key_hash=key_hash,
        defaults={"window_started_at": now, "blocked_until": now + timedelta(minutes=30)},
    )
    print(json.dumps(True))
else:
    print(json.dumps(AuthRateLimitBucket.objects.filter(
        scope=f"{scope}:identity", key_hash=key_hash
    ).delete()[0] > 0))
`,
    { scope, identity, blocked },
  );
}

function deactivateAccount(email) {
  runDjangoJson(
    `
from apps.authn.models import ContactEmail
member = ContactEmail.objects.get(email_address__iexact=data["email"]).member
member.is_active = False
member.save(update_fields=["is_active"])
print(json.dumps(True))
`,
    { email },
  );
}

test.describe("Email-code sign-in panel", () => {
  test("Continue waits for a valid address, the code step keeps six digits, Back keeps the address, and a second code inside a minute is refused until the cooldown passes", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `code-panel-${runId}@example.com`;
    await registerAccountViaApi(request, email, "Cody", "Panel");
    const emailField = page.getByLabel("Email");
    const codeField = page.getByLabel("Verification code");
    const resend = page.getByRole("button", { name: "Resend code" });

    await page.goto("/login");
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();
    await expect(emailField).toHaveAccessibleDescription(
      "We'll email you a 6-digit sign-in code. New here? This creates your account.",
    );
    await expect(
      page.getByText(
        "By continuing, you agree to receive a one-time verification email.",
      ),
    ).toBeVisible();
    await expect(continueButton(page)).toBeDisabled();
    for (const invalid of ["not-an-email", "name@example", "two words@x.io"]) {
      await emailField.fill(invalid);
      await expect(continueButton(page)).toBeDisabled();
    }

    const firstAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    const code1 = await latestVerificationCode(email, firstAt, "login");
    await expect(page.getByText("Sending to")).toBeVisible();
    await expect(
      page.getByRole("main").getByText(email, { exact: true }),
    ).toBeVisible();
    await expect(mainStatus(page)).toHaveText(CODE_SENT);

    // Only digits are kept, at most six, and Continue needs all six.
    await expect(continueButton(page)).toBeDisabled();
    await codeField.fill("12ab34");
    await expect(codeField).toHaveValue("1234");
    await expect(continueButton(page)).toBeDisabled();
    await codeField.fill("1234567");
    await expect(codeField).toHaveValue("123456");
    await expect(continueButton(page)).toBeEnabled();

    await page.getByRole("button", { name: "Back" }).click();
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();
    await expect(emailField).toHaveValue(email);
    await expect(mainStatus(page)).toHaveCount(0);

    // Asking again for the same address inside the 60 s cooldown is refused
    // and keeps the email step.
    const refused = apiResponse(page, "/authn/email-auth/request-code/");
    await continueButton(page).click();
    expect((await refused).status()).toBe(429);
    await expect(mainAlert(page)).toHaveText(TOO_MANY_CODES);
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    expireResendCooldown(email);
    const secondAt = Date.now() - 1000;
    await continueButton(page).click();
    await expect(heading(page, "Verify Your Identity")).toBeVisible();
    await expect(mainAlert(page)).toHaveCount(0);
    const code2 = await latestVerificationCode(email, secondAt, "login", {
      notCode: code1,
    });

    // Resend inside the cooldown is refused too, and keeps the code step.
    const refusedResend = apiResponse(page, "/authn/email-auth/request-code/");
    await resend.click();
    expect((await refusedResend).status()).toBe(429);
    await expect(mainAlert(page)).toHaveText(TOO_MANY_CODES);
    await expect(heading(page, "Verify Your Identity")).toBeVisible();

    expireResendCooldown(email);
    const thirdAt = Date.now() - 1000;
    const resent = apiResponse(page, "/authn/email-auth/request-code/");
    await resend.click();
    expect((await resent).status()).toBe(202);
    await expect(mainStatus(page)).toHaveText(CODE_SENT);
    await expect(mainAlert(page)).toHaveCount(0);
    const code3 = await latestVerificationCode(email, thirdAt, "login", {
      notCode: code2,
    });

    expect((await submitCode(page, code3)).status()).toBe(200);
    await expectDashboard(page);
  });

  test("wrong, superseded, over-attempted and expired codes are refused on the code step, and a fresh code still signs in", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `code-refused-${runId}@example.com`;
    await registerAccountViaApi(request, email, "Rufus", "Refused");
    const resend = page.getByRole("button", { name: "Resend code" });
    const codeStep = heading(page, "Verify Your Identity");

    async function expectRefused(code) {
      expect((await submitCode(page, code)).status()).toBe(400);
      await expect(mainAlert(page)).toHaveText(INVALID_CODE);
      await expect(codeStep).toBeVisible();
    }

    async function resendCode(notCode) {
      const sentAt = Date.now() - 1000;
      const resent = apiResponse(page, "/authn/email-auth/request-code/");
      await resend.click();
      expect((await resent).status()).toBe(202);
      return latestVerificationCode(email, sentAt, "login", { notCode });
    }

    await page.goto("/login");
    const firstAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    const codeA = await latestVerificationCode(email, firstAt, "login");

    await expectRefused(differentCode(codeA));
    // Editing the code clears the error.
    await page.getByLabel("Verification code").fill("1");
    await expect(mainAlert(page)).toHaveCount(0);

    // A newer code supersedes the first one.
    expireResendCooldown(email);
    const codeB = await resendCode(codeA);
    const guesses = [codeA];
    for (let step = 1; guesses.length < 5; step += 1) {
      const guess = String((Number(codeB) + step) % 1_000_000).padStart(6, "0");
      if (!guesses.includes(guess)) guesses.push(guess);
    }
    // Five refused guesses (the superseded code first) use up the newer code.
    for (const guess of guesses) await expectRefused(guess);
    expect(latestChallengeState(email, "login")).toEqual({
      attempts: 5,
      status: "expired",
    });
    await expectRefused(codeB);

    // A used-up code no longer holds the cooldown, so Resend works at once;
    // a code past its ten minutes is refused.
    const codeC = await resendCode(codeB);
    expireEmailChallenges(email);
    await expectRefused(codeC);

    const codeD = await resendCode(codeC);
    expect((await submitCode(page, codeD)).status()).toBe(200);
    await expectDashboard(page);
  });

  test("an eleventh code within the hour is refused, and the durable request and verify throttles tell the person to wait without using up the code", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const capped = `code-cap-${runId}@example.com`;
    const throttled = `code-throttle-${runId}@example.com`;
    await registerAccountViaApi(request, capped, "Cap", "Hourly");
    await registerAccountViaApi(request, throttled, "Theo", "Throttle");
    seedSentLoginCodes(capped, 10);

    await page.goto("/login");
    await page.getByLabel("Email").fill(capped);
    const capRefused = await clickUntilPosted(
      page,
      continueButton(page),
      "/authn/email-auth/request-code/",
    );
    expect(capRefused.status()).toBe(429);
    await expect(mainAlert(page)).toHaveText(TOO_MANY_CODES);
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    // The durable per-address request throttle.
    setIdentityBlock("code_request", throttled);
    await page.getByLabel("Email").fill(throttled);
    const requestRefused = apiResponse(page, "/authn/email-auth/request-code/");
    await continueButton(page).click();
    expect((await requestRefused).status()).toBe(429);
    await expect(mainAlert(page)).toHaveText(THROTTLED);
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    expect(
      setIdentityBlock("code_request", throttled, { blocked: false }),
    ).toBe(true);
    const sentAt = Date.now() - 1000;
    await requestEmailCode(page, throttled);
    const code = await latestVerificationCode(throttled, sentAt, "login");

    // The durable per-address verify throttle refuses before the code is
    // checked, so the same code works once the block lifts.
    setIdentityBlock("code_verify", throttled);
    expect((await submitCode(page, code)).status()).toBe(429);
    await expect(mainAlert(page)).toHaveText(THROTTLED);
    await expect(heading(page, "Verify Your Identity")).toBeVisible();
    expect(setIdentityBlock("code_verify", throttled, { blocked: false })).toBe(
      true,
    );
    expect((await submitCode(page, code)).status()).toBe(200);
    await expectDashboard(page);
  });
});

test.describe("Emailed sign-in links", () => {
  test("an existing account's link signs in on another device, drops the code from the address bar, goes to next, and uses up the code the first device holds", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `link-${runId}@example.com`;
    await registerAccountViaApi(request, email, "Lina", "Link");

    await page.goto("/login?next=%2Fsettings");
    const requestedAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    const link = await latestAuthLink(email, requestedAt, "login");
    expect(link.params.get("flow")).toBe("auth");
    expect(link.params.get("source")).toBe("login");
    expect(link.params.get("email")).toBe(email.toLowerCase());
    expect(link.params.get("next")).toBe("/settings");
    expect(link.body).toContain("Sign In to Your Account");

    const otherDevice = await browser.newContext();
    try {
      const linkPage = await otherDevice.newPage();
      // Hold the verification so the in-between state can be checked.
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const verifyRoute = isApiPath("/authn/email-auth/verify-code/");
      await linkPage.route(verifyRoute, async (route) => {
        await held;
        await route.continue();
      });
      await linkPage.goto(link.url);
      await expect(heading(linkPage, "Signing you in")).toBeVisible();
      await expect(
        linkPage.getByText("Please wait while we securely verify your email."),
      ).toBeVisible();
      // The code-bearing hash leaves the address bar before anything else.
      await expect(linkPage).toHaveURL(/\/email-auth-link$/);
      release();
      await expect(linkPage).toHaveURL(/\/settings$/);
      await expect(heading(linkPage, "Account settings")).toBeVisible();
      await linkPage.unroute(verifyRoute);

      // The link used the code, so typing it on the first device fails.
      expect((await submitCode(page, link.code)).status()).toBe(400);
      await expect(mainAlert(page)).toHaveText(INVALID_CODE);
      await expect(heading(page, "Verify Your Identity")).toBeVisible();

      // Opening the used link again reports the refusal.
      await linkPage.goto(link.url);
      await expect(heading(linkPage, "Link verification failed")).toBeVisible();
      await expect(linkPage.getByRole("main")).toContainText(INVALID_CODE);
      await expect(
        linkPage.getByRole("link", { name: "Request a new code" }),
      ).toHaveAttribute("href", "/login");
      await expect(linkPage).toHaveURL(/\/email-auth-link$/);
    } finally {
      await otherDevice.close();
    }
  });

  test("a new address's link registers on another device through profile completion, a link without next opens its event, and an unsafe next falls back to the dashboard", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `link-new-${runId}@example.com`;

    await page.goto("/login");
    const requestedAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    const link = await latestAuthLink(email, requestedAt, "register");
    expect(link.params.get("flow")).toBe("register");
    expect(link.params.get("source")).toBe("register");
    expect(link.params.get("next")).toBe("/dashboard");
    expect(link.body).toContain("Continue Registration");

    let token;
    const otherDevice = await browser.newContext();
    try {
      const linkPage = await otherDevice.newPage();
      await linkPage.goto(link.url);
      await expect(linkPage).toHaveURL(
        /\/settings\?complete_profile=1&next=%2Fdashboard$/,
      );
      await expect(heading(linkPage, "Complete your profile")).toBeVisible();
      await linkPage.getByRole("textbox", { name: "First name" }).fill("Lena");
      await linkPage
        .getByRole("textbox", { name: "Last name" })
        .fill("Newlink");
      await continueButton(linkPage).click();
      await expectDashboard(linkPage);
      await expect(
        linkPage.getByRole("button", { name: "Lena Newlink", exact: true }),
      ).toBeVisible();
      token = (await readSession(linkPage)).access;
    } finally {
      await otherDevice.close();
    }

    // The first device's pending code went with the registration.
    expect((await submitCode(page, link.code)).status()).toBe(400);
    await expect(mainAlert(page)).toHaveText(INVALID_CODE);

    async function openInFreshBrowser(url, check) {
      const context = await browser.newContext();
      try {
        const fresh = await context.newPage();
        await fresh.goto(url);
        await check(fresh);
      } finally {
        await context.close();
      }
    }

    // An event-registration link without next opens its event.
    const event = await createEvent(request, token, {
      name: `Link event ${runId}`,
    });
    const eventAt = Date.now() - 1000;
    const eventCodeRequest = await request.post(
      `${BACKEND_URL}/authn/email-auth/request-code/`,
      { data: { email, source: "event_registration", event: event.code } },
    );
    expect(eventCodeRequest.status()).toBe(202);
    const eventLink = await latestAuthLink(email, eventAt, "login");
    expect(eventLink.params.get("flow")).toBe("auth");
    expect(eventLink.params.get("source")).toBe("event_registration");
    expect(eventLink.params.get("event")).toBe(event.code);
    expect(eventLink.params.has("next")).toBe(false);
    await openInFreshBrowser(eventLink.url, async (fresh) => {
      await expect(fresh).toHaveURL(new RegExp(`/event\\?code=${event.code}$`));
      await expect(heading(fresh, event.name)).toBeVisible();
    });

    // The API takes a dot-segment next as a local path; the link page still
    // refuses to follow it off the site.
    expireResendCooldown(email);
    const unsafeAt = Date.now() - 1000;
    const unsafeRequest = await request.post(
      `${BACKEND_URL}/authn/email-auth/request-code/`,
      { data: { email, source: "login", next: "/..//evil.example/steal" } },
    );
    expect(unsafeRequest.status()).toBe(202);
    const unsafeLink = await latestAuthLink(email, unsafeAt, "login");
    expect(unsafeLink.params.get("next")).toBe("/..//evil.example/steal");
    await openInFreshBrowser(unsafeLink.url, async (fresh) => {
      await expectDashboard(fresh);
      expect(new URL(fresh.url()).origin).toBe(new URL(FRONTEND_URL).origin);
    });
  });

  test("incomplete, mismatched, malformed and expired links explain themselves and lead back to sign-in", async ({
    page,
    request,
  }) => {
    const verifyCalls = [];
    page.on("request", (sent) => {
      if (/\/verify-code\/$/.test(new URL(sent.url()).pathname)) {
        verifyCalls.push(sent.url());
      }
    });
    const failed = heading(page, "Link verification failed");

    await page.goto("/email-auth-link");
    await expect(failed).toBeVisible();
    await expect(page.getByText(INCOMPLETE_LINK)).toBeVisible();
    await page.getByRole("link", { name: "Request a new code" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    const address = "email=someone%40example.com";
    for (const hash of [
      // A register flow never comes from the login source, nor auth from
      // register.
      `flow=register&source=login&${address}&code=123456`,
      `flow=auth&source=register&${address}&code=123456`,
      `flow=magic&source=login&${address}&code=123456`,
      `flow=auth&source=login&${address}&code=12345`,
      "flow=auth&source=login&email=someone.example.com&code=123456",
      `flow=auth&source=event_registration&${address}&code=123456&event=bad%20slug`,
    ]) {
      // A hash-only change would not reload the page, so leave it first.
      await page.goto("about:blank");
      await page.goto(`/email-auth-link#${hash}`);
      await expect(failed, hash).toBeVisible();
      await expect(page.getByText(INCOMPLETE_LINK)).toBeVisible();
      await expect(page).toHaveURL(/\/email-auth-link$/);
    }
    // Malformed links are refused before any verification request.
    expect(verifyCalls).toEqual([]);

    // A well-formed link whose code has expired is refused by the API.
    const runId = newRunId();
    const email = `link-expired-${runId}@example.com`;
    await registerAccountViaApi(request, email, "Ezra", "Expired");
    const requestedAt = Date.now() - 1000;
    const requested = await request.post(
      `${BACKEND_URL}/authn/email-auth/request-code/`,
      { data: { email, source: "login", next: "/settings" } },
    );
    expect(requested.status()).toBe(202);
    const link = await latestAuthLink(email, requestedAt, "login");
    expect(expireEmailChallenges(email)).toBe(1);
    await page.goto("about:blank");
    await page.goto(link.url);
    await expect(failed).toBeVisible();
    await expect(page.getByRole("main")).toContainText(INVALID_CODE);
    await expect(page).toHaveURL(/\/email-auth-link$/);
    expect(verifyCalls).toHaveLength(1);
  });
});

test.describe("Sign-in redirects", () => {
  test("signed-out edit, dashboard, settings and event pages send people to sign-in with the page as next, and signing in returns to it", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `guard-${runId}@example.com`;
    const organizer = await registerAccountViaApi(
      request,
      email,
      "Gil",
      "Guard",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Guarded ${runId}`,
    });
    const code = event.code;
    const nested = `/settings?complete_profile=1&next=${encodeURIComponent(`/event?code=${code}`)}`;

    for (const [path, expected] of [
      [`/edit?code=${code}`, `/login?next=%2Fedit%3Fcode%3D${code}`],
      ["/dashboard", "/login?next=/dashboard"],
      ["/settings", "/login?next=/settings"],
      // The completion link's own next is encoded a second time.
      [nested, `/login?next=${encodeURIComponent(nested)}`],
      [`/event?code=${code}`, `/login?next=%2Fevent%3Fcode%3D${code}`],
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(`${FRONTEND_URL}${expected}`);
      await expect(heading(page, "Welcome to Releviz")).toBeVisible();
    }
    await page.goto(`/login?next=%2Fedit%3Fcode%3D${code}`);
    const signInAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    expect(
      (
        await submitCode(
          page,
          await latestVerificationCode(email, signInAt, "login"),
        )
      ).status(),
    ).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/edit\\?code=${code}$`));
    await expect(heading(page, "Edit event")).toBeVisible();

    // Signed out again, the nested completion link resolves to its event for
    // an account whose profile is already complete.
    await page.context().clearCookies();
    await page.goto(nested);
    await expect(page).toHaveURL(
      `${FRONTEND_URL}/login?next=${encodeURIComponent(nested)}`,
    );
    const secondAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    expect(
      (
        await submitCode(
          page,
          await latestVerificationCode(email, secondAt, "login"),
        )
      ).status(),
    ).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/event\\?code=${code}$`));
    await expect(heading(page, event.name)).toBeVisible();
  });

  test("sign-in ignores external, protocol-relative, dot-segment and sign-in page destinations, a signed-in visit to /login goes straight to a safe next, and the API refuses a non-local next", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `next-${runId}@example.com`;
    const account = await registerAccountViaApi(request, email, "Nia", "Next");
    const event = await createEvent(request, account.access, {
      name: `Next event ${runId}`,
    });
    const frontendOrigin = new URL(FRONTEND_URL).origin;

    await page.goto(
      `/login?next=${encodeURIComponent("https://evil.example/steal")}`,
    );
    const codeRequest = page.waitForRequest(
      (sent) =>
        sent.method() === "POST" &&
        new URL(sent.url()).pathname === "/authn/email-auth/request-code/",
    );
    const signInAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    // The unsafe value never reaches the API or the emailed link.
    expect((await codeRequest).postDataJSON().next).toBe("/dashboard");
    expect(
      (
        await submitCode(
          page,
          await latestVerificationCode(email, signInAt, "login"),
        )
      ).status(),
    ).toBe(200);
    await expectDashboard(page);
    expect(new URL(page.url()).origin).toBe(frontendOrigin);

    for (const next of [
      "//evil.example",
      "/..//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/recover",
      "/login?next=%2Fsettings",
      "/signup",
      "/email-auth-link",
      "/settings?complete_profile=1&next=%2F%2Fevil.example",
      "/settings?complete_profile=1&next=%2Frecover",
    ]) {
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await expect(page, next).toHaveURL(`${frontendOrigin}/dashboard`);
      await expect(
        page.getByRole("heading", { name: "My Dashboard" }),
      ).toBeVisible();
    }

    for (const [entry, next, expected] of [
      ["/login", "/settings#password", "/settings#password"],
      ["/login", `/event?code=${event.code}`, `/event?code=${event.code}`],
      ["/login", "/settings?complete_profile=1&next=%2Fcreate", "/create"],
      ["/signup", "/settings", "/settings"],
    ]) {
      await page.goto(`${entry}?next=${encodeURIComponent(next)}`);
      await expect(page, `${entry} ${next}`).toHaveURL(
        `${frontendOrigin}${expected}`,
      );
    }
    await expect(heading(page, "Account settings")).toBeVisible();

    for (const next of [
      "https://evil.example",
      "//evil.example",
      "evil.example/path",
      "javascript:alert(1)",
    ]) {
      const refused = await request.post(
        `${BACKEND_URL}/authn/email-auth/request-code/`,
        { data: { email, source: "login", next } },
      );
      expect(refused.status(), next).toBe(400);
      expect(await refused.json()).toEqual({
        next: ["Next must be a local Releviz path."],
      });
    }
  });
});

test.describe("Password sign-in", () => {
  test("Sign In waits for both fields; wrong passwords and unknown or deactivated accounts get the same answer; a locked-out address is told to wait; and the panel switches back to codes", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `password-${runId}@example.com`;
    const password = "Correct-Horse-42!";
    await registerAccountViaApi(request, email, "Pam", "Password");
    setAccountPassword(email, password);
    const emailField = page.getByLabel("Email");
    const passwordField = page.getByLabel("Password", { exact: true });
    const signIn = page.getByRole("button", { name: "Sign In", exact: true });

    async function signInAttempt(expectedStatus) {
      const attempt = apiResponse(page, "/authn/login/");
      await signIn.click();
      expect((await attempt).status()).toBe(expectedStatus);
    }

    await page.goto("/login");
    await switchToPasswordMode(page);
    await expect(signIn).toBeDisabled();
    await emailField.fill(email);
    await expect(signIn).toBeDisabled();
    await passwordField.fill("x");
    await expect(signIn).toBeEnabled();
    await passwordField.fill("");
    await expect(signIn).toBeDisabled();

    await passwordField.fill("Wrong-Horse-42!");
    await signInAttempt(400);
    await expect(mainAlert(page)).toHaveText("Invalid credentials.");

    await emailField.fill(`nobody-${runId}@example.com`);
    await passwordField.fill(password);
    await signInAttempt(400);
    await expect(mainAlert(page)).toHaveText("Invalid credentials.");

    // Back to codes: the address stays, the password goes.
    await page
      .getByRole("button", { name: "Sign in with a verification code" })
      .click();
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();
    await expect(continueButton(page)).toBeEnabled();
    await expect(passwordField).toHaveCount(0);
    await expect(mainAlert(page)).toHaveCount(0);
    await expect(emailField).toHaveValue(`nobody-${runId}@example.com`);
    await switchToPasswordMode(page);
    await expect(passwordField).toHaveValue("");

    // A locked-out address is refused even with the right password.
    setIdentityBlock("password_login_failure", email);
    await emailField.fill(email);
    await passwordField.fill(password);
    await signInAttempt(429);
    await expect(mainAlert(page)).toHaveText(THROTTLED);
    expect(
      setIdentityBlock("password_login_failure", email, { blocked: false }),
    ).toBe(true);
    await signInAttempt(200);
    await expectDashboard(page);

    // A deactivated account gets the same answer as a wrong password.
    deactivateAccount(email);
    const deactivated = await passwordLoginViaApi(request, email, password);
    expect(deactivated.response.status()).toBe(400);
    expect(deactivated.payload).toEqual({
      non_field_errors: ["Invalid credentials."],
    });
  });

  test("the API refuses a plaintext password before checking it, so only an encrypted attempt tells the right password from a wrong one", async ({
    request,
  }) => {
    const runId = newRunId();
    const email = `plaintext-${runId}@example.com`;
    const password = "Plain-Text-42!";
    await registerAccountViaApi(request, email, "Pia", "Plaintext");
    setAccountPassword(email, password);

    for (const attempt of [password, "Wrong-Text-42!"]) {
      const plaintext = await passwordLoginViaApi(request, email, attempt, {
        encrypt: false,
      });
      expect(plaintext.response.status()).toBe(400);
      expect(plaintext.payload).toEqual({
        password: ["Encrypted password required."],
      });
    }

    const wrong = await passwordLoginViaApi(request, email, "Wrong-Text-42!");
    expect(wrong.response.status()).toBe(400);
    expect(wrong.payload).toEqual({
      non_field_errors: ["Invalid credentials."],
    });
    const right = await passwordLoginViaApi(request, email, password);
    expect(right.response.status()).toBe(200);
    expect(right.payload.access).toBeTruthy();
    expect(right.payload.user.email).toBe(email);
  });
});

test.describe("Password recovery", () => {
  test("Forgot password carries next through /recover, recovery answers unknown addresses neutrally and rejects mismatched, wrong and weak input, and the reset returns to next", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `recover-${runId}@example.com`;
    const newPassword = "Recovered-Pass-42!";
    await registerAccountViaApi(request, email, "Rhea", "Recover");
    const verifyCalls = [];
    page.on("request", (sent) => {
      if (
        new URL(sent.url()).pathname === "/authn/password-reset/verify-code/"
      ) {
        verifyCalls.push(sent.url());
      }
    });

    await page.goto("/login?next=%2Fsettings");
    await switchToPasswordMode(page);
    const forgot = page.getByRole("link", { name: "Forgot password?" });
    await expect(forgot).toHaveAttribute("href", "/recover?next=%2Fsettings");
    await forgot.click();
    await expect(page).toHaveURL(/\/recover\?next=%2Fsettings$/);
    await expect(heading(page, "Recover your account")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Back to login" }),
    ).toHaveAttribute("href", /^\/login(\?|$)/);

    const emailField = page.getByLabel("Email");
    const sendCode = page.getByRole("button", { name: "Send reset code" });
    const resetButton = page.getByRole("button", { name: "Reset password" });
    const codeField = page.getByLabel("Reset code");
    const passwordField = page.getByLabel("New password", { exact: true });
    const confirmField = page.getByLabel("Confirm new password");

    await expect(sendCode).toBeDisabled();
    await emailField.fill("nope");
    await expect(sendCode).toBeDisabled();

    // An unknown address gets the same neutral answer.
    await emailField.fill(`nobody-${runId}@example.com`);
    await sendCode.click();
    await expect(mainStatus(page)).toHaveText(RESET_SENT);
    await expect(emailField).toBeDisabled();

    await page.getByRole("button", { name: "Use a different email" }).click();
    await expect(emailField).toBeEnabled();
    await expect(mainStatus(page)).toHaveCount(0);
    await expect(codeField).toHaveCount(0);
    await expect(sendCode).toBeVisible();

    const firstAt = Date.now() - 1000;
    await emailField.fill(email);
    await sendCode.click();
    await expect(mainStatus(page)).toHaveText(RESET_SENT);
    const code1 = await latestVerificationCode(
      email,
      firstAt,
      "password_reset",
    );

    // A mismatch is caught before the code is sent anywhere.
    await codeField.fill(code1);
    await passwordField.fill(newPassword);
    await confirmField.fill("Recovered-Pass-43!");
    await resetButton.click();
    await expect(mainAlert(page)).toHaveText("Passwords do not match.");
    expect(verifyCalls).toEqual([]);

    await confirmField.fill(newPassword);
    await codeField.fill(differentCode(code1));
    const wrongCode = apiResponse(page, "/authn/password-reset/verify-code/");
    await resetButton.click();
    expect((await wrongCode).status()).toBe(400);
    await expect(mainAlert(page)).toHaveText(INVALID_CODE);

    await codeField.fill(code1);
    await passwordField.fill("password123");
    await confirmField.fill("password123");
    const weak = apiResponse(page, "/authn/password-reset/confirm/");
    await resetButton.click();
    expect((await weak).status()).toBe(400);
    await expect(mainAlert(page)).toContainText("This password is too common.");

    // Starting over sends a fresh code; one past its ten minutes is refused.
    await page.getByRole("button", { name: "Use a different email" }).click();
    await expect(codeField).toHaveCount(0);
    const secondAt = Date.now() - 1000;
    await sendCode.click();
    await expect(mainStatus(page)).toHaveText(RESET_SENT);
    const code2 = await latestVerificationCode(
      email,
      secondAt,
      "password_reset",
      { notCode: code1 },
    );
    expect(expireEmailChallenges(email)).toBe(1);
    await codeField.fill(code2);
    await passwordField.fill(newPassword);
    await confirmField.fill(newPassword);
    const expiredCode = apiResponse(page, "/authn/password-reset/verify-code/");
    await resetButton.click();
    expect((await expiredCode).status()).toBe(400);
    await expect(mainAlert(page)).toHaveText(INVALID_CODE);
    await expect(page).toHaveURL(/\/recover\?next=%2Fsettings$/);

    await page.getByRole("button", { name: "Use a different email" }).click();
    const thirdAt = Date.now() - 1000;
    await sendCode.click();
    await expect(mainStatus(page)).toHaveText(RESET_SENT);
    const code3 = await latestVerificationCode(
      email,
      thirdAt,
      "password_reset",
      { notCode: code2 },
    );
    await codeField.fill(code3);
    await passwordField.fill(newPassword);
    await confirmField.fill(newPassword);
    await resetButton.click();
    await expect(page).toHaveURL(
      /\/login\?status=password-reset&next=%2Fsettings$/,
    );
    await expect(mainStatus(page)).toHaveText(
      "Password reset complete. Continue with your email.",
    );

    await signInWithPassword(page, email, newPassword);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(heading(page, "Account settings")).toBeVisible();
  });

  test("a weak new password is refused without using up the reset code", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `recover-weak-${runId}@example.com`;
    const strongPassword = "Stronger-Pass-42!";
    await registerAccountViaApi(request, email, "Wes", "Weak");

    // Reach the recovery form through the sign-in panel, so it is hydrated
    // before it is filled in.
    await page.goto("/login");
    await switchToPasswordMode(page);
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(heading(page, "Recover your account")).toBeVisible();
    const sentAt = Date.now() - 1000;
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(mainStatus(page)).toHaveText(RESET_SENT);
    const code = await latestVerificationCode(email, sentAt, "password_reset");
    const resetButton = page.getByRole("button", { name: "Reset password" });
    await page.getByLabel("Reset code").fill(code);
    await page.getByLabel("New password", { exact: true }).fill("password123");
    await page.getByLabel("Confirm new password").fill("password123");
    const weak = apiResponse(page, "/authn/password-reset/confirm/");
    await resetButton.click();
    expect((await weak).status()).toBe(400);
    await expect(mainAlert(page)).toContainText("This password is too common.");

    // The person picks a stronger password; the code is still within its
    // ten minutes and was never used for a reset, so the reset goes through.
    await page.getByLabel("New password", { exact: true }).fill(strongPassword);
    await page.getByLabel("Confirm new password").fill(strongPassword);
    await resetButton.click();
    await expect(page).toHaveURL(/\/login\?status=password-reset$/);
    const login = await passwordLoginViaApi(request, email, strongPassword);
    expect(login.response.status()).toBe(200);
  });

  test("a second reset request within a minute gets the same neutral answer for an existing account as for an unknown address", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const known = `recover-known-${runId}@example.com`;
    const unknown = `recover-unknown-${runId}@example.com`;
    await registerAccountViaApi(request, known, "Kit", "Known");

    await page.goto("/login");
    await switchToPasswordMode(page);
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(heading(page, "Recover your account")).toBeVisible();
    const emailField = page.getByLabel("Email");
    const sendCode = page.getByRole("button", { name: "Send reset code" });

    // The unknown address first, then the account: each is asked for twice
    // in a row, as someone probing addresses (or retrying) would.
    for (const [attempt, address] of [
      unknown,
      unknown,
      known,
      known,
    ].entries()) {
      if (attempt > 0) {
        await page
          .getByRole("button", { name: "Use a different email" })
          .click();
      }
      await emailField.fill(address);
      const answered = apiResponse(page, "/authn/password-reset/request-code/");
      await sendCode.click();
      expect((await answered).status(), `${address} #${attempt}`).toBe(202);
      await expect(mainStatus(page)).toHaveText(RESET_SENT);
      await expect(mainAlert(page)).toHaveCount(0);
    }
  });
});

test.describe("Account settings", () => {
  test("changing the password reports a mismatch, a wrong current password and weak new passwords, and keeps the session and the old password", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `change-pass-${runId}@example.com`;
    const password = "Settings-Pass-42!";
    await registerAccountViaApi(request, email, "Sam", "Settings");
    setAccountPassword(email, password);
    // Setting a password outdates the tokens issued before it, so the browser
    // signs in with the password itself.
    const signedIn = await passwordLoginViaApi(page.request, email, password);
    expect(signedIn.response.status()).toBe(200);
    const changeCalls = [];
    page.on("request", (sent) => {
      if (new URL(sent.url()).pathname === "/authn/change-password/") {
        changeCalls.push(sent.method());
      }
    });

    await page.goto("/settings");
    await expect(heading(page, "Account settings")).toBeVisible();
    await expect(page.getByText("This device", { exact: true })).toBeVisible();
    const form = page.locator("form#password");
    await form.locator("summary").click();
    const current = form.getByLabel("Current password");
    const newPassword = form.getByLabel("New password", { exact: true });
    const confirmation = form.getByLabel("Confirm new password");
    const change = form.getByRole("button", { name: "Change password" });

    async function changeAttempt() {
      const attempt = apiResponse(page, "/authn/change-password/");
      await change.click();
      expect((await attempt).status()).toBe(400);
    }

    await current.fill(password);
    await newPassword.fill("Brand-New-Pass-42!");
    await confirmation.fill("Brand-New-Pass-43!");
    await change.click();
    await expect(form.getByRole("alert")).toHaveText(
      "New passwords do not match.",
    );
    expect(changeCalls).toEqual([]);

    await current.fill("Not-My-Pass-42!");
    await confirmation.fill("Brand-New-Pass-42!");
    await changeAttempt();
    await expect(form.getByRole("alert")).toHaveText(
      "Current password is incorrect.",
    );

    await current.fill(password);
    await newPassword.fill("password123");
    await confirmation.fill("password123");
    await changeAttempt();
    await expect(form.getByRole("alert")).toContainText(
      "This password is too common.",
    );
    await expect(page).toHaveURL(/\/settings$/);

    // The form's minlength keeps a short password in the browser; the API
    // enforces the same minimum on its own.
    const session = await readSession(page);
    const short = await apiJson(
      request,
      "POST",
      "/authn/change-password/",
      session.access,
      await encryptPasswordFields(
        request,
        {
          current_password: password,
          new_password: "Ab1!xyz",
          new_password_confirm: "Ab1!xyz",
        },
        ["current_password", "new_password", "new_password_confirm"],
      ),
    );
    expect(short.response.status()).toBe(400);
    expect(short.payload).toEqual({
      new_password: ["Password must be at least 8 characters."],
    });

    // Nothing changed: the session and the old password both still work.
    await page.reload();
    await expect(heading(page, "Account settings")).toBeVisible();
    const profile = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      (await readSession(page)).access,
    );
    expect(profile.response.status()).toBe(200);
    const login = await passwordLoginViaApi(request, email, password);
    expect(login.response.status()).toBe(200);
  });

  test("account deletion waits for exactly DELETE and a six-digit code, and a wrong code keeps the account and the session", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `delete-guard-${runId}@example.com`;
    await registerAccountViaApi(page.request, email, "Dana", "Keeps");
    const confirmCalls = [];
    const verifyCalls = [];
    page.on("request", (sent) => {
      const { pathname } = new URL(sent.url());
      if (pathname === "/authn/delete-account/confirm/") {
        confirmCalls.push(sent.method());
      }
      if (
        pathname === "/authn/delete-account/verify-code/" &&
        sent.method() === "POST"
      ) {
        verifyCalls.push(sent.postDataJSON().code);
      }
    });

    await page.goto("/settings");
    await expect(heading(page, "Account settings")).toBeVisible();
    const zone = page.locator("form#danger-zone");
    await zone.locator("summary").click();
    await expect(zone.getByRole("note")).toHaveText(
      "Every session will be revoked and your identity will be anonymized in retained scheduling records.",
    );
    const sendCode = zone.getByRole("button", {
      name: "Email a confirmation code",
    });
    const typed = zone.getByLabel("Type DELETE to confirm");
    await expect(sendCode).toBeDisabled();
    for (const attempt of ["delete", "DELETE ", " DELETE", "DELET"]) {
      await typed.fill(attempt);
      await expect(sendCode, attempt).toBeDisabled();
    }
    await typed.fill("DELETE");
    await expect(sendCode).toBeEnabled();

    const sentAt = Date.now() - 1000;
    await sendCode.click();
    await expect(zone.getByRole("status")).toHaveText(
      "We emailed a confirmation code. Enter it to delete your account.",
    );
    const code = await latestVerificationCode(email, sentAt, "account_delete");
    const deleteNow = zone.getByRole("button", {
      name: "Delete account permanently",
    });
    const codeField = zone.getByLabel("Confirmation code");
    await expect(deleteNow).toBeDisabled();
    const wrong = differentCode(code);
    await codeField.fill(wrong.slice(0, 5));
    await expect(deleteNow).toBeDisabled();
    // Six characters that are not six digits are held back by the field.
    await codeField.fill(`${wrong.slice(0, 5)}x`);
    await expect(deleteNow).toBeEnabled();
    await deleteNow.click();
    expect(
      await codeField.evaluate((field) => field.validity.patternMismatch),
    ).toBe(true);
    await codeField.fill(wrong);
    await expect(deleteNow).toBeEnabled();
    await typed.fill("DELETE!");
    await expect(deleteNow).toBeDisabled();
    await typed.fill("DELETE");
    await expect(deleteNow).toBeEnabled();

    const verify = apiResponse(page, "/authn/delete-account/verify-code/");
    await deleteNow.click();
    expect((await verify).status()).toBe(400);
    await expect(zone.getByRole("alert")).toHaveText(INVALID_CODE);
    await expect(page).toHaveURL(/\/settings$/);
    // Only the six-digit code was checked, and nothing was deleted.
    expect(verifyCalls).toEqual([wrong]);
    expect(confirmCalls).toEqual([]);

    // The account and this browser's session both survive.
    await page.reload();
    await expect(heading(page, "Account settings")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Dana Keeps", exact: true }),
    ).toBeVisible();
    const profile = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      (await readSession(page)).access,
    );
    expect(profile.response.status()).toBe(200);
    expect(profile.payload.email).toBe(email);
  });

  test("deleting an organizer who also answered another organizer's event removes their events, their managed people and their answer, and queues that event's results", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const keeper = await registerAccountViaApi(
      request,
      `keeper-${runId}@example.com`,
      "Kim",
      "Keeper",
    );
    const kept = await createEvent(request, keeper.access, {
      name: `Kept ${runId}`,
      accessMode: "open_link",
    });
    const email = `leaver-${runId}@example.com`;
    const leaver = await registerAccountViaApi(
      page.request,
      email,
      "Lee",
      "Leaver",
    );
    const owned = await createEvent(request, leaver.access, {
      name: `Owned ${runId}`,
    });
    const managed = await addPersonApi(request, owned.code, leaver.access, {
      name: "Nora Noemail",
      organizerManaged: true,
    });
    const managedMemberId = managed.participant.id;

    // The leaver answers the keeper's event.
    const joined = await apiJson(
      request,
      "POST",
      `/events/participants?code=${kept.code}`,
      leaver.access,
      {},
    );
    expect(joined.response.status(), JSON.stringify(joined.payload)).toBe(201);
    const own = joined.payload.participant;
    const answered = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${kept.code}&participantId=${own.id}`,
      leaver.access,
      {
        availabilityInperson: Array(kept.slotCount).fill(1),
        availabilityVirtual: Array(kept.slotCount).fill(0),
        submitted: 1,
        expectedVersion: own.version,
      },
    );
    expect(answered.response.status(), JSON.stringify(answered.payload)).toBe(
      200,
    );
    expect(
      (await rosterByEmail(request, kept.code, keeper.access)).get(email),
    ).toEqual(expect.objectContaining({ name: "Lee Leaver", submitted: true }));

    const state = () =>
      runDjangoJson(
        `
from apps.authn.models import Member
from apps.scheduling.models import Event, EventResultInvalidation, Participant, ScheduleEditRecord
print(json.dumps({
    "leaver": Member.objects.filter(pk=data["leaver"]).exists(),
    "managedMember": Member.objects.filter(pk=data["managed"]).exists(),
    "ownedEvent": Event.objects.filter(code=data["owned"]).exists(),
    "keptEvent": Event.objects.filter(code=data["kept"]).exists(),
    "leaverRows": Participant.objects.filter(member_id=data["leaver"]).count(),
    "leaverEdits": ScheduleEditRecord.objects.filter(event__code=data["kept"], participant__member_id=data["leaver"]).count(),
    "keptInvalidations": EventResultInvalidation.objects.filter(event__code=data["kept"]).count(),
}))
`,
        {
          leaver: leaver.user.id,
          managed: managedMemberId,
          owned: owned.code,
          kept: kept.code,
        },
      );
    const before = state();
    expect(before).toEqual(
      expect.objectContaining({
        leaver: true,
        managedMember: true,
        ownedEvent: true,
        keptEvent: true,
        leaverRows: 1,
      }),
    );
    // The answer left an edit record behind.
    expect(before.leaverEdits).toBeGreaterThan(0);

    await page.goto("/settings");
    const zone = page.locator("form#danger-zone");
    await zone.locator("summary").click();
    await zone.getByLabel("Type DELETE to confirm").fill("DELETE");
    const sentAt = Date.now() - 1000;
    await zone
      .getByRole("button", { name: "Email a confirmation code" })
      .click();
    await zone
      .getByLabel("Confirmation code")
      .fill(await latestVerificationCode(email, sentAt, "account_delete"));
    await zone
      .getByRole("button", { name: "Delete account permanently" })
      .click();
    await expect(page).toHaveURL(/\/login\?status=account-deleted$/);
    await expect(mainStatus(page)).toHaveText("Your account has been deleted.");

    expect(state()).toEqual({
      leaver: false,
      // The organizer's event goes with the account, and so does the
      // identity-less member behind the person they managed there.
      managedMember: false,
      ownedEvent: false,
      // The other organizer's event stays, without the leaver's answer...
      keptEvent: true,
      leaverRows: 0,
      leaverEdits: 0,
      // ...and its results are queued for a recompute.
      keptInvalidations: before.keptInvalidations + 1,
    });
    expect(
      (await rosterByEmail(request, kept.code, keeper.access)).has(email),
    ).toBe(false);
  });

  test("profile names save, survive a reload and show in the header and the session, and a blank name or a failed save is explained", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `profile-${runId}@example.com`;
    await registerAccountViaApi(page.request, email, "Pia", "Profile");
    const profileForm = page.locator("form#profile");
    const first = profileForm.getByRole("textbox", { name: "First name" });
    const last = profileForm.getByRole("textbox", { name: "Last name" });
    const save = profileForm.getByRole("button", { name: "Save profile" });
    const profileRoute = isApiPath("/authn/profile/");
    const profileSaves = [];
    page.on("request", (sent) => {
      if (
        sent.method() === "PATCH" &&
        new URL(sent.url()).pathname === "/authn/profile/"
      ) {
        profileSaves.push(sent.postDataJSON());
      }
    });

    await page.goto("/settings");
    await expect(heading(page, "Account settings")).toBeVisible();
    await expect(first).toHaveValue("Pia");
    await expect(last).toHaveValue("Profile");
    await expect(
      page.getByRole("button", { name: "Pia Profile", exact: true }),
    ).toBeVisible();

    // An empty name is stopped by the field; a blank one by the API. The
    // blank save is the first one the API sees.
    await first.fill("");
    await save.click();
    expect(await first.evaluate((field) => field.validity.valueMissing)).toBe(
      true,
    );
    await first.fill("   ");
    const blank = apiResponse(page, "/authn/profile/", "PATCH");
    await save.click();
    expect((await blank).status()).toBe(400);
    expect(profileSaves).toEqual([{ first_name: "   ", last_name: "Profile" }]);
    await expect(profileForm.getByRole("alert")).toHaveText(
      "This field may not be blank.",
    );

    // A save that never reaches the API is reported and changes nothing.
    await page.route(profileRoute, (route) =>
      route.request().method() === "PATCH"
        ? route.abort("failed")
        : route.continue(),
    );
    await first.fill("Paula");
    await last.fill("Renamed");
    await save.click();
    await expect(profileForm.getByRole("alert")).toBeVisible();
    await expect(profileForm.getByRole("alert")).not.toHaveText("");
    await expect(profileForm.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Pia Profile", exact: true }),
    ).toBeVisible();
    await page.unroute(profileRoute);

    const saved = apiResponse(page, "/authn/profile/", "PATCH");
    await save.click();
    expect((await saved).status()).toBe(200);
    await expect(profileForm.getByRole("status")).toHaveText("Saved");
    await expect(profileForm.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Paula Renamed", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("complementary")
        .getByText("Paula Renamed", { exact: true }),
    ).toBeVisible();

    await page.reload();
    await expect(first).toHaveValue("Paula");
    await expect(last).toHaveValue("Renamed");
    const { trigger } = await openAccountMenu(page, "Paula Renamed");
    await expect(trigger).toBeVisible();
    const session = await readSession(page);
    expect(session.user).toEqual(
      expect.objectContaining({ first_name: "Paula", last_name: "Renamed" }),
    );
    expect(session.requires_profile_completion).toBe(false);
  });

  test("a renamed account shows its new name on the participant list of an event it already answers", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `rene-${runId}@example.com`;
    const rene = await registerAccountViaApi(
      page.request,
      email,
      "Rene",
      "Before",
    );
    const organizerDevice = await browser.newContext();
    try {
      const organizer = await registerAccountViaApi(
        organizerDevice.request,
        `rename-organizer-${runId}@example.com`,
        "Oona",
        "Organizer",
      );
      const answered = await createEvent(request, organizer.access, {
        name: `Answered ${runId}`,
        accessMode: "open_link",
      });
      const joined = await apiJson(
        request,
        "POST",
        `/events/participants?code=${answered.code}`,
        rene.access,
        {},
      );
      expect(joined.response.status(), JSON.stringify(joined.payload)).toBe(
        201,
      );
      // In another event the organizer added Rene under a name of their own
      // and still answers for him.
      const invited = await createEvent(request, organizer.access, {
        name: `Invited ${runId}`,
      });
      await addPersonApi(request, invited.code, organizer.access, {
        name: "Rene From Team B",
        email,
      });
      const before = (
        await rosterByEmail(request, answered.code, organizer.access)
      ).get(email);
      expect(before).toEqual(
        expect.objectContaining({
          name: "Rene Before",
          canOrganizerEditAvailability: false,
        }),
      );

      const workspace = await organizerDevice.newPage();
      await gotoParticipants(workspace, answered);
      await expect(participantRow(workspace, "Rene Before")).toBeVisible();

      await page.goto("/settings");
      await expect(heading(page, "Account settings")).toBeVisible();
      const profileForm = page.locator("form#profile");
      await profileForm
        .getByRole("textbox", { name: "Last name" })
        .fill("After");
      const saved = apiResponse(page, "/authn/profile/", "PATCH");
      await profileForm.getByRole("button", { name: "Save profile" }).click();
      expect((await saved).status()).toBe(200);
      await expect(profileForm.getByRole("status")).toHaveText("Saved");

      // The organizer's open list picks the new name up without a reload, and
      // the name is still Rene's alone to change.
      await wakeLiveSync(workspace);
      await expect(participantRow(workspace, "Rene After")).toBeVisible({
        timeout: LIVE_SYNC_TIMEOUT_MS,
      });
      await expect(participantRow(workspace, "Rene Before")).toHaveCount(0);
      const panel = await openPersonPanel(workspace, "Rene After");
      const fullName = panel.getByRole("textbox", { name: "Full name" });
      await expect(fullName).toHaveValue("Rene After");
      await expect(fullName).toBeDisabled();
      await expect(fullName).toHaveAccessibleDescription(
        "They set their own name in their Releviz account.",
      );
      expect(
        (await rosterByEmail(request, answered.code, organizer.access)).get(
          email,
        ),
      ).toEqual(
        expect.objectContaining({
          name: "Rene After",
          version: before.version + 1,
        }),
      );

      // Rene sees the new name on the event too.
      await page.goto(`/event?code=${answered.code}`);
      await expect(
        page.getByRole("heading", { level: 2, name: /Welcome, Rene After/ }),
      ).toBeVisible();

      // Where the organizer still answers for Rene, the name they gave stays.
      expect(
        (await rosterByEmail(request, invited.code, organizer.access)).get(
          email,
        ),
      ).toEqual(
        expect.objectContaining({
          name: "Rene From Team B",
          canOrganizerEditAvailability: true,
        }),
      );
    } finally {
      await organizerDevice.close();
    }
  });
});

test.describe("Session refresh and revalidation", () => {
  test("refresh answers 401 and clears the cookie when the session is missing, malformed, logged out or belongs to a deactivated account", async ({
    playwright,
  }) => {
    const runId = newRunId();
    const refresh = (context, headers = {}) =>
      context.post(`${BACKEND_URL}/authn/refresh/`, { data: {}, headers });

    const fresh = await playwright.request.newContext();
    try {
      const missing = await refresh(fresh);
      expect(missing.status()).toBe(401);
      expect(await missing.json()).toEqual({
        detail: "Refresh session is required.",
      });
      expect(clearsRefreshCookie(missing)).toBe(true);

      const malformed = await refresh(fresh, {
        Cookie: "releviz_refresh=not-a-token",
      });
      expect(malformed.status()).toBe(401);
      expect(await malformed.json()).toEqual({
        detail: "Refresh session is invalid or has expired.",
      });
      expect(clearsRefreshCookie(malformed)).toBe(true);
    } finally {
      await fresh.dispose();
    }

    const loggedOut = await playwright.request.newContext();
    try {
      await registerAccountViaApi(
        loggedOut,
        `refresh-out-${runId}@example.com`,
        "Olly",
        "Out",
      );
      const cookie = await refreshCookieValue(loggedOut);
      expect(cookie).toBeTruthy();
      expect((await refresh(loggedOut)).status()).toBe(200);
      const logout = await loggedOut.post(`${BACKEND_URL}/authn/logout/`, {
        data: {},
      });
      expect(logout.status()).toBe(204);
      expect(await refreshCookieValue(loggedOut)).toBeUndefined();

      // The logged-out (blacklisted) refresh token no longer works.
      const replayed = await refresh(loggedOut, {
        Cookie: `releviz_refresh=${cookie}`,
      });
      expect(replayed.status()).toBe(401);
      expect(await replayed.json()).toEqual({
        detail: "Refresh session is invalid or has expired.",
      });
      expect(clearsRefreshCookie(replayed)).toBe(true);
    } finally {
      await loggedOut.dispose();
    }

    const deactivated = await playwright.request.newContext();
    try {
      const email = `refresh-inactive-${runId}@example.com`;
      await registerAccountViaApi(deactivated, email, "Dee", "Inactive");
      expect((await refresh(deactivated)).status()).toBe(200);
      deactivateAccount(email);
      const refused = await refresh(deactivated);
      expect(refused.status()).toBe(401);
      // simplejwt checks the member is active before the view's own check,
      // so either wording may carry the refusal.
      expect([
        "Refresh session is invalid or has expired.",
        "No active account was found for this session.",
      ]).toContain((await refused.json()).detail);
      expect(clearsRefreshCookie(refused)).toBe(true);
      expect(await refreshCookieValue(deactivated)).toBeUndefined();
    } finally {
      await deactivated.dispose();
    }
  });

  test("a 401 from the API refreshes the session once and retries the call, and an access token about to expire is refreshed before the call", async ({
    page,
  }) => {
    const runId = newRunId();
    await registerAccountViaApi(
      page.request,
      `retry-${runId}@example.com`,
      "Rita",
      "Retry",
    );
    const watched = [
      "/authn/refresh/",
      "/authn/sessions/",
      "/dashboard/events",
    ];
    const seen = [];
    page.on("request", (sent) => {
      const { pathname } = new URL(sent.url());
      if (watched.includes(pathname) && sent.method() !== "OPTIONS") {
        seen.push({ pathname, auth: sent.headers().authorization || "" });
      }
    });

    // The settings page's first session listing is answered 401, as for an
    // access token the API no longer accepts.
    let rejected = false;
    await page.route(isApiPath("/authn/sessions/"), (route) => {
      if (route.request().method() === "GET" && !rejected) {
        rejected = true;
        return fulfillJson(route, 401, {
          detail: "Given token not valid for any token type",
        });
      }
      return route.continue();
    });
    await page.goto("/settings");
    await expect(page.getByText("This device", { exact: true })).toBeVisible();
    const listings = seen
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.pathname === "/authn/sessions/");
    // The refreshed session also re-runs the page's listing effect, so a
    // third listing may follow; the retry is the second.
    expect(listings.length).toBeGreaterThanOrEqual(2);
    expect(listings[0].auth).toMatch(/^Bearer \S+$/);
    expect(listings[1].auth).toMatch(/^Bearer \S+$/);
    expect(listings[1].auth).not.toBe(listings[0].auth);
    expect(
      seen
        .slice(listings[0].index + 1, listings[1].index)
        .map((entry) => entry.pathname),
    ).toEqual(["/authn/refresh/"]);

    // The API never sends an access expiry today; when a session carries one
    // that is about to pass, the client refreshes before using the token.
    seen.length = 0;
    let bootAccess = "";
    await page.route(isApiPath("/authn/refresh/"), async (route) => {
      if (route.request().method() !== "POST" || bootAccess) {
        return route.continue();
      }
      const response = await route.fetch();
      const body = await response.json();
      bootAccess = body.access;
      return route.fulfill({
        response,
        json: {
          ...body,
          access_expires_at: new Date(Date.now() + 5_000).toISOString(),
        },
      });
    });
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "My Dashboard" }),
    ).toBeVisible();
    await expect
      .poll(() => seen.some((entry) => entry.pathname === "/dashboard/events"))
      .toBe(true);
    // A late listing from the settings page may still land here; only the
    // refreshes and the dashboard call matter.
    const dashboardLoad = seen.filter(
      (entry) => entry.pathname !== "/authn/sessions/",
    );
    const dashboardAt = dashboardLoad.findIndex(
      (entry) => entry.pathname === "/dashboard/events",
    );
    expect(
      dashboardLoad.slice(0, dashboardAt).map((entry) => entry.pathname),
    ).toEqual(["/authn/refresh/", "/authn/refresh/"]);
    expect(bootAccess).toBeTruthy();
    expect(dashboardLoad[dashboardAt].auth).toMatch(/^Bearer \S+$/);
    expect(dashboardLoad[dashboardAt].auth).not.toBe(`Bearer ${bootAccess}`);
  });

  test("focus and visibility checks ask the API at most every 30 s, a server error keeps the session, and a 401 signs the browser out", async ({
    page,
  }) => {
    const runId = newRunId();
    await page.clock.install();
    // Counts the app's session checks as it starts them, and again once the
    // app has read each answer, so a check the 30 s gate skipped can be told
    // apart from one the app is still waiting on (which it would share rather
    // than repeat).
    await page.addInitScript(() => {
      window.__sessionChecks = 0;
      window.__sessionChecksRead = 0;
      const markRead = () => {
        window.__sessionChecksRead += 1;
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (new URL(url, window.location.href).pathname !== "/authn/session/") {
          return originalFetch(input, init);
        }
        window.__sessionChecks += 1;
        return originalFetch(input, init).then(
          (response) => {
            const readJson = response.json.bind(response);
            response.json = () => readJson().finally(markRead);
            return response;
          },
          (error) => {
            markRead();
            throw error;
          },
        );
      };
    });
    await registerAccountViaApi(
      page.request,
      `revalidate-${runId}@example.com`,
      "Vera",
      "Visible",
    );
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "My Dashboard" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Vera Visible", exact: true }),
    ).toBeVisible();

    // Waits until every check the app started has been answered and handled,
    // and returns how many it has made.
    async function settledChecks() {
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__sessionChecks - window.__sessionChecksRead,
          ),
        )
        .toBe(0);
      await flushPageTask(page);
      return page.evaluate(() => window.__sessionChecks);
    }

    async function checksAfter(kind) {
      await page.evaluate((eventKind) => {
        if (eventKind === "focus") window.dispatchEvent(new Event("focus"));
        else document.dispatchEvent(new Event("visibilitychange"));
      }, kind);
      await flushPageTask(page);
      return page.evaluate(() => window.__sessionChecks);
    }

    const sessionRoute = isApiPath("/authn/session/");
    await page.route(sessionRoute, (route) =>
      fulfillJson(route, 503, { detail: "Session check failed." }),
    );
    // Leave behind any check a focus event made while the page loaded.
    const loaded = await settledChecks();
    await page.clock.fastForward("00:31");

    const failedCheck = apiResponse(page, "/authn/session/", "GET");
    expect(await checksAfter("focus")).toBe(loaded + 1);
    expect((await failedCheck).status()).toBe(503);
    expect(await settledChecks()).toBe(loaded + 1);
    // Within 30 s neither event asks again, although no check is under way.
    expect(await checksAfter("visibilitychange")).toBe(loaded + 1);
    await page.clock.fastForward("00:25");
    expect(await checksAfter("focus")).toBe(loaded + 1);

    // The failed check left the browser signed in: the next page opens, and
    // a route change checks at once, whatever the interval.
    await page.unroute(sessionRoute);
    await openAccountMenu(page, "Vera Visible");
    const routeCheck = apiResponse(page, "/authn/session/", "GET");
    await page.getByRole("menuitem", { name: "Settings" }).click();
    expect((await routeCheck).status()).toBe(200);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(heading(page, "Account settings")).toBeVisible();
    expect(await settledChecks()).toBe(loaded + 2);

    // The session is revoked elsewhere (this context's refresh token is
    // logged out). Past 30 s a visibility change checks again; the API's 401
    // survives the client's refresh attempt and signs the browser out.
    const revoked = await page.request.post(`${BACKEND_URL}/authn/logout/`, {
      data: {},
    });
    expect(revoked.status()).toBe(204);
    await page.clock.fastForward("00:31");
    const revokedCheck = apiResponse(page, "/authn/session/", "GET");
    expect(await checksAfter("visibilitychange")).toBe(loaded + 3);
    expect((await revokedCheck).status()).toBe(401);
    await expect(page).toHaveURL(/\/login\?next=\/settings$/);
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();
  });
});

test.describe("Legacy sign-in routes", () => {
  test("old /sign-in and /sign-up addresses, with or without a sub-path, land on email sign-in", async ({
    page,
  }) => {
    for (const [legacy, target] of [
      ["/sign-in", "/login"],
      ["/sign-in/factor-one", "/login"],
      ["/sign-up", "/signup"],
      ["/sign-up/verify-email-address", "/signup"],
    ]) {
      await page.goto(legacy);
      await expect(page, legacy).toHaveURL(`${FRONTEND_URL}${target}`);
      await expect(heading(page, "Welcome to Releviz")).toBeVisible();
    }
  });
});
