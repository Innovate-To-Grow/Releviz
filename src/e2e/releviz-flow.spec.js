const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");

const ROOT = path.resolve(__dirname, "../..");
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:4100";
const EMAIL_FILE_PATH = process.env.EMAIL_FILE_PATH || "/tmp/releviz-e2e-mail";
const ADMIN_EMAIL = process.env.DJANGO_SUPERUSER_EMAIL || "admin@releviz.local";
const ADMIN_PASSWORD = process.env.DJANGO_SUPERUSER_PASSWORD;
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

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
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
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

// Schedule forms use native <select> elements (exposed as comboboxes), so the
// value is chosen via selectOption rather than typed.
async function selectOption(page, name, optionName) {
  const field = page.getByRole("combobox", { name });
  await field.selectOption({ label: optionName });
  await expect(field.locator("option:checked")).toHaveText(optionName);
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

async function importRoster(request, eventCode, token, pastedText) {
  const preview = await apiJson(
    request,
    "POST",
    `/events/roster-imports?code=${eventCode}`,
    token,
    { sourceType: "paste", pastedText },
  );
  expect(preview.response.status()).toBe(201);
  const committed = await apiJson(
    request,
    "POST",
    `/events/roster-imports/${preview.payload.import.id}/commit?code=${eventCode}`,
    token,
    { mode: "merge", idempotencyKey: crypto.randomUUID() },
  );
  expect(committed.response.status()).toBe(201);
  return committed.payload;
}

function assertDatabaseState(payload) {
  const script = `
import json
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")
django.setup()

from django.utils import timezone
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

from apps.authn.models import Member
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import Event, EventInvitation, FinalMeeting, Participant, UserEvent, Weight
from apps.scheduling.services.availability import expected_availability_length

data = json.loads(${JSON.stringify(JSON.stringify(payload))})
event = Event.objects.get(code=data["code"])
organizer = Member.objects.get(pk=data["organizer_id"])
participant_member = Member.objects.get(pk=data["participant_id"])
participant = Participant.objects.get(event=event, member=participant_member)
weight = Weight.objects.get(event=event, participant=participant)

# Member.email is vestigial; the address lives on the primary ContactEmail.
assert organizer.get_primary_email() == data["organizer_email"]
assert participant_member.get_primary_email() == data["participant_email"]
assert event.organizer_id == organizer.pk
assert participant.submitted is True
assert isinstance(participant.availability_inperson, list)
assert isinstance(participant.availability_virtual, list)
assert len(participant.availability_inperson) == expected_availability_length(event)
assert len(participant.availability_virtual) == expected_availability_length(event)
assert participant.group_name == "E2E Group"
assert participant.sort_order == 1
assert participant.hidden is False
assert weight.weight == 0.5
assert weight.included is True
assert event.response_deadline is not None
assert event.reminders_enabled is True
assert event.status == "finalized"
assert event.start_minutes == 9 * 60
assert event.end_minutes == 17 * 60
assert event.slot_minutes == 30
assert event.meeting_duration_minutes == 60
assert event.spans_next_day is False
assert UserEvent.objects.filter(event=event, member=organizer, role="organizer").exists()
assert UserEvent.objects.filter(event=event, member=participant_member, role="participant").exists()
# Refresh sessions live in SimpleJWT's outstanding-token table; a live session
# is one that has not expired and has not been blacklisted.
def live_sessions(member):
    return OutstandingToken.objects.filter(
        user=member,
        expires_at__gt=timezone.now(),
        blacklistedtoken__isnull=True,
    )

assert live_sessions(organizer).exists()
assert live_sessions(participant_member).exists()

registered_invitation = EventInvitation.objects.get(event=event, email=data["participant_email"])
manual_invitation = EventInvitation.objects.get(event=event, email=data["manual_email"])
assert registered_invitation.member_id == participant_member.pk
assert registered_invitation.status == "submitted"
assert registered_invitation.opened_at is not None
assert registered_invitation.joined_at is not None
assert registered_invitation.draft_saved_at is not None
assert registered_invitation.submitted_at is not None
assert manual_invitation.member_id is not None
assert manual_invitation.status == "invited"
assert manual_invitation.reminder_sent_at is not None
# Authentication mail is delivered straight by the authn sender and is not
# recorded as a delivery job, so only event mail appears in these tables.
assert not EmailDeliveryJob.objects.filter(
    message_type__in=["verification", "welcome", "login_alert"],
).exists()
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
# The organizer finalizes whichever window ranks first, so compare against the
# start time the API reported rather than a fixed hour.
assert meeting.starts_at.isoformat() == data["final_starts_at"]
assert EmailDeliveryJob.objects.filter(event=event, message_type="final_confirmation", status="sent").count() == 4
assert EmailDeliveryJob.objects.filter(event=event, message_type="final_cancellation", status="sent").count() == 2
assert EmailMessageLog.objects.filter(event=event, message_type="final_confirmation", status="sent").count() == 4
assert EmailMessageLog.objects.filter(event=event, message_type="final_cancellation", status="sent").count() == 2
`;
  execFileSync(PYTHON_BIN, ["-c", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "src/api"),
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

from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

from apps.authn.models import ContactEmail, EmailAuthChallenge, Member
from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import EventInvitation

data = json.loads(${JSON.stringify(JSON.stringify(payload))})

# Deleting an account removes the member outright and cascades to everything
# that referenced it, so nothing addressable by the old identity survives.
assert not Member.objects.filter(pk=data["member_id"]).exists()
assert not ContactEmail.objects.filter(member_id=data["member_id"]).exists()
assert not ContactEmail.objects.filter(email_address__iexact=data["email"]).exists()
assert not EmailAuthChallenge.objects.filter(member_id=data["member_id"]).exists()
assert not EmailDeliveryJob.objects.filter(member_id=data["member_id"]).exists()
assert not EmailMessageLog.objects.filter(recipient=data["email"]).exists()
assert not EventInvitation.objects.filter(email=data["email"]).exists()
assert not EventInvitation.objects.filter(member_id=data["member_id"]).exists()
assert not OutstandingToken.objects.filter(user_id=data["member_id"]).exists()
`;
  execFileSync(PYTHON_BIN, ["-c", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "src/api"),
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
from apps.scheduling.services.availability import expected_availability_length

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
  execFileSync(PYTHON_BIN, ["-c", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "src/api"),
      DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    },
    stdio: "pipe",
  });
}

function temporaryAccountState(payload) {
  const script = `
import json
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")
django.setup()

from apps.authn.models import ContactEmail
from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import Event, EventInvitation, Participant, TemporaryEventSession, UserEvent, Weight

data = json.loads(${JSON.stringify(JSON.stringify(payload))})
event = Event.objects.get(code=data["code"])
contact = ContactEmail.objects.select_related("member").get(email_address=data["email"])
member = contact.member
participant = Participant.objects.get(event=event, member=member)
invitation = EventInvitation.objects.get(event=event, email=data["email"])
weight = Weight.objects.filter(event=event, participant=participant).first()
sessions = TemporaryEventSession.objects.filter(member=member, participant=participant)

print(json.dumps({
    "memberId": str(member.pk),
    "participantPk": str(participant.pk),
    "participantCount": Participant.objects.filter(event=event, member=member).count(),
    "participantName": participant.participant_name,
    "participantVersion": participant.version,
    "submitted": participant.submitted,
    "availabilityInperson": participant.availability_inperson,
    "accessLevel": member.access_level,
    "contactVerified": contact.verified,
    "hasUsablePassword": member.has_usable_password(),
    "invitationMemberId": str(invitation.member_id),
    "invitationFirstSent": invitation.first_sent_at is not None,
    "invitationJobCount": EmailDeliveryJob.objects.filter(
        event=event,
        invitation=invitation,
        message_type="invitation",
    ).count(),
    "weightPk": str(weight.pk) if weight else None,
    "weightMemberId": str(weight.participant.member_id) if weight else None,
    "weightValue": float(weight.weight) if weight else None,
    "weightIncluded": weight.included if weight else None,
    "userEventVisible": UserEvent.objects.filter(
        event=event,
        member=member,
        role="participant",
    ).exists(),
    "tempSessionCount": sessions.count(),
    "activeTempSessionCount": sessions.filter(revoked_at__isnull=True).count(),
    "revokedTempSessionCount": sessions.filter(revoked_at__isnull=False).count(),
}))
`;
  const output = execFileSync(PYTHON_BIN, ["-c", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "src/api"),
      DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output.trim());
}

function temporaryAccessPathFromEmail(body) {
  const rawLink = body.match(/Link:\s*(https?:\/\/[^\s<]+)/i)?.[1];
  if (!rawLink)
    throw new Error("No temporary access link found in invitation email");
  const link = new URL(rawLink.replaceAll("&amp;", "&"));
  return `${link.pathname}${link.search}`;
}

test.describe("Releviz account and scheduling flow", () => {
  test("imports and auto-invites a roster, shares one temporary response, and upgrades it in place", async ({
    browser,
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const organizerEmail = `temp-organizer-${runId}@example.com`;
    const temporaryEmail = `temporary-${runId}@example.com`;
    const eventName = `Shared temporary schedule ${runId}`;

    await registerAccount(page, organizerEmail, "Morgan", "Manager");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await fillTextbox(page, "Event Name", eventName);
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    expect(eventCode).toMatch(/^[A-Z0-9]+$/);
    await expect(
      page.getByRole("heading", { level: 2, name: eventName }),
    ).toBeVisible();
    const organizerSession = await readSession(page);
    const activeEvent = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access,
    );
    expect(activeEvent.response.status()).toBe(200);
    expect(activeEvent.payload.event.status).toBe("active");

    await page.getByRole("button", { name: "Import roster" }).click();
    await page.getByRole("tab", { name: "Paste spreadsheet" }).click();
    await page
      .getByLabel("Pasted roster rows")
      .fill(
        "name\temail\tgroup\tweight\tincluded\n" +
          `Temporary Taylor\t${temporaryEmail}\tE2E Group\t0.5\ttrue`,
      );
    await page.getByRole("button", { name: "Continue to mapping" }).click();
    await expect(
      page.getByText("Choose a worksheet and map its columns."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Preview rows" }).click();
    await expect(page.getByLabel("Email for row 2")).toHaveValue(
      temporaryEmail,
    );
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    const invitationStartedAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Merge roster" }).click();
    await expect(
      page.getByText(
        "Imported 1 people: 1 added, 0 updated. 1 invitation queued.",
      ),
    ).toBeVisible();
    const eventDeliveryProgress = page.getByLabel("Event delivery progress");
    await expect(eventDeliveryProgress).toBeVisible();

    const createdRoster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(createdRoster.response.status()).toBe(200);
    const managedParticipant = createdRoster.payload.participants.find(
      (participant) => participant.email === temporaryEmail,
    );
    expect(managedParticipant).toEqual(
      expect.objectContaining({
        accountAccess: "temporary",
        canOrganizerEditAvailability: true,
      }),
    );
    const participantCard = page.locator(
      `[data-roster-participant-id="${managedParticipant.id}"]`,
    );
    await expect(participantCard.getByText(/Temporary$/)).toBeVisible();

    const createdState = temporaryAccountState({
      code: eventCode,
      email: temporaryEmail,
    });
    expect(createdState).toEqual(
      expect.objectContaining({
        memberId: managedParticipant.memberId,
        participantCount: 1,
        accessLevel: "temporary",
        contactVerified: false,
        hasUsablePassword: false,
        invitationJobCount: 1,
        userEventVisible: true,
        tempSessionCount: 0,
      }),
    );

    dispatchEmailJobs();
    const invitationEmail = await latestEmailFor(
      temporaryEmail,
      invitationStartedAt,
      (body) => body.includes(`/temp-access?code=${eventCode}`),
    );
    await eventDeliveryProgress
      .getByRole("button", { name: "Refresh progress" })
      .click();
    await expect(eventDeliveryProgress.getByText("1 sent")).toBeVisible();
    const sentRoster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(sentRoster.response.status()).toBe(200);
    expect(
      sentRoster.payload.participants.find(
        (participant) => participant.id === managedParticipant.id,
      )?.invitationStatus,
    ).toBe("invited");
    const accessPath = temporaryAccessPathFromEmail(invitationEmail);
    const sentState = temporaryAccountState({
      code: eventCode,
      email: temporaryEmail,
    });
    expect(sentState.invitationFirstSent).toBe(true);
    expect(sentState.invitationJobCount).toBe(1);

    await participantCard
      .getByRole("button", { name: "Edit schedule" })
      .click();
    const organizerDrawer = page.getByRole("dialog", {
      name: "Edit Temporary Taylor's schedule",
    });
    await expect(organizerDrawer).toBeVisible();

    const temporaryContext = await browser.newContext();
    const temporaryPage = await temporaryContext.newPage();
    const accessCodeStartedAt = Date.now() - 1000;
    await temporaryPage.goto(accessPath);
    await expect(
      temporaryPage.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    const accessCode = await latestVerificationCode(
      temporaryEmail,
      accessCodeStartedAt,
    );
    await temporaryPage.getByLabel("Verification code").fill(accessCode);
    await temporaryPage
      .getByRole("button", { name: "Verify and open schedule" })
      .click();
    await expect(
      temporaryPage.getByRole("heading", { name: eventName }),
    ).toBeVisible();
    await expect(
      temporaryPage.getByText("You are responding as Temporary Taylor"),
    ).toBeVisible();

    await temporaryPage.getByRole("button", { name: "Apply to all" }).click();
    await expect(temporaryPage.getByText("Saving draft…")).toBeVisible();
    await expect(
      temporaryPage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();
    await temporaryPage
      .getByRole("button", { name: "Submit availability" })
      .click();
    await expect(temporaryPage.getByText("Schedule submitted.")).toBeVisible();

    await organizerDrawer.getByRole("button", { name: "Save draft" }).click();
    await expect(
      organizerDrawer.getByText(/This response changed after you opened it/),
    ).toBeVisible();
    await organizerDrawer
      .getByRole("button", { name: "Reload latest response" })
      .click();
    await expect(
      organizerDrawer.getByText("Latest response loaded."),
    ).toBeVisible();
    await organizerDrawer
      .getByRole("button", { name: "Busy", exact: true })
      .click();
    await organizerDrawer.locator('[data-cell-idx="0"]').first().click();
    await organizerDrawer
      .getByRole("button", { name: "Submit on behalf" })
      .click();
    await expect(
      organizerDrawer.getByText("Schedule submitted."),
    ).toBeVisible();

    recomputeEventResults(eventCode);
    const resultsBeforeUpgrade = await apiJson(
      request,
      "GET",
      `/events/results?code=${eventCode}`,
      organizerSession.access,
    );
    expect(resultsBeforeUpgrade.response.status()).toBe(200);
    expect(resultsBeforeUpgrade.payload.results.countedResponseTotal).toBe(1);
    const beforeUpgrade = temporaryAccountState({
      code: eventCode,
      email: temporaryEmail,
    });
    expect(beforeUpgrade).toEqual(
      expect.objectContaining({
        memberId: managedParticipant.memberId,
        participantCount: 1,
        submitted: true,
        accessLevel: "temporary",
        contactVerified: false,
        userEventVisible: true,
        tempSessionCount: 1,
        activeTempSessionCount: 1,
        revokedTempSessionCount: 0,
        weightMemberId: managedParticipant.memberId,
        weightValue: 0.5,
        weightIncluded: true,
      }),
    );

    const upgradeStartedAt = Date.now() - 1000;
    const upgradeLink = temporaryPage.getByRole("link", {
      name: "Upgrade to full access",
    });
    await expect(upgradeLink).toHaveAttribute(
      "href",
      `/signup?upgrade=temporary&code=${eventCode}&next=%2Fevent%3Fcode%3D${eventCode}`,
    );
    await upgradeLink.click();
    await expect(temporaryPage).toHaveURL(/\/signup\?.*upgrade=temporary/);
    expect(new URL(temporaryPage.url()).searchParams.has("email")).toBe(false);
    expect(new URL(temporaryPage.url()).searchParams.has("lockedEmail")).toBe(
      false,
    );
    const lockedEmail = temporaryPage.getByLabel("Email");
    await expect(lockedEmail).toHaveValue(temporaryEmail);
    await expect(lockedEmail).toHaveJSProperty("readOnly", true);
    await temporaryPage.getByLabel("First name").fill("Taylor");
    await temporaryPage.getByLabel("Last name").fill("Upgraded");
    await temporaryPage
      .getByLabel("Password", { exact: true })
      .fill("Password123!");
    await temporaryPage.getByLabel("Confirm password").fill("Password123!");
    await temporaryPage
      .getByRole("button", { name: "Send verification code" })
      .click();
    await expect(
      temporaryPage.getByText("Enter the email verification code."),
    ).toBeVisible();
    const upgradeCode = await latestVerificationCode(
      temporaryEmail,
      upgradeStartedAt,
    );
    await temporaryPage.getByLabel("Verification code").fill(upgradeCode);
    await temporaryPage
      .getByRole("button", { name: "Verify and continue" })
      .click();
    await expect(temporaryPage).toHaveURL(
      new RegExp(`/event\\?code=${eventCode}$`),
    );
    const fullSession = await readSession(temporaryPage);
    // The upgrade keeps the same member; `afterUpgrade` below asserts the
    // promoted access level straight from the database.
    expect(fullSession.user.id).toBe(beforeUpgrade.memberId);

    const oldTemporarySession = await temporaryPage.evaluate(
      async ({ backendUrl, code }) => {
        const response = await fetch(
          `${backendUrl}/events/temp-access/session?code=${code}`,
          {
            credentials: "include",
          },
        );
        return { status: response.status, payload: await response.json() };
      },
      { backendUrl: BACKEND_URL, code: eventCode },
    );
    expect(oldTemporarySession).toEqual(
      expect.objectContaining({
        status: 403,
        payload: expect.objectContaining({
          errorCode: "temp_account_upgraded",
        }),
      }),
    );
    const clearedTemporarySessionStatus = await temporaryPage.evaluate(
      async ({ backendUrl, code }) => {
        const response = await fetch(
          `${backendUrl}/events/temp-access/session?code=${code}`,
          {
            credentials: "include",
          },
        );
        return response.status;
      },
      { backendUrl: BACKEND_URL, code: eventCode },
    );
    expect(clearedTemporarySessionStatus).toBe(401);

    const fullDashboard = await apiJson(
      request,
      "GET",
      "/dashboard/events",
      fullSession.access,
    );
    expect(fullDashboard.response.status()).toBe(200);
    expect(
      fullDashboard.payload.participating.map((event) => event.code),
    ).toContain(eventCode);
    const fullParticipantView = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      fullSession.access,
    );
    expect(fullParticipantView.response.status()).toBe(200);
    expect(fullParticipantView.payload.participants).toHaveLength(1);
    expect(fullParticipantView.payload.participants[0]).toEqual(
      expect.objectContaining({
        id: beforeUpgrade.memberId,
        submitted: 1,
        availabilityInperson: beforeUpgrade.availabilityInperson,
      }),
    );

    await organizerDrawer.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const fullAccessCard = page.locator(
      `[data-roster-participant-id="${managedParticipant.id}"]`,
    );
    await expect(fullAccessCard.getByText(/Full account$/)).toBeVisible();
    await expect(
      fullAccessCard.getByRole("button", { name: "Edit schedule" }),
    ).toHaveCount(0);

    const organizerRosterAfterUpgrade = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(organizerRosterAfterUpgrade.response.status()).toBe(200);
    expect(organizerRosterAfterUpgrade.payload.participants).toHaveLength(1);
    expect(organizerRosterAfterUpgrade.payload.participants[0]).toEqual(
      expect.objectContaining({
        id: managedParticipant.id,
        memberId: beforeUpgrade.memberId,
        accountAccess: "full",
        canOrganizerEditAvailability: false,
        submitted: true,
        weight: 0.5,
        included: true,
      }),
    );
    recomputeEventResults(eventCode);
    const resultsAfterUpgrade = await apiJson(
      request,
      "GET",
      `/events/results?code=${eventCode}`,
      organizerSession.access,
    );
    expect(resultsAfterUpgrade.response.status()).toBe(200);
    expect(resultsAfterUpgrade.payload.results.countedResponseTotal).toBe(1);

    const afterUpgrade = temporaryAccountState({
      code: eventCode,
      email: temporaryEmail,
    });
    expect(afterUpgrade).toEqual(
      expect.objectContaining({
        memberId: beforeUpgrade.memberId,
        participantPk: beforeUpgrade.participantPk,
        participantCount: 1,
        submitted: true,
        accessLevel: "full",
        contactVerified: true,
        hasUsablePassword: true,
        invitationMemberId: beforeUpgrade.memberId,
        weightPk: beforeUpgrade.weightPk,
        weightMemberId: beforeUpgrade.memberId,
        weightValue: 0.5,
        weightIncluded: true,
        userEventVisible: true,
        tempSessionCount: 1,
        activeTempSessionCount: 0,
        revokedTempSessionCount: 1,
      }),
    );
    expect(afterUpgrade.participantName).toBe("Taylor Upgraded");
    expect(afterUpgrade.availabilityInperson).toEqual(
      beforeUpgrade.availabilityInperson,
    );

    await temporaryContext.close();
  });

  test("runs the scaled roster-to-calendar workflow and persists it to Postgres", async ({
    browser,
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const organizerEmail = `organizer-${runId}@example.com`;
    const participantEmail = `participant-${runId}@example.com`;
    const manualEmail = `manual-${runId}@example.com`;
    const eventName = `E2E Planning ${runId}`;

    await registerAccount(page, organizerEmail, "Olivia", "Organizer");
    await expectAccessible(page, "organizer dashboard");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(
      page.getByRole("heading", { name: "Create event" }),
    ).toBeVisible();
    await expectAccessible(page, "create event");
    await fillTextbox(page, "Event Name", eventName);
    await fillTextbox(page, "Location / Address", "E2E Room");
    await selectOption(page, "Event timezone", "UTC");
    await page.getByLabel("Meeting Duration").fill("60");
    await expandAdvancedOptions(page);
    await page
      .getByLabel("Response Deadline")
      .fill(datetimeLocalHoursFromNow(48));
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    expect(eventCode).toMatch(/^[A-Z0-9]+$/);
    await expect(
      page.getByRole("heading", { level: 2, name: eventName }),
    ).toBeVisible();
    await expectAccessible(page, "organizer event");

    const organizerSession = await readSession(page);
    const eventDefinitionResponse = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access,
    );
    expect(eventDefinitionResponse.response.status()).toBe(200);
    const eventDefinition = eventDefinitionResponse.payload.event;
    expect(eventDefinition.slotMinutes).toBe(30);
    expect(eventDefinition.meetingDurationMinutes).toBe(60);
    expect(eventDefinition.status).toBe("active");
    expect(eventDefinition.slotCount).toBeGreaterThan(0);
    const participantContext = await browser.newContext({
      hasTouch: true,
      viewport: { width: 320, height: 720 },
    });
    const participantPage = await participantContext.newPage();
    await registerAccount(
      participantPage,
      participantEmail,
      "Pat",
      "Participant",
    );

    const codeLoginContext = await browser.newContext();
    const codeLoginPage = await codeLoginContext.newPage();
    await loginWithEmailCode(codeLoginPage, participantEmail);
    await codeLoginContext.close();

    const passwordLoginContext = await browser.newContext();
    const passwordLoginPage = await passwordLoginContext.newPage();
    await loginWithEmailCode(passwordLoginPage, organizerEmail);
    await passwordLoginContext.close();

    const inviteStartedAt = Date.now() - 1000;
    const imported = await importRoster(
      request,
      eventCode,
      organizerSession.access,
      "name,email,group,weight,included\n" +
        `Pat Participant,${participantEmail},E2E Group,1,true\n` +
        `Manual Participant,${manualEmail},E2E Group,1,true`,
    );
    expect(imported.receipt).toEqual(
      expect.objectContaining({
        importedCount: 2,
        createdCount: 2,
        updatedCount: 0,
      }),
    );
    expect(imported.autoInvitedCount).toBe(2);
    expect(imported.deliveryRequest).toEqual(
      expect.objectContaining({
        operation: "invitation",
        recipientCount: 2,
        enqueued: 2,
      }),
    );

    dispatchEmailJobs();
    const registeredInvite = await latestEmailFor(
      participantEmail,
      inviteStartedAt,
      (body) =>
        body.includes(`event?code=${eventCode}`) &&
        body.includes("BEGIN:VCALENDAR"),
    );
    expect(registeredInvite).toContain("Share your availability");
    const registeredInvitationLink = registeredInvite
      .match(/^Link: (.+)$/m)?.[1]
      ?.trim();
    expect(registeredInvitationLink).toMatch(
      new RegExp(`/event\\?code=${eventCode}&invitation=[0-9a-f-]+$`, "i"),
    );
    const manualInvite = await latestEmailFor(
      manualEmail,
      inviteStartedAt,
      (body) =>
        body.includes(`/temp-access?code=${eventCode}`) &&
        body.includes("BEGIN:VCALENDAR"),
    );
    expect(manualInvite).toContain("Share your availability");

    const invitationOpenedResponse = participantPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/events/invitations/open"),
    );
    await participantPage.goto(registeredInvitationLink);
    expect((await invitationOpenedResponse).ok()).toBe(true);
    await expect(
      participantPage.getByText(/Welcome, Pat Participant/),
    ).toBeVisible();
    await expect(
      participantPage.getByRole("heading", { name: "Join Event" }),
    ).toHaveCount(0);
    let invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access,
    );
    let registeredInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === participantEmail,
    );
    expect(registeredInvitation.status).toBe("opened");
    expect(registeredInvitation.openedAt).toBeTruthy();
    expect(registeredInvitation.awaitingReminder).toBe(true);
    await expectAccessible(participantPage, "participant schedule at 320px");
    const participantSession = await readSession(participantPage);
    const participantState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    expect(participantState.response.status()).toBe(200);
    const initialParticipant = participantState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
    );
    expect(initialParticipant).toBeTruthy();

    const savedStatus = participantPage.getByText(
      "Draft saved. Submit when you are ready.",
    );
    const allSlotIndexes = eventDefinition.slotGroups.flatMap((group) =>
      group.slots.map((slot) => slot.index),
    );
    expect(allSlotIndexes.length).toBeGreaterThan(3);
    const [
      touchSlotIndex,
      keyboardSlotIndex,
      serverSlotIndex,
      conflictLocalSlotIndex,
    ] = allSlotIndexes;
    const availabilityGrid = participantPage.getByRole("grid", {
      name: "Availability",
    });
    const cell = (index) =>
      availabilityGrid.locator(`[data-cell-idx="${index}"]`);
    const arrowTargetIndex = eventDefinition.slotGroups[1]?.slots[0]?.index;
    expect(arrowTargetIndex).toBeDefined();
    const beforeUnloadIsBlocked = () =>
      participantPage.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });

    await participantPage
      .getByRole("button", { name: "Apply Available to all" })
      .click();
    await expect(participantPage.getByText("Saving draft…")).toBeVisible();
    await expect(savedStatus).toBeVisible();
    let draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    let currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
    );
    expect(
      currentParticipant.availabilityInperson.every((value) => value === 1),
    ).toBe(true);
    expect(currentParticipant.submitted).toBe(0);
    invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access,
    );
    registeredInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === participantEmail,
    );
    expect(registeredInvitation.status).toBe("draft_saved");
    expect(registeredInvitation.draftSavedAt).toBeTruthy();

    await participantPage
      .getByRole("button", { name: "Mark all Busy" })
      .click();
    await expect(participantPage.getByText("Saving draft…")).toBeVisible();
    await expect(savedStatus).toBeVisible();
    draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
    );
    expect(
      currentParticipant.availabilityInperson.every((value) => value === 0),
    ).toBe(true);

    await cell(touchSlotIndex).tap();
    await expect(participantPage.getByText("Saving draft…")).toBeVisible();
    await expect(savedStatus).toBeVisible();
    expect(await beforeUnloadIsBlocked()).toBe(false);
    draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
    );
    expect(currentParticipant.availabilityInperson[touchSlotIndex]).toBe(1);
    expect(currentParticipant.submitted).toBe(0);
    expect(currentParticipant.version).toBeGreaterThan(
      initialParticipant.version,
    );

    await participantPage.reload();
    await expect(
      participantPage.getByText(/Welcome, Pat Participant/),
    ).toBeVisible();
    await expect(cell(touchSlotIndex)).toHaveAttribute("aria-selected", "true");

    const updateRoutePattern = /\/events\/participants\/update\?.*/;
    await expect(
      availabilityGrid.locator("[role='gridcell'][tabindex='0']"),
    ).toHaveCount(1);
    await cell(eventDefinition.slotGroups[0].slots[0].index).focus();
    await participantPage.keyboard.press("ArrowRight");
    await expect(cell(arrowTargetIndex)).toBeFocused();

    let releaseNavigationAutosave;
    let observeNavigationAutosave;
    const navigationAutosaveStarted = new Promise((resolve) => {
      observeNavigationAutosave = resolve;
    });
    const navigationAutosaveRelease = new Promise((resolve) => {
      releaseNavigationAutosave = resolve;
    });
    const holdNavigationAutosave = async (route) => {
      if (route.request().method() === "PUT") {
        observeNavigationAutosave();
        await navigationAutosaveRelease;
      }
      await route.continue();
    };
    await participantPage.route(updateRoutePattern, holdNavigationAutosave);
    await participantPage
      .getByRole("button", { name: "Mark all Busy" })
      .click();
    const leaveSchedule = participantPage
      .getByRole("link", { name: "Releviz home" })
      .click();
    await navigationAutosaveStarted;
    expect(new URL(participantPage.url()).pathname).toBe("/event");
    releaseNavigationAutosave();
    await leaveSchedule;
    await expect(participantPage).toHaveURL(/\/$/);
    await participantPage.unroute(updateRoutePattern, holdNavigationAutosave);
    draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
    );
    expect(
      currentParticipant.availabilityInperson.every((value) => value === 0),
    ).toBe(true);
    await participantPage.goto(`/event?code=${eventCode}`);
    await expect(
      participantPage.getByText(/Welcome, Pat Participant/),
    ).toBeVisible();

    let releaseBackAutosave;
    let observeBackAutosave;
    const backAutosaveStarted = new Promise((resolve) => {
      observeBackAutosave = resolve;
    });
    const backAutosaveRelease = new Promise((resolve) => {
      releaseBackAutosave = resolve;
    });
    const holdBackAutosave = async (route) => {
      if (route.request().method() === "PUT") {
        observeBackAutosave();
        await backAutosaveRelease;
      }
      await route.continue();
    };
    await participantPage.route(updateRoutePattern, holdBackAutosave);
    await participantPage
      .getByRole("button", { name: "Apply Available to all" })
      .click();
    const backNavigation = participantPage.goBack();
    await backAutosaveStarted;
    expect(new URL(participantPage.url()).pathname).toBe("/event");
    releaseBackAutosave();
    await backNavigation;
    await expect(participantPage).toHaveURL(/\/$/);
    await participantPage.unroute(updateRoutePattern, holdBackAutosave);
    draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
    );
    expect(
      currentParticipant.availabilityInperson.every((value) => value === 1),
    ).toBe(true);
    await participantPage.goto(`/event?code=${eventCode}`);
    await expect(
      participantPage.getByText(/Welcome, Pat Participant/),
    ).toBeVisible();

    // Reset the grid so the following keyboard action makes a real change.
    // The previous navigation check deliberately left every slot Available,
    // which is also the editor's default paint value.
    const resetToBusyResponse = participantPage.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        updateRoutePattern.test(response.url()) &&
        response.ok(),
    );
    await participantPage
      .getByRole("button", { name: "Mark all Busy" })
      .click();
    await resetToBusyResponse;
    await expect(cell(keyboardSlotIndex)).toHaveAttribute(
      "aria-selected",
      "false",
    );

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
    const failedAutosaveResponse = participantPage.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        updateRoutePattern.test(response.url()) &&
        response.status() === 503,
    );
    await cell(keyboardSlotIndex).focus();
    await participantPage.keyboard.press("Enter");
    await failedAutosaveResponse;
    await expect(
      participantPage.getByText("Temporary autosave outage"),
    ).toBeVisible();
    expect(await beforeUnloadIsBlocked()).toBe(true);
    const retriedAutosaveResponse = participantPage.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        updateRoutePattern.test(response.url()) &&
        response.ok(),
    );
    await participantPage.getByRole("button", { name: "Retry save" }).click();
    await retriedAutosaveResponse;
    await expect(savedStatus).toBeVisible();
    expect(await beforeUnloadIsBlocked()).toBe(false);
    await participantPage.unroute(updateRoutePattern, failAutosaveOnce);

    draftState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    currentParticipant = draftState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
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
      },
    );
    expect(concurrentUpdate.response.status()).toBe(200);

    await cell(conflictLocalSlotIndex).focus();
    await participantPage.keyboard.press("Enter");
    await expect(
      participantPage.getByText(/changed in another session/i),
    ).toBeVisible();
    expect(await beforeUnloadIsBlocked()).toBe(true);
    await participantPage
      .getByRole("button", { name: "Reload latest response" })
      .click();
    await expect(savedStatus).toBeVisible();
    await expect(cell(serverSlotIndex)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(cell(conflictLocalSlotIndex)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(await beforeUnloadIsBlocked()).toBe(false);

    const finalDate = nextWeekdayDate();
    const finalDayIndex = new Date(`${finalDate}T00:00:00Z`).getUTCDay();
    const finalDayGroup = eventDefinition.slotGroups.find(
      (group) => group.weekday === finalDayIndex,
    );
    expect(finalDayGroup).toBeTruthy();
    const availableSlots = finalDayGroup.slots.filter(
      (slot) => slot.localStart >= "09:00" && slot.localStart < "11:00",
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
      },
    );
    expect(savedFinalDraft.response.status()).toBe(200);
    await participantPage.reload();
    await expect(
      participantPage.getByText(/Welcome, Pat Participant/),
    ).toBeVisible();
    await expect(cell(availableSlots[0].index)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await participantPage
      .getByRole("button", { name: "Submit Availability" })
      .click();
    await expect(
      participantPage.getByText("Schedule submitted."),
    ).toBeVisible();

    const submittedSchedule = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    expect(submittedSchedule.response.status()).toBe(200);
    const submittedParticipant = submittedSchedule.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
    );
    expect(submittedParticipant.submitted).toBe(1);
    expect(submittedParticipant.availabilityInperson).toEqual(schedule);
    invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access,
    );
    registeredInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === participantEmail,
    );
    expect(registeredInvitation.status).toBe("submitted");
    expect(registeredInvitation.submittedAt).toBeTruthy();

    recomputeEventResults(eventCode);
    const officialResults = await apiJson(
      request,
      "GET",
      `/events/results?code=${eventCode}`,
      organizerSession.access,
    );
    expect(officialResults.response.status()).toBe(200);
    expect(officialResults.payload.results.countedResponseTotal).toBe(1);
    expect(officialResults.payload.results.unansweredParticipantTotal).toBe(1);
    expect(
      officialResults.payload.results.channels.inperson.weighted[
        availableSlots[0].index
      ],
    ).toBe(1);
    expect(officialResults.payload.results.recommendations[0]).toEqual(
      expect.objectContaining({
        rank: 1,
        channel: "inperson",
        slotIndex: availableSlots[0].index,
        endSlotIndex: availableSlots[1].index,
        durationMinutes: 60,
        weightedAvailability: 1,
      }),
    );

    const participantOwnOnlyResults = await apiJson(
      request,
      "GET",
      `/events/results?code=${eventCode}`,
      participantSession.access,
    );
    expect(participantOwnOnlyResults.response.status()).toBe(403);
    const participantOwnOnlySchedules = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    expect(participantOwnOnlySchedules.response.status()).toBe(200);
    expect(participantOwnOnlySchedules.payload.participants).toHaveLength(1);
    expect(participantOwnOnlySchedules.payload.participants[0].id).toBe(
      participantSession.user.id,
    );

    const reminderStartedAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Queue reminders" }).click();
    await expect(
      page.getByText("1 reminder emails were queued."),
    ).toBeVisible();
    const reminderDeliveryProgress = page.getByLabel("Event delivery progress");
    await expect(reminderDeliveryProgress.getByText("1 queued")).toBeVisible();
    dispatchEmailJobs();
    await reminderDeliveryProgress
      .getByRole("button", { name: "Refresh progress" })
      .click();
    await expect(reminderDeliveryProgress.getByText("1 sent")).toBeVisible();
    const reminder = await latestEmailFor(
      manualEmail,
      reminderStartedAt,
      (body) => body.includes("Reminder:") && body.includes("BEGIN:VCALENDAR"),
    );
    expect(reminder).toContain(`/temp-access?code=${eventCode}`);
    invitationState = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${eventCode}`,
      organizerSession.access,
    );
    const manualInvitation = invitationState.payload.invitations.find(
      (invitation) => invitation.email === manualEmail,
    );
    expect(manualInvitation.reminderSentAt).toBeTruthy();
    expect(manualInvitation.awaitingReminder).toBe(false);

    await participantPage.goto("/dashboard");
    await expect(
      participantPage.getByText("Events I Participate In (1)"),
    ).toBeVisible();
    await expect(participantPage.getByText(eventName)).toBeVisible();
    await participantPage.goto("/settings");
    await participantPage
      .getByRole("textbox", { name: "Last name" })
      .fill("Availability");
    await participantPage.getByRole("button", { name: "Save profile" }).click();
    await expect(participantPage.getByText("Saved")).toBeVisible();

    await page.goto("/dashboard");
    await expect(page.getByText("My Events (1)")).toBeVisible();
    await expect(page.getByText(eventName)).toBeVisible();
    await page.goto(`/event?code=${eventCode}`);
    await expect(
      page.getByRole("heading", { level: 2, name: eventName }),
    ).toBeVisible();
    const registeredParticipantCard = page
      .locator("tbody tr")
      .filter({ hasText: participantEmail });
    await expect(registeredParticipantCard).toContainText(participantEmail);
    await expect(registeredParticipantCard).toContainText("Submitted");

    const bulkControls = page.locator(
      'details[aria-label="Bulk roster actions"]',
    );
    await bulkControls.locator("summary").click();
    await bulkControls.getByLabel("Bulk update scope").selectOption("group");
    await bulkControls
      .getByLabel("Bulk update group")
      .selectOption("E2E Group");
    await bulkControls.getByLabel("Apply bulk weight").check();
    await bulkControls
      .getByRole("spinbutton", { name: "Bulk weight", exact: true })
      .fill("0.75");
    await bulkControls.getByRole("button", { name: "Apply update" }).click();
    await expect(page.getByText("Updated 2 roster entries.")).toBeVisible();

    const participantWeight = registeredParticipantCard.getByLabel(
      "Weight for Pat Participant",
    );
    await participantWeight.fill("0.5");
    await participantWeight.press("Tab");
    await expect(page.getByText("Pat Participant was updated.")).toBeVisible();

    const rosterAfterWeights = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(rosterAfterWeights.response.status()).toBe(200);
    const rosterParticipant = rosterAfterWeights.payload.participants.find(
      (participant) => participant.memberId === participantSession.user.id,
    );
    expect(rosterParticipant).toEqual(
      expect.objectContaining({
        group: "E2E Group",
        weight: 0.5,
        included: true,
      }),
    );
    const manualRosterParticipant =
      rosterAfterWeights.payload.participants.find(
        (participant) => participant.email === manualEmail,
      );
    expect(manualRosterParticipant.weight).toBe(0.75);

    const deniedRosterPatch = await apiJson(
      request,
      "PATCH",
      `/events/roster/${rosterParticipant.id}?code=${eventCode}`,
      participantSession.access,
      { weight: 0.25, expectedVersion: rosterParticipant.version },
    );
    expect(deniedRosterPatch.response.status()).toBe(403);
    const organizerParticipantVersion = rosterParticipant.version;

    const eventState = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access,
    );
    const closedEvent = await apiJson(
      request,
      "PUT",
      `/events/lifecycle?code=${eventCode}`,
      organizerSession.access,
      {
        status: "closed",
        expectedVersion: eventState.payload.event.version,
      },
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
      },
    );
    expect(duplicateClose.response.status()).toBe(200);
    expect(duplicateClose.payload.event.version).toBe(
      closedEvent.payload.event.version,
    );
    const lockedResponse = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      {
        availabilityInperson: schedule,
        expectedVersion: organizerParticipantVersion,
      },
    );
    expect(lockedResponse.response.status()).toBe(409);
    const reactivatedEvent = await apiJson(
      request,
      "PUT",
      `/events/lifecycle?code=${eventCode}`,
      organizerSession.access,
      {
        status: "active",
        expectedVersion: closedEvent.payload.event.version,
        responseDeadline: datetimeLocalHoursFromNow(72),
      },
    );
    expect(reactivatedEvent.response.status()).toBe(200);
    expect(reactivatedEvent.payload.event.status).toBe("active");

    recomputeEventResults(eventCode);
    await page.goto(`/event?code=${eventCode}`);
    await expect(
      page.getByRole("heading", { level: 2, name: eventName }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
    await expect(
      page.getByText("Top continuous windows for a 60-minute meeting."),
    ).toBeVisible();
    await expect(
      page.getByText(/Results are current at revision/),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Choose this time" })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Finalize" })).toBeFocused();
    await page.getByRole("button", { name: "Review attendance" }).click();
    await expect(
      page.getByText("Attendance review is current for this candidate."),
    ).toBeVisible();
    await expect(page.getByText("Available", { exact: true })).toBeVisible();

    const firstFinalStartedAt = Date.now() - 1000;
    const firstFinalResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events/finalization?code=${eventCode}`),
    );
    await page.getByRole("button", { name: "Finalize meeting" }).click();
    expect((await firstFinalResponsePromise).status()).toBe(202);
    await expect(
      page.getByText(
        "The meeting is finalized and calendar invitations are queued.",
      ),
    ).toBeVisible();
    const finalizationDeliveryProgress = page.getByLabel(
      "Finalization delivery progress",
    );
    await expect(
      finalizationDeliveryProgress.getByText("2 queued"),
    ).toBeVisible();
    dispatchEmailJobs();
    await finalizationDeliveryProgress
      .getByRole("button", { name: "Refresh progress" })
      .click();
    await expect(
      finalizationDeliveryProgress.getByText("2 sent"),
    ).toBeVisible();
    const firstFinalEvent = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access,
    );
    expect(firstFinalEvent.payload.event.status).toBe("finalized");
    expect(firstFinalEvent.payload.event.finalMeeting.calendarSequence).toBe(0);
    const calendarUid = firstFinalEvent.payload.event.finalMeeting.calendarUid;
    const participantFinal = await latestEmailFor(
      participantEmail,
      firstFinalStartedAt,
      (body) =>
        body.includes("The final meeting time") &&
        body.includes("METHOD:REQUEST"),
    );
    expect(participantFinal).toContain(`UID:${calendarUid}`);
    const manualFinal = await latestEmailFor(
      manualEmail,
      firstFinalStartedAt,
      (body) =>
        body.includes("The final meeting time") &&
        body.includes("METHOD:REQUEST"),
    );
    expect(manualFinal).toContain("X-WR-TIMEZONE:UTC");

    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download calendar (.ics)" })
      .click();
    const calendarDownload = await downloadPromise;
    expect(calendarDownload.suggestedFilename()).toMatch(/\.ics$/);
    expect(await fs.readFile(await calendarDownload.path(), "utf8")).toContain(
      "METHOD:REQUEST",
    );

    const cancellationStartedAt = Date.now() - 1000;
    const cancellationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events/lifecycle?code=${eventCode}`),
    );
    await page.getByRole("button", { name: "Reactivate event" }).click();
    expect((await cancellationResponsePromise).status()).toBe(202);
    await expect(
      page.getByText("This event is active and accepting responses."),
    ).toBeVisible();
    const cancellationDeliveryProgress = page.getByLabel(
      "Event delivery progress",
    );
    await expect(
      cancellationDeliveryProgress.getByText("2 queued"),
    ).toBeVisible();
    dispatchEmailJobs();
    await cancellationDeliveryProgress
      .getByRole("button", { name: "Refresh progress" })
      .click();
    await expect(
      cancellationDeliveryProgress.getByText("2 sent"),
    ).toBeVisible();
    const cancellation = await latestEmailFor(
      participantEmail,
      cancellationStartedAt,
      (body) =>
        body.includes("Scheduling for") && body.includes("METHOD:CANCEL"),
    );
    expect(cancellation).toContain(`UID:${calendarUid}`);
    expect(cancellation).toContain("SEQUENCE:1");

    recomputeEventResults(eventCode);
    const candidateButtons = page.getByRole("button", {
      name: "Choose this time",
    });
    await expect(candidateButtons.first()).toBeVisible();
    expect(await candidateButtons.count()).toBeGreaterThanOrEqual(3);
    await candidateButtons.nth(2).click();
    await page.getByRole("button", { name: "Review attendance" }).click();
    await expect(
      page.getByText("Attendance review is current for this candidate."),
    ).toBeVisible();
    const secondFinalStartedAt = Date.now() - 1000;
    const secondFinalResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events/finalization?code=${eventCode}`),
    );
    await page.getByRole("button", { name: "Finalize meeting" }).click();
    expect((await secondFinalResponsePromise).status()).toBe(202);
    await expect(
      page.getByText(
        "The meeting is finalized and calendar invitations are queued.",
      ),
    ).toBeVisible();
    dispatchEmailJobs();
    await finalizationDeliveryProgress
      .getByRole("button", { name: "Refresh progress" })
      .click();
    await expect(
      finalizationDeliveryProgress.getByText("2 sent"),
    ).toBeVisible();
    const reconfirmedEvent = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access,
    );
    expect(reconfirmedEvent.payload.event.finalMeeting.calendarUid).toBe(
      calendarUid,
    );
    expect(reconfirmedEvent.payload.event.finalMeeting.calendarSequence).toBe(
      2,
    );
    const reconfirmation = await latestEmailFor(
      participantEmail,
      secondFinalStartedAt,
      (body) =>
        body.includes("The final meeting time") && body.includes("SEQUENCE:2"),
    );
    expect(reconfirmation).toContain(`UID:${calendarUid}`);

    const finalizedLock = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      {
        availabilityInperson: schedule,
        expectedVersion: organizerParticipantVersion,
      },
    );
    expect(finalizedLock.response.status()).toBe(409);
    const participantCalendar = await request.get(
      `${BACKEND_URL}/events/finalization/calendar?code=${eventCode}`,
      {
        headers: { Authorization: `Bearer ${participantSession.access}` },
      },
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
      final_starts_at: reconfirmedEvent.payload.event.finalMeeting.startsAt,
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
    await fillTextbox(page, "Location / Address", "Lifecycle Room");
    await selectOption(page, "Event timezone", "UTC");
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const originalCode = new URL(page.url()).searchParams.get("code");
    const organizerSession = await readSession(page);

    const eventDefinition = await apiJson(
      request,
      "GET",
      `/events?code=${originalCode}`,
      organizerSession.access,
    );
    expect(eventDefinition.response.status()).toBe(200);

    const launchSeedEmail = `lifecycle-seed-${runId}@example.com`;
    const launchSeed = await importRoster(
      request,
      originalCode,
      organizerSession.access,
      `name,email,group\nLifecycle Seed,${launchSeedEmail},Lifecycle`,
    );
    expect(launchSeed.receipt).toEqual(
      expect.objectContaining({
        importedCount: 1,
        createdCount: 1,
        updatedCount: 0,
      }),
    );
    const removedLaunchEndpoint = await apiJson(
      request,
      "POST",
      `/events/launch?code=${originalCode}`,
      organizerSession.access,
      {
        expectedVersion: eventDefinition.payload.event.version,
        idempotencyKey: crypto.randomUUID(),
        selection: { allEligible: true },
      },
    );
    expect(removedLaunchEndpoint.response.status()).toBe(404);

    const joined = await apiJson(
      request,
      "POST",
      `/events/participants?code=${originalCode}`,
      organizerSession.access,
      {},
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
      },
    );
    expect(submitted.response.status()).toBe(200);

    await page.goto("/dashboard");
    const originalCard = page
      .getByRole("link", { name: originalName, exact: true })
      .locator("xpath=ancestor::article");
    await originalCard.getByRole("link", { name: "Edit" }).click();
    await expect(page).toHaveURL(new RegExp(`/edit\\?code=${originalCode}$`));
    await expect(
      page.getByRole("heading", { name: "Edit event" }),
    ).toBeVisible();
    await fillTextbox(page, "Event Name", updatedName);
    await page.getByLabel("End Time").fill("17:30");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByText("Schedule changes require a response reset"),
    ).toBeVisible();
    const saveButton = page.getByRole("button", { name: "Save changes" });
    await expect(saveButton).toBeDisabled();
    await page
      .getByLabel("I understand that participant availability will be reset.")
      .check();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page).toHaveURL(new RegExp(`/event\\?code=${originalCode}$`));

    const resetRoster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${originalCode}`,
      organizerSession.access,
    );
    expect(resetRoster.response.status()).toBe(200);
    const resetOrganizer = resetRoster.payload.participants.find(
      (participant) => participant.memberId === organizerSession.user.id,
    );
    expect(resetOrganizer).toBeTruthy();
    expect(resetOrganizer.submitted).toBe(false);
    expect(resetOrganizer.version).toBe(3);
    const resetSchedule = await apiJson(
      request,
      "GET",
      `/events/roster/${resetOrganizer.id}/schedule?code=${originalCode}`,
      organizerSession.access,
    );
    expect(resetSchedule.response.status()).toBe(200);
    expect(resetSchedule.payload.schedule.availabilityInperson).toHaveLength(
      eventDefinition.payload.event.slotCount + 5,
    );
    expect(
      resetSchedule.payload.schedule.availabilityInperson.every(
        (value) => !value,
      ),
    ).toBe(true);

    await page.goto("/dashboard");
    const updatedCard = page
      .getByRole("link", { name: updatedName, exact: true })
      .locator("xpath=ancestor::article");
    await updatedCard.getByRole("button", { name: "Duplicate" }).click();
    await expect(
      page.getByText(`${updatedName} was duplicated as a new active event.`),
    ).toBeVisible();
    const copyName = `${updatedName} (copy)`;
    const copyCard = page
      .getByRole("link", { name: copyName, exact: true })
      .locator("xpath=ancestor::article");
    await expect(copyCard.getByText("Status: active")).toBeVisible();
    const copyCodeText = await copyCard.getByText(/^Code: /).textContent();
    const copyCode = copyCodeText.replace("Code: ", "").trim();
    const copyRoster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${copyCode}`,
      organizerSession.access,
    );
    expect(copyRoster.response.status()).toBe(200);
    expect(copyRoster.payload.participants).toEqual([]);

    await updatedCard.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText(`${updatedName} was archived.`)).toBeVisible();
    await expect(updatedCard.getByText("Status: archived")).toBeVisible();
    await expect(
      updatedCard.getByRole("link", { name: "Edit" }),
    ).toHaveAttribute("aria-disabled", "true");

    await copyCard.getByRole("button", { name: "Delete" }).click();
    const deleteButton = page.getByRole("button", {
      name: "Delete event permanently",
    });
    await expect(deleteButton).toBeDisabled();
    await page.getByLabel("Event code confirmation").fill(copyCode);
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();
    await expect(
      page.getByText(`${copyName} was permanently deleted.`),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: copyName, exact: true }),
    ).toHaveCount(0);

    const deletedCopy = await apiJson(
      request,
      "GET",
      `/events?code=${copyCode}`,
      organizerSession.access,
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
    await loginWithEmailCode(otherPage, email);
    const otherOriginalSession = await readSession(otherPage);

    const resetStartedAt = Date.now() - 1000;
    await page.goto("/recover");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(
      page.getByText(
        "If an account exists for that email, a reset code has been sent. Check your inbox.",
      ),
    ).toBeVisible();
    const resetCode = await latestVerificationCode(email, resetStartedAt);
    await page.getByLabel("Reset code").fill(resetCode);
    await page.getByLabel("New password", { exact: true }).fill(resetPassword);
    await page.getByLabel("Confirm new password").fill(resetPassword);
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page).toHaveURL(/\/login\?status=password-reset$/);
    await expect(
      page.getByText("Password reset complete. Continue with your email."),
    ).toBeVisible();

    for (const access of [memberSession.access, otherOriginalSession.access]) {
      const revoked = await apiJson(request, "GET", "/authn/profile/", access);
      expect(revoked.response.status()).toBe(401);
    }

    await loginWithEmailCode(page, email);
    const resetSession = await readSession(page);
    await page.goto("/settings");
    // The change-password fields sit inside a collapsed disclosure.
    const passwordForm = page.locator("form#password");
    await passwordForm.locator("summary").click();
    await passwordForm.getByLabel("Current password").fill(resetPassword);
    await passwordForm
      .getByLabel("New password", { exact: true })
      .fill(finalPassword);
    await passwordForm.getByLabel("Confirm new password").fill(finalPassword);
    await passwordForm.getByRole("button", { name: "Change password" }).click();
    await expect(page).toHaveURL(/\/login\?status=password-changed$/);
    await expect(
      page.getByText(
        "Password changed. Continue with your email on this device.",
      ),
    ).toBeVisible();
    const changedSessionRejected = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      resetSession.access,
    );
    expect(changedSessionRejected.response.status()).toBe(401);

    const oldPasswordLogin = await request.post(`${BACKEND_URL}/authn/login/`, {
      data: { email, password: resetPassword },
    });
    expect(oldPasswordLogin.status()).toBe(400);

    await loginWithEmailCode(page, email);
    const primaryFinalSession = await readSession(page);
    await loginWithEmailCode(otherPage, email);
    const otherFinalSession = await readSession(otherPage);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Sign out all devices" }).click();
    await expect(page).toHaveURL(/\/login\?status=signed-out-all$/);
    await expect(
      page.getByText("All devices have been signed out."),
    ).toBeVisible();

    for (const access of [
      primaryFinalSession.access,
      otherFinalSession.access,
    ]) {
      const revoked = await apiJson(request, "GET", "/authn/profile/", access);
      expect(revoked.response.status()).toBe(401);
    }

    await loginWithEmailCode(page, email);
    await page.goto("/settings");
    // The delete fields also sit inside a collapsed disclosure.
    const deleteForm = page.locator("form#danger-zone");
    await deleteForm.locator("summary").click();
    await deleteForm.getByLabel("Type DELETE to confirm").fill("DELETE");
    // Deletion is confirmed by an emailed code, not by the password.
    const deleteStartedAt = Date.now() - 1000;
    await deleteForm
      .getByRole("button", { name: "Email a confirmation code" })
      .click();
    await expect(
      page.getByText(
        "We emailed a confirmation code. Enter it to delete your account.",
      ),
    ).toBeVisible();
    const deleteCode = await latestVerificationCode(email, deleteStartedAt);
    await deleteForm.getByLabel("Confirmation code").fill(deleteCode);
    await deleteForm
      .getByRole("button", { name: "Delete account permanently" })
      .click();
    await expect(page).toHaveURL(/\/login\?status=account-deleted$/);
    await expect(
      page.getByText("Your account has been deleted."),
    ).toBeVisible();

    const deletedLogin = await request.post(`${BACKEND_URL}/authn/login/`, {
      data: { email, password: finalPassword },
    });
    expect(deletedLogin.status()).toBe(400);
    assertDeletedAccountState({ member_id: memberId, email });
    await otherContext.close();
  });
});

test.describe("Releviz admin", () => {
  test("renders the themed admin login and authenticated sidebar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BACKEND_URL}/admin/login/?next=/admin/`);
    await expect(page.locator(".login-box")).toBeVisible();
    await expect(page.locator("img.login-logo")).toHaveAttribute(
      "src",
      /releviz-mark\.png/,
    );
    await expect(page.getByText("Releviz Admin")).toBeVisible();
    // The login page opens on the email-code step; the password form lives
    // behind the alternate-mode link.
    await page
      .getByRole("link", { name: "Sign in with password instead" })
      .click();
    await page.locator("#id_email").fill(ADMIN_EMAIL);
    await page.locator("#id_password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin\/$/);
    await expect(
      page
        .locator("#nav-sidebar-apps")
        .getByRole("heading", { name: "Scheduling" }),
    ).toBeVisible();
    await expect(
      page
        .locator("#nav-sidebar-apps")
        .getByRole("heading", { name: "Members & Authentication" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-admin-theme-choice="dark"]').first(),
    ).toBeAttached();

    const sidebar = page.locator("#nav-sidebar-apps");
    const activeSidebarLinks = sidebar.locator("a.active");

    await sidebar.getByRole("link", { name: "AWS SES Providers" }).click();
    await expect(page).toHaveURL(/\/admin\/mail\/emailproviderconfig\/$/);
    await expect(activeSidebarLinks).toHaveCount(1);
    await expect(activeSidebarLinks).toHaveText("AWS SES Providers");

    const activeTabs = page.locator("#tabs-items a.active");
    await page
      .locator("#tabs-items")
      .getByRole("link", { name: "Email Logs" })
      .click();
    await expect(page).toHaveURL(/\/admin\/mail\/emailmessagelog\/$/);
    await expect(activeSidebarLinks).toHaveCount(1);
    await expect(activeSidebarLinks).toHaveText("AWS SES Providers");
    await expect(activeTabs).toHaveText("Email Logs");
  });
});
