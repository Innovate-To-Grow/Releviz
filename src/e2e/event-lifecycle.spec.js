const fs = require("node:fs/promises");
const { expect, test } = require("@playwright/test");
const {
  BACKEND_URL,
  FRONTEND_URL,
  apiJson,
  closeBlockedTimes,
  createEvent,
  eventState,
  finalizeViaApi,
  freshResults,
  newRunId,
  openBlockedTimes,
  readSession,
  recomputeEventResults,
  registerAccount,
  registerAccountViaApi,
  runDjangoJson,
  setLifecycleViaApi,
  slotIndex,
  submitResponse,
  updateEventViaApi,
} = require("./helpers/releviz");
const {
  LIVE_SYNC_TIMEOUT_MS,
  addPersonApi,
  continueToConfirm,
  freezeLiveSync,
  requestRecorder,
  reviewEmail,
  rosterByEmail,
  submitOnBehalf,
  waitForInvitationStatus,
} = require("./helpers/participants");
const {
  attendanceTile,
  chooseRecommendedTime,
  clickLifecycleButton,
  eventControls,
  finalizeCurrentSelection,
  overviewTile,
  reviewAttendance,
  wakeLiveSync,
} = require("./helpers/workspace");
const { DAY_MS, icsUtc, isoDate, weekStartMs } = require("./helpers/time");

// The event lifecycle from the organizer's workspace: closing, archiving and
// reactivating from the Event controls (each state's summary, buttons and
// locks, the emails a change cancels, and the refusals the controls show),
// finalizing (the attendance review, the meeting location, the confirmation
// dialog's refusals, a meeting finalized elsewhere) and what a confirmed
// meeting keeps while it is archived, on the workspace and the dashboard.
// The lifecycle and finalization endpoints' guards are checked through the
// API. Every test works on its own organizer and events.

// Each lifecycle status as the Event controls show it: the summary under the
// badge and the buttons offered, in order.
const LIFECYCLE_STATES = {
  active: {
    summary: "This event is active and accepting responses.",
    buttons: ["Close responses", "Archive event"],
  },
  closed: {
    summary: "Responses are now closed.",
    buttons: ["Reactivate event", "Archive event"],
  },
  finalized: {
    summary:
      "The meeting is finalized. Reactivate the event to collect new responses.",
    buttons: ["Reactivate event", "Archive event"],
  },
  archived: {
    summary: "This event is archived.",
    buttons: ["Reactivate event"],
  },
};

// Why "Edit event" and the Blocked times tools are locked.
const ARCHIVED_LOCK = "Reactivate this archived event before editing it.";
const CONFIRMED_LOCK =
  "Reactivate the event before editing a confirmed meeting.";
const STALE_LIFECYCLE =
  "The event changed in another session. Refresh and try again.";
const NOT_ACCEPTING = "The event is no longer accepting responses.";
const FINALIZED_FIRST =
  "The event was finalized before this message was delivered.";
const PAST_DEADLINE = "An active event must have a future response deadline.";

const lifecyclePreviewUrl = (code) => `/events/lifecycle/preview?code=${code}`;

// The badge, the summary, exactly the buttons of `status`, and the header's
// Live line, which shows only while the event is active.
async function expectLifecycleState(page, status) {
  const controls = eventControls(page);
  const { summary, buttons } = LIFECYCLE_STATES[status];
  await expect(
    controls.locator(".organizer-lifecycle-panel__status"),
  ).toHaveText(status);
  await expect(
    controls.locator(".organizer-event-controls__lifecycle"),
  ).toHaveText(summary);
  await expect(controls.getByRole("button")).toHaveText(buttons);
  const live = page.locator(".organizer-heading__live");
  if (status === "active") {
    await expect(live).toContainText("New responses load automatically.");
  } else {
    await expect(live).toHaveCount(0);
  }
}

