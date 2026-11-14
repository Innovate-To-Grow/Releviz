const { expect, test } = require("@playwright/test");
const {
  apiJson,
  createEvent,
  importRosterApi,
  latestEmailFor,
  newRunId,
  registerAccountViaApi,
  runDjangoJson,
  setLifecycleViaApi,
  setRateLimitBlock,
  temporaryAccessPathFromEmail,
} = require("./helpers/releviz");
const {
  LIVE_SYNC_TIMEOUT_MS,
  addPersonApi,
  continueToConfirm,
  emailField,
  expectDeliveredAsPreviewed,
  expectToast,
  freezeLiveSync,
  gotoParticipants,
  invitationEmail,
  invitationJobCount,
  openPersonPanel,
  participantActions,
  participantRow,
  reviewEmail,
  rosterByEmail,
  sendInvitationsApi,
  startOrganizerEvent,
  submitOnBehalf,
  tsv,
  waitForInvitationStatus,
} = require("./helpers/participants");
const { wakeLiveSync } = require("./helpers/workspace");

// Invitations from the organizer's Participants section and what becomes of
// them: the send review's skip rules and "Email them again too" from every
// entry point (the Email menu's invite-everyone, the selection bar, a row's
// ⋯ menu, the person panel), the Response badges from Not invited to Started,
// throttled and refused sends, the event delivery card (its states, Show
// failed, Retry failed recipients with its review, Dismiss and its restore),
// and the API-only paths (adding a person with an invitation, the legacy
// batch invitation endpoint, the delivery-request retry endpoints).
//
// A failed or still-queued delivery cannot be produced for real with the
// file email backend, so a test rewrites where its own person's newest
// invitation email stands once the worker has delivered it
// (setInvitationDelivery). Every test registers its own organizer and event
// and asserts only on its own rows, recipients and rate-limit buckets.

const ORGANIZER = "Rory Roster";

function personEmail(slug, runId) {
  return `${slug}-${runId}@example.com`;
}

function subjectFor(event) {
  return `Share your availability for ${event.name}`;
}

// The link a review shows in place of the recipient's private one.
function previewLinkFor(page, event, path = "/temp-access") {
  return `${new URL(page.url()).origin}${path}?code=${event.code}&invitation=preview`;
}

// A row's one Response badge: Submitted once there is an answer, otherwise
// how far the invitation got (Not invited, Sending invite…, Invite failed,
// Invited, Started), or Not submitted for people nobody invites.
function responseBadge(page, name) {
  return participantRow(page, name).locator(".participants-table__response");
}

function listRows(page) {
  return page.locator("#organizer-roster tr.participants-row");
}

function sendDialog(page) {
  return page.getByRole("dialog", { name: "Send invitations" });
}

// Who the send review says gets an invitation, was already invited, has no
// email or is being emailed right now, one line each.
function summaryLines(dialog) {
  return dialog.locator(".participants-send-summary > li");
}

function previewNote(dialog) {
  return dialog.locator(".email-preview__note");
}

function continueButton(dialog) {
  return dialog.getByRole("button", { name: "Continue", exact: true });
}

function resendBox(dialog) {
  return dialog.getByRole("checkbox", { name: "Email them again too" });
}

function deliveryCard(page) {
  return page.getByRole("group", { name: "Event delivery progress" });
}

function cardState(card) {
  return card.locator(".delivery-progress__header .status-badge");
}

function cardMetrics(card) {
  return card.locator(".metric-list__item");
}

function invitationSection(panel) {
  return panel.getByRole("region", { name: "Invitation" });
}

function failedFilterChip(page) {
  return page
    .locator("#organizer-roster")
    .getByRole("button", { name: "Remove filter Response: Invite failed" });
}

async function openRowMenu(page, name) {
  await participantRow(page, name)
    .getByRole("button", { name: `Actions for ${name}` })
    .click();
  const menu = page.getByRole("menu", { name: `Actions for ${name}` });
  await expect(menu).toBeVisible();
  return menu;
}

async function openEmailMenu(page) {
  await participantActions(page)
    .getByRole("button", { name: "Email", exact: true })
    .click();
  const menu = page.getByRole("menu", { name: "Email" });
  await expect(menu).toBeVisible();
  return menu;
}

// The menu takes Escape only from focus inside it, and a click on its
// trigger does not focus the trigger in every engine, so Escape is pressed
// on its first item.
async function closeMenu(menu) {
  await menu.getByRole("menuitem").first().press("Escape");
  await expect(menu).toHaveCount(0);
}

function requestJson(request) {
  try {
    return request.postDataJSON() || {};
  } catch {
    return {};
  }
}

// The next POST /events/roster/invitations: a preview when `preview`, a
// real send otherwise.
function invitationRequest(page, { preview }) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/events/roster/invitations") &&
      (requestJson(response.request()).preview === true) === preview,
  );
}

// The organizer answers on their own event too, so the list has their row.
async function joinOwnEvent(request, token, event) {
  const joined = await apiJson(
    request,
    "POST",
    `/events/participants?code=${event.code}`,
    token,
    {},
  );
  expect([200, 201], JSON.stringify(joined.payload)).toContain(
    joined.response.status(),
  );
}

async function invitationFor(request, token, eventCode, email) {
  const listed = await apiJson(
    request,
    "GET",
    `/events/invitations?code=${eventCode}`,
    token,
  );
  expect(listed.response.status()).toBe(200);
  return listed.payload.invitations.find(
    (invitation) => invitation.email === email.toLowerCase(),
  );
}

// Where this person's newest invitation email on this test's event stands,
// rewritten after the worker delivered it: "queued" waits for a retry a day
// away (the running email worker leaves it alone), "failed" was given up on
// for good. Only the job changes, as when the worker itself retries or gives
// up, so an open workspace hears of it only through what watches the job.
// With `neverDelivered` the invitation also forgets it was sent, as when that
// email was the first and never got through; do that before the workspace
// opens, since clearing the dates is itself a write to the invitation.
// Otherwise it was a resend of an invitation delivered before, or an email
// already rewritten as never delivered. Refuses a job the worker could still
// be holding.
function setInvitationDelivery(
  eventCode,
  email,
  state,
  { neverDelivered = true } = {},
) {
  return runDjangoJson(
    `
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import EventInvitation

now = timezone.now()
with transaction.atomic():
    invitation = EventInvitation.objects.get(
        event__code=data["code"], email__iexact=data["email"]
    )
    job = (
        EmailDeliveryJob.objects.select_for_update()
        .filter(invitation=invitation, message_type="invitation")
        .order_by("-created_at", "-pk")
        .first()
    )
    assert job.status in {
        EmailDeliveryJob.Status.SENT,
        EmailDeliveryJob.Status.RETRY,
    }, job.status
    if data["state"] == "queued":
        changes = {
            "status": EmailDeliveryJob.Status.RETRY,
            "next_attempt_at": now + timedelta(days=1),
            "last_error": "The provider timed out; trying again later.",
        }
    else:
        changes = {
            "status": EmailDeliveryJob.Status.PERMANENT_FAILURE,
            "attempt_count": job.max_attempts,
            "last_error": "The provider rejected the address.",
        }
    EmailDeliveryJob.objects.filter(pk=job.pk).update(
        sent_at=None,
        provider_message_id="",
        locked_at=None,
        lock_token=None,
        updated_at=now,
        **changes,
    )
    if data["neverDelivered"]:
        EventInvitation.objects.filter(pk=invitation.pk).update(
            first_sent_at=None, last_sent_at=None
        )
print(json.dumps(job.pk))
`,
    { code: eventCode, email, state, neverDelivered },
  );
}

