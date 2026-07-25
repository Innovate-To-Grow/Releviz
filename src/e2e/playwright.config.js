const { defineConfig, devices } = require("@playwright/test");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "../..");
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:4100";
const frontendUrl = process.env.FRONTEND_URL || "http://127.0.0.1:3100";
const backendPort = new URL(backendUrl).port || "80";
const frontendPort = new URL(frontendUrl).port || "80";

const backendEnv = {
  DB_HOST: process.env.DB_HOST || "127.0.0.1",
  DB_PORT: process.env.DB_PORT || "5433",
  DB_NAME: process.env.DB_NAME || "releviz_test",
  DB_USER: process.env.DB_USER || "releviz",
  DB_PASSWORD: process.env.DB_PASSWORD || "releviz",
  DB_TEST_NAME: process.env.DB_TEST_NAME || "releviz_test",
  DJANGO_SETTINGS_MODULE: "config.settings.e2e",
  EMAIL_FILE_PATH: process.env.EMAIL_FILE_PATH || "/tmp/releviz-e2e-mail",
  FRONTEND_URL: frontendUrl,
  BACKEND_URL: backendUrl,
  DJANGO_SUPERUSER_EMAIL: process.env.DJANGO_SUPERUSER_EMAIL || "admin@releviz.local",
  DJANGO_SUPERUSER_PASSWORD: process.env.DJANGO_SUPERUSER_PASSWORD || "Admin12345!",
};

module.exports = defineConfig({
  testDir: ".",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: frontendUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: `python3 src/backend/manage.py runserver 127.0.0.1:${backendPort} --settings=config.settings.e2e`,
      cwd: rootDir,
      url: `${backendUrl}/api/health`,
      env: backendEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm --workspace=releviz-frontend run start -- --hostname 127.0.0.1 --port ${frontendPort}`,
      cwd: rootDir,
      url: frontendUrl,
      env: {
        NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL || "",
        BACKEND_URL: backendUrl,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
