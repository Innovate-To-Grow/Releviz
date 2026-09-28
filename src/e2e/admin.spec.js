const { expect, test } = require("@playwright/test");
const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BACKEND_URL,
  FRONTEND_URL,
  adminPasswordLogin,
  apiJson,
  createEvent,
  differentCode,
  expireResendCooldown,
  finalizeViaApi,
  freshResults,
  importRosterApi,
  latestEmailFor,
  latestVerificationCode,
  memberIdForEmail,
  newRunId,
  registerAccountViaApi,
  runDjangoJson,
  submitResponse,
} = require("./helpers/releviz");
const {
  XLSX_MIME,
  addPersonApi,
  tsv,
  xlsxBuffer,
} = require("./helpers/participants");

// The Django admin (Unfold) at BACKEND_URL/admin/. Every test signs in with
// accounts it seeds itself (a Django write of its own rows) and acts only on
// rows it created. Cookies are host-only for 127.0.0.1 and shared by the
// frontend and backend ports, so each identity gets its own browser context.

test.use({ viewport: { width: 1440, height: 900 } });

const STAFF_PASSWORD = "Admin-E2E-Pass-2468!";

// Creates members (with a verified primary email unless `verified: false`)
// and returns { email: memberId }. `password: null` leaves the account
// without a usable password, like one made by an email code.
function seedMembers(members) {
  return runDjangoJson(
    `
from apps.authn.models import ContactEmail, Member

created = {}
for spec in data["members"]:
    member = Member(
        first_name=spec["first"],
        last_name=spec["last"],
        is_staff=spec.get("staff", False),
        is_superuser=spec.get("superuser", False),
        is_active=spec.get("active", True),
        admin_apps=spec.get("apps", []),
    )
    if spec.get("password"):
        member.set_password(spec["password"])
    else:
        member.set_unusable_password()
    member.save()
    ContactEmail.objects.create(
        member=member,
        email_address=spec["email"],
        email_type="primary",
        verified=spec.get("verified", True),
    )
    created[spec["email"]] = str(member.pk)
print(json.dumps(created))
`,
    { members },
  );
}

// Reads fields of the member that owns `email`.
function memberState(email) {
  return runDjangoJson(
    `
from apps.authn.models import ContactEmail

member = ContactEmail.objects.select_related("member").get(
    email_address__iexact=data["email"]
).member
print(json.dumps({
    "id": str(member.pk),
    "first_name": member.first_name,
    "last_name": member.last_name,
    "is_active": member.is_active,
    "is_staff": member.is_staff,
    "admin_apps": member.admin_apps,
}))
`,
    { email },
  );
}

// Updates fields of this test's own member.
function updateMember(email, fields) {
  runDjangoJson(
    `
from apps.authn.models import ContactEmail

member = ContactEmail.objects.get(email_address__iexact=data["email"]).member
for name, value in data["fields"].items():
    setattr(member, name, value)
member.save()
print(json.dumps(True))
`,
    { email, fields },
  );
}

// Blocks the per-identity bucket of a durable rate-limit scope for one
// identity (this test's own email or token), so a throttled request can be
// exercised without spending the per-IP budget every test shares.
function blockIdentityBucket(scope, identity) {
  runDjangoJson(
    `
from datetime import timedelta

from django.utils import timezone

from apps.authn.models import AuthRateLimitBucket
from apps.authn.security.helpers import _key_hash, normalize_security_identity

now = timezone.now()
AuthRateLimitBucket.objects.update_or_create(
    scope=f'{data["scope"]}:identity',
    key_hash=_key_hash(
        data["scope"], "identity", normalize_security_identity(data["identity"])
    ),
    defaults={"window_started_at": now, "blocked_until": now + timedelta(minutes=30)},
)
print(json.dumps(True))
`,
    { scope, identity },
  );
}

async function openAdminLogin(page, next = "/admin/") {
  await page.goto(
    `${BACKEND_URL}/admin/login/?next=${encodeURIComponent(next)}`,
  );
  await expect(page.locator(".login-box")).toBeVisible();
}

