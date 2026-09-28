const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { expect } = require("@playwright/test");
const { DAY_MS } = require("./time");

// Shared plumbing for the Playwright specs: the file-based email sink the
// e2e settings write to, passwordless sign-in/registration through the UI
// and the API, authenticated API calls that seed and move events, and the
// backend management commands and Django snippets the flows run
// synchronously.

const ROOT = path.resolve(__dirname, "../../..");
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:4100";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://127.0.0.1:3100";
const EMAIL_FILE_PATH = process.env.EMAIL_FILE_PATH || "/tmp/releviz-e2e-mail";
const ADMIN_EMAIL = process.env.DJANGO_SUPERUSER_EMAIL || "admin@releviz.local";
const ADMIN_PASSWORD = process.env.DJANGO_SUPERUSER_PASSWORD;
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

if (!ADMIN_PASSWORD) {
  throw new Error(
    "DJANGO_SUPERUSER_PASSWORD must be set before running Playwright.",
  );
}

// The id every spec suffixes its accounts and events with, so tests never
// collide in the shared database and email sink.
function newRunId() {
  return `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
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

const VERIFICATION_EMAIL_SUBJECTS = {
  register: "Verify your email - Releviz",
  login: "Your login code - Releviz",
  password_reset: "Password reset code - Releviz",
  account_delete: "Delete account code - Releviz",
  temp_event_access: "Your verification code - Releviz",
  admin_login: "Admin login code - Releviz",
};

function subjectOf(message) {
  return message.match(/^Subject:\s*(.+)$/im)?.[1]?.trim();
}

// `notCode` skips a code the caller already holds, so a resend waits for the
// newer code instead of returning the superseded one.
async function latestVerificationCode(
  email,
  afterMs,
  purpose,
  { notCode } = {},
) {
  const subject = VERIFICATION_EMAIL_SUBJECTS[purpose];
  if (typeof subject !== "string") {
    throw new Error(`Unknown verification email purpose: ${purpose}`);
  }
  const body = await latestEmailFor(email, afterMs, (message) => {
    const code = codeFromEmailBody(message);
    return subjectOf(message) === subject && Boolean(code) && code !== notCode;
  });
  const code = codeFromEmailBody(body);
  if (!code) throw new Error(`No verification code email found for ${email}`);
  return code;
}

// The emailed one-click sign-in link. Django autoescapes the CTA href and
// strip_tags keeps the entity in the text part, so `&amp;` is undone here.
async function latestAuthLink(email, afterMs, purpose) {
  const subject = VERIFICATION_EMAIL_SUBJECTS[purpose];
  if (typeof subject !== "string") {
    throw new Error(`Unknown verification email purpose: ${purpose}`);
  }
  const linkPattern = /https?:\/\/[^\s"<>]+\/email-auth-link#[^\s"<>]+/;
  const body = await latestEmailFor(
    email,
    afterMs,
    (message) => subjectOf(message) === subject && linkPattern.test(message),
  );
  const url = body.match(linkPattern)[0].replace(/&amp;/g, "&");
  const params = new URLSearchParams(new URL(url).hash.slice(1));
  const code = codeFromEmailBody(body);
  if (params.get("code") !== code) {
    throw new Error(`The emailed link for ${email} does not carry its code`);
  }
  return { url, params, code, body };
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
      // Another test's fixture can vanish between the listing and the stat.
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < afterMs) continue;
      const body = await fs.readFile(file, "utf8");
      // Django can append several messages to one file. They share its mtime,
      // so examine the last message first when selecting the latest match.
      const messages = body.split(/\r?\n-{20,}\r?\n/).reverse();
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

// The invitation email's "Link:" line for a temporary identity, as a path the
// browser can open on the frontend.
function temporaryAccessPathFromEmail(body) {
  const rawLink = body.match(/Link:\s*(https?:\/\/[^\s<]+)/i)?.[1];
  if (!rawLink)
    throw new Error("No temporary access link found in invitation email");
  const link = new URL(rawLink.replaceAll("&amp;", "&"));
  return `${link.pathname}${link.search}`;
}

// The invitation email's "Link:" line for a full account
// (/event?code=…&invitation=…), as an absolute URL.
function invitationLinkFromEmail(body) {
  const link = body.match(/^Link: (.+)$/m)?.[1]?.trim();
  if (!link) throw new Error("No invitation link found in the email");
  return link.replaceAll("&amp;", "&");
}

// Fills the email on the passwordless panel and asks for a code. Firefox on
// CI has dropped the first submit right after hydration; asking again only
// issues another code, and the newest one is the one read.
async function requestEmailCode(page, email) {
  await page.getByLabel("Email").fill(email);
  const codeStep = page.getByRole("heading", { name: "Verify Your Identity" });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page
      .getByRole("button", { name: "Continue", exact: true })
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
}

// Both /login and /signup render the same passwordless panel: request a code
// for an email address, then confirm it. Existing accounts sign in and unknown
// addresses are created, so this drives registration and login alike.
async function continueWithEmail(page, email, startedAt, purpose) {
  await requestEmailCode(page, email);
  const code = await latestVerificationCode(email, startedAt, purpose);
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
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
  await continueWithEmail(page, email, startedAt, "register");

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

// Registers an account without the UI, for tests whose subject is not the
// sign-up itself. The request context keeps a live refresh session, which
// shows up as another device in that account's settings.
async function registerAccountViaApi(request, email, firstName, lastName) {
  const startedAt = Date.now() - 1000;
  const requested = await request.post(
    `${BACKEND_URL}/authn/email-auth/request-code/`,
    { data: { email, source: "login" } },
  );
  expect(requested.status()).toBe(202);
  const code = await latestVerificationCode(email, startedAt, "register");
  const verified = await request.post(
    `${BACKEND_URL}/authn/email-auth/verify-code/`,
    { data: { email, code } },
  );
  expect(verified.status()).toBe(200);
  const payload = await verified.json();
  const profile = await apiJson(
    request,
    "PATCH",
    "/authn/profile/",
    payload.access,
    { first_name: firstName, last_name: lastName },
  );
  expect(profile.response.status()).toBe(200);
  return {
    access: payload.access,
    user: { ...payload.user, id: payload.user.member_uuid },
  };
}

async function loginWithEmailCode(page, email) {
  const startedAt = Date.now() - 1000;
  await page.goto("/login");
  await continueWithEmail(page, email, startedAt, "login");
  await expectDashboard(page);
}

// Registers an account in a fresh browser context and returns its session.
// The caller closes the context.
async function newAccountContext(
  browser,
  email,
  firstName,
  lastName,
  contextOptions = {},
) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await registerAccount(page, email, firstName, lastName);
  const session = await readSession(page);
  return { context, page, session, token: session.access };
}

async function fillTextbox(page, name, value) {
  await page.getByRole("textbox", { name }).fill(value);
}

// Event settings use native <select> controls, so the value is chosen by its
// visible option label. Most of them use the label as the value (timezones);
// pass `expectedValue` for a select whose option values differ from their
// labels.
async function selectOption(
  page,
  name,
  optionName,
  expectedValue = optionName,
) {
  const select = page.getByRole("combobox", { name });
  await select.selectOption({ label: optionName });
  await expect(select).toHaveValue(expectedValue);
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

// The temporary-access session as the browser's own cookies see it.
async function tempAccessSessionState(page, eventCode) {
  return page.evaluate(
    async ({ backendUrl, code }) => {
      const response = await fetch(
        `${backendUrl}/events/temp-access/session?code=${code}`,
        { credentials: "include" },
      );
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { status: response.status, payload };
    },
    { backendUrl: BACKEND_URL, code: eventCode },
  );
}

// Dispatches a cancelable beforeunload and reports whether the page asked the
// browser to keep it open (an unsaved autosave).
async function beforeUnloadIsBlocked(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

// Opens the header account menu for the signed-in display name.
async function openAccountMenu(page, displayName) {
  const trigger = page.getByRole("button", { name: displayName, exact: true });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return { trigger, menu };
}

// Signs the seeded superuser into the Django admin with a password. The
// login page opens on the email-code step; the password form lives behind
// the alternate-mode link.
async function adminPasswordLogin(
  page,
  { email = ADMIN_EMAIL, password = ADMIN_PASSWORD } = {},
) {
  await page.goto(`${BACKEND_URL}/admin/login/?next=/admin/`);
  await page
    .getByRole("link", { name: "Sign in with password instead" })
    .click();
  await page.locator("#id_email").fill(email);
  await page.locator("#id_password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
}

// A deterministic wrong six-digit code.
function differentCode(code) {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
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
// `startingAvailability` is deliberately left out so these events take the
// product default (everyone starts Available); a spec that needs the legacy
// Busy start passes `{ startingAvailability: "busy" }`.
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
  return eventState(request, token, created.payload.event.code);
}

// The organizer's full definition of an event, slot groups included.
async function eventState(request, token, code) {
  const definition = await apiJson(
    request,
    "GET",
    `/events?code=${code}`,
    token,
  );
  expect(definition.response.status()).toBe(200);
  return definition.payload.event;
}

// Saves event settings through the API. Omitted fields keep their stored
// values; the current version is read first.
async function updateEventViaApi(request, token, code, changes) {
  const current = await eventState(request, token, code);
  const updated = await apiJson(request, "PUT", `/events?code=${code}`, token, {
    ...changes,
    expectedVersion: current.version,
  });
  expect(updated.response.status(), JSON.stringify(updated.payload)).toBe(200);
  return updated.payload;
}

// Moves an event through its lifecycle through the API. Reactivating a
// finalized event answers 202 because it queues cancellations.
async function setLifecycleViaApi(request, token, code, status, extra = {}) {
  const current = await eventState(request, token, code);
  const changed = await apiJson(
    request,
    "PUT",
    `/events/lifecycle?code=${code}`,
    token,
    { status, expectedVersion: current.version, ...extra },
  );
  expect(
    [200, 202],
    `lifecycle ${status}: ${JSON.stringify(changed.payload)}`,
  ).toContain(changed.response.status());
  return changed.payload.event;
}

// setLifecycleViaApi with the (request, eventCode, token) argument order the
// participant helpers use.
async function setEventStatus(
  request,
  eventCode,
  token,
  status,
  { responseDeadline } = {},
) {
  return setLifecycleViaApi(
    request,
    token,
    eventCode,
    status,
    responseDeadline === undefined ? {} : { responseDeadline },
  );
}

// Recomputes an event's results synchronously and returns the snapshot.
async function freshResults(request, token, code) {
  recomputeEventResults(code);
  const results = await apiJson(
    request,
    "GET",
    `/events/results?code=${code}`,
    token,
  );
  expect(results.response.status()).toBe(200);
  return results.payload.results;
}

// Confirms a ranked recommendation (an entry of
// `freshResults(...).recommendations`) as the final meeting through the API.
async function finalizeViaApi(
  request,
  token,
  code,
  recommendation,
  { location = "" } = {},
) {
  const current = await eventState(request, token, code);
  const finalized = await apiJson(
    request,
    "PUT",
    `/events/finalization?code=${code}`,
    token,
    {
      startsAt: recommendation.suggestedStartsAt,
      endsAt: recommendation.suggestedEndsAt,
      channel: recommendation.channel,
      location,
      expectedVersion: current.version,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(
    [200, 202],
    `finalize: ${JSON.stringify(finalized.payload)}`,
  ).toContain(finalized.response.status());
  return finalized.payload;
}

// Imports pasted participant rows through the API (preview, then commit).
// The default merges and sends invitations, as the original flows expect;
// pass `mode: "rebuild"` with the event code as `confirmationCode` to
// replace everyone.
async function importRoster(
  request,
  eventCode,
  token,
  pastedText,
  { sendInvitations = true, mode = "merge", confirmationCode } = {},
) {
  const preview = await apiJson(
    request,
    "POST",
    `/events/roster-imports?code=${eventCode}`,
    token,
    { sourceType: "paste", pastedText },
  );
  expect(preview.response.status(), JSON.stringify(preview.payload)).toBe(201);
  const committed = await apiJson(
    request,
    "POST",
    `/events/roster-imports/${preview.payload.import.id}/commit?code=${eventCode}`,
    token,
    {
      mode,
      sendInvitations,
      idempotencyKey: crypto.randomUUID(),
      ...(confirmationCode === undefined ? {} : { confirmationCode }),
    },
  );
  expect(committed.response.status(), JSON.stringify(committed.payload)).toBe(
    201,
  );
  return committed.payload;
}

// importRoster that sends no invitations unless asked to.
async function importRosterApi(request, eventCode, token, pastedText, opts) {
  return importRoster(request, eventCode, token, pastedText, {
    sendInvitations: false,
    ...opts,
  });
}

// Adds a managed participant, without inviting them, and submits the given
// availability. `inperson` and `virtual` list the slot indices the person is
// free for. Nobody is invited, so finalizing never depends on how far the
// email worker has got.
async function submitResponse(
  request,
  token,
  event,
  { name, email, inperson = [], virtual = [], weight = null },
) {
  const created = await apiJson(
    request,
    "POST",
    `/events/participants/managed?code=${event.code}`,
    token,
    {
      name,
      email,
      sendInvitation: false,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(created.response.status()).toBe(201);
  const participant = created.payload.participant;
  const schedule = await apiJson(
    request,
    "GET",
    `/events/roster/${participant.id}/schedule?code=${event.code}`,
    token,
  );
  expect(schedule.response.status()).toBe(200);
  const version =
    schedule.payload.schedule?.version ?? schedule.payload.participant?.version;
  const toArray = (indices) =>
    Array.from({ length: event.slotCount }, (_, index) =>
      indices.includes(index) ? 1 : 0,
    );
  const updated = await apiJson(
    request,
    "PUT",
    `/events/participants/update?code=${event.code}&participantId=${participant.id}`,
    token,
    {
      availabilityInperson: toArray(inperson),
      availabilityVirtual: toArray(virtual),
      submitted: 1,
      expectedVersion: version,
    },
  );
  expect(updated.response.status()).toBe(200);
  if (weight !== null) {
    const roster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${event.code}&search=${encodeURIComponent(email)}&pageSize=5`,
      token,
    );
    const row = roster.payload.participants.find(
      (entry) => entry.email === email,
    );
    expect(row).toBeTruthy();
    const patched = await apiJson(
      request,
      "PATCH",
      `/events/roster/${row.id}?code=${event.code}`,
      token,
      { weight, expectedVersion: row.version },
    );
    expect(patched.response.status()).toBe(200);
  }
  return participant;
}

