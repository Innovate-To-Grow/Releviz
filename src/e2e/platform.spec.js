const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  BACKEND_URL,
  FRONTEND_URL,
  PYTHON_BIN,
  ROOT,
  createEvent,
  latestEmailFor,
  newRunId,
  passwordLoginViaApi,
  readSession,
  registerAccount,
  registerAccountViaApi,
  runBackendCommand,
  runDjangoJson,
  runDjangoScript,
} = require("./helpers/releviz");

// The platform around the screens: the health probes and the ALB host
// normalization, the disabled legacy /api prefix, request IDs and request
// telemetry, CORS, the CSP report endpoint, the ASGI request-body cap and
// lifespan handshake, the maintenance bypass, the setup and maintenance
// management commands, and the frontend's security headers as real browsers
// enforce them. Most checks are plain HTTP against the running server; what
// cannot be provoked there without disturbing other tests (a database
// outage, the log lines, uvicorn's lifespan driver) runs the same app
// in-process.

const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;
const BACKEND_ORIGIN = new URL(BACKEND_URL).origin;
const EXPOSED_HEADERS = [
  "Retry-After",
  "X-Live-Stream-Unavailable",
  "Content-Disposition",
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CSP_CONSOLE_PATTERN =
  /Content[- ]Security[- ]Policy|Refused to (load|execute|apply|connect|frame|display)/i;
// A document on an origin the API does not trust. Playwright answers its
// requests, so nothing listens there.
const FOREIGN_SITE = "http://localhost:5999";
// uvicorn trusts X-Forwarded-For from the loopback proxy, so a request can
// report a made-up client address; the CSP report endpoint rate limits per
// address, and each test uses its own.
function madeUpAddress() {
  return `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
}
// The synchronous Django helpers block Node's event loop, so an idle
// keep-alive socket the server closed meanwhile can still look reusable and
// fail with ECONNRESET on the next call. Direct API calls retry that one
// network error; the server never saw the failed attempt.
const STALE_SOCKET_RETRIES = 2;

function chromiumOnly(reason) {
  test.skip(({ browserName }) => browserName !== "chromium", reason);
}

const BROWSER_NEUTRAL =
  "Browser-neutral HTTP checks against the shared backend; run them once per suite run";

function backendEnv(overrides = {}) {
  return {
    ...process.env,
    PYTHONPATH: path.join(ROOT, "src/api"),
    DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    ...overrides,
  };
}

// runDjangoJson with environment overrides for the Python process (the
// helper always passes the test's own environment).
function djangoJsonWithEnv(body, { data = {}, env = {} } = {}) {
  const output = execFileSync(
    PYTHON_BIN,
    [
      "-c",
      `import json, os, sys, django\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")\ndjango.setup()\ndata = json.loads(sys.argv[1])\n${body}`,
      JSON.stringify(data),
    ],
    {
      cwd: ROOT,
      env: backendEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  return JSON.parse(lines[lines.length - 1]);
}

// A management command that must refuse: returns its stderr.
function commandRefusal(command, ...args) {
  try {
    runBackendCommand(command, ...args);
  } catch (error) {
    return String(error.stderr || error.message);
  }
  throw new Error(`${command} ${args.join(" ")} did not fail`);
}

// Runs a management command in-process with one model's default manager
// narrowed to `scope`, and returns its stdout. The command's own code runs
// unchanged, but a sweep over the whole table (expired roster previews,
// claimable background jobs) sees only this test's rows: other tests keep
// their own previews and jobs in states such a sweep would change under them
// (participants-import.spec.js expires its previews itself, admin.spec.js
// queues jobs no worker may pick up).
function runCommandScopedTo(command, args, model, scope) {
  return runDjangoJson(
    `
import io
from unittest import mock

from django.apps import apps
from django.core.management import call_command

manager = apps.get_model(data["model"]).objects
unscoped = manager.filter


def scoped(*args, **kwargs):
    return unscoped(*args, **kwargs).filter(**data["scope"])


out = io.StringIO()
with mock.patch.object(manager, "filter", scoped):
    call_command(data["command"], *data["args"], stdout=out)
print(json.dumps(out.getvalue()))
`,
    { command, args, model, scope },
  );
}

async function get(request, url, headers = {}) {
  return request.get(`${BACKEND_URL}${url}`, {
    headers,
    maxRetries: STALE_SOCKET_RETRIES,
  });
}

// One raw HTTP/1.1 exchange with the API on a fresh connection, for what
// APIRequestContext cannot send: a Host header of the test's choosing, or a
// body that is declared or streamed past the server's cap. `body` is written
// as given. `chunks` streams `count` copies of `buffer` and then `tail` with
// chunked encoding, and ends the body only when `end` is set: a refused body
// stays open, so the server has read every byte it was sent when it answers
// and closes the connection cleanly.
function rawExchange({ method = "GET", urlPath, headers = {}, body, chunks }) {
  const target = new URL(urlPath, BACKEND_URL);
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: false,
    });
    request.on("response", (response) => {
      const parts = [];
      response.on("data", (part) => parts.push(part));
      response.on("end", () => {
        settled = true;
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(parts).toString("utf8"),
        });
        request.destroy();
      });
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    if (chunks) {
      let written = 0;
      const pump = () => {
        while (written < chunks.count) {
          written += 1;
          if (!request.write(chunks.buffer)) {
            request.once("drain", pump);
            return;
          }
        }
        if (chunks.tail) request.write(chunks.tail);
        if (chunks.end) request.end();
      };
      pump();
    } else if (body !== undefined) {
      request.end(body);
    } else if (headers["Content-Length"]) {
      // Declared but never sent: the server must answer from the headers.
      request.flushHeaders();
    } else {
      request.end();
    }
  });
}

// Serializes the tests that switch the site-wide maintenance flag, across
// the workers of this run (and repeated runs of the same test).
const MAINTENANCE_LOCK = path.join(
  os.tmpdir(),
  "releviz-e2e-maintenance-flag.lock",
);

function tryMaintenanceLock() {
  try {
    fs.mkdirSync(MAINTENANCE_LOCK);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      // A lock left by a killed worker is released after two minutes.
      if (Date.now() - fs.statSync(MAINTENANCE_LOCK).mtimeMs > 120_000) {
        fs.rmSync(MAINTENANCE_LOCK, { recursive: true, force: true });
      }
    } catch {
      // Released meanwhile.
    }
    return false;
  }
}