// The password form behind "Sign in with password instead".
async function submitAdminPassword(page, email, password) {
  await page
    .getByRole("link", { name: "Sign in with password instead" })
    .click();
  await expect(page.getByText("Sign in with password")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

// The first (email) step of the default admin sign-in.
async function submitAdminEmail(page, email) {
  await expect(page.getByText("Welcome back to")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();
}

async function submitAdminCode(page, code) {
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
}

// Unfold's user menu sits at the foot of the sidebar under the member's name.
async function adminLogout(page, displayName) {
  const trigger = page
    .locator("#nav-sidebar-apps")
    .locator("xpath=..")
    .getByText(displayName, { exact: true });
  const logout = page.getByRole("button", { name: /Log out/ });
  // Alpine wires the menu up shortly after the page loads, and a click that
  // lands before that is lost, so open it until the button shows.
  await expect(async () => {
    if (!(await logout.isVisible())) await trigger.click();
    await expect(logout).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await logout.click();
}

function loginError(page, text) {
  return page.locator(".login-message--error").filter({ hasText: text });
}

function loginInfo(page, text) {
  return page.locator(".login-message--info").filter({ hasText: text });
}

// Selects changelist rows by primary key and runs a bulk action.
async function runAdminAction(page, ids, action) {
  for (const id of ids) {
    await page.locator(`input[name="_selected_action"][value="${id}"]`).check();
  }
  await page
    .getByRole("combobox", { name: "Select action to run" })
    .selectOption(action);
  await page.getByRole("button", { name: "Run" }).click();
}

// The typed-confirmation step of an admin save, delete or bulk action: the
// confirm button stays disabled until the model's verbose name is typed.
async function confirmTyped(page, word, typed = word) {
  const input = page.getByLabel(`Type "${word}" to confirm:`);
  const button = page.locator("#confirm-btn, #confirm-send-btn");
  await expect(button).toBeDisabled();
  // The listener that enables the button is an inline script at the end of
  // the page; typing again covers input that landed before it ran.
  await expect(async () => {
    await input.fill(typed);
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await button.click();
}

// A Django admin message (success, warning or error) with this text.
function adminMessage(page, text) {
  return page.locator("#main").getByText(text, { exact: true });
}

test.describe("Releviz admin", () => {
  test("renders the themed admin login and authenticated sidebar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BACKEND_URL}/admin/login/?next=/admin/`);
    await expect(page.locator(".login-box")).toBeVisible();
    await expect(page.locator("img.login-logo")).toHaveAttribute(
      "src",
      /releviz-mark\.png/,
    );
    await expect(page.getByText("Releviz Admin")).toBeVisible();
    // The login page opens on the email-code step; the password form lives
    // behind the alternate-mode link.
    await page
      .getByRole("link", { name: "Sign in with password instead" })
      .click();
    await page.locator("#id_email").fill(ADMIN_EMAIL);
    await page.locator("#id_password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin\/$/);
    await expect(
      page
        .locator("#nav-sidebar-apps")
        .getByRole("heading", { name: "Scheduling" }),
    ).toBeVisible();
    await expect(
      page
        .locator("#nav-sidebar-apps")
        .getByRole("heading", { name: "Members & Authentication" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-admin-theme-choice="dark"]').first(),
    ).toBeAttached();

    const sidebar = page.locator("#nav-sidebar-apps");
    const activeSidebarLinks = sidebar.locator("a.active");

    await sidebar.getByRole("link", { name: "AWS SES Providers" }).click();
    await expect(page).toHaveURL(/\/admin\/mail\/emailproviderconfig\/$/);
    await expect(activeSidebarLinks).toHaveCount(1);
    await expect(activeSidebarLinks).toHaveText("AWS SES Providers");

    const activeTabs = page.locator("#tabs-items a.active");
    await page
      .locator("#tabs-items")
      .getByRole("link", { name: "Email Logs" })
      .click();
    await expect(page).toHaveURL(/\/admin\/mail\/emailmessagelog\/$/);
    await expect(activeSidebarLinks).toHaveCount(1);
    await expect(activeSidebarLinks).toHaveText("AWS SES Providers");
    await expect(activeTabs).toHaveText("Email Logs");
  });
});

test.describe("Admin sign-in", () => {
  test("a staff member signs in with an emailed code: resend waits for the cooldown and replaces the code", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `admin-code-${runId}@example.com`;
    seedMembers([
      {
        email,
        first: "Esme",
        last: "Code",
        staff: true,
        password: STAFF_PASSWORD,
      },
    ]);

    await openAdminLogin(page, "/admin/");
    const requestedAt = Date.now() - 1000;
    await submitAdminEmail(page, email);
    await expect(page.getByText("Enter verification code")).toBeVisible();
    await expect(page.locator(".login-email-hint")).toHaveText(
      `We sent a 6-digit code to ${email}`,
    );
    await expect(
      loginInfo(page, "A verification code has been sent to your email."),
    ).toBeVisible();
    const firstCode = await latestVerificationCode(
      email,
      requestedAt,
      "admin_login",
    );

    // A resend inside the 60 s cooldown is refused.
    await page.getByRole("button", { name: "Resend code" }).click();
    await expect(
      loginInfo(page, "Please wait before requesting another code."),
    ).toBeVisible();

    // Once the cooldown has passed, a resend sends a new code and retires
    // the first one.
    expect(expireResendCooldown(email)).toBe(1);
    const resentAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Resend code" }).click();
    await expect(
      loginInfo(page, "A new verification code has been sent."),
    ).toBeVisible();
    const secondCode = await latestVerificationCode(
      email,
      resentAt,
      "admin_login",
      { notCode: firstCode },
    );

    await submitAdminCode(page, firstCode);
    await expect(
      loginError(page, "Verification code is invalid or has expired."),
    ).toBeVisible();
    await submitAdminCode(page, differentCode(secondCode));
    await expect(
      loginError(page, "Verification code is invalid or has expired."),
    ).toBeVisible();

    await submitAdminCode(page, secondCode);
    await expect(page).toHaveURL(/\/admin\/$/);
    await expect(page.getByText("Esme Code", { exact: true })).toBeVisible();

    // After signing out, "Use a different email" sets the remembered
    // account aside and returns to the email step.
    await adminLogout(page, "Esme Code");
    await openAdminLogin(page, "/admin/");
    await page.getByRole("link", { name: "Use a different email" }).click();
    await expect(page.getByText("Welcome back to")).toBeVisible();
    await expect(page.locator(".login-last-admin")).toHaveCount(0);
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page).toHaveURL(/[?&]different=1/);
  });

  test("the remembered admin signs in with a password or a code without typing an email, and logging out ends the session", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `admin-remembered-${runId}@example.com`;
    seedMembers([
      {
        email,
        first: "Remy",
        last: "Remembered",
        staff: true,
        password: STAFF_PASSWORD,
      },
    ]);
    await adminPasswordLogin(page, { email, password: STAFF_PASSWORD });

    // Logging out ends the admin session; the signed last-admin cookie
    // stays, so the next visit offers the remembered account.
    await adminLogout(page, "Remy Remembered");
    await page.goto(`${BACKEND_URL}/admin/`);
    await expect(page).toHaveURL(/\/admin\/login\/\?next=\/admin\/$/);
    const remembered = page.locator(".login-last-admin");
    await expect(remembered).toContainText("Last signed in");
    await expect(remembered).toContainText("Remy Remembered");
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send verification code instead" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Use a different email" }),
    ).toBeVisible();

    await page.getByLabel("Password").fill("Not-The-Password-1!");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(loginError(page, "Invalid password.")).toBeVisible();

    // The code goes to the remembered account's primary email, which the
    // page names by the member's name only.
    const requestedAt = Date.now() - 1000;
    await page
      .getByRole("button", { name: "Send verification code instead" })
      .click();
    await expect(page.getByText("Enter verification code")).toBeVisible();
    await expect(page.locator(".login-email-hint")).toHaveText(
      "We sent a 6-digit code to Remy Remembered.",
    );
    await expect(
      loginInfo(page, "A verification code has been sent to Remy Remembered."),
    ).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);
    const code = await latestVerificationCode(
      email,
      requestedAt,
      "admin_login",
    );
    await submitAdminCode(page, code);
    await expect(page).toHaveURL(/\/admin\/$/);

    await adminLogout(page, "Remy Remembered");
    await openAdminLogin(page, "/admin/");
    await expect(remembered).toContainText("Remy Remembered");
    await page.getByLabel("Password").fill(STAFF_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin\/$/);
  });

  test("wrong passwords, non-staff and inactive accounts are refused at every admin sign-in step", async ({
    page,
  }) => {
    const runId = newRunId();
    const staff = `admin-refuse-staff-${runId}@example.com`;
    const member = `admin-refuse-member-${runId}@example.com`;
    const inactive = `admin-refuse-inactive-${runId}@example.com`;
    const demoted = `admin-refuse-demoted-${runId}@example.com`;
    seedMembers([
      {
        email: staff,
        first: "Stan",
        last: "Staff",
        staff: true,
        password: STAFF_PASSWORD,
      },
      {
        email: member,
        first: "Mona",
        last: "Member",
        password: STAFF_PASSWORD,
      },
      {
        email: inactive,
        first: "Ivan",
        last: "Inactive",
        staff: true,
        active: false,
        password: STAFF_PASSWORD,
      },
      { email: demoted, first: "Dora", last: "Demoted", staff: true },
    ]);

    // Password sign-in names no reason: a wrong password, a non-staff
    // account and an inactive staff account read the same.
    for (const [email, password] of [
      [staff, "Wrong-Password-1357!"],
      [member, STAFF_PASSWORD],
      [inactive, STAFF_PASSWORD],
      [`admin-refuse-nobody-${runId}@example.com`, STAFF_PASSWORD],
    ]) {
      await openAdminLogin(page);
      await submitAdminPassword(page, email, password);
      await expect(
        loginError(page, "Invalid email or password."),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/admin\/login\//);
    }

    // The email step sends no code to anyone who could not sign in.
    for (const email of [member, inactive]) {
      await openAdminLogin(page);
      await submitAdminEmail(page, email);
      await expect(
        loginError(page, "Unable to send verification code."),
      ).toBeVisible();
      await expect(page.getByText("Welcome back to")).toBeVisible();
    }

    // Losing staff status between the two steps stops the code from
    // signing in.
    await openAdminLogin(page);
    const requestedAt = Date.now() - 1000;
    await submitAdminEmail(page, demoted);
    await expect(page.getByText("Enter verification code")).toBeVisible();
    const code = await latestVerificationCode(
      demoted,
      requestedAt,
      "admin_login",
    );
    updateMember(demoted, { is_staff: false });
    await submitAdminCode(page, code);
    await expect(
      loginError(page, "You do not have access to the admin panel."),
    ).toBeVisible();
    await expect(page.getByText("Welcome back to")).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login\//);
  });

  test("a throttled admin password sign-in answers 429 with Retry-After, even for the right password", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `admin-throttle-${runId}@example.com`;
    seedMembers([
      {
        email,
        first: "Tara",
        last: "Throttle",
        staff: true,
        password: STAFF_PASSWORD,
      },
    ]);
    // The E2E limits are far above anything a test can spend, so block
    // this account's own admin_login bucket instead.
    blockIdentityBucket("admin_login", email);

    await openAdminLogin(page);
    const refused = page.waitForResponse(
      (response) =>
        response.url().startsWith(`${BACKEND_URL}/admin/login/`) &&
        response.request().method() === "POST",
    );
    await submitAdminPassword(page, email, STAFF_PASSWORD);
    const response = await refused;
    expect(response.status()).toBe(429);
    const retryAfter = Number(response.headers()["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30 * 60);
    await expect(
      loginError(page, "Too many login attempts. Please try again later."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login\//);
  });

  test("the admin login honours a same-site next, ignores an unsafe one, and sends a demoted session back to sign in", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `admin-next-${runId}@example.com`;
    seedMembers([
      {
        email,
        first: "Nell",
        last: "Next",
        staff: true,
        password: STAFF_PASSWORD,
      },
    ]);

    await openAdminLogin(page, "https://evil.example.com/steal");
    await submitAdminPassword(page, email, STAFF_PASSWORD);
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/`);

    // Already signed in: the login page forwards to a safe next at once.
    await page.goto(
      `${BACKEND_URL}/admin/login/?next=${encodeURIComponent("/admin/password_change/")}`,
    );
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/password_change/`);
    await page.goto(
      `${BACKEND_URL}/admin/login/?next=${encodeURIComponent("//evil.example.com/")}`,
    );
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/`);

    // A session whose member is no longer staff is sent to the login page,
    // which renders instead of forwarding.
    updateMember(email, { is_staff: false });
    await page.goto(`${BACKEND_URL}/admin/`);
    await expect(page).toHaveURL(/\/admin\/login\/\?next=\/admin\/$/);
    await expect(page.getByText("Welcome back to")).toBeVisible();
    await expect(page.locator(".login-last-admin")).toHaveCount(0);
  });

  test("switching to password sign-in keeps every query parameter of a deep link", async ({
    page,
  }) => {
    // The mode-switch links must carry the whole destination, including the
    // parts after its first "&".
    const runId = newRunId();
    const email = `admin-deeplink-${runId}@example.com`;
    seedMembers([
      {
        email,
        first: "Dee",
        last: "Link",
        staff: true,
        apps: ["authn"],
        password: STAFF_PASSWORD,
      },
    ]);
    const deepLink = `${BACKEND_URL}/admin/authn/member/?is_staff__exact=1&q=${runId}`;
    await page.goto(deepLink);
    await expect(page).toHaveURL(/\/admin\/login\/\?next=/);
    await submitAdminPassword(page, email, STAFF_PASSWORD);
    await expect(page).toHaveURL(/\/admin\/authn\/member\/\?/);
    expect(page.url()).toBe(deepLink);
    await expect(page.locator("#result_list tbody tr")).toHaveCount(1);
  });
});

// The frontend's error alert (Next.js also renders an empty route-announcer
// alert, so match on the text).
function frontendAlert(page, text) {
  return page.getByRole("alert").filter({ hasText: text });
}

async function impersonateApi(request, token) {
  const response = await request.post(
    `${BACKEND_URL}/authn/impersonate-login/`,
    {
      data: { token },
    },
  );
  return { status: response.status(), payload: await response.json() };
}

test.describe("Admin impersonation", () => {
  test("Login as Member opens the member's dashboard in a new tab, and the one-time token cannot be reused", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `impersonated-${runId}@example.com`;
    const ids = seedMembers([{ email, first: "Ivy", last: "Impersonated" }]);
    await adminPasswordLogin(page);

    await page.goto(`${BACKEND_URL}/admin/authn/member/${ids[email]}/change/`);
    const link = page.getByTitle("Login as this member on the frontend");
    await expect(link).toHaveText(/Login as Member/);
    await expect(link).toHaveAttribute("target", "_blank");

    // The admin view mints a token and redirects to the frontend with the
    // token in the fragment, which the frontend exchanges and then strips.
    // (The redirect itself is read in the next test.)
    const popupOpened = page.waitForEvent("popup");
    await link.click();
    const popup = await popupOpened;
    await expect(popup).toHaveURL(`${FRONTEND_URL}/dashboard`);
    await expect(
      popup.getByRole("heading", { level: 1, name: "My Dashboard" }),
    ).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Ivy Impersonated", exact: true }),
    ).toBeVisible();

    // Exactly one token was minted, by the signed-in admin, and it is spent.
    const minted = runDjangoJson(
      `
from apps.authn.models import ImpersonationToken

print(json.dumps([
    {"token": token.token, "used": token.is_used, "createdBy": str(token.created_by_id)}
    for token in ImpersonationToken.objects.filter(member_id=data["id"])
]))
`,
      { id: ids[email] },
    );
    expect(minted).toEqual([
      {
        token: expect.any(String),
        used: true,
        createdBy: memberIdForEmail(ADMIN_EMAIL),
      },
    ]);
    const [{ token }] = minted;
    const location = `${FRONTEND_URL}/impersonate-login#token=${token}`;
    expect(await impersonateApi(request, token)).toEqual({
      status: 400,
      payload: { detail: "This impersonation link has already been used." },
    });

    const visitor = await browser.newContext();
    try {
      const visitorPage = await visitor.newPage();
      await visitorPage.goto("/impersonate-login");
      await expect(
        frontendAlert(visitorPage, "No impersonation token provided."),
      ).toBeVisible();
      await expect(
        visitorPage.getByRole("link", { name: "Go to Login" }),
      ).toHaveAttribute("href", "/login");

      // The fragment only reaches the page on a fresh document load.
      await visitorPage.goto("about:blank");
      await visitorPage.goto(location);
      await expect(
        frontendAlert(
          visitorPage,
          "This impersonation link is invalid or has expired.",
        ),
      ).toBeVisible();
      expect(visitorPage.url()).toBe(`${FRONTEND_URL}/impersonate-login`);
    } finally {
      await visitor.close();
    }
  });

  test("impersonation refuses staff and superuser accounts, and unknown, empty or expired tokens", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const staffEmail = `impersonate-staff-${runId}@example.com`;
    const memberEmail = `impersonate-expired-${runId}@example.com`;
    const ids = seedMembers([
      { email: staffEmail, first: "Stella", last: "Staff", staff: true },
      { email: memberEmail, first: "Eli", last: "Expired" },
    ]);
    await adminPasswordLogin(page);

    for (const memberId of [ids[staffEmail], memberIdForEmail(ADMIN_EMAIL)]) {
      await page.goto(`${BACKEND_URL}/admin/authn/member/${memberId}/change/`);
      await expect(page.locator("#content")).toBeVisible();
      await expect(
        page.getByTitle("Login as this member on the frontend"),
      ).toHaveCount(0);
      const refused = await page.goto(
        `${BACKEND_URL}/admin/authn/member/${memberId}/impersonate/`,
      );
      expect(refused.status()).toBe(403);
      await expect(
        page.getByText("Staff and superuser accounts cannot be impersonated."),
      ).toBeVisible();
    }

    // Read the redirect without following it, then let the token lapse.
    const minted = await page.request.get(
      `${BACKEND_URL}/admin/authn/member/${ids[memberEmail]}/impersonate/`,
      { maxRedirects: 0 },
    );
    expect(minted.status()).toBe(302);
    const location = minted.headers()["location"];
    expect(location).toMatch(
      new RegExp(`^${FRONTEND_URL}/impersonate-login#token=[\\w-]{40,}$`),
    );
    const token = new URLSearchParams(location.split("#")[1]).get("token");
    runDjangoJson(
      `
from datetime import timedelta

from django.utils import timezone

from apps.authn.models import ImpersonationToken

updated = ImpersonationToken.objects.filter(token=data["token"]).update(
    expires_at=timezone.now() - timedelta(minutes=1)
)
print(json.dumps(updated))
`,
      { token },
    );
    expect(await impersonateApi(request, token)).toEqual({
      status: 400,
      payload: { detail: "This impersonation link has expired." },
    });
    expect(await impersonateApi(request, `unknown-${runId}`)).toEqual({
      status: 400,
      payload: { detail: "Invalid impersonation link." },
    });
    expect(await impersonateApi(request, "   ")).toEqual({
      status: 400,
      payload: { detail: "Token is required." },
    });
  });
});

const INVITE_LINK = /https?:\/\/[^\s"<>]+\/authn\/invite\/[\w-]+\//;

async function invitationLink(email, afterMs, notLink) {
  const body = await latestEmailFor(email, afterMs, (message) => {
    const link = message.match(INVITE_LINK)?.[0];
    return Boolean(link) && link !== notLink;
  });
  expect(body).toMatch(/^Subject: You're invited to join Releviz Admin$/m);
  return body.match(INVITE_LINK)[0];
}

// Adds an admin invitation through the add form and its typed confirmation;
// returns the emailed acceptance link.
async function createAdminInvitation(page, email, message, notLink) {
  await page.goto(`${BACKEND_URL}/admin/authn/admininvitation/add/`);
  await page.locator("#id_email").fill(email);
  await page.locator("#id_message").fill(message);
  const sentAt = Date.now() - 1000;
  await page.locator('button[name="_save"]').click();
  await expect(page).toHaveTitle(/Confirm Adding Admin Invitation/);
  const diff = page.locator("table").first();
  await expect(diff.getByRole("row", { name: `Email ${email}` })).toBeVisible();
  await expect(diff.getByRole("row", { name: "Role Admin" })).toBeVisible();
  if (message) {
    await expect(
      diff.getByRole("row", { name: `Message ${message}` }),
    ).toBeVisible();
  }
  // The confirmation word is matched case-insensitively.
  await confirmTyped(page, "Admin Invitation", "admin invitation");
  await expect(
    adminMessage(page, `Invitation created and sent for ${email}.`),
  ).toBeVisible();
  return invitationLink(email, sentAt, notLink);
}

function seedInvitations(invitations) {
  return runDjangoJson(
    `
from datetime import timedelta

from django.utils import timezone

from apps.authn.models import AdminInvitation

created = {}
for spec in data["invitations"]:
    invitation = AdminInvitation.objects.create(
        email=spec["email"],
        token=AdminInvitation.generate_token(),
        expires_at=timezone.now() + timedelta(days=spec["days"]),
    )
    created[spec["email"]] = {"id": str(invitation.pk), "token": invitation.token}
print(json.dumps(created))
`,
    { invitations },
  );
}

// { email: [status, ...] } for this test's invitations, statuses sorted.
function invitationStatuses(emails) {
  return runDjangoJson(
    `
from apps.authn.models import AdminInvitation

statuses = {email: [] for email in data["emails"]}
for invitation in AdminInvitation.objects.filter(email__in=data["emails"]):
    statuses[invitation.email].append(invitation.status)
print(json.dumps({email: sorted(found) for email, found in statuses.items()}))
`,
    { emails },
  );
}

async function expectInvalidInvitation(page, link) {
  const response = await page.goto(link);
  expect(response.status()).toBe(400);
  await expect(page).toHaveTitle(/Invalid Invitation/);
  await expect(
    page.getByText(
      "This invitation link is invalid, has expired, or has already been used.",
    ),
  ).toBeVisible();
}

test.describe("Admin invitations", () => {
  test("an invitation creates a staff account after the password checks, and a newer invitation cancels the older link", async ({
    browser,
    page,
  }) => {
    const runId = newRunId();
    const email = `invited-staff-${runId}@example.com`;
    const password = "Corr3ct-Horse-Battery!";
    await adminPasswordLogin(page);
    const firstLink = await createAdminInvitation(page, email, "First try");
    const secondLink = await createAdminInvitation(
      page,
      email,
      "Welcome aboard",
      firstLink,
    );
    expect(secondLink.startsWith(`${BACKEND_URL}/authn/invite/`)).toBe(true);

    await page.goto(
      `${BACKEND_URL}/admin/authn/admininvitation/?q=${encodeURIComponent(email)}`,
    );
    const rows = page.locator("#result_list tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Cancelled" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Pending" })).toHaveCount(1);

    const inviteeContext = await browser.newContext();
    try {
      const invitee = await inviteeContext.newPage();
      await expectInvalidInvitation(invitee, firstLink);
      await expectInvalidInvitation(
        invitee,
        `${BACKEND_URL}/authn/invite/not-a-token-${runId}/`,
      );

      await invitee.goto(secondLink);
      await expect(invitee).toHaveTitle(/Accept Invitation/);
      await expect(invitee.getByText("You're invited to join")).toBeVisible();
      await expect(invitee.locator("#id_email")).toHaveValue(email);
      await expect(invitee.locator("#id_email")).toBeDisabled();

      await invitee.locator("#id_first_name").fill("<b>Ines</b>");
      await invitee.locator("#id_last_name").fill("Staff");
      await invitee.locator("#id_password1").fill(password);
      await invitee.locator("#id_password2").fill("Different-Horse-9!");
      await invitee.getByRole("button", { name: /Create account/ }).click();
      await expect(
        invitee.getByText("HTML tags are not allowed."),
      ).toBeVisible();
      await expect(invitee.getByText("Passwords do not match.")).toBeVisible();

      // Django's password validators run too. Password inputs are not
      // re-rendered after a failed POST.
      await invitee.locator("#id_first_name").fill("Ines");
      await invitee.locator("#id_password1").fill("password1");
      await invitee.locator("#id_password2").fill("password1");
      await invitee.getByRole("button", { name: /Create account/ }).click();
      await expect(
        invitee.getByText("This password is too common."),
      ).toBeVisible();
      expect(invitationStatuses([email])).toEqual({
        [email]: ["cancelled", "pending"],
      });

      await invitee.locator("#id_password1").fill(password);
      await invitee.locator("#id_password2").fill(password);
      await invitee.getByRole("button", { name: /Create account/ }).click();
      await expect(
        invitee.getByRole("heading", { name: "Account Created" }),
      ).toBeVisible();
      await expect(
        invitee.getByRole("link", { name: /Log in to admin/ }),
      ).toHaveAttribute("href", "/admin/login/");
      expect(memberState(email)).toMatchObject({
        first_name: "Ines",
        last_name: "Staff",
        is_staff: true,
        is_active: true,
        admin_apps: [],
      });

      // The link is spent, and the new account signs in with its password.
      await expectInvalidInvitation(invitee, secondLink);
      await adminPasswordLogin(invitee, { email, password });
      await expect(
        invitee.getByText("Ines Staff", { exact: true }),
      ).toBeVisible();
    } finally {
      await inviteeContext.close();
    }
  });

  test("an invitation grants admin access to an existing account that could not request an admin code before", async ({
    browser,
    page,
  }) => {
    const runId = newRunId();
    const email = `invited-existing-${runId}@example.com`;
    seedMembers([{ email, first: "Gus", last: "Grant" }]);
    const granteeContext = await browser.newContext();
    try {
      const grantee = await granteeContext.newPage();
      await openAdminLogin(grantee);
      await submitAdminEmail(grantee, email);
      await expect(
        loginError(grantee, "Unable to send verification code."),
      ).toBeVisible();

      await adminPasswordLogin(page);
      const link = await createAdminInvitation(page, email, "");

      await grantee.goto(link);
      await expect(
        grantee.getByRole("heading", { name: "Confirm Admin Access" }),
      ).toBeVisible();
      await expect(
        grantee.getByText(`An account for ${email} already exists.`),
      ).toBeVisible();
      expect(memberState(email).is_staff).toBe(false);
      await grantee.getByRole("button", { name: /Grant admin access/ }).click();
      await expect(
        grantee.getByRole("heading", { name: "Permissions Updated" }),
      ).toBeVisible();
      await expect(
        grantee.getByText(
          "Your admin permissions have been granted. You can now log in.",
        ),
      ).toBeVisible();
      expect(memberState(email).is_staff).toBe(true);
      expect(invitationStatuses([email])).toEqual({ [email]: ["accepted"] });

      // The same account can now request an admin code.
      await openAdminLogin(grantee);
      await submitAdminEmail(grantee, email);
      await expect(grantee.getByText("Enter verification code")).toBeVisible();
    } finally {
      await granteeContext.close();
    }
  });

  test("resend and cancel actions act only on valid invitations, and a throttled accept answers 429", async ({
    browser,
    page,
  }) => {
    const runId = newRunId();
    const pending = `invite-resend-${runId}@example.com`;
    const expired = `invite-expired-${runId}@example.com`;
    const cancelled = `invite-cancel-${runId}@example.com`;
    const invitations = seedInvitations([
      { email: pending, days: 7 },
      { email: expired, days: -1 },
      { email: cancelled, days: 7 },
    ]);
    const linkFor = (email) =>
      `${BACKEND_URL}/authn/invite/${invitations[email].token}/`;

    await adminPasswordLogin(page);
    const changelist = `${BACKEND_URL}/admin/authn/admininvitation/?q=${runId}`;
    await page.goto(changelist);
    await expect(page.locator("#result_list tbody tr")).toHaveCount(3);
    const resentAt = Date.now() - 1000;
    await runAdminAction(
      page,
      [invitations[pending].id, invitations[expired].id],
      "resend_invitations",
    );
    await expect(page).toHaveTitle(
      /Confirm Action: Resend selected pending invitations/,
    );
    await expect(
      page.getByText("This will affect 2 Admin Invitations."),
    ).toBeVisible();
    await confirmTyped(page, "Admin Invitation");
    await expect(
      adminMessage(
        page,
        "Skipped 1 invalid, expired, or already-used invitation(s).",
      ),
    ).toBeVisible();
    await expect(
      adminMessage(page, "Resent 1 invitation email(s)."),
    ).toBeVisible();
    expect(await invitationLink(pending, resentAt)).toBe(linkFor(pending));

    // The resend marked the lapsed invitation expired, so cancelling it
    // together with a pending one cancels only the pending one.
    await page.goto(changelist);
    await runAdminAction(
      page,
      [invitations[cancelled].id, invitations[expired].id],
      "cancel_invitations",
    );
    await expect(page).toHaveTitle(
      /Confirm Action: Cancel selected invitations/,
    );
    await expect(
      page.getByText("This will affect 2 Admin Invitations."),
    ).toBeVisible();
    await confirmTyped(page, "Admin Invitation");
    await expect(
      adminMessage(page, "Cancelled 1 invitation(s)."),
    ).toBeVisible();
    expect(invitationStatuses([pending, expired, cancelled])).toEqual({
      [pending]: ["pending"],
      [expired]: ["expired"],
      [cancelled]: ["cancelled"],
    });

    const inviteeContext = await browser.newContext();
    try {
      const invitee = await inviteeContext.newPage();
      await expectInvalidInvitation(invitee, linkFor(expired));
      await expectInvalidInvitation(invitee, linkFor(cancelled));

      // Accepting is rate limited per invitation token.
      blockIdentityBucket(
        "admin_invitation_accept",
        invitations[pending].token,
      );
      await invitee.goto(linkFor(pending));
      await invitee.locator("#id_first_name").fill("Rhea");
      await invitee.locator("#id_last_name").fill("Resent");
      await invitee.locator("#id_password1").fill("Corr3ct-Horse-Battery!");
      await invitee.locator("#id_password2").fill("Corr3ct-Horse-Battery!");
      const refused = invitee.waitForResponse(
        (response) =>
          response.url() === linkFor(pending) &&
          response.request().method() === "POST",
      );
      await invitee.getByRole("button", { name: /Create account/ }).click();
      const response = await refused;
      expect(response.status()).toBe(429);
      expect(Number(response.headers()["retry-after"])).toBeGreaterThan(0);
      await expect(
        invitee.getByText("Too many attempts. Please try again later."),
      ).toBeVisible();
      expect(invitationStatuses([pending])).toEqual({ [pending]: ["pending"] });
    } finally {
      await inviteeContext.close();
    }
  });
});

// Rows of a downloaded workbook's sheet (the named one, or the active one).
// openpyxl insists on an .xlsx name, so the download is saved under one.
async function readWorkbook(download, sheet = null) {
  const filePath = test.info().outputPath(`${newRunId()}.xlsx`);
  await download.saveAs(filePath);
  return runDjangoJson(
    `
from openpyxl import load_workbook

workbook = load_workbook(data["path"], read_only=True, data_only=True)
worksheet = workbook[data["sheet"]] if data["sheet"] else workbook.active
rows = [["" if value is None else str(value) for value in row] for row in worksheet.iter_rows(values_only=True)]
print(json.dumps(rows))
`,
    { path: filePath, sheet },
  );
}

function memberImportWorkbook(
  rows,
  header = ["First Name", "Last Name", "Primary Email", "Primary Verified"],
) {
  return {
    name: "members.xlsx",
    mimeType: XLSX_MIME,
    buffer: xlsxBuffer([{ name: "Members", rows: [header, ...rows] }]),
  };
}

async function startMemberImport(page, file, { updateExisting = false } = {}) {
  await page.locator("#id_excel_file").setInputFiles(file);
  await page.getByLabel("Update Existing Members").setChecked(updateExisting);
  await page.getByRole("button", { name: /Start Import/ }).click();
}

test.describe("Admin typed confirmation", () => {
  test("a change waits for the typed model name, shows the diff, and a wrong word, cancel or stale token saves nothing", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `confirm-change-${runId}@example.com`;
    const ids = seedMembers([
      { email, first: "Cora", last: `Confirm${runId}` },
    ]);
    const changeUrl = `${BACKEND_URL}/admin/authn/member/${ids[email]}/change/`;
    await adminPasswordLogin(page);

    const submitRename = async (firstName) => {
      await page.goto(changeUrl);
      await page.locator("#id_first_name").fill(firstName);
      await page.locator('button[name="_save"]').click();
      await expect(page).toHaveURL(/\/admin\/authn\/member\/confirm-change\/$/);
      await expect(page).toHaveTitle(/Confirm Changing user/);
    };

    await submitRename("Coral");
    const diff = page.locator("table").first();
    await expect(diff.getByRole("columnheader")).toHaveText([
      "Field",
      "Old Value",
      "New Value",
    ]);
    await expect(diff.locator("tbody tr")).toHaveCount(1);
    await expect(
      diff.getByRole("row", { name: "First name Cora Coral" }),
    ).toBeVisible();

    // The button stays disabled for a partial word; the server also rejects
    // a wrong word submitted anyway.
    const input = page.getByLabel('Type "user" to confirm:');
    const confirmButton = page.locator("#confirm-btn");
    await input.fill("user");
    await expect(confirmButton).toBeEnabled();
    await input.fill("use");
    await expect(confirmButton).toBeDisabled();
    // Re-enable the button by hand to post the wrong word anyway.
    await confirmButton.evaluate((button) => {
      button.disabled = false;
    });
    await confirmButton.click();
    await expect(
      adminMessage(page, 'Please type "user" exactly to confirm.'),
    ).toBeVisible();
    await expect(page).toHaveTitle(/Confirm Changing user/);
    expect(memberState(email).first_name).toBe("Cora");

    // Cancel returns to the change page without saving.
    await page.getByRole("link", { name: /Cancel/ }).click();
    await expect(page).toHaveURL(changeUrl);
    await expect(page.locator("#id_first_name")).toHaveValue("Cora");

    // A confirmation posted with another token is refused and forgotten.
    await submitRename("Coralie");
    await page
      .locator('#confirm-change-form input[name="token"]')
      .evaluate((token) => {
        token.value = "00000000-0000-0000-0000-000000000000";
      });
    await confirmTyped(page, "user");
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/authn/member/`);
    await expect(
      adminMessage(page, "Invalid confirmation token. Please start over."),
    ).toBeVisible();
    await page.goto(`${BACKEND_URL}/admin/authn/member/confirm-change/`);
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/authn/member/`);
    await expect(
      adminMessage(page, "No pending change found. Please try again."),
    ).toBeVisible();
    expect(memberState(email).first_name).toBe("Cora");

    // The word is matched case-insensitively.
    await submitRename("Coral");
    await confirmTyped(page, "user", "USER");
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/authn/member/`);
    expect(memberState(email).first_name).toBe("Coral");

    // Saving without a change needs no confirmation.
    await page.goto(changeUrl);
    await page.locator('button[name="_save"]').click();
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/authn/member/`);
    await expect(page.locator("#main")).toContainText(
      "was changed successfully",
    );
  });

  test("deleting a record and running a bulk action both ask for the typed model name", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `confirm-action-${runId}@example.com`;
    const invitationEmail = `confirm-delete-${runId}@example.com`;
    const ids = seedMembers([{ email, first: "Dex", last: `Action${runId}` }]);
    const invitation = seedInvitations([{ email: invitationEmail, days: 7 }])[
      invitationEmail
    ];
    await adminPasswordLogin(page);

    // The bulk-action confirmation keeps the selection in the session; a
    // direct visit without one is turned away.
    await page.goto(`${BACKEND_URL}/admin/authn/member/confirm-action/`);
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/authn/member/`);
    await expect(
      adminMessage(page, "No pending action found. Please try again."),
    ).toBeVisible();

    await page.goto(
      `${BACKEND_URL}/admin/authn/member/?q=${encodeURIComponent(email)}`,
    );
    await runAdminAction(page, [ids[email]], "deactivate_members");
    await expect(page).toHaveTitle(
      /Confirm Action: Deactivate selected members/,
    );
    await expect(page.getByText("This will affect 1 users.")).toBeVisible();
    await expect(
      page.getByRole("row", { name: "Items affected 1 users" }),
    ).toBeVisible();
    await expect(page.getByRole("row", { name: "Model user" })).toBeVisible();
    await page.getByRole("link", { name: /Cancel/ }).click();
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/authn/member/`);
    expect(memberState(email).is_active).toBe(true);

    // Django's own "Are you sure?" page leads to the typed confirmation,
    // which lists the record's current values.
    await page.goto(
      `${BACKEND_URL}/admin/authn/admininvitation/${invitation.id}/delete/`,
    );
    await page.getByRole("button", { name: /Yes, I.m sure/ }).click();
    await expect(page).toHaveURL(
      /\/admin\/authn\/admininvitation\/confirm-change\/$/,
    );
    await expect(page).toHaveTitle(/Confirm Deleting Admin Invitation/);
    const diff = page.locator("table").first();
    await expect(diff.getByRole("columnheader")).toHaveText([
      "Field",
      "Current Value",
    ]);
    await expect(
      diff.getByRole("row", { name: `Email ${invitationEmail}` }),
    ).toBeVisible();
    await expect(
      diff.getByRole("row", { name: "Status pending" }),
    ).toBeVisible();
    expect(invitationStatuses([invitationEmail])).toEqual({
      [invitationEmail]: ["pending"],
    });
    await confirmTyped(page, "Admin Invitation");
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/authn/admininvitation/`);
    await expect(page.locator("#main")).toContainText(
      "was deleted successfully",
    );
    expect(invitationStatuses([invitationEmail])).toEqual({
      [invitationEmail]: [],
    });
  });
});

test.describe("Admin member tools", () => {
  test("every tab above the member pages opens a page", async ({ page }) => {
    await adminPasswordLogin(page);
    await page.goto(`${BACKEND_URL}/admin/authn/member/`);
    const tabs = page.locator("#tabs-items");
    await expect(tabs.getByRole("link").first()).toHaveText("Members");
    const names = (await tabs.getByRole("link").allTextContents()).map((name) =>
      name.trim(),
    );
    expect(names.slice(0, 2)).toEqual(["Members", "Emails"]);
    for (const name of names) {
      await page.goto(`${BACKEND_URL}/admin/authn/member/`);
      const opened = page.waitForResponse(
        (response) =>
          response.request().isNavigationRequest() &&
          response.url().startsWith(`${BACKEND_URL}/admin/`),
      );
      await tabs.getByRole("link", { name, exact: true }).click();
      expect((await opened).status(), name).toBe(200);
    }
  });

  test("members export to Excel, and the import validates the file, skips or updates existing members", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `imported-${runId}@example.com`;
    await adminPasswordLogin(page);

    await page.goto(`${BACKEND_URL}/admin/authn/member/`);
    const exported = page.waitForEvent("download");
    await page.getByRole("link", { name: /Export Excel/ }).click();
    const exportFile = await exported;
    expect(exportFile.suggestedFilename()).toMatch(
      /^members_export_\d{8}_\d{6}\.xlsx$/,
    );
    const exportedRows = await readWorkbook(exportFile, "Members");
    expect(exportedRows[0]).toEqual([
      "Member UUID",
      "First Name",
      "Last Name",
      "Middle Name",
      "Active",
      "Staff",
      "When Started",
      "Primary Email",
      "Primary Verified",
      "Primary Subscribed",
      "Secondary Email",
      "Secondary Verified",
      "Secondary Subscribed",
    ]);
    expect(exportedRows.some((row) => row.includes(ADMIN_EMAIL))).toBe(true);

    await page.getByRole("link", { name: /Import Excel/ }).click();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Import Members from Excel",
      }),
    ).toBeVisible();
    const template = page.waitForEvent("download");
    await page.getByRole("link", { name: /Download Import Template/ }).click();
    const templateFile = await template;
    expect(templateFile.suggestedFilename()).toBe(
      "member_import_template.xlsx",
    );
    expect((await readWorkbook(templateFile))[0]).toContain("Primary Email");

    await startMemberImport(page, {
      name: "members.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not a spreadsheet"),
    });
    await expect(
      page.getByText("Please upload a .xlsx or .xls format file"),
    ).toBeVisible();

    await startMemberImport(
      page,
      memberImportWorkbook([["Imp", "Orted", email, "TRUE"]]),
    );
    await expect(
      adminMessage(page, "Import complete: 1 created, 0 updated, 0 skipped"),
    ).toBeVisible();
    expect(memberState(email)).toMatchObject({
      first_name: "Imp",
      last_name: "Orted",
      is_active: true,
      is_staff: false,
    });

    // An existing member is skipped with a row error unless updating is on.
    await startMemberImport(
      page,
      memberImportWorkbook([["Impy", "Orted", email, "TRUE"]]),
    );
    await expect(
      adminMessage(
        page,
        "Import complete: 0 created, 0 updated, 1 skipped, 1 error(s)",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(`Row 2: Member with email ${email} already exists`),
    ).toBeVisible();
    expect(memberState(email).first_name).toBe("Imp");

    await startMemberImport(
      page,
      memberImportWorkbook([["Impy", "Orted", email, "TRUE"]]),
      { updateExisting: true },
    );
    await expect(
      adminMessage(page, "Import complete: 0 created, 1 updated, 0 skipped"),
    ).toBeVisible();
    expect(memberState(email).first_name).toBe("Impy");
  });

  test("selected members export as vCard and Excel, and deactivate and activate after the typed confirmation", async ({
    page,
  }) => {
    const runId = newRunId();
    const email = `vcard-${runId}@example.com`;
    const ids = seedMembers([{ email, first: "Vera", last: `Card${runId}` }]);
    const changelist = `${BACKEND_URL}/admin/authn/member/?q=${encodeURIComponent(email)}`;
    await adminPasswordLogin(page);

    // Exports need no confirmation.
    await page.goto(changelist);
    const vcard = page.waitForEvent("download");
    await runAdminAction(page, [ids[email]], "export_members_to_vcard");
    const vcardFile = await vcard;
    expect(vcardFile.suggestedFilename()).toMatch(
      /^members_export_\d{8}_\d{6}\.vcf$/,
    );
    const card = require("node:fs").readFileSync(
      await vcardFile.path(),
      "utf8",
    );
    expect(card.split("\r\n")).toEqual([
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:Vera Card${runId}`,
      `N:Card${runId};Vera;;;`,
      `EMAIL;TYPE=INTERNET,PREF:${email}`,
      `UID:urn:uuid:${ids[email]}`,
      "END:VCARD",
      "",
    ]);

    await page.goto(changelist);
    const excel = page.waitForEvent("download");
    await runAdminAction(page, [ids[email]], "export_members_to_excel");
    const excelRows = await readWorkbook(await excel, "Members");
    expect(excelRows).toHaveLength(2);
    expect(excelRows[1].slice(0, 3)).toEqual([
      ids[email],
      "Vera",
      `Card${runId}`,
    ]);

    await page.goto(changelist);
    await runAdminAction(page, [ids[email]], "deactivate_members");
    await expect(page).toHaveTitle(
      /Confirm Action: Deactivate selected members/,
    );
    await confirmTyped(page, "user");
    await expect(adminMessage(page, "1 member(s) deactivated.")).toBeVisible();
    expect(memberState(email).is_active).toBe(false);

    await page.goto(changelist);
    await runAdminAction(page, [ids[email]], "activate_members");
    await expect(page).toHaveTitle(/Confirm Action: Activate selected members/);
    await confirmTyped(page, "user");
    await expect(adminMessage(page, "1 member(s) activated.")).toBeVisible();
    expect(memberState(email).is_active).toBe(true);
  });
});

