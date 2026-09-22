const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const { createEvent, readSession, registerAccount } = require("./helpers/releviz");

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
});