async function withMaintenanceLock(work) {
  await expect
    .poll(tryMaintenanceLock, {
      timeout: 60_000,
      intervals: [100, 250, 500],
      message: "the maintenance flag lock",
    })
    .toBe(true);
  try {
    return await work();
  } finally {
    fs.rmSync(MAINTENANCE_LOCK, { recursive: true, force: true });
  }
}

// The maintenance singleton's fields. Reading it through load() creates the
// row with its defaults if it is missing, exactly as the bypass endpoint's
// first call would, so a restore never has to delete it (the admin test
// opens its change page).
function maintenanceState() {
  return runDjangoJson(`
from apps.core.models import SiteMaintenanceControl

SiteMaintenanceControl.load()
print(json.dumps(SiteMaintenanceControl.objects.filter(pk=1).values(
    "is_maintenance", "bypass_password", "message"
).get()))
`);
}

// Records `securitypolicyviolation` events in every document the page opens
// and CSP errors the engine logs. The returned collector reports what the
// current document saw since it loaded.
async function watchCspViolations(page) {
  const consoleMessages = [];
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push(
        `${event.effectiveDirective || event.violatedDirective} blocked ${event.blockedURI || "inline"}`,
      );
    });
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      CSP_CONSOLE_PATTERN.test(message.text())
    ) {
      consoleMessages.push(message.text());
    }
  });
  return async () => {
    const events = await page.evaluate(() => window.__cspViolations || []);
    const found = [...events, ...consoleMessages.splice(0)];
    const where = new URL(page.url()).pathname;
    return found.map((entry) => `${where}: ${entry}`);
  };
}

function expectFrontendSecurityHeaders(headers, where) {
  expect(headers["x-content-type-options"], where).toBe("nosniff");
  expect(headers["x-frame-options"], where).toBe("DENY");
  expect(headers["referrer-policy"], where).toBe("no-referrer");
  const csp = headers["content-security-policy"];
  expect(csp, where).toBeTruthy();
  const directives = new Map(
    csp
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/);
        return [name, sources];
      }),
  );
  expect(directives.get("default-src"), where).toEqual(["'self'"]);
  expect(directives.get("frame-ancestors"), where).toEqual(["'none'"]);
  expect(directives.get("object-src"), where).toEqual(["'none'"]);
  expect(directives.get("base-uri"), where).toEqual(["'self'"]);
  expect(directives.get("form-action"), where).toEqual(["'self'"]);
  // The page may talk to itself, the API origin and the bot challenge only.
  expect(directives.get("connect-src"), where).toEqual([
    "'self'",
    BACKEND_ORIGIN,
    "https://challenges.cloudflare.com",
  ]);
  // Production builds never allow eval. The E2E server runs over plain HTTP,
  // so it leaves out upgrade-insecure-requests.
  expect(directives.get("script-src"), where).not.toContain("'unsafe-eval'");
  expect(directives.has("upgrade-insecure-requests"), where).toBe(false);
}

