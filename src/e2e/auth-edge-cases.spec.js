const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  apiJson,
  createEvent,
  differentCode,
  expectDashboard,
  expireResendCooldown,
  importRoster,
  latestAuthLink,
  latestEmailFor,
  latestVerificationCode,
  newRunId,
  readSession,
  registerAccountViaApi,
  requestEmailCode,
  tempAccessSessionState,
  temporaryAccessPathFromEmail,
} = require("./helpers/releviz");
const { rosterByEmail } = require("./helpers/roster");

// Sign-in edge cases the happy-path helpers skip: emailed sign-in links opened
// on another device, the email-code panel (validation, Back, the resend
// cooldown, superseded codes, an unsafe next and the signed-in redirect),
// password mode, /recover, the settings password and deletion errors,
// temporary event access (status pages, wrong and superseded codes, sign-out,
// an upgrade in another tab), the upgrade link's error states and the legacy
// sign-in routes.

const INVALID_CODE = "Verification code is invalid or has expired.";
const INCOMPLETE_LINK =
  "This verification link is incomplete or invalid. Request a new code to continue.";
const WRONG_TEMP_CODE =
  "That code could not be verified. Check the code or request a new one.";

// Next.js mounts its own role=alert route announcer, so page alerts and
// statuses are always read from inside the page's <main>.
function mainAlert(page) {
  return page.getByRole("main").getByRole("alert");
}

function mainStatus(page) {
  return page.getByRole("main").getByRole("status");
}

