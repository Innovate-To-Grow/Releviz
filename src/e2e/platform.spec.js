const { expect, test } = require("@playwright/test");
const { BACKEND_URL } = require("./helpers/releviz");

// The platform surface outside the UI: the health probes, the disabled
// legacy /api prefix, the CSP report endpoint and the frontend's security
// headers, plus a check in every engine that public pages load without a
// Content-Security-Policy violation.

const CSP_CONSOLE_PATTERN =
  /Content[- ]Security[- ]Policy|Refused to (load|execute|apply|connect)/i;

// Records `securitypolicyviolation` events in every document the page opens
// and CSP messages the engine logs to the console. The returned collector
// reports what the current document saw since it loaded. Other console
// output, such as the signed-out 401 from /authn/refresh/, is ignored.
async function watchCspViolations(page) {
  const consoleMessages = [];
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__csp.push(
        `${event.effectiveDirective || event.violatedDirective} blocked ${event.blockedURI || "inline"}`,
      );
    });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (CSP_CONSOLE_PATTERN.test(text)) consoleMessages.push(text);
  });
  return async () => {
    const events = await page.evaluate(() => window.__csp || []);
    const found = [...events, ...consoleMessages.splice(0)];
    const path = new URL(page.url()).pathname;
    return found.map((entry) => `${path}: ${entry}`);
  };
}

test.describe("Platform endpoints", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "browser-independent HTTP checks run once",
  );

  test("health probes, legacy /api prefix, CSP report endpoint and frontend security headers", async ({
    request,
  }) => {
    for (const path of ["/health", "/health/ready"]) {
      const response = await request.get(`${BACKEND_URL}${path}`);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["cache-control"], path).toContain("no-store");
      const payload = await response.json();
      expect(payload.ok, path).toBe(true);
      expect(payload.checks, path).toEqual({ database: "ok" });
      // The release is whatever the deployment set; only its key is fixed.
      expect(Object.keys(payload).sort(), path).toEqual([
        "checks",
        "ok",
        "release",
      ]);
    }
    const live = await request.get(`${BACKEND_URL}/health/live`);
    expect(live.status()).toBe(200);
    expect(live.headers()["cache-control"]).toContain("no-store");
    const livePayload = await live.json();
    expect(livePayload.ok).toBe(true);
    expect(Object.keys(livePayload).sort()).toEqual(["ok", "release"]);

    const posted = await request.post(`${BACKEND_URL}/health`);
    expect(posted.status()).toBe(405);
    expect(await posted.json()).toEqual({
      detail: 'Method "POST" not allowed.',
    });

    // The legacy /api prefix is disabled outside an explicit production
    // opt-in, so the old health path no longer resolves.
    const legacy = await request.get(`${BACKEND_URL}/api/health`);
    expect(legacy.status()).toBe(404);

    // The report endpoint answers 204 for a report and for junk alike, and
    // refuses oversized bodies before reading them. Only four requests are
    // sent, well under its per-address rate limit (which would also answer
    // 204 and hide the 413).
    const cspReport = `${BACKEND_URL}/csp-report/`;
    const report = await request.post(cspReport, {
      headers: { "Content-Type": "application/csp-report" },
      data: JSON.stringify({
        "csp-report": {
          "document-uri": "http://127.0.0.1/",
          "violated-directive": "script-src-elem",
          "blocked-uri": "https://example.invalid/script.js?token=secret",
        },
      }),
    });
    expect(report.status()).toBe(204);
    const junk = await request.post(cspReport, {
      headers: { "Content-Type": "application/csp-report" },
      data: "not json",
    });
    expect(junk.status()).toBe(204);
    const oversized = await request.post(cspReport, {
      headers: { "Content-Type": "application/csp-report" },
      data: "x".repeat(5000),
    });
    expect(oversized.status()).toBe(413);
    const fetched = await request.get(cspReport);
    expect(fetched.status()).toBe(405);

    const home = await request.get("/");
    expect(home.status()).toBe(200);
    const headers = home.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    const csp = headers["content-security-policy"];
    for (const directive of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "form-action 'self'",
      `connect-src 'self' ${new URL(BACKEND_URL).origin}`,
    ]) {
      expect(csp).toContain(directive);
    }
    // The E2E server runs over plain HTTP and in production mode.
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
  });
});

test.describe("Content-Security-Policy in real browsers", () => {
  test("public and status pages load without Content-Security-Policy violations", async ({
    page,
  }) => {
    const collect = await watchCspViolations(page);
    const violations = [];
    for (const [path, heading] of [
      ["/", "Find a time that works for everyone."],
      ["/login", "Welcome to Releviz"],
      ["/signup", "Welcome to Releviz"],
      ["/recover", "Recover your account"],
      ["/privacy", "Privacy notice"],
      ["/terms", "Terms of service"],
      ["/temp-access", "Access link required"],
      ["/email-auth-link", "Link verification failed"],
      ["/this-page-does-not-exist/", "Page not found"],
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      violations.push(...(await collect()));
    }
    expect(violations).toEqual([]);
  });
});