// The index of the slot starting at `localStart` ("HH:MM") in the slot group
// `groupKey` ("weekday:1" for Monday, "date:YYYY-MM-DD" for a specific date).
function slotIndex(event, groupKey, localStart) {
  const group = event.slotGroups.find((entry) => entry.key === groupKey);
  const slot = group?.slots.find((entry) => entry.localStart === localStart);
  if (!slot) throw new Error(`No slot ${groupKey} ${localStart}`);
  return slot.index;
}

// A participant's own response as the API reports it (the caller is not the
// organizer, so the payload carries their schedule and nobody else's).
async function ownResponse(request, token, eventCode) {
  const state = await apiJson(
    request,
    "GET",
    `/events/participants?code=${eventCode}`,
    token,
  );
  expect(state.response.status()).toBe(200);
  expect(state.payload.participants).toHaveLength(1);
  return state.payload.participants[0];
}

function backendProcessOptions() {
  return {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "src/api"),
      DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  };
}

// Runs a management command synchronously and returns its stdout. A failing
// command throws with its stderr in the message.
function runBackendCommand(command, ...args) {
  try {
    return execFileSync(
      PYTHON_BIN,
      [
        path.join(ROOT, "src/api/manage.py"),
        command,
        ...args,
        "--settings=config.settings.e2e",
      ],
      backendProcessOptions(),
    );
  } catch (error) {
    error.message = `${error.message}\n${error.stderr || ""}`;
    throw error;
  }
}