// "Edit event" is disabled with `reason` as its title, and the Blocked times
// step is read-only: the calendar says so, and every tool is disabled with
// the same reason.
async function expectEditingLocked(page, reason) {
  const edit = page.getByRole("button", { name: "Edit event" });
  await expect(edit).toBeDisabled();
  await expect(edit).toHaveAttribute("title", reason);
  await openBlockedTimes(page);
  await expect(page.locator(".meeting-calendar__mode")).toHaveText(
    "Blocked times (read-only)",
  );
  await expect(
    page.getByRole("grid", { name: /^Meeting time calendar, / }),
  ).toHaveAttribute("aria-readonly", "true");
  const tools = page.getByRole("region", { name: "Blocked times tools" });
  const brush = tools.getByRole("group", { name: "Mark times as" });
  for (const name of ["Blocked", "Open"]) {
    await expect(
      brush.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  for (const name of ["Clear all", "Save blocked times"]) {
    const button = tools.getByRole("button", { name, exact: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", reason);
  }
  await expect(tools).toContainText(reason);
  await closeBlockedTimes(page);
}

// The Finalize step stays collapsed until a time is picked; a confirmed
// meeting and its calendar download sit inside it.
async function openFinalize(page) {
  const finalize = page.locator("details#organizer-finalize");
  if ((await finalize.getAttribute("open")) === null) {
    await finalize.locator("> summary").click();
  }
  await expect(finalize).toHaveAttribute("open", "");
}

// Opens the workspace and waits for the event's heading.
async function openWorkspace(page, event) {
  await page.goto(`/event?code=${event.code}`);
  await expect(
    page.getByRole("heading", { level: 2, name: event.name }),
  ).toBeVisible();
}

// Registers an organizer through the UI and creates an API event with one
// response, available Monday 10:00-11:00 (the best time).
async function startLifecycleEvent({ page, request }, label, overrides = {}) {
  const runId = newRunId();
  await registerAccount(page, `${label}-${runId}@example.com`, "Lee", "Cycle");
  const token = (await readSession(page)).access;
  const event = await createEvent(request, token, {
    name: `Lifecycle ${label} ${runId}`,
    ...overrides,
  });
  const mon10 = slotIndex(event, "weekday:1", "10:00");
  await submitResponse(request, token, event, {
    name: "Ada Answer",
    email: `ada-${runId}@example.com`,
    inperson: [mon10, mon10 + 1],
  });
  return { runId, token, event, code: event.code };
}

// Delivery jobs for this test's own event. Pending and retry jobs are due a
// day from now and a processing one is locked now, so the stack's email
// worker leaves them alone; the lifecycle and finalization code under test
// are the only ones to touch them. Returns the job ids in order.
function seedDeliveryJobs(eventCode, jobs) {
  return runDjangoJson(
    `
import uuid
from datetime import timedelta

from django.utils import timezone

from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import Event

event = Event.objects.get(code=data["code"])
now = timezone.now()
ids = []
for spec in data["jobs"]:
    key = uuid.uuid4().hex
    status = spec["status"]
    job = EmailDeliveryJob.objects.create(
        idempotency_key=f"e2e-lifecycle:{key}",
        message_type=spec["type"],
        recipient=spec["recipient"],
        subject="Seeded by the lifecycle spec",
        body="Seeded by the lifecycle spec.",
        message_id=f"<e2e-lifecycle-{key}@releviz.local>",
        event=event,
        status=status,
        attempt_count=0 if status == "pending" else 1,
        next_attempt_at=now + timedelta(days=1),
        locked_at=now if status == "processing" else None,
        lock_token=uuid.uuid4() if status == "processing" else None,
        sent_at=now if status == "sent" else None,
    )
    ids.append(str(job.pk))
print(json.dumps(ids))
`,
    { code: eventCode, jobs },
  );
}

// { status, lastError } of each job, in the order of `ids`.
function deliveryJobStates(ids) {
  return runDjangoJson(
    `
from apps.mail.models import EmailDeliveryJob

jobs = {str(job.pk): job for job in EmailDeliveryJob.objects.filter(pk__in=data["ids"])}
print(json.dumps([
    {"status": jobs[job_id].status, "lastError": jobs[job_id].last_error}
    for job_id in data["ids"]
]))
`,
    { ids },
  );
}

// Lets a seeded processing job finish, as the worker would once the provider
// answers.
function finishDeliveryJob(id) {
  runDjangoJson(
    `
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob

updated = EmailDeliveryJob.objects.filter(pk=data["id"], status="processing").update(
    status="sent", sent_at=timezone.now(), locked_at=None, lock_token=None
)
print(json.dumps(updated))
`,
    { id },
  );
}

// Adds a person and submits `values` ({ slotIndex: availability }) for them
// as the organizer, so a response can be partly available (0.5, "If needed").
async function submitValues(request, token, event, { name, email, values }) {
  const { participant } = await addPersonApi(request, event.code, token, {
    name,
    email,
  });
  const schedule = await apiJson(
    request,
    "GET",
    `/events/roster/${participant.id}/schedule?code=${event.code}`,
    token,
  );
  expect(schedule.response.status()).toBe(200);
  const inperson = Array.from(
    { length: event.slotCount },
    (_, index) => values[index] ?? 0,
  );
  const updated = await apiJson(
    request,
    "PUT",
    `/events/participants/update?code=${event.code}&participantId=${participant.id}`,
    token,
    {
      availabilityInperson: inperson,
      availabilityVirtual: Array(event.slotCount).fill(0),
      submitted: 1,
      expectedVersion:
        schedule.payload.schedule?.version ??
        schedule.payload.participant?.version,
    },
  );
  expect(updated.response.status(), JSON.stringify(updated.payload)).toBe(200);
  return participant;
}

// Finalizes the best time through the API with one person on the event who
// was sent an invitation, and waits until their confirmation email has gone
// out, so reopening the event would email them a cancellation.
async function finalizeWithEmailedPerson(request, token, event, person) {
  await addPersonApi(request, event.code, token, {
    ...person,
    sendInvitation: true,
  });
  await waitForInvitationStatus(
    request,
    event.code,
    token,
    person.email,
    "sent",
  );
  const entry = (await rosterByEmail(request, event.code, token)).get(
    person.email.toLowerCase(),
  );
  await submitOnBehalf(request, token, event, entry);
  const results = await freshResults(request, token, event.code);
  await finalizeViaApi(request, token, event.code, results.recommendations[0]);
  await expect
    .poll(
      async () =>
        (
          await apiJson(
            request,
            "GET",
            `/events/finalization?code=${event.code}`,
            token,
          )
        ).payload?.delivery,
      { timeout: LIVE_SYNC_TIMEOUT_MS },
    )
    .toEqual(expect.objectContaining({ recipientTotal: 1, sent: 1 }));
}

// Releases a frozen live sync and waits for the workspace to re-read the
// event, which it does once the held digest reports the change.
async function releaseAndReload(page, release, code) {
  const reloaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/events" &&
      url.searchParams.get("code") === code
    );
  });
  await release();
  expect((await reloaded).status()).toBe(200);
}

// The deadline as the Overview's Responses tile prints it: in the event's
// time zone, in the browser's locale.
async function shownDeadline(page, deadline, timeZone) {
  return page.evaluate(
    ([value, zone]) =>
      new Date(value).toLocaleString([], {
        timeZone: zone,
        timeZoneName: "short",
      }),
    [deadline, timeZone],
  );
}

// Clicks the organizer's "Download calendar (.ics)" and reads the file.
async function downloadCalendar(page) {
  const pending = page.waitForEvent("download");
  await page
    .locator("#organizer-finalize")
    .getByRole("button", { name: "Download calendar (.ics)" })
    .click();
  const download = await pending;
  return {
    filename: download.suggestedFilename(),
    body: await fs.readFile(await download.path(), "utf8"),
  };
}

// A call's status and error message.
async function expectRefusal(call, status, error) {
  const { response, payload } = await call;
  expect(response.status(), JSON.stringify(payload)).toBe(status);
  expect(payload.error).toBe(error);
  return payload;
}

test.describe("Event controls", () => {
  test("closing, a stale reopen, archiving and reactivating show each state, cancel queued emails and lock an archived event", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startLifecycleEvent(
      { page, request },
      "controls",
    );
    recomputeEventResults(code);
    const [pendingInvitation, retryReminder, sentInvitation] = seedDeliveryJobs(
      code,
      [
        {
          type: "invitation",
          status: "pending",
          recipient: `queued-${runId}@example.com`,
        },
        {
          type: "reminder",
          status: "retry",
          recipient: `retry-${runId}@example.com`,
        },
        {
          type: "invitation",
          status: "sent",
          recipient: `sent-${runId}@example.com`,
        },
      ],
    );

    await openWorkspace(page, event);
    await expectLifecycleState(page, "active");

    // Closing stops responses but keeps editing open, and cancels the
    // invitation and reminder emails still waiting to go out. One already
    // sent stays sent.
    let response = await clickLifecycleButton(page, "Close responses", code);
    expect(response.status()).toBe(200);
    await expectLifecycleState(page, "closed");
    await expect(
      page.getByRole("button", { name: "Edit event" }),
    ).toBeEnabled();
    expect((await eventState(request, token, code)).status).toBe("closed");
    expect(
      deliveryJobStates([pendingInvitation, retryReminder, sentInvitation]),
    ).toEqual([
      { status: "canceled", lastError: NOT_ACCEPTING },
      { status: "canceled", lastError: NOT_ACCEPTING },
      { status: "sent", lastError: "" },
    ]);

    // Another session moves the deadline into the past while this page's
    // live sync is held, so the page still holds the old version and its
    // reopening is refused.
    const release = await freezeLiveSync(page);
    const pastDeadline = new Date(Date.now() - 3_600_000).toISOString();
    await updateEventViaApi(request, token, code, {
      responseDeadline: pastDeadline,
    });
    response = await clickLifecycleButton(page, "Reactivate event", code);
    expect(response.status()).toBe(409);
    const alert = eventControls(page).getByRole("alert");
    await expect(alert).toHaveText(STALE_LIFECYCLE);
    await expectLifecycleState(page, "closed");

    // Once the page has the latest event, reopening clears the passed
    // deadline, since an active event needs one ahead of it.
    await releaseAndReload(page, release, code);
    await expect(overviewTile(page, "Responses")).toContainText(
      await shownDeadline(page, pastDeadline, event.timezone),
    );
    response = await clickLifecycleButton(page, "Reactivate event", code);
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().responseDeadline).toBeNull();
    expect((await response.json()).cancellationDeliveryRequestId).toBeNull();
    await expect(alert).toHaveCount(0);
    await expectLifecycleState(page, "active");
    await expect(overviewTile(page, "Responses")).toContainText("No deadline");
    expect(
      (await eventState(request, token, code)).responseDeadline,
    ).toBeNull();

    // Archiving an active event cancels queued reminders too, and locks
    // editing, blocked times and finalizing.
    const [queuedReminder] = seedDeliveryJobs(code, [
      {
        type: "reminder",
        status: "pending",
        recipient: `later-${runId}@example.com`,
      },
    ]);
    response = await clickLifecycleButton(page, "Archive event", code);
    expect(response.status()).toBe(200);
    await expectLifecycleState(page, "archived");
    expect(deliveryJobStates([queuedReminder])).toEqual([
      { status: "canceled", lastError: NOT_ACCEPTING },
    ]);
    await expectEditingLocked(page, ARCHIVED_LOCK);

    // A time can still be picked to look at, but not reviewed or finalized.
    await chooseRecommendedTime(page, 0);
    const finalize = page.locator("#organizer-finalize");
    await expect(finalize.getByRole("note")).toHaveText(
      "Reactivate this event before reviewing and finalizing a meeting time.",
    );
    await expect(
      finalize.getByRole("button", { name: "Review attendance" }),
    ).toBeDisabled();
    await expect(
      finalize.getByRole("button", { name: "Finalize meeting" }),
    ).toBeDisabled();

    // Reactivating reopens responses and clears the pick.
    response = await clickLifecycleButton(page, "Reactivate event", code);
    expect(response.status()).toBe(200);
    await expectLifecycleState(page, "active");
    await expect(finalize).toContainText("No time selected yet");
    await expect(finalize.getByRole("note")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Edit event" }),
    ).toBeEnabled();
    expect((await eventState(request, token, code)).status).toBe("active");
  });

  test("the server's refusals show in the event controls and change nothing", async ({
    page,
    request,
  }) => {
    const { token, event, code } = await startLifecycleEvent(
      { page, request },
      "refusals",
    );
    // An active event refuses a passed deadline, so it is closed first.
    await setLifecycleViaApi(request, token, code, "closed");
    const deadline = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await updateEventViaApi(request, token, code, {
      responseDeadline: deadline,
    });
    await openWorkspace(page, event);
    await expectLifecycleState(page, "closed");

    // This browser's clock runs three hours behind the server's, so it still
    // sees the response deadline ahead and asks to keep it. The server,
    // whose deadline has passed, refuses to reopen with it.
    await page.clock.setFixedTime(new Date(Date.parse(deadline) - 3_600_000));
    const refused = await clickLifecycleButton(page, "Reactivate event", code);
    expect(refused.status()).toBe(400);
    expect(Date.parse(refused.request().postDataJSON().responseDeadline)).toBe(
      Date.parse(deadline),
    );
    const alert = eventControls(page).getByRole("alert");
    await expect(alert).toHaveText(PAST_DEADLINE);
    await expectLifecycleState(page, "closed");
    const refusedState = await eventState(request, token, code);
    expect(refusedState.status).toBe("closed");
    expect(Date.parse(refusedState.responseDeadline)).toBe(
      Date.parse(deadline),
    );

    // Once the meeting is finalized (in another session), reopening is
    // previewed first; the refused preview shows in the controls, and
    // nothing is reopened.
    const results = await freshResults(request, token, code);
    await finalizeViaApi(request, token, code, results.recommendations[0]);
    await wakeLiveSync(page);
    await expect(
      eventControls(page).locator(".organizer-lifecycle-panel__status"),
    ).toHaveText("finalized", { timeout: LIVE_SYNC_TIMEOUT_MS });
    const lifecyclePuts = requestRecorder(
      page,
      (candidate) =>
        candidate.method() === "PUT" &&
        candidate.url().includes(`/events/lifecycle?code=${code}`),
    );
    // The 400's alert (the same words) is still up, so the preview is held
    // until the new attempt has cleared it: the alert that follows is the
    // preview's own.
    await expect(alert).toHaveText(PAST_DEADLINE);
    const heldPreviews = [];
    const isPreview = (url) =>
      url.pathname === "/events/lifecycle/preview" &&
      url.searchParams.get("code") === code;
    const holdPreview = (route) => {
      if (route.request().method() === "POST") heldPreviews.push(route);
      else route.fallback();
    };
    await page.route(isPreview, holdPreview);
    const reactivate = eventControls(page).getByRole("button", {
      name: "Reactivate event",
    });
    await reactivate.click();
    await expect.poll(() => heldPreviews.length).toBe(1);
    await expect(alert).toHaveCount(0);
    await expect(reactivate).toBeDisabled();
    const refusedPreview = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        candidate.url().includes(lifecyclePreviewUrl(code)),
    );
    await heldPreviews[0].continue();
    expect((await refusedPreview).status()).toBe(409);
    await page.unroute(isPreview, holdPreview);
    await expect(alert).toHaveText(PAST_DEADLINE);
    await expect(reactivate).toBeEnabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectLifecycleState(page, "finalized");
    expect(lifecyclePuts.entries).toEqual([]);
    expect(await eventState(request, token, code)).toMatchObject({
      status: "finalized",
      responseDeadline: expect.any(String),
    });

    // With the clock right, the passed deadline is cleared and the event
    // reopens at once (nobody was emailed the confirmation).
    await page.clock.setFixedTime(new Date());
    const reopened = await clickLifecycleButton(page, "Reactivate event", code);
    expect(reopened.status()).toBe(202);
    expect(reopened.request().postDataJSON().responseDeadline).toBeNull();
    await expect(alert).toHaveCount(0);
    await expectLifecycleState(page, "active");
    expect(
      (await eventState(request, token, code)).responseDeadline,
    ).toBeNull();
  });

  test("the lifecycle API refuses strangers, missing or stale versions, malformed deadlines and illegal moves", async ({
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `lifecycle-api-${runId}@example.com`,
      "Lia",
      "Owner",
    );
    const stranger = await registerAccountViaApi(
      request,
      `lifecycle-stranger-${runId}@example.com`,
      "Sam",
      "Stranger",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `Lifecycle API ${runId}`,
    });
    const { code, version } = event;
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const change = (body, { as = token, query = `?code=${code}` } = {}) =>
      apiJson(request, "PUT", `/events/lifecycle${query}`, as, body);
    const preview = (body, { as = token, query = `?code=${code}` } = {}) =>
      apiJson(request, "POST", `/events/lifecycle/preview${query}`, as, body);
    const closeAt = { status: "closed", expectedVersion: version };

    await expectRefusal(
      change(closeAt, { query: "" }),
      400,
      "code is required",
    );
    await expectRefusal(
      change(closeAt, { query: `?code=NONE${runId}` }),
      404,
      "Event not found",
    );
    await expectRefusal(
      change(closeAt, { as: stranger.access }),
      403,
      "Only the organizer can change event lifecycle",
    );
    for (const expectedVersion of [undefined, String(version), true]) {
      await expectRefusal(
        change({ status: "closed", expectedVersion }),
        428,
        "expectedVersion is required",
      );
    }
    await expectRefusal(
      change({ ...closeAt, responseDeadline: "next Tuesday" }),
      400,
      "responseDeadline must be an ISO datetime",
    );
    await expectRefusal(
      change({ status: "draft", expectedVersion: version }),
      400,
      "Invalid event status.",
    );
    await expectRefusal(
      change({ status: "finalized", expectedVersion: version }),
      400,
      "Confirm a final meeting time to finalize the event.",
    );
    await expectRefusal(
      change({
        status: "active",
        expectedVersion: version,
        responseDeadline: past,
      }),
      400,
      PAST_DEADLINE,
    );
    expect(await eventState(request, token, code)).toMatchObject({
      status: "active",
      version,
    });

    // Closing answers 200 with no cancellation. A repeat with the old
    // version for the same state is a replay; another move with it is
    // refused with the current event.
    const closed = await change(closeAt);
    expect(closed.response.status()).toBe(200);
    expect(closed.payload).toMatchObject({
      event: { status: "closed", version: version + 1 },
      cancellationEnqueued: 0,
      cancellationDeliveryRequestId: null,
    });
    const replay = await change(closeAt);
    expect(replay.response.status()).toBe(200);
    expect(replay.payload.event.version).toBe(version + 1);
    const stale = await expectRefusal(
      change({ status: "archived", expectedVersion: version }),
      409,
      STALE_LIFECYCLE,
    );
    expect(stale.event).toMatchObject({
      status: "closed",
      version: version + 1,
    });

    const archived = await change({
      status: "archived",
      expectedVersion: version + 1,
    });
    expect(archived.response.status()).toBe(200);
    await expectRefusal(
      change({ status: "closed", expectedVersion: version + 2 }),
      400,
      "Cannot transition an event from archived to closed.",
    );

    // The preview has the same guards, and answers a refusal with 409.
    await expectRefusal(
      preview({ status: "active" }, { query: "" }),
      400,
      "code is required",
    );
    await expectRefusal(
      preview({ status: "active" }, { query: `?code=NONE${runId}` }),
      404,
      "Event not found",
    );
    await expectRefusal(
      preview({ status: "active" }, { as: stranger.access }),
      403,
      "Only the organizer can change event lifecycle",
    );
    await expectRefusal(
      preview({ status: "active", responseDeadline: "soon" }),
      400,
      "responseDeadline must be an ISO datetime",
    );
    await expectRefusal(
      preview({ status: "closed" }),
      409,
      "Cannot transition an event from archived to closed.",
    );
    await expectRefusal(
      preview({ status: "finalized" }),
      409,
      "Confirm a final meeting time to finalize the event.",
    );
    await expectRefusal(
      preview({ status: "active", responseDeadline: past }),
      409,
      PAST_DEADLINE,
    );
    // Reopening an event without a confirmed meeting emails nobody, and a
    // preview changes nothing.
    const reopening = await preview({ status: "active" });
    expect(reopening.response.status()).toBe(200);
    expect(reopening.payload).toEqual({
      cancellation: { recipientCount: 0, email: null, sample: null },
    });
    expect(await eventState(request, token, code)).toMatchObject({
      status: "archived",
      version: version + 2,
    });

    // A blank deadline clears it.
    const reactivated = await change({
      status: "active",
      expectedVersion: version + 2,
      responseDeadline: "",
    });
    expect(reactivated.response.status()).toBe(200);
    expect(reactivated.payload.event).toMatchObject({
      status: "active",
      responseDeadline: null,
    });
  });
});