function sidebarSection(page, title) {
  return page
    .locator("#nav-sidebar-apps")
    .getByRole("heading", { name: title, exact: true });
}

// Opens an admin URL and returns the HTTP status of the page.
async function adminStatus(page, path) {
  const response = await page.goto(`${BACKEND_URL}${path}`);
  return response.status();
}

test.describe("Admin per-app access", () => {
  test("a staff member granted only the member app manages members but cannot widen staff access or open other apps", async ({
    page,
  }) => {
    const runId = newRunId();
    const adminEmail = `authn-admin-${runId}@example.com`;
    const targetEmail = `authn-target-${runId}@example.com`;
    const staffEmail = `authn-staff-${runId}@example.com`;
    const ids = seedMembers([
      {
        email: adminEmail,
        first: "Ada",
        last: "Authn",
        staff: true,
        apps: ["authn"],
        password: STAFF_PASSWORD,
      },
      { email: targetEmail, first: "Mara", last: `Target${runId}` },
      { email: staffEmail, first: "Stu", last: "Staff", staff: true },
    ]);
    await adminPasswordLogin(page, {
      email: adminEmail,
      password: STAFF_PASSWORD,
    });

    await expect(
      sidebarSection(page, "Members & Authentication"),
    ).toBeVisible();
    await expect(sidebarSection(page, "Scheduling")).toHaveCount(0);
    await expect(sidebarSection(page, "Email Delivery")).toHaveCount(0);
    for (const path of [
      "/admin/scheduling/event/",
      "/admin/mail/emailproviderconfig/",
      "/admin/core/awscredentialconfig/",
      "/admin/core/backgroundjob/",
    ]) {
      expect(await adminStatus(page, path), path).toBe(403);
    }
    for (const path of [
      "/admin/authn/member/",
      "/admin/authn/member/import-excel/",
      "/admin/authn/admininvitation/",
    ]) {
      expect(await adminStatus(page, path), path).toBe(200);
    }
    const templateResponse = await page.request.get(
      `${BACKEND_URL}/admin/authn/member/import-template/`,
    );
    expect(templateResponse.status()).toBe(200);

    // Staff status and app grants are read-only for a non-superuser, and a
    // forged value is dropped on save.
    const changeUrl = `${BACKEND_URL}/admin/authn/member/${ids[targetEmail]}/change/`;
    await page.goto(changeUrl);
    await expect(page.locator("#id_first_name")).toBeVisible();
    await expect(page.locator('[name="is_staff"]')).toHaveCount(0);
    await expect(page.locator('[name="admin_apps"]')).toHaveCount(0);
    await page.locator("#id_first_name").evaluate((input) => {
      for (const [name, value] of [
        ["is_staff", "on"],
        ["admin_apps", "authn"],
        ["admin_apps", "core"],
      ]) {
        const forged = document.createElement("input");
        forged.type = "hidden";
        forged.name = name;
        forged.value = value;
        input.form.append(forged);
      }
    });
    await page.locator("#id_first_name").fill("Marisol");
    await page.locator('button[name="_save"]').click();
    await expect(page).toHaveTitle(/Confirm Changing user/);
    await expect(page.locator("table").first().locator("tbody tr")).toHaveCount(
      1,
    );
    await confirmTyped(page, "user");
    await expect(page).toHaveURL(`${BACKEND_URL}/admin/authn/member/`);
    expect(memberState(targetEmail)).toMatchObject({
      first_name: "Marisol",
      is_staff: false,
      admin_apps: [],
    });

    // Member support tools stay limited to non-staff accounts.
    await page.goto(changeUrl);
    await expect(
      page.getByTitle("Login as this member on the frontend"),
    ).toBeVisible();
    const minted = await page.request.get(
      `${BACKEND_URL}/admin/authn/member/${ids[targetEmail]}/impersonate/`,
      { maxRedirects: 0 },
    );
    expect(minted.status()).toBe(302);
    expect(
      await adminStatus(
        page,
        `/admin/authn/member/${ids[staffEmail]}/impersonate/`,
      ),
    ).toBe(403);

    // Setting a regular member's password is part of member support.
    expect(
      await adminStatus(
        page,
        `/admin/authn/member/${ids[targetEmail]}/password/`,
      ),
    ).toBe(200);
  });

  test("a non-superuser member admin cannot set a superuser's password", async ({
    page,
  }) => {
    // Setting the password would take over the superuser account that
    // impersonation deliberately refuses.
    const runId = newRunId();
    const adminEmail = `password-admin-${runId}@example.com`;
    const masterEmail = `password-master-${runId}@example.com`;
    const ids = seedMembers([
      {
        email: adminEmail,
        first: "Pax",
        last: "Admin",
        staff: true,
        apps: ["authn"],
        password: STAFF_PASSWORD,
      },
      {
        email: masterEmail,
        first: "Mae",
        last: "Master",
        staff: true,
        superuser: true,
        password: STAFF_PASSWORD,
      },
    ]);
    try {
      await adminPasswordLogin(page, {
        email: adminEmail,
        password: STAFF_PASSWORD,
      });
      expect(
        await adminStatus(
          page,
          `/admin/authn/member/${ids[masterEmail]}/password/`,
        ),
      ).toBe(403);
    } finally {
      // Never leave a usable superuser behind.
      updateMember(masterEmail, {
        is_superuser: false,
        is_staff: false,
        is_active: false,
      });
    }
  });

  test("a staff member without the member app is refused the member admin, its tools and impersonation", async ({
    page,
  }) => {
    const runId = newRunId();
    const adminEmail = `core-admin-${runId}@example.com`;
    const targetEmail = `core-target-${runId}@example.com`;
    const ids = seedMembers([
      {
        email: adminEmail,
        first: "Cole",
        last: "Core",
        staff: true,
        apps: ["core"],
        password: STAFF_PASSWORD,
      },
      { email: targetEmail, first: "Tess", last: "Target" },
    ]);
    await adminPasswordLogin(page, {
      email: adminEmail,
      password: STAFF_PASSWORD,
    });
    await expect(sidebarSection(page, "Site Settings")).toBeVisible();
    await expect(sidebarSection(page, "Members & Authentication")).toHaveCount(
      0,
    );
    expect(await adminStatus(page, "/admin/core/awscredentialconfig/")).toBe(
      200,
    );

    // The custom member URLs re-check the app grant themselves.
    for (const [path, reason] of [
      ["/admin/authn/member/", null],
      [`/admin/authn/member/${ids[targetEmail]}/change/`, null],
      [`/admin/authn/member/${ids[targetEmail]}/password/`, null],
      [
        "/admin/authn/member/import-excel/",
        "You do not have permission to import members.",
      ],
      [
        "/admin/authn/member/export-excel/",
        "You do not have permission to export members.",
      ],
      [
        "/admin/authn/member/import-template/",
        "You do not have permission to access member tooling.",
      ],
      [
        `/admin/authn/member/${ids[targetEmail]}/impersonate/`,
        "You do not have permission to impersonate members.",
      ],
      [
        "/admin/authn/member/confirm-change/",
        "You do not have permission to view users.",
      ],
      [
        "/admin/authn/member/confirm-action/",
        "You do not have permission to view users.",
      ],
    ]) {
      expect(await adminStatus(page, path), path).toBe(403);
      await expect(
        page.getByRole("heading", { name: "Permission denied" }),
      ).toBeVisible();
      if (reason) await expect(page.getByText(reason)).toBeVisible();
    }
  });

  test("a staff member granted the scheduling and mail apps can open their admin pages", async ({
    page,
  }) => {
    // The scheduling and mail admins subclass Unfold's ModelAdmin directly,
    // so the admin_apps grant must reach them as well as BaseModelAdmin.
    const runId = newRunId();
    const email = `scheduling-admin-${runId}@example.com`;
    seedMembers([
      {
        email,
        first: "Sid",
        last: "Scheduling",
        staff: true,
        apps: ["scheduling", "mail"],
        password: STAFF_PASSWORD,
      },
    ]);
    await adminPasswordLogin(page, { email, password: STAFF_PASSWORD });
    await expect(sidebarSection(page, "Scheduling")).toBeVisible();
    await expect(sidebarSection(page, "Email Delivery")).toBeVisible();
    await expect(sidebarSection(page, "Members & Authentication")).toHaveCount(
      0,
    );

    const opened = page.waitForResponse(
      `${BACKEND_URL}/admin/scheduling/event/`,
    );
    await page
      .locator("#nav-sidebar-apps")
      .getByRole("link", { name: "Events" })
      .click();
    expect((await opened).status()).toBe(200);
    expect(await adminStatus(page, "/admin/mail/emailproviderconfig/")).toBe(
      200,
    );
    expect(await adminStatus(page, "/admin/authn/member/")).toBe(403);
  });

  test("a non-superuser member admin cannot grant staff status through the member import", async ({
    page,
  }) => {
    // Staff status is read-only for a non-superuser everywhere, so the
    // import's "Staff" column is ignored for them.
    const runId = newRunId();
    const adminEmail = `import-admin-${runId}@example.com`;
    const targetEmail = `import-target-${runId}@example.com`;
    seedMembers([
      {
        email: adminEmail,
        first: "Ivo",
        last: "Importer",
        staff: true,
        apps: ["authn"],
        password: STAFF_PASSWORD,
      },
      { email: targetEmail, first: "Tomas", last: "Target" },
    ]);
    await adminPasswordLogin(page, {
      email: adminEmail,
      password: STAFF_PASSWORD,
    });
    await page.goto(`${BACKEND_URL}/admin/authn/member/import-excel/`);
    await startMemberImport(
      page,
      memberImportWorkbook(
        [["Tomas", "Target", targetEmail, "TRUE", "TRUE"]],
        [
          "First Name",
          "Last Name",
          "Primary Email",
          "Primary Verified",
          "Staff",
        ],
      ),
      { updateExisting: true },
    );
    await expect(
      page.getByRole("heading", { name: "Import Results" }),
    ).toBeVisible();
    expect(memberState(targetEmail).is_staff).toBe(false);
  });
});

