const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");

const ROOT = path.resolve(__dirname, "../..");
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:4100";
const EMAIL_FILE_PATH = process.env.EMAIL_FILE_PATH || "/tmp/releviz-e2e-mail";
const ADMIN_EMAIL = process.env.DJANGO_SUPERUSER_EMAIL || "admin@releviz.local";
const ADMIN_PASSWORD = process.env.DJANGO_SUPERUSER_PASSWORD || "Admin12345!";

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
  await expect(page.getByRole("heading", { name: "My Dashboard" })).toBeVisible();
  const welcome = await latestEmailFor(email, startedAt, (body) =>
    body.includes("Welcome to Releviz")
  );
  expect(welcome).toContain("Your account is ready");
  const storedCredentials = await page.evaluate(() => ({
    local: window.localStorage.getItem("releviz.auth"),
    session: window.sessionStorage.getItem("releviz.auth"),
    visibleCookies: document.cookie,
  }));
  expect(storedCredentials.local).toBeNull();
  expect(storedCredentials.session).toBeNull();
  expect(storedCredentials.visibleCookies).not.toContain("releviz_refresh");
  await page.reload();
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
  await expect(page.getByRole("heading", { name: "My Dashboard" })).toBeVisible();
  const alert = await latestEmailFor(
    email,
    startedAt,
    (body) => body.includes("A new login was completed") && body.includes("email verification code")
  );
  expect(alert).toContain("User agent:");
}

async function loginWithPassword(page, email, password = "Password123!", verifyAlert = true) {
  const startedAt = Date.now() - 1000;
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "My Dashboard" })).toBeVisible();
  if (!verifyAlert) return;
  const alert = await latestEmailFor(
    email,
    startedAt,
    (body) => body.includes("A new login was completed") && body.includes("Method: password")
  );
  expect(alert).toContain("IP address:");
}

async function fillTextbox(page, name, value) {
  await page.getByRole("textbox", { name }).fill(value);
}

async function expandAdvancedOptions(page) {
  const panel = page.locator("details").filter({ hasText: "Advanced options" });
  await panel.locator("summary").click();
  await expect(panel).toHaveAttribute("open", "");
}