test.describe("Reopening a finalized event", () => {
  test("a closed event can be finalized, locks editing, and reopens at once when nobody was emailed", async ({
    page,
    request,
  }) => {
    const { token, event, code } = await startLifecycleEvent(
      { page, request },
      "closed-final",
    );
    await setLifecycleViaApi(request, token, code, "closed");
    recomputeEventResults(code);
    await openWorkspace(page, event);
    await expectLifecycleState(page, "closed");

    // Closing responses does not stop finalizing.
    await chooseRecommendedTime(page, 0);
    await finalizeCurrentSelection(page, code);
    await expectLifecycleState(page, "finalized");
    await expectEditingLocked(page, CONFIRMED_LOCK);

    // Reopening asks who would be told the meeting is canceled; nobody
    // received the confirmation, so it reopens without a review.
    const previewed = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        candidate.url().includes(lifecyclePreviewUrl(code)),
    );
    const reopened = await clickLifecycleButton(page, "Reactivate event", code);
    const preview = await previewed;
    expect(preview.status()).toBe(200);
    expect(await preview.json()).toEqual({
      cancellation: { recipientCount: 0, email: null, sample: null },
    });
    // The canceled meeting still gets a cancellation run, with no emails.
    expect(reopened.status()).toBe(202);
    const reopenedBody = await reopened.json();
    expect(reopenedBody.cancellationEnqueued).toBe(0);
    expect(reopenedBody.cancellationDeliveryRequestId).toEqual(
      expect.any(String),
    );
    await expect(
      page.getByRole("dialog", { name: "Reopen scheduling" }),
    ).toHaveCount(0);
    await expectLifecycleState(page, "active");
    const finalize = page.locator("#organizer-finalize");
    await expect(finalize).toContainText("No time selected yet");
    await expect(finalize.locator(".finalized-meeting")).toHaveCount(0);
    const delivery = page.getByLabel("Event delivery progress");
    await expect(delivery).toContainText("Final cancellation delivery");
    await expect(delivery.getByText("0 total")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit event" }),
    ).toBeEnabled();
    expect(await eventState(request, token, code)).toMatchObject({
      status: "active",
      finalMeeting: null,
    });

    // A later reactivation cancels nothing, so it reports no cancellation
    // run, not the earlier one.
    let response = await clickLifecycleButton(page, "Close responses", code);
    expect(response.status()).toBe(200);
    await expectLifecycleState(page, "closed");
    response = await clickLifecycleButton(page, "Reactivate event", code);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      cancellationEnqueued: 0,
      cancellationDeliveryRequestId: null,
    });
    await expectLifecycleState(page, "active");

    // A closed event can be archived from the workspace too.
    response = await clickLifecycleButton(page, "Close responses", code);
    expect(response.status()).toBe(200);
    response = await clickLifecycleButton(page, "Archive event", code);
    expect(response.status()).toBe(200);
    await expectLifecycleState(page, "archived");
    expect((await eventState(request, token, code)).status).toBe("archived");
  });

  test("a refused reopening stays on the confirmation step with its error", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startLifecycleEvent(
      { page, request },
      "reopen-error",
    );
    const patEmail = `pat-${runId}@example.com`;
    await finalizeWithEmailedPerson(request, token, event, {
      name: "Pat Person",
      email: patEmail,
    });
    const subject = `Scheduling reopened: ${event.name}`;

    // The preview names who would be told, and refuses what the lifecycle
    // would refuse.
    const preview = await apiJson(
      request,
      "POST",
      lifecyclePreviewUrl(code),
      token,
      { status: "active" },
    );
    expect(preview.response.status()).toBe(200);
    expect(preview.payload.cancellation).toMatchObject({
      recipientCount: 1,
      email: { subject },
      sample: { email: patEmail },
    });
    // Archiving a finalized meeting emails nobody.
    const archivePreview = await apiJson(
      request,
      "POST",
      lifecyclePreviewUrl(code),
      token,
      { status: "archived" },
    );
    expect(archivePreview.payload).toEqual({
      cancellation: { recipientCount: 0, email: null, sample: null },
    });
    await expectRefusal(
      apiJson(request, "POST", lifecyclePreviewUrl(code), token, {
        status: "closed",
      }),
      409,
      "Cannot transition an event from finalized to closed.",
    );

    await openWorkspace(page, event);
    await expectLifecycleState(page, "finalized");
    await eventControls(page)
      .getByRole("button", { name: "Reactivate event" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Reopen scheduling" });
    await reviewEmail(dialog, {
      summary: [
        "1 person who received the confirmation will be told the meeting is canceled.",
      ],
      to: patEmail,
      subject,
      attachments: `releviz-${code}-final.ics`,
      heading: "Scheduling reopened",
    });
    const send = await continueToConfirm(
      dialog,
      "Reopen and email 1 person?",
      "Reopen and send 1 email",
    );

    // Another session archives the event before the send, so the page's
    // version is stale: the dialog stays on its confirmation step with the
    // refusal, and nothing is canceled or emailed.
    const release = await freezeLiveSync(page);
    await setLifecycleViaApi(request, token, code, "archived");
    const attempt = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PUT" &&
        candidate.url().includes(`/events/lifecycle?code=${code}`),
    );
    await send.click();
    expect((await attempt).status()).toBe(409);
    await expect(dialog.getByText("Step 2 of 2: Confirm")).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText(STALE_LIFECYCLE);
    await expect(send).toBeEnabled();
    const stored = await eventState(request, token, code);
    expect(stored.status).toBe("archived");
    expect(stored.finalMeeting).toMatchObject({ active: true });
    expect(
      runDjangoJson(
        `
from apps.mail.models import EmailDeliveryJob

print(json.dumps(EmailDeliveryJob.objects.filter(
    event__code=data["code"], message_type="final_cancellation"
).count()))
`,
        { code },
      ),
    ).toBe(0);
    // Archived, the event still holds the meeting Pat was told about, so
    // the server would email Pat the cancellation on reopening it (the
    // workspace reviews that email first, as a test below shows).
    const archivedReopen = await apiJson(
      request,
      "POST",
      lifecyclePreviewUrl(code),
      token,
      { status: "active" },
    );
    expect(archivedReopen.response.status()).toBe(200);
    expect(archivedReopen.payload.cancellation).toMatchObject({
      recipientCount: 1,
      email: { subject },
      sample: { email: patEmail },
    });

    // Closing the dialog leaves the event as the other session left it.
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(dialog).toHaveCount(0);
    await releaseAndReload(page, release, code);
    await expectLifecycleState(page, "archived");
    await openFinalize(page);
    await expect(
      page.locator("#organizer-finalize .finalized-meeting"),
    ).toBeVisible();
  });
});

