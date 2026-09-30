const { expect, test } = require("@playwright/test");
const {
  apiJson,
  createEvent,
  finalizeViaApi,
  freshResults,
  invitationLinkFromEmail,
  latestEmailFor,
  newAccountContext,
  newRunId,
  ownResponse,
  registerAccountViaApi,
  runDjangoJson,
  runDjangoScript,
  setLifecycleViaApi,
  tempAccessSessionState,
  temporaryAccessPathFromEmail,
} = require("./helpers/releviz");
const {
  LIVE_SYNC_TIMEOUT_MS,
  addPersonApi,
  expectToast,
  freezeLiveSync,
  gotoParticipants,
  invitationEmail,
  openAddPanel,
  openPersonPanel,
  participantActions,
  participantRow,
  participantSummary,
  requestRecorder,
  rosterEntries,
  sendInvitationsApi,
  startOrganizerEvent,
  submitOnBehalf,
  waitForInvitationStatus,
} = require("./helpers/participants");
const {
  eventControls,
  updateRoutePattern,
  wakeLiveSync,
} = require("./helpers/workspace");

// The people on an organizer's list, one at a time: the person panel
// (renames, contact guards, phone, navigation and its unsaved-changes
// guard), version conflicts on rows and in the panel, the add panel's
// validation and refusals, the schedule drawer the organizer fills in for
// people they answer for, removals and their side effects, the read-only
// and past-deadline states, and the organizer-only API guards. Every test
// registers its own organizer and event and asserts only on its own rows,
// recipients and email jobs.

function personEmail(slug, runId) {
  return `${slug}-${runId}@example.com`;
}

// A single-row PATCH from the list or the person panel (never the bulk one).
function isRowPatch(response) {
  return (
    response.request().method() === "PATCH" &&
    /\/events\/roster\/\d+$/.test(new URL(response.url()).pathname)
  );
}

function waitForRowPatch(page) {
  return page.waitForResponse(isRowPatch);
}

function rowPatchRecorder(page) {
  return requestRecorder(
    page,
    (candidate) =>
      candidate.method() === "PATCH" &&
      /\/events\/roster\/\d+/.test(new URL(candidate.url()).pathname),
  );
}

// Organizer-managed people share the organizer's filing address, so the
// listing is keyed by name here.
async function rosterByName(request, eventCode, token) {
  const payload = await rosterEntries(request, eventCode, token);
  return new Map(payload.participants.map((entry) => [entry.name, entry]));
}

// The organizer answers their own event too (the add panel's Add myself).
async function joinAsOrganizer(request, eventCode, token) {
  const joined = await apiJson(
    request,
    "POST",
    `/events/participants?code=${eventCode}`,
    token,
    {},
  );
  expect([200, 201], JSON.stringify(joined.payload)).toContain(
    joined.response.status(),
  );
}

// A full account saves their own answers, which makes the response theirs:
// the organizer can no longer enter it, rename them or move their address.
async function claimOwnResponse(request, eventCode, token) {
  const own = await ownResponse(request, token, eventCode);
  const schedule = [...own.availabilityInperson];
  schedule[0] = schedule[0] === 1 ? 0 : 1;
  const saved = await apiJson(
    request,
    "PUT",
    `/events/participants/update?code=${eventCode}&participantId=${own.id}`,
    token,
    { availabilityInperson: schedule, expectedVersion: own.version },
  );
  expect(saved.response.status(), JSON.stringify(saved.payload)).toBe(200);
}

// Another session's change to one row, straight through the API.
async function patchRowViaApi(request, eventCode, token, entry, changes) {
  const patched = await apiJson(
    request,
    "PATCH",
    `/events/roster/${entry.id}?code=${eventCode}`,
    token,
    { ...changes, expectedVersion: entry.version },
  );
  expect(patched.response.status(), JSON.stringify(patched.payload)).toBe(200);
  return patched.payload.participant;
}

