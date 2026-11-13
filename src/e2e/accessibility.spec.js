const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  apiJson,
  createEvent,
  openBlockedTimes,
  readSession,
  registerAccount,
} = require("./helpers/releviz");

test.use({ viewport: { width: 320, height: 720 } });

// Fails when the page scrolls sideways or anything reaches past the viewport
// edge. Content inside a horizontally scrolling box (the calendar canvas, a
// responsive table) may extend past the edge; anything else that reaches past
// it widens the page instead.
async function expectNoHorizontalScroll(page, label) {
  const layout = await page.evaluate(() => {
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
  expect(layout.scrollWidth, `${label} must not scroll horizontally`).toBeLessThanOrEqual(
    layout.clientWidth
  );
  expect(layout.offenders, `elements reaching past the viewport in ${label}`).toEqual([]);
}

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
      ["/email-auth-link", page.getByRole("heading", { name: "Link verification failed" })],
      ["/impersonate-login", page.getByText("No impersonation token provided.")],
      // Without an event code the upgrade page settles on its error state.
      ["/signup?upgrade=temporary", page.getByText("This upgrade link is incomplete.")],
    ]) {
      await page.goto(path);
      await expect(finalState).toBeVisible();
      await expectNoHorizontalScroll(page, path);
      await expectAccessible(page, path);
    }
    await expect(page.getByRole("heading", { name: "Upgrade your account" })).toBeVisible();
  });

  test("signed-in dashboard, delete dialog and edit page meet WCAG A/AA checks at 320px", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
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

  test("account settings with every section open meet WCAG A/AA checks at 320px", async ({
    page,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    await registerAccount(page, `axe-settings-${runId}@example.com`, "Sol", "Settings");
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { level: 1, name: "Account settings" })
    ).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "This device" })).toBeVisible();
    // The password and account-deletion forms sit in collapsed sections, which
    // axe skips until they are open.
    for (const form of ["password", "danger-zone"]) {
      await page.locator(`form#${form} summary`).click();
      await expect(page.locator(`form#${form} details`)).toHaveAttribute("open", "");
    }
    await expectAccessible(page, "settings with every section open");
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

      await expectNoHorizontalScroll(page, "organizer workspace at 375px");
      await expectAccessible(page, "organizer workspace at 375px");

      // Painting blocked times on the calendar at phone width: the step opens
      // without widening the page, a tap paints, and the page stays clean.
      await openBlockedTimes(page);
      await expect(
        page.getByRole("grid", { name: /marking blocked times$/ })
      ).toBeVisible();
      await expectNoHorizontalScroll(page, "organizer workspace at 375px while painting");
      // Pin the cell by index: once painted it no longer matches an "open"
      // locator.
      const firstOpenIndex = await page
        .locator('[data-blocked-paint="false"]')
        .first()
        .getAttribute("data-cell-idx");
      const tappedCell = page.locator(`[data-cell-idx="${firstOpenIndex}"]`);
      await tappedCell.scrollIntoViewIfNeeded();
      const cellBox = await tappedCell.boundingBox();
      await page.touchscreen.tap(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
      await expect(tappedCell).toHaveAttribute("data-blocked-paint", "true");
      await expectAccessible(page, "organizer workspace at 375px, marking blocked times");
    });

    // Every organizer email is reviewed in a two-step dialog before it goes
    // out. Both steps fit a phone and pass the automated checks, and closing
    // the dialog sends nothing.
    // The preview frame holds the email itself, not page UI, and is sandboxed
    // with scripts off, so axe cannot be injected into it: descending into it
    // stalls the scan (WebKit times out). Its title is covered by the unit
    // tests; everything around it is checked here.
    const EMAIL_FRAME = { exclude: ['iframe[title="Email preview"]'] };

    test("email review and confirmation fit a phone and meet WCAG A/AA checks", async ({
      page,
      request,
    }) => {
      const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
      await registerAccount(page, `email-review-${runId}@example.com`, "Rae", "Reviewer");
      const token = (await readSession(page)).access;
      const event = await createEvent(request, token, {
        name: `Email review ${runId}`,
      });
      const inviteeEmail = `invitee-${runId}@example.com`;
      const added = await apiJson(
        request,
        "POST",
        `/events/participants/managed?code=${event.code}`,
        token,
        {
          name: "Ivy Invitee",
          email: inviteeEmail,
          sendInvitation: false,
          idempotencyKey: crypto.randomUUID(),
        }
      );
      expect(added.response.status()).toBe(201);

      await page.goto(`/event?code=${event.code}`);
      const row = page.locator("tr.participants-row", { hasText: "Ivy Invitee" });
      await row.getByRole("button", { name: "Actions for Ivy Invitee" }).click();
      await page.getByRole("menuitem", { name: "Send invitation", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Send invitations" });
      await expect(dialog.getByText("Step 1 of 2: Review")).toBeVisible();
      await expect(dialog.getByText(`Ivy Invitee <${inviteeEmail}>`)).toBeVisible();
      await expect(dialog.locator('iframe[title="Email preview"]')).toBeVisible();
      await expectNoHorizontalScroll(page, "email review at 375px");
      await expectAccessible(page, "email review at 375px", EMAIL_FRAME);

      await dialog.getByRole("tab", { name: "Plain text" }).click();
      await expect(dialog.getByRole("tab", { name: "Plain text" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await expectAccessible(page, "email plain text at 375px", EMAIL_FRAME);

      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "Send 1 invitation now?" })).toBeFocused();
      await expectNoHorizontalScroll(page, "email confirmation at 375px");
      await expectAccessible(page, "email confirmation at 375px", EMAIL_FRAME);

      await dialog.getByRole("button", { name: "Close dialog" }).click();
      await expect(dialog).toHaveCount(0);
      const roster = await apiJson(request, "GET", `/events/roster?code=${event.code}`, token);
      expect(roster.response.status()).toBe(200);
      expect(roster.payload.participants).toEqual([
        expect.objectContaining({ email: inviteeEmail, invitationStatus: "not_sent" }),
      ]);
    });
  });

  test.describe("dark appearance", () => {
    test.use({ colorScheme: "dark", viewport: { width: 1280, height: 800 } });

    // Bootstrap compiles outline buttons and the danger emphasis from the light
    // palette; theme.scss re-tints them for dark mode. The header "Sign in",
    // the dashboard "Delete" and the settings "Delete account" heading on the
    // raised dark surface are the scans that guard those colors.

    test("public and signed-in pages meet WCAG A/AA checks in dark mode", async ({
      page,
      request,
    }) => {
      const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;

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
      // The participants list is the last section to finish loading.
      await expect(page.getByRole("heading", { name: "No participants yet" })).toBeVisible();
      await expectAccessible(page, "organizer workspace dark");

      await page.goto("/settings");
      await expect(page.getByRole("listitem").filter({ hasText: "This device" })).toBeVisible();
      await expectAccessible(page, "settings dark");
    });
  });
});
