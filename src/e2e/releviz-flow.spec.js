const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  BACKEND_URL,
  PYTHON_BIN,
  ROOT,
  apiJson,
  beforeUnloadIsBlocked,
  datetimeLocalHoursFromNow,
  dispatchEmailJobs,
  emailsSentTo,
  expandAdvancedOptions,
  expectDashboard,
  fillTextbox,
  importRoster,
  latestEmailFor,
  latestVerificationCode,
  loginWithEmailCode,
  nextWeekdayDate,
  openRecommendedTimes,
  readSession,
  recomputeEventResults,
  registerAccount,
  runBackendCommand,
  selectOption,
  temporaryAccessPathFromEmail,
} = require("./helpers/releviz");
const {
  LIVE_SYNC_TIMEOUT_MS,
  addPerson,
  continueToConfirm,
  expectDeliveredAsPreviewed,
  expectToast,
  openAddPanel,
  openPersonPanel,
  participantActions,
  participantRow,
  participantSummary,
  reviewEmail,
  textLine,
} = require("./helpers/participants");
const {
  currentResultsRevision,
  waitForAttendanceReview,
} = require("./helpers/workspace");

// The row's one badge: submitted, or how far its invitation has got.
function responseBadge(row) {
  return row.locator(".participants-table__response");
}

// Picks an option in the Filter popover's single Response group, then closes
// the popover so it cannot cover the list.
async function chooseResponseFilter(page, label) {
  await page
    .locator("#organizer-roster")
    .getByRole("button", { name: /^Filter/ })
    .click();
  await page
    .getByRole("group", { name: "Response", exact: true })
    .getByRole("radio", { name: label, exact: true })
    .click();
  await page.keyboard.press("Escape");
}