// Field inputs a read-only admin page must not render.
async function expectNoFieldInputs(page, names) {
  for (const name of names) {
    await expect(page.locator(`[name="${name}"]`), name).toHaveCount(0);
  }
}

test.describe("Admin theme", () => {
  test("the theme switcher persists light, dark and system choices across reloads", async ({
    page,
  }) => {
    await adminPasswordLogin(page);
    const toggle = page.getByTestId("releviz-admin-theme-toggle").first();
    const trigger = toggle.getByRole("button", { name: "Switch admin theme" });
    const options = toggle.getByRole("navigation", {
      name: "Admin theme options",
    });
    const html = page.locator("html");
    const storedTheme = () =>
      page.evaluate(() => window.localStorage.getItem("adminTheme"));

    const choose = async (label) => {
      // A click before Alpine has wired the toggle is lost, so open the menu
      // until it reports itself expanded.
      await expect(async () => {
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.click();
        }
        await expect(trigger).toHaveAttribute("aria-expanded", "true", {
          timeout: 1_000,
        });
      }).toPass({ timeout: 15_000 });
      await options.getByRole("button", { name: label }).click();
      await expect(options).toBeHidden();
      await expect(trigger).toContainText(label);
    };

    await choose("Dark");
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    await expect.poll(storedTheme).toBe('"dark"');
    await page.reload();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    await expect(trigger).toContainText("Dark");

    await choose("Light");
    await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    await expect.poll(storedTheme).toBe('"light"');

    // "System" follows the operating system's colour scheme.
    await page.emulateMedia({ colorScheme: "dark" });
    await choose("System");
    await expect.poll(storedTheme).toBe('"auto"');
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(trigger).toContainText("System");
    await expect(html).not.toHaveClass(/(^|\s)(dark|light)(\s|$)/);

    // The choice also themes the login page.
    await page.evaluate(() =>
      window.localStorage.setItem("adminTheme", '"dark"'),
    );
    await page.context().clearCookies({ name: "sessionid" });
    await page.goto(`${BACKEND_URL}/admin/login/`);
    await expect(page.locator(".login-box")).toBeVisible();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  });
});

