const { expect, test } = require("@playwright/test");
const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BACKEND_URL,
  adminPasswordLogin,
  differentCode,
  latestEmailFor,
  latestVerificationCode,
  memberIdForEmail,
  newRunId,
  registerAccountViaApi,
  runDjangoJson,
} = require("./helpers/releviz");
const { xlsxBuffer, XLSX_MIME } = require("./helpers/roster");

// The Django admin (Unfold): theme switcher, send-test-email, "Login as
// Member", admin invitations, the email-code admin login with its
// remembered-admin screen, and the member import/export tools. The admin,
// the member and the invitee each use their own browser context: cookies are
// host-only for 127.0.0.1 and shared across the frontend and backend ports.

test.use({ viewport: { width: 1440, height: 900 } });

const INVITE_LINK_PATTERN =
  /https?:\/\/[^\s"<>]+\/authn\/invite\/[^\s"<>\/]+\//;

// Creates an admin invitation through the add form and its typed
// confirmation, and returns the time just before the invitation email was
// sent.
async function createAdminInvitation(adminPage, email, message) {
  await adminPage.goto(`${BACKEND_URL}/admin/authn/admininvitation/add/`);
  await adminPage.locator("#id_email").fill(email);
  await adminPage.locator("#id_message").fill(message);
  const startedAt = Date.now() - 1000;
  await adminPage.locator('button[name="_save"]').click();
  await expect(adminPage).toHaveTitle(/Confirm Adding Admin Invitation/);
  const confirm = adminPage.locator("#confirm-btn");
  await expect(confirm).toBeDisabled();
  // The confirmation word is matched case-insensitively.
  await adminPage.locator("#confirm-input").fill("admin invitation");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(
    adminPage.getByText(`Invitation created and sent for ${email}.`),
  ).toBeVisible();
  return startedAt;
}

function adminInvitationLinkFromEmail(body) {
  const match = body.match(INVITE_LINK_PATTERN);
  if (!match)
    throw new Error("The invitation email carries no /authn/invite/ link");
  return match[0].replace(/&amp;/g, "&");
}

function emailSubject(body) {
  return body.match(/^Subject:\s*(.+)$/im)?.[1]?.trim();
}

