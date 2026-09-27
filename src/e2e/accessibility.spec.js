const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const { apiJson, createEvent, readSession, registerAccount } = require("./helpers/releviz");

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
});
