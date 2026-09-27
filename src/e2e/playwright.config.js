const { defineConfig, devices } = require("@playwright/test");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "../..");
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:4100";
const frontendUrl = process.env.FRONTEND_URL || "http://127.0.0.1:3100";
const backendPort = new URL(backendUrl).port || "80";
const frontendPort = new URL(frontendUrl).port || "80";
const adminPassword = process.env.DJANGO_SUPERUSER_PASSWORD;
const pythonBin = process.env.PYTHON_BIN || "python3";

if (!adminPassword) {
  throw new Error(
    "DJANGO_SUPERUSER_PASSWORD must be set before running Playwright.",
  );
}

const backendEnv = {
  DB_HOST: process.env.DB_HOST || "127.0.0.1",
  DB_PORT: process.env.DB_PORT || "5433",
  DB_NAME: process.env.DB_NAME || "releviz_test",
  DB_USER: process.env.DB_USER || "releviz",
  DB_PASSWORD: process.env.DB_PASSWORD || "releviz",
  DB_TEST_NAME: process.env.DB_TEST_NAME || "releviz_test",
  DJANGO_SETTINGS_MODULE: "config.settings.e2e",
  EMAIL_FILE_PATH: process.env.EMAIL_FILE_PATH || "/tmp/releviz-e2e-mail",
  PRINT_EMAILS_TO_TERMINAL: "0",
  FRONTEND_URL: frontendUrl,
  BACKEND_URL: backendUrl,
  DJANGO_SUPERUSER_EMAIL:
    process.env.DJANGO_SUPERUSER_EMAIL || "admin@releviz.local",
  DJANGO_SUPERUSER_PASSWORD: adminPassword,
  PYTHONUNBUFFERED: "1",
};

module.exports = defineConfig({
  testDir: ".",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: frontendUrl,
    // The organizer workspace scrolls the Finalize step into view with smooth
    // scrolling after every pick; while that animation runs, a click aimed at
    // a calendar cell can land on the wrong element (seen on Firefox in CI).
    // The app honours reduced motion, so the suite asks for it.
    contextOptions: {
      reducedMotion: "reduce",
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      // The stream endpoint needs an ASGI server (runserver is WSGI); this is
      // the production server, gunicorn running uvicorn workers.
      command: `${JSON.stringify(pythonBin)} -m gunicorn config.asgi:application -k uvicorn_worker.UvicornWorker --chdir src/api --bind 127.0.0.1:${backendPort} --workers 1`,
      cwd: rootDir,
      url: `${backendUrl}/health`,
      env: backendEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm --workspace=releviz-web run start -- --hostname 127.0.0.1 --port ${frontendPort}`,
      cwd: rootDir,
      url: frontendUrl,
      env: {
        NEXT_E2E_SERVER: "1",
        NEXT_PUBLIC_API_BASE_URL:
          process.env.NEXT_PUBLIC_API_BASE_URL || backendUrl,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      name: "result-worker",
      command: `${JSON.stringify(pythonBin)} src/api/manage.py recompute_event_results --watch --poll-interval=0.5 --settings=config.settings.e2e`,
      cwd: rootDir,
      env: backendEnv,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      wait: { stdout: /Event results:/ },
      timeout: 60_000,
    },
    {
      name: "email-worker",
      command: `${JSON.stringify(pythonBin)} src/api/manage.py dispatch_email_jobs --watch --limit=1000 --concurrency=2 --rate-limit=100 --poll-interval=0.5 --settings=config.settings.e2e`,
      cwd: rootDir,
      env: backendEnv,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      wait: { stdout: /Email jobs:/ },
      timeout: 60_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
