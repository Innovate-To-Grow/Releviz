const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BACKEND_URL,
  PYTHON_BIN,
  ROOT,
  apiJson,
  datetimeLocalHoursFromNow,
  dispatchEmailJobs,
  expandAdvancedOptions,
  expectDashboard,
  fillTextbox,
  latestEmailFor,
  latestVerificationCode,
  loginWithEmailCode,
  nextWeekdayDate,
  openRankedWindows,
  readSession,
  recomputeEventResults,
  registerAccount,
  selectOption,
} = require("./helpers/releviz");

// The workspace and its delivery card keep themselves current on their own,
// checking every 3 s and easing off to every 15 s while nothing changes, so a
// wait for a change they pick up needs more than the default expect timeout.
const LIVE_SYNC_TIMEOUT_MS = 20_000;

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
    {
      mode: "merge",
      sendInvitations: true,
      idempotencyKey: crypto.randomUUID(),
    },
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
assert list(participant.groups.values_list("name", flat=True)) == ["E2E Group"]
assert participant.all_groups is False
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
manual_participant = Participant.objects.get(event=event, member_id=manual_invitation.member_id)
assert sorted(manual_participant.groups.values_list("name", flat=True)) == ["E2E Group", "E2E Second"]
assert sorted(event.participant_groups.values_list("name", flat=True)) == ["E2E Group", "E2E Second"]
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