test.describe("Archiving a finalized event", () => {
  test("the workspace archives a finalized event and keeps its meeting and calendar file until it is reactivated", async ({
    page,
    request,
  }) => {
    const { token, event, code } = await startLifecycleEvent(
      { page, request },
      "archive-final",
    );
    const results = await freshResults(request, token, code);
    await finalizeViaApi(request, token, code, results.recommendations[0], {
      location: "Board Room",
    });
    const meeting = (await eventState(request, token, code)).finalMeeting;
    expect(meeting).toMatchObject({ location: "Board Room", active: true });

    await openWorkspace(page, event);
    await expectLifecycleState(page, "finalized");
    await openFinalize(page);
    const finalize = page.locator("#organizer-finalize");
    const meetingCard = finalize.locator(".finalized-meeting");
    await expect(meetingCard).toBeVisible();
    await expect(meetingCard.locator(".finalized-meeting__meta")).toHaveText(
      "In person · Board Room",
    );

    const archived = await clickLifecycleButton(page, "Archive event", code);
    expect(archived.status()).toBe(200);
    await expectLifecycleState(page, "archived");
    await expect(eventControls(page).getByRole("alert")).toHaveCount(0);
    await expect(meetingCard.locator(".finalized-meeting__meta")).toHaveText(
      "In person · Board Room",
    );
    await expect(overviewTile(page, "Confirmed meeting")).toContainText(
      "In-Person · Board Room",
    );
    await expectEditingLocked(page, CONFIRMED_LOCK);
    expect(await eventState(request, token, code)).toMatchObject({
      status: "archived",
      finalMeeting: { calendarUid: meeting.calendarUid, active: true },
    });

    // The calendar file downloads under the server's name while archived.
    await openFinalize(page);
    await expect(meetingCard).toBeVisible();
    const calendar = await downloadCalendar(page);
    expect(calendar.filename).toBe(`releviz-${code}-final.ics`);
    expect(calendar.body).toContain("METHOD:REQUEST");
    expect(calendar.body).toContain(`UID:${meeting.calendarUid}`);
    expect(calendar.body).toContain(`DTSTART:${icsUtc(meeting.startsAt)}`);
    expect(calendar.body).toContain("LOCATION:Board Room");

    // Reactivated in another session, the meeting is canceled: a download
    // from this page, which has not caught up yet, reports the server's
    // answer in an alert.
    const release = await freezeLiveSync(page);
    await setLifecycleViaApi(request, token, code, "active");
    const failed = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "GET" &&
        candidate.url().includes(`/events/finalization/calendar?code=${code}`),
    );
    await finalize
      .getByRole("button", { name: "Download calendar (.ics)" })
      .click();
    expect((await failed).status()).toBe(404);
    await expect(finalize.getByRole("alert")).toHaveText(
      "No active final meeting has been confirmed",
    );
    await releaseAndReload(page, release, code);
    await expectLifecycleState(page, "active");
    await expect(meetingCard).toHaveCount(0);
    await expect(overviewTile(page, "Confirmed meeting")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Edit event" }),
    ).toBeEnabled();
  });

  test("reactivating an archived event whose confirmation reached people reviews the cancellation email first", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startLifecycleEvent(
      { page, request },
      "archived-reopen",
    );
    const patEmail = `pat-${runId}@example.com`;
    await finalizeWithEmailedPerson(request, token, event, {
      name: "Pat Person",
      email: patEmail,
    });
    await setLifecycleViaApi(request, token, code, "archived");
    // The server would email Pat on reopening, and says so.
    const preview = await apiJson(
      request,
      "POST",
      lifecyclePreviewUrl(code),
      token,
      { status: "active" },
    );
    expect(preview.payload.cancellation.recipientCount).toBe(1);

    await openWorkspace(page, event);
    await expectLifecycleState(page, "archived");
    const lifecyclePuts = requestRecorder(
      page,
      (candidate) =>
        candidate.method() === "PUT" &&
        candidate.url().includes(`/events/lifecycle?code=${code}`),
    );
    await eventControls(page)
      .getByRole("button", { name: "Reactivate event" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Reopen scheduling" });
    await expect(
      dialog.getByText(
        "1 person who received the confirmation will be told the meeting is canceled.",
      ),
    ).toBeVisible();
    expect(lifecyclePuts.entries).toEqual([]);
    expect((await eventState(request, token, code)).status).toBe("archived");
    const send = await continueToConfirm(
      dialog,
      "Reopen and email 1 person?",
      "Reopen and send 1 email",
    );
    const reopened = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PUT" &&
        candidate.url().includes(`/events/lifecycle?code=${code}`),
    );
    await send.click();
    expect((await reopened).status()).toBe(202);
    await expectLifecycleState(page, "active");
  });

  test("the dashboard locks Edit on finalized and archived events and archives a finalized event with its meeting", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startLifecycleEvent(
      { page, request },
      "dashboard",
    );
    const results = await freshResults(request, token, code);
    await finalizeViaApi(request, token, code, results.recommendations[0]);
    const meeting = (await eventState(request, token, code)).finalMeeting;
    const closedEvent = await createEvent(request, token, {
      name: `Lifecycle dashboard closed ${runId}`,
    });
    await setLifecycleViaApi(request, token, closedEvent.code, "closed");

    await page.goto("/dashboard");
    const cardFor = (name) =>
      page
        .getByRole("link", { name, exact: true })
        .locator("xpath=ancestor::article");
    const finalizedCard = cardFor(event.name);
    const closedCard = cardFor(closedEvent.name);
    await expect(finalizedCard.getByText("Status: finalized")).toBeVisible();
    await expect(closedCard.getByText("Status: closed")).toBeVisible();
    // A closed event can still be edited; a finalized one cannot.
    await expect(
      closedCard.getByRole("link", { name: "Edit" }),
    ).toHaveAttribute("aria-disabled", "false");
    const lockedEdit = finalizedCard.getByRole("link", { name: "Edit" });
    await expect(lockedEdit).toHaveAttribute("aria-disabled", "true");
    // The pointer cannot reach it, and a click that does (the keyboard's, or
    // one dispatched to it) is swallowed.
    await expect(lockedEdit).toHaveCSS("pointer-events", "none");
    await lockedEdit.focus();
    await page.keyboard.press("Enter");
    await lockedEdit.dispatchEvent("click");

    // The dashboard offers Archive for a finalized event, and archiving
    // keeps its confirmed meeting.
    await finalizedCard.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText(`${event.name} was archived.`)).toBeVisible();
    await expect(finalizedCard.getByText("Status: archived")).toBeVisible();
    await expect(
      finalizedCard.getByRole("button", { name: "Archive" }),
    ).toHaveCount(0);
    await expect(
      finalizedCard.getByRole("link", { name: "Edit" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(await eventState(request, token, code)).toMatchObject({
      status: "archived",
      finalMeeting: { calendarUid: meeting.calendarUid, active: true },
    });
    // By now a navigation from the locked Edit would have landed.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { name: "My Dashboard" }),
    ).toBeVisible();
  });
});