test.describe("Health probes and request plumbing", () => {
  chromiumOnly(BROWSER_NEUTRAL);

  test("the probes answer uncached, readiness checks the database, POST is refused, only ALB probes get their Host normalized, and the legacy /api prefix is gone", async ({
    request,
  }) => {
    for (const probe of ["/health", "/health/ready"]) {
      const response = await get(request, probe);
      expect(response.status(), probe).toBe(200);
      expect(response.headers()["cache-control"], probe).toContain("no-store");
      const payload = await response.json();
      expect(payload, probe).toEqual({
        ok: true,
        checks: { database: "ok" },
        release: payload.release,
      });
      // The release is whatever the deployment set, or null without one.
      expect(
        payload.release === null || typeof payload.release === "string",
        probe,
      ).toBe(true);
    }
    const live = await get(request, "/health/live");
    expect(live.status()).toBe(200);
    expect(live.headers()["cache-control"]).toContain("no-store");
    const livePayload = await live.json();
    expect(Object.keys(livePayload).sort()).toEqual(["ok", "release"]);
    expect(livePayload.ok).toBe(true);

    for (const probe of ["/health", "/health/live", "/health/ready"]) {
      const posted = await request.post(`${BACKEND_URL}${probe}`, {
        maxRetries: STALE_SOCKET_RETRIES,
      });
      expect(posted.status(), probe).toBe(405);
      expect(await posted.json(), probe).toEqual({
        detail: 'Method "POST" not allowed.',
      });
    }

    // Application Load Balancer probes arrive with the target's private IP
    // as Host. Only that exact user agent, on the health paths, is let
    // through; any other request with an unknown Host is refused.
    const albProbe = { "User-Agent": "ELB-HealthChecker/2.0" };
    const privateHost = { Host: "10.0.12.34" };
    const normalized = await rawExchange({
      urlPath: "/health",
      headers: { ...privateHost, ...albProbe },
    });
    expect(normalized.status).toBe(200);
    expect(JSON.parse(normalized.body)).toMatchObject({
      ok: true,
      checks: { database: "ok" },
    });
    expect(
      (
        await rawExchange({
          urlPath: "/health/live",
          headers: { ...privateHost, ...albProbe },
        })
      ).status,
    ).toBe(200);
    for (const [what, exchange] of [
      [
        "an ordinary client with an unknown Host",
        { urlPath: "/health", headers: privateHost },
      ],
      [
        "an ALB user agent outside the health paths",
        {
          urlPath: "/authn/public-key/",
          headers: { ...privateHost, ...albProbe },
        },
      ],
      [
        "an ALB probe on the retired /api prefix",
        { urlPath: "/api/health", headers: { ...privateHost, ...albProbe } },
      ],
      [
        "a look-alike user agent",
        {
          urlPath: "/health",
          headers: {
            ...privateHost,
            "User-Agent": "ELB-HealthChecker/2.0 (x)",
          },
        },
      ],
    ]) {
      expect((await rawExchange(exchange)).status, what).toBe(400);
    }

    // The legacy /api prefix is disabled outside an explicit production
    // opt-in, so the old paths no longer resolve.
    for (const legacy of [
      "/api/health",
      "/api/health/live",
      "/api/csp-report/",
    ]) {
      expect((await get(request, legacy)).status(), legacy).toBe(404);
    }
  });

  test("readiness answers 503 while the database is unreachable and liveness stays up", async () => {
    // A second copy of the app, in-process with Django's test client and
    // pointed at a port nothing listens on: the running server's database
    // stays untouched.
    const probes = djangoJsonWithEnv(
      `
from django.test import Client

client = Client()
result = {}
for path in ["/health", "/health/ready", "/health/live"]:
    response = client.get(path, HTTP_HOST="127.0.0.1")
    result[path] = {
        "status": response.status_code,
        "body": response.json(),
        "cacheControl": response.get("Cache-Control", ""),
        "requestId": response.get("X-Request-ID", ""),
    }
print(json.dumps(result))
`,
      {
        env: {
          DB_HOST: "127.0.0.1",
          DB_PORT: "1",
          PGCONNECT_TIMEOUT: "5",
          E2E_ENDPOINT_LOG: "",
        },
      },
    );
    for (const probe of ["/health", "/health/ready"]) {
      expect(probes[probe].status, probe).toBe(503);
      expect(probes[probe].body, probe).toEqual({
        ok: false,
        checks: { database: "unavailable" },
        release: probes[probe].body.release,
      });
      expect(probes[probe].cacheControl, probe).toContain("no-store");
      expect(probes[probe].requestId, probe).toMatch(UUID_PATTERN);
    }
    expect(probes["/health/live"].status).toBe(200);
    expect(probes["/health/live"].body.ok).toBe(true);
    expect(probes["/health/live"].cacheControl).toContain("no-store");
  });

  test("every response carries a request ID: a valid inbound one is echoed in canonical form, anything else is replaced", async ({
    request,
  }) => {
    const inbound = crypto.randomUUID();
    const cases = [
      ["a lower-case UUID", inbound, inbound],
      ["an upper-case UUID", inbound.toUpperCase(), inbound],
      ["a URN", `urn:uuid:${inbound}`, inbound],
    ];
    for (const [what, sent, echoed] of cases) {
      const response = await get(request, "/health/live", {
        "X-Request-ID": sent,
      });
      expect(response.headers()["x-request-id"], what).toBe(echoed);
    }
    const generated = new Set();
    for (const [what, headers] of [
      ["no header", {}],
      ["a non-UUID", { "X-Request-ID": "not-a-uuid" }],
      ["an injection attempt", { "X-Request-ID": "abc; drop table" }],
    ]) {
      const response = await get(request, "/health/live", headers);
      const id = response.headers()["x-request-id"];
      expect(id, what).toMatch(UUID_PATTERN);
      expect(id, what).not.toBe(inbound);
      generated.add(id);
    }
    expect(generated.size).toBe(3);

    // Refusals and errors carry one too: the caller's own ID when it sent
    // one, a fresh one otherwise.
    const refusals = [
      [
        "404",
        (headers) => get(request, `/no-such-route-${newRunId()}`, headers),
      ],
      ["401", (headers) => get(request, "/authn/profile/", headers)],
      [
        "405",
        (headers) =>
          request.post(`${BACKEND_URL}/health`, {
            headers,
            maxRetries: STALE_SOCKET_RETRIES,
          }),
      ],
    ];
    for (const [what, send] of refusals) {
      const traced = crypto.randomUUID();
      const echoed = await send({ "X-Request-ID": traced });
      expect(echoed.headers()["x-request-id"], what).toBe(traced);
      const untraced = (await send({})).headers()["x-request-id"];
      expect(untraced, what).toMatch(UUID_PATTERN);
      expect(untraced, what).not.toBe(traced);
    }
  });

  test("request telemetry logs the route pattern, status, duration and request ID, never the URL's values", async () => {
    // The app in-process with Django's test client and the production log
    // formatter attached, so the emitted lines can be read back.
    const requestId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const lines = djangoJsonWithEnv(
      `
import io
import logging

from django.test import Client

from apps.core.utils.logging import JsonFormatter, RequestContextFilter

stream = io.StringIO()
handler = logging.StreamHandler(stream)
handler.addFilter(RequestContextFilter())
handler.setFormatter(JsonFormatter())
logger = logging.getLogger("releviz.requests")
logger.addHandler(handler)
logger.setLevel(logging.INFO)

client = Client()
client.get("/health/live?token=secret-token", HTTP_HOST="127.0.0.1", HTTP_X_REQUEST_ID=data["requestId"])
client.get(f"/authn/contact-emails/{data['contactId']}/?email=someone@example.com", HTTP_HOST="127.0.0.1")
client.get("/no-such-route/secret-path", HTTP_HOST="127.0.0.1")
print(json.dumps([json.loads(line) for line in stream.getvalue().splitlines()]))
`,
      { data: { requestId, contactId }, env: { E2E_ENDPOINT_LOG: "" } },
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatchObject({
        logger: "releviz.requests",
        event: "request_completed",
        method: "GET",
      });
      expect(line.request_id).toMatch(UUID_PATTERN);
      expect(typeof line.duration_ms).toBe("number");
    }
    expect(lines[0]).toMatchObject({
      path: "/health/live",
      status_code: 200,
      request_id: requestId,
    });
    expect(lines[1]).toMatchObject({
      path: "/authn/contact-emails/<uuid:pk>/",
      status_code: 401,
    });
    expect(lines[2]).toMatchObject({ path: "<unresolved>", status_code: 404 });
    const logged = JSON.stringify(lines);
    for (const value of [
      "secret-token",
      "someone@example.com",
      contactId,
      "secret-path",
    ]) {
      expect(logged).not.toContain(value);
    }
  });

  test("CORS lets only the frontend origin make credentialed calls and exposes the headers the app reads", async ({
    request,
  }) => {
    const preflight = (origin) =>
      request.fetch(`${BACKEND_URL}/authn/refresh/`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,authorization",
        },
        maxRetries: STALE_SOCKET_RETRIES,
      });

    const allowed = await preflight(FRONTEND_ORIGIN);
    expect(allowed.status()).toBe(200);
    const allowedHeaders = allowed.headers();
    expect(allowedHeaders["access-control-allow-origin"]).toBe(FRONTEND_ORIGIN);
    expect(allowedHeaders["access-control-allow-credentials"]).toBe("true");
    expect(
      allowedHeaders["access-control-allow-methods"].split(/,\s*/),
    ).toEqual(expect.arrayContaining(["POST", "PATCH", "DELETE"]));
    expect(
      allowedHeaders["access-control-allow-headers"].split(/,\s*/),
    ).toEqual(expect.arrayContaining(["authorization", "content-type"]));

    const actual = await get(request, "/health/live", {
      Origin: FRONTEND_ORIGIN,
    });
    const actualHeaders = actual.headers();
    expect(actualHeaders["access-control-allow-origin"]).toBe(FRONTEND_ORIGIN);
    expect(actualHeaders["access-control-allow-credentials"]).toBe("true");
    expect(
      actualHeaders["access-control-expose-headers"].split(/,\s*/),
    ).toEqual(EXPOSED_HEADERS);
    expect(actualHeaders.vary.toLowerCase()).toContain("origin");

    for (const origin of [
      "https://evil.example",
      "http://localhost:3000",
      `${FRONTEND_ORIGIN}.evil.example`,
      "null",
    ]) {
      const refusedPreflight = (await preflight(origin)).headers();
      const refusedActual = (
        await get(request, "/health/live", { Origin: origin })
      ).headers();
      for (const headers of [refusedPreflight, refusedActual]) {
        expect(headers["access-control-allow-origin"], origin).toBeUndefined();
        expect(
          headers["access-control-allow-credentials"],
          origin,
        ).toBeUndefined();
        expect(
          headers["access-control-expose-headers"],
          origin,
        ).toBeUndefined();
      }
    }
  });
});