function assertOrganizerManagedState(payload) {
  const script = `
import json
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.e2e")
django.setup()

from apps.authn.models import ContactEmail, Member
from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import Event, EventInvitation, Participant

data = json.loads(${JSON.stringify(JSON.stringify(payload))})
event = Event.objects.get(code=data["code"])
organizer = Member.objects.get(pk=data["organizer_id"])

assert EventInvitation.objects.filter(event=event).count() == 0
# The email worker webServer is always running, so count by type rather than
# by status: no invitation is ever queued for an organizer-managed person.
assert EmailDeliveryJob.objects.filter(
    event=event,
    message_type=EmailMessageLog.MessageType.INVITATION,
).count() == 0
# The organizer never becomes a participant of their own event.
assert not Participant.objects.filter(event=event, member=organizer).exists()
managed = Participant.objects.filter(event=event, organizer_managed=True)
assert sorted(managed.values_list("participant_name", flat=True)) == sorted(data["names"])
assert managed.get(participant_name=data["names"][0]).contact_phone == data["phone"]
for participant in managed:
    assert participant.contact_email == data["organizer_email"]
    assert participant.member_id != organizer.pk
    assert participant.member.access_level == "temporary"
    assert participant.member.email == ""
    assert not ContactEmail.objects.filter(member=participant.member).exists()
# The shared address still belongs to the organizer alone.
assert ContactEmail.objects.get(email_address=data["organizer_email"]).member_id == organizer.pk
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
# The reset re-seeds from the event's starting availability. This event kept
# the Available default, so every slot is 1 (all zeros under the old Busy start).
assert event.starting_availability == "available"
assert all(value == 1 for value in participant.availability_inperson)
assert all(value == 1 for value in participant.availability_virtual)

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

// The revision the Results panel says it is current at, or -1 while it is
// still updating.
async function currentResultsRevision(page) {
  const text = await page
    .getByText(/Results are current at revision \d+/)
    .textContent({ timeout: 500 })
    .catch(() => "");
  const match = String(text || "").match(/revision (\d+)/);
  return match ? Number(match[1]) : -1;
}

function temporaryAccessPathFromEmail(body) {
  const rawLink = body.match(/Link:\s*(https?:\/\/[^\s<]+)/i)?.[1];
  if (!rawLink)
    throw new Error("No temporary access link found in invitation email");
  const link = new URL(rawLink.replaceAll("&amp;", "&"));
  return `${link.pathname}${link.search}`;
}

// Clicks "Review attendance" until the preview lands. The Finalize step
// re-keys when a pick changes, so a click made right after can be dropped by
// slower engines (seen on WebKit); the preview is read-only, so retrying is
// safe.
async function reviewAttendance(page) {
  const notice = page.getByText(
    "Attendance review is current for this candidate.",
  );
  await expect
    .poll(
      async () => {
        if (await notice.isVisible()) return true;
        await page.getByRole("button", { name: "Review attendance" }).click();
        return notice.isVisible();
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
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
    // The workspace opens one event stream as soon as it mounts. Playwright
    // reports a response when its headers arrive, which for a Server-Sent
    // Events response is long before the body ends, so this wait settles
    // while the stream stays open. The request counter shows the stream is
    // doing the work: while it is up, the digest is only read on a pushed
    // change or once a minute.
    const streamOpened = page.waitForResponse(
      (response) =>
        response.url().includes("/events/stream?") && response.status() === 200,
    );
    let activityRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/events/activity?")) activityRequests += 1;
    });
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    expect(eventCode).toMatch(/^[A-Z0-9]+$/);
    await expect(
      page.getByRole("heading", { level: 2, name: eventName }),
    ).toBeVisible();
    await streamOpened;
    // The results worker publishes the new event's first snapshot, and that
    // publication is itself a pushed change; once the panel shows the
    // revision, the catch-up pass the stream's open triggered has landed.
    await expect
      .poll(() => currentResultsRevision(page), { timeout: 20_000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    const quietStart = activityRequests;
    await page.waitForTimeout(12_000);
    // While the stream is up the workspace only checks the digest on a pushed
    // change or once a minute, whereas fallback polling would have asked at
    // least twice in twelve seconds.
    expect(activityRequests - quietStart).toBe(0);
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
    await page.getByLabel("Send invitations to newly added people").check();
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
    await expect(eventDeliveryProgress.getByText("1 sent")).toBeVisible({
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
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
    ).toBe("sent");
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
      "temp_event_access",
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

    await expect(page.getByLabel("Roster summary")).toContainText(
      "0 submitted",
    );
    let revisionBeforeResponse = -1;
    await expect
      .poll(
        async () => {
          revisionBeforeResponse = await currentResultsRevision(page);
          return revisionBeforeResponse;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // This event keeps the default Available start, so the roster import
    // seeded Taylor's schedule with ones and the brush pre-selects Busy:
    // "Apply to all" paints every slot Busy. The flow only asserts the saved
    // and submitted states and the counted total, never the slot values, so
    // the click still produces the change that drives autosave.
    await temporaryPage.getByRole("button", { name: "Apply to all" }).click();
    await expect(temporaryPage.getByText("Saving draft…")).toBeVisible();
    await expect(
      temporaryPage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();
    await temporaryPage
      .getByRole("button", { name: "Submit availability" })
      .click();
    await expect(temporaryPage.getByText("Schedule submitted.")).toBeVisible();

    // The organizer workspace picks the response up on its own (its live
    // sync checks every 3 s while things change and eases off to every 15 s
    // while nothing does): the roster counts it and the results move on to a
    // newer revision, with no Refresh press.
    await expect(page.getByLabel("Roster summary")).toContainText(
      "1 submitted",
      {
        timeout: 20_000,
      },
    );
    await expect(participantCard).toContainText(/Response\s*Submitted/);
    await expect
      .poll(() => currentResultsRevision(page), { timeout: 20_000 })
      .toBeGreaterThan(revisionBeforeResponse);
    await expect(
      page.getByText("New responses load automatically."),
    ).toBeVisible();
    // Live sync cannot be switched off and needs no hand: the header offers
    // neither a rate control nor a Refresh button.
    await expect(page.getByLabel("Check for new responses")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh", exact: true }),
    ).toHaveCount(0);

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
    // The drawer's brush also pre-selects Busy for an Available-start event,
    // so choosing Busy is a no-op and the first slot is already Busy after
    // Taylor's "Apply to all". "Submit on behalf" saves regardless of whether
    // anything changed, which is all this flow checks.
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
      "register",
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

    const addedEmail = `added-${runId}@example.com`;
    await page.getByRole("button", { name: "Add person", exact: true }).click();
    await fillTextbox(page, "Full name", "Added Avery");
    await fillTextbox(page, "Email address", addedEmail);
    await page.getByRole("button", { name: "Add only" }).click();
    await expect(
      page.getByText("Added Avery was added. No invitation was sent."),
    ).toBeVisible();
    // Adding someone never selects them, so the next Send invitation cannot
    // quietly include a person who was added without one.
    await expect(page.getByText("0 selected", { exact: true })).toHaveCount(2);
    await expect(
      page
        .getByRole("button", { name: "Send invitation", exact: true })
        .first(),
    ).toBeDisabled();

    const rosterAfterAdd = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(rosterAfterAdd.response.status()).toBe(200);
    const addedParticipant = rosterAfterAdd.payload.participants.find(
      (participant) => participant.email === addedEmail,
    );
    expect(addedParticipant).toEqual(
      expect.objectContaining({ invitationStatus: "not_sent" }),
    );
    const addedCard = page.locator(
      `[data-roster-participant-id="${addedParticipant.id}"]`,
    );
    await expect(addedCard.getByText("Not sent")).toBeVisible();
    const addedState = temporaryAccountState({
      code: eventCode,
      email: addedEmail,
    });
    expect(addedState).toEqual(
      expect.objectContaining({
        invitationJobCount: 0,
        invitationFirstSent: false,
      }),
    );

    await addedCard.getByLabel("Select Added Avery").check();
    await page
      .getByRole("button", { name: "Send invitation", exact: true })
      .first()
      .click();
    await expect(page.getByText(/Queued 1 invitation/)).toBeVisible();
    await expect(eventDeliveryProgress).toBeVisible();

    dispatchEmailJobs();
    // Delivery moves the invitation, which the live sync picks up as a
    // roster change.
    await expect(addedCard.getByText("Sent", { exact: true })).toBeVisible({
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    const rosterAfterSend = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(rosterAfterSend.response.status()).toBe(200);
    expect(
      rosterAfterSend.payload.participants.find(
        (participant) => participant.id === addedParticipant.id,
      )?.invitationStatus,
    ).toBe("sent");
    const sentAddedState = temporaryAccountState({
      code: eventCode,
      email: addedEmail,
    });
    expect(sentAddedState).toEqual(
      expect.objectContaining({
        invitationJobCount: 1,
        invitationFirstSent: true,
      }),
    );

    await temporaryContext.close();
  });

  test("adds people with no email of their own without inviting them", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const organizerEmail = `managing-organizer-${runId}@example.com`;
    const eventName = `Organizer-managed roster ${runId}`;
    const managedName = "Managed Morgan Junior";
    const managedPhone = "+1 (555) 010-2030";

    await registerAccount(page, organizerEmail, "Morgan", "Manager");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await fillTextbox(page, "Event Name", eventName);
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    expect(eventCode).toMatch(/^[A-Z0-9]+$/);
    const organizerSession = await readSession(page);

    // The email can stay blank: the person is filed under the organizer's
    // own address, which never becomes theirs.
    await page.getByRole("button", { name: "Add person", exact: true }).click();
    await fillTextbox(page, "Full name", managedName);
    await fillTextbox(page, "Phone (optional)", managedPhone);
    await page
      .getByRole("checkbox", {
        name: "No email of their own — use one of mine and I'll enter their schedule",
      })
      .check();
    await expect(
      page.getByText(
        "Leave blank to use your account email, or enter another of your verified addresses. No invitation is sent.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add person", exact: true }).click();
    await expect(
      page.getByText(
        `${managedName} was added. Use Edit schedule to enter their availability.`,
      ),
    ).toBeVisible();

    const managedRow = page.locator("tr.roster-table__row", {
      hasText: managedName,
    });
    await expect(managedRow).toContainText("Organizer-managed");
    await expect(managedRow).toContainText("No email");
    await expect(managedRow).not.toContainText(organizerEmail);
    await expect(managedRow).toContainText(managedPhone);
    await expect(managedRow).toContainText("Not sent");
    await expect(
      managedRow.getByRole("button", { name: "Edit schedule" }),
    ).toBeVisible();

    assertOrganizerManagedState({
      code: eventCode,
      organizer_id: organizerSession.user.id,
      organizer_email: organizerEmail,
      names: [managedName],
      phone: managedPhone,
    });

    // A roster import treats a blank email, or the organizer's own address,
    // the same way: people the organizer manages, never invited, even with
    // invitations switched on for the import.
    const imported = await importRoster(
      request,
      eventCode,
      organizerSession.access,
      "name,email,group\n" +
        "Sam No Email,,ALL\n" +
        `Organizer Twin,${organizerEmail},\n`,
    );
    expect(imported.receipt).toEqual(
      expect.objectContaining({ importedCount: 2, createdCount: 2 }),
    );
    expect(imported.autoInvitedCount).toBe(0);
    assertOrganizerManagedState({
      code: eventCode,
      organizer_id: organizerSession.user.id,
      organizer_email: organizerEmail,
      names: [managedName, "Sam No Email", "Organizer Twin"],
      phone: managedPhone,
    });
    const dashboard = await apiJson(
      request,
      "GET",
      "/dashboard/events",
      organizerSession.access,
    );
    expect(dashboard.payload.participating).toEqual([]);
    const samRow = page.locator("tr.roster-table__row", {
      hasText: "Sam No Email",
    });
    await expect(samRow).toContainText("No email", { timeout: 20_000 });
    await expect(
      samRow.getByLabel("All groups for Sam No Email"),
    ).toBeChecked();
    await expect(
      samRow.getByRole("button", { name: "Edit schedule" }),
    ).toBeVisible();
  });

  test("lets the organizer enter a schedule for an existing full account until that person responds", async ({
    browser,
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const organizerEmail = `full-organizer-${runId}@example.com`;
    const participantEmail = `fiona-${runId}@example.com`;
    const eventName = `Full account roster ${runId}`;
    const participantName = "Full Fiona";

    const participantContext = await browser.newContext();
    const participantPage = await participantContext.newPage();
    await registerAccount(participantPage, participantEmail, "Fiona", "Full");
    const participantSession = await readSession(participantPage);

    await registerAccount(page, organizerEmail, "Owen", "Organizer");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await fillTextbox(page, "Event Name", eventName);
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    expect(eventCode).toMatch(/^[A-Z0-9]+$/);
    const organizerSession = await readSession(page);

    await page.getByRole("button", { name: "Add person", exact: true }).click();
    await fillTextbox(page, "Full name", participantName);
    await fillTextbox(page, "Email address", participantEmail);
    await page.getByRole("button", { name: "Add only" }).click();
    await expect(
      page.getByText(
        `${participantName} was added. No invitation was sent. They already have a Releviz account, so you can use Edit schedule until they respond themselves.`,
      ),
    ).toBeVisible();

    const fullRow = page.locator("tr.roster-table__row", {
      hasText: participantName,
    });
    await expect(fullRow).toContainText("Full account");
    await expect(fullRow).toContainText("Not sent");
    await fullRow.getByRole("button", { name: "Edit schedule" }).click();
    const organizerDrawer = page.getByRole("dialog", {
      name: `Edit ${participantName}'s schedule`,
    });
    await expect(organizerDrawer).toBeVisible();
    await expect(
      organizerDrawer.getByText("Full account · not responded yet"),
    ).toBeVisible();
    await organizerDrawer
      .getByRole("button", { name: "Submit on behalf" })
      .click();
    await expect(
      organizerDrawer.getByText("Schedule submitted."),
    ).toBeVisible();

    // Entering the response is not an acceptance: the row stays Not sent
    // and the organizer keeps the right to edit it.
    const rosterAfterSubmit = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(rosterAfterSubmit.response.status()).toBe(200);
    expect(
      rosterAfterSubmit.payload.participants.find(
        (participant) => participant.email === participantEmail,
      ),
    ).toEqual(
      expect.objectContaining({
        memberId: participantSession.user.id,
        accountAccess: "full",
        canOrganizerEditAvailability: true,
        submitted: true,
        invitationStatus: "not_sent",
      }),
    );

    // With the drawer still open, Fiona saves her own answers, which makes
    // the response hers.
    const ownState = await apiJson(
      request,
      "GET",
      `/events/participants?code=${eventCode}`,
      participantSession.access,
    );
    expect(ownState.response.status()).toBe(200);
    const ownResponse = ownState.payload.participants.find(
      (participant) => participant.id === participantSession.user.id,
    );
    expect(ownResponse).toEqual(expect.objectContaining({ submitted: 1 }));
    const ownSchedule = [...ownResponse.availabilityInperson];
    ownSchedule[0] = ownSchedule[0] === 1 ? 0 : 1;
    const ownSave = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      participantSession.access,
      {
        availabilityInperson: ownSchedule,
        expectedVersion: ownResponse.version,
      },
    );
    expect(ownSave.response.status()).toBe(200);

    await organizerDrawer.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByText(
        `${participantName} now manages their own response, so you can no longer edit their schedule.`,
      ),
    ).toBeVisible();

    await expect(fullRow).toContainText("Self-managed", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(
      fullRow.getByRole("button", { name: "Edit schedule" }),
    ).toHaveCount(0);
    const rosterAfterClaim = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(rosterAfterClaim.response.status()).toBe(200);
    const claimedParticipant = rosterAfterClaim.payload.participants.find(
      (participant) => participant.email === participantEmail,
    );
    expect(claimedParticipant).toEqual(
      expect.objectContaining({
        accountAccess: "full",
        canOrganizerEditAvailability: false,
      }),
    );
    const deniedUpdate = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${eventCode}&participantId=${participantSession.user.id}`,
      organizerSession.access,
      {
        availabilityInperson: ownResponse.availabilityInperson,
        expectedVersion: claimedParticipant.version,
      },
    );
    expect(deniedUpdate.response.status()).toBe(403);
    expect(deniedUpdate.payload.errorCode).toBe(
      "organizer_edit_participant_owned",
    );

    await participantContext.close();
  });

  test("lets the organizer add themselves, fix a mistyped email, count one group alone, and remove someone", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const organizerEmail = `self-organizer-${runId}@example.com`;
    const typoEmail = `ada-${runId}@exmaple.com`;
    const fixedEmail = `ada-${runId}@example.com`;

    await registerAccount(page, organizerEmail, "Owen", "Organizer");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await fillTextbox(page, "Event Name", `Roster corrections ${runId}`);
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    const organizerSession = await readSession(page);

    for (const [name, email] of [
      ["Ada Typo", typoEmail],
      ["Ben Leaving", `ben-${runId}@example.com`],
    ]) {
      await page
        .getByRole("button", { name: "Add person", exact: true })
        .click();
      await fillTextbox(page, "Full name", name);
      await fillTextbox(page, "Email address", email);
      await page.getByRole("button", { name: "Add only" }).click();
      await expect(
        page.getByText(`${name} was added. No invitation was sent.`),
      ).toBeVisible();
    }

    // The organizer answers too, under their own account, and is never
    // invited.
    await page.getByRole("button", { name: "Add myself" }).click();
    const ownDrawer = page.getByRole("dialog", { name: "Edit my schedule" });
    await expect(ownDrawer).toBeVisible();
    await expect(ownDrawer.getByText("Your own response")).toBeVisible();
    await ownDrawer
      .getByRole("button", { name: "Submit", exact: true })
      .click();
    await expect(ownDrawer.getByText("Schedule submitted.")).toBeVisible();
    await ownDrawer.locator(".managed-drawer__close").click();
    await expect(ownDrawer).toHaveCount(0);
    const ownRow = page.locator("tr.roster-table__row", {
      hasText: "Owen Organizer",
    });
    await expect(ownRow).toContainText("You (organizer)");
    await expect(page.getByRole("button", { name: "Add myself" })).toHaveCount(
      0,
    );

    // A mistyped address is fixed in place; the row keeps its name.
    await page
      .getByRole("button", { name: "Edit name and email for Ada Typo" })
      .click();
    const details = page.getByRole("dialog", { name: "Edit Ada Typo" });
    await details.getByLabel(/Email address/).fill(fixedEmail);
    await details.getByRole("button", { name: "Save details" }).click();
    await expect(details).toHaveCount(0);
    await expect(
      page.getByText(
        `Ada Typo now uses ${fixedEmail}. Their invitation has not been sent to this address yet.`,
      ),
    ).toBeVisible();
    const adaRow = page.locator("tr.roster-table__row", {
      hasText: "Ada Typo",
    });
    await expect(adaRow).toContainText(fixedEmail);
    await expect(adaRow).toContainText("Not sent");

    // One group alone counts in the results; Include everyone undoes it.
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("New group name").fill("Team A");
    await page
      .getByRole("button", { name: "Create group", exact: true })
      .click();
    await expect(page.getByText("Created Team A.")).toBeVisible();
    await page.getByLabel("Ada Typo in Team A").check();
    await page.getByRole("button", { name: "Save group changes" }).click();
    const teamRow = page
      .getByRole("region", { name: "Roster groups" })
      .locator('[data-roster-group="Team A"]');
    await expect(teamRow).toContainText("1 person");
    await teamRow.getByRole("button", { name: "Only this group" }).click();
    await expect(
      page.getByText(
        "Only Team A counts in the results now. Use Include everyone to bring the others back.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Include Ada Typo")).toBeChecked();
    await expect(page.getByLabel("Include Ben Leaving")).not.toBeChecked();
    await expect(page.getByLabel("Include Owen Organizer")).not.toBeChecked();
    await page.getByRole("button", { name: "Include everyone" }).click();
    await expect(page.getByLabel("Include Ben Leaving")).toBeChecked();
    await expect(page.getByLabel("Include Owen Organizer")).toBeChecked();

    // Removing asks first, then deletes the row and its invitation.
    await page.getByRole("button", { name: "Remove Ben Leaving" }).click();
    const removeDialog = page.getByRole("dialog", {
      name: "Remove Ben Leaving from the roster?",
    });
    await expect(
      removeDialog.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await removeDialog.getByRole("button", { name: "Remove person" }).click();
    await expect(
      page.getByText("Ben Leaving was removed from the roster."),
    ).toBeVisible();
    await expect(
      page.locator("tr.roster-table__row", { hasText: "Ben Leaving" }),
    ).toHaveCount(0);

    const roster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(roster.response.status()).toBe(200);
    expect(roster.payload.organizerOnRoster).toBe(true);
    expect(
      roster.payload.participants
        .map((participant) => participant.email)
        .sort(),
    ).toEqual([fixedEmail, organizerEmail].sort());
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
    // Participants start Available by default. This flow drives the editor
    // from a Busy start (paint Available, "Mark all Busy", a tap turns a slot
    // on), so it opts into the legacy start here; the default itself is
    // covered by starting-availability.spec.js.
    await expect(page.getByLabel("Participants start as")).toHaveValue(
      "available",
    );
    await selectOption(
      page,
      "Participants start as",
      "Busy (they mark the times that work)",
      "busy",
    );
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
    // The lifecycle summary sits beside the controls from first paint.
    await expect(
      page.getByText("This event is active and accepting responses."),
    ).toBeVisible();
    await expectAccessible(page, "organizer event");

    // Groups can be set up before anyone is on the roster. This one is
    // deleted again straight away so the group checks further down still see
    // only the groups the roster import and the organizer create later.
    await expect(page.getByText("No participants yet")).toBeVisible();
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("New group name").fill("E2E Early");
    await page
      .getByRole("button", { name: "Create group", exact: true })
      .click();
    await expect(page.getByText("Created E2E Early.")).toBeVisible();
    const earlyGroupRow = page
      .getByRole("region", { name: "Roster groups" })
      .locator('[data-roster-group="E2E Early"]');
    await expect(earlyGroupRow).toContainText("0 people");
    await earlyGroupRow.getByRole("button", { name: "Delete group" }).click();
    const earlyGroupDialog = page.getByRole("dialog", {
      name: "Delete group E2E Early?",
    });
    await earlyGroupDialog
      .getByRole("button", { name: "Delete group" })
      .click();
    await expect(page.getByText("Deleted E2E Early.")).toBeVisible();
    await expect(earlyGroupDialog).toHaveCount(0);
    await expect(earlyGroupRow).toHaveCount(0);
    await expect(page.getByText(/No groups yet/)).toBeVisible();

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
    expect(eventDefinition.startingAvailability).toBe("busy");
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
    // The background email worker may deliver before the panel renders, so
    // assert the run's size rather than its transient "queued" count.
    const reminderDeliveryProgress = page.getByLabel("Event delivery progress");
    await expect(reminderDeliveryProgress.getByText("1 total")).toBeVisible();
    dispatchEmailJobs();
    await expect(reminderDeliveryProgress.getByText("1 sent")).toBeVisible({
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
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

    // The Groups table manages a whole group at once: its shared weight is
    // now mixed, and setting it re-applies one weight to every member.
    const groupsTable = page.getByRole("region", { name: "Roster groups" });
    const groupRow = groupsTable.locator('[data-roster-group="E2E Group"]');
    await expect(groupRow).toContainText("2 people");
    await expect(groupRow).toContainText("Mixed");
    const groupWeight = groupsTable.getByRole("spinbutton", {
      name: "Weight for group E2E Group",
    });
    await groupWeight.fill("0.6");
    await groupWeight.press("Enter");
    await expect(
      page.getByText("Weight 0.6 now applies to 2 people in E2E Group."),
    ).toBeVisible();
    await expect(groupWeight).toHaveValue("0.6");
    await expect(groupRow).not.toContainText("Mixed");
    await expect(participantWeight).toHaveValue("0.6");
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
    // The group weight (0.6) reached everyone in E2E Group; only Pat was
    // changed again afterwards.
    expect(manualRosterParticipant.weight).toBe(0.6);

    // Groups exist on their own: create an empty one from the Groups panel,
    // then add one selected person to it without leaving E2E Group.
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("New group name").fill("E2E Second");
    await page
      .getByRole("button", { name: "Create group", exact: true })
      .click();
    await expect(page.getByText("Created E2E Second.")).toBeVisible();
    const secondGroupRow = groupsTable.locator(
      '[data-roster-group="E2E Second"]',
    );
    await expect(secondGroupRow).toContainText("0 people");
    await page.getByLabel("Select Manual Participant").check();
    await secondGroupRow.getByRole("button", { name: "Add selected" }).click();
    await expect(page.getByText("Added 1 person to E2E Second.")).toBeVisible();
    await expect(secondGroupRow).toContainText("1 person");
    await expect(groupRow).toContainText("2 people");
    await page.getByLabel("Select Manual Participant").uncheck();

    // Every group is also a checkbox column on the roster rows: ticking one
    // stages that single membership until Save group changes, and All puts
    // the person in every group.
    const patInSecond = page.getByLabel("Pat Participant in E2E Second");
    const unsavedGroups = page.getByRole("region", {
      name: "Unsaved group changes",
    });
    const saveGroups = page.getByRole("button", { name: "Save group changes" });
    await expect(
      page.getByLabel("Manual Participant in E2E Second"),
    ).toBeChecked();
    await expect(patInSecond).not.toBeChecked();
    await patInSecond.check();
    await expect(unsavedGroups).toContainText(
      "1 unsaved group change for 1 person.",
    );
    // Nothing is saved until the organizer says so.
    await expect(secondGroupRow).toContainText("1 person");
    await saveGroups.click();
    await expect(unsavedGroups).toHaveCount(0);
    await expect(secondGroupRow).toContainText("2 people");
    await patInSecond.uncheck();
    await saveGroups.click();
    await expect(unsavedGroups).toHaveCount(0);
    await expect(secondGroupRow).toContainText("1 person");
    const patInAll = page.getByLabel("All groups for Pat Participant");
    await patInAll.check();
    await expect(patInSecond).toBeChecked();
    await expect(patInSecond).toBeDisabled();
    await saveGroups.click();
    await expect(unsavedGroups).toHaveCount(0);
    await expect(secondGroupRow).toContainText("2 people");
    await patInAll.uncheck();
    await expect(patInSecond).toBeEnabled();
    await expect(patInSecond).not.toBeChecked();
    await saveGroups.click();
    await expect(unsavedGroups).toHaveCount(0);
    await expect(secondGroupRow).toContainText("1 person");
    await expect(groupRow).toContainText("2 people");

    // Deleting a group asks in the page first. A throwaway group with one
    // member shows the delete keeps that person and their other groups; the
    // roster checks below still see only E2E Group and E2E Second.
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("New group name").fill("E2E Throwaway");
    await page
      .getByRole("button", { name: "Create group", exact: true })
      .click();
    await expect(page.getByText("Created E2E Throwaway.")).toBeVisible();
    const throwawayGroupRow = groupsTable.locator(
      '[data-roster-group="E2E Throwaway"]',
    );
    await page.getByLabel("Select Manual Participant").check();
    await throwawayGroupRow
      .getByRole("button", { name: "Add selected" })
      .click();
    await expect(
      page.getByText("Added 1 person to E2E Throwaway."),
    ).toBeVisible();
    await page.getByLabel("Select Manual Participant").uncheck();
    await throwawayGroupRow
      .getByRole("button", { name: "Delete group" })
      .click();
    const deleteGroupDialog = page.getByRole("dialog", {
      name: "Delete group E2E Throwaway?",
    });
    await expect(deleteGroupDialog).toContainText("People stay on the roster.");
    await expect(
      deleteGroupDialog.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await deleteGroupDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(deleteGroupDialog).toHaveCount(0);
    await expect(throwawayGroupRow).toContainText("1 person");
    await throwawayGroupRow
      .getByRole("button", { name: "Delete group" })
      .click();
    await deleteGroupDialog
      .getByRole("button", { name: "Delete group" })
      .click();
    await expect(page.getByText("Deleted E2E Throwaway.")).toBeVisible();
    await expect(deleteGroupDialog).toHaveCount(0);
    await expect(throwawayGroupRow).toHaveCount(0);
    await expect(page.getByLabel("Select Manual Participant")).toBeVisible();
    await expect(secondGroupRow).toContainText("1 person");
    await expect(groupRow).toContainText("2 people");

    const rosterAfterGroups = await apiJson(
      request,
      "GET",
      `/events/roster?code=${eventCode}`,
      organizerSession.access,
    );
    expect(rosterAfterGroups.response.status()).toBe(200);
    const manualAfterGroups = rosterAfterGroups.payload.participants.find(
      (participant) => participant.email === manualEmail,
    );
    expect(manualAfterGroups.groups.map((group) => group.name)).toEqual([
      "E2E Group",
      "E2E Second",
    ]);
    expect(manualAfterGroups.group).toBe("E2E Group; E2E Second");
    expect(
      rosterAfterGroups.payload.stats.groups.map((group) => [
        group.name,
        group.count,
      ]),
    ).toEqual([
      ["E2E Group", 2],
      ["E2E Second", 1],
    ]);

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
    await openRankedWindows(page);
    await page
      .getByRole("button", { name: "Choose this time" })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Finalize" })).toBeFocused();
    await reviewAttendance(page);
    await expect(page.getByText("Available", { exact: true })).toBeVisible();
    // The count tiles are backed by a per-person breakdown: a header row plus
    // one row for each roster entry.
    const attendanceTable = page
      .locator("#organizer-finalize")
      .getByRole("table", { name: "Attendance by person" });
    await expect(attendanceTable).toBeVisible();
    await expect(
      attendanceTable.getByRole("columnheader", { name: "Person" }),
    ).toBeVisible();
    expect(
      await attendanceTable.getByRole("row").count(),
    ).toBeGreaterThanOrEqual(2);

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
    // Invitation delivery joins the workspace banner with every other run.
    const finalizationDeliveryProgress = page.getByLabel(
      "Event delivery progress",
    );
    await expect(finalizationDeliveryProgress).toContainText(
      "Final confirmation delivery",
    );
    await expect(
      finalizationDeliveryProgress.getByText("2 total"),
    ).toBeVisible();
    dispatchEmailJobs();
    // The card keeps reading its run whatever the event's lifecycle state.
    await expect(finalizationDeliveryProgress.getByText("2 sent")).toBeVisible({
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
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

    // Nothing clears the pick when the meeting is finalized: the rail still
    // marks it, and the Finalize step ignores it until the event is active
    // again. Make sure a live one is selected through the ranked rail before
    // reactivating (the loop below only clicks if none is marked).
    await openRankedWindows(page);
    const rankedRail = page.getByRole("complementary", {
      name: "Ranked windows",
    });
    // The rail re-renders as the ranked windows load, and a click that lands
    // mid-render is dropped on slower engines (WebKit), so the pick is retried
    // until one window reports itself selected.
    const selectedRankedTime = rankedRail.getByRole("button", {
      name: "Selected time",
    });
    await expect
      .poll(
        async () => {
          if ((await selectedRankedTime.count()) === 0) {
            await rankedRail
              .getByRole("button", { name: "Choose this time" })
              .first()
              .click();
          }
          return selectedRankedTime.count();
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
      )
      .toBe(1);

    const cancellationStartedAt = Date.now() - 1000;
    const cancellationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events/lifecycle?code=${eventCode}`),
    );
    await page.getByRole("button", { name: "Reactivate event" }).click();
    const cancellationResponse = await cancellationResponsePromise;
    expect(cancellationResponse.status()).toBe(202);
    // The suite's email worker dispatches queued jobs within half a second and
    // the progress widget re-reads the server after three, so the "queued"
    // state is too short-lived to assert in the UI on a slow browser (WebKit).
    // The response carries the count the workspace renders from.
    expect((await cancellationResponse.json()).cancellationEnqueued).toBe(2);
    await expect(
      page.getByText("This event is active and accepting responses."),
    ).toBeVisible();
    // Reactivating drops the stale pick: the Finalize step asks for a window
    // again instead of still offering the meeting that was just cancelled.
    const finalizeStep = page.locator("#organizer-finalize");
    await expect(finalizeStep).toContainText("No time selected yet");
    await expect(finalizeStep).toContainText(
      "Pick a window on the calendar or choose a ranked one.",
    );
    await expect(finalizeStep).not.toContainText("Ranked #");
    await expect(finalizeStep).not.toContainText("The meeting is finalized");
    await expect(
      rankedRail.getByRole("button", { name: "Selected time" }),
    ).toHaveCount(0);
    const cancellationDeliveryProgress = page.getByLabel(
      "Event delivery progress",
    );
    await expect(cancellationDeliveryProgress).toContainText(
      "Final cancellation delivery",
    );
    await expect(
      cancellationDeliveryProgress.getByText("2 total"),
    ).toBeVisible();
    dispatchEmailJobs();
    await expect(cancellationDeliveryProgress.getByText("2 sent")).toBeVisible({
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    const cancellation = await latestEmailFor(
      participantEmail,
      cancellationStartedAt,
      (body) =>
        body.includes("Scheduling for") && body.includes("METHOD:CANCEL"),
    );
    expect(cancellation).toContain(`UID:${calendarUid}`);
    expect(cancellation).toContain("SEQUENCE:1");

    recomputeEventResults(eventCode);
    await openRankedWindows(page);
    const candidateButtons = page.getByRole("button", {
      name: "Choose this time",
    });
    await expect(candidateButtons.first()).toBeVisible();
    expect(await candidateButtons.count()).toBeGreaterThanOrEqual(3);
    await candidateButtons.nth(2).click();
    // The Finalize step re-keys on a new selection: wait for the new pick to
    // land before driving its buttons.
    await expect(page.getByRole("heading", { name: "Finalize" })).toBeFocused();
    await expect(page.locator("#organizer-finalize")).toContainText(
      "Ranked #3",
    );
    await reviewAttendance(page);
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
    await expect(finalizationDeliveryProgress.getByText("2 sent")).toBeVisible({
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
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
    await expect(
      page.getByText("This event is active and accepting responses."),
    ).toBeVisible();
    const originalCode = new URL(page.url()).searchParams.get("code");
    const organizerSession = await readSession(page);

    const eventDefinition = await apiJson(
      request,
      "GET",
      `/events?code=${originalCode}`,
      organizerSession.access,
    );
    expect(eventDefinition.response.status()).toBe(200);
    // Created with the form's defaults, so participants start Available; the
    // response reset below re-seeds schedules from this setting.
    expect(eventDefinition.payload.event.startingAvailability).toBe(
      "available",
    );

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
    // A reset re-seeds every slot from the event's starting availability:
    // this event starts Available, so the longer schedule is all ones (it was
    // all zeros when every event started Busy).
    expect(
      resetSchedule.payload.schedule.availabilityInperson.every(
        (value) => value === 1,
      ),
    ).toBe(true);
    expect(
      resetSchedule.payload.schedule.availabilityVirtual.every(
        (value) => value === 1,
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
    // Archiving moves the card out of the active list into its own section:
    // the copy is the only active event left.
    await expect(
      page.getByRole("heading", { name: "My Events (1)", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Archived (1)", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: /Archived \(1\)/ })
        .getByRole("link", { name: updatedName, exact: true }),
    ).toBeVisible();

    await copyCard.getByRole("button", { name: "Delete" }).click();
    const deleteButton = page.getByRole("button", {
      name: "Delete event permanently",
    });
    await expect(deleteButton).toBeDisabled();
    // A wrong code explains itself inline rather than only leaving the
    // button disabled.
    const confirmationInput = page.getByLabel("Event code confirmation");
    const confirmationError = page.getByText(
      "Type the event code exactly to confirm deletion",
    );
    await confirmationInput.fill("WRONG");
    await expect(confirmationError).toBeVisible();
    await expect(confirmationInput).toHaveAttribute("aria-invalid", "true");
    await expect(deleteButton).toBeDisabled();
    await confirmationInput.fill(copyCode);
    await expect(confirmationError).toBeHidden();
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
    const resetCode = await latestVerificationCode(
      email,
      resetStartedAt,
      "password_reset",
    );
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

    // Password mode proves the password set through /recover works in the UI.
    await page
      .getByRole("button", { name: "Sign in with password instead" })
      .click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(resetPassword);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expectDashboard(page);
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

    // Revoking one device from another only reaches that device on its next
    // client-side route change: its cached access token still looks usable
    // until the workspace asks the API again.
    await page.goto("/settings");
    const otherDevice = page
      .getByRole("listitem")
      .filter({ hasText: "Other device" });
    await expect(otherDevice).toHaveCount(1);
    await otherDevice.getByRole("button", { name: "Revoke" }).click();
    await expect(otherDevice).toHaveCount(0);
    const revokedOtherSession = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      otherFinalSession.access,
    );
    expect(revokedOtherSession.response.status()).toBe(401);
    await otherPage.getByRole("link", { name: "Create New Event" }).click();
    await expect(otherPage).toHaveURL(/\/login\?next=%2Fcreate/);

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
    const deleteCode = await latestVerificationCode(
      email,
      deleteStartedAt,
      "account_delete",
    );
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
