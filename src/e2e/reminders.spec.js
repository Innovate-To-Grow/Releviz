const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  apiJson,
  createEvent,
  dispatchEmailJobs,
  importRoster,
  latestEmailFor,
  newRunId,
  registerAccountViaApi,
  runBackendCommand,
  runDjangoJson,
  setLifecycleViaApi,
} = require("./helpers/releviz");
const { rosterByEmail, submitOnBehalf } = require("./helpers/roster");

// The background command send_due_event_reminders: which events and
// invitations qualify, the reminder email, idempotent reruns, the
// --window-minutes option and its validation. The command scans the whole
// shared database, so every assertion is scoped to this test's own events
// and recipients, and its global counts are never asserted.

// The command is browser-neutral, so it runs once per suite run: a local
// all-projects run shares one database, and another project's widened
// window would otherwise remind this project's control event.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Browser-neutral management command that scans the shared E2E database; run it once per suite run",
);

const MINUTE_MS = 60 * 1000;

// Two copies of this test (--repeat-each, retries) must not overlap: one
// copy's widened --window-minutes=90 run would remind the other's control
// event before that copy checks it, and any run could remind the other's
// closed-to-be event before it is closed. A directory lock on this machine
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

// Reminder jobs per event (and per recipient for the due event), read from
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

async function invitations(request, token, code) {
  const listed = await apiJson(
    request,
    "GET",
    `/events/invitations?code=${code}`,
    token,
  );
  expect(listed.response.status()).toBe(200);
  return listed.payload.invitations;
}

async function invitationFor(request, token, code, email) {
  return (await invitations(request, token, code)).find(
    (invitation) => invitation.email.toLowerCase() === email.toLowerCase(),
  );
}

const COMMAND_OUTPUT = [
  /Queued \d+ new reminder email job\(s\)\./,
  /Email jobs: attempted=\d+ sent=\d+/,
];

function expectCommandOutput(output) {
  for (const pattern of COMMAND_OUTPUT) expect(output).toMatch(pattern);
}

test.describe("Due event reminders", () => {
  test("send_due_event_reminders reminds only due, unanswered invitations once, honours --window-minutes, and rejects a zero window", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    await withReminderLock(async () => {
      const runId = newRunId();
      const { access: token } = await registerAccountViaApi(
        request,
        `remind-org-${runId}@example.com`,
        "Rae",
        "Minder",
      );
      const t = Date.now();
      const deadlineIn = (minutes) =>
        new Date(t + minutes * MINUTE_MS).toISOString();

      // due: reminder time (deadline - 1 h) has already passed.
      // far: reminder time is an hour out, outside a 20-minute window but
      //      inside a 90-minute one.
      // off: due, but reminders are disabled.
      // closed: due, but closed once its invitation is out.
      const reminderEvent = (name, minutes, remindersEnabled = true) =>
        createEvent(request, token, {
          name: `${name} ${runId}`,
          remindersEnabled,
          reminderHoursBefore: 1,
          responseDeadline: deadlineIn(minutes),
        });
      const due = await reminderEvent("Reminder due", 30);
      const far = await reminderEvent("Reminder far", 120);
      const off = await reminderEvent("Reminder off", 30, false);
      const closedEv = await reminderEvent("Reminder closed", 30);

      const pending = `remind-pending-${runId}@example.com`;
      const submitted = `remind-submitted-${runId}@example.com`;
      const farPending = `remind-far-${runId}@example.com`;
      const offPending = `remind-off-${runId}@example.com`;
      const closedPending = `remind-closed-${runId}@example.com`;

      await importRoster(
        request,
        due.code,
        token,
        `name,email\nPending Pia,${pending}\nSubmitted Sam,${submitted}`,
      );
      for (const [event, name, email] of [
        [far, "Far Fay", farPending],
        [off, "Off Oli", offPending],
        [closedEv, "Closed Cal", closedPending],
      ]) {
        await importRoster(
          request,
          event.code,
          token,
          `name,email\n${name},${email}`,
        );
      }
      dispatchEmailJobs();
      for (const [event, expected] of [
        [due, 2],
        [far, 1],
        [off, 1],
        [closedEv, 1],
      ]) {
        await expect
          .poll(
            async () => {
              const rows = await invitations(request, token, event.code);
              return rows.filter((row) => row.firstSentAt).length;
            },
            { timeout: 20_000 },
          )
          .toBe(expected);
      }

      // Sam's response is in, so the reminder skips him.
      const samRow = (await rosterByEmail(request, due.code, token)).get(
        submitted,
      );
      expect(samRow).toBeTruthy();
      await submitOnBehalf(request, token, due, samRow);
      await expect
        .poll(
          async () =>
            (await invitationFor(request, token, due.code, submitted))?.status,
          { timeout: 20_000 },
        )
        .toBe("submitted");
      await setLifecycleViaApi(request, token, closedEv.code, "closed");

      const countsFor = {
        due: due.code,
        pending,
        submitted,
        far: far.code,
        off: off.code,
        closed: closedEv.code,
      };

      // 1) The default-sized window reminds only Pia on the due event.
      const startedAt = Date.now() - 1000;
      const out1 = runBackendCommand(
        "send_due_event_reminders",
        "--window-minutes=20",
      );
      expectCommandOutput(out1);
      const mail = await latestEmailFor(
        pending,
        startedAt,
        (body) =>
          body.includes("Reminder:") && body.includes(`code=${due.code}`),
      );
      // Long subjects are folded, so the header may continue on the next line.
      expect(mail).toMatch(
        /^Subject:\s+Reminder: share your availability for/m,
      );
      expect(mail).toContain(`Event: ${due.name}`);
      expect(mail).toContain(`code=${due.code}`);
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
      const piaInvitation = await invitationFor(
        request,
        token,
        due.code,
        pending,
      );
      expect(piaInvitation.awaitingReminder).toBe(false);
      const samInvitation = await invitationFor(
        request,
        token,
        due.code,
        submitted,
      );
      expect(samInvitation.reminderSentAt).toBeNull();

      const c1 = reminderCounts(countsFor);
      expect(c1).toEqual({
        duePending: 1,
        dueSubmitted: 0,
        far: 0,
        off: 0,
        closed: 0,
      });

      // 2) A rerun queues nothing new for this test's events.
      const out2 = runBackendCommand(
        "send_due_event_reminders",
        "--window-minutes=20",
      );
      expectCommandOutput(out2);
      expect(reminderCounts(countsFor)).toEqual(c1);

      // 3) A 90-minute window reaches the far event's reminder time too.
      const farStarted = Date.now() - 1000;
      const out3 = runBackendCommand(
        "send_due_event_reminders",
        "--window-minutes=90",
      );
      expectCommandOutput(out3);
      const farMail = await latestEmailFor(
        farPending,
        farStarted,
        (body) =>
          body.includes("Reminder:") && body.includes(`code=${far.code}`),
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
