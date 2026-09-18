const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { expect } = require("@playwright/test");

// Shared plumbing for the Playwright specs: the file-based email sink the
// e2e settings write to, passwordless sign-in/registration through the UI,
// authenticated API calls, and the backend management commands the flows
// trigger synchronously.

const ROOT = path.resolve(__dirname, "../../..");
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:4100";
const EMAIL_FILE_PATH = process.env.EMAIL_FILE_PATH || "/tmp/releviz-e2e-mail";
const ADMIN_EMAIL = process.env.DJANGO_SUPERUSER_EMAIL || "admin@releviz.local";
const ADMIN_PASSWORD = process.env.DJANGO_SUPERUSER_PASSWORD;
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const DAY_MS = 24 * 60 * 60 * 1000;

if (!ADMIN_PASSWORD) {
  throw new Error(
    "DJANGO_SUPERUSER_PASSWORD must be set before running Playwright.",
  );
}

function decodeQuotedPrintable(value) {
  if (!/^Content-Transfer-Encoding:\s*quoted-printable\s*$/im.test(value)) {
    return value;
  }
  const unfolded = value.replace(/=\r?\n/g, "");
  return unfolded.replace(/(?:=[0-9a-f]{2})+/gi, (encoded) => {
    const bytes = encoded
      .slice(1)
      .split("=")
      .map((hex) => Number.parseInt(hex, 16));
    return Buffer.from(bytes).toString("utf8");
  });
}

// The branded template renders the one-time code as its own block, so it
// arrives on a line of its own rather than in a sentence.
function codeFromEmailBody(body) {
  return (
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^\d{6}$/.test(line)) || null
  );
}

async function latestVerificationCode(email, afterMs) {
  const body = await latestEmailFor(email, afterMs, (message) =>
    Boolean(codeFromEmailBody(message)),
  );
  const code = codeFromEmailBody(body);
  if (!code) throw new Error(`No verification code email found for ${email}`);
  return code;
}

async function latestEmailFor(email, afterMs, predicate = () => true) {
  const deadline = Date.now() + 20_000;
  const normalizedEmail = email.trim().toLowerCase();
  while (Date.now() < deadline) {
    let entries = [];
    try {
      entries = await fs.readdir(EMAIL_FILE_PATH);
    } catch {
      entries = [];
    }

    const matches = [];
    for (const entry of entries) {
      const file = path.join(EMAIL_FILE_PATH, entry);
      const stat = await fs.stat(file);
      if (stat.mtimeMs < afterMs) continue;
      const body = await fs.readFile(file, "utf8");
      const messages = body.split(/\r?\n-{20,}\r?\n/);
      for (const message of messages) {
        const recipientHeader = message.match(/^To:\s*(.+)$/im)?.[1] || "";
        const recipients = recipientHeader
          .split(",")
          .map((recipient) => recipient.trim().toLowerCase());
        if (!recipients.includes(normalizedEmail)) continue;
        const decodedMessage = decodeQuotedPrintable(message);
        if (predicate(decodedMessage)) {
          matches.push({ body: decodedMessage, mtimeMs: stat.mtimeMs });
        }
      }
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (matches[0]) return matches[0].body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No matching email found for ${email}`);
}

// Both /login and /signup render the same passwordless panel: request a code
// for an email address, then confirm it. Existing accounts sign in and unknown
// addresses are created, so this drives registration and login alike.
async function continueWithEmail(page, email, startedAt) {
  await page.getByLabel("Email").fill(email);
  const codeStep = page.getByRole("heading", { name: "Check your email" });
  // Firefox on CI has dropped the first submit right after hydration. Asking
  // again only issues another code, and the newest one is the one read.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page
      .getByRole("button", { name: "Continue with email" })
      .click({ timeout: 5_000 })
      .catch(() => {});
    const sent = await codeStep
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    if (sent) break;
  }
  await expect(codeStep).toBeVisible();
  const code = await latestVerificationCode(email, startedAt);
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify and continue" }).click();
}

async function expectDashboard(page) {
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("heading", { name: "My Dashboard" }),
  ).toBeVisible();
}

async function registerAccount(page, email, firstName, lastName) {
  const startedAt = Date.now() - 1000;
  await page.goto("/signup");
  await continueWithEmail(page, email, startedAt);

  // A brand-new account carries no name yet, so verification lands on the
  // profile-completion step before the dashboard.
  await expect(page).toHaveURL(/complete_profile=1/);
  await page.getByRole("textbox", { name: "First name" }).fill(firstName);
  await page.getByRole("textbox", { name: "Last name" }).fill(lastName);
  await page.getByRole("button", { name: "Continue" }).click();
  await expectDashboard(page);

  const storedCredentials = await page.evaluate(() => ({
    local: window.localStorage.getItem("releviz.auth"),
    session: window.sessionStorage.getItem("releviz.auth"),
    visibleCookies: document.cookie,
  }));
  expect(storedCredentials.local).toBeNull();
  expect(storedCredentials.session).toBeNull();
  expect(storedCredentials.visibleCookies).not.toContain("releviz_refresh");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "My Dashboard" }),
  ).toBeVisible();
}

async function loginWithEmailCode(page, email) {
  const startedAt = Date.now() - 1000;
  await page.goto("/login");
  await continueWithEmail(page, email, startedAt);
  await expectDashboard(page);
}

async function fillTextbox(page, name, value) {
  await page.getByRole("textbox", { name }).fill(value);
}

// Event settings use native <select> controls, so the value is chosen by its
// visible option label.
async function selectOption(page, name, optionName) {
  const select = page.getByRole("combobox", { name });
  await select.selectOption({ label: optionName });
  await expect(select).toHaveValue(optionName);
}

async function expandAdvancedOptions(page) {
  const panel = page.locator("details").filter({ hasText: "Advanced options" });
  await panel.locator("summary").click();
  await expect(panel).toHaveAttribute("open", "");
}

async function readSession(page) {
  const payload = await page.evaluate(async (backendUrl) => {
    const response = await fetch(`${backendUrl}/authn/refresh/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "include",
    });
    if (!response.ok)
      throw new Error(`Unable to refresh test session: ${response.status}`);
    return response.json();
  }, BACKEND_URL);
  // The session payload identifies the member as `member_uuid`. Alias it to
  // `id` so callers can use one stable name for the member identifier.
  return {
    ...payload,
    user: { ...payload.user, id: payload.user.member_uuid },
  };
}