test.describe("CSP report endpoint", () => {
  chromiumOnly(BROWSER_NEUTRAL);

  test("reports and junk alike get 204, oversized bodies 413, other methods 405, and one address is rate limited", async ({
    request,
  }) => {
    // Each run reports from its own made-up address, so it has its own rate
    // bucket.
    const reporter = madeUpAddress();
    const post = (data, forwardedFor = reporter) =>
      request.post(`${BACKEND_URL}/csp-report/`, {
        headers: {
          "Content-Type": "application/csp-report",
          "X-Forwarded-For": forwardedFor,
        },
        data,
        maxRetries: STALE_SOCKET_RETRIES,
      });

    const report = await post(
      JSON.stringify({
        "csp-report": {
          "document-uri": "http://127.0.0.1/invite/secret-token",
          "violated-directive": "script-src-elem",
          "blocked-uri": "https://example.invalid/script.js?token=secret",
          "source-file": "line\r\nforged: entry",
        },
      }),
    );
    expect(report.status()).toBe(204);
    expect(await report.text()).toBe("");
    for (const [what, junk] of [
      ["text that is not JSON", "not json"],
      ["JSON without a report", JSON.stringify({ other: true })],
      ["a JSON list", JSON.stringify([1, 2, 3])],
      ["an empty body", ""],
    ]) {
      expect((await post(junk)).status(), what).toBe(204);
    }
    const oversized = await post("x".repeat(4097));
    expect(oversized.status()).toBe(413);
    expect(await oversized.text()).toBe("");
    for (const method of ["GET", "PUT", "DELETE"]) {
      const refused = await request.fetch(`${BACKEND_URL}/csp-report/`, {
        method,
        maxRetries: STALE_SOCKET_RETRIES,
      });
      expect(refused.status(), method).toBe(405);
    }

    // Past 60 reports a minute from one address, the endpoint drops
    // everything unread with 204, even a body it would refuse as too large.
    // Six were counted above (the refused methods never reach the view).
    for (let sent = 6; sent < 60; sent += 1) {
      expect((await post("{}")).status()).toBe(204);
    }
    expect((await post("x".repeat(4097))).status()).toBe(204);
    expect((await post("x".repeat(4097), madeUpAddress())).status()).toBe(413);
  });

  test("a logged report keeps only the directive and each URL's route, with credentials, queries and control characters removed", async () => {
    // The log line is only readable in-process: the app with Django's test
    // client and a handler on the endpoint's logger.
    const logged = djangoJsonWithEnv(
      `
import io
import logging

from django.test import Client

stream = io.StringIO()
handler = logging.StreamHandler(stream)
logger = logging.getLogger("apps.core.middleware.csp_report")
logger.addHandler(handler)

response = Client().post(
    "/csp-report/",
    data=json.dumps({"csp-report": data["report"]}),
    content_type="application/csp-report",
    HTTP_HOST="127.0.0.1",
)
print(json.dumps({"status": response.status_code, "lines": stream.getvalue().splitlines()}))
`,
      {
        data: {
          report: {
            "document-uri":
              "https://user:pass@app.example:8443/invite/secret-token?code=ABC#frag",
            "violated-directive": "script-src-elem\r\nforged: line",
            "blocked-uri": "https://cdn.example/script.js?token=secret",
            "source-file": "https://app.example/unsubscribe/other-secret/page",
          },
        },
        env: { E2E_ENDPOINT_LOG: "" },
      },
    );
    expect(logged).toEqual({
      status: 204,
      lines: [
        "CSP violation: directive=script-src-elem  forged: line " +
          "blocked=https://cdn.example/script.js " +
          "document=https://app.example:8443/invite/<redacted> " +
          "source=https://app.example/unsubscribe/<redacted>/page",
      ],
    });
  });
});

