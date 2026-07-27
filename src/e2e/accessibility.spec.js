const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");

test.use({ viewport: { width: 320, height: 720 } });

test.describe("automated accessibility baseline", () => {
  test("public entry pages meet WCAG A/AA checks at 320px", async ({ page }) => {
    for (const [path, heading] of [
      ["/", "Find a time that works for everyone."],
      ["/login", "Log in"],
      ["/signup", "Create account"],
      ["/recover", "Recover your account"],
      ["/privacy", "Privacy notice"],
      ["/terms", "Terms of service"],
      ["/support", "How can we help?"],
      ["/feedback", "Send feedback"],
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

  test("anonymous feedback submits at 320px without exposing source-page secrets", async ({
    page,
  }) => {
    await page.goto("/feedback?from=%2Fevent%3Fcode%3DPRIVATE%23availability");
    await page.getByLabel("Feedback type").selectOption("usability");
    await page
      .getByLabel("What happened, or what would you change?")
      .fill("The final-time review needed a clearer explanation.");
    await page
      .getByLabel(/service team may follow up using my account contact information/)
      .check();

    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.url().endsWith("/api/feedback") && candidate.request().method() === "POST"
      ),
      page.getByRole("button", { name: "Send feedback" }).click(),
    ]);

    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toEqual({
      category: "usability",
      message: "The final-time review needed a clearer explanation.",
      pagePath: "/event",
      consentToFollowUp: true,
    });
    await expect(page.getByText("Thank you. Your feedback was received.")).toBeVisible();
    await expect(page.getByLabel("What happened, or what would you change?")).toHaveValue("");
    await expectAccessible(page, "submitted feedback");
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(horizontalOverflow).toBeFalsy();
  });
});