function datetimeLocalHoursFromNow(hours) {
  const value = new Date(Date.now() + hours * 60 * 60 * 1000);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
}

function nextWeekdayDate() {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  do {
    value.setUTCDate(value.getUTCDate() + 1);
  } while (value.getUTCDay() === 0 || value.getUTCDay() === 6);
  return value.toISOString().slice(0, 10);
}

async function apiJson(request, method, url, token, body) {
  const response = await request.fetch(`${BACKEND_URL}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    data: body,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

// Creates an active weekday event through the API and returns its full
// definition (slot groups included) so specs can seed responses by slot
// index. `overrides` replaces any field of the default payload.
async function createEvent(request, token, overrides) {
  const created = await apiJson(request, "POST", "/events", token, {
    startTime: "09:00",
    endTime: "17:00",
    slotMinutes: 30,
    days: [1, 2, 3, 4, 5],
    mode: "inperson",
    location: "Calendar Room",
    participantViewPermission: "realtime",
    daySelectionType: "days_of_week",
    specificDates: [],
    responseDeadline: new Date(Date.now() + 5 * DAY_MS).toISOString(),
    timezone: "UTC",
    remindersEnabled: false,
    reminderHoursBefore: 24,
    accessMode: "invite_only",
    meetingDurationMinutes: 60,
    status: "active",
    ...overrides,
  });
  expect(created.response.status()).toBe(201);
  const definition = await apiJson(
    request,
    "GET",
    `/events?code=${created.payload.event.code}`,
    token,
  );
  expect(definition.response.status()).toBe(200);
  return definition.payload.event;
}

function runBackendCommand(command, ...args) {
  execFileSync(
    PYTHON_BIN,
    [
      path.join(ROOT, "src/api/manage.py"),
      command,
      ...args,
      "--settings=config.settings.e2e",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PYTHONPATH: path.join(ROOT, "src/api"),
        DJANGO_SETTINGS_MODULE: "config.settings.e2e",
      },
      stdio: "pipe",
    },
  );
}

function dispatchEmailJobs() {
  runBackendCommand(
    "dispatch_email_jobs",
    "--limit=1000",
    "--concurrency=4",
    "--rate-limit=1000",
  );
}

function recomputeEventResults(eventCode) {
  runBackendCommand("recompute_event_results", `--event-code=${eventCode}`);
}

// The header's Refresh is the workspace's only refresh control; it re-reads
// the event, roster, results, and any delivery progress that is showing.
async function refreshWorkspace(page) {
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refreshing…" })).toBeHidden();
  await expect(page.getByText("Workspace updated.")).toBeVisible();
}

// The ranked list beside the calendar starts collapsed; open it on demand.
async function openRankedWindows(page) {
  const details = page
    .getByRole("complementary", { name: "Ranked windows" })
    .locator("details");
  if ((await details.getAttribute("open")) === null) {
    await details.locator("summary").click();
  }
  await expect(details).toHaveAttribute("open", "");
}

module.exports = {
  openRankedWindows,
  refreshWorkspace,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BACKEND_URL,
  EMAIL_FILE_PATH,
  PYTHON_BIN,
  ROOT,
  apiJson,
  codeFromEmailBody,
  continueWithEmail,
  createEvent,
  datetimeLocalHoursFromNow,
  decodeQuotedPrintable,
  dispatchEmailJobs,
  expandAdvancedOptions,
  expectDashboard,
  fillTextbox,
  latestEmailFor,
  latestVerificationCode,
  loginWithEmailCode,
  nextWeekdayDate,
  readSession,
  recomputeEventResults,
  registerAccount,
  runBackendCommand,
  selectOption,
};