test.describe("ASGI entrypoint", () => {
  chromiumOnly(BROWSER_NEUTRAL);

  test("bodies declared or streamed past the cap get 413 with Connection: close before Django reads them", async ({
    request,
  }) => {
    const reporter = madeUpAddress();
    const maxBytes = runDjangoJson(`
from django.conf import settings

print(json.dumps(settings.REQUEST_BODY_MAX_BYTES))
`);
    expect(maxBytes).toBe(50 * 1024 * 1024);
    const tooLarge = { error: "Request body too large" };

    // A declared Content-Length over the cap is refused from the headers.
    const declared = await rawExchange({
      method: "POST",
      urlPath: "/csp-report/",
      headers: {
        "Content-Type": "application/csp-report",
        "Content-Length": String(maxBytes + 1),
        "X-Forwarded-For": reporter,
      },
    });
    expect(declared.status).toBe(413);
    expect(JSON.parse(declared.body)).toEqual(tooLarge);
    expect(declared.headers["content-type"]).toBe("application/json");
    expect(declared.headers.connection).toBe("close");

    // A chunked body carries no length, so the bytes are counted as they
    // arrive. A body of exactly the cap reaches the app (the report endpoint
    // answers 204 for a body that is not a report); one byte more is refused
    // by the cap.
    const chunk = Buffer.alloc(1024 * 1024, "a");
    const stream = (extra) =>
      rawExchange({
        method: "POST",
        urlPath: "/csp-report/",
        headers: {
          "Content-Type": "application/csp-report",
          "Transfer-Encoding": "chunked",
          "X-Forwarded-For": reporter,
        },
        chunks: {
          buffer: chunk,
          count: maxBytes / chunk.length,
          ...extra,
        },
      });
    const atTheCap = await stream({ end: true });
    expect(atTheCap.status).toBe(204);
    const pastTheCap = await stream({ tail: Buffer.from("a") });
    expect(pastTheCap.status).toBe(413);
    expect(JSON.parse(pastTheCap.body)).toEqual(tooLarge);
    expect(pastTheCap.headers.connection).toBe("close");

    // Ordinary requests are untouched: the endpoint's own size limit still
    // answers a small oversized report, with no body of its own.
    const small = await request.post(`${BACKEND_URL}/csp-report/`, {
      headers: {
        "Content-Type": "application/csp-report",
        "X-Forwarded-For": reporter,
      },
      data: "x".repeat(5000),
      maxRetries: STALE_SOCKET_RETRIES,
    });
    expect(small.status()).toBe(413);
    expect(await small.text()).toBe("");
  });
});

test.describe("ASGI lifespan", () => {
  chromiumOnly(BROWSER_NEUTRAL);

  test("the entrypoint completes uvicorn's lifespan handshake itself, which bare Django cannot, and passes other scopes through", async () => {
    // The same import string the E2E and production servers load, run
    // through uvicorn's own lifespan driver in "on" mode, where a failed
    // handshake stops the server instead of being logged and ignored.
    const outcome = runDjangoJson(`
import asyncio

from django.conf import settings
from uvicorn.config import Config
from uvicorn.lifespan.on import LifespanOn

import config.asgi as entrypoint
from apps.core.middleware import RequestBodyLimitMiddleware


async def handshake(app):
    lifespan = LifespanOn(Config(app=app, lifespan="on", log_level="critical"))
    await lifespan.startup()
    started = not lifespan.should_exit
    await lifespan.shutdown()
    return {
        "started": started,
        "stopped": not lifespan.should_exit,
        "errorOccurred": lifespan.error_occurred,
        "startupFailed": lifespan.startup_failed,
        "shutdownFailed": lifespan.shutdown_failed,
    }


async def websocket_scope(app):
    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        pass

    try:
        await app({"type": "websocket", "path": "/", "headers": []}, receive, send)
    except ValueError as exc:
        return str(exc)
    return ""


print(json.dumps({
    "wrapped": isinstance(entrypoint.application, RequestBodyLimitMiddleware),
    "wraps": entrypoint.application.app is entrypoint.django_application,
    "maxBytes": entrypoint.application.max_bytes == settings.REQUEST_BODY_MAX_BYTES,
    "entrypoint": asyncio.run(handshake("config.asgi:application")),
    "bareDjango": asyncio.run(handshake(entrypoint.django_application)),
    "websocket": asyncio.run(websocket_scope(entrypoint.application)),
}))
`);
    expect(outcome.wrapped).toBe(true);
    expect(outcome.wraps).toBe(true);
    expect(outcome.maxBytes).toBe(true);
    expect(outcome.entrypoint).toEqual({
      started: true,
      stopped: true,
      errorOccurred: false,
      startupFailed: false,
      shutdownFailed: false,
    });
    // Without the wrapper Django raises on the lifespan scope, which uvicorn
    // in "on" mode treats as a failed startup.
    expect(outcome.bareDjango).toMatchObject({
      started: false,
      errorOccurred: true,
    });
    // A websocket scope reaches Django untouched, which refuses it itself.
    expect(outcome.websocket).toContain("websocket");
  });
});

test.describe("Maintenance bypass", () => {
  chromiumOnly(
    "Switches the site-wide maintenance flag, so it runs once per suite run under a lock",
  );

  test("the bypass needs a password, active maintenance and a configured bypass, refuses a wrong password and accepts the right one, and the purge refuses to run outside maintenance", async () => {
    await withMaintenanceLock(async () => {
      // Nothing on this branch enforces the flag; only the bypass endpoint
      // and the purge command read it, and both are exercised here under the
      // lock.
      const original = maintenanceState();
      expect(original.is_maintenance).toBe(false);
      expect(
        commandRefusal(
          "purge_scheduling_data",
          "--execute",
          "--confirm",
          "PURGE-SCHEDULING-DATA",
          "--expected-event-count",
          "2147483647",
        ),
      ).toContain(
        "Maintenance mode must be enabled before purging Scheduling data",
      );

      // The CI endpoint audit (scripts/ci/audit_e2e_coverage.py) exempts
      // /maintenance/bypass/ and fails the run if the E2E server ever serves
      // it, so the endpoint answers in-process: the same app, settings and
      // database through Django's test client, with the route log off. One
      // process switches the flag and restores the exact original fields in
      // a finally block.
      const secret = `bypass-${newRunId()}`;
      const outcome = djangoJsonWithEnv(
        `
from django.test import Client

from apps.core.models import SiteMaintenanceControl

client = Client()


def bypass(body):
    response = client.post(
        "/maintenance/bypass/",
        data=json.dumps(body),
        content_type="application/json",
        HTTP_HOST="127.0.0.1",
    )
    return {"status": response.status_code, "body": response.json()}


def configure(**fields):
    control = SiteMaintenanceControl.load()
    for name, value in fields.items():
        setattr(control, name, value)
    control.save()


answers = {
    "missing": bypass({}),
    "blank": bypass({"password": ""}),
    "inactive": bypass({"password": "anything"}),
}
try:
    configure(is_maintenance=True, bypass_password="")
    answers["unconfigured"] = bypass({"password": data["secret"]})
    configure(bypass_password=data["secret"])
    stored = SiteMaintenanceControl.objects.get(pk=1).bypass_password
    answers["wrong"] = bypass({"password": data["secret"] + "x"})
    answers["right"] = bypass({"password": data["secret"]})
finally:
    SiteMaintenanceControl.objects.filter(pk=1).update(**data["original"])
answers["restored"] = bypass({"password": data["secret"]})
print(json.dumps({"answers": answers, "stored": stored}))
`,
        {
          data: { secret, original },
          env: { E2E_ENDPOINT_LOG: "" },
        },
      );
      const refusal = (status, error) => ({
        status,
        body: { success: false, error },
      });
      expect(outcome.answers).toEqual({
        missing: refusal(400, "Password is required."),
        blank: refusal(400, "Password is required."),
        inactive: refusal(400, "Maintenance mode is not active."),
        unconfigured: refusal(400, "Bypass is not configured."),
        wrong: refusal(403, "Incorrect password."),
        right: { status: 200, body: { success: true } },
        restored: refusal(400, "Maintenance mode is not active."),
      });
      // The bypass password is stored hashed.
      expect(outcome.stored).not.toContain(secret);
      expect(outcome.stored).toMatch(/^\w+\$/);
      expect(maintenanceState()).toEqual(original);
    });
  });
});