async function chooseRowAction(page, name, action) {
  await participantRow(page, name)
    .getByRole("button", { name: `Actions for ${name}` })
    .click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

// The notice row a version conflict adds under a participant's row.
function conflictNotice(page, name) {
  return page.locator("tr.participants-row__notice", {
    hasText: `${name} was changed in another session`,
  });
}

// The invitation filed for `email` on this event: its link token and whether
// it was ever sent, or null when there is none.
function invitationState(eventCode, email) {
  return runDjangoJson(
    `
from apps.scheduling.models import EventInvitation

invitation = EventInvitation.objects.filter(
    event__code=data["code"], email__iexact=data["email"]
).first()
print(json.dumps(None if invitation is None else {
    "token": str(invitation.access_token),
    "firstSent": invitation.first_sent_at is not None,
}))
`,
    { code: eventCode, email },
  );
}

function invitationTokenExists(token) {
  return runDjangoJson(
    `
from apps.scheduling.models import EventInvitation

print(json.dumps(EventInvitation.objects.filter(access_token=data["token"]).exists()))
`,
    { token },
  );
}

function memberExists(memberId) {
  return runDjangoJson(
    `
from apps.authn.models import Member

print(json.dumps(Member.objects.filter(pk=data["id"]).exists()))
`,
    { id: memberId },
  );
}

// The add panel's POST (the managed-participant endpoint).
function isManagedPost(response) {
  return (
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/events/participants/managed"
  );
}

function waitForManagedPost(page) {
  return page.waitForResponse(isManagedPost);
}

function managedPostRecorder(page) {
  return requestRecorder(
    page,
    (candidate) =>
      candidate.method() === "POST" &&
      new URL(candidate.url()).pathname === "/events/participants/managed",
  );
}

function isScheduleSave(response) {
  return (
    response.request().method() === "PUT" &&
    updateRoutePattern.test(response.url())
  );
}

function scheduleDrawer(page, name) {
  return page.getByRole("dialog", { name: `Edit ${name}'s schedule` });
}

// Clicks a drawer save button and waits for its PUT to succeed.
async function saveDrawer(page, drawer, label) {
  const saved = page.waitForResponse(isScheduleSave);
  await drawer.getByRole("button", { name: label, exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
}

// What the organizer's schedule endpoint holds for a listed person.
async function managedSchedule(request, eventCode, token, entry) {
  const loaded = await apiJson(
    request,
    "GET",
    `/events/roster/${entry.id}/schedule?code=${eventCode}`,
    token,
  );
  expect(loaded.response.status()).toBe(200);
  return loaded.payload.schedule;
}

// Two accounts the add panel must refuse, made directly: one deactivated,
// and one full account whose address was never verified.
function seedAccounts({ inactive, unverified }) {
  runDjangoScript(
    `
from apps.authn.models import ContactEmail, Member

for address, active, verified in (
    (data["inactive"], False, True),
    (data["unverified"], True, False),
):
    member = Member(
        email=address,
        first_name="Seeded",
        last_name="Account",
        is_active=active,
        access_level="full",
    )
    member.set_unusable_password()
    member.save()
    ContactEmail.objects.create(
        member=member, email_address=address, email_type="primary", verified=verified
    )
`,
    { inactive, unverified },
  );
}

// Files as many invitation recipients as the cap allows on this event only.
function fillInvitationCap(eventCode, runId) {
  runDjangoScript(
    `
from django.conf import settings

from apps.scheduling.models import Event, EventInvitation

event = Event.objects.get(code=data["code"])
room = settings.INVITATION_MAX_EVENT_RECIPIENTS - event.invitations.count()
EventInvitation.objects.bulk_create(
    EventInvitation(event=event, email=f"cap-{index}-{data['run']}@example.com")
    for index in range(room)
)
`,
    { code: eventCode, run: runId },
  );
}

function clearInvitationCap(eventCode, runId) {
  runDjangoScript(
    `
from apps.scheduling.models import EventInvitation

EventInvitation.objects.filter(
    event__code=data["code"], email__endswith=f"-{data['run']}@example.com",
    email__startswith="cap-",
).delete()
`,
    { code: eventCode, run: runId },
  );
}

// Fills the event up to the participant cap with people the organizer
// manages (each with the stand-in member such a person has).
function fillParticipantCap(eventCode, runId) {
  runDjangoScript(
    `
from django.conf import settings

from apps.authn.models import Member
from apps.scheduling.models import Event, Participant
from apps.scheduling.services.availability import default_availability

event = Event.objects.get(code=data["code"])
room = settings.EVENT_MAX_PARTICIPANTS - event.participants.count()
members = []
for index in range(room):
    member = Member(
        email="",
        first_name=f"Cap {index} {data['run']}",
        is_active=True,
        access_level="temporary",
    )
    member.set_unusable_password()
    members.append(member)
Member.objects.bulk_create(members)
schedule = default_availability(event)
Participant.objects.bulk_create(
    Participant(
        event=event,
        member=member,
        participant_name=member.first_name,
        organizer_managed=True,
        availability_inperson=schedule,
        availability_virtual=schedule,
    )
    for member in members
)
`,
    { code: eventCode, run: runId },
  );
}

function clearParticipantCap(eventCode, runId) {
  runDjangoScript(
    `
from apps.authn.models import Member

Member.objects.filter(
    first_name__startswith="Cap ",
    first_name__endswith=f" {data['run']}",
    schedule_participations__event__code=data["code"],
).delete()
`,
    { code: eventCode, run: runId },
  );
}

// Opens the row's Remove from event… and returns the confirmation.
async function removeFromRow(page, name) {
  await chooseRowAction(page, name, "Remove from event…");
  const dialog = page.getByRole("dialog", {
    name: `Remove ${name} from the event?`,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function confirmRemoval(page, dialog, status) {
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      /\/events\/roster\/\d+$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole("button", { name: "Remove person" }).click();
  expect((await removed).status()).toBe(status);
  await expect(dialog).toHaveCount(0);
}

async function participatingCodes(request, token) {
  const dashboard = await apiJson(request, "GET", "/dashboard/events", token);
  expect(dashboard.response.status()).toBe(200);
  return dashboard.payload.participating.map((event) => event.code);
}

// Files an email job for a listed person's invitation in a given state: a
// pending one due tomorrow (queued, so the running email worker leaves it
// alone) or one the worker holds right now (processing with a fresh lock,
// which is only reclaimed after 15 minutes).
function queueEmailJob(eventCode, email, { type, status }) {
  return runDjangoJson(
    `
import uuid
from datetime import timedelta

from django.utils import timezone

from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import EventInvitation

invitation = EventInvitation.objects.get(
    event__code=data["code"], email__iexact=data["email"]
)
now = timezone.now()
processing = data["status"] == "processing"
job = EmailDeliveryJob.objects.create(
    idempotency_key=f"e2e-{data['type']}:{uuid.uuid4()}",
    message_type=data["type"],
    recipient=invitation.email,
    subject="Filed by the participants-people spec",
    body="Filed by the participants-people spec",
    message_id=f"<{uuid.uuid4()}@e2e.releviz.local>",
    event=invitation.event,
    invitation=invitation,
    status=data["status"],
    next_attempt_at=now + timedelta(days=1),
    locked_at=now if processing else None,
    lock_token=uuid.uuid4() if processing else None,
)
print(json.dumps(job.pk))
`,
    { code: eventCode, email, type, status },
  );
}

function emailJobState(jobId) {
  return runDjangoJson(
    `
from apps.mail.models import EmailDeliveryJob

job = EmailDeliveryJob.objects.get(pk=data["id"])
print(json.dumps({"status": job.status, "lastError": job.last_error}))
`,
    { id: jobId },
  );
}

function setEmailJobStatus(jobId, status) {
  runDjangoScript(
    `
from apps.mail.models import EmailDeliveryJob

EmailDeliveryJob.objects.filter(pk=data["id"]).update(
    status=data["status"], locked_at=None, lock_token=None
)
`,
    { id: jobId, status },
  );
}

// Moves this event's response deadline an hour into the past while it stays
// active (the API only ever sets a future deadline on an active event).
function passResponseDeadline(eventCode) {
  runDjangoScript(
    `
from datetime import timedelta

from django.utils import timezone

from apps.scheduling.models import Event

Event.objects.filter(code=data["code"]).update(
    response_deadline=timezone.now() - timedelta(hours=1)
)
`,
    { code: eventCode },
  );
}

// The list while it cannot change: Import and + Add person are disabled and
// say why, the Email menu is gone, rows cannot be selected, and a row's
// menu offers only Details.
async function expectListLocked(page, name, lockReason) {
  const actions = participantActions(page);
  for (const label of ["Import", "+ Add person"]) {
    const button = actions.getByRole("button", { name: label, exact: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", lockReason);
  }
  await expect(actions.getByRole("button", { name: "Email" })).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: `Select ${name}` }),
  ).toBeDisabled();
  await participantRow(page, name)
    .getByRole("button", { name: `Actions for ${name}` })
    .click();
  for (const item of [
    "Send invitation",
    "Leave out of results",
    "Remove from event…",
  ]) {
    await expect(
      page.getByRole("menuitem", { name: item, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    page.getByRole("menuitem", { name: "Details", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

// The person panel opens for reading only.
async function expectPanelLocked(panel, name) {
  for (const field of ["Full name", "Email", "Phone"]) {
    await expect(panel.getByRole("textbox", { name: field })).toBeDisabled();
  }
  await expect(
    panel.getByRole("spinbutton", { name: "Weight" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("checkbox", { name: `Count ${name}'s answers` }),
  ).toBeDisabled();
  for (const button of [
    "Save",
    "Remove from event…",
    "Send invitation",
    "+ Add to group",
  ]) {
    await expect(
      panel.getByRole("button", { name: button, exact: true }),
    ).toBeDisabled();
  }
}

// One of each roster write, for checking that a locked event refuses them.
function rosterWrites(eventCode, entry, runId) {
  const q = `?code=${eventCode}`;
  return [
    [
      "PATCH",
      `/events/roster/${entry.id}${q}`,
      { phone: "+1 555 303 0303", expectedVersion: entry.version },
    ],
    ["DELETE", `/events/roster/${entry.id}${q}`, undefined],
    [
      "PATCH",
      `/events/roster/bulk${q}`,
      {
        filter: { all: true },
        updates: { included: false },
        idempotencyKey: crypto.randomUUID(),
      },
    ],
    ["POST", `/events/roster/groups${q}`, { name: "Closed team" }],
    [
      "POST",
      `/events/roster/invitations${q}`,
      { participantIds: [entry.id], preview: true },
    ],
    [
      "POST",
      `/events/participants/managed${q}`,
      {
        name: "Closed Carl",
        email: personEmail("carl", runId),
        sendInvitation: false,
        idempotencyKey: crypto.randomUUID(),
      },
    ],
  ];
}

test.describe("Person panel", () => {
  test("renames a person the organizer answers for and locks names and emails that come from an account", async ({
    page,
    request,
  }) => {
    const { runId, organizerEmail, token, event } = await startOrganizerEvent(
      { page, request },
      "people-names",
    );
    const niaEmail = personEmail("nia", runId);
    const sidEmail = personEmail("sid", runId);
    const noraPhone = "+1 555 010 9999";
    await joinAsOrganizer(request, event.code, token);
    await addPersonApi(request, event.code, token, {
      name: "Nia Named",
      email: niaEmail,
    });
    const sid = await registerAccountViaApi(request, sidEmail, "Sid", "Self");
    await addPersonApi(request, event.code, token, {
      name: "Sid Self",
      email: sidEmail,
    });
    await claimOwnResponse(request, event.code, sid.access);
    await addPersonApi(request, event.code, token, {
      name: "Nora NoEmail",
      phone: noraPhone,
      organizerManaged: true,
    });
    const writes = rowPatchRecorder(page);

    await gotoParticipants(page, event);
    await expect(participantSummary(page)).toContainText("4 people");

    // Someone the organizer still answers for can be renamed, and the panel
    // checks the name and the phone before anything is sent.
    const nia = await openPersonPanel(page, "Nia Named");
    const niaName = nia.getByRole("textbox", { name: "Full name" });
    const niaPhone = nia.getByRole("textbox", { name: "Phone" });
    const niaSave = nia.getByRole("button", { name: "Save", exact: true });
    await expect(niaName).toBeEnabled();
    await expect(niaName).toHaveAttribute("maxlength", "100");
    await expect(niaSave).toBeDisabled();
    await niaName.fill("   ");
    await niaSave.click();
    await expect(nia.getByText("Full name is required.")).toBeVisible();
    await expect(niaName).toHaveAttribute("aria-invalid", "true");
    await niaName.fill("Nia Renamed");
    await expect(nia.getByText("Full name is required.")).toHaveCount(0);
    await expect(niaPhone).toHaveAccessibleDescription(
      "Never used to contact them",
    );
    const phoneMessage = nia.getByText(
      "Enter a phone number with 7 to 32 digits.",
    );
    for (const badPhone of ["12ab 3456 789", "555-01"]) {
      await niaPhone.fill(badPhone);
      // Typing clears the last message, so each one comes from this Save.
      await expect(phoneMessage).toHaveCount(0);
      await niaSave.click();
      await expect(phoneMessage).toBeVisible();
      await expect(niaPhone).toHaveAttribute("aria-invalid", "true");
    }
    expect(writes.entries).toEqual([]);

    await niaPhone.fill("+1 (555) 010-2030");
    const saved = waitForRowPatch(page);
    await niaSave.click();
    expect((await saved).status()).toBe(200);
    await expectToast(page, "Saved.");
    // The panel is named after the person, so it follows the rename.
    const renamedPanel = page.getByRole("dialog", {
      name: "Nia Renamed",
      exact: true,
    });
    await expect(renamedPanel).toBeVisible();
    await expect(
      renamedPanel.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    // A person with an email shows it on their row, then the phone.
    await expect(
      participantRow(page, "Nia Renamed").locator(".participants-row__contact"),
    ).toHaveText(`${niaEmail} · +1 (555) 010-2030`);
    await renamedPanel.getByRole("button", { name: "Cancel" }).click();
    await expect(renamedPanel).toHaveCount(0);
    const renamed = (await rosterByName(request, event.code, token)).get(
      "Nia Renamed",
    );
    expect(renamed).toMatchObject({
      email: niaEmail,
      phone: "+1 (555) 010-2030",
    });

    // Sid answered with his own account: his name and address are his.
    const sidPanel = await openPersonPanel(page, "Sid Self");
    await expect(sidPanel.getByText("Answers themselves")).toBeVisible();
    const sidName = sidPanel.getByRole("textbox", { name: "Full name" });
    await expect(sidName).toBeDisabled();
    await expect(sidName).toHaveAccessibleDescription(
      "They set their own name in their Releviz account.",
    );
    const sidEmailField = sidPanel.getByRole("textbox", { name: "Email" });
    await expect(sidEmailField).toBeDisabled();
    await expect(sidEmailField).toHaveValue(sidEmail);
    await expect(sidEmailField).toHaveAccessibleDescription(
      "Sid Self already signed in, so this address can't change. Remove Sid Self and add them again if it is wrong.",
    );
    await expect(
      sidPanel.getByRole("textbox", { name: "Phone" }),
    ).toBeEnabled();
    await sidPanel.getByRole("button", { name: "Close details" }).click();
    await expect(sidPanel).toHaveCount(0);

    // The organizer's own row takes both from their account settings.
    await participantRow(page, "Rory Roster (you)")
      .getByRole("button", { name: /^Rory Roster/ })
      .click();
    const own = page.getByRole("dialog", {
      name: "Rory Roster (you)",
      exact: true,
    });
    await expect(own).toBeVisible();
    await expect(own.getByText("Your own row.")).toBeVisible();
    await expect(
      own.getByRole("button", { name: "Edit my schedule" }),
    ).toBeVisible();
    const ownName = own.getByRole("textbox", { name: "Full name" });
    const ownEmail = own.getByRole("textbox", { name: "Email" });
    await expect(ownName).toBeDisabled();
    await expect(ownName).toHaveAccessibleDescription(
      "From your account settings",
    );
    await expect(ownEmail).toBeDisabled();
    await expect(ownEmail).toHaveValue(organizerEmail);
    await expect(ownEmail).toHaveAccessibleDescription(
      "From your account settings",
    );
    await page.keyboard.press("Escape");
    await expect(own).toHaveCount(0);

    // A person with no email never shows the phone (or the organizer's
    // filing address) on their row; the panel keeps it and asks for an
    // address of their own.
    const noraRow = participantRow(page, "Nora NoEmail");
    await expect(noraRow.locator(".participants-row__contact")).toHaveText(
      "No email · you enter their schedule",
    );
    await expect(noraRow).not.toContainText(noraPhone);
    await expect(noraRow).not.toContainText(organizerEmail);
    const nora = await openPersonPanel(page, "Nora NoEmail");
    await expect(
      nora.getByRole("textbox", { name: "Full name" }),
    ).toBeEnabled();
    const noraEmail = nora.getByRole("textbox", { name: "Email" });
    await expect(noraEmail).toHaveValue("");
    await expect(noraEmail).toHaveAttribute(
      "placeholder",
      "Add their email to invite them",
    );
    await expect(noraEmail).toHaveAccessibleDescription(
      "They are never emailed until they have an address of their own.",
    );
    await expect(nora.getByRole("textbox", { name: "Phone" })).toHaveValue(
      noraPhone,
    );
    await nora.getByRole("button", { name: "Cancel" }).click();
    await expect(nora).toHaveCount(0);
    expect(writes.entries).toHaveLength(1);

    // The server holds the same line: an address that comes from an account
    // cannot be moved through the API either.
    const listed = await rosterByName(request, event.code, token);
    const lockedAddresses = [
      [
        "Sid Self",
        "This person has already signed in or answered, so their email can no longer be changed. Remove them and add them again if the address is wrong.",
      ],
      ["Rory Roster", "Your own email comes from your account settings."],
    ];
    for (const [name, message] of lockedAddresses) {
      const entry = listed.get(name);
      const refused = await apiJson(
        request,
        "PATCH",
        `/events/roster/${entry.id}?code=${event.code}`,
        token,
        { email: personEmail("moved", runId), expectedVersion: entry.version },
      );
      expect(refused.response.status(), name).toBe(409);
      expect(refused.payload.error, name).toBe(message);
    }
    expect(
      (await rosterByName(request, event.code, token)).get("Sid Self"),
    ).toMatchObject({
      email: sidEmail,
      version: listed.get("Sid Self").version,
    });
  });

  test("refuses email changes the server cannot make and moves people to a new address", async ({
    page,
    request,
  }) => {
    const { runId, organizerEmail, token, event } = await startOrganizerEvent(
      { page, request },
      "people-email",
    );
    const niaEmail = personEmail("nia", runId);
    const niaNewEmail = personEmail("nia-new", runId);
    const wesEmail = personEmail("wes", runId);
    const noraEmail = personEmail("nora", runId);
    await addPersonApi(request, event.code, token, {
      name: "Nia Moving",
      email: niaEmail,
    });
    await addPersonApi(request, event.code, token, {
      name: "Wes Taken",
      email: wesEmail,
    });
    const nora = await addPersonApi(request, event.code, token, {
      name: "Nora Later",
      organizerManaged: true,
    });
    const niaEntry = (await rosterByName(request, event.code, token)).get(
      "Nia Moving",
    );
    await sendInvitationsApi(request, event.code, token, [niaEntry.id]);
    await waitForInvitationStatus(request, event.code, token, niaEmail, "sent");
    const oldInvitation = invitationState(event.code, niaEmail);
    expect(oldInvitation.firstSent).toBe(true);
    // A reminder to the old address is still queued (due tomorrow, so the
    // running email worker leaves it alone).
    const oldReminder = queueEmailJob(event.code, niaEmail, {
      type: "reminder",
      status: "pending",
    });
    const writes = rowPatchRecorder(page);

    await gotoParticipants(page, event);
    const panel = await openPersonPanel(page, "Nia Moving");
    const email = panel.getByRole("textbox", { name: "Email" });
    const save = panel.getByRole("button", { name: "Save", exact: true });
    await expect(email).toBeEnabled();
    await expect(email).toHaveValue(niaEmail);

    // A malformed address never leaves the page.
    await email.fill("bad@");
    await save.click();
    await expect(panel.getByText("Enter a valid email address.")).toBeVisible();
    expect(writes.entries).toEqual([]);

    // The server refuses the organizer's own address and an address that
    // is already on the event; the panel keeps the draft each time.
    const refusals = [
      [
        organizerEmail,
        "That is one of your own addresses. Enter this person's own email, or use Add myself to add yourself as a participant.",
      ],
      [wesEmail, `${wesEmail} is already a participant.`],
    ];
    for (const [address, message] of refusals) {
      await email.fill(address);
      const refused = waitForRowPatch(page);
      await save.click();
      expect((await refused).status()).toBe(409);
      await expect(
        panel.getByRole("alert").filter({ hasText: message }),
      ).toBeVisible();
      await expect(email).toHaveValue(address);
      await expect(panel).toBeVisible();
    }

    // A new address moves Nia: her sent invitation and its link are gone,
    // the reminder queued for the old address is canceled, and a fresh
    // invitation waits unsent for the new address.
    await email.fill(niaNewEmail.toUpperCase());
    const moved = waitForRowPatch(page);
    await save.click();
    expect((await moved).status()).toBe(200);
    const toast = page
      .getByRole("region", { name: "Notifications" })
      .locator(".participants-toast", {
        hasText: "Saved. The new address hasn't been invited yet.",
      });
    await expect(
      toast.getByRole("button", { name: "Send invitation" }),
    ).toBeVisible();
    await expectToast(page, "Saved. The new address hasn't been invited yet.");
    await expect(email).toHaveValue(niaNewEmail);
    await expect(panel.getByText("Not sent", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Cancel" }).click();
    const niaRow = participantRow(page, "Nia Moving");
    await expect(niaRow).toContainText(niaNewEmail);
    await expect(niaRow.locator(".participants-table__response")).toHaveText(
      "Not invited",
    );
    expect(invitationTokenExists(oldInvitation.token)).toBe(false);
    expect(invitationState(event.code, niaNewEmail)).toMatchObject({
      firstSent: false,
    });
    expect(invitationState(event.code, niaEmail)).toBeNull();
    expect(emailJobState(oldReminder)).toEqual({
      status: "canceled",
      lastError: "The person was changed on the event's participant list.",
    });

    // A person with no email gets an address of their own and becomes an
    // ordinary invitable person; the stand-in member made for them is gone.
    const noraPanel = await openPersonPanel(page, "Nora Later");
    await noraPanel.getByRole("textbox", { name: "Email" }).fill(noraEmail);
    const given = waitForRowPatch(page);
    await noraPanel.getByRole("button", { name: "Save", exact: true }).click();
    expect((await given).status()).toBe(200);
    await expectToast(page, "Saved. The new address hasn't been invited yet.");
    await expect(
      noraPanel.getByText(
        "Invited by email. Signs in with their link, no account.",
      ),
    ).toBeVisible();
    await expect(
      noraPanel.getByRole("button", { name: "Send invitation" }),
    ).toBeEnabled();
    await noraPanel.getByRole("button", { name: "Cancel" }).click();
    const noraRow = participantRow(page, "Nora Later");
    await expect(noraRow.locator(".participants-row__contact")).toHaveText(
      noraEmail,
    );
    await expect(noraRow.locator(".participants-table__response")).toHaveText(
      "Not invited",
    );
    const noraEntry = (await rosterByName(request, event.code, token)).get(
      "Nora Later",
    );
    expect(noraEntry).toMatchObject({
      email: noraEmail,
      organizerManaged: false,
      accountAccess: "temporary",
      invitationStatus: "not_sent",
    });
    expect(noraEntry.memberId).not.toBe(nora.participant.id);
    expect(memberExists(nora.participant.id)).toBe(false);
  });

  test("moves between people and asks before discarding unsaved panel edits", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-nav",
    );
    await addPersonApi(request, event.code, token, {
      name: "Ann First",
      email: personEmail("ann", runId),
    });
    await addPersonApi(request, event.code, token, {
      name: "Ben Second",
      email: personEmail("ben", runId),
    });
    await addPersonApi(request, event.code, token, {
      name: "Cal Third",
      organizerManaged: true,
    });
    const writes = rowPatchRecorder(page);

    await gotoParticipants(page, event);
    await expect(participantSummary(page)).toContainText("3 people");
    const discard = page.getByRole("dialog", { name: "Discard your changes?" });

    let panel = await openPersonPanel(page, "Ann First");
    await expect(panel.getByText("1 of 3", { exact: true })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Previous person" }),
    ).toBeDisabled();
    await panel.getByRole("button", { name: "Next person" }).click();
    panel = page.getByRole("dialog", { name: "Ben Second", exact: true });
    await expect(panel.getByText("2 of 3", { exact: true })).toBeVisible();

    // An unsaved change holds every way out of the panel until confirmed.
    const phone = panel.getByRole("textbox", { name: "Phone" });
    await phone.fill("555 0100 200");
    await panel.getByRole("button", { name: "Next person" }).click();
    await expect(discard).toBeVisible();
    await expect(discard).toContainText(
      "Your changes to Ben Second haven't been saved.",
    );
    await expect(
      discard.getByRole("button", { name: "Keep editing" }),
    ).toBeFocused();
    await discard.getByRole("button", { name: "Keep editing" }).click();
    await expect(discard).toHaveCount(0);
    await expect(panel.getByText("2 of 3", { exact: true })).toBeVisible();
    await expect(phone).toHaveValue("555 0100 200");

    // Escape asks too, and a second Escape only closes the question.
    await page.keyboard.press("Escape");
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(discard).toHaveCount(0);
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close details" }).click();
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Keep editing" }).click();

    await panel.getByRole("button", { name: "Previous person" }).click();
    await discard.getByRole("button", { name: "Discard" }).click();
    panel = page.getByRole("dialog", { name: "Ann First", exact: true });
    await expect(panel.getByText("1 of 3", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Next person" }).click();
    panel = page.getByRole("dialog", { name: "Ben Second", exact: true });
    await expect(panel.getByRole("textbox", { name: "Phone" })).toHaveValue("");
    await panel.getByRole("button", { name: "Next person" }).click();
    panel = page.getByRole("dialog", { name: "Cal Third", exact: true });
    await expect(panel.getByText("3 of 3", { exact: true })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Next person" }),
    ).toBeDisabled();

    // Cancel asks before throwing a rename away.
    await panel.getByRole("textbox", { name: "Full name" }).fill("Cal Changed");
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(discard).toContainText(
      "Your changes to Cal Third haven't been saved.",
    );
    await discard.getByRole("button", { name: "Keep editing" }).click();
    await expect(panel.getByRole("textbox", { name: "Full name" })).toHaveValue(
      "Cal Changed",
    );

    // The schedule drawer replaces the panel, so opening it with unsaved
    // edits asks first, and Discard then opens the drawer.
    await panel.getByRole("button", { name: "Edit schedule" }).click();
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Discard" }).click();
    const drawer = page.getByRole("dialog", {
      name: "Edit Cal Third's schedule",
    });
    await expect(drawer).toBeVisible();
    await expect(panel).toHaveCount(0);
    await drawer.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(participantRow(page, "Cal Third")).toBeVisible();
    await expect(participantRow(page, "Cal Changed")).toHaveCount(0);
    expect(writes.entries).toEqual([]);
  });

  test("keeps the panel draft through a version conflict and offers Apply again on a conflicting row", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-conflict",
    );
    await addPersonApi(request, event.code, token, {
      name: "Rita Row",
      email: personEmail("rita", runId),
    });
    await addPersonApi(request, event.code, token, {
      name: "Pam Panel",
      email: personEmail("pam", runId),
    });
    await gotoParticipants(page, event);
    const ritaRow = participantRow(page, "Rita Row");
    await expect(ritaRow).toBeVisible();

    // Live sync is held so the list keeps the versions it loaded while
    // another session changes the rows underneath it.
    const release = await freezeLiveSync(page);
    try {
      let entries = await rosterByName(request, event.code, token);
      await patchRowViaApi(
        request,
        event.code,
        token,
        entries.get("Rita Row"),
        {
          weight: 0.3,
        },
      );

      const conflicted = waitForRowPatch(page);
      await chooseRowAction(page, "Rita Row", "Leave out of results");
      expect((await conflicted).status()).toBe(409);
      const notice = conflictNotice(page, "Rita Row");
      await expect(notice).toHaveText(
        /Rita Row was changed in another session, so your change wasn't saved\. The latest values are shown\./,
      );
      await expect(ritaRow).toContainText("Weight 0.3");
      await expect(ritaRow).not.toContainText("Left out of results");
      const applied = waitForRowPatch(page);
      await notice.getByRole("button", { name: "Apply again" }).click();
      expect((await applied).status()).toBe(200);
      await expectToast(page, "Rita Row was updated.");
      await expect(notice).toHaveCount(0);
      await expect(ritaRow).toContainText("Weight 0.3");
      await expect(ritaRow).toContainText("Left out of results");

      // Dismiss keeps the latest values and sends nothing.
      entries = await rosterByName(request, event.code, token);
      await patchRowViaApi(
        request,
        event.code,
        token,
        entries.get("Rita Row"),
        {
          phone: "+1 555 777 0000",
        },
      );
      const second = waitForRowPatch(page);
      await chooseRowAction(page, "Rita Row", "Count in results");
      expect((await second).status()).toBe(409);
      await expect(notice).toBeVisible();
      await expect(ritaRow).toContainText("+1 555 777 0000");
      const writes = rowPatchRecorder(page);
      await notice.getByRole("button", { name: "Dismiss" }).click();
      await expect(notice).toHaveCount(0);
      await expect(ritaRow).toContainText("Left out of results");
      expect(writes.entries).toEqual([]);
      entries = await rosterByName(request, event.code, token);
      expect(entries.get("Rita Row")).toMatchObject({
        weight: 0.3,
        included: false,
        phone: "+1 555 777 0000",
      });

      // The panel keeps what the organizer typed; saving again applies it
      // on top of the other session's change.
      const panel = await openPersonPanel(page, "Pam Panel");
      await patchRowViaApi(
        request,
        event.code,
        token,
        entries.get("Pam Panel"),
        {
          phone: "+1 555 222 3333",
        },
      );
      const weight = panel.getByRole("spinbutton", { name: "Weight" });
      await weight.fill("0.5");
      const save = panel.getByRole("button", { name: "Save", exact: true });
      const refused = waitForRowPatch(page);
      await save.click();
      expect((await refused).status()).toBe(409);
      await expect(
        panel.getByRole("alert").filter({
          hasText:
            "Pam Panel was changed in another session, so your change wasn't saved. Save again to apply it on top of the latest values.",
        }),
      ).toBeVisible();
      await expect(weight).toHaveValue("0.5");
      await expect(save).toBeEnabled();
      const resaved = waitForRowPatch(page);
      await save.click();
      expect((await resaved).status()).toBe(200);
      await expectToast(page, "Saved.");
      await expect(panel.getByRole("alert")).toHaveCount(0);
      await expect(save).toBeDisabled();
      await panel.getByRole("button", { name: "Cancel" }).click();
      await expect(participantRow(page, "Pam Panel")).toContainText(
        "Weight 0.5",
      );
    } finally {
      await release();
    }
    const pam = (await rosterByName(request, event.code, token)).get(
      "Pam Panel",
    );
    expect(pam).toMatchObject({ weight: 0.5, phone: "+1 555 222 3333" });
  });
});

test.describe("Adding people", () => {
  test("validates the add panel before sending and shows each refusal from the server", async ({
    page,
    request,
  }) => {
    const { runId, organizerEmail, token, event } = await startOrganizerEvent(
      { page, request },
      "people-add",
    );
    const adaEmail = personEmail("ada", runId);
    const inactiveEmail = personEmail("ina", runId);
    const unverifiedEmail = personEmail("una", runId);
    seedAccounts({ inactive: inactiveEmail, unverified: unverifiedEmail });
    const posts = managedPostRecorder(page);

    await gotoParticipants(page, event);
    const panel = await openAddPanel(page);
    const name = panel.getByRole("textbox", { name: "Full name" });
    const email = panel.getByRole("textbox", { name: "Email" });
    const phone = panel.getByRole("textbox", { name: "Phone" });
    const add = panel.getByRole("button", { name: "Add", exact: true });

    // Nothing leaves the page until every field reads right, and focus goes
    // to the first field that does not.
    await add.click();
    await expect(panel.getByText("Full name is required.")).toBeVisible();
    await expect(panel.getByText("Email address is required.")).toBeVisible();
    await expect(name).toBeFocused();
    await name.fill("Ada Adder");
    await expect(panel.getByText("Full name is required.")).toHaveCount(0);
    await add.click();
    await expect(panel.getByText("Email address is required.")).toBeVisible();
    await expect(email).toBeFocused();
    await email.fill("ada@example");
    await add.click();
    await expect(panel.getByText("Enter a valid email address.")).toBeVisible();
    await expect(email).toBeFocused();
    await email.fill(adaEmail);
    await phone.fill("12");
    // Enter in a field submits too, although Add sits in the footer.
    await phone.press("Enter");
    await expect(
      panel.getByText("Enter a phone number with 7 to 32 digits."),
    ).toBeVisible();
    await expect(phone).toBeFocused();
    await phone.fill("");
    expect(posts.entries).toEqual([]);

    // The server refuses the organizer's own address, an inactive account
    // and an unverified full account; the fields keep what was typed.
    const refusals = [
      [organizerEmail, "That is one of your own addresses."],
      [inactiveEmail, "This email belongs to an inactive account."],
      [unverifiedEmail, "This email belongs to an unverified full account."],
    ];
    for (const [address, message] of refusals) {
      await email.fill(address);
      const refused = waitForManagedPost(page);
      await add.click();
      expect((await refused).status()).toBe(409);
      await expect(
        panel.getByRole("alert").filter({ hasText: message }),
      ).toBeVisible();
      await expect(name).toHaveValue("Ada Adder");
      await expect(email).toHaveValue(address);
    }
    await expect(participantSummary(page)).toContainText("0 people");

    await email.fill(adaEmail);
    await add.click();
    await expect(
      panel.getByText("Ada Adder was added. No invitation was sent."),
    ).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(name).toHaveValue("");
    await expect(name).toBeFocused();
    const entries = await rosterEntries(request, event.code, token);
    expect(entries.participants.map((entry) => entry.email)).toEqual([
      adaEmail,
    ]);
  });

  test("the own-address refusal names the checkbox the add panel shows", async ({
    page,
    request,
  }) => {
    const { organizerEmail, event } = await startOrganizerEvent(
      { page, request },
      "people-own",
    );
    await gotoParticipants(page, event);
    const panel = await openAddPanel(page);
    await panel.getByRole("textbox", { name: "Full name" }).fill("Twin Me");
    await panel.getByRole("textbox", { name: "Email" }).fill(organizerEmail);
    const refused = waitForManagedPost(page);
    await panel.getByRole("button", { name: "Add", exact: true }).click();
    expect((await refused).status()).toBe(409);
    const alert = panel
      .getByRole("alert")
      .filter({ hasText: "That is one of your own addresses." });
    await expect(alert).toBeVisible();
    // The refusal tells the organizer which box to tick: that box must be
    // the one on the panel.
    const quoted = (await alert.textContent()).match(/["“]([^"”]+)["”]/)?.[1];
    expect(quoted, "the refusal names a checkbox").toBeTruthy();
    expect(
      await panel.getByRole("checkbox", { name: quoted, exact: true }).count(),
    ).toBe(1);
  });

  test("refuses adds past the event's invitation-recipient and participant caps", async ({
    page,
    request,
  }) => {
    const { runId, event } = await startOrganizerEvent(
      { page, request },
      "people-caps",
    );
    await gotoParticipants(page, event);
    const panel = await openAddPanel(page);
    const name = panel.getByRole("textbox", { name: "Full name" });
    const add = panel.getByRole("button", { name: "Add", exact: true });

    // A thousand invitation recipients (the configured cap) are filed on
    // this event directly; the next address is refused.
    fillInvitationCap(event.code, runId);
    try {
      await name.fill("Over Invited");
      await panel
        .getByRole("textbox", { name: "Email" })
        .fill(personEmail("over", runId));
      const refused = waitForManagedPost(page);
      await add.click();
      expect((await refused).status()).toBe(409);
      await expect(
        panel.getByRole("alert").filter({
          hasText: "An event can have at most 1000 invitation recipients.",
        }),
      ).toBeVisible();
    } finally {
      clearInvitationCap(event.code, runId);
    }

    // A thousand participants (the other cap) refuse even someone with no
    // email, who needs no invitation.
    fillParticipantCap(event.code, runId);
    try {
      await name.fill("Over Crowded");
      await panel
        .getByRole("checkbox", {
          name: "They have no email. I'll enter their schedule.",
        })
        .check();
      const refused = waitForManagedPost(page);
      await add.click();
      expect((await refused).status()).toBe(409);
      await expect(
        panel.getByRole("alert").filter({
          hasText: "An event can have at most 1000 participants.",
        }),
      ).toBeVisible();
    } finally {
      clearParticipantCap(event.code, runId);
    }
    await expect(name).toHaveValue("Over Crowded");
  });

  test("reports someone already on the list and offers an invitation only to people never invited", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-again",
    );
    const adaEmail = personEmail("ada", runId);
    const boEmail = personEmail("bo", runId);
    await addPersonApi(request, event.code, token, {
      name: "Ada Again",
      email: adaEmail,
    });
    await addPersonApi(request, event.code, token, {
      name: "Bo Before",
      email: boEmail,
    });
    const bo = (await rosterByName(request, event.code, token)).get(
      "Bo Before",
    );
    await sendInvitationsApi(request, event.code, token, [bo.id]);
    await waitForInvitationStatus(request, event.code, token, boEmail, "sent");

    await gotoParticipants(page, event);
    await expect(participantSummary(page)).toContainText("2 people");
    const panel = await openAddPanel(page);
    const name = panel.getByRole("textbox", { name: "Full name" });
    const email = panel.getByRole("textbox", { name: "Email" });
    const add = panel.getByRole("button", { name: "Add", exact: true });
    const result = panel.locator(".participants-add-panel__result");

    // The line names the person as the list has them, whatever was typed.
    await name.fill("Ada Different");
    await email.fill(adaEmail.toUpperCase());
    const again = waitForManagedPost(page);
    await add.click();
    expect((await again).status()).toBe(200);
    await expect(result).toContainText(
      "Ada Again is already on the list, so nothing was added.",
    );
    await expect(result.getByRole("button", { name: "Open" })).toBeVisible();
    // Ada was never invited, so the line offers it; the review can be
    // closed without sending, which keeps the offer.
    await result.getByRole("button", { name: "Send invitation" }).click();
    const review = page.getByRole("dialog", { name: "Send invitations" });
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Cancel" }).click();
    await expect(review).toHaveCount(0);
    await expect(
      result.getByRole("button", { name: "Send invitation" }),
    ).toBeVisible();

    // Bo already has his invitation, so nothing is offered but his panel.
    await name.fill("Bo Other");
    await email.fill(boEmail);
    await add.click();
    await expect(result).toContainText(
      "Bo Before is already on the list, so nothing was added.",
    );
    await expect(
      result.getByRole("button", { name: "Send invitation" }),
    ).toHaveCount(0);
    await result.getByRole("button", { name: "Open" }).click();
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Bo Before", exact: true }),
    ).toBeVisible();

    const byName = await rosterByName(request, event.code, token);
    expect([...byName.keys()].sort()).toEqual(["Ada Again", "Bo Before"]);
    expect(byName.get("Ada Again").invitationStatus).toBe("not_sent");
  });
});

test.describe("Schedule drawer", () => {
  test("enters a no-email person's schedule from the add result and saves it as a draft or a submission", async ({
    page,
    request,
  }) => {
    const { token, event } = await startOrganizerEvent(
      { page, request },
      "people-schedule",
    );
    const puts = requestRecorder(
      page,
      (candidate) =>
        candidate.method() === "PUT" &&
        updateRoutePattern.test(candidate.url()),
    );
    await gotoParticipants(page, event);
    const panel = await openAddPanel(page);
    await panel
      .getByRole("textbox", { name: "Full name" })
      .fill("Nell NoEmail");
    await panel
      .getByRole("checkbox", {
        name: "They have no email. I'll enter their schedule.",
      })
      .check();
    await panel.getByRole("button", { name: "Add", exact: true }).click();
    await expect(panel.locator(".participants-add-panel__result")).toHaveText(
      /^Nell NoEmail was added\./,
    );
    await panel.getByRole("button", { name: "Enter their schedule" }).click();

    const drawer = scheduleDrawer(page, "Nell NoEmail");
    await expect(drawer).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(
      drawer.getByText("Organizer-managed participant"),
    ).toBeVisible();
    await expect(
      drawer.getByText("You and this participant edit the same response."),
    ).toBeVisible();
    // Everyone starts Available here, so the brush starts on Busy.
    await expect(
      drawer.getByRole("button", { name: "Busy", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const cell = (index) => drawer.locator(`[data-cell-idx="${index}"]`);
    await expect(cell(0)).toHaveAttribute("data-availability", "free");
    await cell(0).click();
    await expect(cell(0)).toHaveAttribute("data-availability", "busy");

    // An unsubmitted response saves as a draft straight away.
    await saveDrawer(page, drawer, "Save draft");
    await expect(drawer.getByText("Draft saved.")).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Close", exact: true }),
    ).toBeVisible();
    const row = participantRow(page, "Nell NoEmail");
    const entry = (await rosterByName(request, event.code, token)).get(
      "Nell NoEmail",
    );
    let schedule = await managedSchedule(request, event.code, token, entry);
    expect(schedule.submitted).toBeFalsy();
    expect(schedule.availabilityInperson.slice(0, 2)).toEqual([0, 1]);
    await expect(row.locator(".participants-table__response")).toHaveText(
      "Not submitted",
    );

    await saveDrawer(page, drawer, "Submit on behalf");
    await expect(drawer.getByText("Schedule submitted.")).toBeVisible();
    await expect(row.locator(".participants-table__response")).toHaveText(
      "Submitted",
    );
    await expect(participantSummary(page)).toContainText("1 submitted");

    // Saving a submitted response as a draft takes it out of the results,
    // so it asks first; Cancel keeps it submitted and sends nothing.
    await cell(1).click();
    puts.clear();
    await drawer.getByRole("button", { name: "Save draft" }).click();
    const confirm = page.getByRole("dialog", { name: "Save as a draft?" });
    await expect(confirm).toContainText(
      "This takes Nell NoEmail's answers out of the results until you submit again.",
    );
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(drawer).toBeVisible();
    expect(puts.entries).toEqual([]);
    schedule = await managedSchedule(request, event.code, token, entry);
    expect(schedule.submitted).toBeTruthy();

    await drawer.getByRole("button", { name: "Save draft" }).click();
    const saved = page.waitForResponse(isScheduleSave);
    await confirm.getByRole("button", { name: "Save as draft" }).click();
    expect((await saved).status()).toBe(200);
    await expect(drawer.getByText("Draft saved.")).toBeVisible();
    await expect(row.locator(".participants-table__response")).toHaveText(
      "Not submitted",
    );
    await expect(participantSummary(page)).toContainText("0 submitted");
    schedule = await managedSchedule(request, event.code, token, entry);
    expect(schedule.submitted).toBeFalsy();
    expect(schedule.availabilityInperson.slice(0, 3)).toEqual([0, 0, 1]);
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(drawer).toHaveCount(0);

    // The row's Edit schedule reopens the saved answers.
    await row.getByRole("button", { name: "Edit schedule" }).click();
    await expect(drawer).toBeVisible();
    await expect(cell(0)).toHaveAttribute("data-availability", "busy");
    await expect(cell(1)).toHaveAttribute("data-availability", "busy");
    await saveDrawer(page, drawer, "Submit on behalf");
    await expect(drawer.getByText("Schedule submitted.")).toBeVisible();
    schedule = await managedSchedule(request, event.code, token, entry);
    expect(schedule.submitted).toBeTruthy();
  });

  test("asks before discarding unsaved schedule edits from every way out of the drawer", async ({
    page,
    request,
  }) => {
    const { token, event } = await startOrganizerEvent(
      { page, request },
      "people-discard",
    );
    await addPersonApi(request, event.code, token, {
      name: "Dee Draft",
      organizerManaged: true,
    });
    const puts = requestRecorder(
      page,
      (candidate) =>
        candidate.method() === "PUT" &&
        updateRoutePattern.test(candidate.url()),
    );
    await gotoParticipants(page, event);
    const row = participantRow(page, "Dee Draft");
    const drawer = scheduleDrawer(page, "Dee Draft");
    const confirm = page.getByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    const cell = drawer.locator('[data-cell-idx="0"]');

    // Without changes the drawer closes at once.
    await row.getByRole("button", { name: "Edit schedule" }).click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    await row.getByRole("button", { name: "Edit schedule" }).click();
    await cell.click();
    await expect(cell).toHaveAttribute("data-availability", "busy");
    const ways = [
      ["Cancel", () => drawer.getByRole("button", { name: "Cancel" }).click()],
      [
        "the close button",
        () =>
          drawer.getByRole("button", { name: "Close schedule editor" }).click(),
      ],
      [
        "the backdrop",
        () =>
          page
            .locator(".managed-drawer-backdrop")
            .click({ position: { x: 5, y: 5 } }),
      ],
      ["Escape", () => page.keyboard.press("Escape")],
    ];
    for (const [way, leave] of ways) {
      await leave();
      await expect(confirm, way).toBeVisible();
      await expect(confirm).toContainText(
        "You have unsaved changes to this participant's schedule. Discard them?",
      );
      await expect(
        confirm.getByRole("button", { name: "Cancel" }),
      ).toBeFocused();
      // Escape (and Cancel) only closes the question.
      await page.keyboard.press("Escape");
      await expect(confirm).toHaveCount(0);
      await expect(drawer).toBeVisible();
      await expect(cell).toHaveAttribute("data-availability", "busy");
    }

    await drawer.getByRole("button", { name: "Cancel" }).click();
    await confirm.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(puts.entries).toEqual([]);
    await row.getByRole("button", { name: "Edit schedule" }).click();
    await expect(cell).toHaveAttribute("data-availability", "free");
  });

  test("paints and copies between the in-person and virtual grids of a hybrid event, and paints a virtual-only one", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-hybrid",
      { mode: "mixed" },
    );
    await addPersonApi(request, event.code, token, {
      name: "Hal Hybrid",
      organizerManaged: true,
    });
    await gotoParticipants(page, event);
    await participantRow(page, "Hal Hybrid")
      .getByRole("button", { name: "Edit schedule" })
      .click();
    const drawer = scheduleDrawer(page, "Hal Hybrid");
    const inPersonTab = drawer.getByRole("tab", { name: "In person" });
    const virtualTab = drawer.getByRole("tab", { name: "Virtual" });
    const inPerson = drawer.getByRole("grid", { name: "In-Person" });
    const virtual = drawer.getByRole("grid", { name: "Virtual" });
    const cellOf = (grid, index) => grid.locator(`[data-cell-idx="${index}"]`);
    await expect(inPersonTab).toHaveAttribute("aria-selected", "true");
    await expect(inPerson).toBeVisible();
    // Both grids of a mixed event share the in-person brush palette.
    await expect(
      drawer
        .getByRole("group", { name: "Availability status" })
        .locator(".availability-swatch--virtual"),
    ).toHaveCount(0);
    const copyToVirtual = drawer.getByRole("button", {
      name: "Copy In-Person to Virtual",
    });
    // Identical channels have nothing to copy.
    await expect(copyToVirtual).toBeDisabled();

    // A fresh Virtual grid is copied over without asking.
    await cellOf(inPerson, 0).click();
    await expect(copyToVirtual).toBeEnabled();
    await copyToVirtual.click();
    await expect(virtualTab).toHaveAttribute("aria-selected", "true");
    await expect(cellOf(virtual, 0)).toHaveAttribute(
      "data-availability",
      "busy",
    );
    const copyToInPerson = drawer.getByRole("button", {
      name: "Copy Virtual to In-Person",
    });
    await expect(copyToInPerson).toBeDisabled();

    // A painted target asks before it is replaced.
    await cellOf(virtual, 1).click();
    await copyToInPerson.click();
    const replace = drawer.getByRole("alertdialog", {
      name: "Replace In-Person availability?",
    });
    await expect(replace).toContainText(
      "This copies every Virtual value and replaces the current In-Person schedule.",
    );
    await replace.getByRole("button", { name: "Cancel" }).click();
    await expect(replace).toHaveCount(0);
    await expect(virtualTab).toHaveAttribute("aria-selected", "true");
    await inPersonTab.click();
    await expect(cellOf(inPerson, 1)).toHaveAttribute(
      "data-availability",
      "free",
    );
    await virtualTab.click();
    await copyToInPerson.click();
    await replace.getByRole("button", { name: "Replace schedule" }).click();
    await expect(inPersonTab).toHaveAttribute("aria-selected", "true");
    await expect(cellOf(inPerson, 1)).toHaveAttribute(
      "data-availability",
      "busy",
    );
    await saveDrawer(page, drawer, "Submit on behalf");
    await expect(drawer.getByText("Schedule submitted.")).toBeVisible();
    const hal = (await rosterByName(request, event.code, token)).get(
      "Hal Hybrid",
    );
    const halSchedule = await managedSchedule(request, event.code, token, hal);
    expect(halSchedule.availabilityInperson.slice(0, 3)).toEqual([0, 0, 1]);
    expect(halSchedule.availabilityVirtual).toEqual(
      halSchedule.availabilityInperson,
    );

    // A virtual-only event has one grid in the virtual palette, and what
    // is painted there is the virtual schedule.
    const virtualEvent = await createEvent(request, token, {
      name: `people-virtual ${runId}`,
      mode: "virtual",
    });
    await addPersonApi(request, virtualEvent.code, token, {
      name: "Vic Virtual",
      organizerManaged: true,
    });
    await gotoParticipants(page, virtualEvent);
    await participantRow(page, "Vic Virtual")
      .getByRole("button", { name: "Edit schedule" })
      .click();
    const virtualDrawer = scheduleDrawer(page, "Vic Virtual");
    await expect(virtualDrawer).toBeVisible();
    await expect(virtualDrawer.getByRole("tablist")).toHaveCount(0);
    await expect(
      virtualDrawer
        .getByRole("group", { name: "Availability status" })
        .locator(".availability-swatch--virtual"),
    ).toHaveCount(3);
    await virtualDrawer.locator('[data-cell-idx="0"]').click();
    await saveDrawer(page, virtualDrawer, "Submit on behalf");
    await expect(virtualDrawer.getByText("Schedule submitted.")).toBeVisible();
    const vic = (await rosterByName(request, virtualEvent.code, token)).get(
      "Vic Virtual",
    );
    const vicSchedule = await managedSchedule(
      request,
      virtualEvent.code,
      token,
      vic,
    );
    expect(vicSchedule.availabilityVirtual[0]).toBe(0);
    expect(vicSchedule.availabilityInperson[0]).toBe(1);
  });

  test("keeps a left-out person's schedule editable while saying their answers don't count until they count again, and refuses Edit schedule for someone who took over", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-locked",
    );
    const cleoEmail = personEmail("cleo", runId);
    await addPersonApi(request, event.code, token, {
      name: "Lena Left",
      organizerManaged: true,
    });
    const cleo = await registerAccountViaApi(
      request,
      cleoEmail,
      "Cleo",
      "Claim",
    );
    await addPersonApi(request, event.code, token, {
      name: "Cleo Claim",
      email: cleoEmail,
    });
    const lena = (await rosterByName(request, event.code, token)).get(
      "Lena Left",
    );
    await patchRowViaApi(request, event.code, token, lena, { included: false });

    await gotoParticipants(page, event);
    const lenaRow = participantRow(page, "Lena Left");
    await expect(lenaRow).toContainText("Left out of results");
    await lenaRow.getByRole("button", { name: "Edit schedule" }).click();
    const drawer = scheduleDrawer(page, "Lena Left");
    const leftOut = drawer.getByRole("status").filter({
      hasText:
        "Lena Left is left out of the results, so their answers don't count.",
    });
    await expect(leftOut).toBeVisible();
    // Leaving someone out changes only the results: their schedule can still
    // be entered and saved.
    const cell = drawer.locator('[data-cell-idx="0"]');
    await expect(cell).not.toHaveAttribute("aria-readonly", "true");
    await expect(
      drawer.getByRole("button", { name: "Submit on behalf" }),
    ).toBeEnabled();
    await expect(
      drawer.getByRole("button", { name: "Busy", exact: true }),
    ).toBeEnabled();
    await cell.click();
    await expect(cell).toHaveAttribute("data-availability", "busy");
    await saveDrawer(page, drawer, "Save draft");
    await expect(drawer.getByText("Draft saved.")).toBeVisible();
    await expect(leftOut).toBeVisible();
    expect(
      (await managedSchedule(request, event.code, token, lena))
        .availabilityInperson[0],
    ).toBe(0);

    const counted = waitForRowPatch(page);
    await leftOut.getByRole("button", { name: "Count them again" }).click();
    expect((await counted).status()).toBe(200);
    await expectToast(page, "Lena Left now counts in the results.");
    await expect(leftOut).toHaveCount(0);
    await expect(cell).not.toHaveAttribute("aria-readonly", "true");
    await expect(
      drawer.getByRole("button", { name: "Submit on behalf" }),
    ).toBeEnabled();
    await expect(lenaRow).not.toContainText("Left out of results");
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect(
      (await rosterByName(request, event.code, token)).get("Lena Left")
        .included,
    ).toBe(true);

    // Cleo answers herself after the list loaded (live sync is held, so the
    // row still offers Edit schedule): opening it says so and reloads.
    const cleoRow = participantRow(page, "Cleo Claim");
    const editCleo = cleoRow.getByRole("button", { name: "Edit schedule" });
    await expect(editCleo).toBeVisible();
    const release = await freezeLiveSync(page);
    try {
      await claimOwnResponse(request, event.code, cleo.access);
      await editCleo.click();
      await expectToast(
        page,
        "Cleo Claim now manages their own response, so you can no longer edit their schedule.",
      );
      await expect(scheduleDrawer(page, "Cleo Claim")).toHaveCount(0);
      await expect(cleoRow.getByText("Answers themselves")).toBeVisible();
      await expect(editCleo).toHaveCount(0);
    } finally {
      await release();
    }
  });

  test("saves a schedule right after counting the person again from the drawer", async ({
    page,
    request,
  }) => {
    const { token, event } = await startOrganizerEvent(
      { page, request },
      "people-countin",
    );
    await addPersonApi(request, event.code, token, {
      name: "Lou Later",
      organizerManaged: true,
    });
    const lou = (await rosterByName(request, event.code, token)).get(
      "Lou Later",
    );
    await patchRowViaApi(request, event.code, token, lou, { included: false });
    await gotoParticipants(page, event);
    await participantRow(page, "Lou Later")
      .getByRole("button", { name: "Edit schedule" })
      .click();
    const drawer = scheduleDrawer(page, "Lou Later");
    const counted = waitForRowPatch(page);
    await drawer.getByRole("button", { name: "Count them again" }).click();
    expect((await counted).status()).toBe(200);
    await expect(drawer.getByText(/is left out of the results/)).toHaveCount(0);
    // Nobody else touched Lou: the drawer's own change must not stand in
    // the way of entering their schedule right after.
    const cell = drawer.locator('[data-cell-idx="0"]');
    await cell.click();
    await expect(cell).toHaveAttribute("data-availability", "busy");
    const saved = page.waitForResponse(isScheduleSave);
    await drawer.getByRole("button", { name: "Submit on behalf" }).click();
    expect((await saved).status()).toBe(200);
    await expect(drawer.getByText("Schedule submitted.")).toBeVisible();
    const schedule = await managedSchedule(request, event.code, token, lou);
    expect(schedule.submitted).toBeTruthy();
    expect(schedule.availabilityInperson[0]).toBe(0);
  });
});

test.describe("Removing people", () => {
  test("removal cancels queued emails, ends links, sessions and dashboard entries, and waits for an email being sent", async ({
    browser,
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-remove",
    );
    const tessEmail = personEmail("tess", runId);
    const finnEmail = personEmail("finn", runId);
    const piaEmail = personEmail("pia", runId);
    const finn = await newAccountContext(browser, finnEmail, "Finn", "Full");
    const tessContext = await browser.newContext();
    try {
      await addPersonApi(request, event.code, token, {
        name: "Tess Temp",
        email: tessEmail,
      });
      await addPersonApi(request, event.code, token, {
        name: "Finn Full",
        email: finnEmail,
      });
      const nora = await addPersonApi(request, event.code, token, {
        name: "Nora NoEmail",
        organizerManaged: true,
      });
      await addPersonApi(request, event.code, token, {
        name: "Pia Pending",
        email: piaEmail,
      });
      let entries = await rosterByName(request, event.code, token);
      const invitedAt = Date.now() - 1000;
      await sendInvitationsApi(request, event.code, token, [
        entries.get("Tess Temp").id,
        entries.get("Finn Full").id,
      ]);
      const tessInvitation = await latestEmailFor(
        tessEmail,
        invitedAt,
        invitationEmail(event.code),
      );
      const finnInvitation = await latestEmailFor(
        finnEmail,
        invitedAt,
        (body) => body.includes(`/event?code=${event.code}&invitation=`),
      );
      const finnLink = invitationLinkFromEmail(finnInvitation);

      // Tess opens her link, which signs her in to her schedule.
      const tessPage = await tessContext.newPage();
      await tessPage.goto(temporaryAccessPathFromEmail(tessInvitation));
      await expect(
        tessPage.getByText("You are responding as Tess Temp"),
      ).toBeVisible();

      // Finn has the event on his dashboard and a reminder still queued.
      expect(await participatingCodes(request, finn.token)).toContain(
        event.code,
      );
      const finnReminder = queueEmailJob(event.code, finnEmail, {
        type: "reminder",
        status: "pending",
      });
      // An invitation email to Pia is being handed to the provider.
      const piaSending = queueEmailJob(event.code, piaEmail, {
        type: "invitation",
        status: "processing",
      });
      try {
        await gotoParticipants(page, event);
        await expect(participantSummary(page)).toContainText("4 people");

        // Signing in locks Tess's address, though the organizer still
        // answers for her and can rename her.
        const tessPanel = await openPersonPanel(page, "Tess Temp");
        await expect(
          tessPanel.getByRole("textbox", { name: "Full name" }),
        ).toBeEnabled();
        await expect(
          tessPanel.getByRole("textbox", { name: "Email" }),
        ).toBeDisabled();
        await expect(
          tessPanel.getByRole("textbox", { name: "Email" }),
        ).toHaveAccessibleDescription(
          "Tess Temp already signed in, so this address can't change. Remove Tess Temp and add them again if it is wrong.",
        );
        await tessPanel.getByRole("button", { name: "Cancel" }).click();

        const removeTess = await removeFromRow(page, "Tess Temp");
        await expect(removeTess).toContainText(
          "Their schedule, group memberships and invitation are deleted, and any invitation link already sent stops working.",
        );
        await confirmRemoval(page, removeTess, 200);
        await expectToast(page, "Tess Temp was removed from the event.");
        await expect(participantRow(page, "Tess Temp")).toHaveCount(0);
        // Her link session ended with her invitation.
        const tessSession = await tempAccessSessionState(tessPage, event.code);
        expect(tessSession.status).toBe(401);
        expect(tessSession.payload.errorCode).toBe("temp_session_inactive");
        await tessPage.getByRole("button", { name: "Apply to all" }).click();
        await expect(
          tessPage.getByRole("heading", { name: "Temporary access ended" }),
        ).toBeVisible();

        // Finn goes from the person panel: his queued reminder is canceled,
        // the event leaves his dashboard, and his link no longer opens it.
        const finnPanel = await openPersonPanel(page, "Finn Full");
        await finnPanel
          .getByRole("button", { name: "Remove from event…" })
          .click();
        const removeFinn = page.getByRole("dialog", {
          name: "Remove Finn Full from the event?",
        });
        await confirmRemoval(page, removeFinn, 200);
        await expectToast(page, "Finn Full was removed from the event.");
        await expect(finnPanel).toHaveCount(0);
        expect(emailJobState(finnReminder)).toEqual({
          status: "canceled",
          lastError: "The person was changed on the event's participant list.",
        });
        expect(await participatingCodes(request, finn.token)).not.toContain(
          event.code,
        );
        await finn.page.goto(finnLink);
        await expect(
          finn.page.getByRole("heading", { name: "Event Not Found" }),
        ).toBeVisible();

        // A person with no email takes their stand-in member with them.
        await confirmRemoval(
          page,
          await removeFromRow(page, "Nora NoEmail"),
          200,
        );
        await expectToast(page, "Nora NoEmail was removed from the event.");
        expect(memberExists(nora.participant.id)).toBe(false);

        // An email on its way to the provider cannot be pulled back, so
        // neither a removal nor an address change goes through meanwhile.
        const sendingMessage =
          "An email to this person is being sent right now. Try again in a minute.";
        const piaRow = participantRow(page, "Pia Pending");
        await expect(
          piaRow.locator(".participants-table__response"),
        ).toHaveText("Sending invite…");
        await confirmRemoval(
          page,
          await removeFromRow(page, "Pia Pending"),
          409,
        );
        await expectToast(page, sendingMessage);
        await expect(piaRow).toBeVisible();
        const piaPanel = await openPersonPanel(page, "Pia Pending");
        await piaPanel
          .getByRole("textbox", { name: "Email" })
          .fill(personEmail("pia-new", runId));
        const refused = waitForRowPatch(page);
        await piaPanel
          .getByRole("button", { name: "Save", exact: true })
          .click();
        expect((await refused).status()).toBe(409);
        await expect(
          piaPanel.getByRole("alert").filter({ hasText: sendingMessage }),
        ).toBeVisible();
        expect(emailJobState(piaSending).status).toBe("processing");
      } finally {
        setEmailJobStatus(piaSending, "canceled");
      }
      entries = await rosterByName(request, event.code, token);
      expect([...entries.keys()]).toEqual(["Pia Pending"]);
      expect(entries.get("Pia Pending").email).toBe(piaEmail);
    } finally {
      await tessContext.close();
      await finn.context.close();
    }
  });
});

test.describe("Locked list", () => {
  test("a closed, archived or finalized event keeps a read-only list, closes what was open, and refuses roster writes until reactivated", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-closed",
    );
    await addPersonApi(request, event.code, token, {
      name: "Ana Open",
      email: personEmail("ana", runId),
    });
    await addPersonApi(request, event.code, token, {
      name: "Mo Managed",
      organizerManaged: true,
    });
    const ana = (await rosterByName(request, event.code, token)).get(
      "Ana Open",
    );
    await gotoParticipants(page, event);
    const banner = page.getByText(
      "Responses are closed, so this list is read-only. Reactivate the event to make changes.",
    );
    const actions = participantActions(page);
    await expect(actions.getByRole("button", { name: "Email" })).toBeVisible();

    // A drawer with unsaved edits is open when another session closes
    // responses: it goes away without asking, as does everything else that
    // could change the list.
    await participantRow(page, "Mo Managed")
      .getByRole("button", { name: "Edit schedule" })
      .click();
    const drawer = scheduleDrawer(page, "Mo Managed");
    const moCell = drawer.locator('[data-cell-idx="0"]');
    await moCell.click();
    await expect(moCell).toHaveAttribute("data-availability", "busy");
    await setLifecycleViaApi(request, token, event.code, "closed");
    await wakeLiveSync(page);
    await expect(banner).toBeVisible({ timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const lockReason = "Responses are closed, so this list is read-only.";
    await expectListLocked(page, "Ana Open", lockReason);
    const panel = await openPersonPanel(page, "Ana Open");
    await expectPanelLocked(panel, "Ana Open");
    await panel.getByRole("button", { name: "Cancel" }).click();
    await participantRow(page, "Mo Managed")
      .getByRole("button", { name: "Edit schedule" })
      .click();
    await expect(
      drawer.getByRole("note").filter({
        hasText: "Availability can only be edited while this event is active.",
      }),
    ).toBeVisible();
    await expect(drawer.locator('[data-cell-idx="0"]')).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    await expect(
      drawer.getByRole("button", { name: "Submit on behalf" }),
    ).toBeDisabled();
    await drawer.getByRole("button", { name: "Cancel" }).click();
    await expect(drawer).toHaveCount(0);

    // Every roster write is refused while the event is closed.
    const closedMessage = "Responses cannot change while the event is closed.";
    for (const [method, path, body] of rosterWrites(event.code, ana, runId)) {
      const refused = await apiJson(request, method, path, token, body);
      expect(refused.response.status(), `${method} ${path}`).toBe(409);
      expect(refused.payload.error).toBe(closedMessage);
    }

    // Archiving keeps the list read-only; reactivating opens it again.
    await setLifecycleViaApi(request, token, event.code, "archived");
    await wakeLiveSync(page);
    await expect(eventControls(page)).toContainText("archived", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(banner).toBeVisible();
    await expect(
      actions.getByRole("button", { name: "+ Add person" }),
    ).toBeDisabled();
    await setLifecycleViaApi(request, token, event.code, "active");
    await wakeLiveSync(page);
    await expect(banner).toHaveCount(0, { timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(
      actions.getByRole("button", { name: "+ Add person" }),
    ).toBeEnabled();
    await expect(actions.getByRole("button", { name: "Email" })).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "Select Ana Open" }),
    ).toBeEnabled();
    const reopened = await apiJson(
      request,
      "PATCH",
      `/events/roster/${ana.id}?code=${event.code}`,
      token,
      { phone: "+1 555 303 0303", expectedVersion: ana.version },
    );
    expect(reopened.response.status()).toBe(200);

    // Finalizing locks the list the same way (nobody was invited, so
    // nobody is emailed).
    await submitOnBehalf(
      request,
      token,
      event,
      (await rosterByName(request, event.code, token)).get("Mo Managed"),
    );
    const results = await freshResults(request, token, event.code);
    expect(results.recommendations.length).toBeGreaterThan(0);
    await finalizeViaApi(
      request,
      token,
      event.code,
      results.recommendations[0],
    );
    await wakeLiveSync(page);
    await expect(banner).toBeVisible({ timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(
      actions.getByRole("button", { name: "+ Add person" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("checkbox", { name: "Select Ana Open" }),
    ).toBeDisabled();
    const finalizedWrite = await apiJson(
      request,
      "PATCH",
      `/events/roster/${ana.id}?code=${event.code}`,
      token,
      {
        phone: "+1 555 303 0404",
        expectedVersion: reopened.payload.participant.version,
      },
    );
    expect(finalizedWrite.response.status()).toBe(409);
    expect(finalizedWrite.payload.error).toBe(
      "Responses cannot change while the event is finalized.",
    );
  });

  test("adding someone to an event closed in another session says to reactivate it", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-closing",
    );
    await gotoParticipants(page, event);
    const panel = await openAddPanel(page);
    await panel.getByRole("textbox", { name: "Full name" }).fill("Late Larry");
    await panel
      .getByRole("textbox", { name: "Email" })
      .fill(personEmail("larry", runId));
    const banner = page.getByText(
      "Responses are closed, so this list is read-only. Reactivate the event to make changes.",
    );
    // Live sync is held so the panel is still open when the add is sent,
    // and only the refusal itself can tell the page the event closed.
    const release = await freezeLiveSync(page);
    try {
      await setLifecycleViaApi(request, token, event.code, "closed");
      const refused = waitForManagedPost(page);
      await panel.getByRole("button", { name: "Add", exact: true }).click();
      expect((await refused).status()).toBe(409);
      await expect(panel.getByRole("alert").or(banner).first()).toBeVisible();
      // The refusal says to reactivate: the panel's own message, or the
      // read-only banner once the workspace takes the closed event from the
      // reply (which also closes the panel). Either is on screen as soon as
      // the refusal is, so a short wait is enough.
      await expect(
        page
          .getByText(
            /This event is closed\. Reactivate it before adding participants\.|Reactivate the event to make changes\./,
          )
          .first(),
      ).toBeVisible({ timeout: 2_000 });
    } finally {
      await release();
    }
    expect(
      (await rosterEntries(request, event.code, token)).participants,
    ).toEqual([]);
  });

  test("past the response deadline the list is locked while schedules the organizer answers for stay open", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "people-deadline",
    );
    await joinAsOrganizer(request, event.code, token);
    await addPersonApi(request, event.code, token, {
      name: "Tia Temp",
      email: personEmail("tia", runId),
    });
    await addPersonApi(request, event.code, token, {
      name: "Mo Managed",
      organizerManaged: true,
    });
    await addPersonApi(request, event.code, token, {
      name: "Lou Left",
      organizerManaged: true,
    });
    let entries = await rosterByName(request, event.code, token);
    await patchRowViaApi(request, event.code, token, entries.get("Lou Left"), {
      included: false,
    });
    passResponseDeadline(event.code);

    await gotoParticipants(page, event);
    const banner = page.getByRole("status").filter({
      hasText:
        /^The response deadline \(.+\) has passed, so people can't be added, invited or changed\. You can still enter schedules for people you answer for\./,
    });
    await expect(banner).toBeVisible();
    // The deadline is shown in the event's timezone, named.
    await expect(banner).toContainText(/\(.+ UTC\) has passed/);
    const lockReason =
      "The response deadline has passed, so people can't be added, invited or changed.";
    await expectListLocked(page, "Tia Temp", lockReason);
    const panel = await openPersonPanel(page, "Tia Temp");
    await expectPanelLocked(panel, "Tia Temp");
    await panel.getByRole("button", { name: "Cancel" }).click();

    // Someone the organizer answers for still gets their schedule entered.
    await participantRow(page, "Mo Managed")
      .getByRole("button", { name: "Edit schedule" })
      .click();
    const moDrawer = scheduleDrawer(page, "Mo Managed");
    await expect(moDrawer).toBeVisible();
    await expect(moDrawer.getByRole("note")).toHaveCount(0);
    await moDrawer.locator('[data-cell-idx="0"]').click();
    await saveDrawer(page, moDrawer, "Submit on behalf");
    await expect(moDrawer.getByText("Schedule submitted.")).toBeVisible();
    await moDrawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      participantRow(page, "Mo Managed").locator(
        ".participants-table__response",
      ),
    ).toHaveText("Submitted");

    // Counting a left-out person again changes the list, so it is locked
    // (their schedule is not).
    await participantRow(page, "Lou Left")
      .getByRole("button", { name: "Edit schedule" })
      .click();
    const louDrawer = scheduleDrawer(page, "Lou Left");
    await expect(
      louDrawer.getByText(
        "Lou Left is left out of the results, so their answers don't count.",
      ),
    ).toBeVisible();
    await expect(
      louDrawer.getByRole("button", { name: "Count them again" }),
    ).toBeDisabled();
    await louDrawer.getByRole("button", { name: "Cancel" }).click();

    // The organizer's own answers follow the deadline like everyone's.
    await participantRow(page, "Rory Roster (you)")
      .getByRole("button", { name: "Edit my schedule" })
      .click();
    const ownDrawer = page.getByRole("dialog", { name: "Edit my schedule" });
    await expect(
      ownDrawer.getByRole("note").filter({
        hasText:
          "The response deadline has passed, so your own answers can't change.",
      }),
    ).toBeVisible();
    await expect(
      ownDrawer.getByRole("button", { name: "Submit", exact: true }),
    ).toBeDisabled();
    await expect(ownDrawer.locator('[data-cell-idx="0"]')).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    await ownDrawer.getByRole("button", { name: "Cancel" }).click();

    // Every roster write is refused past the deadline.
    entries = await rosterByName(request, event.code, token);
    for (const [method, path, body] of rosterWrites(
      event.code,
      entries.get("Tia Temp"),
      runId,
    )) {
      const refused = await apiJson(request, method, path, token, body);
      expect(refused.response.status(), `${method} ${path}`).toBe(409);
      expect(refused.payload.error, `${method} ${path}`).toBe(
        "The response deadline has passed.",
      );
    }
    expect(
      [...(await rosterByName(request, event.code, token)).keys()].sort(),
    ).toEqual(["Lou Left", "Mo Managed", "Rory Roster", "Tia Temp"]);

    // Change deadline opens the event settings in place, on the deadline.
    await banner.getByRole("button", { name: "Change deadline" }).click();
    await expect(page.getByLabel("Response Deadline")).toBeFocused();
    await expect(
      page.getByText("Uses the event timezone (UTC).", { exact: false }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/event\\?code=${event.code}$`));
  });
});

test.describe("Roster API guards", () => {
  test("only the organizer reaches the roster, group, bulk, invitation, import, reminder and delivery endpoints", async ({
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      personEmail("people-guard", runId),
      "Rory",
      "Roster",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `people-guard ${runId}`,
    });
    const patEmail = personEmail("pat", runId);
    const pat = await registerAccountViaApi(
      request,
      patEmail,
      "Pat",
      "Participant",
    );
    await addPersonApi(request, event.code, token, {
      name: "Pat Participant",
      email: patEmail,
    });
    const created = await apiJson(
      request,
      "POST",
      `/events/roster/groups?code=${event.code}`,
      token,
      { name: "Team" },
    );
    expect(created.response.status()).toBe(201);
    const group = created.payload.group;
    const entry = (await rosterByName(request, event.code, token)).get(
      "Pat Participant",
    );
    const sent = await sendInvitationsApi(request, event.code, token, [
      entry.id,
    ]);
    const deliveryId = sent.deliveryRequest.id;
    // Pat can see the event he was invited to, but none of its management.
    expect(
      (
        await apiJson(request, "GET", `/events?code=${event.code}`, pat.access)
      ).response.status(),
    ).toBe(200);

    const q = `?code=${event.code}`;
    const organizerOnly = "Only the organizer can manage participants";
    const calls = [
      ["GET", `/events/roster${q}`, undefined, 403, organizerOnly],
      [
        "GET",
        `/events/roster/${entry.id}/schedule${q}`,
        undefined,
        403,
        organizerOnly,
      ],
      [
        "PATCH",
        `/events/roster/${entry.id}${q}`,
        { phone: "+1 555 000 1111", expectedVersion: entry.version },
        403,
        organizerOnly,
      ],
      [
        "DELETE",
        `/events/roster/${entry.id}${q}`,
        undefined,
        403,
        organizerOnly,
      ],
      [
        "PATCH",
        `/events/roster/bulk${q}`,
        {
          filter: { all: true },
          updates: { included: false },
          idempotencyKey: crypto.randomUUID(),
        },
        403,
        organizerOnly,
      ],
      ["GET", `/events/roster/groups${q}`, undefined, 403, organizerOnly],
      [
        "POST",
        `/events/roster/groups${q}`,
        { name: "Mine" },
        403,
        organizerOnly,
      ],
      [
        "PATCH",
        `/events/roster/groups/${group.id}${q}`,
        { name: "Renamed" },
        403,
        organizerOnly,
      ],
      [
        "DELETE",
        `/events/roster/groups/${group.id}${q}`,
        undefined,
        403,
        organizerOnly,
      ],
      [
        "POST",
        `/events/roster/groups/${group.id}/include-only${q}`,
        {},
        403,
        organizerOnly,
      ],
      [
        "POST",
        `/events/roster/invitations${q}`,
        { participantIds: [entry.id], preview: true },
        403,
        organizerOnly,
      ],
      [
        "POST",
        `/events/roster-imports${q}`,
        {
          sourceType: "paste",
          pastedText: `name,email\nSneaky,${personEmail("sneaky", runId)}`,
        },
        403,
        organizerOnly,
      ],
      [
        "POST",
        `/events/reminders${q}`,
        { preview: true },
        403,
        "Only the organizer can send reminders",
      ],
      [
        "POST",
        `/events/participants/managed${q}`,
        {
          name: "Sneaky",
          email: personEmail("sneaky", runId),
          sendInvitation: false,
          idempotencyKey: crypto.randomUUID(),
        },
        403,
        "Only the organizer can create managed participants.",
      ],
      [
        "GET",
        `/events/delivery-requests/${deliveryId}`,
        undefined,
        404,
        "Delivery request not found",
      ],
      [
        "GET",
        `/events/delivery-requests/${deliveryId}/retry-preview`,
        undefined,
        404,
        "Delivery request not found",
      ],
      [
        "POST",
        `/events/delivery-requests/${deliveryId}`,
        {},
        404,
        "Delivery request not found",
      ],
    ];
    for (const [method, path, body, status, message] of calls) {
      const denied = await apiJson(request, method, path, pat.access, body);
      expect(denied.response.status(), `${method} ${path}`).toBe(status);
      expect(denied.payload.error, `${method} ${path}`).toBe(message);
    }

    // Nothing Pat tried changed the event.
    const after = await rosterEntries(request, event.code, token);
    expect(after.participants).toHaveLength(1);
    expect(after.participants[0]).toMatchObject({
      name: "Pat Participant",
      phone: "",
      included: true,
      version: entry.version,
    });
    expect(
      after.stats.groups
        .filter((entry) => entry.name)
        .map((entry) => entry.name),
    ).toEqual(["Team"]);
  });

  test("PATCH /events/roster/{id} keeps the account name of someone who answers themselves and of the organizer's own row", async ({
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      personEmail("people-names-api", runId),
      "Rory",
      "Roster",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `people-names-api ${runId}`,
    });
    await joinAsOrganizer(request, event.code, token);
    const sidEmail = personEmail("sid", runId);
    const sid = await registerAccountViaApi(request, sidEmail, "Sid", "Self");
    await addPersonApi(request, event.code, token, {
      name: "Sid Self",
      email: sidEmail,
    });
    await claimOwnResponse(request, event.code, sid.access);
    const listed = await rosterByName(request, event.code, token);
    const sidEntry = listed.get("Sid Self");
    expect(sidEntry.canOrganizerEditAvailability).toBe(false);
    expect(listed.get("Rory Roster").isOrganizer).toBe(true);

    // The schedule endpoint already keeps Sid's name his own.
    const viaSchedule = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${event.code}&participantId=${sidEntry.memberId}`,
      token,
      { name: "Sid Renamed", expectedVersion: sidEntry.version },
    );
    expect(viaSchedule.response.status()).toBe(403);
    expect(viaSchedule.payload.errorCode).toBe(
      "organizer_edit_participant_owned",
    );

    // The roster PATCH holds the same line for Sid and for the organizer's
    // own row, whose name comes from their account settings.
    for (const [name, error] of [
      ["Sid Self", "This person set their own name in their Releviz account."],
      ["Rory Roster", "Your own name comes from your account settings."],
    ]) {
      const entry = listed.get(name);
      const renamed = await apiJson(
        request,
        "PATCH",
        `/events/roster/${entry.id}?code=${event.code}`,
        token,
        { name: `${name} Renamed`, expectedVersion: entry.version },
      );
      expect({
        name,
        status: renamed.response.status(),
        error: renamed.payload?.error,
      }).toEqual({ name, status: 409, error });
    }
    expect(
      [...(await rosterByName(request, event.code, token)).keys()].sort(),
    ).toEqual(["Rory Roster", "Sid Self"]);
    expect((await ownResponse(request, sid.access, event.code)).name).toBe(
      "Sid Self",
    );
  });

  test("PATCH /events/roster/{id} needs a numeric version, validates the name and phone, and refuses a group deleted elsewhere", async ({
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      personEmail("people-patch", runId),
      "Rory",
      "Roster",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `people-patch ${runId}`,
    });
    await addPersonApi(request, event.code, token, {
      name: "Gil Guard",
      email: personEmail("gil", runId),
    });
    const created = await apiJson(
      request,
      "POST",
      `/events/roster/groups?code=${event.code}`,
      token,
      { name: "Gone" },
    );
    expect(created.response.status()).toBe(201);
    const goneId = created.payload.group.id;
    const deleted = await apiJson(
      request,
      "DELETE",
      `/events/roster/groups/${goneId}?code=${event.code}`,
      token,
    );
    expect(deleted.response.status()).toBe(200);
    const entry = (await rosterByName(request, event.code, token)).get(
      "Gil Guard",
    );
    const version = entry.version;
    const path = `/events/roster/${entry.id}?code=${event.code}`;
    const cases = [
      [{ phone: "+1 555 010 0000" }, 428, "expectedVersion is required"],
      [
        { phone: "+1 555 010 0000", expectedVersion: String(version) },
        428,
        "expectedVersion is required",
      ],
      [
        { phone: "+1 555 010 0000", expectedVersion: true },
        428,
        "expectedVersion is required",
      ],
      [{ name: "   ", expectedVersion: version }, 400, "name is required."],
      [
        { name: "N".repeat(101), expectedVersion: version },
        400,
        "name is too long (max 100).",
      ],
      [
        { phone: "call me maybe", expectedVersion: version },
        400,
        "Enter a valid phone number.",
      ],
      [
        { phone: "1".repeat(33), expectedVersion: version },
        400,
        "Phone is too long (max 32).",
      ],
      // Every field is checked before the first write, so a good name
      // beside a bad phone changes nothing either.
      [
        { name: "Gil Renamed", phone: "12", expectedVersion: version },
        400,
        "Enter a valid phone number.",
      ],
      [
        { addGroupIds: [goneId], expectedVersion: version },
        409,
        "This group was deleted in another session.",
      ],
    ];
    for (const [body, status, message] of cases) {
      const refused = await apiJson(request, "PATCH", path, token, body);
      expect(refused.response.status(), JSON.stringify(body)).toBe(status);
      expect(refused.payload.error, JSON.stringify(body)).toBe(message);
    }
    // Leaving a group that is already gone is simply done.
    const left = await apiJson(request, "PATCH", path, token, {
      removeGroupIds: [goneId],
      expectedVersion: version,
    });
    expect(left.response.status()).toBe(200);
    expect(left.payload.participant).toMatchObject({
      name: "Gil Guard",
      phone: "",
      version,
    });
  });
});
