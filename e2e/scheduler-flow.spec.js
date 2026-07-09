const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:4100";
const EMAIL_FILE_PATH = process.env.EMAIL_FILE_PATH || "/tmp/releviz-e2e-mail";
const ADMIN_EMAIL = process.env.DJANGO_SUPERUSER_EMAIL || "admin@releviz.local";
const ADMIN_PASSWORD = process.env.DJANGO_SUPERUSER_PASSWORD || "Admin12345!";

async function latestVerificationCode(email, afterMs) {
  const body = await latestEmailFor(email, afterMs, (message) =>
    /verification code is \d{6}/i.test(message)
  );
  const code = body.match(/verification code is (\d{6})/i)?.[1];
  if (!code) throw new Error(`No verification code email found for ${email}`);
  return code;
}

async function latestEmailFor(email, afterMs, predicate = () => true) {
  const deadline = Date.now() + 20_000;
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
      if (!body.includes(email)) continue;
      if (predicate(body)) matches.push({ body, mtimeMs: stat.mtimeMs });
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (matches[0]) return matches[0].body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No matching email found for ${email}`);
}

async function registerAccount(page, email, firstName, lastName) {
  const startedAt = Date.now() - 1000;
  await page.goto("/signup");
  await page.getByLabel("First name").fill(firstName);
  await page.getByLabel("Last name").fill(lastName);
  await page.getByLabel("Organization").fill("Releviz E2E");
  await page.getByLabel("Title").fill("Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Password123!");
  await page.getByLabel("Confirm password").fill("Password123!");
  await page.getByRole("button", { name: "Send verification code" }).click();
  await expect(page.getByText("Enter the email verification code.")).toBeVisible();
  const code = await latestVerificationCode(email, startedAt);
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const welcome = await latestEmailFor(email, startedAt, (body) =>
    body.includes("Welcome to Releviz")
  );
  expect(welcome).toContain("Your account is ready");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        try {
          const session = JSON.parse(window.localStorage.getItem("releviz.auth") || "null");
          return Boolean(session?.access && session?.user?.id);
        } catch {
          return false;
        }
      })
    )
    .toBe(true);
  await expect(page.getByRole("heading", { name: "My Dashboard" })).toBeVisible();
}

async function loginWithEmailCode(page, email) {
  const startedAt = Date.now() - 1000;
  await page.goto("/login");
  await page.getByRole("button", { name: "Email code" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText("Verification code sent. Check your email.")).toBeVisible();
  const code = await latestVerificationCode(email, startedAt);
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const alert = await latestEmailFor(email, startedAt, (body) =>
    body.includes("A new login was completed") && body.includes("email verification code")
  );
  expect(alert).toContain("User agent:");
}

async function loginWithPassword(page, email) {
  const startedAt = Date.now() - 1000;
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Password123!");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const alert = await latestEmailFor(email, startedAt, (body) =>
    body.includes("A new login was completed") && body.includes("Method: password")
  );
  expect(alert).toContain("IP address:");
}

async function fillTextbox(page, name, value) {
  await page.getByRole("textbox", { name }).fill(value);
}

async function readSession(page) {
  return page.evaluate(() => JSON.parse(window.localStorage.getItem("releviz.auth")));
}

function datetimeLocalHoursFromNow(hours) {
  const value = new Date(Date.now() + hours * 60 * 60 * 1000);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
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

function assertDatabaseState(payload) {
  const script = `
import json
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")
django.setup()

from apps.authn.models import Member
from apps.messaging.models import EmailMessageLog
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent, Weight

data = json.loads(${JSON.stringify(JSON.stringify(payload))})
event = Event.objects.get(code=data["code"])
organizer = Member.objects.get(pk=data["organizer_id"])
participant_member = Member.objects.get(pk=data["participant_id"])
participant = Participant.objects.get(event=event, member=participant_member)
weight = Weight.objects.get(event=event, participant=participant)

assert organizer.email == data["organizer_email"]
assert participant_member.email == data["participant_email"]
assert event.organizer_id == organizer.pk
assert participant.submitted is True
assert participant.group_name == "E2E Group"
assert participant.sort_order == 2
assert participant.hidden is False
assert weight.weight == 0.5
assert weight.included is True
assert event.response_deadline is not None
assert event.reminders_enabled is True
assert UserEvent.objects.filter(event=event, member=organizer, role="organizer").exists()
assert UserEvent.objects.filter(event=event, member=participant_member, role="participant").exists()

registered_invitation = EventInvitation.objects.get(event=event, email=data["participant_email"])
manual_invitation = EventInvitation.objects.get(event=event, email=data["manual_email"])
assert registered_invitation.member_id == participant_member.pk
assert registered_invitation.status == "submitted"
assert manual_invitation.member_id is None
assert manual_invitation.status == "invited"
assert manual_invitation.reminder_sent_at is not None
assert EmailMessageLog.objects.filter(recipient=data["organizer_email"], message_type="welcome", status="sent").exists()
assert EmailMessageLog.objects.filter(recipient=data["participant_email"], message_type="welcome", status="sent").exists()
assert EmailMessageLog.objects.filter(message_type="login_alert", status="sent").count() >= 2
assert EmailMessageLog.objects.filter(event=event, message_type="invitation", status="sent").count() >= 2
assert EmailMessageLog.objects.filter(event=event, message_type="reminder", status="sent").count() >= 1
`;
  execFileSync("python3", ["-c", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "backend/src"),
      DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    },
    stdio: "pipe",
  });
}

test.describe("Scheduler account and scheduling flow", () => {
  test("registers users, schedules an event, checks permissions, and persists to Postgres", async ({
    browser,
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const organizerEmail = `organizer-${runId}@example.com`;
    const participantEmail = `participant-${runId}@example.com`;
    const manualEmail = `manual-${runId}@example.com`;

    await registerAccount(page, organizerEmail, "Olivia", "Organizer");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(page.getByRole("heading", { name: "Releviz" })).toBeVisible();
    await fillTextbox(page, "Event Name", `E2E Planning ${runId}`);
    await fillTextbox(page, "Location / Address", "E2E Room");
    await page.locator('input[type="datetime-local"]').fill(datetimeLocalHoursFromNow(48));
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    expect(eventCode).toMatch(/^[A-Z0-9]+$/);
    await expect(page.getByText("Organizer Dashboard")).toBeVisible();

    const organizerSession = await readSession(page);
    const participantContext = await browser.newContext();
    const participantPage = await participantContext.newPage();
    await registerAccount(participantPage, participantEmail, "Pat", "Participant");

    const codeLoginContext = await browser.newContext();
    const codeLoginPage = await codeLoginContext.newPage();
    await loginWithEmailCode(codeLoginPage, participantEmail);
    await codeLoginContext.close();

    const passwordLoginContext = await browser.newContext();
    const passwordLoginPage = await passwordLoginContext.newPage();
    await loginWithPassword(passwordLoginPage, organizerEmail);
    await passwordLoginContext.close();

    const inviteStartedAt = Date.now() - 1000;
    await page.getByRole("textbox", { name: "Invite emails" }).fill(
      `${participantEmail}, ${manualEmail}`
    );
    await page.locator('textarea[placeholder="Optional message"]').fill("Please add your times.");
    await page.getByRole("button", { name: "Send Invitations" }).click();
    await expect(page.getByText("Sent 2 invitation(s).")).toBeVisible();
    await expect(page.getByText(participantEmail)).toBeVisible();
    await expect(page.getByText(manualEmail)).toBeVisible();
    const registeredInvite = await latestEmailFor(participantEmail, inviteStartedAt, (body) =>
      body.includes(`event?code=${eventCode}`) && body.includes("BEGIN:VCALENDAR")
    );
    expect(registeredInvite).toContain("Please add your times.");
    const manualInvite = await latestEmailFor(manualEmail, inviteStartedAt, (body) =>
      body.includes(`event?code=${eventCode}`) && body.includes("BEGIN:VCALENDAR")
    );
    expect(manualInvite).toContain("Share your availability");

    await participantPage.goto(`/event?code=${eventCode}`);
    await expect(participantPage.getByRole("heading", { name: "Join Event" })).toBeVisible();
    await participantPage.getByRole("button", { name: /Join as Pat Participant/ }).click();
    await expect(participantPage.getByText(/Welcome, Pat Participant/)).toBeVisible();
    const participantSession = await readSession(participantPage);
    const schedule = Array(56).fill(0);
    schedule[0] = 1;
    const submittedSchedule = await apiJson(
      request,
      "PUT",
      `/api/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      {
        scheduleInperson: JSON.stringify(schedule),
        scheduleVirtual: JSON.stringify(schedule),
        submitted: 1,
      }
    );
    expect(submittedSchedule.response.status()).toBe(200);

    const reminderStartedAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Send Reminders" }).click();
    await expect(page.getByText("Sent 1 reminder(s).")).toBeVisible();
    const reminder = await latestEmailFor(manualEmail, reminderStartedAt, (body) =>
      body.includes("Reminder:") && body.includes("BEGIN:VCALENDAR")
    );
    expect(reminder).toContain(`event?code=${eventCode}`);

    await participantPage.goto("/dashboard");
    await expect(participantPage.getByText("Events I Participate In (1)")).toBeVisible();
    await expect(participantPage.getByText(`E2E Planning ${runId}`)).toBeVisible();
    await participantPage.goto("/settings");
    await participantPage.getByLabel("Title").fill("Availability Tester");
    await participantPage.getByRole("button", { name: "Save" }).click();
    await expect(participantPage.getByText("Saved")).toBeVisible();

    await page.goto("/dashboard");
    await expect(page.getByText("My Events (1)")).toBeVisible();
    await expect(page.getByText(`E2E Planning ${runId}`)).toBeVisible();

    const deniedWeights = await apiJson(
      request,
      "PUT",
      `/api/events/weights?code=${eventCode}`,
      participantSession.access,
      { weights: [{ participantId: participantSession.user.id, weight: 0.25, included: 1 }] }
    );
    expect(deniedWeights.response.status()).toBe(403);

    const deniedGroup = await apiJson(
      request,
      "PUT",
      `/api/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      { groupName: "Denied" }
    );
    expect(deniedGroup.response.status()).toBe(403);

    const savedWeight = await apiJson(
      request,
      "PUT",
      `/api/events/weights?code=${eventCode}`,
      organizerSession.access,
      { weights: [{ participantId: participantSession.user.id, weight: 0.5, included: 1 }] }
    );
    expect(savedWeight.response.status()).toBe(200);
    expect(savedWeight.payload.weights[0]).toEqual(
      expect.objectContaining({
        participant_id: participantSession.user.id,
        weight: 0.5,
        included: 1,
      })
    );

    const groupUpdate = await apiJson(
      request,
      "PUT",
      `/api/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      organizerSession.access,
      { groupName: "E2E Group", sortOrder: 2 }
    );
    expect(groupUpdate.response.status()).toBe(200);
    expect(groupUpdate.payload.participant.group_name).toBe("E2E Group");

    const hideResult = await apiJson(
      request,
      "DELETE",
      `/api/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      organizerSession.access
    );
    expect(hideResult.response.status()).toBe(200);
    const unhideResult = await apiJson(
      request,
      "PUT",
      `/api/events/participants/update/unhide?code=${eventCode}&participantId=${participantSession.user.id}`,
      organizerSession.access
    );
    expect(unhideResult.response.status()).toBe(200);

    assertDatabaseState({
      code: eventCode,
      organizer_id: organizerSession.user.id,
      participant_id: participantSession.user.id,
      organizer_email: organizerEmail,
      participant_email: participantEmail,
      manual_email: manualEmail,
    });
    await participantContext.close();
  });
});

test.describe("Scheduler admin", () => {
  test("renders the themed admin login and authenticated sidebar", async ({ page }) => {
    await page.goto(`${BACKEND_URL}/admin/login/?next=/admin/`);
    await expect(page.locator(".login-box")).toBeVisible();
    await expect(page.locator("img.login-logo")).toHaveAttribute("src", /scheduler-logo\.svg/);
    await expect(page.getByText("Scheduler Admin")).toBeVisible();
    await page.locator("#id_email").fill(ADMIN_EMAIL);
    await page.locator("#id_password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin\/$/);
    await expect(
      page.locator("#nav-sidebar-apps").getByRole("heading", { name: "Scheduling" })
    ).toBeVisible();
    await expect(
      page.locator("#nav-sidebar-apps").getByRole("heading", { name: "Members & Authentication" })
    ).toBeVisible();
    await expect(page.locator('[data-admin-theme-choice="dark"]').first()).toBeAttached();
  });
});