function heading(page, name) {
  return page.getByRole("heading", { level: 1, name, exact: true });
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

function invitationStorageKey(code) {
  return `releviz.temp-access.invitation:${code}`;
}

// An organizer's event with one invited person who has no account, and the
// temporary access path from that person's invitation email.
async function temporaryInvitation(request, runId, name) {
  const organizerEmail = `temp-org-${runId}@example.com`;
  const tempEmail = `temp-${runId}@example.com`;
  const organizer = await registerAccountViaApi(
    request,
    organizerEmail,
    "Tara",
    "Organizer",
  );
  const event = await createEvent(request, organizer.access, {
    name: `Temp access ${runId}`,
  });
  const invitedAt = Date.now() - 1000;
  await importRoster(
    request,
    event.code,
    organizer.access,
    `name,email,group,weight,included\n${name},${tempEmail},Temp Access,1,true`,
  );
  // The always-on email worker delivers the invitation.
  const body = await latestEmailFor(tempEmail, invitedAt, (message) =>
    message.includes(`/temp-access?code=${event.code}`),
  );
  return {
    organizer,
    event,
    tempEmail,
    accessPath: temporaryAccessPathFromEmail(body),
  };
}

test.describe("Sign-in and temporary access edge cases", () => {
  test("opens the emailed sign-in link on another device and rejects reused or malformed links", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `magic-${runId}@example.com`;
    await registerAccountViaApi(request, email, "Lina", "Link");

    await page.goto("/login?next=%2Fsettings");
    const requestedAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    const link = await latestAuthLink(email, requestedAt, "login");
    expect(link.params.get("flow")).toBe("auth");
    expect(link.params.get("source")).toBe("login");
    expect(link.params.get("email")).toBe(email.toLowerCase());
    expect(link.params.get("next")).toBe("/settings");
    expect(link.code).toMatch(/^\d{6}$/);
    expect(link.body).toContain("Sign In to Your Account");
    expect(link.body).toContain("If the button does not work, open this link:");

    // Another device: a fresh context with no session opens the link.
    const linkContext = await browser.newContext();
    try {
      const linkPage = await linkContext.newPage();
      await linkPage.goto(link.url);
      await expect(linkPage).toHaveURL(/\/settings$/);
      await expect(heading(linkPage, "Account settings")).toBeVisible();

      // The link consumed the code, so typing it on the first device fails.
      await page.getByLabel("Verification code").fill(link.code);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(mainAlert(page)).toHaveText(INVALID_CODE);
      await expect(heading(page, "Verify Your Identity")).toBeVisible();

      // Reopening the used link from /settings is a new document, so the page
      // verifies again and reports the backend rejection.
      await linkPage.goto(link.url);
      await expect(heading(linkPage, "Link verification failed")).toBeVisible();
      await expect(linkPage.getByText(INVALID_CODE)).toBeVisible();
      await expect(
        linkPage.getByRole("link", { name: "Request a new code" }),
      ).toHaveAttribute("href", "/login");
      // The code-bearing hash never stays in the address bar.
      await expect(linkPage).toHaveURL(/\/email-auth-link$/);
    } finally {
      await linkContext.close();
    }

    await page.goto("/email-auth-link");
    await expect(heading(page, "Link verification failed")).toBeVisible();
    await expect(page.getByText(INCOMPLETE_LINK)).toBeVisible();
    await page.getByRole("link", { name: "Request a new code" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    // A register flow cannot come from the login source.
    await page.goto(
      "/email-auth-link#flow=register&source=login&email=a%40example.com&code=123456",
    );
    await expect(heading(page, "Link verification failed")).toBeVisible();
    await expect(page.getByText(INCOMPLETE_LINK)).toBeVisible();

    // A hash-only change on the same path would not reload the page, so leave
    // it first. An event slug with a space is rejected before any request.
    await page.goto("/login");
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();
    await page.goto(
      "/email-auth-link#flow=auth&source=event_registration&email=a%40example.com&code=123456&event=bad%20slug",
    );
    await expect(heading(page, "Link verification failed")).toBeVisible();
    await expect(page.getByText(INCOMPLETE_LINK)).toBeVisible();
  });

  test("the email-code panel validates the address, keeps it on Back, rate-limits resends, supersedes old codes, and ignores an unsafe next", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const runId = newRunId();
    const email = `code-panel-${runId}@example.com`;
    await registerAccountViaApi(request, email, "Cody", "Panel");
    const continueButton = page.getByRole("button", {
      name: "Continue",
      exact: true,
    });
    const resendButton = page.getByRole("button", { name: "Resend code" });
    const codeField = page.getByLabel("Verification code");

    await page.goto("/login?next=https%3A%2F%2Fevil.example");
    await page.getByLabel("Email").fill("not-an-email");
    await expect(continueButton).toBeDisabled();
    await expect(
      page.getByText(
        "We'll email you a 6-digit sign-in code. New here? This creates your account.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "By continuing, you agree to receive a one-time verification email.",
      ),
    ).toBeVisible();

    const firstAt = Date.now() - 1000;
    await requestEmailCode(page, email);
    const code1 = await latestVerificationCode(email, firstAt, "login");
    await expect(page.getByText("Sending to")).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(mainStatus(page)).toHaveText(
      "Check your email for a verification code.",
    );

    // Only digits are kept, and six are needed.
    await codeField.fill("12ab34");
    await expect(codeField).toHaveValue("1234");
    await expect(continueButton).toBeDisabled();

    await page.getByRole("button", { name: "Back" }).click();
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveValue(email);

    // Asking again inside the 60 s cooldown is refused. The copy is a known
    // misleading "Too many verification attempts", so only the alert is pinned.
    await continueButton.click();
    await expect(mainAlert(page)).toBeVisible();
    await expect(mainAlert(page)).not.toHaveText("");
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    expireResendCooldown(email);
    const secondAt = Date.now() - 1000;
    await continueButton.click();
    await expect(heading(page, "Verify Your Identity")).toBeVisible();
    const code2 = await latestVerificationCode(email, secondAt, "login", {
      notCode: code1,
    });
    expect(code2).not.toBe(code1);

    // Resend once the cooldown is over issues a newer code.
    expireResendCooldown(email);
    const thirdAt = Date.now() - 1000;
    await resendButton.click();
    await expect(mainStatus(page)).toHaveText(
      "Check your email for a verification code.",
    );
    const code3 = await latestVerificationCode(email, thirdAt, "login", {
      notCode: code2,
    });

    // A resend inside the cooldown is refused and keeps the code step.
    await resendButton.click();
    await expect(mainAlert(page)).toBeVisible();
    await expect(mainAlert(page)).not.toHaveText("");
    await expect(heading(page, "Verify Your Identity")).toBeVisible();

    // Both earlier codes were superseded.
    for (const stale of [code1, code2]) {
      if (stale === code3) continue;
      await codeField.fill(stale);
      await continueButton.click();
      await expect(mainAlert(page)).toHaveText(INVALID_CODE);
    }

    // The code issued before the refused resend still works, and the unsafe
    // next falls back to the dashboard.
    await codeField.fill(code3);
    await continueButton.click();
    await expectDashboard(page);
    expect(page.url()).not.toContain("evil.example");

    // Already signed in: /login goes straight to a safe next.
    await page.goto("/login?next=%2Fsettings");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(heading(page, "Account settings")).toBeVisible();

    // An auth entry path as next falls back to the dashboard.
    await page.goto("/login?next=%2Frecover");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("password mode, Forgot password and recovery reject bad input before a reset succeeds, and settings reports password and deletion errors", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const runId = newRunId();
    const email = `recover-${runId}@example.com`;
    const unknownEmail = `nobody-${runId}@example.com`;
    await registerAccountViaApi(request, email, "Rhea", "Recover");
    const signInButton = page.getByRole("button", {
      name: "Sign In",
      exact: true,
    });

    await page.goto("/login");
    await switchToPasswordMode(page);
    await expect(signInButton).toBeDisabled();
    await page.getByLabel("Email").fill(email);
    await expect(signInButton).toBeDisabled();
    await page
      .getByLabel("Password", { exact: true })
      .fill("WrongPassword123!");
    await expect(signInButton).toBeEnabled();
    await signInButton.click();
    await expect(mainAlert(page)).toHaveText("Invalid credentials.");

    await page
      .getByRole("button", { name: "Sign in with a verification code" })
      .click();
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await switchToPasswordMode(page);

    // A custom destination travels to the recovery page.
    await page.goto("/login?next=%2Fsettings");
    await switchToPasswordMode(page);
    await expect(
      page.getByRole("link", { name: "Forgot password?" }),
    ).toHaveAttribute("href", "/recover?next=%2Fsettings");

    await page.goto("/login");
    await switchToPasswordMode(page);
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/recover$/);
    await expect(heading(page, "Recover your account")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Back to login" }),
    ).toHaveAttribute("href", "/login");

    const emailField = page.getByLabel("Email");
    const sendReset = page.getByRole("button", { name: "Send reset code" });
    const resetStatus =
      "If an account exists for that email, a reset code has been sent. Check your inbox.";
    await emailField.fill("nope");
    await expect(sendReset).toBeDisabled();
    // An unknown address gets the same neutral answer.
    await emailField.fill(unknownEmail);
    await sendReset.click();
    await expect(mainStatus(page)).toHaveText(resetStatus);
    await expect(emailField).toBeDisabled();

    await page.getByRole("button", { name: "Use a different email" }).click();
    await expect(emailField).toBeEnabled();
    await expect(mainStatus(page)).toHaveCount(0);
    await expect(page.getByLabel("Reset code")).toHaveCount(0);

    const resetAt = Date.now() - 1000;
    await emailField.fill(email);
    await sendReset.click();
    await expect(mainStatus(page)).toHaveText(resetStatus);
    const resetCode = await latestVerificationCode(
      email,
      resetAt,
      "password_reset",
    );

    const resetButton = page.getByRole("button", { name: "Reset password" });
    await page.getByLabel("Reset code").fill(resetCode);
    await page
      .getByLabel("New password", { exact: true })
      .fill("ResetPassword123!");
    await page.getByLabel("Confirm new password").fill("Mismatch123!");
    await resetButton.click();
    await expect(mainAlert(page)).toHaveText("Passwords do not match.");

    await page.getByLabel("Confirm new password").fill("ResetPassword123!");
    await page.getByLabel("Reset code").fill(differentCode(resetCode));
    await resetButton.click();
    await expect(mainAlert(page)).toHaveText(INVALID_CODE);

    await page.getByLabel("Reset code").fill(resetCode);
    await resetButton.click();
    await expect(page).toHaveURL(/\/login\?status=password-reset$/);
    await expect(
      page.getByText("Password reset complete. Continue with your email."),
    ).toBeVisible();

    await signInWithPassword(page, email, "ResetPassword123!");
    await expectDashboard(page);

    await page.goto("/settings");
    await expect(heading(page, "Account settings")).toBeVisible();
    const pw = page.locator("form#password");
    await pw.locator("summary").click();
    const changePassword = pw.getByRole("button", { name: "Change password" });
    const current = pw.getByLabel("Current password");
    const newPassword = pw.getByLabel("New password", { exact: true });
    const confirmPassword = pw.getByLabel("Confirm new password");

    await current.fill("ResetPassword123!");
    await newPassword.fill("NewPassword123!");
    await confirmPassword.fill("Different123!");
    await changePassword.click();
    await expect(pw.getByRole("alert")).toHaveText(
      "New passwords do not match.",
    );

    await current.fill("WrongCurrent123!");
    await confirmPassword.fill("NewPassword123!");
    await changePassword.click();
    await expect(pw.getByRole("alert")).toHaveText(
      "Current password is incorrect.",
    );

    await current.fill("ResetPassword123!");
    await newPassword.fill("password123");
    await confirmPassword.fill("password123");
    await changePassword.click();
    await expect(pw.getByRole("alert")).toContainText(
      "This password is too common.",
    );
    await expect(page).toHaveURL(/\/settings$/);

    const del = page.locator("form#danger-zone");
    await del.locator("summary").click();
    await expect(
      del.getByText(
        "Every session will be revoked and your identity will be anonymized in retained scheduling records.",
      ),
    ).toBeVisible();
    const emailDeleteCode = del.getByRole("button", {
      name: "Email a confirmation code",
    });
    const confirmation = del.getByLabel("Type DELETE to confirm");
    await confirmation.fill("delete");
    await expect(emailDeleteCode).toBeDisabled();
    await confirmation.fill("DELETE");
    await expect(emailDeleteCode).toBeEnabled();
    const deleteAt = Date.now() - 1000;
    await emailDeleteCode.click();
    await expect(del.getByRole("status")).toHaveText(
      "We emailed a confirmation code. Enter it to delete your account.",
    );
    const deleteCode = await latestVerificationCode(
      email,
      deleteAt,
      "account_delete",
    );
    const deletePermanently = del.getByRole("button", {
      name: "Delete account permanently",
    });
    await expect(deletePermanently).toBeDisabled();
    const wrongDeleteCode = differentCode(deleteCode);
    await del.getByLabel("Confirmation code").fill(wrongDeleteCode.slice(0, 5));
    await expect(deletePermanently).toBeDisabled();
    await del.getByLabel("Confirmation code").fill(wrongDeleteCode);
    await expect(deletePermanently).toBeEnabled();
    await deletePermanently.click();
    await expect(del.getByRole("alert")).toHaveText(INVALID_CODE);
    await expect(page).toHaveURL(/\/settings$/);

    // The account survives the wrong code and stays signed in.
    const session = await readSession(page);
    const profile = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      session.access,
    );
    expect(profile.response.status()).toBe(200);
  });

  test("Forgot password keeps the original destination through a reset", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `recover-next-${runId}@example.com`;
    await registerAccountViaApi(request, email, "Nell", "Next");

    await page.goto("/login?next=%2Fsettings");
    await switchToPasswordMode(page);
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/recover\?next=%2Fsettings$/);
    await expect(heading(page, "Recover your account")).toBeVisible();

    const resetAt = Date.now() - 1000;
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(page.getByLabel("Reset code")).toBeVisible();
    const resetCode = await latestVerificationCode(
      email,
      resetAt,
      "password_reset",
    );
    await page.getByLabel("Reset code").fill(resetCode);
    await page
      .getByLabel("New password", { exact: true })
      .fill("ResetPassword123!");
    await page.getByLabel("Confirm new password").fill("ResetPassword123!");
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page).toHaveURL(
      /\/login\?status=password-reset&next=%2Fsettings$/,
    );
    await expect(
      page.getByText("Password reset complete. Continue with your email."),
    ).toBeVisible();

    await signInWithPassword(page, email, "ResetPassword123!");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(heading(page, "Account settings")).toBeVisible();
  });

  test("temporary access explains missing links, rejects wrong and superseded codes, and signs out only the temporary session", async ({
    browser,
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await page.goto("/temp-access");
    await expect(heading(page, "Access link required")).toBeVisible();
    await expect(
      page.getByText(
        "Open the temporary access link in your invitation email.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.goto("/temp-access?code=NOPE0000");
    await expect(heading(page, "Access link required")).toBeVisible();
    await expect(
      page.getByText(
        "Open the temporary access link in your invitation email. The link only works for its event.",
      ),
    ).toBeVisible();

    const runId = newRunId();
    const { organizer, event, tempEmail, accessPath } =
      await temporaryInvitation(request, runId, "Temi Temporary");
    const storageKey = invitationStorageKey(event.code);

    const tempContext = await browser.newContext();
    try {
      const temp = await tempContext.newPage();
      const firstAt = Date.now() - 1000;
      await temp.goto(accessPath);
      await expect(heading(temp, "Check your email")).toBeVisible();
      await expect(mainStatus(temp)).toHaveText(
        "If this access link is valid, a six-digit code has been sent to its email address.",
      );
      // The invitation token moves out of the address bar into this tab.
      await expect(temp).toHaveURL(
        new RegExp(`/temp-access\\?code=${event.code}$`),
      );
      expect(
        await temp.evaluate(
          (key) => window.sessionStorage.getItem(key),
          storageKey,
        ),
      ).toBeTruthy();
      await expect(
        temp.getByText(
          "This verification only grants access to this event. It does not sign you in to a full Releviz account.",
        ),
      ).toBeVisible();
      const code1 = await latestVerificationCode(
        tempEmail,
        firstAt,
        "temp_event_access",
      );
      await expectAccessible(temp, "temporary access code step");

      const field = temp.getByLabel("Verification code");
      const verify = temp.getByRole("button", {
        name: "Verify and open schedule",
      });
      // Native validation blocks a short code before the page handles it.
      await field.fill("123");
      await verify.click();
      expect(await field.evaluate((el) => el.validity.patternMismatch)).toBe(
        true,
      );
      await expect(heading(temp, "Check your email")).toBeVisible();
      await expect(
        temp.getByText("Enter the six-digit code from your email."),
      ).toHaveCount(0);

      await field.fill(differentCode(code1));
      await verify.click();
      await expect(temp.getByText(WRONG_TEMP_CODE)).toBeVisible();

      // A new code supersedes the first one.
      expireResendCooldown(tempEmail);
      const secondAt = Date.now() - 1000;
      await temp.getByRole("button", { name: "Send a new code" }).click();
      const code2 = await latestVerificationCode(
        tempEmail,
        secondAt,
        "temp_event_access",
        { notCode: code1 },
      );
      await expect(temp.getByText(WRONG_TEMP_CODE)).toHaveCount(0);
      await field.fill(code1);
      await verify.click();
      await expect(temp.getByText(WRONG_TEMP_CODE)).toBeVisible();

      await field.fill(code2);
      await verify.click();
      await expect(heading(temp, event.name)).toBeVisible();
      await expect(
        temp.getByText("You are responding as Temi Temporary"),
      ).toBeVisible();
      const siteNav = temp.getByRole("navigation", { name: "Site" });
      await expect(siteNav.getByText("Temporary event access")).toBeVisible();
      expect(
        await temp.evaluate(
          (key) => window.sessionStorage.getItem(key),
          storageKey,
        ),
      ).toBeNull();
      await expectAccessible(temp, "temporary participant view");

      // A failed revoke keeps the person on the event and says so.
      const logoutRoute = "**/events/temp-access/logout";
      await temp.route(logoutRoute, (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unavailable" }),
        }),
      );
      const signOut = siteNav.getByRole("button", { name: "Sign out" });
      await signOut.click();
      await expect(mainAlert(temp)).toHaveText(
        "Sign out could not be confirmed. This temporary session may still be active; try again before leaving this device.",
      );
      await expect(heading(temp, event.name)).toBeVisible();

      await temp.unroute(logoutRoute);
      await signOut.click();
      await expect(heading(temp, "You are signed out")).toBeVisible();
      await expect(
        temp.getByText(
          "Reopen the invitation email whenever you need to access this event again.",
        ),
      ).toBeVisible();
      await expectAccessible(temp, "temporary signed out");
      const state = await tempAccessSessionState(temp, event.code);
      expect(state.status).toBe(401);
      expect(state.payload?.errorCode).toBe("temp_session_inactive");

      await temp.reload();
      await expect(heading(temp, "Access link required")).toBeVisible();
    } finally {
      await tempContext.close();
    }

    // Signing out ends only the session; the person stays on the roster.
    const roster = await rosterByEmail(request, event.code, organizer.access);
    expect(roster.has(tempEmail.toLowerCase())).toBe(true);
  });

  test("a temporary tab ends access after the same person upgrades in another tab", async ({
    browser,
    request,
  }) => {
    test.setTimeout(150_000);
    const runId = newRunId();
    const { event, tempEmail, accessPath } = await temporaryInvitation(
      request,
      runId,
      "Uma Upgrade",
    );

    const tempContext = await browser.newContext();
    try {
      const tab1 = await tempContext.newPage();
      const accessAt = Date.now() - 1000;
      await tab1.goto(accessPath);
      await expect(heading(tab1, "Check your email")).toBeVisible();
      const accessCode = await latestVerificationCode(
        tempEmail,
        accessAt,
        "temp_event_access",
      );
      await tab1.getByLabel("Verification code").fill(accessCode);
      await tab1
        .getByRole("button", { name: "Verify and open schedule" })
        .click();
      await expect(heading(tab1, event.name)).toBeVisible();

      // The second tab has no invitation in its storage and opens the event
      // from the shared temporary-session cookie.
      const tab2 = await tempContext.newPage();
      await tab2.goto(`/temp-access?code=${event.code}`);
      await expect(heading(tab2, event.name)).toBeVisible();
      await tab2.getByRole("link", { name: "Upgrade to full access" }).click();
      await expect(tab2).toHaveURL(/\/signup\?.*upgrade=temporary/);
      await expect(tab2.getByLabel("Email")).toHaveValue(tempEmail);
      await tab2.getByLabel("First name").fill("Uma");
      await tab2.getByLabel("Last name").fill("Upgrade");
      await tab2.getByLabel("Password", { exact: true }).fill("Password123!");
      await tab2.getByLabel("Confirm password").fill("Password123!");
      const upgradeAt = Date.now() - 1000;
      await tab2
        .getByRole("button", { name: "Send verification code" })
        .click();
      await expect(
        tab2.getByText("Enter the email verification code."),
      ).toBeVisible();
      const upgradeCode = await latestVerificationCode(
        tempEmail,
        upgradeAt,
        "register",
      );
      await tab2.getByLabel("Verification code").fill(upgradeCode);
      await tab2.getByRole("button", { name: "Verify and continue" }).click();
      await expect(tab2).toHaveURL(new RegExp(`/event\\?code=${event.code}$`));

      // The first tab only notices on its next write.
      await tab1.getByRole("button", { name: "Apply to all" }).click();
      await expect(heading(tab1, "Temporary access ended")).toBeVisible();
      await expect(
        tab1.getByText(
          "This account now has full access. Sign in with the full account to continue.",
        ),
      ).toBeVisible();
    } finally {
      await tempContext.close();
    }
  });

  test("upgrade links without a temporary session and legacy sign-in routes lead back to email sign-in", async ({
    page,
  }) => {
    await page.goto("/signup");
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    const sendCode = page.getByRole("button", {
      name: "Send verification code",
    });
    await page.goto("/signup?upgrade=temporary");
    await expect(heading(page, "Upgrade your account")).toBeVisible();
    await expect(
      page.getByText(
        "This upgrade link is incomplete. Reopen the event from your temporary access link.",
      ),
    ).toBeVisible();
    await expect(sendCode).toBeDisabled();

    await page.goto(
      "/signup?upgrade=temporary&code=NOPE0000&next=%2Fevent%3Fcode%3DNOPE0000",
    );
    await expect(
      page.getByText(
        "We could not verify this temporary session. Reopen your event access link and try again.",
      ),
    ).toBeVisible();
    await expect(sendCode).toBeDisabled();
    const continueWithEmail = page.getByRole("link", {
      name: "Continue with email",
    });
    await expect(continueWithEmail).toHaveAttribute(
      "href",
      "/login?next=%2Fevent%3Fcode%3DNOPE0000",
    );
    await continueWithEmail.click();
    await expect(page).toHaveURL(/\/login\?next=%2Fevent%3Fcode%3DNOPE0000$/);
    await expect(heading(page, "Welcome to Releviz")).toBeVisible();

    // Legacy routes redirect on the server.
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/sign-up");
    await expect(page).toHaveURL(/\/signup$/);
    await page.goto("/sign-in/factor-one");
    await expect(page).toHaveURL(/\/login$/);
  });
});