// The group menu is a popover that scripts keep anchored to its trigger on
// every scroll. Opening it with the trigger mid-screen keeps the whole menu
// in view, so clicking an item needs no scroll of its own: WebKit reports a
// scroll a frame late, and a click right after one could land where the item
// was. The dialog is then waited for, so a lost click fails here, not later.
async function openGroupsPanel(page) {
  const trigger = page.getByRole("button", { name: "Group: Everyone" });
  await trigger.evaluate((element) =>
    element.scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await trigger.click();
  await page.getByRole("button", { name: "Manage groups…" }).click();
  const panel = page.getByRole("dialog", { name: "Groups", exact: true });
  await expect(panel).toBeVisible();
  return panel;
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

from apps.authn.models import ContactEmail, EmailAuthChallenge
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
    "invitationStatus": invitation.status,
    "invitationOpened": invitation.opened_at is not None,
    "invitationAccepted": invitation.accepted_at is not None,
    "tempAccessChallengeCount": EmailAuthChallenge.objects.filter(
        member=member,
        purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
    ).count(),
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

test.describe("Releviz account and scheduling flow", () => {
  test("imports a roster, reviews and sends its invitation, shares one temporary response, and upgrades it in place", async ({
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

    // The import sheet walks through Source, Columns, Review and Done.
    await participantActions(page)
      .getByRole("button", { name: "Import", exact: true })
      .click();
    const importSheet = page.getByRole("dialog", {
      name: "Import participants",
    });
    await importSheet
      .getByRole("tab", { name: "Paste from a spreadsheet" })
      .click();
    await importSheet
      .getByLabel("Pasted participant rows")
      .fill(
        "name\temail\tgroup\tweight\tincluded\n" +
          `Temporary Taylor\t${temporaryEmail}\tE2E Group\t0.5\ttrue`,
      );
    await importSheet
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(
      importSheet.getByText(
        "Check which column fills each field. We matched them by their headers.",
      ),
    ).toBeVisible();
    await importSheet.getByRole("button", { name: "Preview rows" }).click();
    await expect(importSheet.getByLabel("Email for row 2")).toHaveValue(
      temporaryEmail,
    );
    await expect(importSheet.getByText("Ready", { exact: true })).toBeVisible();
    // An import never emails anyone itself: the Done step hands the people
    // it added to the same review every invitation goes through.
    await expect(
      importSheet.getByLabel(
        "Email invitations to the people this import adds",
      ),
    ).toHaveCount(0);
    await importSheet
      .getByRole("button", { name: "Import 1 person", exact: true })
      .click();
    await expect(
      importSheet.getByText(
        "Imported 1 people: 1 added, 0 updated. No invitations were sent.",
      ),
    ).toBeVisible();
    await expect(
      importSheet.getByRole("button", { name: "Back to participants" }),
    ).toBeVisible();
    await importSheet
      .getByRole("button", { name: "Review and send invitations (1)…" })
      .click();
    await expect(importSheet).toHaveCount(0);
    await expectToast(
      page,
      "Imported 1 people: 1 added, 0 updated. No invitations were sent.",
    );

    // The review shows Taylor's invitation as Taylor gets it, with a
    // stand-in for the private link, and sends nothing on its own.
    const importInviteDialog = page.getByRole("dialog", {
      name: "Send invitations",
    });
    const previewLink = `${new URL(page.url()).origin}/temp-access?code=${eventCode}&invitation=preview`;
    const invitationEnvelope = await reviewEmail(importInviteDialog, {
      summary: ["1 will get an invitation now"],
      to: `Temporary Taylor <${temporaryEmail}>`,
      subject: `Share your availability for ${eventName}`,
      heading: "You're invited",
      link: { name: "Share your availability", href: previewLink },
      notice:
        "This private link is only for you and only grants access to this event. Please do not forward it.",
      text: [
        `Link: ${previewLink}`,
        "Open the link to share your availability. It is private to you and only grants access to this event, so please do not forward it.",
      ],
    });
    // The link alone opens the schedule, so the email promises no code.
    expect(invitationEnvelope.text).not.toMatch(/six-digit|verification code/i);
    await expect(
      importInviteDialog.getByText(
        "Shown for Temporary Taylor. Each person gets their own private link.",
      ),
    ).toBeVisible();
    expect(
      temporaryAccountState({ code: eventCode, email: temporaryEmail }),
    ).toEqual(
      expect.objectContaining({
        invitationJobCount: 0,
        invitationFirstSent: false,
      }),
    );
    // Back leaves the confirmation without sending and returns to Continue.
    await continueToConfirm(
      importInviteDialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    await expect(
      importInviteDialog.getByText(
        `Subject: Share your availability for ${eventName} · 1 recipient`,
      ),
    ).toBeVisible();
    await importInviteDialog.getByRole("button", { name: "Back" }).click();
    await expect(
      importInviteDialog.getByRole("button", { name: "Continue" }),
    ).toBeFocused();
    const sendImportInvitation = await continueToConfirm(
      importInviteDialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    const invitationStartedAt = Date.now() - 1000;
    await sendImportInvitation.click();
    await expect(importInviteDialog).toHaveCount(0);
    await expectToast(page, "Queued 1 invitation.");
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
    await expect(participantCard).toContainText(temporaryEmail);
    await expect(participantCard).toContainText("Weight 0.5");
    // How the row is answered is explained in the person panel.
    const taylorPanel = await openPersonPanel(page, "Temporary Taylor");
    await expect(
      taylorPanel.getByText(
        "Invited by email. Signs in with their link, no account.",
      ),
    ).toBeVisible();
    await taylorPanel.getByRole("button", { name: "Cancel" }).click();
    await expect(taylorPanel).toHaveCount(0);

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
    // Taylor got the email the review showed, with a real private link in
    // place of the preview's stand-in.
    expectDeliveredAsPreviewed(
      invitationEmail,
      invitationEnvelope,
      temporaryEmail,
    );
    expect(invitationEmail).not.toContain("invitation=preview");
    expect(invitationEmail).toContain(
      "It is private to you and only grants access to this event, so please do not forward it.",
    );
    expect(invitationEmail).not.toMatch(/six-digit|verification code/i);
    await expect(eventDeliveryProgress.getByText("1 sent")).toBeVisible({
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(responseBadge(participantCard)).toHaveText("Invited", {
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

    // A link that matches no invitation opens nothing, and says so without
    // hinting at why: an unknown token and, further down, a link whose person
    // has since upgraded look the same.
    const strangerContext = await browser.newContext();
    const strangerPage = await strangerContext.newPage();
    await strangerPage.goto(
      `/temp-access?code=${eventCode}&invitation=${crypto.randomUUID()}`,
    );
    await expect(
      strangerPage.getByRole("heading", {
        name: "This invitation link isn't active",
      }),
    ).toBeVisible();
    await expect(
      strangerPage.getByText(
        "It may have been replaced by a newer invitation, or the organizer changed the address it was sent to.",
      ),
    ).toBeVisible();
    await expect(
      strangerPage.getByRole("heading", { name: eventName }),
    ).toHaveCount(0);
    await strangerContext.close();

    // The emailed link is the credential: opening it lands straight on
    // Taylor's schedule, with no code to type and no second email.
    const temporaryContext = await browser.newContext();
    const temporaryPage = await temporaryContext.newPage();
    // The first attempt to open the link fails on the way. The page keeps the
    // link and offers to try again, and the retry opens the schedule.
    let failNextOpen = true;
    await temporaryPage.route("**/events/temp-access/open", async (route) => {
      if (failNextOpen) {
        failNextOpen = false;
        await route.fulfill({ status: 503, json: {} });
        return;
      }
      await route.continue();
    });
    const openedAt = Date.now();
    await temporaryPage.goto(accessPath);
    await expect(
      temporaryPage.getByText(
        "We could not open your invitation. Check your connection and try again.",
      ),
    ).toBeVisible();
    await expect(temporaryPage.getByLabel("Verification code")).toHaveCount(0);
    await temporaryPage.getByRole("button", { name: "Try again" }).click();
    await expect(
      temporaryPage.getByRole("heading", { name: eventName }),
    ).toBeVisible();
    await expect(
      temporaryPage.getByText("You are responding as Temporary Taylor"),
    ).toBeVisible();
    await expect(temporaryPage.getByLabel("Verification code")).toHaveCount(0);
    await expect(
      temporaryPage.getByRole("heading", { name: "Check your email" }),
    ).toHaveCount(0);
    await expect(temporaryPage).toHaveURL(
      new RegExp(`/temp-access\\?code=${eventCode}$`),
    );
    expect(await emailsSentTo(temporaryEmail, openedAt)).toEqual([]);
    // Opening records that the link was opened. It is not accepting the
    // invitation: that waits for Taylor's own first save or submit.
    const openedState = temporaryAccountState({
      code: eventCode,
      email: temporaryEmail,
    });
    expect(openedState).toEqual(
      expect.objectContaining({
        invitationStatus: "opened",
        invitationOpened: true,
        invitationAccepted: false,
        tempAccessChallengeCount: 0,
        tempSessionCount: 1,
      }),
    );
    // The organizer's row does not move on to Started for an opened link.
    await expect(responseBadge(participantCard)).toHaveText("Invited");

    // Opening the same link again in the same browser lands on the schedule
    // again, still with no code, and keeps the session it has.
    await temporaryPage.goto(accessPath);
    await expect(
      temporaryPage.getByRole("heading", { name: eventName }),
    ).toBeVisible();
    await expect(
      temporaryPage.getByText("You are responding as Temporary Taylor"),
    ).toBeVisible();
    await expect(temporaryPage.getByLabel("Verification code")).toHaveCount(0);
    expect(await emailsSentTo(temporaryEmail, openedAt)).toEqual([]);
    expect(
      temporaryAccountState({ code: eventCode, email: temporaryEmail }),
    ).toEqual(
      expect.objectContaining({
        tempSessionCount: 1,
        activeTempSessionCount: 1,
      }),
    );

    await expect(participantSummary(page)).toContainText("0 submitted");
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
    await expect(participantSummary(page)).toContainText("1 submitted", {
      timeout: 20_000,
    });
    await expect(responseBadge(participantCard)).toHaveText("Submitted");
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
        // Taylor's own first save is what accepted the invitation, and no
        // emailed code was ever issued along the way.
        invitationStatus: "submitted",
        invitationAccepted: true,
        tempAccessChallengeCount: 0,
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

    // The response was submitted on Taylor's behalf, so saving it as a draft
    // asks first; the save itself is refused because the response is now
    // Taylor's own, which closes the editor.
    await organizerDrawer.getByRole("button", { name: "Save draft" }).click();
    const draftDialog = page.getByRole("dialog", { name: "Save as a draft?" });
    await expect(draftDialog).toContainText(
      "This takes Temporary Taylor's answers out of the results until you submit again.",
    );
    await draftDialog.getByRole("button", { name: "Save as draft" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectToast(page, /now manages their own response/);
    const fullAccessCard = page.locator(
      `[data-roster-participant-id="${managedParticipant.id}"]`,
    );
    await expect(fullAccessCard.getByText("Answers themselves")).toBeVisible();
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

    // Taylor answers with the account now, so the old private link opens
    // nothing, and says no more than any other link that matches nothing.
    const oldLinkPage = await temporaryContext.newPage();
    await oldLinkPage.goto(accessPath);
    await expect(
      oldLinkPage.getByRole("heading", {
        name: "This invitation link isn't active",
      }),
    ).toBeVisible();
    await expect(
      oldLinkPage.getByRole("heading", { name: eventName }),
    ).toHaveCount(0);
    await oldLinkPage.close();

    // Add and send invitation adds the person without emailing them and
    // opens the invitation review above the panel. Closing the review
    // leaves them added and uninvited, with Send invitation on the result.
    const addedEmail = `added-${runId}@example.com`;
    const addPanel = await openAddPanel(page);
    await addPanel
      .getByRole("textbox", { name: "Full name" })
      .fill("Added Avery");
    await addPanel.getByRole("textbox", { name: "Email" }).fill(addedEmail);
    await addPanel
      .getByRole("button", { name: "Add and send invitation" })
      .click();
    const addInviteDialog = page.getByRole("dialog", {
      name: "Send invitations",
    });
    await reviewEmail(addInviteDialog, {
      summary: ["1 will get an invitation now"],
      to: `Added Avery <${addedEmail}>`,
      subject: `Share your availability for ${eventName}`,
      heading: "You're invited",
    });
    await addInviteDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(addInviteDialog).toHaveCount(0);
    await expect(
      addPanel.getByText("Added Avery was added. No invitation was sent."),
    ).toBeVisible();
    await expect(
      addPanel.getByRole("button", { name: "Send invitation", exact: true }),
    ).toBeVisible();
    await addPanel.getByRole("button", { name: "Done" }).click();
    await expect(addPanel).toHaveCount(0);
    // Adding someone never selects them, so a later Send invitation cannot
    // quietly include a person who was added without one.
    await expect(
      page.getByRole("region", { name: "Selected people" }),
    ).toHaveCount(0);
    // The list keeps saying that person has not been emailed, for as long
    // as that is true.
    const notInvitedBanner = page
      .getByRole("status")
      .filter({ hasText: /been invited yet/ });
    await expect(notInvitedBanner).toContainText(
      "1 person hasn't been invited yet. Nobody is emailed until you send invitations.",
    );

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
    await expect(responseBadge(addedCard)).toHaveText("Not invited");
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

    // Selecting the row brings up the selection bar; sending reviews who
    // gets an email, and the email itself, before a second confirmation.
    await addedCard.getByLabel("Select Added Avery").check();
    const selectionBar = page.getByRole("region", { name: "Selected people" });
    await expect(selectionBar).toContainText("1 selected");
    await selectionBar
      .getByRole("button", { name: "Send invitation…" })
      .click();
    const sendDialog = page.getByRole("dialog", { name: "Send invitations" });
    await reviewEmail(sendDialog, {
      summary: ["1 will get an invitation now"],
      to: `Added Avery <${addedEmail}>`,
      subject: `Share your availability for ${eventName}`,
      heading: "You're invited",
    });
    const sendAveryInvitation = await continueToConfirm(
      sendDialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    await sendAveryInvitation.click();
    await expect(sendDialog).toHaveCount(0);
    await expectToast(page, "Queued 1 invitation.");
    await expect(selectionBar).toHaveCount(0);
    await expect(eventDeliveryProgress).toBeVisible();
    await expect(notInvitedBanner).toHaveCount(0);

    dispatchEmailJobs();
    // Delivery moves the invitation, which the live sync picks up as a
    // roster change.
    await expect(responseBadge(addedCard)).toHaveText("Invited", {
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
    const addPanel = await openAddPanel(page);
    await addPanel
      .getByRole("textbox", { name: "Full name" })
      .fill(managedName);
    await addPanel.getByRole("textbox", { name: "Phone" }).fill(managedPhone);
    await addPanel
      .getByRole("checkbox", {
        name: "They have no email. I'll enter their schedule.",
      })
      .check();
    await expect(
      addPanel.getByText(
        "Blank = filed under your account email. They are never emailed.",
      ),
    ).toBeVisible();
    // With no email there is nobody to invite, so that action goes away.
    await expect(
      addPanel.getByRole("button", { name: "Add and send invitation" }),
    ).toHaveCount(0);
    await addPanel.getByRole("button", { name: "Add", exact: true }).click();
    await expect(addPanel.getByText(`${managedName} was added.`)).toBeVisible();
    await expect(
      addPanel.getByRole("button", { name: "Enter their schedule" }),
    ).toBeVisible();
    await addPanel.getByRole("button", { name: "Done" }).click();
    await expect(addPanel).toHaveCount(0);

    const managedRow = participantRow(page, managedName);
    await expect(managedRow).toContainText(
      "No email · you enter their schedule",
    );
    await expect(managedRow).not.toContainText(organizerEmail);
    // One Response column carries the whole person; there is no separate
    // Invitation column, and nobody is invited here.
    const rosterTable = page.locator("table.participants-table");
    await expect(
      rosterTable.getByRole("columnheader", { name: "Response", exact: true }),
    ).toHaveCount(1);
    await expect(
      rosterTable.getByRole("columnheader", { name: "Invitation" }),
    ).toHaveCount(0);
    await expect(responseBadge(managedRow)).toHaveText("Not submitted");
    await expect(
      managedRow.getByRole("button", { name: "Edit schedule" }),
    ).toBeVisible();
    // The phone is kept but never shown on the row; the person panel has it.
    const managedPanel = await openPersonPanel(page, managedName);
    await expect(
      managedPanel.getByText(
        "No email of their own. You enter their schedule.",
      ),
    ).toBeVisible();
    await expect(
      managedPanel.getByRole("textbox", { name: "Phone" }),
    ).toHaveValue(managedPhone);
    await expect(
      managedPanel.getByRole("textbox", { name: "Email" }),
    ).toHaveAttribute("placeholder", "Add their email to invite them");
    await managedPanel.getByRole("button", { name: "Cancel" }).click();
    await expect(managedPanel).toHaveCount(0);

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
    const samRow = participantRow(page, "Sam No Email");
    await expect(samRow).toContainText("No email", { timeout: 20_000 });
    await expect(responseBadge(samRow)).toHaveText("Not submitted");
    await expect(samRow.locator(".participants-table__groups")).toHaveText(
      "Every group",
    );
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

    const addPanel = await openAddPanel(page);
    await addPerson(addPanel, participantName, participantEmail);
    const fullRow = participantRow(page, participantName);
    await expect(fullRow).toContainText(participantEmail);
    await expect(responseBadge(fullRow)).toHaveText("Not invited");
    // The result's Open link goes to the person panel, which says how the
    // row is answered and opens the schedule editor from there.
    await addPanel.getByRole("button", { name: "Open", exact: true }).click();
    await expect(addPanel).toHaveCount(0);
    const fullPanel = page.getByRole("dialog", {
      name: participantName,
      exact: true,
    });
    await expect(fullPanel).toBeVisible();
    await expect(
      fullPanel.getByText(
        "Has a Releviz account. You can enter their schedule until they answer themselves.",
      ),
    ).toBeVisible();
    await fullPanel.getByRole("button", { name: "Edit schedule" }).click();
    await expect(fullPanel).toHaveCount(0);
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

    // Entering the response is not an acceptance: the invitation stays
    // not sent and the organizer keeps the right to edit it. The row itself
    // reads Submitted, which outranks every invitation stage.
    await expect(responseBadge(fullRow)).toHaveText("Submitted");
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

    // The response was submitted on Fiona's behalf, so saving it as a draft
    // asks first; the save itself is refused because the response is hers.
    await organizerDrawer.getByRole("button", { name: "Save draft" }).click();
    const draftDialog = page.getByRole("dialog", { name: "Save as a draft?" });
    await draftDialog.getByRole("button", { name: "Save as draft" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectToast(
      page,
      `${participantName} now manages their own response, so you can no longer edit their schedule.`,
    );

    await expect(fullRow.getByText("Answers themselves")).toBeVisible({
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

    // The add panel stays open between people, so a list is entered in one
    // go. Add and send invitation reviews the new person's invitation first
    // and only sends it once that is confirmed.
    const benEmail = `ben-${runId}@example.com`;
    const addPanel = await openAddPanel(page);
    await addPerson(addPanel, "Ada Typo", typoEmail);
    await addPanel
      .getByRole("textbox", { name: "Full name" })
      .fill("Ben Leaving");
    await addPanel.getByRole("textbox", { name: "Email" }).fill(benEmail);
    await addPanel
      .getByRole("button", { name: "Add and send invitation" })
      .click();
    const benInviteDialog = page.getByRole("dialog", {
      name: "Send invitations",
    });
    await reviewEmail(benInviteDialog, {
      summary: ["1 will get an invitation now"],
      to: `Ben Leaving <${benEmail}>`,
      subject: `Share your availability for Roster corrections ${runId}`,
      heading: "You're invited",
    });
    const sendBenInvitation = await continueToConfirm(
      benInviteDialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    await sendBenInvitation.click();
    await expect(benInviteDialog).toHaveCount(0);
    await expect(
      addPanel.getByText(
        "Ben Leaving was added and their invitation is queued.",
      ),
    ).toBeVisible();
    await expectToast(page, "Queued 1 invitation.");

    // The organizer answers too, under their own account, and is never
    // invited: their row opens straight in the schedule editor.
    await addPanel.getByRole("button", { name: "Add myself" }).click();
    const ownDrawer = page.getByRole("dialog", { name: "Edit my schedule" });
    await expect(ownDrawer).toBeVisible();
    await expect(addPanel).toHaveCount(0);
    await expectToast(page, "You're on the list. Your schedule is open.");
    await expect(ownDrawer.getByText("Your own response")).toBeVisible();
    await ownDrawer
      .getByRole("button", { name: "Submit", exact: true })
      .click();
    await expect(ownDrawer.getByText("Schedule submitted.")).toBeVisible();
    // Once a save has landed the footer offers Close instead of Cancel.
    await expect(
      ownDrawer.getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveCount(0);
    await ownDrawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(ownDrawer).toHaveCount(0);
    const ownRow = participantRow(page, "Owen Organizer");
    await expect(ownRow).toContainText("Owen Organizer (you)");
    await expect(ownRow).toContainText("From your account");
    await expect(responseBadge(ownRow)).toHaveText("Submitted", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(
      ownRow.getByRole("button", { name: "Edit my schedule" }),
    ).toBeVisible();
    // Already on the list, the organizer is not offered Add myself again.
    const reopenedAddPanel = await openAddPanel(page);
    await expect(
      reopenedAddPanel.getByRole("button", { name: "Add myself" }),
    ).toHaveCount(0);
    await reopenedAddPanel.getByRole("button", { name: "Done" }).click();
    await expect(reopenedAddPanel).toHaveCount(0);

    // A mistyped address is fixed in the person panel; the row keeps its
    // name and the new address starts uninvited.
    const adaPanel = await openPersonPanel(page, "Ada Typo");
    await adaPanel.getByRole("textbox", { name: "Email" }).fill(fixedEmail);
    await adaPanel.getByRole("button", { name: "Save", exact: true }).click();
    await expectToast(page, "Saved. The new address hasn't been invited yet.");
    await adaPanel.getByRole("button", { name: "Cancel" }).click();
    await expect(adaPanel).toHaveCount(0);
    const adaRow = participantRow(page, "Ada Typo");
    await expect(adaRow).toContainText(fixedEmail);
    await expect(responseBadge(adaRow)).toHaveText("Not invited");

    // The Filter popover has one Response group, and choosing an option
    // leaves one Response chip. Ben's queued invitation counts as not sent
    // until it is delivered, so wait for it to land first.
    dispatchEmailJobs();
    const benRow = participantRow(page, "Ben Leaving");
    await expect(responseBadge(benRow)).toHaveText("Invited", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    const filterButton = page
      .locator("#organizer-roster")
      .getByRole("button", { name: /^Filter/ });
    await filterButton.click();
    const responseGroup = page.getByRole("group", {
      name: "Response",
      exact: true,
    });
    await expect(responseGroup.locator("label")).toHaveText([
      "Any",
      "Submitted",
      "Not submitted",
      "Not invited yet",
      "Sending invite",
      "Invite failed",
      "Invited",
      "Started",
    ]);
    await expect(
      page.getByRole("group", { name: "Invitation", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    await chooseResponseFilter(page, "Not invited yet");
    await expect(participantSummary(page)).toContainText(
      "Showing 1 of 3 people",
    );
    await expect(adaRow).toBeVisible();
    await expect(benRow).toHaveCount(0);
    await expect(ownRow).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Remove filter Response: Not invited yet",
      }),
    ).toBeVisible();
    // The pair of API filters behind the option is one active filter.
    await expect(filterButton).toContainText("1 active");

    await chooseResponseFilter(page, "Invited");
    await expect(participantSummary(page)).toContainText(
      "Showing 1 of 3 people",
    );
    await expect(benRow).toBeVisible();
    await expect(adaRow).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Remove filter Response:/ }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Remove filter Response: Invited" }),
    ).toBeVisible();

    await chooseResponseFilter(page, "Submitted");
    await expect(participantSummary(page)).toContainText(
      "Showing 1 of 3 people",
    );
    await expect(ownRow).toBeVisible();
    await expect(benRow).toHaveCount(0);

    // Not submitted is everyone who has not submitted, invited or not.
    await chooseResponseFilter(page, "Not submitted");
    await expect(participantSummary(page)).toContainText(
      "Showing 2 of 3 people",
    );
    await expect(adaRow).toBeVisible();
    await expect(benRow).toBeVisible();
    await expect(ownRow).toHaveCount(0);

    // The chip clears both API filters behind the option at once.
    await page
      .getByRole("button", { name: "Remove filter Response: Not submitted" })
      .click();
    await expect(participantSummary(page)).toContainText("3 people");
    await expect(participantSummary(page)).not.toContainText("Showing");
    await expect(
      page.getByRole("button", { name: /^Remove filter Response:/ }),
    ).toHaveCount(0);
    await expect(ownRow).toBeVisible();

    // A group is created from the Group filter, and one selected person is
    // put in it through the selection bar's picker.
    await page.getByRole("button", { name: "Group: Everyone" }).click();
    await page.getByRole("button", { name: "+ New group" }).click();
    const newGroupDialog = page.getByRole("dialog", { name: "New group" });
    await newGroupDialog
      .getByRole("textbox", { name: "Group name" })
      .fill("Team A");
    await newGroupDialog.getByRole("button", { name: "Create" }).click();
    await expect(newGroupDialog).toHaveCount(0);
    await expectToast(page, "Created group Team A.");
    await adaRow.getByLabel("Select Ada Typo").check();
    const selectionBar = page.getByRole("region", { name: "Selected people" });
    await expect(selectionBar).toContainText("1 selected");
    await selectionBar.getByRole("button", { name: "Groups…" }).click();
    const adaPicker = page.getByRole("dialog", {
      name: "Groups for 1 selected people",
    });
    await adaPicker.getByRole("checkbox", { name: "Team A" }).check();
    await adaPicker.getByRole("button", { name: "Apply" }).click();
    await expect(adaPicker).toHaveCount(0);
    await expectToast(page, "Updated groups for 1 person.");
    await expect(adaRow.locator(".participants-table__groups")).toHaveText(
      "Team A",
    );
    await selectionBar.getByRole("button", { name: "Clear" }).click();
    await expect(selectionBar).toHaveCount(0);

    // The Group filter narrows the list to that group; the chip clears it.
    await page.getByRole("button", { name: "Group: Everyone" }).click();
    await page.getByRole("radio", { name: "Team A" }).click();
    await expect(participantSummary(page)).toContainText(
      "Showing 1 of 3 people",
    );
    await expect(participantRow(page, "Ben Leaving")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove filter Group: Team A" }),
    ).toBeVisible();
    await page
      .locator("#organizer-roster")
      .getByRole("button", { name: "Clear all" })
      .click();
    await expect(participantSummary(page)).toContainText("3 people");
    await expect(participantRow(page, "Ben Leaving")).toBeVisible();

    // One group alone counts in the results; the banner brings everyone
    // back.
    const groupsPanel = await openGroupsPanel(page);
    const teamRow = groupsPanel.locator("tr", { hasText: "Team A" });
    await expect(teamRow).toContainText("1 person");
    await teamRow.getByRole("button", { name: "Actions for Team A" }).click();
    await page
      .getByRole("menuitem", { name: "Count only this group…" })
      .click();
    const countOnlyDialog = page.getByRole("dialog", {
      name: "Count only Team A in the results?",
    });
    await expect(countOnlyDialog).toContainText(
      "2 people outside Team A will be left out. Weights don't change.",
    );
    await countOnlyDialog
      .getByRole("button", { name: "Count only this group" })
      .click();
    await expect(countOnlyDialog).toHaveCount(0);
    await expectToast(page, "Only Team A counts in the results now.");
    await expect(
      teamRow.locator(".participants-groups-table__counted"),
    ).toContainText("All");
    await groupsPanel
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(groupsPanel).toHaveCount(0);
    await expect(adaRow).not.toContainText("Left out of results");
    await expect(participantRow(page, "Ben Leaving")).toContainText(
      "Left out of results",
    );
    await expect(ownRow).toContainText("Left out of results");
    const leftOutBanner = page.getByText(
      "2 people are left out of the results.",
    );
    await expect(leftOutBanner).toBeVisible();
    await page.getByRole("button", { name: "Count everyone again" }).click();
    await expectToast(page, "Everyone counts in the results again.");
    await expect(leftOutBanner).toHaveCount(0);
    await expect(participantRow(page, "Ben Leaving")).not.toContainText(
      "Left out of results",
    );
    await expect(ownRow).not.toContainText("Left out of results");

    // Removing asks first, then deletes the row and its invitation.
    await participantRow(page, "Ben Leaving")
      .getByRole("button", { name: "Actions for Ben Leaving" })
      .click();
    await page.getByRole("menuitem", { name: "Remove from event…" }).click();
    const removeDialog = page.getByRole("dialog", {
      name: "Remove Ben Leaving from the event?",
    });
    await expect(
      removeDialog.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await removeDialog.getByRole("button", { name: "Remove person" }).click();
    await expectToast(page, "Ben Leaving was removed from the event.");
    await expect(participantRow(page, "Ben Leaving")).toHaveCount(0);

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
    // The deadline is a main setting: filling it needs no Advanced options.
    await page
      .getByLabel("Response Deadline")
      .fill(datetimeLocalHoursFromNow(48));
    // Reminders are counted back from it and stay folded away until asked for.
    await expandAdvancedOptions(page);
    await expect(
      page.getByLabel("Reminder Hours Before Deadline"),
    ).toBeVisible();
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

    // Groups can be set up before anyone is on the list, from the empty
    // state's link into the Groups panel. This one is deleted again straight
    // away so the group checks further down still see only the groups the
    // import and the organizer create later.
    await expect(
      page.getByRole("heading", { name: "No participants yet" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create a group" }).click();
    const groupsPanel = page.getByRole("dialog", {
      name: "Groups",
      exact: true,
    });
    await expect(groupsPanel.getByText(/No groups yet/)).toBeVisible();
    await groupsPanel.getByRole("button", { name: "+ New group" }).click();
    await groupsPanel.getByLabel("New group name").fill("E2E Early");
    await groupsPanel
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await expectToast(page, "Created group E2E Early.");
    const earlyGroupRow = groupsPanel.locator("tr", { hasText: "E2E Early" });
    await expect(earlyGroupRow).toContainText("0 people");
    await earlyGroupRow
      .getByRole("button", { name: "Actions for E2E Early" })
      .click();
    await page.getByRole("menuitem", { name: "Delete group…" }).click();
    const earlyGroupDialog = page.getByRole("dialog", {
      name: "Delete group E2E Early?",
    });
    await earlyGroupDialog
      .getByRole("button", { name: "Delete group" })
      .click();
    await expectToast(page, "Deleted E2E Early.");
    await expect(earlyGroupDialog).toHaveCount(0);
    await expect(earlyGroupRow).toHaveCount(0);
    await expect(groupsPanel.getByText(/No groups yet/)).toBeVisible();
    await groupsPanel
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(groupsPanel).toHaveCount(0);

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
    expect(await beforeUnloadIsBlocked(participantPage)).toBe(false);
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
    expect(await beforeUnloadIsBlocked(participantPage)).toBe(true);
    const retriedAutosaveResponse = participantPage.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        updateRoutePattern.test(response.url()) &&
        response.ok(),
    );
    await participantPage.getByRole("button", { name: "Retry save" }).click();
    await retriedAutosaveResponse;
    await expect(savedStatus).toBeVisible();
    expect(await beforeUnloadIsBlocked(participantPage)).toBe(false);
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
    expect(await beforeUnloadIsBlocked(participantPage)).toBe(true);
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
    expect(await beforeUnloadIsBlocked(participantPage)).toBe(false);

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

    // Reminders go out from the Email menu, which says when the next
    // automatic one is due and counts who would get one now. The review
    // shows the reminder the first of them gets, and a second step confirms.
    await participantActions(page)
      .getByRole("button", { name: "Email", exact: true })
      .click();
    await expect(page.getByRole("menu", { name: "Email" })).toContainText(
      "Next automatic reminder:",
    );
    await page.getByRole("menuitem", { name: "Send reminders (1)…" }).click();
    const reminderDialog = page.getByRole("dialog", {
      name: "Send reminders",
    });
    const reminderPreviewLink = `${new URL(page.url()).origin}/temp-access?code=${eventCode}&invitation=preview`;
    const reminderEnvelope = await reviewEmail(reminderDialog, {
      summary: [
        "1 invited person who hasn't submitted will get a reminder",
        "People never invited, people without an email, and you are skipped.",
      ],
      to: manualEmail,
      subject: `Reminder: share your availability for ${eventName}`,
      attachments: `releviz-${eventCode}-availability.ics`,
      heading: "Availability reminder",
      link: { name: "Share your availability", href: reminderPreviewLink },
      text: ["Reminder:", `Link: ${reminderPreviewLink}`],
    });
    const sendReminder = await continueToConfirm(
      reminderDialog,
      "Remind 1 invited person who hasn't submitted?",
      "Send 1 reminder",
    );
    await expect(reminderDialog).toContainText(
      "Anyone already reminded since the deadline was set isn't emailed again.",
    );
    const reminderStartedAt = Date.now() - 1000;
    await sendReminder.click();
    await expect(reminderDialog).toHaveCount(0);
    await expectToast(page, "Queued 1 reminder.");
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
    expectDeliveredAsPreviewed(reminder, reminderEnvelope, manualEmail);
    expect(reminder).not.toContain("invitation=preview");
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
    const registeredParticipantCard = participantRow(page, participantEmail);
    const manualParticipantCard = participantRow(page, manualEmail);
    await expect(registeredParticipantCard).toContainText(participantEmail);
    // Pat answers with their own account, so the row follows the name they
    // just saved in Settings.
    await expect(registeredParticipantCard).toContainText("Pat Availability");
    await expect(responseBadge(registeredParticipantCard)).toHaveText(
      "Submitted",
    );
    // Manual was emailed and reminded but has not answered.
    await expect(responseBadge(manualParticipantCard)).toHaveText("Invited");

    // A weight for everyone in E2E Group: filter to the group, select the
    // page, and set it from the selection bar.
    await page.getByRole("button", { name: "Group: Everyone" }).click();
    await page.getByRole("radio", { name: "E2E Group" }).click();
    await expect(participantSummary(page)).toContainText(
      "Showing 2 of 2 people",
    );
    await page.getByLabel("Select everyone on this page").check();
    const selectionBar = page.getByRole("region", { name: "Selected people" });
    await expect(selectionBar).toContainText("2 selected");
    await selectionBar.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Set weight…" }).click();
    const weightDialog = page.getByRole("dialog", { name: "Set weight" });
    await weightDialog.getByRole("spinbutton", { name: "Weight" }).fill("0.75");
    await weightDialog.getByRole("button", { name: "Apply" }).click();
    await expect(weightDialog).toHaveCount(0);
    await expectToast(page, "Set weight 0.75 for 2 people.");
    await expect(registeredParticipantCard).toContainText("Weight 0.75");
    await expect(manualParticipantCard).toContainText("Weight 0.75");
    await selectionBar.getByRole("button", { name: "Clear" }).click();
    await expect(selectionBar).toHaveCount(0);
    await page
      .getByRole("button", { name: "Remove filter Group: E2E Group" })
      .click();
    await expect(participantSummary(page)).toContainText("2 people ·");

    // One person's weight is set in their panel.
    const setPatWeight = async (weight) => {
      const patPanel = await openPersonPanel(page, "Pat Availability");
      await patPanel.getByRole("spinbutton", { name: "Weight" }).fill(weight);
      await patPanel.getByRole("button", { name: "Save", exact: true }).click();
      await expectToast(page, "Saved.");
      await patPanel.getByRole("button", { name: "Cancel" }).click();
      await expect(patPanel).toHaveCount(0);
      await expect(registeredParticipantCard).toContainText(`Weight ${weight}`);
    };
    await setPatWeight("0.5");

    // The Groups panel manages a whole group at once: its shared weight is
    // now mixed, and setting it re-applies one weight to every member.
    await openGroupsPanel(page);
    const groupRow = groupsPanel.locator("tr", { hasText: "E2E Group" });
    await expect(groupRow).toContainText("2 people");
    const groupWeight = groupsPanel.getByRole("spinbutton", {
      name: "Weight for E2E Group",
    });
    await expect(groupWeight).toHaveAttribute("placeholder", "mixed");
    await expect(groupWeight).toHaveValue("");
    await groupWeight.fill("0.6");
    await groupWeight.press("Enter");
    await expectToast(page, "Set weight 0.6 for 2 people.");
    await expect(groupWeight).toHaveValue("0.6");
    await expect(groupWeight).not.toHaveAttribute("placeholder", "mixed");
    await groupsPanel
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(groupsPanel).toHaveCount(0);
    await expect(registeredParticipantCard).toContainText("Weight 0.6");
    await setPatWeight("0.5");

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
    await openGroupsPanel(page);
    await groupsPanel.getByRole("button", { name: "+ New group" }).click();
    await groupsPanel.getByLabel("New group name").fill("E2E Second");
    await groupsPanel
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await expectToast(page, "Created group E2E Second.");
    const secondGroupRow = groupsPanel.locator("tr", { hasText: "E2E Second" });
    await expect(secondGroupRow).toContainText("0 people");
    await groupsPanel
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(groupsPanel).toHaveCount(0);
    await page.getByLabel("Select Manual Participant").check();
    await selectionBar.getByRole("button", { name: "Groups…" }).click();
    const manualPicker = page.getByRole("dialog", {
      name: "Groups for 1 selected people",
    });
    await expect(
      manualPicker.getByRole("checkbox", { name: "E2E Group" }),
    ).toBeChecked();
    const manualInSecond = manualPicker.getByRole("checkbox", {
      name: "E2E Second",
    });
    await expect(manualInSecond).not.toBeChecked();
    await manualInSecond.check();
    await manualPicker.getByRole("button", { name: "Apply" }).click();
    await expect(manualPicker).toHaveCount(0);
    await expectToast(page, "Updated groups for 1 person.");
    const manualGroupsCell = manualParticipantCard.locator(
      ".participants-table__groups",
    );
    await expect(manualGroupsCell).toHaveText("E2E Group, E2E Second");
    await page.getByLabel("Select Manual Participant").uncheck();
    await expect(selectionBar).toHaveCount(0);

    // One person's groups are edited in their panel: the picker stages the
    // change and nothing is saved until Save. Every group puts the person in
    // every group, including groups created later.
    const patPanel = await openPersonPanel(page, "Pat Availability");
    const patGroups = patPanel.getByRole("list", { name: "Groups" });
    const patGroupsCell = registeredParticipantCard.locator(
      ".participants-table__groups",
    );
    await expect(patGroups).toHaveText("E2E Group");
    const pickPatGroups = async (change) => {
      await patPanel.getByRole("button", { name: "+ Add to group" }).click();
      const picker = page.getByRole("dialog", {
        name: "Groups for Pat Availability",
      });
      await change(picker);
      await picker.getByRole("button", { name: "Apply" }).click();
      await expect(picker).toHaveCount(0);
    };
    const savePat = async () => {
      await patPanel.getByRole("button", { name: "Save", exact: true }).click();
      await expectToast(page, "Saved.");
    };
    await pickPatGroups((picker) =>
      picker.getByRole("checkbox", { name: "E2E Second" }).check(),
    );
    await expect(patGroups).toContainText("E2E Second");
    // Nothing is saved until the organizer says so.
    await expect(patGroupsCell).toHaveText("E2E Group");
    await savePat();
    await expect(patGroupsCell).toHaveText("E2E Group, E2E Second");
    await pickPatGroups((picker) =>
      picker.getByRole("checkbox", { name: "E2E Second" }).uncheck(),
    );
    await savePat();
    await expect(patGroupsCell).toHaveText("E2E Group");
    const everyGroup = (picker) =>
      picker.getByRole("checkbox", {
        name: "Every group, including groups added later",
      });
    await pickPatGroups(async (picker) => {
      await everyGroup(picker).check();
      await expect(
        picker.getByRole("checkbox", { name: "E2E Second" }),
      ).toBeDisabled();
    });
    await expect(patGroups).toHaveText(
      "Every group, including groups added later",
    );
    await savePat();
    await expect(patGroupsCell).toHaveText("Every group");
    await pickPatGroups((picker) => everyGroup(picker).uncheck());
    await expect(patGroups).toHaveText("E2E Group");
    await savePat();
    await expect(patGroupsCell).toHaveText("E2E Group");
    await patPanel.getByRole("button", { name: "Cancel" }).click();
    await expect(patPanel).toHaveCount(0);

    // A group can also be created from inside the picker, ticked for the
    // selection at once. Deleting a group asks in the page first; a
    // throwaway group with one member shows the delete keeps that person and
    // their other groups, so the checks below still see only E2E Group and
    // E2E Second.
    await page.getByLabel("Select Manual Participant").check();
    await selectionBar.getByRole("button", { name: "Groups…" }).click();
    const throwawayPicker = page.getByRole("dialog", {
      name: "Groups for 1 selected people",
    });
    await throwawayPicker.getByRole("button", { name: "+ New group" }).click();
    await throwawayPicker.getByLabel("New group name").fill("E2E Throwaway");
    await throwawayPicker
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await expectToast(page, "Created group E2E Throwaway.");
    await expect(
      throwawayPicker.getByRole("checkbox", { name: "E2E Throwaway" }),
    ).toBeChecked();
    await throwawayPicker.getByRole("button", { name: "Apply" }).click();
    await expect(throwawayPicker).toHaveCount(0);
    await expectToast(page, "Updated groups for 1 person.");
    await expect(manualGroupsCell).toContainText("E2E Throwaway");
    await page.getByLabel("Select Manual Participant").uncheck();
    await openGroupsPanel(page);
    const throwawayGroupRow = groupsPanel.locator("tr", {
      hasText: "E2E Throwaway",
    });
    await expect(throwawayGroupRow).toContainText("1 person");
    const askToDeleteThrowaway = async () => {
      await throwawayGroupRow
        .getByRole("button", { name: "Actions for E2E Throwaway" })
        .click();
      await page.getByRole("menuitem", { name: "Delete group…" }).click();
    };
    await askToDeleteThrowaway();
    const deleteGroupDialog = page.getByRole("dialog", {
      name: "Delete group E2E Throwaway?",
    });
    await expect(deleteGroupDialog).toContainText(
      "People stay on the participant list.",
    );
    await expect(
      deleteGroupDialog.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await deleteGroupDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(deleteGroupDialog).toHaveCount(0);
    await expect(throwawayGroupRow).toContainText("1 person");
    await askToDeleteThrowaway();
    await deleteGroupDialog
      .getByRole("button", { name: "Delete group" })
      .click();
    await expectToast(page, "Deleted E2E Throwaway.");
    await expect(deleteGroupDialog).toHaveCount(0);
    await expect(throwawayGroupRow).toHaveCount(0);
    await expect(secondGroupRow).toContainText("1 person");
    await expect(groupRow).toContainText("2 people");
    await groupsPanel
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(groupsPanel).toHaveCount(0);
    await expect(manualGroupsCell).toHaveText("E2E Group, E2E Second");
    await expect(page.getByLabel("Select Manual Participant")).toBeVisible();

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
    await expect(
      page.getByRole("heading", { name: "Time Table" }),
    ).toBeVisible();
    await expect(
      page.getByText("Group availability for a 60-minute meeting."),
    ).toBeVisible();
    await expect(page.locator('[data-results-status="fresh"]')).toBeVisible();
    await openRecommendedTimes(page);
    await page
      .getByRole("button", { name: "Choose this time" })
      .first()
      .click();
    // The recommended times sit inside Finalize: the chosen chip keeps focus
    // and the step below it shows the pick.
    await expect(
      page.locator("details.organizer-recommended-times .ranked-chip").first(),
    ).toBeFocused();
    await expect(page.locator(".final-candidate")).toContainText(
      "Recommended #1",
    );
    await waitForAttendanceReview(page);
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

    // Finalizing emails everyone who was invited, so the confirmation is
    // reviewed first (for the time being finalized, with its calendar
    // invitation attached) and then confirmed a second time. Until then the
    // event stays active.
    await page
      .locator("#organizer-finalize")
      .getByRole("button", { name: "Finalize meeting" })
      .click();
    const firstFinalizeDialog = page.getByRole("dialog", {
      name: "Finalize meeting",
    });
    const firstConfirmation = await reviewEmail(firstFinalizeDialog, {
      summary: [
        "2 invited people will receive the confirmation and a calendar invitation.",
      ],
      to: manualEmail,
      subject: `Confirmed: ${eventName}`,
      attachments: `releviz-${eventCode}-final.ics`,
      heading: "Meeting confirmed",
      text: [
        `The final meeting time for ${eventName} is confirmed.`,
        "Timezone: UTC",
        "A calendar invitation is attached.",
      ],
    });
    const finalizeFirst = await continueToConfirm(
      firstFinalizeDialog,
      "Finalize and email 2 people?",
      "Finalize and send 2 emails",
    );
    const beforeFirstFinal = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access,
    );
    expect(beforeFirstFinal.payload.event.status).toBe("active");
    const firstFinalStartedAt = Date.now() - 1000;
    const firstFinalResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events/finalization?code=${eventCode}`),
    );
    await finalizeFirst.click();
    expect((await firstFinalResponsePromise).status()).toBe(202);
    await expect(firstFinalizeDialog).toHaveCount(0);
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
    // The confirmation that went out is the one reviewed, for the same time.
    expectDeliveredAsPreviewed(manualFinal, firstConfirmation, manualEmail);
    const previewedWhen = textLine(firstConfirmation.text, "When: ");
    expect(previewedWhen).toBeTruthy();
    expect(manualFinal).toContain(previewedWhen);

    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download calendar (.ics)" })
      .click();
    const calendarDownload = await downloadPromise;
    expect(calendarDownload.suggestedFilename()).toMatch(/\.ics$/);
    expect(await fs.readFile(await calendarDownload.path(), "utf8")).toContain(
      "METHOD:REQUEST",
    );

    // While the meeting is finalized, picking is locked until the event is
    // reactivated: Finalize offers no lists and the calendar is read-only.
    // (The pick that was finalized is kept, but no longer drawn.)
    const rankedRail = page.locator("details.organizer-recommended-times");
    await expect(rankedRail).toHaveCount(0);
    await expect(page.locator("details#organizer-other-times")).toHaveCount(0);
    await expect(
      page.getByRole("grid", { name: /^Meeting time calendar/ }),
    ).toHaveAttribute("aria-readonly", "true");

    // Reopening a finalized event cancels its meeting and emails everyone
    // the confirmation reached, so the cancellation is reviewed and
    // confirmed first too. Until then the event stays finalized.
    await page.getByRole("button", { name: "Reactivate event" }).click();
    const reopenDialog = page.getByRole("dialog", {
      name: "Reopen scheduling",
    });
    const cancellationEnvelope = await reviewEmail(reopenDialog, {
      summary: [
        "2 people who received the confirmation will be told the meeting is canceled.",
      ],
      to: manualEmail,
      subject: `Scheduling reopened: ${eventName}`,
      attachments: `releviz-${eventCode}-final.ics`,
      heading: "Scheduling reopened",
      text: [
        `Scheduling for ${eventName} has reopened.`,
        "The previously confirmed calendar invitation has been canceled.",
      ],
    });
    const reopenAndSend = await continueToConfirm(
      reopenDialog,
      "Reopen and email 2 people?",
      "Reopen and send 2 emails",
    );
    await expect(reopenDialog).toContainText(
      "The confirmed meeting is canceled and responses open again.",
    );
    const beforeReopen = await apiJson(
      request,
      "GET",
      `/events?code=${eventCode}`,
      organizerSession.access,
    );
    expect(beforeReopen.payload.event.status).toBe("finalized");
    const cancellationStartedAt = Date.now() - 1000;
    const cancellationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events/lifecycle?code=${eventCode}`),
    );
    await reopenAndSend.click();
    const cancellationResponse = await cancellationResponsePromise;
    expect(cancellationResponse.status()).toBe(202);
    await expect(reopenDialog).toHaveCount(0);
    // The suite's email worker dispatches queued jobs within half a second and
    // the progress widget re-reads the server after three, so the "queued"
    // state is too short-lived to assert in the UI on a slow browser (WebKit).
    // The response carries the count the workspace renders from.
    expect((await cancellationResponse.json()).cancellationEnqueued).toBe(2);
    await expect(
      page.getByText("This event is active and accepting responses."),
    ).toBeVisible();
    // Reactivating unlocks picking: the Finalize step asks for a window
    // again instead of still offering the meeting that was just cancelled.
    const finalizeStep = page.locator("#organizer-finalize");
    await expect(finalizeStep).toContainText("No time selected yet");
    await expect(finalizeStep).toContainText(
      "Pick a time on the calendar, or choose a recommended or other time above.",
    );
    // Only the pick area: an open Other times list names recommended ranks.
    await expect(
      finalizeStep.locator(".finalize-block__body"),
    ).not.toContainText("Recommended #");
    await expect(finalizeStep).not.toContainText("The meeting is finalized");
    await expect(finalizeStep).not.toContainText("This meeting is finalized");
    await expect(rankedRail).toHaveCount(1);
    await expect(
      page.getByRole("grid", { name: /^Meeting time calendar/ }),
    ).not.toHaveAttribute("aria-readonly");
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
    const manualCancellation = await latestEmailFor(
      manualEmail,
      cancellationStartedAt,
      (body) =>
        body.includes("Scheduling for") && body.includes("METHOD:CANCEL"),
    );
    expectDeliveredAsPreviewed(
      manualCancellation,
      cancellationEnvelope,
      manualEmail,
    );

    recomputeEventResults(eventCode);
    await openRecommendedTimes(page);
    const candidateButtons = page.getByRole("button", {
      name: "Choose this time",
    });
    await expect(candidateButtons.first()).toBeVisible();
    // The participant's free 09:00–11:00 tiles into two hours; the half-hour
    // shifts in between overlap them, so they are not listed again.
    await expect(candidateButtons).toHaveCount(2);
    await candidateButtons.nth(1).click();
    // The Finalize step re-keys on a new selection: wait for the new pick to
    // land before driving its buttons. The chosen chip keeps focus.
    await expect(
      page.locator("details.organizer-recommended-times .ranked-chip").nth(1),
    ).toBeFocused();
    await expect(page.locator("#organizer-finalize")).toContainText(
      "Recommended #2",
    );
    await waitForAttendanceReview(page);
    // The review follows the new pick: its confirmation is for Recommended #2.
    await page
      .locator("#organizer-finalize")
      .getByRole("button", { name: "Finalize meeting" })
      .click();
    const secondFinalizeDialog = page.getByRole("dialog", {
      name: "Finalize meeting",
    });
    const secondConfirmation = await reviewEmail(secondFinalizeDialog, {
      summary: [
        "2 invited people will receive the confirmation and a calendar invitation.",
      ],
      to: manualEmail,
      subject: `Confirmed: ${eventName}`,
      attachments: `releviz-${eventCode}-final.ics`,
      heading: "Meeting confirmed",
    });
    const reviewedSecondWhen = textLine(secondConfirmation.text, "When: ");
    expect(reviewedSecondWhen).toBeTruthy();
    expect(reviewedSecondWhen).not.toBe(previewedWhen);
    const finalizeSecond = await continueToConfirm(
      secondFinalizeDialog,
      "Finalize and email 2 people?",
      "Finalize and send 2 emails",
    );
    const secondFinalStartedAt = Date.now() - 1000;
    const secondFinalResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events/finalization?code=${eventCode}`),
    );
    await finalizeSecond.click();
    expect((await secondFinalResponsePromise).status()).toBe(202);
    await expect(secondFinalizeDialog).toHaveCount(0);
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
    expect(reconfirmation).toContain(reviewedSecondWhen);

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

  test("sends a passed response deadline straight to the field that fixes it", async ({
    page,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;

    await registerAccount(page, `deadline-${runId}@example.com`, "Dana", "Due");
    await page.getByRole("link", { name: "Create New Event" }).click();
    await fillTextbox(page, "Event Name", `Deadline ${runId}`);
    await selectOption(page, "Event timezone", "UTC");
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const eventCode = new URL(page.url()).searchParams.get("code");
    expect(eventCode).toMatch(/^[A-Z0-9]+$/);

    // The deadline passes while the event is still active. Whole minutes,
    // like the form's own field, so saving other settings stays possible.
    runBackendCommand(
      "shell",
      "-c",
      `from datetime import timedelta
from django.utils import timezone
from apps.scheduling.models import Event
past = timezone.now().replace(second=0, microsecond=0) - timedelta(hours=2)
assert Event.objects.filter(code="${eventCode}").update(response_deadline=past) == 1`,
    );
    await page.reload();

    const lifecycle = page
      .getByRole("status")
      .filter({ hasText: "so people can no longer respond" });
    await expect(lifecycle).toBeVisible();
    await expect(page.locator("#organizer-overview")).toContainText(
      /Deadline .*UTC/,
    );
    const banner = page
      .locator("#organizer-roster")
      .getByRole("status")
      .filter({ hasText: "The response deadline (" });
    await expect(banner).toContainText(/\(.*UTC\) has passed/);

    // Either notice opens the settings with the deadline field ready to type
    // in; the deadline is a main setting, so Advanced options stay folded.
    const deadline = page.getByLabel("Response Deadline");
    await expect(deadline).toHaveCount(0);
    await banner.getByRole("button", { name: "Change deadline" }).click();
    await expect(deadline).toBeFocused();
    await expect(
      page.getByText("Uses the event timezone (UTC)."),
    ).toBeVisible();
    await expect(
      page.locator("details").filter({ hasText: "Advanced options" }),
    ).not.toHaveAttribute("open", "");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(deadline).toHaveCount(0);
    await lifecycle.getByRole("button", { name: "Change deadline" }).click();
    await expect(deadline).toBeFocused();

    await deadline.fill(datetimeLocalHoursFromNow(72));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByText("This event is active and accepting responses."),
    ).toBeVisible();
    await expect(banner).toHaveCount(0);
    await expect(lifecycle).toHaveCount(0);
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

    // Archiving says what it does first, and can be backed out of.
    await updatedCard.getByRole("button", { name: "Archive" }).click();
    const archiveDialog = page.getByRole("dialog", {
      name: "Archive this event?",
    });
    await expect(archiveDialog).toContainText("People can no longer respond.");
    await archiveDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(archiveDialog).toHaveCount(0);
    await expect(updatedCard.getByText("Status: active")).toBeVisible();
    await updatedCard.getByRole("button", { name: "Archive" }).click();
    await archiveDialog.getByRole("button", { name: "Archive event" }).click();
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
