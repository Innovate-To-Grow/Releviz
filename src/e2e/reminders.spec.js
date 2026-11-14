const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  apiJson,
  createEvent,
  importRoster,
  latestEmailFor,
  newRunId,
  registerAccountViaApi,
  runBackendCommand,
  runDjangoJson,
  setLifecycleViaApi,
  setRateLimitBlock,
  updateEventViaApi,
} = require("./helpers/releviz");
const {
  LIVE_SYNC_TIMEOUT_MS,
  addPersonApi,
  continueToConfirm,
  expectDeliveredAsPreviewed,
  expectToast,
  freezeLiveSync,
  gotoParticipants,
  participantActions,
  reviewEmail,
  rosterByEmail,
  startOrganizerEvent,
  submitOnBehalf,
  tsv,
  waitForInvitationStatus,
} = require("./helpers/participants");
const { wakeLiveSync } = require("./helpers/workspace");

// Availability reminders: the organizer's manual run from the Email menu
// (its review, who is skipped because this deadline already reminded them,
// reminders turned off, throttled and refused runs), and the scheduled
// send_due_event_reminders command. Every test registers its own organizer
// and events and asserts only on its own recipients.

const MINUTE_MS = 60 * 1000;

function personEmail(slug, runId) {
  return `${slug}-${runId}@example.com`;
}

function reminderDialog(page) {
  return page.getByRole("dialog", { name: "Send reminders" });
}

function continueButton(dialog) {
  return dialog.getByRole("button", { name: "Continue", exact: true });
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
// on its first item (Invite everyone…, which is never disabled).
async function closeMenu(menu) {
  await menu.getByRole("menuitem").first().press("Escape");
  await expect(menu).toHaveCount(0);
}

// The next POST /events/reminders: the preview when `preview`, a run
// otherwise.
function remindersRequest(page, { preview }) {
  return page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      !new URL(response.url()).pathname.endsWith("/events/reminders")
    )
      return false;
    let body = {};
    try {
      body = response.request().postDataJSON() || {};
    } catch {
      body = {};
    }
    return (body.preview === true) === preview;
  });
}

async function runReminders(request, token, eventCode, body) {
  return apiJson(
    request,
    "POST",
    `/events/reminders?code=${eventCode}`,
    token,
    body,
  );
}

// Reminder jobs this event queued, per recipient.
function reminderJobsByRecipient(eventCode) {
  return runDjangoJson(
    `
from django.db.models import Count

from apps.mail.models import EmailDeliveryJob

rows = (
    EmailDeliveryJob.objects.filter(event__code=data["code"], message_type="reminder")
    .values("recipient")
    .annotate(total=Count("pk"))
)
print(json.dumps({row["recipient"]: row["total"] for row in rows}))
`,
    { code: eventCode },
  );
}

function reminderEmail(eventCode) {
  return (body) =>
    body.includes("Reminder:") && body.includes(`code=${eventCode}`);
}