test.describe("Admin email delivery", () => {
  test("send test email validates the recipient and reports a missing provider", async ({
    page,
  }) => {
    const runId = newRunId();
    await adminPasswordLogin(page);
    // No Email Provider is active in the E2E database, so the test send
    // stops before any delivery.
    await page.goto(`${BACKEND_URL}/admin/mail/emailproviderconfig/`);
    await page.getByRole("link", { name: /Send test email/ }).click();
    await expect(page).toHaveURL(
      `${BACKEND_URL}/admin/mail/emailproviderconfig/send-test-email/`,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Send test email" }),
    ).toBeVisible();
    await expect(page.getByText("No active Email Provider.")).toBeVisible();

    const recipient = page.getByLabel("Recipient email");
    await recipient.fill("not-an-address");
    await recipient.evaluate((input) => {
      input.type = "text";
    });
    await page.getByRole("button", { name: /Send email/ }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page).toHaveURL(/\/send-test-email\/$/);

    await page
      .getByLabel("Recipient email")
      .fill(`admin-test-${runId}@example.com`);
    await page.getByRole("button", { name: /Send email/ }).click();
    await expect(page).toHaveURL(
      `${BACKEND_URL}/admin/mail/emailproviderconfig/`,
    );
    await expect(
      adminMessage(page, "No active Email Provider is configured."),
    ).toBeVisible();
  });

  test("an uncertain email delivery is requeued from the admin, delivered, and recorded in the read-only admin log", async ({
    page,
  }) => {
    const runId = newRunId();
    const recipient = `uncertain-${runId}@example.com`;
    const subject = `Uncertain delivery ${runId}`;
    seedMembers([{ email: recipient, first: "Una", last: "Certain" }]);
    // Created and quarantined in one transaction, so the running email
    // worker never sees the uncertain job as due.
    const jobs = runDjangoJson(
      `
from django.db import transaction
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.mail.services import enqueue_email_job

member = ContactEmail.objects.get(email_address__iexact=data["email"]).member
created = {}
# Test-type jobs: authentication mail never goes through this queue, and
# releviz-flow asserts that across the whole shared database.
with transaction.atomic():
    for label, status in (("uncertain", "uncertain"), ("sent", "sent")):
        job, _ = enqueue_email_job(
            idempotency_key=f'e2e-{label}-{data["run"]}',
            message_type=EmailMessageLog.MessageType.TEST,
            recipient=data["email"],
            subject=f'{data["subject"]} ({label})',
            body="An administrator requeued this delivery.",
            message_id=f'<e2e-{label}-{data["run"]}@releviz.local>',
            member=member,
        )
        EmailDeliveryJob.objects.filter(pk=job.pk).update(
            status=status,
            attempt_count=job.max_attempts,
            provider_call_started_at=timezone.now(),
        )
        created[label] = str(job.pk)
print(json.dumps(created))
`,
      { email: recipient, subject, run: runId },
    );
    const jobStatus = (id) =>
      runDjangoJson(
        `
from apps.mail.models import EmailDeliveryJob

print(json.dumps(EmailDeliveryJob.objects.get(pk=data["id"]).status))
`,
        { id },
      );

    await adminPasswordLogin(page);
    const changelist = `${BACKEND_URL}/admin/mail/emaildeliveryjob/?q=${encodeURIComponent(recipient)}`;
    await page.goto(changelist);
    await expect(page.locator("#result_list tbody tr")).toHaveCount(2);
    const requeuedAt = Date.now() - 1000;
    await runAdminAction(
      page,
      [jobs.uncertain, jobs.sent],
      "retry_uncertain_deliveries",
    );
    await expect(
      adminMessage(page, "1 uncertain email delivery job(s) requeued."),
    ).toBeVisible();
    const delivered = await latestEmailFor(recipient, requeuedAt, (message) =>
      message.includes(`${subject} (uncertain)`),
    );
    expect(delivered).toContain("An administrator requeued this delivery.");
    await expect.poll(() => jobStatus(jobs.uncertain)).toBe("sent");
    expect(jobStatus(jobs.sent)).toBe("sent");

    await page.goto(changelist);
    await runAdminAction(page, [jobs.uncertain], "retry_uncertain_deliveries");
    await expect(
      adminMessage(page, "0 uncertain email delivery job(s) requeued."),
    ).toBeVisible();

    // The requeue is audited in the admin log, which nobody can edit.
    await page.goto(
      `${BACKEND_URL}/admin/admin/logentry/?q=${encodeURIComponent(recipient)}`,
    );
    const logRows = page.locator("#result_list tbody tr");
    await expect(logRows).toHaveCount(1);
    await expect(logRows).toContainText(`test to ${recipient} [uncertain]`);
    // On a filtered changelist Django appends ?_changelist_filters= to the
    // add link, so match the path anywhere in the href.
    await expect(
      page.locator('a[href*="/admin/admin/logentry/add/"]'),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("combobox", { name: "Select action to run" })
        .locator('option[value="delete_selected"]'),
    ).toHaveCount(0);
    await logRows.getByRole("link").first().click();
    await expect(page).toHaveURL(
      /\/admin\/admin\/logentry\/\d+\/change\/(\?|$)/,
    );
    await expect(
      page.getByText("Manually requeued an uncertain email delivery.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('button[name="_save"]')).toHaveCount(0);
    await expectNoFieldInputs(page, ["change_message", "object_repr"]);
    const logEntryUrl = page.url().split("?")[0];
    expect(await adminStatus(page, "/admin/admin/logentry/add/")).toBe(403);
    expect(
      (await page.goto(logEntryUrl.replace(/change\/$/, "delete/"))).status(),
    ).toBe(403);
  });

  test("failed and uncertain background jobs are retried through the typed confirmation, and job records stay read-only", async ({
    page,
  }) => {
    const runId = newRunId();
    // No background worker runs in E2E, and the kind is this test's own, so
    // nothing picks the retried job up.
    const jobs = runDjangoJson(
      `
from django.utils import timezone

from apps.core.models import BackgroundJob

created = {}
for status in ("failed", "uncertain", "succeeded"):
    job = BackgroundJob.objects.create(
        kind="e2e.admin_retry",
        dedupe_key=f'{status}-{data["run"]}',
        payload={},
        status=status,
        attempts=5,
        completed_at=timezone.now(),
    )
    created[status] = str(job.pk)
print(json.dumps(created))
`,
      { run: runId },
    );
    const statuses = () =>
      runDjangoJson(
        `
from apps.core.models import BackgroundJob

print(json.dumps({
    job.dedupe_key.split("-")[0]: job.status
    for job in BackgroundJob.objects.filter(pk__in=data["ids"])
}))
`,
        { ids: Object.values(jobs) },
      );

    try {
      await adminPasswordLogin(page);
      const changelist = `${BACKEND_URL}/admin/core/backgroundjob/?q=${runId}`;
      await page.goto(changelist);
      await expect(page.locator("#result_list tbody tr")).toHaveCount(3);
      await expect(
        page
          .getByRole("combobox", { name: "Select action to run" })
          .locator('option[value="delete_selected"]'),
      ).toHaveCount(0);
      await runAdminAction(
        page,
        [jobs.failed, jobs.uncertain, jobs.succeeded],
        "retry_selected_jobs",
      );
      await expect(page).toHaveTitle(
        /Confirm Action: Explicitly retry selected failed\/uncertain jobs/,
      );
      await expect(
        page.getByText("This will affect 3 background jobs."),
      ).toBeVisible();
      await confirmTyped(page, "background job");
      await expect(
        adminMessage(page, "Queued 2 job(s) for explicit retry."),
      ).toBeVisible();
      expect(statuses()).toEqual({
        failed: "retry",
        uncertain: "retry",
        succeeded: "succeeded",
      });

      await page.goto(changelist);
      await runAdminAction(page, [jobs.succeeded], "retry_selected_jobs");
      await confirmTyped(page, "background job");
      await expect(
        adminMessage(page, "No failed or uncertain jobs were selected."),
      ).toBeVisible();

      await page.goto(
        `${BACKEND_URL}/admin/core/backgroundjob/${jobs.failed}/change/`,
      );
      await expect(
        page.getByText(`failed-${runId}`, { exact: true }),
      ).toBeVisible();
      await expect(page.locator('button[name="_save"]')).toHaveCount(0);
      await expectNoFieldInputs(page, [
        "kind",
        "dedupe_key",
        "status",
        "payload",
      ]);
      expect(await adminStatus(page, "/admin/core/backgroundjob/add/")).toBe(
        403,
      );
      expect(
        await adminStatus(
          page,
          `/admin/core/backgroundjob/${jobs.failed}/delete/`,
        ),
      ).toBe(403);
    } finally {
      runDjangoJson(
        `
from apps.core.models import BackgroundJob

print(json.dumps(BackgroundJob.objects.filter(pk__in=data["ids"]).delete()[0]))
`,
        { ids: Object.values(jobs) },
      );
    }
  });

  test("an event's delivery request, job and message log are listed by search and shown read-only", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = `delivery-organizer-${runId}@example.com`;
    const invitee = `delivery-invitee-${runId}@example.com`;
    const { access } = await registerAccountViaApi(
      request,
      organizer,
      "Dell",
      "Organizer",
    );
    const event = await createEvent(request, access, {
      name: `Delivery ${runId}`,
    });
    const added = await addPersonApi(request, event.code, access, {
      name: "Ivy Invitee",
      email: invitee,
      sendInvitation: true,
    });
    expect(added.deliveryRequest).toBeTruthy();
    await adminPasswordLogin(page);

    await page.goto(
      `${BACKEND_URL}/admin/mail/emaildeliveryrequest/?q=${event.code}`,
    );
    const requestRows = page.locator("#result_list tbody tr");
    await expect(requestRows).toHaveCount(1);
    await expect(requestRows).toContainText("Invitation");
    await requestRows.getByRole("link").first().click();
    await expect(page).toHaveURL(
      /\/admin\/mail\/emaildeliveryrequest\/[\w-]+\/change\/(\?|$)/,
    );
    await expect(page.getByText(event.code).first()).toBeVisible();
    await expectNoFieldInputs(page, [
      "operation",
      "idempotency_key",
      "request_fingerprint",
      "recipient_count",
      "created_job_count",
      "event",
    ]);

    await page.goto(
      `${BACKEND_URL}/admin/mail/emaildeliveryjob/?q=${encodeURIComponent(invitee)}`,
    );
    const jobRows = page.locator("#result_list tbody tr");
    await expect(jobRows).toHaveCount(1);
    await jobRows.getByRole("link").first().click();
    await expect(page).toHaveURL(
      /\/admin\/mail\/emaildeliveryjob\/[\w-]+\/change\/(\?|$)/,
    );
    await expect(page.getByText(invitee).first()).toBeVisible();
    await expectNoFieldInputs(page, [
      "recipient",
      "subject",
      "body",
      "status",
      "attempt_count",
    ]);

    // The worker logs the delivery once it has sent the invitation.
    const logList = `${BACKEND_URL}/admin/mail/emailmessagelog/?q=${encodeURIComponent(invitee)}`;
    await expect
      .poll(
        async () => {
          await page.goto(logList);
          return page.locator("#result_list tbody tr").count();
        },
        { timeout: 20_000 },
      )
      .toBe(1);
    await expect(page.locator("#result_list tbody tr")).toContainText("Sent");
    await page
      .locator("#result_list tbody tr")
      .getByRole("link")
      .first()
      .click();
    await expect(page).toHaveURL(
      /\/admin\/mail\/emailmessagelog\/[\w-]+\/change\/(\?|$)/,
    );
    await expect(page.getByText(invitee).first()).toBeVisible();
    await expectNoFieldInputs(page, [
      "recipient",
      "subject",
      "status",
      "error",
      "message_type",
    ]);
  });
});

// Serializes a test across local workers with an exclusive lock file. Only
// the AWS credential test needs it: activating a config deactivates every
// other one, so two runs of that test (for example under --repeat-each)
// would switch each other's config off.
async function withLocalLock(name, body) {
  const fs = require("node:fs");
  const lockPath = require("node:path").join(
    require("node:os").tmpdir(),
    `releviz-e2e-${name}.lock`,
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A lock left by a killed run is stale after two minutes.
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 120_000) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${lockPath}`);
      // Polling for another worker's lock, not a product timer.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    return await body();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function contactEmails(memberEmail) {
  return runDjangoJson(
    `
from apps.authn.models import ContactEmail

member = ContactEmail.objects.get(email_address__iexact=data["email"]).member
print(json.dumps({
    contact.email_address: {
        "id": str(contact.pk),
        "type": contact.email_type,
        "verified": contact.verified,
        "subscribe": contact.subscribe,
    }
    for contact in member.contact_emails.all()
}))
`,
    { email: memberEmail },
  );
}

function awsCredentialState(name) {
  return runDjangoJson(
    `
from apps.core.models import AWSCredentialConfig

print(json.dumps([
    {
        "id": config.pk,
        "active": config.is_active,
        "region": config.default_region,
        "encrypted": config.encrypted_secret_access_key,
        "secret": config.get_secret_access_key(),
    }
    for config in AWSCredentialConfig.objects.filter(name=data["name"])
]))
`,
    { name },
  );
}

async function addAwsCredential(page, { name, accessKey, secret }) {
  await page.goto(`${BACKEND_URL}/admin/core/awscredentialconfig/add/`);
  await page.locator("#id_name").fill(name);
  await page.locator("#id_access_key_id").fill(accessKey);
  await page.locator("#id_secret_access_key").fill(secret);
  await page.locator('button[name="_save"]').click();
  await expect(page).toHaveTitle(/Confirm Adding AWS Credential/);
}

test.describe("Admin model guards", () => {
  test("contact email actions protect the primary address and swap it only to a verified email", async ({
    page,
  }) => {
    const runId = newRunId();
    const primary = `contact-primary-${runId}@example.com`;
    const secondary = `contact-secondary-${runId}@example.com`;
    seedMembers([{ email: primary, first: "Pia", last: "Primary" }]);
    runDjangoJson(
      `
from apps.authn.models import ContactEmail

member = ContactEmail.objects.get(email_address__iexact=data["primary"]).member
ContactEmail.objects.create(
    member=member,
    email_address=data["secondary"],
    email_type="secondary",
    verified=False,
    subscribe=True,
)
print(json.dumps(True))
`,
      { primary, secondary },
    );
    const ids = Object.fromEntries(
      Object.entries(contactEmails(primary)).map(([email, row]) => [
        email,
        row.id,
      ]),
    );
    const changelist = `${BACKEND_URL}/admin/authn/contactemail/?q=${runId}`;
    const runContactAction = async (selected, action) => {
      await page.goto(changelist);
      await runAdminAction(
        page,
        selected.map((email) => ids[email]),
        action,
      );
      await confirmTyped(page, "Contact Email");
    };
    await adminPasswordLogin(page);

    // The primary address's owner, address and type are read-only, and it
    // cannot be deleted.
    await page.goto(
      `${BACKEND_URL}/admin/authn/contactemail/${ids[primary]}/change/`,
    );
    await expect(
      page.getByText(primary, { exact: true }).first(),
    ).toBeVisible();
    await expectNoFieldInputs(page, ["member", "email_address", "email_type"]);
    await expect(page.locator('[name="verified"]')).toBeAttached();
    await expect(
      page.locator(`a[href$="/${ids[primary]}/delete/"]`),
    ).toHaveCount(0);
    expect(
      await adminStatus(
        page,
        `/admin/authn/contactemail/${ids[primary]}/delete/`,
      ),
    ).toBe(403);
    await page.goto(
      `${BACKEND_URL}/admin/authn/contactemail/${ids[secondary]}/change/`,
    );
    await expect(page.locator('[name="email_address"]')).toHaveValue(secondary);
    await expect(
      page.locator(`a[href$="/${ids[secondary]}/delete/"]`),
    ).toBeVisible();

    await runContactAction([primary, secondary], "make_primary");
    await expect(
      adminMessage(page, "Select exactly one email to make primary."),
    ).toBeVisible();
    await runContactAction([secondary], "make_primary");
    await expect(
      adminMessage(page, "Verify this email before setting it as primary."),
    ).toBeVisible();

    await runContactAction([secondary], "mark_verified");
    await expect(
      adminMessage(page, "1 email(s) marked as verified."),
    ).toBeVisible();
    await runContactAction([secondary], "toggle_subscribe");
    await expect(
      adminMessage(page, "Toggled subscription for 1 email(s)."),
    ).toBeVisible();
    expect(contactEmails(primary)[secondary]).toMatchObject({
      type: "secondary",
      verified: true,
      subscribe: false,
    });

    await runContactAction([secondary], "make_primary");
    await expect(
      adminMessage(page, `${secondary} is now the primary email.`),
    ).toBeVisible();
    await runContactAction([primary], "mark_unverified");
    await expect(
      adminMessage(page, "1 email(s) marked as unverified."),
    ).toBeVisible();
    expect(contactEmails(primary)).toMatchObject({
      [primary]: { type: "secondary", verified: false },
      [secondary]: { type: "primary", verified: true },
    });
  });

  test("AWS credentials keep the secret write-only, and the active config cannot be deleted", async ({
    browserName,
    page,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Activating a config switches every other one off; one browser job runs it",
    );
    const runId = newRunId();
    const name = `E2E AWS ${runId}`;
    const secret = `e2e-secret-${runId}`;
    const accessKey = `AKIAE2E${runId.replace(/\D/g, "").slice(-9)}`;
    await withLocalLock("aws-credential", async () => {
      const previouslyActive = runDjangoJson(`
from apps.core.models import AWSCredentialConfig

print(json.dumps(list(AWSCredentialConfig.objects.filter(is_active=True).values_list("pk", flat=True))))
`);
      try {
        await adminPasswordLogin(page);
        await addAwsCredential(page, { name, accessKey, secret });
        await confirmTyped(page, "AWS Credential");
        const [saved] = awsCredentialState(name);
        expect(saved).toMatchObject({ active: false, secret });
        expect(saved.encrypted).not.toContain(secret);

        // The secret is never rendered back; a blank field keeps it.
        const changeUrl = `${BACKEND_URL}/admin/core/awscredentialconfig/${saved.id}/change/`;
        await page.goto(changeUrl);
        await expect(page.locator("#id_secret_access_key")).toHaveValue("");
        await expect(
          page.getByText(
            "Leave blank to keep the existing AWS secret access key.",
          ),
        ).toBeVisible();
        await expect(page.getByText(saved.encrypted)).toBeVisible();
        expect(await page.content()).not.toContain(secret);
        await page.locator("#id_default_region").fill("eu-west-1");
        await page.locator('button[name="_save"]').click();
        await expect(page).toHaveTitle(/Confirm Changing AWS Credential/);
        await confirmTyped(page, "AWS Credential");
        expect(awsCredentialState(name)[0]).toMatchObject({
          region: "eu-west-1",
          secret,
        });

        await page.goto(
          `${BACKEND_URL}/admin/core/awscredentialconfig/?q=${runId}`,
        );
        const row = page.locator("#result_list tbody tr");
        await expect(row).toContainText(`...${accessKey.slice(-4)}`);
        await expect(row).not.toContainText(accessKey);
        await expect(row).toContainText("Inactive");
        await expect(
          page
            .getByRole("combobox", { name: "Select action to run" })
            .locator('option[value="delete_selected"]'),
        ).toHaveCount(0);

        await page.goto(changeUrl);
        await expect(
          page.locator(`a[href$="/${saved.id}/delete/"]`),
        ).toBeVisible();
        await page.getByRole("link", { name: /Activate this config/ }).click();
        await expect(
          adminMessage(
            page,
            `"${name}" is now the active AWS credential config.`,
          ),
        ).toBeVisible();
        expect(awsCredentialState(name)[0].active).toBe(true);
        await expect(
          page.locator(`a[href$="/${saved.id}/delete/"]`),
        ).toHaveCount(0);
        expect(
          await adminStatus(
            page,
            `/admin/core/awscredentialconfig/${saved.id}/delete/`,
          ),
        ).toBe(403);

        // Switched off again, it can be deleted.
        await page.goto(changeUrl);
        await page.locator("#id_is_active").uncheck();
        await page.locator('button[name="_save"]').click();
        await confirmTyped(page, "AWS Credential");
        await page.goto(
          `${BACKEND_URL}/admin/core/awscredentialconfig/${saved.id}/delete/`,
        );
        await page.getByRole("button", { name: /Yes, I.m sure/ }).click();
        await confirmTyped(page, "AWS Credential");
        await expect(page.locator("#main")).toContainText(
          "was deleted successfully",
        );
        expect(awsCredentialState(name)).toEqual([]);
      } finally {
        runDjangoJson(
          `
from apps.core.models import AWSCredentialConfig

AWSCredentialConfig.objects.filter(name=data["name"]).delete()
for config in AWSCredentialConfig.objects.filter(pk__in=data["active"]):
    config.is_active = True
    config.save()
print(json.dumps(True))
`,
          { name, active: previouslyActive },
        );
      }
    });
  });

  test("the typed confirmation does not reveal a new AWS secret", async ({
    page,
  }) => {
    // The confirmation page must not print a secret the form never renders
    // back; its row shows a mask instead.
    const runId = newRunId();
    const secret = `e2e-reveal-${runId}`;
    await adminPasswordLogin(page);
    await addAwsCredential(page, {
      name: `E2E AWS reveal ${runId}`,
      accessKey: "AKIAE2EREVEAL",
      secret,
    });
    await expect(
      page
        .locator("table")
        .first()
        .getByRole("row", { name: /Access Key ID/ }),
    ).toBeVisible();
    try {
      await expect(page.locator("table").first()).toContainText("••••••••");
      // The page is rendered by the server, so read it once.
      expect(await page.locator("#main").textContent()).not.toContain(secret);
    } finally {
      // Leave without saving.
      await page.getByRole("link", { name: /Cancel/ }).click();
      expect(awsCredentialState(`E2E AWS reveal ${runId}`)).toEqual([]);
    }
  });

  test("RSA keypairs are generated on save, read-only afterwards, and rotate or deactivate through actions", async ({
    page,
  }) => {
    const runId = newRunId();
    const name = `e2e-rsa-${runId}`;
    const keypairs = () =>
      runDjangoJson(
        `
from apps.authn.models import RSAKeypair

print(json.dumps([
    {
        "id": str(pair.pk),
        "key_id": str(pair.key_id),
        "active": pair.is_active,
        "rotated": pair.rotated_at is not None,
        "public": pair.public_key_pem,
        "private_is_plain": pair.private_key_pem.startswith("-----BEGIN"),
    }
    for pair in RSAKeypair.objects.filter(name=data["name"]).order_by("created_at")
]))
`,
        { name },
      );
    await adminPasswordLogin(page);
    await page.goto(`${BACKEND_URL}/admin/authn/rsakeypair/add/`);
    await expect(
      page.getByText("RSA keys will be auto-generated when you save."),
    ).toBeVisible();
    await page.locator("#id_name").fill(name);
    await expect(page.locator("#id_is_active")).toBeChecked();
    await page.locator('button[name="_save"]').click();
    await expect(page).toHaveTitle(/Confirm Adding RSA Keypair/);
    await confirmTyped(page, "RSA Keypair");
    const [created] = keypairs();
    expect(created).toMatchObject({
      active: true,
      rotated: false,
      private_is_plain: false,
    });
    expect(created.public).toMatch(/^-----BEGIN PUBLIC KEY-----/);

    await page.goto(
      `${BACKEND_URL}/admin/authn/rsakeypair/${created.id}/change/`,
    );
    await expect(page.locator("#id_name")).toHaveValue(name);
    await expectNoFieldInputs(page, [
      "key_id",
      "is_active",
      "public_key_pem",
      "private_key_pem",
    ]);

    const changelist = `${BACKEND_URL}/admin/authn/rsakeypair/?q=${runId}`;
    await page.goto(changelist);
    await runAdminAction(page, [created.id], "regenerate_keys");
    await expect(page).toHaveTitle(
      /Confirm Action: Regenerate keys for selected keypairs/,
    );
    await confirmTyped(page, "RSA Keypair");
    await expect(adminMessage(page, "1 keypair(s) regenerated.")).toBeVisible();
    const [retired, replacement] = keypairs();
    expect(retired).toMatchObject({
      id: created.id,
      active: false,
      rotated: true,
    });
    expect(replacement).toMatchObject({ active: true, rotated: false });
    expect(replacement.key_id).not.toBe(created.key_id);
    expect(replacement.public).not.toBe(created.public);

    await page.goto(changelist);
    await runAdminAction(
      page,
      [retired.id, replacement.id],
      "deactivate_keypairs",
    );
    await confirmTyped(page, "RSA Keypair");
    await expect(adminMessage(page, "1 keypair(s) deactivated.")).toBeVisible();
    await page.goto(changelist);
    await runAdminAction(page, [replacement.id], "regenerate_keys");
    await confirmTyped(page, "RSA Keypair");
    await expect(adminMessage(page, "0 keypair(s) regenerated.")).toBeVisible();
    expect(keypairs().map((pair) => pair.active)).toEqual([false, false]);
  });

  test("the maintenance control is a singleton that is never deleted and never renders its bypass password", async ({
    page,
  }) => {
    // The public bypass endpoint creates the singleton the same way on its
    // first call; nothing here saves it.
    const pk = runDjangoJson(`
from apps.core.models import SiteMaintenanceControl

print(json.dumps(SiteMaintenanceControl.load().pk))
`);
    await adminPasswordLogin(page);
    await page.goto(`${BACKEND_URL}/admin/core/sitemaintenancecontrol/`);
    await expect(page).toHaveURL(
      `${BACKEND_URL}/admin/core/sitemaintenancecontrol/${pk}/change/`,
    );
    await expect(page.getByLabel("Maintenance Mode")).toBeVisible();
    await expect(page.locator('[name="bypass_password"]')).toHaveValue("");
    await expect(page.getByLabel("Clear bypass password")).not.toBeChecked();
    await expect(page.locator(`a[href$="/${pk}/delete/"]`)).toHaveCount(0);
    expect(
      await adminStatus(page, "/admin/core/sitemaintenancecontrol/add/"),
    ).toBe(403);
    expect(
      await adminStatus(
        page,
        `/admin/core/sitemaintenancecontrol/${pk}/delete/`,
      ),
    ).toBe(403);
  });
});

// An organizer's event with imported groups, an import still in review, an
// invited temporary person
// who holds a temporary session, a submitted and weighted response, fresh
// results and, unless `finalize` is false, a confirmed final meeting.
async function seedSchedulingEvent(request, runId, { finalize = true } = {}) {
  const organizer = `sched-organizer-${runId}@example.com`;
  const temporary = `sched-temp-${runId}@example.com`;
  const { access } = await registerAccountViaApi(
    request,
    organizer,
    "Otto",
    "Organizer",
  );
  const event = await createEvent(request, access, {
    name: `Admin scheduling ${runId}`,
  });
  await importRosterApi(
    request,
    event.code,
    access,
    tsv([
      ["name", "email", "group"],
      ["Gil Group", `sched-gil-${runId}@example.com`, "Alpha"],
      ["Hal Group", `sched-hal-${runId}@example.com`, "Alpha; Beta"],
    ]),
  );
  // A committed import keeps its batch and receipt; the rows of an import
  // still under review stay until it expires.
  const preview = await apiJson(
    request,
    "POST",
    `/events/roster-imports?code=${event.code}`,
    access,
    {
      sourceType: "paste",
      pastedText: tsv([
        ["name", "email"],
        ["Pat Preview", `sched-pat-${runId}@example.com`],
      ]),
    },
  );
  expect(preview.response.status()).toBe(201);
  await addPersonApi(request, event.code, access, {
    name: "Tia Temporary",
    email: temporary,
    sendInvitation: true,
  });
  await submitResponse(request, access, event, {
    name: "Sam Submitted",
    email: `sched-sam-${runId}@example.com`,
    inperson: [0, 1, 2, 3],
    weight: 0.5,
  });
  const results = await freshResults(request, access, event.code);
  if (finalize) {
    await finalizeViaApi(
      request,
      access,
      event.code,
      results.recommendations[0],
    );
  }
  const ids = runDjangoJson(
    `
import hashlib
import secrets
from datetime import timedelta

from django.utils import timezone

from apps.scheduling.models import (
    EventInvitation,
    Participant,
    ParticipantGroup,
    TemporaryEventSession,
)

invitation = EventInvitation.objects.get(event__code=data["code"], email__iexact=data["temporary"])
participant = Participant.objects.get(event=invitation.event, member=invitation.member)
session = TemporaryEventSession.objects.create(
    member=invitation.member,
    participant=participant,
    invitation=invitation,
    secret_hash=hashlib.sha256(secrets.token_urlsafe(32).encode()).hexdigest(),
    expires_at=timezone.now() + timedelta(days=1),
)
print(json.dumps({
    "invitation": str(invitation.pk),
    "session": str(session.pk),
    "hal": str(Participant.objects.get(event__code=data["code"], participant_name="Hal Group").pk),
    "groups": {
        group.name: str(group.pk)
        for group in ParticipantGroup.objects.filter(event__code=data["code"])
    },
}))
`,
    { code: event.code, temporary },
  );
  return { access, event, ids, temporary };
}

test.describe("Admin scheduling data", () => {
  test("every scheduling changelist finds an event's records by its code", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const { event, temporary } = await seedSchedulingEvent(request, runId);
    await adminPasswordLogin(page);

    // The event's own records, counted in the database.
    const expectedRows = runDjangoJson(
      `
from apps.scheduling import models

code = data["code"]
counts = {
    "event": models.Event.objects.filter(code=code),
    "participant": models.Participant.objects.filter(event__code=code),
    "participantgroup": models.ParticipantGroup.objects.filter(event__code=code),
    "eventinvitation": models.EventInvitation.objects.filter(event__code=code),
    "weight": models.Weight.objects.filter(event__code=code),
    "userevent": models.UserEvent.objects.filter(event__code=code),
    "temporaryeventsession": models.TemporaryEventSession.objects.filter(
        participant__event__code=code
    ),
    "eventresultsnapshot": models.EventResultSnapshot.objects.filter(event__code=code),
    "scheduleeditrecord": models.ScheduleEditRecord.objects.filter(event__code=code),
    "rosterimportbatch": models.RosterImportBatch.objects.filter(event__code=code),
    "rosterimportrow": models.RosterImportRow.objects.filter(batch__event__code=code),
    "rosterimportreceipt": models.RosterImportReceipt.objects.filter(event__code=code),
    "finalmeeting": models.FinalMeeting.objects.filter(event__code=code),
    "finalizationrequest": models.FinalizationRequest.objects.filter(event__code=code),
}
print(json.dumps({name: queryset.count() for name, queryset in counts.items()}))
`,
      { code: event.code },
    );
    for (const [model, count] of Object.entries(expectedRows)) {
      expect(count, model).toBeGreaterThan(0);
      const response = await page.goto(
        `${BACKEND_URL}/admin/scheduling/${model}/?q=${event.code}`,
      );
      expect(response.status(), model).toBe(200);
      const rows = page.locator("#result_list tbody tr");
      await expect(rows, model).toHaveCount(count);
      for (const row of await rows.all()) {
        await expect(row, model).toContainText(event.code);
      }
    }

    // Other search fields reach the same records.
    await page.goto(
      `${BACKEND_URL}/admin/scheduling/event/?q=${encodeURIComponent(event.name)}`,
    );
    await expect(page.locator("#result_list tbody tr")).toHaveCount(1);
    await page.goto(
      `${BACKEND_URL}/admin/scheduling/eventinvitation/?q=${encodeURIComponent(temporary)}`,
    );
    await expect(page.locator("#result_list tbody tr")).toContainText(
      temporary,
    );
    await page.goto(
      `${BACKEND_URL}/admin/scheduling/participant/?q=${encodeURIComponent("Hal Group")}+${event.code}`,
    );
    await expect(page.locator("#result_list tbody tr")).toHaveCount(1);
    await page.goto(
      `${BACKEND_URL}/admin/scheduling/participantgroup/?q=${encodeURIComponent(`no-such-group-${runId}`)}`,
    );
    await expect(page.locator("#result_list tbody tr")).toHaveCount(0);
  });

  test("group names follow the cell grammar, a participant's groups come from its own event, and secrets stay read-only", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const { access, event, ids } = await seedSchedulingEvent(request, runId, {
      finalize: false,
    });
    // Another event's group must not be offered to this event's people.
    const otherEvent = await createEvent(request, access, {
      name: `Admin scheduling other ${runId}`,
    });
    await importRosterApi(
      request,
      otherEvent.code,
      access,
      tsv([
        ["name", "email", "group"],
        ["Oli Other", `sched-oli-${runId}@example.com`, "Alpha"],
      ]),
    );
    await adminPasswordLogin(page);

    const groupUrl = `${BACKEND_URL}/admin/scheduling/participantgroup/${ids.groups.Alpha}/change/`;
    const renameGroup = async (name) => {
      await page.goto(groupUrl);
      await page.locator("#id_name").fill(name);
      await page.locator('button[name="_save"]').click();
    };
    for (const [name, error] of [
      ["Alpha; Gamma", "Group names cannot contain ; or ,."],
      ["Alpha, Gamma", "Group names cannot contain ; or ,."],
      ["all", "ALL is reserved for every group."],
    ]) {
      await renameGroup(name);
      await expect(page.getByText(error)).toBeVisible();
      await expect(page).toHaveURL(groupUrl);
    }
    await renameGroup("  Alpha Prime  ");
    await expect(page).toHaveURL(
      `${BACKEND_URL}/admin/scheduling/participantgroup/`,
    );
    expect(
      runDjangoJson(
        `
from apps.scheduling.models import ParticipantGroup

print(json.dumps(ParticipantGroup.objects.get(pk=data["id"]).name))
`,
        { id: ids.groups.Alpha },
      ),
    ).toBe("Alpha Prime");

    await page.goto(
      `${BACKEND_URL}/admin/scheduling/participant/${ids.hal}/change/`,
    );
    await expect(page.locator("#id_participant_name")).toHaveValue("Hal Group");
    const offered = await page
      .locator('select[id^="id_groups"] option')
      .allTextContents();
    expect(offered.map((text) => text.trim()).sort()).toEqual([
      `Alpha Prime - ${event.code}`,
      `Beta - ${event.code}`,
    ]);
    expect(offered.join(" ")).not.toContain(otherEvent.code);
    await expectNoFieldInputs(page, ["response_claimed_at"]);
    await expect(page.getByText("Response claimed at").first()).toBeVisible();

    await page.goto(
      `${BACKEND_URL}/admin/scheduling/eventinvitation/${ids.invitation}/change/`,
    );
    await expect(page.getByText("Access token").first()).toBeVisible();
    await expectNoFieldInputs(page, ["access_token"]);

    await page.goto(
      `${BACKEND_URL}/admin/scheduling/temporaryeventsession/${ids.session}/change/`,
    );
    await expect(page.getByText("Secret hash").first()).toBeVisible();
    await expectNoFieldInputs(page, [
      "secret_hash",
      "member",
      "participant",
      "invitation",
      "expires_at",
      "revoked_at",
    ]);
  });
});
