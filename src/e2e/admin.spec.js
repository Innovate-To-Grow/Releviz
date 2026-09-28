const { expect, test } = require("@playwright/test");
const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BACKEND_URL,
} = require("./helpers/releviz");

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