// A member-import workbook with the template's column names.
function buildMemberImportXlsx(rows) {
  return xlsxBuffer([
    {
      name: "Members",
      rows: [
        [
          "First Name",
          "Last Name",
          "Middle Name",
          "When Started",
          "Last Updated",
          "Primary Email",
          "Primary Verified",
          "Primary Subscribed",
          "Primary Expired",
          "Secondary Email",
          "Secondary Verified",
          "Secondary Subscribed",
        ],
        ...rows,
      ],
    },
  ]);
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

  test("the admin theme switcher persists the choice, and send-test-email reports a missing provider", async ({
    page,
  }) => {
    const runId = newRunId();
    await adminPasswordLogin(page);

    const toggle = page.getByTestId("releviz-admin-theme-toggle").first();
    const html = page.locator("html");
    const themeOptions = toggle.getByRole("navigation", {
      name: "Admin theme options",
    });
    await toggle.getByRole("button", { name: "Switch admin theme" }).click();
    await expect(themeOptions).toBeVisible();
    await themeOptions.getByRole("button", { name: "Dark" }).click();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("adminTheme")))
      .toBe('"dark"');
    await expect(
      toggle.getByRole("button", { name: "Switch admin theme" }),
    ).toContainText("Dark");

    await page.reload();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);

    await toggle.getByRole("button", { name: "Switch admin theme" }).click();
    await expect(themeOptions).toBeVisible();
    await themeOptions.getByRole("button", { name: "Light" }).click();
    await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("adminTheme")))
      .toBe('"light"');

    // No Email Provider is active in the E2E database, so the test send
    // stops before reaching SES.
    await page.goto(`${BACKEND_URL}/admin/mail/emailproviderconfig/`);
    await page.getByRole("link", { name: /Send test email/ }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Send test email" }),
    ).toBeVisible();
    await expect(page.getByText("No active Email Provider.")).toBeVisible();
    await page
      .getByLabel("Recipient email")
      .fill(`admin-test-${runId}@example.com`);
    await page.getByRole("button", { name: /Send email/ }).click();
    await expect(page).toHaveURL(/\/admin\/mail\/emailproviderconfig\/$/);
    await expect(
      page.getByText("No active Email Provider is configured."),
    ).toBeVisible();
  });

  test("Login as Member signs the admin into the member's frontend account once", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const adminContext = await browser.newContext();
    const memberContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await adminPasswordLogin(adminPage);
      const member = await registerAccountViaApi(
        request,
        `impersonated-${runId}@example.com`,
        "Ivy",
        "Impersonated",
      );
      const adminId = memberIdForEmail(ADMIN_EMAIL);

      await adminPage.goto(
        `${BACKEND_URL}/admin/authn/member/${member.user.id}/change/`,
      );
      const link = adminPage.getByTitle("Login as this member on the frontend");
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("target", "_blank");
      const href = await link.getAttribute("href");
      expect(href).toBe(`/admin/authn/member/${member.user.id}/impersonate/`);

      // Read the redirect through the admin context (it carries the admin
      // session) instead of following target=_blank, which would sign the
      // admin's own context into the member's account.
      const minted = await adminPage.request.get(`${BACKEND_URL}${href}`, {
        maxRedirects: 0,
      });
      expect(minted.status()).toBe(302);
      const location = minted.headers()["location"];
      expect(location).toMatch(/\/impersonate-login#token=[\w-]{40,}$/);

      const memberPage = await memberContext.newPage();
      await memberPage.goto("/impersonate-login");
      // Next.js also renders an empty route-announcer alert.
      await expect(
        memberPage
          .getByRole("alert")
          .filter({ hasText: "No impersonation token provided." }),
      ).toBeVisible();
      await expect(
        memberPage.getByRole("link", { name: "Go to Login" }),
      ).toHaveAttribute("href", "/login");

      // The token travels in the hash, so open it from another document.
      await memberPage.goto("about:blank");
      await memberPage.goto(location);
      await expect(memberPage).toHaveURL(/\/dashboard$/);
      expect(memberPage.url()).not.toContain("#");
      await expect(
        memberPage.getByRole("heading", { level: 1, name: "My Dashboard" }),
      ).toBeVisible();
      await expect(
        memberPage.getByRole("button", {
          name: "Ivy Impersonated",
          exact: true,
        }),
      ).toBeVisible();

      // The token is single-use.
      await memberPage.goto(location);
      // Next.js also renders an empty route-announcer alert.
      await expect(
        memberPage.getByRole("alert").filter({
          hasText: "This impersonation link is invalid or has expired.",
        }),
      ).toBeVisible();

      // Staff and superuser accounts cannot be impersonated.
      await adminPage.goto(
        `${BACKEND_URL}/admin/authn/member/${adminId}/change/`,
      );
      await expect(
        adminPage.getByRole("heading", { level: 1 }).first(),
      ).toBeVisible();
      await expect(
        adminPage.getByTitle("Login as this member on the frontend"),
      ).toHaveCount(0);
      const staffAttempt = await adminPage.request.get(
        `${BACKEND_URL}/admin/authn/member/${adminId}/impersonate/`,
        { maxRedirects: 0 },
      );
      expect(staffAttempt.status()).toBe(403);
    } finally {
      await adminContext.close();
      await memberContext.close();
    }
  });

  test("an admin invitation creates a staff account that signs in with an email code and is then remembered", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const runId = newRunId();
    const inviteeEmail = `staff-${runId}@example.com`;
    const password = "Corr3ct-Horse-Battery!";
    const adminContext = await browser.newContext();
    const inviteeContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await adminPasswordLogin(adminPage);
      const invitedAt = await createAdminInvitation(
        adminPage,
        inviteeEmail,
        "Welcome aboard",
      );
      const body = await latestEmailFor(inviteeEmail, invitedAt, (message) =>
        message.includes("/authn/invite/"),
      );
      expect(emailSubject(body)).toBe("You're invited to join Releviz Admin");
      const link = adminInvitationLinkFromEmail(body);
      expect(link.startsWith(`${BACKEND_URL}/authn/invite/`)).toBe(true);

      const invitee = await inviteeContext.newPage();
      await invitee.goto(link);
      await expect(invitee).toHaveTitle(/Accept Invitation/);
      await expect(invitee.getByText("You're invited to join")).toBeVisible();
      await expect(invitee.locator("#id_email")).toHaveValue(inviteeEmail);
      await expect(invitee.locator("#id_email")).toBeDisabled();

      await invitee.locator("#id_first_name").fill("Ines");
      await invitee.locator("#id_last_name").fill("Staff");
      await invitee.locator("#id_password1").fill(password);
      await invitee.locator("#id_password2").fill("Different-Horse-9!");
      await invitee.getByRole("button", { name: /Create account/ }).click();
      await expect(invitee.getByText("Passwords do not match.")).toBeVisible();

      // Password inputs are not re-rendered after a failed POST.
      await invitee.locator("#id_password1").fill(password);
      await invitee.locator("#id_password2").fill(password);
      await invitee.getByRole("button", { name: /Create account/ }).click();
      await expect(
        invitee.getByRole("heading", { name: "Account Created" }),
      ).toBeVisible();
      await expect(
        invitee.getByText("Your admin account has been created successfully."),
      ).toBeVisible();
      await expect(
        invitee.getByRole("link", { name: /Log in to admin/ }),
      ).toHaveAttribute("href", "/admin/login/");

      const reopened = await invitee.goto(link);
      expect(reopened.status()).toBe(400);
      await expect(
        invitee.getByRole("heading", { name: "Invalid Invitation" }),
      ).toBeVisible();
      await expect(
        invitee.getByText(
          "This invitation link is invalid, has expired, or has already been used.",
        ),
      ).toBeVisible();

      await invitee.goto(`${BACKEND_URL}/admin/login/`);
      await invitee.locator("#id_email").fill(inviteeEmail);
      const requestedAt = Date.now() - 1000;
      await invitee
        .getByRole("button", { name: "Send verification code" })
        .click();
      await expect(invitee.getByText("Enter verification code")).toBeVisible();
      await expect(
        invitee.getByText("We sent a 6-digit code to"),
      ).toBeVisible();
      await expect(invitee.locator(".login-email-hint strong")).toHaveText(
        inviteeEmail,
      );
      await expect(
        invitee.getByText("A verification code has been sent to your email."),
      ).toBeVisible();
      const code = await latestVerificationCode(
        inviteeEmail,
        requestedAt,
        "admin_login",
      );

      // A resend inside the cooldown is refused and the first code stays
      // valid.
      await invitee.getByRole("button", { name: "Resend code" }).click();
      await expect(
        invitee.getByText("Please wait before requesting another code."),
      ).toBeVisible();

      await invitee.locator("#id_code").fill(differentCode(code));
      await invitee.getByRole("button", { name: /Verify and sign in/ }).click();
      await expect(
        invitee.getByText("Verification code is invalid or has expired."),
      ).toBeVisible();

      await invitee.locator("#id_code").fill(code);
      await invitee.getByRole("button", { name: /Verify and sign in/ }).click();
      await expect(invitee).toHaveURL(/\/admin\/$/);

      // Signing out of the session keeps the remembered-admin cookie.
      await inviteeContext.clearCookies({ name: "sessionid" });
      await invitee.goto(`${BACKEND_URL}/admin/login/`);
      await expect(invitee.getByText("Last signed in")).toBeVisible();
      await expect(invitee.getByText("Ines Staff")).toBeVisible();
      await expect(invitee.locator("#id_email")).toHaveCount(0);
      await expect(invitee.locator("#id_password")).toBeVisible();
      await expect(
        invitee.getByRole("button", { name: "Sign In" }),
      ).toBeVisible();
      await expect(
        invitee.getByRole("button", { name: "Send verification code instead" }),
      ).toBeVisible();
      await expect(
        invitee.getByRole("link", { name: "Use a different email" }),
      ).toBeVisible();

      await invitee.locator("#id_password").fill(password);
      await invitee.getByRole("button", { name: "Sign In" }).click();
      await expect(invitee).toHaveURL(/\/admin\/$/);
    } finally {
      await adminContext.close();
      await inviteeContext.close();
    }
  });

  test("an invitation grants admin access to an existing account that could not request an admin code before", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const runId = newRunId();
    const existingEmail = `grant-${runId}@example.com`;
    await registerAccountViaApi(request, existingEmail, "Gus", "Grant");
    const adminContext = await browser.newContext();
    const grantContext = await browser.newContext();
    try {
      const grantee = await grantContext.newPage();
      await grantee.goto(`${BACKEND_URL}/admin/login/`);
      await grantee.locator("#id_email").fill(existingEmail);
      await grantee
        .getByRole("button", { name: "Send verification code" })
        .click();
      await expect(
        grantee.getByText("Unable to send verification code."),
      ).toBeVisible();
      await expect(grantee.getByText("Welcome back to")).toBeVisible();

      const adminPage = await adminContext.newPage();
      await adminPasswordLogin(adminPage);
      const invitedAt = await createAdminInvitation(
        adminPage,
        existingEmail,
        "",
      );
      const body = await latestEmailFor(existingEmail, invitedAt, (message) =>
        message.includes("/authn/invite/"),
      );
      const link = adminInvitationLinkFromEmail(body);

      await grantee.goto(link);
      await expect(
        grantee.getByRole("heading", { name: "Confirm Admin Access" }),
      ).toBeVisible();
      await expect(
        grantee.getByText(`An account for ${existingEmail} already exists.`),
      ).toBeVisible();
      await grantee.getByRole("button", { name: /Grant admin access/ }).click();
      await expect(
        grantee.getByRole("heading", { name: "Permissions Updated" }),
      ).toBeVisible();
      await expect(
        grantee.getByText(
          "Your admin permissions have been granted. You can now log in.",
        ),
      ).toBeVisible();

      await grantee.goto(`${BACKEND_URL}/admin/login/`);
      await grantee.locator("#id_email").fill(existingEmail);
      const requestedAt = Date.now() - 1000;
      await grantee
        .getByRole("button", { name: "Send verification code" })
        .click();
      await expect(grantee.getByText("Enter verification code")).toBeVisible();
      const code = await latestVerificationCode(
        existingEmail,
        requestedAt,
        "admin_login",
      );
      await grantee.locator("#id_code").fill(code);
      await grantee.getByRole("button", { name: /Verify and sign in/ }).click();
      await expect(grantee).toHaveURL(/\/admin\/$/);
    } finally {
      await adminContext.close();
      await grantContext.close();
    }
  });

  test("member import and export downloads, and confirmed deactivation of an imported member", async ({
    page,
  }) => {
    const runId = newRunId();
    const importEmail = `imported-${runId}@example.com`;
    await adminPasswordLogin(page);

    await page.goto(`${BACKEND_URL}/admin/authn/member/`);
    const exported = page.waitForEvent("download");
    await page.getByRole("link", { name: /Export Excel/ }).click();
    expect((await exported).suggestedFilename()).toMatch(
      /^members_export_\d{8}_\d{6}\.xlsx$/,
    );

    await page.getByRole("link", { name: /Import Excel/ }).click();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Import Members from Excel",
      }),
    ).toBeVisible();
    const template = page.waitForEvent("download");
    await page.getByRole("link", { name: /Download Import Template/ }).click();
    expect((await template).suggestedFilename()).toBe(
      "member_import_template.xlsx",
    );

    const fileInput = page.locator("#id_excel_file");
    await fileInput.setInputFiles({
      name: "members.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not a spreadsheet"),
    });
    await page.getByRole("button", { name: /Start Import/ }).click();
    await expect(
      page.getByText("Please upload a .xlsx or .xls format file"),
    ).toBeVisible();

    await fileInput.setInputFiles({
      name: "members.xlsx",
      mimeType: XLSX_MIME,
      buffer: buildMemberImportXlsx([
        [
          "Imp",
          "Orted",
          null,
          null,
          null,
          importEmail,
          "FALSE",
          "FALSE",
          "FALSE",
          null,
          null,
          null,
        ],
      ]),
    });
    await page.getByRole("button", { name: /Start Import/ }).click();
    await expect(
      page.getByText("Import complete: 1 created, 0 updated, 0 skipped"),
    ).toBeVisible();

    // Deactivate only the member this test imported.
    await page.goto(
      `${BACKEND_URL}/admin/authn/member/?q=${encodeURIComponent(importEmail)}`,
    );
    const rowCheckbox = page.locator('input[name="_selected_action"]');
    await expect(rowCheckbox).toHaveCount(1);
    await rowCheckbox.check();
    await expect(rowCheckbox).toBeChecked();
    await page
      .locator('select[name="action"]')
      .selectOption("deactivate_members");
    await page.locator('button[name="index"]').click();
    await expect(page).toHaveTitle(/Confirm Action/);
    // The confirmation word is the model's verbose name, which the Member
    // model inherits from Django's user model.
    await expect(page.getByLabel('Type "user" to confirm:')).toBeVisible();
    const confirm = page.locator("#confirm-send-btn");
    await expect(confirm).toBeDisabled();
    await page.locator("#confirm-input").fill("user");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText("1 member(s) deactivated.")).toBeVisible();

    const active = runDjangoJson(
      `
from apps.authn.models import ContactEmail

contact = ContactEmail.objects.select_related("member").get(
    email_address__iexact=data["email"]
)
print(json.dumps(contact.member.is_active))
`,
      { email: importEmail },
    );
    expect(active).toBe(false);
  });
});