test.describe("Manual reminders", () => {
  test("a second run skips people already reminded for this deadline, and a third finds nobody to remind", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "remind-again",
      { remindersEnabled: true, reminderHoursBefore: 24 },
    );
    const ana = personEmail("ana", runId);
    const ben = personEmail("ben", runId);
    const cai = personEmail("cai", runId);
    await importRoster(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Ana Asked", ana],
        ["Ben Asked", ben],
      ]),
    );
    for (const email of [ana, ben]) {
      await waitForInvitationStatus(request, event.code, token, email, "sent");
    }
    const first = await runReminders(request, token, event.code, {
      idempotencyKey: crypto.randomUUID(),
    });
    expect(first.response.status()).toBe(202);
    expect(first.payload).toEqual(
      expect.objectContaining({
        recipientCount: 2,
        enqueued: 2,
        deduplicated: 0,
      }),
    );
    // Cai is invited after that run.
    await addPersonApi(request, event.code, token, {
      name: "Cai Caught",
      email: cai,
      sendInvitation: true,
    });
    await waitForInvitationStatus(request, event.code, token, cai, "sent");

    await gotoParticipants(page, event);
    let menu = await openEmailMenu(page);
    await expect(menu.locator(".participants-menu__header")).toHaveText(
      /^Next automatic reminder: /,
    );
    const previewed = remindersRequest(page, { preview: true });
    await menu.getByRole("menuitem", { name: "Send reminders (3)…" }).click();
    expect(await (await previewed).json()).toEqual(
      expect.objectContaining({
        preview: true,
        remindersEnabled: true,
        eligible: 3,
        alreadyReminded: 2,
        wouldEnqueue: 1,
      }),
    );
    const dialog = reminderDialog(page);
    const previewLink = `${new URL(page.url()).origin}/temp-access?code=${event.code}&invitation=preview`;
    const envelope = await reviewEmail(dialog, {
      summary: [
        "1 invited person who hasn't submitted will get a reminder",
        "2 were already reminded for this deadline and are skipped",
        "People never invited, people without an email, and you are skipped.",
      ],
      to: cai,
      subject: `Reminder: share your availability for ${event.name}`,
      attachments: `releviz-${event.code}-availability.ics`,
      heading: "Availability reminder",
      link: { name: "Share your availability", href: previewLink },
      text: ["Reminder:", `Link: ${previewLink}`],
    });
    await expect(dialog.locator(".email-preview__note")).toHaveText(
      "Shown for Cai Caught. Each person gets their own private link.",
    );
    const send = await continueToConfirm(
      dialog,
      "Remind 1 invited person who hasn't submitted?",
      "Send 1 reminder",
    );
    const startedAt = Date.now() - 1000;
    const ran = remindersRequest(page, { preview: false });
    await send.click();
    const reply = await ran;
    expect(reply.status()).toBe(202);
    expect(await reply.json()).toEqual(
      expect.objectContaining({
        recipientCount: 3,
        enqueued: 1,
        deduplicated: 2,
      }),
    );
    await expect(dialog).toHaveCount(0);
    await expectToast(page, "Queued 1 reminder. Skipped 2 already reminded.");

    // The delivery card follows the reminder run, the people already
    // reminded included.
    const card = page.getByRole("group", { name: "Event delivery progress" });
    await expect(card.getByText("Reminder delivery")).toBeVisible();
    await expect(card.getByText("3 total")).toBeVisible();
    await expect(
      card.locator(".delivery-progress__header .status-badge"),
    ).toHaveText("Complete", { timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(card.getByText("3 sent")).toBeVisible();
    const reminder = await latestEmailFor(
      cai,
      startedAt,
      reminderEmail(event.code),
    );
    expectDeliveredAsPreviewed(reminder, envelope, cai);
    expect(reminder).not.toContain("invitation=preview");
    // Nobody was reminded twice for this deadline.
    expect(reminderJobsByRecipient(event.code)).toEqual({
      [ana]: 1,
      [ben]: 1,
      [cai]: 1,
    });

    // A third run finds everyone already reminded.
    menu = await openEmailMenu(page);
    await menu.getByRole("menuitem", { name: "Send reminders (3)…" }).click();
    await expect(
      dialog.getByText(
        "3 were already reminded for this deadline and are skipped",
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText("Nobody needs a reminder right now."),
    ).toBeVisible();
    await expect(dialog.getByText(/will get a reminder/)).toHaveCount(0);
    await expect(continueButton(dialog)).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(reminderJobsByRecipient(event.code)).toEqual({
      [ana]: 1,
      [ben]: 1,
      [cai]: 1,
    });
  });

  test("with reminders off the menu says so and offers no run, and a run asked for after they were turned off elsewhere only warns", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "remind-off",
      { remindersEnabled: true },
    );
    const ana = personEmail("ana", runId);
    await addPersonApi(request, event.code, token, {
      name: "Ana Asked",
      email: ana,
      sendInvitation: true,
    });
    await waitForInvitationStatus(request, event.code, token, ana, "sent");

    // A fake clock (still running at the normal pace) lets the test jump
    // past the six seconds a passing notice lasts.
    await page.clock.install();
    await gotoParticipants(page, event);
    let menu = await openEmailMenu(page);
    await expect(menu.locator(".participants-menu__header")).toHaveText(
      /^Next automatic reminder: /,
    );
    await expect(
      menu.getByRole("menuitem", { name: "Send reminders (1)…" }),
    ).toBeEnabled();
    await closeMenu(menu);

    // Reminders are turned off in another session before this one hears.
    const release = await freezeLiveSync(page);
    const warning = page
      .getByRole("region", { name: "Notifications" })
      .locator(".participants-toast", {
        hasText:
          "Reminders are off for this event, so nobody would be emailed. Turn them on in the event settings first.",
      });
    try {
      await updateEventViaApi(request, token, event.code, {
        remindersEnabled: false,
      });
      menu = await openEmailMenu(page);
      const previewed = remindersRequest(page, { preview: true });
      await menu.getByRole("menuitem", { name: "Send reminders (1)…" }).click();
      expect(await (await previewed).json()).toEqual(
        expect.objectContaining({
          preview: true,
          remindersEnabled: false,
          eligible: 1,
          wouldEnqueue: 1,
        }),
      );
      await expect(warning).toBeVisible();
      await expect(reminderDialog(page)).toHaveCount(0);
      // The warning stays until it is dismissed.
      await page.clock.fastForward(10_000);
      await expect(warning).toBeVisible();
    } finally {
      await release();
    }
    await warning.getByRole("button", { name: "Dismiss" }).click();
    await expect(warning).toHaveCount(0);

    // Once the workspace hears, the menu says reminders are off and offers
    // no run.
    await wakeLiveSync(page);
    await expect
      .poll(
        async () => {
          const opened = await openEmailMenu(page);
          const header = await opened
            .locator(".participants-menu__header")
            .textContent();
          await closeMenu(opened);
          return header;
        },
        { timeout: LIVE_SYNC_TIMEOUT_MS },
      )
      .toBe("Reminders are off");
    menu = await openEmailMenu(page);
    await expect(
      menu.getByRole("menuitem", { name: "Send reminders (1)…" }),
    ).toBeDisabled();
    await closeMenu(menu);

    // A run while reminders are off queues nobody.
    const run = await runReminders(request, token, event.code, {
      idempotencyKey: crypto.randomUUID(),
    });
    expect(run.response.status()).toBe(202);
    expect(run.payload).toEqual(
      expect.objectContaining({ recipientCount: 0, enqueued: 0 }),
    );
    expect(reminderJobsByRecipient(event.code)).toEqual({});
  });

  test("a preview spends no request budget, a throttled run keeps its review open with the error, and bad input, other accounts and closed events are refused", async ({
    page,
    request,
  }) => {
    const { runId, token, event, organizerEmail } = await startOrganizerEvent(
      { page, request },
      "remind-refused",
      { remindersEnabled: true },
    );
    const ana = personEmail("ana", runId);
    await addPersonApi(request, event.code, token, {
      name: "Ana Asked",
      email: ana,
      sendInvitation: true,
    });
    await waitForInvitationStatus(request, event.code, token, ana, "sent");

    for (const [body, error] of [
      [{ preview: "yes" }, "preview must be a boolean."],
      [{}, "idempotencyKey must be a UUID"],
    ]) {
      const refused = await runReminders(request, token, event.code, body);
      expect(refused.response.status(), error).toBe(400);
      expect(refused.payload.error).toBe(error);
    }
    const noCode = await apiJson(request, "POST", "/events/reminders", token, {
      preview: true,
    });
    expect(noCode.response.status()).toBe(400);
    expect(noCode.payload.error).toBe("code is required");
    const unknown = await runReminders(request, token, "NOSUCHEVENT", {
      preview: true,
    });
    expect(unknown.response.status()).toBe(404);
    expect(unknown.payload.error).toBe("Event not found");

    // With this organizer's reminder request budget spent, the review still
    // opens (a preview emails nobody), but the run is throttled and the
    // review stays on its confirmation with the error.
    setRateLimitBlock(organizerEmail, "reminder_request");
    try {
      await gotoParticipants(page, event);
      await (
        await openEmailMenu(page)
      )
        .getByRole("menuitem", { name: "Send reminders (1)…" })
        .click();
      const dialog = reminderDialog(page);
      await expect(
        dialog.getByText(
          "1 invited person who hasn't submitted will get a reminder",
        ),
      ).toBeVisible();
      const send = await continueToConfirm(
        dialog,
        "Remind 1 invited person who hasn't submitted?",
        "Send 1 reminder",
      );
      const ran = remindersRequest(page, { preview: false });
      await send.click();
      expect((await ran).status()).toBe(429);
      await expect(
        dialog.getByRole("heading", {
          name: "Remind 1 invited person who hasn't submitted?",
        }),
      ).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "Request was throttled.",
      );
      await expect(send).toBeEnabled();
      await dialog.getByRole("button", { name: "Close dialog" }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      setRateLimitBlock(organizerEmail, "reminder_request", { blocked: false });
    }
    expect(reminderJobsByRecipient(event.code)).toEqual({});

    // Only the organizer may look or send.
    const { access: otherToken } = await registerAccountViaApi(
      request,
      personEmail("remind-other", runId),
      "Otto",
      "Other",
    );
    for (const body of [
      { preview: true },
      { idempotencyKey: crypto.randomUUID() },
    ]) {
      const refused = await runReminders(request, otherToken, event.code, body);
      expect(refused.response.status()).toBe(403);
      expect(refused.payload.error).toBe(
        "Only the organizer can send reminders",
      );
    }

    // A closed event takes no reminder run; the preview still answers.
    await setLifecycleViaApi(request, token, event.code, "closed");
    const closed = await runReminders(request, token, event.code, {
      idempotencyKey: crypto.randomUUID(),
    });
    expect(closed.response.status()).toBe(409);
    expect(closed.payload.error).toBe(
      "Responses cannot change while the event is closed.",
    );
    const preview = await runReminders(request, token, event.code, {
      preview: true,
    });
    expect(preview.response.status()).toBe(200);
    expect(preview.payload).toEqual(
      expect.objectContaining({ eligible: 1, nextAutomaticAt: null }),
    );
    expect(reminderJobsByRecipient(event.code)).toEqual({});
  });
});

