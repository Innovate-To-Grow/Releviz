const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  apiJson,
  createEvent,
  newRunId,
  readSession,
  registerAccount,
} = require("./helpers/releviz");

test.use({ viewport: { width: 320, height: 720 } });

test.describe("automated accessibility baseline", () => {
  test("public entry pages meet WCAG A/AA checks at 320px", async ({ page }) => {
    for (const [path, heading] of [
      ["/", "Find a time that works for everyone."],
      // Both entry points render the same sign-in panel in email-code mode.
      ["/login", "Welcome to Releviz"],
      ["/signup", "Welcome to Releviz"],
      ["/recover", "Recover your account"],
      ["/privacy", "Privacy notice"],
      ["/terms", "Terms of service"],
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectAccessible(page, path);
      const horizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(horizontalOverflow, `${path} must not overflow a 320px viewport`).toBeFalsy();
    }
  });

  test("status and error pages meet WCAG A/AA checks at 320px", async ({ page }) => {
    for (const [path, finalState] of [
      ["/this-page-does-not-exist/", page.getByRole("heading", { name: "Page not found" })],
      ["/temp-access", page.getByRole("heading", { name: "Access link required" })],
      ["/email-auth-link", page.getByRole("heading", { name: "Link verification failed" })],
      ["/impersonate-login", page.getByText("No impersonation token provided.")],
      // Without an event code the upgrade page settles on its error state.
      ["/signup?upgrade=temporary", page.getByText("This upgrade link is incomplete.")],
    ]) {
      await page.goto(path);
      await expect(finalState).toBeVisible();
      await expectAccessible(page, path);
      const horizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(horizontalOverflow, `${path} must not overflow a 320px viewport`).toBeFalsy();
    }
    await expect(page.getByRole("heading", { name: "Upgrade your account" })).toBeVisible();
  });

  test("signed-in dashboard, delete dialog and edit page meet WCAG A/AA checks at 320px", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(page, `axe-org-${runId}@example.com`, "Ava", "Axe");
    const token = (await readSession(page)).access;
    const active = await createEvent(request, token, { name: `Axe active ${runId}` });
    const archived = await createEvent(request, token, { name: `Axe archived ${runId}` });
    const archiving = await apiJson(
      request,
      "PUT",
      `/events/lifecycle?code=${archived.code}`,
      token,
      { status: "archived", expectedVersion: archived.version }
    );
    expect(archiving.response.status(), JSON.stringify(archiving.payload)).toBe(200);

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "My Events (1)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Archived (1)" })).toBeVisible();
    await expect(page.getByRole("link", { name: active.name })).toBeVisible();
    await expectAccessible(page, "dashboard with event cards");

    await page
      .getByRole("group", { name: `Actions for ${archived.name}` })
      .getByRole("button", { name: "Delete" })
      .click();
    const dialog = page.getByRole("dialog", { name: `Delete ${archived.name}?` });
    await expect(dialog).toBeVisible();
    await expectAccessible(page, "delete event dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto(`/edit?code=${active.code}`);
    await expect(page.getByRole("heading", { level: 1, name: "Edit event" })).toBeVisible();
    await expectAccessible(page, "edit event");
  });

  test("keyboard focus reaches the login form with a visible indicator", async ({ page }) => {
    await page.goto("/login");
    const email = page.getByLabel("Email");

    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await email.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }

    await expect(email).toBeFocused();
    const focusIndicator = await email.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
    expect(
      focusIndicator.outlineStyle !== "none" ||
        focusIndicator.outlineWidth !== "0px" ||
        focusIndicator.boxShadow !== "none"
    ).toBeTruthy();
  });

  test.describe("organizer workspace at phone width", () => {
    test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

    test("organizer event workspace does not scroll horizontally with a long display name", async ({
      page,
      request,
    }) => {
      const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
      await registerAccount(
        page,
        `workspace-width-${runId}@example.com`,
        "QA0917",
        "Organizer Updated Longname"
      );
      const token = (await readSession(page)).access;
      const event = await createEvent(request, token, {
        name: `Workspace width ${runId}`,
      });

      await page.goto(`/event?code=${event.code}`);
      await expect(page.getByRole("button", { name: "Copy share link" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "QA0917 Organizer Updated Longname" })
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Workspace sections" })
      ).toBeVisible();
      // The roster is the last section to finish loading; wait for it so the
      // whole workspace is measured.
      await expect(page.getByRole("heading", { name: "No participants yet" })).toBeVisible();

      const layout = await page.evaluate(() => {
        // Content inside a horizontally scrolling box (the calendar canvas, a
        // responsive table) may extend past the viewport edge; anything else
        // that reaches past it widens the page instead.
        const insideScroller = (element) => {
          for (let node = element.parentElement; node; node = node.parentElement) {
            const overflowX = window.getComputedStyle(node).overflowX;
            if (overflowX === "auto" || overflowX === "scroll") return true;
          }
          return false;
        };
        const limit = window.innerWidth + 1;
        const offenders = [];
        for (const element of document.querySelectorAll("body *")) {
          if (element.getBoundingClientRect().right <= limit) continue;
          if (insideScroller(element)) continue;
          const tag = element.tagName.toLowerCase();
          const className = (element.getAttribute("class") || "").trim();
          offenders.push(className ? `${tag}.${className.split(/\s+/).join(".")}` : tag);
        }
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          offenders,
        };
      });
      expect(
        layout.scrollWidth,
        "organizer workspace must not overflow a 375px viewport"
      ).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.offenders, "elements reaching past the 375px viewport").toEqual([]);
      await expectAccessible(page, "organizer workspace at 375px");
    });
  });

  test.describe("dark appearance", () => {
    // 1280px keeps the home page clear of the local fontconfig failure at 320px.
    test.use({ colorScheme: "dark", viewport: { width: 1280, height: 800 } });

    // Bootstrap compiles outline buttons and the danger emphasis from the light
    // palette; theme.scss re-tints them for dark mode. The header "Sign in",
    // the dashboard "Delete" and the settings "Delete account" heading on the
    // raised dark surface are the scans that guard those colors.

    test("public and signed-in pages meet WCAG A/AA checks in dark mode", async ({
      page,
      request,
    }) => {
      const runId = newRunId();

      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const appearance = await page.evaluate(() => ({
        prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
        background: window.getComputedStyle(document.body).backgroundColor,
      }));
      expect(appearance.prefersDark).toBe(true);
      const channels = (appearance.background.match(/\d+(\.\d+)?/g) || [])
        .slice(0, 3)
        .map(Number);
      expect(channels, `body background ${appearance.background}`).toHaveLength(3);
      for (const channel of channels) {
        expect(channel, `body background ${appearance.background}`).toBeLessThan(80);
      }
      await expectAccessible(page, "/ dark");

      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Welcome to Releviz" })).toBeVisible();
      await expectAccessible(page, "/login dark");

      await registerAccount(page, `dark-${runId}@example.com`, "Dora", "Dark");
      const token = (await readSession(page)).access;
      const event = await createEvent(request, token, { name: `Dark ${runId}` });

      await page.goto("/dashboard");
      await expect(page.getByRole("link", { name: event.name })).toBeVisible();
      await expectAccessible(page, "dashboard dark");

      await page.goto(`/event?code=${event.code}`);
      await expect(page.getByRole("button", { name: "Copy share link" })).toBeVisible();
      // The roster is the last section to finish loading.
      await expect(page.getByRole("heading", { name: "No participants yet" })).toBeVisible();
      await expectAccessible(page, "organizer workspace dark");

      await page.goto("/settings");
      await expect(page.getByRole("listitem").filter({ hasText: "This device" })).toBeVisible();
      await expectAccessible(page, "settings dark");
    });
  });
});