// The statuses of every invitation email this event queued for `email`,
// oldest first.
function invitationJobStatuses(eventCode, email) {
  return runDjangoJson(
    `
from apps.mail.models import EmailDeliveryJob

print(json.dumps(list(
    EmailDeliveryJob.objects.filter(
        event__code=data["code"],
        message_type="invitation",
        recipient__iexact=data["email"],
    )
    .order_by("created_at", "pk")
    .values_list("status", flat=True)
)))
`,
    { code: eventCode, email },
  );
}

test.describe("Sending invitations", () => {
  test("Invite everyone not invited yet sends the not-sent filter, skips people with no email or an email in flight, and tries a failed first delivery again", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "invite-all",
    );
    const emails = Object.fromEntries(
      ["pia", "rex", "fay", "sid", "ola"].map((slug) => [
        slug,
        personEmail(slug, runId),
      ]),
    );
    await joinOwnEvent(request, token, event);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Pia Pending", emails.pia],
        ["Rex Ready", emails.rex],
        ["Fay Failed", emails.fay],
        ["Sid Sending", emails.sid],
        ["Ola Sent", emails.ola],
      ]),
    );
    await addPersonApi(request, event.code, token, {
      name: "Quinn NoEmail",
      organizerManaged: true,
    });
    const byEmail = await rosterByEmail(request, event.code, token);
    await sendInvitationsApi(
      request,
      event.code,
      token,
      [emails.fay, emails.sid, emails.ola].map(
        (email) => byEmail.get(email).id,
      ),
    );
    for (const email of [emails.fay, emails.sid, emails.ola]) {
      await waitForInvitationStatus(request, event.code, token, email, "sent");
    }
    // Fay's first invitation never got through; Sid's is still on its way.
    setInvitationDelivery(event.code, emails.fay, "failed");
    setInvitationDelivery(event.code, emails.sid, "queued");

    await gotoParticipants(page, event);
    for (const [name, badge] of [
      ["Pia Pending", "Not invited"],
      ["Rex Ready", "Not invited"],
      ["Fay Failed", "Invite failed"],
      ["Sid Sending", "Sending invite…"],
      ["Ola Sent", "Invited"],
      ["Quinn NoEmail", "Not submitted"],
      [ORGANIZER, "Not submitted"],
    ]) {
      await expect(responseBadge(page, name)).toHaveText(badge);
    }

    // The event has reminders off, so the menu says so and offers no run.
    // Everyone not invited yet counts Fay (her email failed) but neither
    // Sid (his is on its way) nor the people who can never be emailed.
    const menu = await openEmailMenu(page);
    await expect(menu.locator(".participants-menu__header")).toHaveText(
      "Reminders are off",
    );
    await expect(
      menu.getByRole("menuitem", { name: "Send reminders (1)…" }),
    ).toBeDisabled();
    const previewed = invitationRequest(page, { preview: true });
    await menu
      .getByRole("menuitem", { name: "Invite everyone not invited yet (3)…" })
      .click();
    expect(requestJson((await previewed).request())).toEqual({
      filter: { invitationStatus: "not_sent" },
      resend: false,
      preview: true,
    });
    const dialog = sendDialog(page);
    const previewLink = previewLinkFor(page, event);
    const envelope = await reviewEmail(dialog, {
      summary: [
        "3 will get an invitation now",
        "1 has no email of their own and is never emailed",
        "1 is being sent right now",
      ],
      to: emails.pia,
      subject: subjectFor(event),
      heading: "You're invited",
      link: { name: "Share your availability", href: previewLink },
      text: [`Event: ${event.name}`, `Link: ${previewLink}`],
    });
    // Your own row is left out without a line of its own.
    await expect(summaryLines(dialog)).toHaveCount(3);
    await expect(previewNote(dialog)).toHaveText(
      "Shown for Pia Pending. Each person gets their own private link.",
    );
    const send = await continueToConfirm(
      dialog,
      "Send 3 invitations now?",
      "Send 3 invitations",
    );
    const startedAt = Date.now() - 1000;
    const sent = invitationRequest(page, { preview: false });
    await send.click();
    const reply = await sent;
    expect(reply.status()).toBe(202);
    expect(requestJson(reply.request())).toEqual({
      filter: { invitationStatus: "not_sent" },
      resend: false,
      idempotencyKey: expect.any(String),
    });
    expect(await reply.json()).toEqual(
      expect.objectContaining({
        requestedCount: 6,
        queuedCount: 3,
        skippedCount: 3,
        skipped: { alreadyInvited: 0, noEmail: 1, organizer: 1, inFlight: 1 },
      }),
    );
    await expect(dialog).toHaveCount(0);
    await expectToast(
      page,
      "Queued 3 invitations. Skipped 1 without an email.",
    );

    const piaInvitation = await latestEmailFor(
      emails.pia,
      startedAt,
      invitationEmail(event.code),
    );
    expectDeliveredAsPreviewed(piaInvitation, envelope, emails.pia);
    expect(piaInvitation).not.toContain("invitation=preview");
    for (const email of [emails.rex, emails.fay]) {
      await latestEmailFor(email, startedAt, invitationEmail(event.code));
    }
    for (const email of [emails.pia, emails.rex, emails.fay]) {
      await waitForInvitationStatus(request, event.code, token, email, "sent");
    }
    expect(invitationJobCount(event.code, emails.fay)).toBe(2);
    expect(invitationJobCount(event.code, emails.sid)).toBe(1);
    expect(invitationJobCount(event.code, emails.ola)).toBe(1);

    const card = deliveryCard(page);
    await expect(card.getByText("Invitation delivery")).toBeVisible();
    await expect(cardState(card)).toHaveText("Complete", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(cardMetrics(card)).toHaveText([
      "3 total",
      "3 sent",
      "0 queued",
      "0 failed",
    ]);
    for (const name of ["Pia Pending", "Rex Ready", "Fay Failed"]) {
      await expect(responseBadge(page, name)).toHaveText("Invited", {
        timeout: LIVE_SYNC_TIMEOUT_MS,
      });
    }
    await expect(responseBadge(page, "Sid Sending")).toHaveText(
      "Sending invite…",
    );

    // Nobody is left to invite: the review says who is skipped and why, and
    // offers nothing to send.
    await (
      await openEmailMenu(page)
    )
      .getByRole("menuitem", { name: "Invite everyone not invited yet (0)…" })
      .click();
    await expect(summaryLines(dialog)).toHaveText([
      "1 has no email of their own and is never emailed",
      "1 is being sent right now",
    ]);
    await expect(
      dialog.getByText("Nobody in this selection can be invited."),
    ).toBeVisible();
    await expect(continueButton(dialog)).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("the selection and a row's ⋯ menu skip people already invited unless Email them again too is ticked", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "invite-resend",
    );
    const emails = Object.fromEntries(
      ["ola", "pia", "rex"].map((slug) => [slug, personEmail(slug, runId)]),
    );
    await joinOwnEvent(request, token, event);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Ola Sent", emails.ola],
        ["Pia Pending", emails.pia],
        ["Rex Ready", emails.rex],
      ]),
    );
    await addPersonApi(request, event.code, token, {
      name: "Quinn NoEmail",
      organizerManaged: true,
    });
    const byEmail = await rosterByEmail(request, event.code, token);
    await sendInvitationsApi(request, event.code, token, [
      byEmail.get(emails.ola).id,
    ]);
    await waitForInvitationStatus(
      request,
      event.code,
      token,
      emails.ola,
      "sent",
    );
    await gotoParticipants(page, event);
    const dialog = sendDialog(page);

    // A row's ⋯ menu invites one person.
    let menu = await openRowMenu(page, "Rex Ready");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Details",
      "Send invitation",
      "Leave out of results",
      "Remove from event…",
    ]);
    await menu
      .getByRole("menuitem", { name: "Send invitation", exact: true })
      .click();
    await reviewEmail(dialog, {
      summary: ["1 will get an invitation now"],
      to: emails.rex,
      subject: subjectFor(event),
      heading: "You're invited",
    });
    let send = await continueToConfirm(
      dialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    let startedAt = Date.now() - 1000;
    let sent = invitationRequest(page, { preview: false });
    await send.click();
    let reply = await sent;
    expect(reply.status()).toBe(202);
    expect(requestJson(reply.request())).toEqual(
      expect.objectContaining({
        participantIds: [byEmail.get(emails.rex).id],
        resend: false,
      }),
    );
    expect(await reply.json()).toEqual(
      expect.objectContaining({
        requestedCount: 1,
        queuedCount: 1,
        skippedCount: 0,
      }),
    );
    await expectToast(page, "Queued 1 invitation.");
    await latestEmailFor(emails.rex, startedAt, invitationEmail(event.code));

    // A selection: one person to invite, one already invited, one with no
    // email and your own row. "Email them again too" previews the email the
    // first already-invited person would get, and unticking it goes back.
    for (const name of [
      "Ola Sent",
      "Pia Pending",
      "Quinn NoEmail",
      ORGANIZER,
    ]) {
      await page.getByLabel(`Select ${name}`, { exact: true }).check();
    }
    const bar = page.getByRole("region", { name: "Selected people" });
    await expect(bar.getByRole("status")).toHaveText("4 selected");
    await bar.getByRole("button", { name: "Send invitation…" }).click();
    await expect(summaryLines(dialog)).toHaveText([
      "1 will get an invitation now",
      /^1 was already invited/,
      "1 has no email of their own and is never emailed",
    ]);
    await expect(previewNote(dialog)).toHaveText(
      "Shown for Pia Pending. Each person gets their own private link.",
    );
    await expect(resendBox(dialog)).not.toBeChecked();
    const resendPreview = invitationRequest(page, { preview: true });
    await resendBox(dialog).check();
    expect(requestJson((await resendPreview).request())).toEqual(
      expect.objectContaining({ resend: true, preview: true }),
    );
    await expect(previewNote(dialog)).toHaveText(
      "Shown for Ola Sent. Each person gets their own private link.",
    );
    await expect(emailField(dialog, "To")).toContainText(emails.ola);
    await continueButton(dialog).click();
    await expect(
      dialog.getByRole("heading", { name: "Send 2 invitations now?" }),
    ).toBeFocused();
    await dialog.getByRole("button", { name: "Back" }).click();
    await resendBox(dialog).uncheck();
    await expect(previewNote(dialog)).toHaveText(
      "Shown for Pia Pending. Each person gets their own private link.",
    );
    send = await continueToConfirm(
      dialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    startedAt = Date.now() - 1000;
    sent = invitationRequest(page, { preview: false });
    await send.click();
    reply = await sent;
    expect(reply.status()).toBe(202);
    expect(await reply.json()).toEqual(
      expect.objectContaining({
        requestedCount: 4,
        queuedCount: 1,
        skipped: { alreadyInvited: 1, noEmail: 1, organizer: 1, inFlight: 0 },
      }),
    );
    await expectToast(
      page,
      "Queued 1 invitation. Skipped 1 already invited and 1 without an email.",
    );
    await expect(bar).toHaveCount(0);
    await latestEmailFor(emails.pia, startedAt, invitationEmail(event.code));
    expect(invitationJobCount(event.code, emails.ola)).toBe(1);

    // Ola's ⋯ menu resends: nobody gets one until Email them again too is
    // ticked.
    menu = await openRowMenu(page, "Ola Sent");
    await expect(
      menu.getByRole("menuitem", { name: "Send invitation", exact: true }),
    ).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Resend invitation" }).click();
    await expect(summaryLines(dialog)).toHaveText([/^1 was already invited/]);
    await expect(
      dialog.getByText("Nobody in this selection can be invited."),
    ).toBeVisible();
    await expect(continueButton(dialog)).toBeDisabled();
    await resendBox(dialog).check();
    const resendEnvelope = await reviewEmail(dialog, {
      to: emails.ola,
      subject: subjectFor(event),
      heading: "You're invited",
    });
    await expect(previewNote(dialog)).toHaveText(
      "Shown for Ola Sent. Each person gets their own private link.",
    );
    send = await continueToConfirm(
      dialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    startedAt = Date.now() - 1000;
    sent = invitationRequest(page, { preview: false });
    await send.click();
    reply = await sent;
    expect(requestJson(reply.request())).toEqual(
      expect.objectContaining({
        participantIds: [byEmail.get(emails.ola).id],
        resend: true,
      }),
    );
    expect(await reply.json()).toEqual(
      expect.objectContaining({ queuedCount: 1, skippedCount: 0 }),
    );
    await expectToast(page, "Queued 1 invitation.");
    const resent = await latestEmailFor(
      emails.ola,
      startedAt,
      invitationEmail(event.code),
    );
    expectDeliveredAsPreviewed(resent, resendEnvelope, emails.ola);
    expect(invitationJobCount(event.code, emails.ola)).toBe(2);

    // Nobody can be invited from Quinn's row or your own.
    for (const name of ["Quinn NoEmail", ORGANIZER]) {
      menu = await openRowMenu(page, name);
      await expect(menu.getByRole("menuitem")).toHaveText([
        "Details",
        "Leave out of results",
        "Remove from event…",
      ]);
      await closeMenu(menu);
    }
  });

  test("the person panel's Invitation section sends and resends, and waits while an email is on its way", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "invite-panel",
    );
    const pia = personEmail("pia", runId);
    const sid = personEmail("sid", runId);
    await joinOwnEvent(request, token, event);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Pia Pending", pia],
        ["Sid Sending", sid],
      ]),
    );
    await addPersonApi(request, event.code, token, {
      name: "Quinn NoEmail",
      organizerManaged: true,
    });
    // Sid was invited, and a resend is now waiting for a retry.
    const sidId = (await rosterByEmail(request, event.code, token)).get(sid).id;
    await sendInvitationsApi(request, event.code, token, [sidId]);
    await waitForInvitationStatus(request, event.code, token, sid, "sent");
    await sendInvitationsApi(request, event.code, token, [sidId], {
      resend: true,
    });
    await expect
      .poll(() => invitationJobStatuses(event.code, sid), { timeout: 20_000 })
      .toEqual(["sent", "sent"]);
    setInvitationDelivery(event.code, sid, "queued", { neverDelivered: false });

    await gotoParticipants(page, event);
    const dialog = sendDialog(page);
    let panel = await openPersonPanel(page, "Pia Pending");
    let section = invitationSection(panel);
    await expect(section.locator(".status-badge")).toHaveText("Not sent");
    await section.getByRole("button", { name: "Send invitation" }).click();
    await reviewEmail(dialog, {
      summary: ["1 will get an invitation now"],
      to: pia,
      subject: subjectFor(event),
      heading: "You're invited",
    });
    let send = await continueToConfirm(
      dialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    let startedAt = Date.now() - 1000;
    await send.click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, "Queued 1 invitation.");
    await latestEmailFor(pia, startedAt, invitationEmail(event.code));
    // The panel follows the list: once the email is out it reads Sent on
    // its date and offers a resend.
    await expect(section.locator(".status-badge")).toHaveText(/^Sent on .+$/, {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    const resend = section.getByRole("button", { name: "Resend" });
    await expect(resend).toBeEnabled();

    await resend.click();
    await expect(summaryLines(dialog)).toHaveText([/^1 was already invited/]);
    await expect(
      dialog.getByText("Nobody in this selection can be invited."),
    ).toBeVisible();
    await resendBox(dialog).check();
    await expect(previewNote(dialog)).toHaveText(
      "Shown for Pia Pending. Each person gets their own private link.",
    );
    send = await continueToConfirm(
      dialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    startedAt = Date.now() - 1000;
    await send.click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, "Queued 1 invitation.");
    await latestEmailFor(pia, startedAt, invitationEmail(event.code));
    expect(invitationJobCount(event.code, pia)).toBe(2);
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toHaveCount(0);

    // Sid's resend is still on its way, so there is nothing to send yet.
    await expect(responseBadge(page, "Sid Sending")).toHaveText(
      "Sending invite…",
    );
    panel = await openPersonPanel(page, "Sid Sending");
    section = invitationSection(panel);
    await expect(section.locator(".status-badge")).toHaveText("Sending…");
    await expect(
      section.getByRole("button", { name: "Resend" }),
    ).toBeDisabled();
    await panel.getByRole("button", { name: "Cancel" }).click();

    // Nobody invites Quinn (no email) or you.
    panel = await openPersonPanel(page, "Quinn NoEmail");
    await expect(
      panel.getByText(
        "They are never emailed until they have an address of their own.",
      ),
    ).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: "Invitation" }),
    ).toHaveCount(0);
    await panel.getByRole("button", { name: "Cancel" }).click();
    await participantRow(page, ORGANIZER)
      .locator("button.participants-row__name")
      .click();
    panel = page.getByRole("dialog", { name: `${ORGANIZER} (you)` });
    await expect(panel.getByText("Your own row.")).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: "Invitation" }),
    ).toHaveCount(0);
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toHaveCount(0);
  });

  test("the person panel dates a sent invitation (Sent on …)", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "invite-sent-on",
    );
    const pia = personEmail("pia", runId);
    const added = await addPersonApi(request, event.code, token, {
      name: "Pia Pending",
      email: pia,
      sendInvitation: true,
    });
    expect(added.autoInvitedCount).toBe(1);
    await waitForInvitationStatus(request, event.code, token, pia, "sent");
    await gotoParticipants(page, event);
    const panel = await openPersonPanel(page, "Pia Pending");
    const badge = invitationSection(panel).locator(".status-badge");
    await expect(badge).toHaveText(/^Sent/);
    // The row is loaded by now, so its date would already be showing.
    await expect(badge).toHaveText(/^Sent on \S.*\d{4}/, { timeout: 2_000 });
  });

  test("a throttled send closes the review with a notice, while a refused send or preview keeps its error in the review", async ({
    page,
    request,
  }) => {
    const { runId, token, event, organizerEmail } = await startOrganizerEvent(
      { page, request },
      "invite-errors",
    );
    const pia = personEmail("pia", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Pia Pending", pia],
      ]),
    );
    const piaId = (await rosterByEmail(request, event.code, token)).get(pia).id;

    // With this organizer's request budget spent, a preview still answers
    // (it emails nobody) but a send is throttled.
    setRateLimitBlock(organizerEmail, "invitation_request");
    try {
      const preview = await sendInvitationsApi(
        request,
        event.code,
        token,
        [piaId],
        { preview: true },
      );
      expect(preview).toEqual(
        expect.objectContaining({ preview: true, willSend: 1 }),
      );
      const throttled = await apiJson(
        request,
        "POST",
        `/events/roster/invitations?code=${event.code}`,
        token,
        {
          participantIds: [piaId],
          resend: false,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      expect(throttled.response.status()).toBe(429);

      await gotoParticipants(page, event);
      await (
        await openRowMenu(page, "Pia Pending")
      )
        .getByRole("menuitem", { name: "Send invitation", exact: true })
        .click();
      const dialog = sendDialog(page);
      await expect(summaryLines(dialog)).toHaveText([
        "1 will get an invitation now",
      ]);
      const send = await continueToConfirm(
        dialog,
        "Send 1 invitation now?",
        "Send 1 invitation",
      );
      const sent = invitationRequest(page, { preview: false });
      await send.click();
      expect((await sent).status()).toBe(429);
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Notifications" }).getByRole("alert"),
      ).toHaveText("Too many invitation requests. Try again in a few minutes.");
      await expectToast(
        page,
        "Too many invitation requests. Try again in a few minutes.",
      );
    } finally {
      setRateLimitBlock(organizerEmail, "invitation_request", {
        blocked: false,
      });
    }
    expect(invitationJobCount(event.code, pia)).toBe(0);

    // The event closes in another session while the review is open. The
    // workspace has not heard yet, so the send is refused and the error stays
    // on the confirmation with the send still offered.
    const emailButton = participantActions(page).getByRole("button", {
      name: "Email",
      exact: true,
    });
    await expect(emailButton).toBeVisible();
    const dialog = sendDialog(page);
    await (
      await openRowMenu(page, "Pia Pending")
    )
      .getByRole("menuitem", { name: "Send invitation", exact: true })
      .click();
    await expect(summaryLines(dialog)).toHaveText([
      "1 will get an invitation now",
    ]);
    const send = await continueToConfirm(
      dialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    const release = await freezeLiveSync(page);
    try {
      await setLifecycleViaApi(request, token, event.code, "closed");
      const sent = invitationRequest(page, { preview: false });
      await send.click();
      expect((await sent).status()).toBe(409);
      await expect(
        dialog.getByRole("heading", { name: "Send 1 invitation now?" }),
      ).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveText(
        "Responses cannot change while the event is closed.",
      );
      await expect(send).toBeEnabled();
      await dialog.getByRole("button", { name: "Close dialog" }).click();
      await expect(dialog).toHaveCount(0);

      // A new review cannot even count who would get one.
      const previewed = invitationRequest(page, { preview: true });
      await (
        await openRowMenu(page, "Pia Pending")
      )
        .getByRole("menuitem", { name: "Send invitation", exact: true })
        .click();
      expect((await previewed).status()).toBe(409);
      await expect(dialog.getByRole("alert")).toHaveText(
        "Responses cannot change while the event is closed.",
      );
      await expect(
        dialog.getByText("Preparing the email preview…"),
      ).toBeVisible();
      await expect(continueButton(dialog)).toBeDisabled();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await release();
    }
    // Once the workspace hears of the close, nothing can be sent at all.
    await wakeLiveSync(page);
    await expect(emailButton).toHaveCount(0, {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    expect(invitationJobCount(event.code, pia)).toBe(0);
  });

  test("a respondent's own save moves their invitation from Invited to Started for the organizer, while opening the link or a response entered for them does not", async ({
    page,
    request,
    browser,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "invite-accepted",
    );
    const pia = personEmail("pia", runId);
    const rex = personEmail("rex", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Pia Pending", pia],
        ["Rex Ready", rex],
      ]),
    );
    const byEmail = await rosterByEmail(request, event.code, token);
    const sentAt = Date.now() - 1000;
    await sendInvitationsApi(request, event.code, token, [
      byEmail.get(pia).id,
      byEmail.get(rex).id,
    ]);
    const piaInvitation = await latestEmailFor(
      pia,
      sentAt,
      invitationEmail(event.code),
    );
    for (const email of [pia, rex]) {
      await waitForInvitationStatus(request, event.code, token, email, "sent");
    }
    await gotoParticipants(page, event);
    await expect(responseBadge(page, "Pia Pending")).toHaveText("Invited");
    await expect(responseBadge(page, "Rex Ready")).toHaveText("Invited");

    // A response the organizer enters for Rex moves his invitation on (so
    // reminders skip him) but is not his acceptance: his row reads
    // Submitted, and his invitation still reads Sent in his panel.
    await submitOnBehalf(request, token, event, byEmail.get(rex));
    await expect(responseBadge(page, "Rex Ready")).toHaveText("Submitted", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    expect(await invitationFor(request, token, event.code, rex)).toEqual(
      expect.objectContaining({ status: "submitted", acceptedAt: null }),
    );
    expect(
      (await rosterByEmail(request, event.code, token)).get(rex)
        .invitationStatus,
    ).toBe("sent");
    let panel = await openPersonPanel(page, "Rex Ready");
    await expect(invitationSection(panel).locator(".status-badge")).toHaveText(
      /^Sent on .+$/,
    );
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toHaveCount(0);

    const context = await browser.newContext();
    try {
      const piaPage = await context.newPage();
      // The link alone opens Pia's schedule, which marks the invitation
      // opened; the organizer still sees it as Invited.
      await piaPage.goto(temporaryAccessPathFromEmail(piaInvitation));
      await expect(
        piaPage.getByText("You are responding as Pia Pending"),
      ).toBeVisible();
      expect(await invitationFor(request, token, event.code, pia)).toEqual(
        expect.objectContaining({
          status: "opened",
          openedAt: expect.any(String),
          acceptedAt: null,
        }),
      );
      expect(
        (await rosterByEmail(request, event.code, token)).get(pia)
          .invitationStatus,
      ).toBe("sent");
      await expect(responseBadge(page, "Pia Pending")).toHaveText("Invited");

      // Pia's own first save is her acceptance.
      const saved = piaPage.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().includes("/events/temp-access/participant?"),
      );
      await piaPage
        .getByRole("grid", { name: "Availability" })
        .locator('[data-cell-idx="0"]')
        .click();
      expect((await saved).status()).toBe(200);
    } finally {
      await context.close();
    }
    await expect(responseBadge(page, "Pia Pending")).toHaveText("Started", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    expect(await invitationFor(request, token, event.code, pia)).toEqual(
      expect.objectContaining({
        status: "draft_saved",
        acceptedAt: expect.any(String),
        joinedAt: expect.any(String),
      }),
    );
    expect(
      (await rosterByEmail(request, event.code, token)).get(pia)
        .invitationStatus,
    ).toBe("accepted");
    panel = await openPersonPanel(page, "Pia Pending");
    const section = invitationSection(panel);
    await expect(section.locator(".status-badge")).toHaveText("Accepted");
    await expect(section.getByRole("button", { name: "Resend" })).toBeEnabled();
  });
});