test.describe("Finalize", () => {
  test("reviews attendance person by person, finalizes at the location typed, and cancels availability emails still queued", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startLifecycleEvent(
      { page, request },
      "attendance",
    );
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    const tue14 = slotIndex(event, "weekday:2", "14:00");
    const person = (name) => ({
      name,
      email: `${name.split(" ")[0].toLowerCase()}-${runId}@example.com`,
    });
    // Ada Answer (from the setup) is free Monday 10:00-11:00; Ben only if
    // needed; Cam on Tuesday instead; Dee never answers; Eve is hidden and
    // Fay left out of the results.
    await submitValues(request, token, event, {
      ...person("Ben Maybe"),
      values: { [mon10]: 0.5, [mon10 + 1]: 0.5 },
    });
    await submitResponse(request, token, event, {
      ...person("Cam Busy"),
      inperson: [tue14, tue14 + 1],
    });
    await addPersonApi(request, code, token, person("Dee Silent"));
    const eve = await submitResponse(request, token, event, {
      ...person("Eve Hidden"),
      inperson: [mon10, mon10 + 1],
    });
    const hidden = await apiJson(
      request,
      "DELETE",
      `/events/participants/update?code=${code}&participantId=${eve.id}`,
      token,
    );
    expect(hidden.response.status()).toBe(200);
    const fay = person("Fay Excluded");
    await submitResponse(request, token, event, {
      ...fay,
      inperson: [mon10, mon10 + 1],
    });
    const fayEntry = (await rosterByEmail(request, code, token)).get(fay.email);
    const excluded = await apiJson(
      request,
      "PATCH",
      `/events/roster/${fayEntry.id}?code=${code}`,
      token,
      { included: false, expectedVersion: fayEntry.version },
    );
    expect(excluded.response.status()).toBe(200);
    const best = (await freshResults(request, token, code)).recommendations[0];
    await expectRefusal(
      apiJson(request, "GET", `/events/finalization?code=${code}`, token),
      404,
      "No final meeting has been confirmed",
    );
    const queued = seedDeliveryJobs(code, [
      {
        type: "invitation",
        status: "pending",
        recipient: `queued-${runId}@example.com`,
      },
      {
        type: "reminder",
        status: "retry",
        recipient: `retry-${runId}@example.com`,
      },
      {
        type: "invitation",
        status: "sent",
        recipient: `sent-${runId}@example.com`,
      },
    ]);

    await openWorkspace(page, event);
    await chooseRecommendedTime(page, 0);
    const finalize = page.locator("#organizer-finalize");
    const finalizeButton = finalize.getByRole("button", {
      name: "Finalize meeting",
    });
    const currentStep = finalize.locator('[aria-current="step"]');
    const reviewNotice = finalize.getByText(
      "Attendance review is current for this candidate.",
    );
    const tiles = finalize.getByRole("group", { name: "Attendance review" });
    // Finalizing waits for a review of the time picked.
    await expect(currentStep).toHaveText("Review attendance");
    await expect(finalizeButton).toBeDisabled();

    await reviewAttendance(page);
    await expect(currentStep).toHaveText("Finalize meeting");
    await expect(finalizeButton).toBeEnabled();
    for (const [label, value] of [
      ["Available", "1"],
      ["Partial", "1"],
      ["Unavailable", "1"],
      ["Unanswered", "1"],
      ["Excluded", "2"],
    ]) {
      await expect(attendanceTile(page, label)).toHaveText(value);
    }
    const attendance = finalize.getByRole("region", {
      name: "Attendance by person",
    });
    await expect(attendance.getByRole("row")).toHaveCount(7);
    for (const [name, response, availability] of [
      ["Ada Answer", "Submitted", "Fully available · 100%"],
      ["Ben Maybe", "Submitted", "Partly available · 50%"],
      ["Cam Busy", "Submitted", "Not available · 0%"],
      ["Dee Silent", "Not submitted", "—"],
      ["Eve Hidden", "Not included", "Hidden from results"],
      ["Fay Excluded", "Not included", "Excluded by organizer"],
    ]) {
      const row = attendance
        .getByRole("row")
        .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
      await expect(row.getByRole("cell")).toHaveText([response, availability]);
    }

    // The location starts as the event's own. Editing it clears the review.
    const location = finalize.getByRole("textbox", {
      name: "Location or meeting link",
    });
    await expect(location).toHaveValue("Calendar Room");
    await location.fill("Studio 9");
    await expect(reviewNotice).toHaveCount(0);
    await expect(tiles).toHaveCount(0);
    await expect(currentStep).toHaveText("Review attendance");
    await expect(finalizeButton).toBeDisabled();

    // A review still on its way when the location changes again is dropped
    // on arrival.
    const previewPattern = /\/events\/finalization\/preview\?/;
    const heldReviews = [];
    const holdFirstReview = (route) => {
      if (route.request().method() === "POST" && heldReviews.length === 0) {
        heldReviews.push(route);
      } else {
        route.fallback();
      }
    };
    await page.route(previewPattern, holdFirstReview);
    await finalize.getByRole("button", { name: "Review attendance" }).click();
    await expect.poll(() => heldReviews.length).toBe(1);
    await expect(
      finalize.getByRole("button", { name: "Reviewing…" }),
    ).toBeDisabled();
    await location.fill("Studio 4");
    const answered = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        previewPattern.test(candidate.url()),
    );
    await heldReviews[0].continue();
    expect((await answered).status()).toBe(200);
    await page.unroute(previewPattern, holdFirstReview);
    await expect(
      finalize.getByRole("button", { name: "Review attendance" }),
    ).toBeEnabled();
    await expect(reviewNotice).toHaveCount(0);
    await expect(tiles).toHaveCount(0);
    await expect(finalizeButton).toBeDisabled();

    // Reviewed again, the meeting is finalized where it was typed.
    await finalizeCurrentSelection(page, code);
    await expect(finalize.locator(".finalized-meeting__meta")).toHaveText(
      "In person · Studio 4",
    );
    await expect(overviewTile(page, "Confirmed meeting")).toContainText(
      "In-Person · Studio 4",
    );
    const meeting = (await eventState(request, token, code)).finalMeeting;
    expect(meeting.location).toBe("Studio 4");
    expect(Date.parse(meeting.startsAt)).toBe(
      Date.parse(best.suggestedStartsAt),
    );

    // Finalizing canceled the invitation and reminder emails still queued,
    // so none of them crosses the confirmed meeting; a sent one is kept.
    expect(deliveryJobStates(queued)).toEqual([
      { status: "canceled", lastError: FINALIZED_FIRST },
      { status: "canceled", lastError: FINALIZED_FIRST },
      { status: "sent", lastError: "" },
    ]);

    // The organizer reads the confirmed meeting, its attendance and its
    // delivery back.
    const finalization = await apiJson(
      request,
      "GET",
      `/events/finalization?code=${code}`,
      token,
    );
    expect(finalization.response.status()).toBe(200);
    expect(finalization.payload).toMatchObject({
      event: { status: "finalized" },
      finalMeeting: {
        location: "Studio 4",
        calendarUid: meeting.calendarUid,
        active: true,
        attendance: {
          availableParticipantTotal: 1,
          partialParticipantTotal: 1,
          unavailableParticipantTotal: 1,
          unansweredParticipantTotal: 1,
          excludedParticipantTotal: 2,
        },
      },
      delivery: { recipientTotal: 0, sent: 0, pending: 0 },
    });

    const calendar = await downloadCalendar(page);
    expect(calendar.filename).toBe(`releviz-${code}-final.ics`);
    expect(calendar.body).toContain("METHOD:REQUEST");
    expect(calendar.body).toContain("LOCATION:Studio 4");
    expect(calendar.body).toContain(`UID:${meeting.calendarUid}`);
  });

  test("a refused finalization stays on the confirmation step, and one made elsewhere closes the open dialog", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startLifecycleEvent(
      { page, request },
      "finalize-refused",
    );
    const best = (await freshResults(request, token, code)).recommendations[0];
    await openWorkspace(page, event);
    await chooseRecommendedTime(page, 0);
    await reviewAttendance(page);
    const finalize = page.locator("#organizer-finalize");
    await finalize.getByRole("button", { name: "Finalize meeting" }).click();
    const dialog = page.getByRole("dialog", { name: "Finalize meeting" });
    const send = await continueToConfirm(
      dialog,
      "Finalize without emailing anyone?",
      "Finalize meeting",
    );

    // An invitation is being handed to the email provider right now, so
    // finalizing is refused until it is done; the dialog keeps its step.
    const [inFlight] = seedDeliveryJobs(code, [
      {
        type: "invitation",
        status: "processing",
        recipient: `in-flight-${runId}@example.com`,
      },
    ]);
    const finalizationPut = (candidate) =>
      candidate.request().method() === "PUT" &&
      candidate.url().includes(`/events/finalization?code=${code}`);
    try {
      let attempt = page.waitForResponse(finalizationPut);
      await send.click();
      const refused = await attempt;
      expect(refused.status()).toBe(409);
      await expect(dialog.getByText("Step 2 of 2: Confirm")).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveText(
        "Wait for in-progress invitations and reminders to finish before finalizing.",
      );
      await expect(send).toBeEnabled();
      await expectLifecycleState(page, "active");
      expect((await eventState(request, token, code)).status).toBe("active");

      // Once it is sent, trying again (with the same idempotency key)
      // finalizes.
      finishDeliveryJob(inFlight);
      attempt = page.waitForResponse(finalizationPut);
      await send.click();
      const accepted = await attempt;
      expect(accepted.status()).toBe(202);
      expect(accepted.request().postDataJSON().idempotencyKey).toBe(
        refused.request().postDataJSON().idempotencyKey,
      );
    } finally {
      finishDeliveryJob(inFlight);
    }
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("The meeting is finalized. Nobody was emailed."),
    ).toBeVisible();
    await expectLifecycleState(page, "finalized");

    // Reopened and reviewed again, the dialog is open when another session
    // finalizes the same time: the workspace closes it and shows the
    // confirmed meeting.
    const reopened = await clickLifecycleButton(page, "Reactivate event", code);
    expect(reopened.status()).toBe(202);
    await expectLifecycleState(page, "active");
    await chooseRecommendedTime(page, 0);
    await reviewAttendance(page);
    await finalize.getByRole("button", { name: "Finalize meeting" }).click();
    await expect(dialog.getByText("Step 1 of 2: Review")).toBeVisible();
    await finalizeViaApi(request, token, code, best);
    await wakeLiveSync(page);
    await expect(dialog).toHaveCount(0, { timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(finalize.locator(".finalized-meeting")).toBeVisible();
    await expectLifecycleState(page, "finalized");
  });

  test("the finalization API validates the time, versions, keys and permissions, and serves the meeting to the organizer only", async ({
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `finalize-api-${runId}@example.com`,
      "Fin",
      "Owner",
    );
    const stranger = await registerAccountViaApi(
      request,
      `finalize-stranger-${runId}@example.com`,
      "Sam",
      "Stranger",
    );
    const token = organizer.access;
    // Monday 09:00-10:00 is blocked.
    const event = await createEvent(request, token, {
      name: `Finalize API ${runId}`,
      blockedSlots: { "weekday:1": [0, 1] },
    });
    const { code } = event;
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, token, event, {
      name: "Ada Answer",
      email: `ada-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    const monday = isoDate(weekStartMs() + 8 * DAY_MS);
    const saturday = isoDate(weekStartMs() + 13 * DAY_MS);
    const window = (start, end, extra = {}) => ({
      startsAt: `${monday}T${start}:00+00:00`,
      endsAt: `${monday}T${end}:00+00:00`,
      channel: "inperson",
      location: "",
      ...extra,
    });
    const onDay = (date) => ({
      startsAt: `${date}T10:00:00+00:00`,
      endsAt: `${date}T11:00:00+00:00`,
    });
    const reviewAs = (body, { as = token, query = `?code=${code}` } = {}) =>
      apiJson(
        request,
        "POST",
        `/events/finalization/preview${query}`,
        as,
        body,
      );
    const confirmAs = (body, { as = token, query = `?code=${code}` } = {}) =>
      apiJson(request, "PUT", `/events/finalization${query}`, as, body);
    const readAs = (as) =>
      apiJson(request, "GET", `/events/finalization?code=${code}`, as);
    const calendarAs = (as, headers = {}) =>
      request.get(`${BACKEND_URL}/events/finalization/calendar?code=${code}`, {
        headers: { Authorization: `Bearer ${as}`, ...headers },
      });
    const ten = window("10:00", "11:00");

    // Nothing is confirmed yet.
    await expectRefusal(
      readAs(token),
      404,
      "No final meeting has been confirmed",
    );
    await expectRefusal(
      readAs(stranger.access),
      403,
      "Only the organizer can view finalization details",
    );
    const noMeeting = await calendarAs(token);
    expect(noMeeting.status()).toBe(404);
    expect((await noMeeting.json()).error).toBe(
      "No active final meeting has been confirmed",
    );

    // The review checks who asks, then the time.
    await expectRefusal(reviewAs(ten, { query: "" }), 400, "code is required");
    await expectRefusal(
      reviewAs(ten, { query: `?code=NONE${runId}` }),
      404,
      "Event not found",
    );
    await expectRefusal(
      reviewAs(ten, { as: stranger.access }),
      403,
      "Only the organizer can review a final meeting time",
    );
    for (const [body, error] of [
      [{ ...ten, startsAt: 5 }, "startsAt must be an ISO datetime"],
      [
        { ...ten, endsAt: `${monday}T11:00:00` },
        "endsAt must include an explicit UTC offset",
      ],
      [
        window("11:00", "10:00"),
        "Final meeting end time must be after its start time.",
      ],
      [{ ...ten, channel: "virtual" }, "virtual is not valid for this event."],
      [
        window("10:15", "11:15"),
        "The final meeting must fit inside the event window and align to 30-minute slots.",
      ],
      [
        { ...ten, ...onDay(saturday) },
        "The final meeting day is not enabled for this event.",
      ],
      [
        window("09:00", "10:00"),
        "The confirmed meeting overlaps a blocked slot.",
      ],
      [
        window("10:00", "10:30"),
        "The final meeting must be exactly 60 minutes long.",
      ],
      [
        { ...ten, location: "x".repeat(501) },
        "Final meeting location is too long (max 500).",
      ],
    ]) {
      await expectRefusal(reviewAs(body), 400, error);
    }
    const current = await eventState(request, token, code);
    const reviewed = await reviewAs(ten);
    expect(reviewed.response.status()).toBe(200);
    // A blank location falls back to the event's own.
    expect(reviewed.payload).toMatchObject({
      eventVersion: current.version,
      proposedMeeting: { location: "Calendar Room", channel: "inperson" },
      attendance: { availableParticipantTotal: 1, countedResponseTotal: 1 },
      recipientCount: 0,
    });

    // Confirming checks the request, who asks, the version and the time.
    const version = current.version;
    const key = () => crypto.randomUUID();
    await expectRefusal(
      confirmAs({ ...ten, idempotencyKey: key() }),
      428,
      "expectedVersion is required",
    );
    await expectRefusal(
      confirmAs({ ...ten, expectedVersion: version, idempotencyKey: "one" }),
      400,
      "idempotencyKey must be a UUID",
    );
    await expectRefusal(
      confirmAs(
        { ...ten, expectedVersion: version, idempotencyKey: key() },
        { query: `?code=NONE${runId}` },
      ),
      404,
      "Event not found.",
    );
    await expectRefusal(
      confirmAs(
        { ...ten, expectedVersion: version, idempotencyKey: key() },
        { as: stranger.access },
      ),
      403,
      "Only the organizer can confirm a final meeting time.",
    );
    await expectRefusal(
      confirmAs({
        ...ten,
        expectedVersion: version - 1,
        idempotencyKey: key(),
      }),
      409,
      "The event changed in another session. Refresh and review the final time again.",
    );
    await expectRefusal(
      confirmAs({
        ...window("09:00", "10:00"),
        expectedVersion: version,
        idempotencyKey: key(),
      }),
      400,
      "The confirmed meeting overlaps a blocked slot.",
    );
    const [inFlight] = seedDeliveryJobs(code, [
      {
        type: "reminder",
        status: "processing",
        recipient: `in-flight-${runId}@example.com`,
      },
    ]);
    try {
      await expectRefusal(
        confirmAs({ ...ten, expectedVersion: version, idempotencyKey: key() }),
        409,
        "Wait for in-progress invitations and reminders to finish before finalizing.",
      );
    } finally {
      finishDeliveryJob(inFlight);
    }

    // A confirmation replays under its key, and nothing else can reuse the
    // key or move the confirmed time.
    const firstKey = key();
    const room = { ...ten, location: "Room 1" };
    const first = await confirmAs({
      ...room,
      expectedVersion: version,
      idempotencyKey: firstKey,
    });
    expect(first.response.status()).toBe(202);
    expect(first.payload).toMatchObject({
      idempotent: false,
      event: { status: "finalized", version: version + 1 },
      finalMeeting: { location: "Room 1", active: true },
      delivery: { recipientTotal: 0 },
      deliveryRequestId: expect.any(String),
    });
    const replay = await confirmAs({
      ...room,
      expectedVersion: version,
      idempotencyKey: firstKey,
    });
    expect(replay.response.status()).toBe(202);
    expect(replay.payload).toMatchObject({
      idempotent: true,
      finalMeeting: {
        calendarUid: first.payload.finalMeeting.calendarUid,
        calendarSequence: first.payload.finalMeeting.calendarSequence,
      },
    });
    await expectRefusal(
      confirmAs({
        ...ten,
        location: "Room 2",
        expectedVersion: version,
        idempotencyKey: firstKey,
      }),
      409,
      "This idempotency key was already used with different final-time details.",
    );
    await expectRefusal(
      confirmAs({
        ...window("11:00", "12:00"),
        expectedVersion: version + 1,
        idempotencyKey: key(),
      }),
      409,
      "Reopen the event before changing its confirmed meeting time.",
    );
    const same = await confirmAs({
      ...room,
      expectedVersion: version + 1,
      idempotencyKey: key(),
    });
    expect(same.response.status()).toBe(202);
    expect(same.payload.idempotent).toBe(true);

    // Only the organizer reads it back; the calendar file goes to the
    // organizer, with its file name readable by the web app's origin.
    const read = await readAs(token);
    expect(read.response.status()).toBe(200);
    expect(read.payload).toMatchObject({
      finalMeeting: {
        location: "Room 1",
        active: true,
        attendance: { availableParticipantTotal: 1 },
      },
      delivery: { recipientTotal: 0 },
    });
    await expectRefusal(
      readAs(stranger.access),
      403,
      "Only the organizer can view finalization details",
    );
    const strangerCalendar = await calendarAs(stranger.access);
    expect(strangerCalendar.status()).toBe(403);
    expect((await strangerCalendar.json()).error).toBe(
      "You do not have access to this calendar invitation",
    );
    const organizerCalendar = await calendarAs(token, { Origin: FRONTEND_URL });
    expect(organizerCalendar.status()).toBe(200);
    expect(organizerCalendar.headers()["content-disposition"]).toBe(
      `attachment; filename="releviz-${code}-final.ics"`,
    );
    expect(
      organizerCalendar.headers()["access-control-expose-headers"],
    ).toMatch(/content-disposition/i);
    const ics = await organizerCalendar.text();
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("LOCATION:Room 1");

    // Archived, the meeting is kept but nothing can be reviewed or
    // confirmed.
    const archived = await setLifecycleViaApi(request, token, code, "archived");
    await expectRefusal(
      reviewAs(ten),
      409,
      "An event cannot be finalized while it is archived.",
    );
    await expectRefusal(
      confirmAs({
        ...ten,
        expectedVersion: archived.version,
        idempotencyKey: key(),
      }),
      409,
      "An event cannot be finalized while it is archived.",
    );
    expect((await calendarAs(token)).status()).toBe(200);

    // Reactivated, the meeting is canceled: the calendar file is gone, the
    // record says so, and the first confirmation cannot be replayed.
    await setLifecycleViaApi(request, token, code, "active");
    const canceledCalendar = await calendarAs(token);
    expect(canceledCalendar.status()).toBe(404);
    expect((await canceledCalendar.json()).error).toBe(
      "No active final meeting has been confirmed",
    );
    const canceled = await readAs(token);
    expect(canceled.response.status()).toBe(200);
    expect(canceled.payload.finalMeeting.active).toBe(false);
    const reactivated = await eventState(request, token, code);
    await expectRefusal(
      confirmAs({
        ...room,
        expectedVersion: reactivated.version,
        idempotencyKey: firstKey,
      }),
      409,
      "This confirmation was superseded after the event was reopened.",
    );
  });
});