async function readSession(page) {
  return page.evaluate(async (backendUrl) => {
    const response = await fetch(`${backendUrl}/authn/refresh/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "include",
    });
    if (!response.ok) throw new Error(`Unable to refresh test session: ${response.status}`);
    return response.json();
  }, BACKEND_URL);
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

function assertDatabaseState(payload) {
  const script = `
import json
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")
django.setup()

from apps.authn.models import AuthSession, Member
from apps.messaging.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import Event, EventInvitation, FinalMeeting, Participant, UserEvent, Weight
from apps.scheduling.utils import expected_availability_length

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
assert isinstance(participant.availability_inperson, list)
assert isinstance(participant.availability_virtual, list)
assert len(participant.availability_inperson) == expected_availability_length(event)
assert len(participant.availability_virtual) == expected_availability_length(event)
assert participant.group_name == "E2E Group"
assert participant.sort_order == 2
assert participant.hidden is False
assert weight.weight == 0.5
assert weight.included is True
assert event.response_deadline is not None
assert event.reminders_enabled is True
assert event.status == "finalized"
assert event.start_minutes == 9 * 60
assert event.end_minutes == 17 * 60
assert event.slot_minutes == 30
assert event.spans_next_day is False
assert UserEvent.objects.filter(event=event, member=organizer, role="organizer").exists()
assert UserEvent.objects.filter(event=event, member=participant_member, role="participant").exists()
assert AuthSession.objects.filter(member=organizer, revoked_at__isnull=True).exists()
assert AuthSession.objects.filter(member=participant_member, revoked_at__isnull=True).exists()

registered_invitation = EventInvitation.objects.get(event=event, email=data["participant_email"])
manual_invitation = EventInvitation.objects.get(event=event, email=data["manual_email"])
assert registered_invitation.member_id == participant_member.pk
assert registered_invitation.status == "submitted"
assert registered_invitation.opened_at is not None
assert registered_invitation.joined_at is not None
assert registered_invitation.draft_saved_at is not None
assert registered_invitation.submitted_at is not None
assert manual_invitation.member_id is None
assert manual_invitation.status == "invited"
assert manual_invitation.reminder_sent_at is not None
assert EmailMessageLog.objects.filter(recipient=data["organizer_email"], message_type="welcome", status="sent").exists()
assert EmailMessageLog.objects.filter(recipient=data["participant_email"], message_type="welcome", status="sent").exists()
assert EmailMessageLog.objects.filter(message_type="login_alert", status="sent").count() >= 2
auth_jobs = EmailDeliveryJob.objects.filter(
    member__in=[organizer, participant_member],
    message_type__in=["verification", "welcome", "login_alert"],
)
assert auth_jobs.filter(message_type="verification", status="sent", auth_challenge__isnull=False).count() >= 3
assert auth_jobs.filter(message_type="welcome", status="sent").count() == 2
assert auth_jobs.filter(message_type="login_alert", status="sent", auth_session__isnull=False).count() >= 2
assert not auth_jobs.filter(event__isnull=False).exists()
assert not auth_jobs.filter(content_encrypted=False).exists()
assert not auth_jobs.filter(message_type="verification", body__icontains="verification code is").exists()
assert EmailMessageLog.objects.filter(
    delivery_job__in=auth_jobs,
    status="sent",
).count() >= auth_jobs.filter(status="sent").count()
assert EmailMessageLog.objects.filter(event=event, message_type="invitation", status="sent").count() >= 2
assert EmailMessageLog.objects.filter(event=event, message_type="reminder", status="sent").count() >= 1
assert EmailDeliveryJob.objects.filter(event=event, message_type="invitation", status="sent", invitation__isnull=False).count() == 2
assert EmailDeliveryJob.objects.filter(event=event, message_type="reminder", status="sent", invitation__isnull=False).count() == 1
invitation_request = EmailDeliveryRequest.objects.get(event=event, operation="invitation")
reminder_request = EmailDeliveryRequest.objects.get(event=event, operation="reminder")
assert invitation_request.recipient_count == 2
assert invitation_request.created_job_count == 2
assert invitation_request.jobs.count() == 2
assert reminder_request.recipient_count == 1
assert reminder_request.created_job_count == 1
assert reminder_request.jobs.count() == 1
meeting = FinalMeeting.objects.get(event=event)
assert meeting.active is True
assert meeting.calendar_uid == data["calendar_uid"]
assert meeting.calendar_sequence == 2
assert meeting.starts_at.isoformat().startswith(data["final_date"] + "T10:00:00")
assert EmailDeliveryJob.objects.filter(event=event, message_type="final_confirmation", status="sent").count() >= 6
assert EmailDeliveryJob.objects.filter(event=event, message_type="final_cancellation", status="sent").count() >= 3
assert EmailMessageLog.objects.filter(event=event, message_type="final_confirmation", status="sent").count() >= 6
assert EmailMessageLog.objects.filter(event=event, message_type="final_cancellation", status="sent").count() >= 3
`;
  execFileSync("python3", ["-c", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "src/backend"),
      DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    },
    stdio: "pipe",
  });
}

function assertDeletedAccountState(payload) {
  const script = `
import json
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")
django.setup()

from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from apps.authn.models import AuthSession, ContactEmail, ContactPhone, EmailAuthChallenge, Member
from apps.messaging.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import EventInvitation

data = json.loads(${JSON.stringify(JSON.stringify(payload))})
member = Member.objects.get(pk=data["member_id"])

assert member.is_active is False
assert member.is_staff is False
assert member.is_superuser is False
assert member.email == ""
assert member.first_name == ""
assert member.last_name == ""
assert member.organization == ""
assert member.title == ""
assert member.profile_image == ""
assert member.admin_apps == []
assert not member.has_usable_password()
assert not ContactEmail.objects.filter(member=member).exists()
assert not ContactPhone.objects.filter(member=member).exists()
assert not EmailAuthChallenge.objects.filter(member=member).exists()
assert not EmailDeliveryJob.objects.filter(member=member).exists()
assert not EmailMessageLog.objects.filter(recipient=data["email"]).exists()
assert not EventInvitation.objects.filter(email=data["email"]).exists()
assert not EventInvitation.objects.filter(member=member).exists()
assert not AuthSession.objects.filter(member=member, revoked_at__isnull=True).exists()
assert AuthSession.objects.filter(member=member, revoked_reason="account_delete").exists()
outstanding = OutstandingToken.objects.filter(user=member)
assert outstanding.exists()
assert not outstanding.filter(blacklistedtoken__isnull=True).exists()
assert BlacklistedToken.objects.filter(token__user=member).exists()
`;
  execFileSync("python3", ["-c", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "src/backend"),
      DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    },
    stdio: "pipe",
  });
}

function assertManagedEventState(payload) {
  const script = `
import json
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")
django.setup()

from apps.scheduling.models import (
    Event,
    EventDeletionRecord,
    EventDuplicationRequest,
    Participant,
)
from apps.scheduling.utils import expected_availability_length

data = json.loads(${JSON.stringify(JSON.stringify(payload))})
event = Event.objects.get(code=data["original_code"])
participant = Participant.objects.get(event=event, member_id=data["organizer_id"])

assert event.name == data["updated_name"]
assert event.status == "archived"
assert event.end_minutes == 17 * 60 + 30
assert participant.submitted is False
assert participant.version == 3
assert len(participant.availability_inperson) == expected_availability_length(event)
assert len(participant.availability_virtual) == expected_availability_length(event)
assert not any(participant.availability_inperson)
assert not any(participant.availability_virtual)

assert not Event.objects.filter(code=data["deleted_copy_code"]).exists()
deletion = EventDeletionRecord.objects.get(code=data["deleted_copy_code"])
assert str(deletion.organizer_id) == data["organizer_id"]
assert deletion.deleted_version == 1
duplication = EventDuplicationRequest.objects.get(source_event=event)
assert duplication.source_version < event.version
assert duplication.duplicate_event_id is None
`;
  execFileSync("python3", ["-c", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "src/backend"),
      DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    },
    stdio: "pipe",
  });
}

test.describe("Releviz account and scheduling flow", () => {
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
    await expectAccessible(page, "organizer dashboard");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(page.getByRole("heading", { name: "Create event" })).toBeVisible();
    await expectAccessible(page, "create event");
    await fillTextbox(page, "Event Name", `E2E Planning ${runId}`);
    await expandAdvancedOptions(page);
    await fillTextbox(page, "Location / Address", "E2E Room");
    await page.getByLabel("Event timezone").fill("UTC");
    await page.locator('input[type="datetime-local"]').fill(datetimeLocalHoursFromNow(48));
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    expect(eventCode).toMatch(/^[A-Z0-9]+$/);
    await expect(page.getByText("Organizer Dashboard")).toBeVisible();
    await expectAccessible(page, "organizer event");

    const organizerSession = await readSession(page);
    const organizerDraft = await apiJson(
      request,
      "POST",
      `/events/participants?code=${eventCode}`,
      organizerSession.access,
      {}
    );
    expect(organizerDraft.response.status()).toBe(201);
    const eventDefinitionResponse = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access
    );
    expect(eventDefinitionResponse.response.status()).toBe(200);
    const eventDefinition = eventDefinitionResponse.payload.event;
    expect(eventDefinition.slotMinutes).toBe(30);
    expect(eventDefinition.slotCount).toBeGreaterThan(0);
    const participantContext = await browser.newContext({
      hasTouch: true,
      viewport: { width: 320, height: 720 },
    });
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
    await page
      .getByRole("textbox", { name: "Invite emails" })
      .fill(`${participantEmail}, ${manualEmail}`);
    await page.locator('textarea[placeholder="Optional message"]').fill("Please add your times.");
    await page.getByRole("button", { name: "Send Invitations" }).click();
    await expect(page.getByText("Sent 2 invitation(s).")).toBeVisible();
    await expect(page.getByText(participantEmail)).toBeVisible();
    await expect(page.getByText(manualEmail)).toBeVisible();
    const registeredInvite = await latestEmailFor(
      participantEmail,
      inviteStartedAt,
      (body) => body.includes(`event?code=${eventCode}`) && body.includes("BEGIN:VCALENDAR")
    );
    expect(registeredInvite).toContain("Please add your times.");
    const registeredInvitationLink = registeredInvite.match(/^Link: (.+)$/m)?.[1]?.trim();
    expect(registeredInvitationLink).toMatch(
      new RegExp(`/event\\?code=${eventCode}&invitation=[0-9a-f-]+$`, "i")
    );
    const manualInvite = await latestEmailFor(
      manualEmail,
      inviteStartedAt,
      (body) => body.includes(`event?code=${eventCode}`) && body.includes("BEGIN:VCALENDAR")
    );
    expect(manualInvite).toContain("Share your availability");

    await participantPage.goto(registeredInvitationLink);
    await expect(participantPage.getByRole("heading", { name: "Join Event" })).toBeVisible();
    let invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access
    );
    let registeredInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === participantEmail
    );
    expect(registeredInvitation.status).toBe("opened");
    expect(registeredInvitation.openedAt).toBeTruthy();
    expect(registeredInvitation.awaitingReminder).toBe(true);
    await expectAccessible(participantPage, "participant join at 320px");
    await participantPage.getByRole("button", { name: /Join as Pat Participant/ }).click();
    await expect(participantPage.getByText(/Welcome, Pat Participant/)).toBeVisible();
    invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access
    );
    registeredInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === participantEmail
    );
    expect(registeredInvitation.status).toBe("joined");
    expect(registeredInvitation.joinedAt).toBeTruthy();
    await expectAccessible(participantPage, "participant schedule at 320px");
    const participantSession = await readSession(participantPage);
    const participantState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access
    );
    expect(participantState.response.status()).toBe(200);
    const initialParticipant = participantState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id
    );
    expect(initialParticipant).toBeTruthy();

    const savedStatus = participantPage.getByText("Draft saved. Submit when you are ready.");
    const allSlotIndexes = eventDefinition.slotGroups.flatMap((group) =>
      group.slots.map((slot) => slot.index)
    );
    expect(allSlotIndexes.length).toBeGreaterThan(3);
    const [touchSlotIndex, keyboardSlotIndex, serverSlotIndex, conflictLocalSlotIndex] =
      allSlotIndexes;
    const availabilityGrid = participantPage.getByRole("grid", {
      name: "Availability",
    });
    const cell = (index) => availabilityGrid.locator(`[data-cell-idx="${index}"]`);
    const beforeUnloadIsBlocked = () =>
      participantPage.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });

    await participantPage.getByRole("button", { name: "Apply Available to all" }).click();
    await expect(participantPage.getByText("Saving draft…")).toBeVisible();
    await expect(savedStatus).toBeVisible();
    let draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access
    );
    let currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id
    );
    expect(currentParticipant.availabilityInperson.every((value) => value === 1)).toBe(true);
    expect(currentParticipant.submitted).toBe(0);
    invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access
    );
    registeredInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === participantEmail
    );
    expect(registeredInvitation.status).toBe("draft_saved");
    expect(registeredInvitation.draftSavedAt).toBeTruthy();

    await participantPage.getByRole("button", { name: "Mark all Busy" }).click();
    await expect(participantPage.getByText("Saving draft…")).toBeVisible();
    await expect(savedStatus).toBeVisible();
    draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access
    );
    currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id
    );
    expect(currentParticipant.availabilityInperson.every((value) => value === 0)).toBe(true);

    await cell(touchSlotIndex).tap();
    await expect(participantPage.getByText("Saving draft…")).toBeVisible();
    await expect(savedStatus).toBeVisible();
    expect(await beforeUnloadIsBlocked()).toBe(false);
    draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access
    );
    currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id
    );
    expect(currentParticipant.availabilityInperson[touchSlotIndex]).toBe(1);
    expect(currentParticipant.submitted).toBe(0);
    expect(currentParticipant.version).toBeGreaterThan(initialParticipant.version);

    await participantPage.reload();
    await expect(participantPage.getByText(/Welcome, Pat Participant/)).toBeVisible();
    await expect(cell(touchSlotIndex)).toHaveAttribute("aria-selected", "true");

    const updateRoutePattern = /\/events\/participants\/update\?.*/;
    let failNextAutosave = true;
    const failAutosaveOnce = async (route) => {
      if (failNextAutosave && route.request().method() === "PUT") {
        failNextAutosave = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary autosave outage" }),
        });
        return;
      }
      await route.continue();
    };
    await participantPage.route(updateRoutePattern, failAutosaveOnce);
    await cell(keyboardSlotIndex).focus();
    await participantPage.keyboard.press("Enter");
    await expect(participantPage.getByText("Saving draft…")).toBeVisible();
    await expect(participantPage.getByText("Temporary autosave outage")).toBeVisible();
    expect(await beforeUnloadIsBlocked()).toBe(true);
    await participantPage.getByRole("button", { name: "Retry save" }).click();
    await expect(savedStatus).toBeVisible();
    expect(await beforeUnloadIsBlocked()).toBe(false);
    await participantPage.unroute(updateRoutePattern, failAutosaveOnce);

    draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access
    );
    currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id
    );
    expect(currentParticipant.availabilityInperson[keyboardSlotIndex]).toBe(1);

    const concurrentSchedule = [...currentParticipant.availabilityInperson];
    concurrentSchedule[serverSlotIndex] = 1;
    const concurrentUpdate = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      {
        availabilityInperson: concurrentSchedule,
        submitted: 0,
        expectedVersion: currentParticipant.version,
      }
    );
    expect(concurrentUpdate.response.status()).toBe(200);

    await cell(conflictLocalSlotIndex).focus();
    await participantPage.keyboard.press("Enter");
    await expect(participantPage.getByText(/changed in another session/i)).toBeVisible();
    expect(await beforeUnloadIsBlocked()).toBe(true);
    await participantPage.getByRole("button", { name: "Reload latest response" }).click();
    await expect(savedStatus).toBeVisible();
    await expect(cell(serverSlotIndex)).toHaveAttribute("aria-selected", "true");
    await expect(cell(conflictLocalSlotIndex)).toHaveAttribute("aria-selected", "false");
    expect(await beforeUnloadIsBlocked()).toBe(false);

    const finalDate = nextWeekdayDate();
    const finalDayIndex = new Date(`${finalDate}T00:00:00Z`).getUTCDay();
    const finalDayGroup = eventDefinition.slotGroups.find(
      (group) => group.weekday === finalDayIndex
    );
    expect(finalDayGroup).toBeTruthy();
    const availableSlots = finalDayGroup.slots.filter(
      (slot) => slot.localStart >= "09:00" && slot.localStart < "11:00"
    );
    expect(availableSlots).toHaveLength(4);
    const schedule = Array(eventDefinition.slotCount).fill(0);
    for (const slot of availableSlots) schedule[slot.index] = 1;
    const savedFinalDraft = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      {
        availabilityInperson: schedule,
        availabilityVirtual: schedule,
        submitted: 0,
        expectedVersion: concurrentUpdate.payload.participant.version,
      }
    );
    expect(savedFinalDraft.response.status()).toBe(200);
    await participantPage.reload();
    await expect(participantPage.getByText(/Welcome, Pat Participant/)).toBeVisible();
    await expect(cell(availableSlots[0].index)).toHaveAttribute("aria-selected", "true");
    await participantPage.getByRole("button", { name: "Submit Availability" }).click();
    await expect(participantPage.getByText("Schedule submitted.")).toBeVisible();

    const submittedSchedule = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access
    );
    expect(submittedSchedule.response.status()).toBe(200);
    const submittedParticipant = submittedSchedule.payload.participants.find(
      (participant) => participant.id === participantSession.user.id
    );
    expect(submittedParticipant.submitted).toBe(1);
    expect(submittedParticipant.availabilityInperson).toEqual(schedule);
    invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access
    );
    registeredInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === participantEmail
    );
    expect(registeredInvitation.status).toBe("submitted");
    expect(registeredInvitation.submittedAt).toBeTruthy();

    const officialResults = await apiJson(
      request,
      "GET",
      `/events/results?code=${eventCode}`,
      organizerSession.access
    );
    expect(officialResults.response.status()).toBe(200);
    expect(officialResults.payload.results.countedResponseTotal).toBe(1);
    expect(officialResults.payload.results.unansweredParticipantTotal).toBe(1);
    expect(
      officialResults.payload.results.channels.inperson.weighted[availableSlots[0].index]
    ).toBe(1);
    expect(officialResults.payload.results.recommendations[0]).toEqual(
      expect.objectContaining({
        rank: 1,
        channel: "inperson",
        slotIndex: availableSlots[0].index,
        requiredParticipantConflictTotal: 0,
        weightedAvailability: 1,
      })
    );

    const participantOwnOnlyResults = await apiJson(
      request,
      "GET",
      `/events/results?code=${eventCode}`,
      participantSession.access
    );
    expect(participantOwnOnlyResults.response.status()).toBe(403);
    const participantOwnOnlySchedules = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access
    );
    expect(participantOwnOnlySchedules.response.status()).toBe(200);
    expect(participantOwnOnlySchedules.payload.participants).toHaveLength(1);
    expect(participantOwnOnlySchedules.payload.participants[0].id).toBe(participantSession.user.id);

    const reminderStartedAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Send Reminders" }).click();
    await expect(page.getByText("Sent 1 reminder(s).")).toBeVisible();
    const reminder = await latestEmailFor(
      manualEmail,
      reminderStartedAt,
      (body) => body.includes("Reminder:") && body.includes("BEGIN:VCALENDAR")
    );
    expect(reminder).toContain(`event?code=${eventCode}`);
    invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access
    );
    const manualInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === manualEmail
    );
    expect(manualInvitation.reminderSentAt).toBeTruthy();
    expect(manualInvitation.awaitingReminder).toBe(false);

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
    await page.goto(`/event?code=${eventCode}`);
    await expect(page.getByText("Organizer Dashboard")).toBeVisible();
    const registeredInvitationRow = page.getByText(participantEmail).locator("..");
    await expect(registeredInvitationRow.getByText("Submitted", { exact: true })).toBeVisible();

    const deniedWeights = await apiJson(
      request,
      "PUT",
      `/events/weights?code=${eventCode}`,
      participantSession.access,
      { weights: [{ participantId: participantSession.user.id, weight: 0.25, included: 1 }] }
    );
    expect(deniedWeights.response.status()).toBe(403);

    const deniedGroup = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      { groupName: "Denied" }
    );
    expect(deniedGroup.response.status()).toBe(403);

    const savedWeight = await apiJson(
      request,
      "PUT",
      `/events/weights?code=${eventCode}`,
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
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      organizerSession.access,
      { groupName: "E2E Group", sortOrder: 2 }
    );
    expect(groupUpdate.response.status()).toBe(200);
    expect(groupUpdate.payload.participant.group_name).toBe("E2E Group");

    const hideResult = await apiJson(
      request,
      "DELETE",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      organizerSession.access
    );
    expect(hideResult.response.status()).toBe(200);
    const unhideResult = await apiJson(
      request,
      "PUT",
      `/events/participants/update/unhide?code=${eventCode}&participantId=${participantSession.user.id}`,
      organizerSession.access
    );
    expect(unhideResult.response.status()).toBe(200);

    const eventState = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access
    );
    const closedEvent = await apiJson(
      request,
      "PUT",
      `/events/lifecycle?code=${eventCode}`,
      organizerSession.access,
      {
        status: "closed",
        expectedVersion: eventState.payload.event.version,
      }
    );
    expect(closedEvent.response.status()).toBe(200);
    expect(closedEvent.payload.event.status).toBe("closed");
    const duplicateClose = await apiJson(
      request,
      "PUT",
      `/events/lifecycle?code=${eventCode}`,
      organizerSession.access,
      {
        status: "closed",
        expectedVersion: eventState.payload.event.version,
      }
    );
    expect(duplicateClose.response.status()).toBe(200);
    expect(duplicateClose.payload.event.version).toBe(closedEvent.payload.event.version);
    const lockedResponse = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      {
        availabilityInperson: schedule,
        expectedVersion: unhideResult.payload.participant.version,
      }
    );
    expect(lockedResponse.response.status()).toBe(409);
    const reopenedEvent = await apiJson(
      request,
      "PUT",
      `/events/lifecycle?code=${eventCode}`,
      organizerSession.access,
      {
        status: "open",
        expectedVersion: closedEvent.payload.event.version,
        responseDeadline: datetimeLocalHoursFromNow(72),
      }
    );
    expect(reopenedEvent.response.status()).toBe(200);
    expect(reopenedEvent.payload.event.status).toBe("open");

    await page.goto(`/event?code=${eventCode}`);
    await expect(page.getByText("Organizer Dashboard")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recommended Meeting Times" })).toBeVisible();
    await page.getByRole("button", { name: "Use recommendation 1", exact: true }).click();
    await expect(page.getByLabel("Final start")).toHaveValue(`${finalDate}T09:00`);
    await expect(page.getByLabel("Final end")).toHaveValue(`${finalDate}T09:30`);
    await page.getByRole("button", { name: "Review Attendance" }).click();
    await expect(
      page.getByText("Attendance review is current. Confirm when you are ready to lock responses.")
    ).toBeVisible();
    await expect(page.getByText(/Pat Participant: available/)).toBeVisible();

    const firstFinalStartedAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Confirm Final Time" }).click();
    await expect(page.getByText(/Final time is locked/)).toBeVisible();
    const firstFinalEvent = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access
    );
    expect(firstFinalEvent.payload.event.status).toBe("finalized");
    expect(firstFinalEvent.payload.event.finalMeeting.calendarSequence).toBe(0);
    const calendarUid = firstFinalEvent.payload.event.finalMeeting.calendarUid;
    const participantFinal = await latestEmailFor(
      participantEmail,
      firstFinalStartedAt,
      (body) => body.includes("The final meeting time") && body.includes("METHOD:REQUEST")
    );
    expect(participantFinal).toContain(`UID:${calendarUid}`);
    const manualFinal = await latestEmailFor(
      manualEmail,
      firstFinalStartedAt,
      (body) => body.includes("The final meeting time") && body.includes("METHOD:REQUEST")
    );
    expect(manualFinal).toContain("X-WR-TIMEZONE:UTC");

    const cancellationStartedAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Reopen Event" }).click();
    await expect(page.getByText("Open", { exact: true })).toBeVisible();
    const cancellation = await latestEmailFor(
      participantEmail,
      cancellationStartedAt,
      (body) => body.includes("Scheduling for") && body.includes("METHOD:CANCEL")
    );
    expect(cancellation).toContain(`UID:${calendarUid}`);
    expect(cancellation).toContain("SEQUENCE:1");

    await page.getByLabel("Final start").fill(`${finalDate}T10:00`);
    await page.getByLabel("Final end").fill(`${finalDate}T11:00`);
    await page.getByRole("button", { name: "Review Attendance" }).click();
    await expect(
      page.getByText("Attendance review is current. Confirm when you are ready to lock responses.")
    ).toBeVisible();
    const secondFinalStartedAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Confirm Final Time" }).click();
    await expect(page.getByText(/Final time is locked/)).toBeVisible();
    const reconfirmedEvent = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access
    );
    expect(reconfirmedEvent.payload.event.finalMeeting.calendarUid).toBe(calendarUid);
    expect(reconfirmedEvent.payload.event.finalMeeting.calendarSequence).toBe(2);
    const reconfirmation = await latestEmailFor(
      participantEmail,
      secondFinalStartedAt,
      (body) => body.includes("The final meeting time") && body.includes("SEQUENCE:2")
    );
    expect(reconfirmation).toContain(`UID:${calendarUid}`);

    const duplicateFinal = await apiJson(
      request,
      "PUT",
      `/events/finalization?code=${eventCode}`,
      organizerSession.access,
      {
        startsAt: `${finalDate}T10:00:00.000Z`,
        endsAt: `${finalDate}T11:00:00.000Z`,
        channel: "inperson",
        location: "E2E Room",
        expectedVersion: reopenedEvent.payload.event.version,
        idempotencyKey: crypto.randomUUID(),
      }
    );
    expect(duplicateFinal.response.status()).toBe(200);
    expect(duplicateFinal.payload.idempotent).toBe(true);
    expect(duplicateFinal.payload.event.version).toBe(reconfirmedEvent.payload.event.version);

    const finalizedLock = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      {
        availabilityInperson: schedule,
        expectedVersion: unhideResult.payload.participant.version,
      }
    );
    expect(finalizedLock.response.status()).toBe(409);
    const participantCalendar = await request.get(
      `${BACKEND_URL}/events/finalization/calendar?code=${eventCode}`,
      {
        headers: { Authorization: `Bearer ${participantSession.access}` },
      }
    );
    expect(participantCalendar.status()).toBe(200);
    expect(await participantCalendar.text()).toContain(`UID:${calendarUid}`);

    assertDatabaseState({
      code: eventCode,
      organizer_id: organizerSession.user.id,
      participant_id: participantSession.user.id,
      organizer_email: organizerEmail,
      participant_email: participantEmail,
      manual_email: manualEmail,
      final_date: finalDate,
      calendar_uid: calendarUid,
    });
    await participantContext.close();
  });

  test("edits, resets, duplicates, archives, and deletes organizer events", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const email = `manager-${runId}@example.com`;
    const originalName = `Lifecycle ${runId}`;
    const updatedName = `${originalName} Updated`;

    await registerAccount(page, email, "Morgan", "Manager");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await fillTextbox(page, "Event Name", originalName);
    await expandAdvancedOptions(page);
    await fillTextbox(page, "Location / Address", "Lifecycle Room");
    await page.getByLabel("Event timezone").fill("UTC");
    await page.locator('input[type="datetime-local"]').fill(datetimeLocalHoursFromNow(48));
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const originalCode = new URL(page.url()).searchParams.get("code");
    const organizerSession = await readSession(page);

    const eventDefinition = await apiJson(
      request,
      "GET",
      `/events?code=${originalCode}`,
      organizerSession.access
    );
    expect(eventDefinition.response.status()).toBe(200);
    const joined = await apiJson(
      request,
      "POST",
      `/events/participants?code=${originalCode}`,
      organizerSession.access,
      {}
    );
    expect(joined.response.status()).toBe(201);
    const schedule = Array(eventDefinition.payload.event.slotCount).fill(1);
    const submitted = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${originalCode}&participantId=${organizerSession.user.id}`,
      organizerSession.access,
      {
        availabilityInperson: schedule,
        availabilityVirtual: schedule,
        submitted: 1,
        expectedVersion: joined.payload.participant.version,
      }
    );
    expect(submitted.response.status()).toBe(200);

    await page.goto("/dashboard");
    const originalCard = page
      .getByRole("link", { name: originalName, exact: true })
      .locator("xpath=ancestor::article");
    await originalCard.getByRole("link", { name: "Edit" }).click();
    await expect(page).toHaveURL(new RegExp(`/edit\\?code=${originalCode}$`));
    await expect(page.getByRole("heading", { name: "Edit event" })).toBeVisible();
    await fillTextbox(page, "Event Name", updatedName);
    await page.getByLabel("End Time").fill("17:30");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Schedule changes require a response reset")).toBeVisible();
    const saveButton = page.getByRole("button", { name: "Save changes" });
    await expect(saveButton).toBeDisabled();
    await page.getByLabel("I understand that participant availability will be reset.").check();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page).toHaveURL(new RegExp(`/event\\?code=${originalCode}$`));

    const resetParticipants = await apiJson(
      request,
      "GET",
      `/events/participants?code=${originalCode}&includeHidden=true`,
      organizerSession.access
    );
    expect(resetParticipants.response.status()).toBe(200);
    expect(resetParticipants.payload.participants[0].submitted).toBe(0);
    expect(resetParticipants.payload.participants[0].version).toBe(3);
    expect(resetParticipants.payload.participants[0].availabilityInperson).toHaveLength(
      eventDefinition.payload.event.slotCount + 5
    );
    expect(
      resetParticipants.payload.participants[0].availabilityInperson.every((value) => !value)
    ).toBe(true);

    await page.goto("/dashboard");
    const updatedCard = page
      .getByRole("link", { name: updatedName, exact: true })
      .locator("xpath=ancestor::article");
    await updatedCard.getByRole("button", { name: "Duplicate" }).click();
    await expect(page.getByText(`${updatedName} was duplicated as a draft.`)).toBeVisible();
    const copyName = `${updatedName} (copy)`;
    const copyCard = page
      .getByRole("link", { name: copyName, exact: true })
      .locator("xpath=ancestor::article");
    await expect(copyCard.getByText("Status: draft")).toBeVisible();
    const copyCodeText = await copyCard.getByText(/^Code: /).textContent();
    const copyCode = copyCodeText.replace("Code: ", "").trim();
    const copyParticipants = await apiJson(
      request,
      "GET",
      `/events/participants?code=${copyCode}&includeHidden=true`,
      organizerSession.access
    );
    expect(copyParticipants.response.status()).toBe(200);
    expect(copyParticipants.payload.participants).toEqual([]);

    await updatedCard.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText(`${updatedName} was archived.`)).toBeVisible();
    await expect(updatedCard.getByText("Status: archived")).toBeVisible();
    await expect(updatedCard.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );

    await copyCard.getByRole("button", { name: "Delete" }).click();
    const deleteButton = page.getByRole("button", { name: "Delete event permanently" });
    await expect(deleteButton).toBeDisabled();
    await page.getByLabel("Event code confirmation").fill(copyCode);
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();
    await expect(page.getByText(`${copyName} was permanently deleted.`)).toBeVisible();
    await expect(page.getByRole("link", { name: copyName, exact: true })).toHaveCount(0);

    const deletedCopy = await apiJson(
      request,
      "GET",
      `/events?code=${copyCode}`,
      organizerSession.access
    );
    expect(deletedCopy.response.status()).toBe(404);
    assertManagedEventState({
      original_code: originalCode,
      deleted_copy_code: copyCode,
      organizer_id: organizerSession.user.id,
      updated_name: updatedName,
    });
  });

  test("recovers, secures, signs out, and deletes an account", async ({
    browser,
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const email = `account-${runId}@example.com`;
    const resetPassword = "ResetPassword123!";
    const finalPassword = "FinalPassword123!";

    await registerAccount(page, email, "Alex", "Account");
    const memberSession = await readSession(page);
    const memberId = memberSession.user.id;

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await loginWithPassword(otherPage, email, "Password123!", false);
    const otherOriginalSession = await readSession(otherPage);

    const resetStartedAt = Date.now() - 1000;
    await page.goto("/recover");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(
      page.getByText(
        "If an account exists for that email, a reset code has been sent. Check your inbox."
      )
    ).toBeVisible();
    const resetCode = await latestVerificationCode(email, resetStartedAt);
    await page.getByLabel("Reset code").fill(resetCode);
    await page.getByLabel("New password", { exact: true }).fill(resetPassword);
    await page.getByLabel("Confirm new password").fill(resetPassword);
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page).toHaveURL(/\/login\?status=password-reset$/);
    await expect(
      page.getByText("Password reset complete. Log in with your new password.")
    ).toBeVisible();

    for (const access of [memberSession.access, otherOriginalSession.access]) {
      const revoked = await apiJson(request, "GET", "/authn/profile/", access);
      expect(revoked.response.status()).toBe(401);
    }

    await loginWithPassword(page, email, resetPassword, false);
    const resetSession = await readSession(page);
    await page.goto("/settings");
    const passwordForm = page.getByRole("heading", { name: "Change password" }).locator("..");
    await passwordForm.getByLabel("Current password").fill(resetPassword);
    await passwordForm.getByLabel("New password", { exact: true }).fill(finalPassword);
    await passwordForm.getByLabel("Confirm new password").fill(finalPassword);
    await passwordForm.getByRole("button", { name: "Change password" }).click();
    await expect(page).toHaveURL(/\/login\?status=password-changed$/);
    await expect(page.getByText("Password changed. Log in again on this device.")).toBeVisible();
    const changedSessionRejected = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      resetSession.access
    );
    expect(changedSessionRejected.response.status()).toBe(401);

    const oldPasswordLogin = await request.post(`${BACKEND_URL}/authn/login/`, {
      data: { email, password: resetPassword },
    });
    expect(oldPasswordLogin.status()).toBe(400);

    await loginWithPassword(page, email, finalPassword, false);
    const primaryFinalSession = await readSession(page);
    await loginWithPassword(otherPage, email, finalPassword, false);
    const otherFinalSession = await readSession(otherPage);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Sign out all devices" }).click();
    await expect(page).toHaveURL(/\/login\?status=signed-out-all$/);
    await expect(page.getByText("All devices have been signed out.")).toBeVisible();

    for (const access of [primaryFinalSession.access, otherFinalSession.access]) {
      const revoked = await apiJson(request, "GET", "/authn/profile/", access);
      expect(revoked.response.status()).toBe(401);
    }

    await loginWithPassword(page, email, finalPassword, false);
    await page.goto("/settings");
    const deleteForm = page.getByRole("heading", { name: "Delete account" }).locator("..");
    await deleteForm.getByLabel("Current password").fill(finalPassword);
    await deleteForm.getByLabel("Type DELETE to confirm").fill("DELETE");
    await deleteForm.getByRole("button", { name: "Delete account permanently" }).click();
    await expect(page).toHaveURL(/\/login\?status=account-deleted$/);
    await expect(page.getByText("Your account has been deleted.")).toBeVisible();

    const deletedLogin = await request.post(`${BACKEND_URL}/authn/login/`, {
      data: { email, password: finalPassword },
    });
    expect(deletedLogin.status()).toBe(400);
    assertDeletedAccountState({ member_id: memberId, email });
    await otherContext.close();
  });
});

test.describe("Releviz admin", () => {
  test("renders the themed admin login and authenticated sidebar", async ({ page }) => {
    await page.goto(`${BACKEND_URL}/admin/login/?next=/admin/`);
    await expect(page.locator(".login-box")).toBeVisible();
    await expect(page.locator("img.login-logo")).toHaveAttribute("src", /releviz-mark\.png/);
    await expect(page.getByText("Releviz Admin")).toBeVisible();
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