test.describe("Event delivery card", () => {
  test("follows a run into Needs attention, Show failed lists the failed people, and Retry failed recipients reviews then sends the current ones again", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "delivery-retry",
    );
    const emails = Object.fromEntries(
      ["fay", "gus", "ola"].map((slug) => [slug, personEmail(slug, runId)]),
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Fay Failed", emails.fay],
        ["Gus Good", emails.gus],
        ["Ola Gone", emails.ola],
      ]),
    );
    const byEmail = await rosterByEmail(request, event.code, token);
    const run = await sendInvitationsApi(
      request,
      event.code,
      token,
      Object.values(emails).map((email) => byEmail.get(email).id),
    );
    const requestId = run.deliveryRequest.id;
    for (const email of Object.values(emails)) {
      await waitForInvitationStatus(request, event.code, token, email, "sent");
    }
    // Fay's email is waiting for a retry; Ola's failed, and Ola has since
    // been removed from the event.
    setInvitationDelivery(event.code, emails.fay, "queued");
    setInvitationDelivery(event.code, emails.ola, "failed");
    const removed = await apiJson(
      request,
      "DELETE",
      `/events/roster/${byEmail.get(emails.ola).id}?code=${event.code}`,
      token,
    );
    expect(removed.response.status()).toBe(200);

    // A fresh tab has nothing stored, so the card comes from the listing.
    await gotoParticipants(page, event);
    const card = deliveryCard(page);
    await expect(card.getByText("Invitation delivery")).toBeVisible();
    await expect(cardState(card)).toHaveText("In progress");
    await expect(cardMetrics(card)).toHaveText([
      "3 total",
      "1 sent",
      "1 queued",
      "1 failed",
    ]);
    const retryButton = card.getByRole("button", {
      name: "Retry failed recipients",
    });
    await expect(retryButton).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Show failed" }),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
    await expect(responseBadge(page, "Fay Failed")).toHaveText(
      "Sending invite…",
    );

    // The card follows the run on its own when Fay's email is given up on.
    // (Whether her row does too is the expected failure below.)
    setInvitationDelivery(event.code, emails.fay, "failed", {
      neverDelivered: false,
    });
    await expect(cardState(card)).toHaveText("Needs attention", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(cardMetrics(card)).toHaveText([
      "3 total",
      "1 sent",
      "0 queued",
      "2 failed",
    ]);
    await expect(card.getByRole("button", { name: "Dismiss" })).toBeVisible();

    // Show failed filters the list to them and moves focus to it.
    await card.getByRole("button", { name: "Show failed" }).click();
    await expect(failedFilterChip(page)).toBeVisible();
    await expect(listRows(page)).toHaveCount(1);
    await expect(responseBadge(page, "Fay Failed")).toHaveText("Invite failed");
    await expect(page.locator("#organizer-roster-heading")).toBeFocused();
    const panel = await openPersonPanel(page, "Fay Failed");
    await expect(invitationSection(panel).locator(".status-badge")).toHaveText(
      "Failed",
    );
    await expect(
      invitationSection(panel).getByRole("button", { name: "Send invitation" }),
    ).toBeEnabled();
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toHaveCount(0);

    // A server that answers the review URL with anything but a review (one
    // that retried at once, say) is an error, not "nothing to send".
    const previewPath = `/events/delivery-requests/${requestId}/retry-preview`;
    const previewRoute = (url) => url.pathname.endsWith(previewPath);
    await page.route(previewRoute, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: {
          deliveryRequest: { id: requestId, operation: "invitation" },
          retried: 1,
          canceled: 1,
        },
      });
    });
    const retryDialog = page.getByRole("dialog", {
      name: "Retry failed recipients",
    });
    try {
      await retryButton.click();
      await expect(retryDialog.getByRole("alert")).toHaveText(
        "Unable to check which emails can be sent again.",
      );
      await expect(
        retryDialog.getByText("There are no failed emails to send again."),
      ).toHaveCount(0);
      await expect(continueButton(retryDialog)).toBeDisabled();
      await retryDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(retryDialog).toHaveCount(0);
    } finally {
      await page.unroute(previewRoute);
    }
    expect(invitationJobStatuses(event.code, emails.fay)).toEqual([
      "permanent_failure",
    ]);

    // The review: Fay's email goes out again as it was written; Ola's is no
    // longer current and is canceled.
    const reviewed = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(previewPath),
    );
    await retryButton.click();
    expect(await (await reviewed).json()).toEqual(
      expect.objectContaining({ preview: true, retryable: 1, obsolete: 1 }),
    );
    const previewLink = previewLinkFor(page, event);
    const envelope = await reviewEmail(retryDialog, {
      summary: [
        "1 failed email will be sent again",
        "1 is no longer current and will be canceled",
      ],
      to: emails.fay,
      subject: subjectFor(event),
      heading: "You're invited",
      link: { name: "Share your availability", href: previewLink },
      text: [`Link: ${previewLink}`],
    });
    await expect(previewNote(retryDialog)).toHaveText(
      "Shown for Fay Failed. Each email goes out again as it was written.",
    );
    const sendAgain = await continueToConfirm(
      retryDialog,
      "Send 1 email again now?",
      "Send 1 again",
    );
    const retriedAt = Date.now() - 1000;
    const retried = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith(
          `/events/delivery-requests/${requestId}`,
        ),
    );
    await sendAgain.click();
    const retryReply = await retried;
    expect(retryReply.status()).toBe(202);
    expect(await retryReply.json()).toEqual(
      expect.objectContaining({ retried: 1, canceled: 1 }),
    );
    await expect(retryDialog).toHaveCount(0);
    const delivered = await latestEmailFor(
      emails.fay,
      retriedAt,
      invitationEmail(event.code),
    );
    expectDeliveredAsPreviewed(delivered, envelope, emails.fay);
    expect(delivered).not.toContain("invitation=preview");
    await expect(cardState(card)).toHaveText("Complete", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(cardMetrics(card)).toHaveText([
      "3 total",
      "2 sent",
      "0 queued",
      "0 failed",
      "1 canceled",
    ]);
    await expect(retryButton).toHaveCount(0);

    // Nobody has a failed invitation any more.
    await expect(
      page.getByRole("heading", { name: "No matching participants." }),
    ).toBeVisible({ timeout: LIVE_SYNC_TIMEOUT_MS });
    await failedFilterChip(page).click();
    await expect(listRows(page)).toHaveCount(2);
    await expect(responseBadge(page, "Fay Failed")).toHaveText("Invited");
    await expect(responseBadge(page, "Gus Good")).toHaveText("Invited");
  });

  test("a row's Sending invite… badge turns Invite failed on its own once the email is given up on", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "delivery-row-live",
    );
    const fay = personEmail("fay", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Fay Failed", fay],
      ]),
    );
    const fayId = (await rosterByEmail(request, event.code, token)).get(fay).id;
    await sendInvitationsApi(request, event.code, token, [fayId]);
    await waitForInvitationStatus(request, event.code, token, fay, "sent");
    // Fay's first invitation email is still waiting for another try.
    setInvitationDelivery(event.code, fay, "queued");

    await gotoParticipants(page, event);
    const card = deliveryCard(page);
    await expect(cardState(card)).toHaveText("In progress");
    await expect(responseBadge(page, "Fay Failed")).toHaveText(
      "Sending invite…",
    );

    // The worker gives up on it. The card hears of that on its own, and a
    // live-sync pass then runs for the list too.
    setInvitationDelivery(event.code, fay, "failed", { neverDelivered: false });
    await expect(cardState(card)).toHaveText("Needs attention", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await wakeLiveSync(page);
    await expect(responseBadge(page, "Fay Failed")).toHaveText(
      "Invite failed",
      { timeout: LIVE_SYNC_TIMEOUT_MS },
    );
  });

  test("a finished run can be dismissed for good, comes back from the server in a new tab, and a new run shows again", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "delivery-dismiss",
    );
    const gus = personEmail("gus", runId);
    const hal = personEmail("hal", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Gus Good", gus],
        ["Hal Hopeful", hal],
      ]),
    );
    const byEmail = await rosterByEmail(request, event.code, token);
    await sendInvitationsApi(request, event.code, token, [byEmail.get(gus).id]);
    await waitForInvitationStatus(request, event.code, token, gus, "sent");

    await gotoParticipants(page, event);
    const card = deliveryCard(page);
    await expect(card.getByText("Invitation delivery")).toBeVisible();
    await expect(cardState(card)).toHaveText("Complete");
    await expect(cardMetrics(card)).toHaveText([
      "1 total",
      "1 sent",
      "0 queued",
      "0 failed",
    ]);
    await expect(
      card.getByRole("button", { name: "Retry failed recipients" }),
    ).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Show failed" })).toHaveCount(
      0,
    );

    // A reload brings the run back.
    await page.reload();
    await expect(participantRow(page, "Gus Good")).toBeVisible();
    await expect(cardState(card)).toHaveText("Complete");

    // Dismissed, it stays away through reloads and list reloads, although
    // every listing still names it as the latest run.
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);
    const listed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/events/roster") &&
        response.request().method() === "GET",
    );
    await page.reload();
    const listing = await (await listed).json();
    expect(listing.latestDeliveryRequest).toEqual(
      expect.objectContaining({ operation: "invitation", recipientCount: 1 }),
    );
    await expect(participantRow(page, "Gus Good")).toBeVisible();
    await expect(card).toHaveCount(0);
    await page
      .getByRole("searchbox", { name: "Search participants" })
      .fill("Gus");
    await expect(listRows(page)).toHaveCount(1);
    await expect(card).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search participants" }).fill("");
    await expect(listRows(page)).toHaveCount(2);

    // What is dismissed is remembered per tab: a new tab gets the run from
    // the server again.
    const otherTab = await page.context().newPage();
    try {
      await gotoParticipants(otherTab, event);
      const otherCard = deliveryCard(otherTab);
      await expect(otherCard.getByText("Invitation delivery")).toBeVisible();
      await expect(cardState(otherCard)).toHaveText("Complete");
      await expect(cardMetrics(otherCard)).toHaveText([
        "1 total",
        "1 sent",
        "0 queued",
        "0 failed",
      ]);
    } finally {
      await otherTab.close();
    }

    // A new run shows in the tab that dismissed the last one, and the
    // notice's View progress brings it into view.
    await (
      await openRowMenu(page, "Hal Hopeful")
    )
      .getByRole("menuitem", { name: "Send invitation", exact: true })
      .click();
    const dialog = sendDialog(page);
    await expect(summaryLines(dialog)).toHaveText([
      "1 will get an invitation now",
    ]);
    const send = await continueToConfirm(
      dialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    await send.click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByText("1 total")).toBeVisible();
    // The list sits well below the card.
    await page.locator("#organizer-roster").scrollIntoViewIfNeeded();
    await expect(card).not.toBeInViewport();
    await page
      .getByRole("region", { name: "Notifications" })
      .locator(".participants-toast", { hasText: "Queued 1 invitation." })
      .getByRole("button", { name: "View progress" })
      .click();
    await expect(card).toBeInViewport();
    await expect(cardState(card)).toHaveText("Complete", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await waitForInvitationStatus(request, event.code, token, hal, "sent");
  });

  test("the retry endpoints refuse a preview flag, a run with nothing current left, and other accounts", async ({
    request,
  }) => {
    const runId = newRunId();
    const { access: token } = await registerAccountViaApi(
      request,
      personEmail("retry-api", runId),
      "Rhea",
      "Retry",
    );
    const event = await createEvent(request, token, {
      name: `Retry API ${runId}`,
    });
    const ivy = personEmail("ivy", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Ivy Invitee", ivy],
      ]),
    );
    const ivyId = (await rosterByEmail(request, event.code, token)).get(ivy).id;
    const run = await sendInvitationsApi(request, event.code, token, [ivyId]);
    const requestId = run.deliveryRequest.id;
    await waitForInvitationStatus(request, event.code, token, ivy, "sent");
    setInvitationDelivery(event.code, ivy, "failed");
    const runUrl = `/events/delivery-requests/${requestId}`;

    const status = await apiJson(request, "GET", runUrl, token);
    expect(status.response.status()).toBe(200);
    expect(status.payload.deliveryRequest).toEqual(
      expect.objectContaining({
        id: String(requestId),
        operation: "invitation",
        recipientCount: 1,
        delivery: expect.objectContaining({ total: 1, permanentFailure: 1 }),
      }),
    );
    const review = await apiJson(
      request,
      "GET",
      `${runUrl}/retry-preview`,
      token,
    );
    expect(review.response.status()).toBe(200);
    expect(review.payload).toEqual(
      expect.objectContaining({
        preview: true,
        retryable: 1,
        obsolete: 0,
        sample: { name: "Ivy Invitee", email: ivy },
      }),
    );
    expect(review.payload.email.text).toContain("invitation=preview");

    // The retry URL always sends, so asking it for a preview is refused.
    const flagged = await apiJson(request, "POST", runUrl, token, {
      preview: true,
    });
    expect(flagged.response.status()).toBe(400);
    expect(flagged.payload.error).toBe(
      `Preview a retry with GET /events/delivery-requests/${requestId}/retry-preview.`,
    );
    expect(invitationJobStatuses(event.code, ivy)).toEqual([
      "permanent_failure",
    ]);

    // Nobody else can read or retry the run.
    const { access: otherToken } = await registerAccountViaApi(
      request,
      personEmail("retry-other", runId),
      "Otto",
      "Other",
    );
    for (const [method, url] of [
      ["GET", runUrl],
      ["GET", `${runUrl}/retry-preview`],
      ["POST", runUrl],
    ]) {
      const refused = await apiJson(request, method, url, otherToken, {});
      expect(refused.response.status(), `${method} ${url}`).toBe(404);
      expect(refused.payload.error).toBe("Delivery request not found");
    }

    // Once the event is closed the failed invitation is no longer current:
    // the review offers nothing and the retry cancels it with a 409.
    await setLifecycleViaApi(request, token, event.code, "closed");
    const obsolete = await apiJson(
      request,
      "GET",
      `${runUrl}/retry-preview`,
      token,
    );
    expect(obsolete.payload).toEqual(
      expect.objectContaining({
        preview: true,
        retryable: 0,
        obsolete: 1,
        email: null,
      }),
    );
    const stale = await apiJson(request, "POST", runUrl, token, {});
    expect(stale.response.status()).toBe(409);
    expect(stale.payload).toEqual(
      expect.objectContaining({
        error: "This delivery request is no longer current for the event.",
        retried: 0,
        canceled: 1,
      }),
    );
    expect(stale.payload.deliveryRequest.delivery).toEqual(
      expect.objectContaining({ canceled: 1, permanentFailure: 0 }),
    );
    expect(invitationJobStatuses(event.code, ivy)).toEqual(["canceled"]);
  });
});