test.describe("Management commands", () => {
  chromiumOnly(
    "Runs management commands against the shared database, so it runs once per suite run",
  );

  test("the admin bootstrap commands create a superuser once, never promote or claim another identity, and refuse without confirmation", async ({
    request,
  }) => {
    const runId = newRunId();
    const adminEmail = `ensure-admin-${runId}@example.com`;
    const superEmail = `create-super-${runId}@example.com`;
    const passwordEnv = `RELEVIZ_E2E_ENSURE_ADMIN_${runId.replace(/\W/g, "_")}`;
    const password = `Releviz-Admin-${runId}!`;
    const created = [];
    const memberState = (email) =>
      runDjangoJson(
        `
from apps.authn.models import ContactEmail

contact = ContactEmail.objects.select_related("member").get(email_address__iexact=data["email"])
member = contact.member
print(json.dumps({
    "id": str(member.pk),
    "active": member.is_active,
    "staff": member.is_staff,
    "superuser": member.is_superuser,
    "usablePassword": member.has_usable_password(),
    "type": contact.email_type,
    "verified": contact.verified,
}))
`,
        { email },
      );

    try {
      expect(commandRefusal("seed_admin_e2e")).toContain(
        "Refusing to mutate the database without --yes.",
      );
      expect(
        commandRefusal("ensure_default_admin", "--email", adminEmail),
      ).toContain("Refusing to mutate admin users without --yes.");
      expect(
        commandRefusal(
          "ensure_default_admin",
          "--yes",
          "--email",
          adminEmail,
          "--password-env",
          passwordEnv,
        ),
      ).toContain(`${passwordEnv} must be set.`);

      process.env[passwordEnv] = password;
      let output;
      try {
        output = runBackendCommand(
          "ensure_default_admin",
          "--yes",
          "--email",
          adminEmail.toUpperCase(),
          "--password-env",
          passwordEnv,
          "--first-name",
          "Ada",
          "--last-name",
          "Bootstrap",
        );
      } finally {
        delete process.env[passwordEnv];
      }
      const admin = memberState(adminEmail);
      created.push(admin.id);
      expect(output).toContain(
        `Default admin created: email=${adminEmail}, member=${admin.id}`,
      );
      expect(admin).toMatchObject({
        active: true,
        staff: true,
        superuser: true,
        usablePassword: true,
        type: "primary",
        verified: true,
      });
      const signedIn = await passwordLoginViaApi(request, adminEmail, password);
      expect(signedIn.response.status()).toBe(200);
      expect(signedIn.payload.user).toMatchObject({
        member_uuid: admin.id,
        is_staff: true,
        first_name: "Ada",
        last_name: "Bootstrap",
      });

      // Running again changes nothing, and --create-only only verifies.
      expect(
        runBackendCommand(
          "ensure_default_admin",
          "--yes",
          "--email",
          adminEmail,
          "--password-env",
          passwordEnv,
        ),
      ).toContain(
        `Default admin already exists; left unchanged: email=${adminEmail}, member=${admin.id}`,
      );
      expect(
        runBackendCommand(
          "ensure_default_admin",
          "--yes",
          "--create-only",
          "--email",
          adminEmail,
        ),
      ).toContain(
        `Default admin verified: email=${adminEmail}, member=${admin.id}`,
      );

      // An ordinary account is never promoted.
      const ordinaryEmail = `ensure-ordinary-${runId}@example.com`;
      await registerAccountViaApi(request, ordinaryEmail, "Ord", "Inary");
      expect(
        commandRefusal(
          "ensure_default_admin",
          "--yes",
          "--email",
          ordinaryEmail,
        ),
      ).toContain(
        `Email ${ordinaryEmail} belongs to a member who is not an active staff superuser; refusing to promote or replace that account.`,
      );
      expect(memberState(ordinaryEmail)).toMatchObject({
        staff: false,
        superuser: false,
      });
      // A newsletter address nobody owns is not claimed in --create-only mode.
      const subscriberEmail = `ensure-subscriber-${runId}@example.com`;
      expect(
        (
          await request.post(`${BACKEND_URL}/authn/subscribe/`, {
            data: { email: subscriberEmail },
            maxRetries: STALE_SOCKET_RETRIES,
          })
        ).status(),
      ).toBe(201);
      expect(
        commandRefusal(
          "ensure_default_admin",
          "--yes",
          "--create-only",
          "--email",
          subscriberEmail,
        ),
      ).toContain(
        `Email ${subscriberEmail} already exists without an owner; refusing to claim it in --create-only mode.`,
      );

      // The createsuperuser override files the address as a verified primary.
      expect(
        commandRefusal(
          "createsuperuser",
          "--noinput",
          "--email",
          superEmail,
          "--password",
          password,
        ),
      ).toContain(
        "--email, --password, --first-name, and --last-name are required in non-interactive mode.",
      );
      const createdSuper = runBackendCommand(
        "createsuperuser",
        "--noinput",
        "--email",
        superEmail,
        "--password",
        password,
        "--first-name",
        "Sue",
        "--last-name",
        "Peruser",
      );
      const superuser = memberState(superEmail);
      created.push(superuser.id);
      expect(createdSuper).toContain(
        `Superuser created with email '${superEmail}' (UUID: ${superuser.id}).`,
      );
      expect(superuser).toMatchObject({
        active: true,
        staff: true,
        superuser: true,
        usablePassword: true,
        type: "primary",
        verified: true,
      });
      expect(
        (
          await passwordLoginViaApi(request, superEmail, password)
        ).response.status(),
      ).toBe(200);
      expect(
        commandRefusal(
          "createsuperuser",
          "--noinput",
          "--email",
          superEmail.toUpperCase(),
          "--password",
          password,
          "--first-name",
          "Sue",
          "--last-name",
          "Again",
        ),
      ).toContain(
        `A contact email with address '${superEmail.toUpperCase()}' already exists.`,
      );
    } finally {
      // Superusers with known passwords do not outlive the test.
      runDjangoScript(
        `
from apps.authn.models import Member

Member.objects.filter(pk__in=data["ids"]).delete()
`,
        { ids: created },
      );
    }
  });

  test("the maintenance commands: locked migrations, guarded reset and purge, roster preview cleanup and one background worker pass", async ({
    request,
  }) => {
    const runId = newRunId();
    const email = `commands-${runId}@example.com`;
    const organizer = await registerAccountViaApi(
      request,
      email,
      "Cam",
      "Mand",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Commands ${runId}`,
    });

    expect(commandRefusal("resetdb", "--confirm", "NOT-RESET-DB")).toContain(
      "Destructive command requires --force and --confirm RESET_DB.",
    );

    // migrate_locked holds the advisory lock around migrate. --check applies
    // nothing and fails only when migrations are pending.
    expect(
      runBackendCommand(
        "migrate_locked",
        "--check",
        "--lock-timeout-seconds",
        "30",
      ),
    ).toContain("Acquired database migration lock.");
    expect(
      commandRefusal(
        "migrate_locked",
        "--check",
        "--lock-timeout-seconds",
        "-1",
      ),
    ).toContain("--lock-timeout-seconds must be non-negative.");
    const holder = spawn(
      PYTHON_BIN,
      [
        "-c",
        `
import sys
import django

django.setup()
from django.db import connection
from apps.authn.management.commands.migrate_locked import MIGRATION_LOCK_ID

with connection.cursor() as cursor:
    cursor.execute("SELECT pg_advisory_lock(%s)", [MIGRATION_LOCK_ID])
print("locked", flush=True)
sys.stdin.read()
`,
      ],
      { cwd: ROOT, env: backendEnv(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const holderExited = new Promise((resolve) => holder.on("exit", resolve));
    try {
      await new Promise((resolve, reject) => {
        let output = "";
        holder.stdout.on("data", (data) => {
          output += data;
          if (output.includes("locked")) resolve();
        });
        holder.on("exit", (code) =>
          reject(new Error(`the lock holder exited early (${code})`)),
        );
      });
      expect(
        commandRefusal(
          "migrate_locked",
          "--check",
          "--lock-timeout-seconds",
          "0",
        ),
      ).toContain("Timed out waiting 0s for the database migration lock.");
    } finally {
      holder.stdin.end();
      await holderExited;
    }

    // The purge is a dry run unless told otherwise, and executing it needs
    // the confirmation phrase and the expected event count first.
    const dryRun = JSON.parse(
      runBackendCommand("purge_scheduling_data").trim().split(/\r?\n/).pop(),
    );
    expect(dryRun).toMatchObject({ dryRun: true });
    expect(Object.keys(dryRun).sort()).toEqual([
      "dryRun",
      "events",
      "schedulingDeliveryJobs",
      "schedulingMessageLogs",
      "schedulingRows",
      "temporaryAccessChallenges",
      "temporaryMemberMessageLogs",
      "temporaryMembers",
    ]);
    // This test's event is one of them.
    expect(dryRun.events).toBeGreaterThanOrEqual(1);
    expect(dryRun.schedulingRows).toBeGreaterThanOrEqual(dryRun.events);
    expect(commandRefusal("purge_scheduling_data", "--execute")).toContain(
      "Execution requires --confirm PURGE-SCHEDULING-DATA",
    );
    expect(
      commandRefusal(
        "purge_scheduling_data",
        "--execute",
        "--confirm",
        "PURGE-SCHEDULING-DATA",
      ),
    ).toContain("Execution requires a non-negative --expected-event-count");
    expect(
      (
        await request.get(`${BACKEND_URL}/events?code=${event.code}`, {
          headers: { Authorization: `Bearer ${organizer.access}` },
          maxRetries: STALE_SOCKET_RETRIES,
        })
      ).status(),
    ).toBe(200);

    // Roster import previews expire after a day; the cleanup scrubs the
    // expired ones and leaves previews still under review.
    const startPreview = async (name) => {
      const created = await request.post(
        `${BACKEND_URL}/events/roster-imports?code=${event.code}`,
        {
          headers: { Authorization: `Bearer ${organizer.access}` },
          data: {
            sourceType: "paste",
            pastedText: `name\temail\n${name}\t${name.toLowerCase().replace(/\s/g, ".")}-${runId}@example.com`,
          },
          maxRetries: STALE_SOCKET_RETRIES,
        },
      );
      expect(created.status()).toBe(201);
      return (await created.json()).import.id;
    };
    const expiredId = await startPreview("Old Preview");
    const freshId = await startPreview("New Preview");
    runDjangoScript(
      `
from datetime import timedelta

from django.utils import timezone

from apps.scheduling.models import RosterImportBatch

RosterImportBatch.objects.filter(pk=data["id"]).update(
    expires_at=timezone.now() - timedelta(minutes=1)
)
`,
      { id: expiredId },
    );
    const cleanup = runCommandScopedTo(
      "cleanup_roster_imports",
      [],
      "scheduling.RosterImportBatch",
      { event__code: event.code },
    );
    expect(cleanup.trim()).toBe("Expired 1 roster import preview(s).");
    const batches = runDjangoJson(
      `
from apps.scheduling.models import RosterImportBatch

print(json.dumps({
    str(batch.pk): {"status": batch.status, "rows": batch.rows.count()}
    for batch in RosterImportBatch.objects.filter(pk__in=data["ids"])
}))
`,
      { ids: [expiredId, freshId] },
    );
    expect(batches[expiredId]).toEqual({ status: "expired", rows: 0 });
    expect(batches[freshId].status).toBe("preview");
    expect(batches[freshId].rows).toBeGreaterThan(0);
    const rows = (id) =>
      request.get(
        `${BACKEND_URL}/events/roster-imports/${id}/rows?code=${event.code}`,
        {
          headers: { Authorization: `Bearer ${organizer.access}` },
          maxRetries: STALE_SOCKET_RETRIES,
        },
      );
    const expiredRows = await rows(expiredId);
    expect(expiredRows.status()).toBe(410);
    expect(await expiredRows.json()).toEqual({
      error: "This import preview has expired.",
    });
    expect((await rows(freshId)).status()).toBe(200);

    // One worker pass claims a queued job, delivers it and reports metrics.
    const subject = `Worker check ${runId}`;
    const jobId = runDjangoJson(
      `
from apps.core.services.background_jobs import enqueue_notification_email

job, created = enqueue_notification_email(
    recipient=data["email"],
    subject=data["subject"],
    template="authn/email/email_claim_notification.html",
    context={"account_url": ""},
)
print(json.dumps(str(job.pk)))
`,
      { email, subject },
    );
    const sentAfter = Date.now() - 1000;
    const workerOutput = runCommandScopedTo(
      "run_background_worker",
      ["--once"],
      "core.BackgroundJob",
      { pk: jobId },
    );
    const metrics = JSON.parse(workerOutput.trim().split(/\r?\n/).pop());
    expect(metrics).toMatchObject({ heartbeat: 1 });
    expect(Object.keys(metrics).sort()).toEqual([
      "failed_jobs",
      "heartbeat",
      "oldest_job_age_seconds",
      "queue_depth",
      "uncertain_email_jobs",
      "uncertain_jobs",
    ]);
    expect(
      runDjangoJson(
        `
from apps.core.models import BackgroundJob

job = BackgroundJob.objects.get(pk=data["id"])
print(json.dumps({"status": job.status, "attempts": job.attempts, "completed": job.completed_at is not None}))
`,
        { id: jobId },
      ),
    ).toEqual({ status: "succeeded", attempts: 1, completed: true });
    await latestEmailFor(
      email,
      sentAfter,
      (message) =>
        message.match(/^Subject:\s*(.+)$/im)?.[1]?.trim() === subject,
    );
  });
});

test.describe("Frontend security headers in the browser", () => {
  test("pages carry the security headers and load without Content-Security-Policy violations, signed out and signed in", async ({
    page,
    request,
  }) => {
    const collect = await watchCspViolations(page);
    const violations = [];
    for (const [pagePath, heading] of [
      ["/", "Find a time that works for everyone."],
      ["/login", "Welcome to Releviz"],
      ["/recover", "Recover your account"],
      ["/privacy", "Privacy notice"],
      ["/temp-access", "Access link required"],
      ["/email-auth-link", "Link verification failed"],
      ["/this-page-does-not-exist/", "Page not found"],
    ]) {
      const response = await page.goto(pagePath);
      expectFrontendSecurityHeaders(await response.allHeaders(), pagePath);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      violations.push(...(await collect()));
    }

    // Signed in, the app talks to the API origin (fetch and the workspace's
    // event stream) under the same policy.
    const runId = newRunId();
    await registerAccount(page, `csp-${runId}@example.com`, "Cass", "Policy");
    violations.push(...(await collect()));
    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, { name: `CSP ${runId}` });
    for (const [pagePath, heading] of [
      ["/dashboard", "My Dashboard"],
      ["/create", "Create event"],
      [`/event?code=${event.code}`, event.name],
      ["/settings", "Account settings"],
    ]) {
      const response = await page.goto(pagePath);
      expectFrontendSecurityHeaders(await response.allHeaders(), pagePath);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      violations.push(...(await collect()));
    }
    expect(violations).toEqual([]);

    // Static assets carry the same headers.
    const favicon = await request.get(`${FRONTEND_URL}/favicon.ico`);
    expect(favicon.status()).toBe(200);
    expect(favicon.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("another site can neither frame the app nor use the visitor's API session", async ({
    page,
  }) => {
    // The visitor is signed in: the browser holds the API's refresh cookie.
    const runId = newRunId();
    const member = await registerAccountViaApi(
      page.request,
      `framing-${runId}@example.com`,
      "Fay",
      "Rame",
    );
    await page.route(`${FOREIGN_SITE}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/control") {
        await route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Control</title><h1>Framed control</h1>",
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Other site</title>
<h1>Other site</h1>
<iframe title="Framed control" src="${FOREIGN_SITE}/control"></iframe>
<iframe title="Framed Releviz" src="${FRONTEND_URL}/privacy"></iframe>`,
      });
    });

    const framedUrl = `${FRONTEND_URL}/privacy`;
    let framedRequests = 0;
    page.on("request", (request) => {
      if (request.url() === framedUrl) framedRequests += 1;
    });
    // The load event waits for both frames to finish, loaded or refused.
    await page.goto(`${FOREIGN_SITE}/`, { waitUntil: "load" });
    expect(framedRequests).toBeGreaterThan(0);
    // Frames render on this page, but the app's server-rendered heading
    // never appears in its frame.
    await expect(
      page
        .frameLocator('iframe[title="Framed control"]')
        .getByRole("heading", { name: "Framed control" }),
    ).toBeVisible();
    await expect(
      page
        .frameLocator('iframe[title="Framed Releviz"]')
        .getByRole("heading", { name: "Privacy notice" }),
    ).toHaveCount(0);

    // Credentialed calls from this site get no readable answer: the API does
    // not name this origin (and the refresh cookie is SameSite=Lax anyway).
    const probe = (url, method = "GET") =>
      page.evaluate(
        async ({ target, verb }) => {
          try {
            const response = await fetch(target, {
              method: verb,
              credentials: "include",
            });
            const body = await response.json().catch(() => null);
            return {
              status: response.status,
              member: body?.user?.member_uuid ?? null,
            };
          } catch (error) {
            return { error: error.name };
          }
        },
        { target: url, verb: method },
      );
    const refresh = `${BACKEND_URL}/authn/refresh/`;
    expect(await probe(`${BACKEND_URL}/health/live`)).toEqual({
      error: "TypeError",
    });
    expect(await probe(refresh, "POST")).toEqual({ error: "TypeError" });

    // The same calls from the app's own origin are answered, with the session.
    await page.goto("/privacy");
    expect(await probe(`${BACKEND_URL}/health/live`)).toEqual({
      status: 200,
      member: null,
    });
    expect(await probe(refresh, "POST")).toEqual({
      status: 200,
      member: member.user.id,
    });
  });
});
