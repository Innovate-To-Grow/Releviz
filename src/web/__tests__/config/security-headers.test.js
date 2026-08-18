const amplifyHeaders = require("../../../../infra/prod/amplify-custom-headers.json");

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const ORIGINAL_STATIC_EXPORT = process.env.AMPLIFY_STATIC_EXPORT;
const ORIGINAL_E2E_SERVER = process.env.NEXT_E2E_SERVER;

async function loadCsp(nodeEnvironment) {
  jest.resetModules();
  process.env.NODE_ENV = nodeEnvironment;
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.releviz.com";
  delete process.env.AMPLIFY_STATIC_EXPORT;
  delete process.env.NEXT_E2E_SERVER;

  const config = require("../../next.config.js");
  const routes = await config.headers();
  return routes[0].headers.find(({ key }) => key === "Content-Security-Policy")
    .value;
}

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_API_BASE === undefined) {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
  } else {
    process.env.NEXT_PUBLIC_API_BASE_URL = ORIGINAL_API_BASE;
  }
  if (ORIGINAL_STATIC_EXPORT === undefined) {
    delete process.env.AMPLIFY_STATIC_EXPORT;
  } else {
    process.env.AMPLIFY_STATIC_EXPORT = ORIGINAL_STATIC_EXPORT;
  }
  if (ORIGINAL_E2E_SERVER === undefined) {
    delete process.env.NEXT_E2E_SERVER;
  } else {
    process.env.NEXT_E2E_SERVER = ORIGINAL_E2E_SERVER;
  }
});

test("uses a Next-compatible output mode for each runtime", () => {
  jest.resetModules();
  delete process.env.AMPLIFY_STATIC_EXPORT;
  delete process.env.NEXT_E2E_SERVER;
  expect(require("../../next.config.js").output).toBe("standalone");

  jest.resetModules();
  process.env.AMPLIFY_STATIC_EXPORT = "1";
  expect(require("../../next.config.js").output).toBe("export");

  jest.resetModules();
  delete process.env.AMPLIFY_STATIC_EXPORT;
  process.env.NEXT_E2E_SERVER = "1";
  expect(require("../../next.config.js").output).toBeUndefined();
});

test("production fallback and Amplify use the same hardened CSP", async () => {
  const fallbackCsp = await loadCsp("production");
  const amplifyCsp = amplifyHeaders.customHeaders[0].headers.find(
    ({ key }) => key === "Content-Security-Policy",
  ).value;

  expect(fallbackCsp).toBe(amplifyCsp);
  expect(fallbackCsp).not.toContain("'unsafe-eval'");
  expect(fallbackCsp).not.toContain("esm.run");
  expect(fallbackCsp).not.toMatch(/(?:^|\s)(?:ws:|wss:|blob:)(?:;|\s|$)/);
  expect(fallbackCsp).toContain("object-src 'none'");
  expect(fallbackCsp).toContain("frame-ancestors 'none'");
  expect(fallbackCsp).toContain(
    "connect-src 'self' https://api.releviz.com https://challenges.cloudflare.com",
  );
});

test("HTTP E2E server does not upgrade its own assets to HTTPS", async () => {
  jest.resetModules();
  process.env.NODE_ENV = "production";
  process.env.NEXT_E2E_SERVER = "1";
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:4100";

  const config = require("../../next.config.js");
  const routes = await config.headers();
  const csp = routes[0].headers.find(
    ({ key }) => key === "Content-Security-Policy",
  ).value;

  expect(csp).not.toContain("upgrade-insecure-requests");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).toContain(
    "connect-src 'self' http://127.0.0.1:4100 https://challenges.cloudflare.com",
  );
});

test("development keeps only the sources needed by the Next dev server", async () => {
  const developmentCsp = await loadCsp("development");

  expect(developmentCsp).toContain("'unsafe-eval'");
  expect(developmentCsp).toContain("ws: wss:");
  expect(developmentCsp).not.toContain("upgrade-insecure-requests");
});