test.describe("Invitation endpoints without a screen of their own", () => {
  test("adding a person with sendInvitation invites them once, spends the recipient budget only on new invitations, and refuses a reused key with other details", async ({
    request,
  }) => {
    const runId = newRunId();
    const organizerEmail = personEmail("managed-send", runId);
    const { access: token } = await registerAccountViaApi(
      request,
      organizerEmail,
      "Mona",
      "Manager",
    );
    const event = await createEvent(request, token, {
      name: `Managed send ${runId}`,
    });
    const mia = personEmail("mia", runId);
    const nia = personEmail("nia", runId);
    const url = `/events/participants/managed?code=${event.code}`;
    const add = (body) => apiJson(request, "POST", url, token, body);

    // sendInvitation defaults to true: Mia is added and invited at once.
    const key = crypto.randomUUID();
    const startedAt = Date.now() - 1000;
    const created = await add({
      name: "Mia Managed",
      email: mia,
      idempotencyKey: key,
    });
    expect(created.response.status()).toBe(201);
    expect(created.payload).toEqual(
      expect.objectContaining({
        created: true,
        idempotent: false,
        autoInvitedCount: 1,
        deliveryRequest: expect.objectContaining({
          operation: "invitation",
          recipientCount: 1,
        }),
      }),
    );
    expect(created.payload.participant.name).toBe("Mia Managed");
    const invitation = await latestEmailFor(
      mia,
      startedAt,
      invitationEmail(event.code),
    );
    expect(invitation).toContain(`Event: ${event.name}`);
    await waitForInvitationStatus(request, event.code, token, mia, "sent");

    // The same key and details replay the receipt without another email.
    const replay = await add({
      name: "Mia Managed",
      email: mia,
      idempotencyKey: key,
    });
    expect(replay.response.status()).toBe(200);
    expect(replay.payload).toEqual(
      expect.objectContaining({
        created: false,
        idempotent: true,
        autoInvitedCount: 1,
      }),
    );
    expect(replay.payload.deliveryRequest.id).toBe(
      created.payload.deliveryRequest.id,
    );
    // The same key with other details is refused.
    const conflict = await add({
      name: "Mia Renamed",
      email: mia,
      idempotencyKey: key,
    });
    expect(conflict.response.status()).toBe(409);
    expect(conflict.payload.error).toBe(
      "This idempotency key was already used with different participant details.",
    );
    // Someone already on the list is not invited again under a new key.
    const again = await add({
      name: "Mia Managed",
      email: mia,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(again.response.status()).toBe(200);
    expect(again.payload).toEqual(
      expect.objectContaining({ created: false, autoInvitedCount: 0 }),
    );
    // A person with no email of their own is never emailed.
    const managed = await add({
      name: "Quinn NoEmail",
      email: "",
      organizerManaged: true,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(managed.response.status()).toBe(201);
    expect(managed.payload).toEqual(
      expect.objectContaining({
        created: true,
        autoInvitedCount: 0,
        deliveryRequest: expect.objectContaining({ recipientCount: 0 }),
      }),
    );
    expect(invitationJobCount(event.code, mia)).toBe(1);

    // With this organizer's recipient budget spent, a new invitation is
    // throttled and nobody is added; adding without inviting, and replaying
    // a receipt, spend none of it.
    setRateLimitBlock(organizerEmail, "invitation_recipient");
    try {
      const throttled = await add({
        name: "Nia New",
        email: nia,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(throttled.response.status()).toBe(429);
      expect((await rosterByEmail(request, event.code, token)).has(nia)).toBe(
        false,
      );
      const quiet = await add({
        name: "Nia New",
        email: nia,
        sendInvitation: false,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(quiet.response.status()).toBe(201);
      expect(quiet.payload).toEqual(
        expect.objectContaining({
          created: true,
          autoInvitedCount: 0,
          deliveryRequest: null,
        }),
      );
      const replayed = await add({
        name: "Mia Managed",
        email: mia,
        idempotencyKey: key,
      });
      expect(replayed.response.status()).toBe(200);
      expect(replayed.payload.idempotent).toBe(true);
    } finally {
      setRateLimitBlock(organizerEmail, "invitation_recipient", {
        blocked: false,
      });
    }
    expect(invitationJobCount(event.code, nia)).toBe(0);
    expect(
      (await rosterByEmail(request, event.code, token)).get(nia)
        .invitationStatus,
    ).toBe("not_sent");
  });

  test("the legacy batch invitation endpoint validates its batch, invites each new address once per key, and refuses closed events and other accounts", async ({
    request,
  }) => {
    const runId = newRunId();
    const { access: token } = await registerAccountViaApi(
      request,
      personEmail("legacy-invite", runId),
      "Lea",
      "Legacy",
    );
    const event = await createEvent(request, token, {
      name: `Legacy invite ${runId}`,
    });
    const url = `/events/invitations?code=${event.code}`;
    const post = (body, as = token) => apiJson(request, "POST", url, as, body);
    const ada = personEmail("ada", runId);
    const bo = personEmail("bo", runId);

    // Validation happens before anything is written.
    for (const [body, error] of [
      [{ emails: [ada] }, "idempotencyKey must be a UUID"],
      [
        { emails: [ada], idempotencyKey: "key-1" },
        "idempotencyKey must be a UUID",
      ],
      [
        {
          emails: ["not-an-address", ada],
          idempotencyKey: crypto.randomUUID(),
        },
        "Invalid email address: not-an-address",
      ],
      [
        { emails: [" ", ""], idempotencyKey: crypto.randomUUID() },
        "At least one email address is required",
      ],
      [
        {
          emails: Array.from({ length: 1001 }, (_, index) =>
            personEmail(`batch${index}`, runId),
          ),
          idempotencyKey: crypto.randomUUID(),
        },
        "Too many invitation recipients; send at most 1000 at once.",
      ],
      [
        {
          emails: [ada],
          message: "x".repeat(1001),
          idempotencyKey: crypto.randomUUID(),
        },
        "message is too long (max 1000)",
      ],
    ]) {
      const refused = await post(body);
      expect(refused.response.status(), error).toBe(400);
      expect(refused.payload.error).toBe(error);
    }
    const { access: otherToken } = await registerAccountViaApi(
      request,
      personEmail("legacy-other", runId),
      "Otto",
      "Other",
    );
    const foreign = await post(
      { emails: [ada], idempotencyKey: crypto.randomUUID() },
      otherToken,
    );
    expect(foreign.response.status()).toBe(403);
    expect(foreign.payload.error).toBe(
      "Only the organizer can manage invitations",
    );
    let listed = await apiJson(request, "GET", url, token);
    expect(listed.payload.invitations).toEqual([]);

    // A batch, with a duplicate and mixed case, invites each address once
    // with the organizer's message.
    const key = crypto.randomUUID();
    const body = {
      emails: [ada, bo.toUpperCase(), ada],
      message: "Bring your calendar.",
      idempotencyKey: key,
    };
    const startedAt = Date.now() - 1000;
    const sent = await post(body);
    expect(sent.response.status()).toBe(202);
    expect(sent.payload).toEqual(
      expect.objectContaining({
        recipientCount: 2,
        enqueued: 2,
        deduplicated: 0,
        idempotent: false,
      }),
    );
    expect(sent.payload.invitations.map((entry) => entry.email)).toEqual([
      ada,
      bo,
    ]);
    const link = `/event?code=${event.code}&invitation=`;
    for (const email of [ada, bo]) {
      const message = await latestEmailFor(email, startedAt, (text) =>
        text.includes(link),
      );
      expect(message).toContain(
        "Message from organizer:\nBring your calendar.",
      );
      expect(message).toContain(
        "Log in or create a Releviz account with this email address to fill out your schedule.",
      );
    }
    // The same key replays the receipt; with other addresses it is refused.
    const replay = await post(body);
    expect(replay.response.status()).toBe(202);
    expect(replay.payload).toEqual(
      expect.objectContaining({
        idempotent: true,
        deliveryRequestId: sent.payload.deliveryRequestId,
      }),
    );
    const conflict = await post({ ...body, emails: [ada] });
    expect(conflict.response.status()).toBe(409);
    expect(conflict.payload.error).toBe(
      "This idempotency key was already used with different invitation details.",
    );
    await expect
      .poll(
        async () =>
          (await apiJson(request, "GET", url, token)).payload.invitations.map(
            (entry) => [entry.email, Boolean(entry.firstSentAt)],
          ),
        { timeout: 20_000 },
      )
      .toEqual([
        [ada, true],
        [bo, true],
      ]);
    expect(invitationJobCount(event.code, ada)).toBe(1);

    // A closed event takes no invitations.
    await setLifecycleViaApi(request, token, event.code, "closed");
    const closed = await post({
      emails: [personEmail("late", runId)],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(closed.response.status()).toBe(409);
    expect(closed.payload.error).toBe(
      "Responses cannot change while the event is closed.",
    );
    listed = await apiJson(request, "GET", url, token);
    expect(listed.payload.invitations).toHaveLength(2);
  });
});