// The scheduled command scans every event in the shared database. It is
// browser-neutral, so it runs in the Chromium project only: the three
// browser jobs would otherwise race one another's windows.
test.describe("Due event reminders", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Browser-neutral management command that scans the shared E2E database; run it once per suite run",
  );

  // Two copies of this test (--repeat-each, retries) must not overlap: one
  // copy's wider --window-minutes run would remind the other's control
  // event before that copy checks it. A directory lock on this machine
  // serializes them; a lock older than any test timeout is stale.
  const LOCK_DIR = path.join(os.tmpdir(), "releviz-e2e-due-reminders.lock");
  const STALE_LOCK_MS = 5 * MINUTE_MS;

  async function tryAcquireLock() {
    try {
      await fs.mkdir(LOCK_DIR);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.stat(LOCK_DIR).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      await fs.rm(LOCK_DIR, { recursive: true, force: true });
    }
    return false;
  }

  async function withReminderLock(body) {
    await expect
      .poll(tryAcquireLock, {
        timeout: 150_000,
        intervals: [250, 500, 1000],
        message: "another send_due_event_reminders test holds the lock",
      })
      .toBe(true);
    try {
      return await body();
    } finally {
      await fs.rm(LOCK_DIR, { recursive: true, force: true });
    }
  }

  // Reminder jobs per event (and per recipient on the due event), read from
  // the delivery queue so the numbers cover jobs not yet delivered.
  function reminderCounts(data) {
    return runDjangoJson(
      `
from apps.mail.models import EmailDeliveryJob

jobs = EmailDeliveryJob.objects.filter(message_type="reminder")


def count(code, email=None):
    rows = jobs.filter(event__code=code)
    if email:
        rows = rows.filter(recipient__iexact=email)
    return rows.count()


print(json.dumps({
    "duePending": count(data["due"], data["pending"]),
    "dueSubmitted": count(data["due"], data["submitted"]),
    "far": count(data["far"]),
    "off": count(data["off"]),
    "closed": count(data["closed"]),
}))
`,
      data,
    );
  }

  async function invitationFor(request, token, code, email) {
    const listed = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${code}`,
      token,
    );
    expect(listed.response.status()).toBe(200);
    return listed.payload.invitations.find(
      (invitation) => invitation.email === email.toLowerCase(),
    );
  }

  function expectCommandOutput(output) {
    expect(output).toMatch(/Queued \d+ new reminder email job\(s\)\./);
    expect(output).toMatch(/Email jobs: attempted=\d+ sent=\d+/);
  }

  test("send_due_event_reminders reminds only due, unanswered invitations once, honours --window-minutes, and rejects a zero window", async ({
    request,
  }) => {
    // The lock can make this copy wait for another one to finish.
    test.setTimeout(180_000);
    await withReminderLock(async () => {
      const runId = newRunId();
      const { access: token } = await registerAccountViaApi(
        request,
        personEmail("remind-org", runId),
        "Rae",
        "Minder",
      );
      const now = Date.now();
      const deadlineIn = (minutes) =>
        new Date(now + minutes * MINUTE_MS).toISOString();

      // Each reminder goes out an hour before its deadline.
      // due: that time passed half an hour ago.
      // far: it is 40 minutes away, outside a 20-minute window but inside a
      //      45-minute one.
      // off: due, but reminders are off.
      // closed: due, but closed once its invitation is out.
      const reminderEvent = (name, minutes, remindersEnabled = true) =>
        createEvent(request, token, {
          name: `${name} ${runId}`,
          remindersEnabled,
          reminderHoursBefore: 1,
          responseDeadline: deadlineIn(minutes),
        });
      const due = await reminderEvent("Reminder due", 30);
      const far = await reminderEvent("Reminder far", 100);
      const off = await reminderEvent("Reminder off", 30, false);
      const closed = await reminderEvent("Reminder closed", 30);

      const pending = personEmail("remind-pending", runId);
      const submitted = personEmail("remind-submitted", runId);
      const farPending = personEmail("remind-far", runId);
      const offPending = personEmail("remind-off", runId);
      const closedPending = personEmail("remind-closed", runId);

      await importRoster(
        request,
        due.code,
        token,
        tsv([
          ["name", "email"],
          ["Pending Pia", pending],
          ["Submitted Sam", submitted],
        ]),
      );
      for (const [event, name, email] of [
        [far, "Far Fay", farPending],
        [off, "Off Oli", offPending],
        [closed, "Closed Cal", closedPending],
      ]) {
        await importRoster(
          request,
          event.code,
          token,
          tsv([
            ["name", "email"],
            [name, email],
          ]),
        );
      }
      for (const [event, email] of [
        [due, pending],
        [due, submitted],
        [far, farPending],
        [off, offPending],
        [closed, closedPending],
      ]) {
        await waitForInvitationStatus(
          request,
          event.code,
          token,
          email,
          "sent",
        );
      }

      // Sam's response is in, so the reminder skips him.
      const samRow = (await rosterByEmail(request, due.code, token)).get(
        submitted,
      );
      await submitOnBehalf(request, token, due, samRow);
      await expect
        .poll(
          async () =>
            (await invitationFor(request, token, due.code, submitted))?.status,
          { timeout: 20_000 },
        )
        .toBe("submitted");
      await setLifecycleViaApi(request, token, closed.code, "closed");

      const countsFor = {
        due: due.code,
        pending,
        submitted,
        far: far.code,
        off: off.code,
        closed: closed.code,
      };

      // 1) The default-sized window reminds only Pia on the due event.
      const startedAt = Date.now() - 1000;
      expectCommandOutput(
        runBackendCommand("send_due_event_reminders", "--window-minutes=20"),
      );
      const mail = await latestEmailFor(
        pending,
        startedAt,
        reminderEmail(due.code),
      );
      // Long subjects are folded, so the header may continue on the next line.
      expect(mail).toMatch(
        /^Subject:\s+Reminder: share your availability for/m,
      );
      expect(mail).toContain(`Event: ${due.name}`);
      expect(mail).toContain("Please respond by ");
      expect(mail).toContain(
        "The organizer is still waiting for your availability.",
      );
      expect(mail).toContain("TRIGGER:-PT1H");
      expect(mail).toContain(`releviz-${due.code}-availability.ics`);

      await expect
        .poll(
          async () =>
            (await invitationFor(request, token, due.code, pending))
              ?.reminderSentAt,
          { timeout: 20_000 },
        )
        .toBeTruthy();
      expect(
        (await invitationFor(request, token, due.code, pending))
          .awaitingReminder,
      ).toBe(false);
      expect(
        (await invitationFor(request, token, due.code, submitted))
          .reminderSentAt,
      ).toBeNull();
      const firstCounts = reminderCounts(countsFor);
      expect(firstCounts).toEqual({
        duePending: 1,
        dueSubmitted: 0,
        far: 0,
        off: 0,
        closed: 0,
      });

      // 2) A rerun queues nothing new for this test's events.
      expectCommandOutput(
        runBackendCommand("send_due_event_reminders", "--window-minutes=20"),
      );
      expect(reminderCounts(countsFor)).toEqual(firstCounts);

      // 3) A 45-minute window reaches the far event's reminder time too.
      const farStarted = Date.now() - 1000;
      expectCommandOutput(
        runBackendCommand("send_due_event_reminders", "--window-minutes=45"),
      );
      const farMail = await latestEmailFor(
        farPending,
        farStarted,
        reminderEmail(far.code),
      );
      expect(farMail).toContain(`Event: ${far.name}`);
      expect(reminderCounts(countsFor)).toEqual({
        duePending: 1,
        dueSubmitted: 0,
        far: 1,
        off: 0,
        closed: 0,
      });

      // 4) A window must be at least one minute.
      expect(() =>
        runBackendCommand("send_due_event_reminders", "--window-minutes=0"),
      ).toThrow(/window-minutes must be positive/);
    });
  });
});