const DJANGO_PRELUDE = `
import json
import os
import sys

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")
django.setup()

data = json.loads(sys.argv[1])
`;

// Runs a Python snippet against the e2e database with `data` bound to the
// given payload and returns its stdout. Use it only for reads, or for writes
// scoped to rows the calling test created: the database is shared.
function runDjangoScript(body, data = {}) {
  try {
    return execFileSync(
      PYTHON_BIN,
      ["-c", `${DJANGO_PRELUDE}\n${body}`, JSON.stringify(data)],
      backendProcessOptions(),
    );
  } catch (error) {
    error.message = `${error.message}\n${error.stderr || ""}`;
    throw error;
  }
}

// runDjangoScript for a snippet that prints one JSON value on its last line.
function runDjangoJson(body, data = {}) {
  const lines = runDjangoScript(body, data)
    .split(/\r?\n/)
    .filter((line) => line.trim());
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

// Lifts the 60 s resend cooldown for this test's own address only, so a real
// resend can be exercised without sleeping. Returns the number of pending
// challenges moved back in time.
function expireResendCooldown(email) {
  return runDjangoJson(
    `
from datetime import timedelta

from django.db.models import F

from apps.authn.models import EmailAuthChallenge

updated = EmailAuthChallenge.objects.filter(
    target_email__iexact=data["email"], status="pending"
).update(last_sent_at=F("last_sent_at") - timedelta(seconds=61))
print(json.dumps(updated))
`,
    { email },
  );
}

// The member UUID of the account that owns `email`.
function memberIdForEmail(email) {
  return runDjangoJson(
    `
from apps.authn.models import ContactEmail

contact = ContactEmail.objects.get(email_address__iexact=data["email"])
print(json.dumps(str(contact.member_id)))
`,
    { email },
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

// The recommended times are a collapsed list inside the Finalize step; open
// Finalize first, then the list (the calendar outlines the recommended times
// only while the list is open).
async function openRecommendedTimes(page) {
  const finalize = page.locator("details#organizer-finalize");
  if ((await finalize.getAttribute("open")) === null) {
    await finalize.locator("> summary").click();
  }
  await expect(finalize).toHaveAttribute("open", "");
  const details = page.locator("details.organizer-recommended-times");
  if ((await details.getAttribute("open")) === null) {
    await details.locator("> summary").click();
  }
  await expect(details).toHaveAttribute("open", "");
}

// The Blocked times step under the calendar starts closed; while it is open
// the meeting calendar is the paint surface for blocked times.
async function openBlockedTimes(page) {
  const details = page.locator("details.organizer-blocked-times");
  if ((await details.getAttribute("open")) === null) {
    await details.locator("summary").click();
  }
  await expect(details).toHaveAttribute("open", "");
}

async function closeBlockedTimes(page) {
  const details = page.locator("details.organizer-blocked-times");
  if ((await details.getAttribute("open")) !== null) {
    await details.locator("summary").click();
  }
  await expect(details).not.toHaveAttribute("open", "");
}

module.exports = {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BACKEND_URL,
  EMAIL_FILE_PATH,
  FRONTEND_URL,
  PYTHON_BIN,
  ROOT,
  VERIFICATION_EMAIL_SUBJECTS,
  adminPasswordLogin,
  apiJson,
  beforeUnloadIsBlocked,
  closeBlockedTimes,
  codeFromEmailBody,
  continueWithEmail,
  createEvent,
  datetimeLocalHoursFromNow,
  decodeQuotedPrintable,
  differentCode,
  dispatchEmailJobs,
  eventState,
  expandAdvancedOptions,
  expectDashboard,
  expireResendCooldown,
  fillTextbox,
  finalizeViaApi,
  freshResults,
  importRoster,
  importRosterApi,
  invitationLinkFromEmail,
  latestAuthLink,
  latestEmailFor,
  latestVerificationCode,
  loginWithEmailCode,
  memberIdForEmail,
  newAccountContext,
  newRunId,
  nextWeekdayDate,
  openAccountMenu,
  openBlockedTimes,
  openRecommendedTimes,
  ownResponse,
  readSession,
  recomputeEventResults,
  registerAccount,
  registerAccountViaApi,
  requestEmailCode,
  runBackendCommand,
  runDjangoJson,
  runDjangoScript,
  selectOption,
  setEventStatus,
  setLifecycleViaApi,
  slotIndex,
  submitResponse,
  tempAccessSessionState,
  temporaryAccessPathFromEmail,
  updateEventViaApi,
};

// Blocks (or, with `blocked: false`, clears) the per-account bucket of one
// durable rate-limit scope ("invitation_request", "invitation_recipient",
// "reminder_request", ...) for the account that owns `email`, so a throttled
// request can be exercised without spending the per-IP budget every test
// shares. Only that account's own bucket is written. Returns whether a bucket
// was blocked or removed.
function setRateLimitBlock(email, scope, { blocked = true } = {}) {
  return runDjangoJson(
    `
from datetime import timedelta
from django.utils import timezone
from apps.authn.models import AuthRateLimitBucket, ContactEmail
from apps.authn.security.helpers import _key_hash, normalize_security_identity
member_id = ContactEmail.objects.get(email_address__iexact=data["email"]).member_id
scope = data["scope"]
key_hash = _key_hash(scope, "identity", normalize_security_identity(str(member_id)))
buckets = AuthRateLimitBucket.objects.filter(scope=f"{scope}:identity", key_hash=key_hash)
if data["blocked"]:
    now = timezone.now()
    AuthRateLimitBucket.objects.update_or_create(
        scope=f"{scope}:identity",
        key_hash=key_hash,
        defaults={"window_started_at": now, "blocked_until": now + timedelta(minutes=30)},
    )
    print(json.dumps(True))
else:
    print(json.dumps(buckets.delete()[0] > 0))
`,
    { email, scope, blocked },
  );
}

module.exports.setRateLimitBlock = setRateLimitBlock;

// Encrypts the named password fields of an API payload the way the web app
// does (RSA-OAEP with SHA-256 under the published key) and adds the key id.
// The E2E settings require encrypted passwords, so a plaintext password is
// refused before it is ever checked.
async function encryptPasswordFields(request, payload, fields) {
  const nodeCrypto = require("node:crypto");
  const keyResponse = await request.get(`${BACKEND_URL}/authn/public-key/`);
  expect(keyResponse.status()).toBe(200);
  const key = await keyResponse.json();
  const secured = { ...payload, key_id: key.key_id };
  for (const field of fields) {
    secured[field] = nodeCrypto
      .publicEncrypt(
        {
          key: key.public_key,
          padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(String(secured[field])),
      )
      .toString("base64");
  }
  return secured;
}

// Posts a password sign-in to the API, encrypted like the web app's unless
// `encrypt` is false. Returns `{ response, payload }` without asserting the
// status. A successful sign-in leaves a refresh cookie in `request`.
async function passwordLoginViaApi(
  request,
  email,
  password,
  { encrypt = true } = {},
) {
  const data = encrypt
    ? await encryptPasswordFields(request, { email, password }, ["password"])
    : { email, password };
  const response = await request.post(`${BACKEND_URL}/authn/login/`, { data });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

// Gives the account that owns `email` a password (accounts made by email
// code have none), writing only that account's own row. Access tokens issued
// before carry the old password hash and stop working, so sign a browser in
// afterwards (e.g. passwordLoginViaApi(page.request, ...)).
function setAccountPassword(email, password) {
  runDjangoScript(
    `
from apps.authn.models import ContactEmail

member = ContactEmail.objects.get(email_address__iexact=data["email"]).member
member.set_password(data["password"])
member.save(update_fields=["password"])
`,
    { email, password },
  );
}

module.exports.encryptPasswordFields = encryptPasswordFields;
module.exports.passwordLoginViaApi = passwordLoginViaApi;
module.exports.setAccountPassword = setAccountPassword;
