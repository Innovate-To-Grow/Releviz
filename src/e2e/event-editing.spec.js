const { expect, test } = require("@playwright/test");
const {
  apiJson,
  continueWithEmail,
  createEvent,
  eventState,
  finalizeViaApi,
  freshResults,
  newRunId,
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
  addPersonApi,
  freezeLiveSync,
  participantActions,
  participantSummary,
  requestRecorder,
  rosterByEmail,
  rosterEntries,
  submitOnBehalf,
  waitForInvitationStatus,
} = require("./helpers/participants");
const {
  chooseRecommendedTime,
  overviewDetail,
  overviewTile,
} = require("./helpers/workspace");
const {
  DAY_MS,
  nextUsDstDates,
  zonedLocalDateTime,
  zonedWallClock,
} = require("./helpers/time");

// Editing an existing event and the dashboard's duplicate and delete. The
// /edit page (the dashboard's Edit link, the saved values it loads, saves
// that keep responses, the stale-version reload, the response-reset prompt,
// the server's refusals and its error states), the workspace's inline editor
// (cancel, save, reset, conflict), how blocked times ride along with a
// settings edit, and the server guards and idempotency of PUT, DELETE and
// POST /events/duplicate. Every test works on its own organizer and events.

const CONFLICT_ERROR =
  "The event changed in another session. Reload it and review your edits.";
const RESET_ERROR =
  "These schedule changes would invalidate saved availability. Confirm that participant responses may be reset.";
const RESET_TITLE = "Schedule changes require a response reset";
const RESET_CONFIRMATION =
  "I understand that participant availability will be reset.";
const SAVED = "Event changes saved.";
const STALE_DUPLICATE =
  "The event changed in another session. Reload it before duplicating.";
const STALE_DELETE =
  "The event changed in another session. Reload it before deleting.";
const DELIVERY_IN_PROGRESS =
  "Email delivery is currently in progress. Try deleting again shortly.";

// A deadline at 12:00 UTC on the day `days` from now. The form edits
// deadlines to the minute in the event's timezone, so a seeded deadline with
// seconds would change on every save; noon UTC also never falls in a
// daylight-saving switch in Europe or the Americas, where the repeated hour
// would make the form's wall-clock time ambiguous.
function noonDeadline(days) {
  const day = new Date(Date.now() + days * DAY_MS);
  day.setUTCHours(12, 0, 0, 0);
  return day.toISOString();
}

// Registers the organizer through the UI and creates one API event named
// after `label`, with a noon UTC deadline.
async function startEditor({ page, request }, label, overrides = {}) {
  const runId = newRunId();
  await registerAccount(page, `${label}-${runId}@example.com`, "Eddie", "Edit");
  const token = (await readSession(page)).access;
  const event = await createEvent(request, token, {
    name: `${label} ${runId}`,
    responseDeadline: noonDeadline(5),
    ...overrides,
  });
  return { runId, token, event, code: event.code };
}

// Adds Ada (a managed person, not invited) with a submitted response for
// Monday 10:00-11:00, then flushes the results invalidation her response
// queued, so later revisions count only the edits. Returns the event as it
// now stands.
async function seedAda(request, token, event, email) {
  const mon10 = slotIndex(event, "weekday:1", "10:00");
  await submitResponse(request, token, event, {
    name: "Ada",
    email,
    inperson: [mon10, mon10 + 1],
  });
  recomputeEventResults(event.code);
  return eventState(request, token, event.code);
}

async function listed(request, token, code, email) {
  const entry = (await rosterByEmail(request, code, token)).get(
    email.toLowerCase(),
  );
  expect(entry, `participant ${email}`).toBeTruthy();
  return entry;
}

// A listed participant's stored schedule (both arrays and `submitted`).
async function scheduleOf(request, token, code, email) {
  const entry = await listed(request, token, code, email);
  const schedule = await apiJson(
    request,
    "GET",
    `/events/roster/${entry.id}/schedule?code=${code}`,
    token,
  );
  expect(schedule.response.status()).toBe(200);
  return schedule.payload.schedule;
}

function eventUpdate(page, code) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes(`/events?code=${code}`),
  );
}

// Opens /edit and waits for the form to load the event.
async function gotoEdit(page, code, expectedName) {
  await page.goto(`/edit?code=${code}`);
  await expect(page.getByRole("textbox", { name: "Event Name" })).toHaveValue(
    expectedName,
  );
}

// Saves the /edit form, expects a 200 and the workspace, and returns the
// PUT's payload.
async function saveAndReturn(page, code) {
  const saved = eventUpdate(page, code);
  await page.getByRole("button", { name: "Save changes" }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/event\\?code=${code}$`));
  return response.json();
}

// The workspace's inline editor. A click that lands while the workspace
// re-renders after loading can be dropped by slower engines, so it is
// retried until the editor shows; the button is disabled while the editor is
// open, so a retry never closes it again.
async function openInlineEditor(page) {
  const region = page.getByRole("region", { name: "Edit event" });
  const editButton = page.getByRole("button", { name: "Edit event" });
  await expect
    .poll(
      async () => {
        if (!(await region.isVisible())) await editButton.click();
        return region.isVisible();
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return region;
}

// The dashboard card of one event.
function dashboardCard(page, name) {
  return page.locator("article.dashboard-event-card").filter({
    has: page.getByRole("link", { name, exact: true }),
  });
}

function mutationResponse(page, method, pathPrefix) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      response.url().includes(`${pathPrefix}?code=`),
  );
}

// A processing delivery job for this test's own event, locked now, as if the
// email worker were talking to the provider. The stack's worker only picks up
// due pending or retry jobs, so it leaves this one alone.
function seedInFlightJob(code, recipient) {
  return runDjangoJson(
    `
import uuid

from django.utils import timezone

from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import Event

key = uuid.uuid4().hex
now = timezone.now()
job = EmailDeliveryJob.objects.create(
    idempotency_key=f"e2e-editing:{key}",
    message_type="invitation",
    recipient=data["recipient"],
    subject="Seeded by the event editing spec",
    body="Seeded by the event editing spec.",
    message_id=f"<e2e-editing-{key}@releviz.local>",
    event=Event.objects.get(code=data["code"]),
    status="processing",
    attempt_count=1,
    next_attempt_at=now,
    locked_at=now,
    lock_token=uuid.uuid4(),
)
print(json.dumps(str(job.pk)))
`,
    { code, recipient },
  );
}

// Lets a seeded processing job finish, as the worker would once the provider
// answers.
function finishJob(id) {
  return runDjangoJson(
    `
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob

print(json.dumps(EmailDeliveryJob.objects.filter(pk=data["id"], status="processing").update(
    status="sent", sent_at=timezone.now(), locked_at=None, lock_token=None
)))
`,
    { id },
  );
}

test.describe("Editing on the /edit page", () => {
  test("the dashboard's Edit link loads the saved settings with Advanced options open, and settings saves keep responses and bump results only for mode and duration", async ({
    page,
    request,
  }) => {
    const deadline = noonDeadline(6);
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "edit-open",
      {
        mode: "mixed",
        location: "Studio 5",
        startTime: "10:00",
        endTime: "15:30",
        slotMinutes: 15,
        days: [2, 4],
        timezone: "Europe/Berlin",
        meetingDurationMinutes: 90,
        accessMode: "open_link",
        startingAvailability: "busy",
        remindersEnabled: true,
        reminderHoursBefore: 12,
        responseDeadline: deadline,
      },
    );
    const ada = `ada-${runId}@example.com`;
    const tue10 = slotIndex(event, "weekday:2", "10:00");
    await submitResponse(request, token, event, {
      name: "Ada",
      email: ada,
      inperson: [tue10, tue10 + 1],
    });
    recomputeEventResults(code);
    const seeded = await eventState(request, token, code);
    const v0 = seeded.version;
    const r0 = seeded.resultsRevision;

    // 1) The card's Edit link opens /edit with every saved value loaded and
    // the Advanced options already open.
    await page.goto("/dashboard");
    await dashboardCard(page, event.name)
      .getByRole("link", { name: "Edit", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/edit\\?code=${code}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Edit event" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Review the schedule and response rules before saving your changes.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Event Name" })).toHaveValue(
      event.name,
    );
    const modeGroup = page.getByRole("group", { name: "Meeting type" });
    for (const [label, pressed] of [
      ["In-Person", "false"],
      ["Virtual", "false"],
      ["Mixed", "true"],
    ]) {
      await expect(
        modeGroup.getByRole("button", { name: label, exact: true }),
      ).toHaveAttribute("aria-pressed", pressed);
    }
    await expect(
      page.getByRole("textbox", { name: "Location / Address" }),
    ).toHaveValue("Studio 5");
    await expect(page.getByLabel("Start Time")).toHaveValue("10:00");
    await expect(page.getByLabel("End Time")).toHaveValue("15:30");
    await expect(
      page
        .getByRole("group", { name: "Day selection type" })
        .getByRole("button", { name: "Days of Week" }),
    ).toHaveAttribute("aria-pressed", "true");
    const dayGroup = page.getByRole("group", { name: "Days of the week" });
    for (const [label, pressed] of [
      ["Sun", "false"],
      ["Mon", "false"],
      ["Tue", "true"],
      ["Wed", "false"],
      ["Thu", "true"],
      ["Fri", "false"],
      ["Sat", "false"],
    ]) {
      await expect(
        dayGroup.getByRole("button", { name: label, exact: true }),
      ).toHaveAttribute("aria-pressed", pressed);
    }
    await expect(
      page.getByRole("combobox", { name: "Event timezone" }),
    ).toHaveValue("Europe/Berlin");
    await expect(page.getByLabel("Meeting Duration")).toHaveValue("90");
    await expect(
      page.getByRole("combobox", { name: "Event Access" }),
    ).toHaveValue("open_link");
    await expect(
      page.getByRole("combobox", { name: "Participants start as" }),
    ).toHaveValue("busy");
    await expect(
      page.getByText(
        "Changing this updates people who have not started their schedule yet.",
      ),
    ).toBeVisible();
    await expect(
      page.locator("details.create-event-disclosure"),
    ).toHaveAttribute("open", "");
    await expect(
      page.getByRole("combobox", { name: "Slot Duration" }),
    ).toHaveValue("15");
    await expect(page.getByLabel("Response Deadline")).toHaveValue(
      zonedWallClock(deadline, "Europe/Berlin"),
    );
    await expect(page.getByLabel("Reminder Hours Before Deadline")).toHaveValue(
      "12",
    );
    await expect(
      page.getByRole("checkbox", {
        name: "Send reminder emails before the deadline",
      }),
    ).toBeChecked();

    // 2) A rename, a new location, invite-only access and new reminder
    // settings save directly: no reset, Ada keeps her response, and none of
    // them moves the results revision.
    const renamed = `Edit open ${runId} renamed`;
    await page.getByRole("textbox", { name: "Event Name" }).fill(renamed);
    await page
      .getByRole("textbox", { name: "Location / Address" })
      .fill("Studio 6");
    await page
      .getByRole("combobox", { name: "Event Access" })
      .selectOption("invite_only");
    await page.getByLabel("Reminder Hours Before Deadline").fill("6");
    await page
      .getByRole("checkbox", {
        name: "Send reminder emails before the deadline",
      })
      .uncheck();
    let saved = await saveAndReturn(page, code);
    expect(saved).toMatchObject({ responsesReset: 0, idempotent: false });
    await expect(
      page.getByRole("heading", { level: 2, name: renamed }),
    ).toBeVisible();
    let stored = await eventState(request, token, code);
    expect(stored).toMatchObject({
      name: renamed,
      location: "Studio 6",
      accessMode: "invite_only",
      remindersEnabled: false,
      reminderHoursBefore: 6,
      version: v0 + 1,
      resultsRevision: r0,
      responseDeadline: seeded.responseDeadline,
    });
    expect((await listed(request, token, code, ada)).submitted).toBe(true);

    // 3) A new meeting type recomputes results but keeps responses.
    await gotoEdit(page, code, renamed);
    await modeGroup
      .getByRole("button", { name: "Virtual", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Location / Address" }),
    ).toHaveCount(0);
    saved = await saveAndReturn(page, code);
    expect(saved.responsesReset).toBe(0);
    await expect(overviewTile(page, "Meeting")).toContainText(
      "Virtual · 90 minutes",
    );
    stored = await eventState(request, token, code);
    expect(stored).toMatchObject({
      mode: "virtual",
      location: "",
      version: v0 + 2,
      resultsRevision: r0 + 1,
    });
    expect((await listed(request, token, code, ada)).submitted).toBe(true);

    // 4) So does a new meeting duration.
    await gotoEdit(page, code, renamed);
    await page.getByLabel("Meeting Duration").fill("120");
    saved = await saveAndReturn(page, code);
    expect(saved.responsesReset).toBe(0);
    await expect(overviewTile(page, "Meeting")).toContainText(
      "Virtual · 120 minutes",
    );
    await page.getByRole("button", { name: "Show all details" }).click();
    await expect(overviewDetail(page, "Result revision")).toHaveText(
      String(r0 + 2),
    );
    stored = await eventState(request, token, code);
    expect(stored).toMatchObject({
      meetingDurationMinutes: 120,
      version: v0 + 3,
      resultsRevision: r0 + 2,
    });
    expect((await listed(request, token, code, ada)).submitted).toBe(true);
  });

  test("a stale save offers the latest version and reloads it, a stale save that matches it is idempotent, the reset prompt stands alone, and Cancel returns to the event", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "edit-conflict",
    );
    const ada = `ada-${runId}@example.com`;
    await seedAda(request, token, event, ada);
    const formError = page.locator(".create-event-error");
    const staleNotice = page.getByText(/The latest saved version is/);
    const reloadButton = page.getByRole("button", {
      name: "Reload latest event",
    });

    // 1) Another session renames the event while the form is open: the save
    // is refused with the latest version, and reloading brings it in and
    // drops the unsaved reminder change.
    await gotoEdit(page, code, event.name);
    const changedName = `Changed elsewhere ${runId}`;
    const changed = await updateEventViaApi(request, token, code, {
      name: changedName,
    });
    await page.getByLabel("Reminder Hours Before Deadline").fill("12");
    let put = eventUpdate(page, code);
    await page.getByRole("button", { name: "Save changes" }).click();
    let response = await put;
    expect(response.status()).toBe(409);
    expect((await response.json()).event.version).toBe(changed.event.version);
    await expect(formError).toHaveText(CONFLICT_ERROR);
    await expect(
      page.getByText(
        `The latest saved version is ${changed.event.version}. Reload before deciding which edits to keep.`,
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/edit\\?code=${code}$`));
    const reloaded = page.waitForEvent("load");
    await reloadButton.click();
    await reloaded;
    await expect(page.getByRole("textbox", { name: "Event Name" })).toHaveValue(
      changedName,
    );
    await expect(page.getByLabel("Reminder Hours Before Deadline")).toHaveValue(
      "24",
    );
    await expect(formError).toHaveCount(0);
    await expect(staleNotice).toHaveCount(0);
    expect((await eventState(request, token, code)).reminderHoursBefore).toBe(
      24,
    );

    // 2) A save from the now-stale form that asks for exactly what the other
    // session already saved changes nothing and succeeds.
    const sameName = `Same elsewhere ${runId}`;
    const same = await updateEventViaApi(request, token, code, {
      name: sameName,
    });
    await page.getByRole("textbox", { name: "Event Name" }).fill(sameName);
    const idempotent = await saveAndReturn(page, code);
    expect(idempotent).toMatchObject({ idempotent: true, responsesReset: 0 });
    expect(idempotent.event.version).toBe(same.event.version);
    expect((await eventState(request, token, code)).version).toBe(
      same.event.version,
    );

    // 3) A schedule change asks for a response reset, and only that: the
    // current event rides along on the refusal, but nothing offers to
    // reload it and discard the edit.
    await gotoEdit(page, code, sameName);
    await page.getByLabel("End Time").fill("17:30");
    put = eventUpdate(page, code);
    await page.getByRole("button", { name: "Save changes" }).click();
    response = await put;
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({
      requiresResponseReset: true,
      participantCount: 1,
    });
    const resetAlert = page.getByRole("alert").filter({ hasText: RESET_TITLE });
    await expect(resetAlert).toContainText(
      "Saving will clear draft and submitted availability for 1 participant. Invitations and participant membership will remain.",
    );
    await expect(formError).toHaveText(RESET_ERROR);
    await expect(staleNotice).toHaveCount(0);
    await expect(reloadButton).toHaveCount(0);
    const saveButton = page.getByRole("button", { name: "Save changes" });
    await expect(saveButton).toBeDisabled();
    await page.getByLabel(RESET_CONFIRMATION).check();
    await expect(saveButton).toBeEnabled();
    const reset = await saveAndReturn(page, code);
    expect(reset.responsesReset).toBe(1);
    expect(reset.event.endTime).toBe("17:30");
    expect((await listed(request, token, code, ada)).submitted).toBe(false);

    // 4) Cancel returns to the workspace without saving.
    await gotoEdit(page, code, sameName);
    const puts = requestRecorder(
      page,
      (sent) =>
        sent.method() === "PUT" && sent.url().includes(`/events?code=${code}`),
    );
    await page
      .getByRole("textbox", { name: "Event Name" })
      .fill(`Never saved ${runId}`);
    await page
      .getByRole("link", { name: "Cancel and return to event" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/event\\?code=${code}$`));
    await expect(
      page.getByRole("heading", { level: 2, name: sameName }),
    ).toBeVisible();
    expect(puts.entries).toEqual([]);
    expect((await eventState(request, token, code)).name).toBe(sameName);
  });

  test("the server's refusals show in the form: a past deadline in the inline editor and a duration that no longer fits a daylight-saving day on /edit", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "edit-refusals",
    );

    // 1) An active event cannot move its deadline into the past.
    await page.goto(`/event?code=${code}`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    const region = await openInlineEditor(page);
    await region.locator("details.create-event-disclosure > summary").click();
    await expect(
      region.locator("details.create-event-disclosure"),
    ).toHaveAttribute("open", "");
    await region
      .getByLabel("Response Deadline")
      .fill(zonedLocalDateTime(-1, "12:00", "UTC"));
    let put = eventUpdate(page, code);
    await region.getByRole("button", { name: "Save changes" }).click();
    expect((await put).status()).toBe(400);
    await expect(region.locator(".create-event-error")).toHaveText(
      "An active event must have a future response deadline",
    );
    await expect(region).toBeVisible();
    await expect(page.getByText(SAVED)).toHaveCount(0);
    expect((await eventState(request, token, code)).responseDeadline).toBe(
      event.responseDeadline,
    );

    // 2) New York's spring-forward night holds only two real hours between
    // 01:00 and 04:00, so a three-hour meeting passes the form's check of
    // the typed window but fits no day on the server.
    const { springForward } = nextUsDstDates();
    const dst = await createEvent(request, token, {
      name: `DST day ${runId}`,
      daySelectionType: "specific_dates",
      days: [],
      specificDates: [springForward],
      timezone: "America/New_York",
      startTime: "01:00",
      endTime: "04:00",
      meetingDurationMinutes: 60,
      responseDeadline: noonDeadline(5),
    });
    expect(dst.slotCount).toBe(4);
    await gotoEdit(page, dst.code, dst.name);
    await page.getByLabel("Meeting Duration").fill("180");
    put = eventUpdate(page, dst.code);
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await put).status()).toBe(400);
    await expect(page.locator(".create-event-error")).toHaveText(
      "meetingDurationMinutes does not fit within any configured day",
    );
    await expect(page).toHaveURL(new RegExp(`/edit\\?code=${dst.code}$`));
    const stored = await eventState(request, token, dst.code);
    expect(stored).toMatchObject({
      meetingDurationMinutes: 60,
      version: dst.version,
    });
  });

  test("blocked times survive a settings edit, shrink with the window and days, and an edit that leaves no open window is refused", async ({
    page,
    request,
  }) => {
    const { runId, token, code } = await startEditor(
      { page, request },
      "edit-blocked",
    );
    // Mornings (09:00-12:00, rows 0-5) are blocked every weekday, plus
    // Monday's last slot (16:30, row 15).
    const mornings = [0, 1, 2, 3, 4, 5];
    const blocked = {
      "weekday:1": [...mornings, 15],
      "weekday:2": mornings,
      "weekday:3": mornings,
      "weekday:4": mornings,
      "weekday:5": mornings,
    };
    const seeded = (
      await updateEventViaApi(request, token, code, { blockedSlots: blocked })
    ).event;
    expect(seeded.blockedSlots).toEqual(blocked);

    // 1) A rename keeps every block.
    const renamed = `Blocked ${runId} renamed`;
    await gotoEdit(page, code, seeded.name);
    await page.getByRole("textbox", { name: "Event Name" }).fill(renamed);
    await saveAndReturn(page, code);
    await expect(overviewTile(page, "Schedule")).toContainText(
      "9:00 AM - 5:00 PM · UTC · 31 slots blocked",
    );
    expect((await eventState(request, token, code)).blockedSlots).toEqual(
      blocked,
    );

    // 2) Ending at noon would leave only blocked mornings.
    await gotoEdit(page, code, renamed);
    await page.getByLabel("End Time").fill("12:00");
    const put = eventUpdate(page, code);
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await put).status()).toBe(400);
    await expect(page.locator(".create-event-error")).toHaveText(
      "Blocked slots leave no open window for a 60-minute meeting.",
    );
    await expect(page).toHaveURL(new RegExp(`/edit\\?code=${code}$`));
    expect((await eventState(request, token, code)).endTime).toBe("17:00");

    // 3) Ending at 16:00 and dropping Friday keeps the mornings of the
    // remaining days and prunes the Monday 16:30 block and Friday's rows.
    await page.getByLabel("End Time").fill("16:00");
    await page
      .getByRole("group", { name: "Days of the week" })
      .getByRole("button", { name: "Fri", exact: true })
      .click();
    const saved = await saveAndReturn(page, code);
    expect(saved.responsesReset).toBe(0);
    const pruned = {
      "weekday:1": mornings,
      "weekday:2": mornings,
      "weekday:3": mornings,
      "weekday:4": mornings,
    };
    expect(saved.event.blockedSlots).toEqual(pruned);
    await expect(overviewTile(page, "Schedule")).toContainText(
      "Mon, Tue, Wed, Thu",
    );
    await expect(overviewTile(page, "Schedule")).toContainText(
      "9:00 AM - 4:00 PM · UTC · 24 slots blocked",
    );
    expect(await eventState(request, token, code)).toMatchObject({
      days: [1, 2, 3, 4],
      endTime: "16:00",
      blockedSlots: pruned,
    });
  });

  test("/edit explains a missing code, an unknown or hidden event and a non-organizer, and sends a signed-out visitor to sign in first", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const other = await registerAccountViaApi(
      request,
      `edit-owner-${runId}@example.com`,
      "Olive",
      "Owner",
    );
    const hidden = await createEvent(request, other.access, {
      name: `Hidden ${runId}`,
    });
    const open = await createEvent(request, other.access, {
      name: `Open ${runId}`,
      accessMode: "open_link",
    });

    const visitor = `edit-visitor-${runId}@example.com`;
    await registerAccountViaApi(request, visitor, "Vera", "Visitor");
    const heading = page.getByRole("heading", {
      level: 1,
      name: "Unable to edit event",
    });
    // Next.js keeps its own (empty) route announcer as an alert, so the
    // page's alerts are looked up inside the main content.
    const errorAlert = page.getByRole("main").getByRole("alert");
    const expectUnable = async (message) => {
      await expect(heading).toBeVisible();
      await expect(errorAlert).toHaveText(message);
      await expect(
        page.getByRole("textbox", { name: "Event Name" }),
      ).toHaveCount(0);
    };

    // 1) Signed out, /edit goes to sign-in, and signing in there comes back
    // to /edit. The open event is one this account can see, but it still
    // belongs to its organizer.
    await page.goto(`/edit?code=${open.code}`);
    await expect(page).toHaveURL(
      new RegExp(`/login\\?next=%2Fedit%3Fcode%3D${open.code}$`),
    );
    await continueWithEmail(page, visitor, Date.now() - 1000, "login");
    await expect(page).toHaveURL(new RegExp(`/edit\\?code=${open.code}$`));
    await expectUnable("Only the organizer can edit this event.");
    await page.getByRole("link", { name: "Return to dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "My Dashboard" }),
    ).toBeVisible();

    // 2) No code at all.
    await page.goto("/edit");
    await expectUnable("No event code was provided for editing.");

    // 3) An unknown code, and an invite-only event this account cannot see,
    // are both simply not found.
    await page.goto(`/edit?code=UNKNOWN-${runId}`);
    await expectUnable("Event not found");
    await page.goto(`/edit?code=${hidden.code}`);
    await expectUnable("Event not found");
    expect((await eventState(request, other.access, open.code)).version).toBe(
      open.version,
    );
  });

  test("a finalized, an archived and a still-confirmed event refuse setting changes on /edit and through the API", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "edit-locked",
    );
    await seedAda(request, token, event, `ada-${runId}@example.com`);
    const results = await freshResults(request, token, code);
    await finalizeViaApi(request, token, code, results.recommendations[0]);
    const formError = page.locator(".create-event-error");

    // Opening /edit directly still loads the form; saving is refused.
    const refusedRename = async (message) => {
      const current = await eventState(request, token, code);
      await gotoEdit(page, code, current.name);
      await page
        .getByRole("textbox", { name: "Event Name" })
        .fill(`Locked rename ${runId}`);
      const put = eventUpdate(page, code);
      await page.getByRole("button", { name: "Save changes" }).click();
      const response = await put;
      expect(response.status()).toBe(400);
      expect((await response.json()).error).toBe(message);
      await expect(formError).toHaveText(message);
      await expect(page).toHaveURL(new RegExp(`/edit\\?code=${code}$`));
      const api = await apiJson(request, "PUT", `/events?code=${code}`, token, {
        expectedVersion: current.version,
        location: "Elsewhere",
      });
      expect(api.response.status()).toBe(400);
      expect(api.payload.error).toBe(message);
      expect(await eventState(request, token, code)).toMatchObject({
        name: event.name,
        location: event.location,
        version: current.version,
      });
    };

    // 1) Finalized: the workspace's Edit event is locked with its reason,
    // and /edit, opened directly, is refused on save.
    await page.goto(`/event?code=${code}`);
    const editButton = page.getByRole("button", { name: "Edit event" });
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute(
      "title",
      "Reactivate the event before editing a confirmed meeting.",
    );
    await refusedRename(
      "Scheduling settings cannot change while the event is finalized.",
    );

    // 2) Archived (the confirmed meeting stays).
    await setLifecycleViaApi(request, token, code, "archived");
    await refusedRename(
      "Scheduling settings cannot change while the event is archived.",
    );

    // 3) An active status next to a meeting that is still confirmed cannot
    // arise through the lifecycle (every move back to active cancels the
    // meeting), so it is set up directly on this test's own event to show
    // the server's second guard.
    const forced = runDjangoJson(
      `
from apps.scheduling.models import Event, FinalMeeting

updated = Event.objects.filter(code=data["code"], status="archived").update(
    status="active", archived_at=None
)
print(json.dumps({
    "updated": updated,
    "activeMeetings": FinalMeeting.objects.filter(event__code=data["code"], active=True).count(),
}))
`,
      { code },
    );
    try {
      expect(forced).toEqual({ updated: 1, activeMeetings: 1 });
      await refusedRename(
        "Reopen the event before editing settings for a confirmed meeting.",
      );
    } finally {
      // The inconsistent event is removed so nothing else meets it.
      const current = await eventState(request, token, code);
      const removed = await apiJson(
        request,
        "DELETE",
        `/events?code=${code}`,
        token,
        {
          expectedVersion: current.version,
          idempotencyKey: crypto.randomUUID(),
          confirmation: code,
        },
      );
      expect(removed.response.status()).toBe(200);
    }
  });
});

test.describe("Editing in the workspace", () => {
  test("Edit event opens the inline editor; Cancel returns focus, and a save updates the workspace, clears the picked time and re-seeds only untouched people", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "inline-save",
    );
    const ada = `ada-${runId}@example.com`;
    const uma = `uma-${runId}@example.com`;
    await addPersonApi(request, code, token, { name: "Uma", email: uma });
    const seeded = await seedAda(request, token, event, ada);
    const adaBefore = await scheduleOf(request, token, code, ada);
    expect(
      (await scheduleOf(request, token, code, uma)).availabilityInperson,
    ).toEqual(Array(event.slotCount).fill(1));

    await page.goto(`/event?code=${code}`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    await chooseRecommendedTime(page, 0);
    const candidate = page.locator(".final-candidate");

    // 1) The editor opens in the Overview with its heading focused.
    const editButton = page.getByRole("button", { name: "Edit event" });
    await expect(editButton).toHaveAttribute("aria-expanded", "false");
    const region = await openInlineEditor(page);
    await expect(
      page.getByRole("heading", { level: 4, name: "Edit event" }),
    ).toBeFocused();
    await expect(region).toContainText(
      "Update this event without leaving the workspace.",
    );
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute("aria-expanded", "true");
    await expect(
      region.locator("details.create-event-disclosure"),
    ).not.toHaveAttribute("open", "");
    const nameBox = region.getByRole("textbox", { name: "Event Name" });
    await expect(nameBox).toHaveValue(event.name);

    // 2) Cancel closes it, returns focus and keeps the picked time.
    await region.getByRole("button", { name: "Cancel" }).click();
    await expect(region).toHaveCount(0);
    await expect(editButton).toBeEnabled();
    await expect(editButton).toBeFocused();
    await expect(candidate).toBeVisible();

    // 3) A save of the name, the meeting type and a Busy start.
    await openInlineEditor(page);
    const renamed = `Inline ${runId} renamed`;
    await nameBox.fill(renamed);
    await region
      .getByRole("group", { name: "Meeting type" })
      .getByRole("button", { name: "Mixed", exact: true })
      .click();
    await region
      .getByRole("combobox", { name: "Participants start as" })
      .selectOption("busy");
    const put = eventUpdate(page, code);
    await region.getByRole("button", { name: "Save changes" }).click();
    const response = await put;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      responsesReset: 0,
      idempotent: false,
    });
    await expect(
      page.getByRole("status").filter({ hasText: SAVED }),
    ).toBeVisible();
    await expect(region).toHaveCount(0);
    await expect(editButton).toBeFocused();

    // The workspace shows the saved event, and the time picked before the
    // save is dropped with the old results.
    await expect(page.locator("h2.organizer-title")).toHaveText(renamed);
    await expect(page.locator("h1.event-header-title")).toHaveText(renamed);
    await expect(overviewTile(page, "Meeting")).toContainText(
      "Mixed · 60 minutes",
    );
    await expect(candidate).toHaveCount(0);
    await expect(page.locator("#organizer-finalize")).toContainText(
      /Pick a time on the calendar/,
    );
    await page.getByRole("button", { name: "Show all details" }).click();
    await expect(overviewDetail(page, "Participants start as")).toHaveText(
      "Busy",
    );
    await expect(overviewDetail(page, "Result revision")).toHaveText(
      String(seeded.resultsRevision + 1),
    );

    const stored = await eventState(request, token, code);
    expect(stored).toMatchObject({
      name: renamed,
      mode: "mixed",
      startingAvailability: "busy",
      version: seeded.version + 1,
      resultsRevision: seeded.resultsRevision + 1,
    });
    // Uma never touched her schedule, so she now starts Busy; Ada's
    // submitted answer stays exactly as she gave it.
    const umaAfter = await scheduleOf(request, token, code, uma);
    expect(umaAfter.availabilityInperson).toEqual(
      Array(event.slotCount).fill(0),
    );
    expect(umaAfter.availabilityVirtual).toEqual(
      Array(event.slotCount).fill(0),
    );
    const adaAfter = await scheduleOf(request, token, code, ada);
    expect(adaAfter.submitted).toBe(true);
    expect(adaAfter.availabilityInperson).toEqual(
      adaBefore.availabilityInperson,
    );
  });

  test("a schedule change asks for a response reset on its own, then reopens every submitted invitation and refreshes the participant list", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "inline-reset",
    );
    // Ivy was invited and her response was entered for her, so her
    // invitation counts as submitted; Ada was never invited.
    const ivy = `ivy-${runId}@example.com`;
    await addPersonApi(request, code, token, {
      name: "Ivy",
      email: ivy,
      sendInvitation: true,
    });
    await waitForInvitationStatus(request, code, token, ivy, "sent");
    await submitOnBehalf(
      request,
      token,
      event,
      await listed(request, token, code, ivy),
    );
    await seedAda(request, token, event, `ada-${runId}@example.com`);
    const invitationStatus = () =>
      runDjangoJson(
        `
from apps.scheduling.models import EventInvitation

print(json.dumps(list(EventInvitation.objects.filter(
    event__code=data["code"], email__iexact=data["email"]
).values_list("status", flat=True))))
`,
        { code, email: ivy },
      );
    expect(invitationStatus()).toEqual(["submitted"]);
    expect((await rosterEntries(request, code, token)).overall.remindable).toBe(
      0,
    );

    await page.goto(`/event?code=${code}`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    await expect(participantSummary(page)).toContainText("2 submitted");
    const emailButton = participantActions(page).getByRole("button", {
      name: "Email",
      exact: true,
    });
    const emailMenu = page.getByRole("menu", { name: "Email" });
    const remindersItem = (count) =>
      emailMenu.getByRole("menuitem", { name: `Send reminders (${count})…` });
    await emailButton.click();
    await expect(remindersItem(0)).toBeVisible();
    // The trigger toggles the menu.
    await emailButton.click();
    await expect(emailMenu).toHaveCount(0);

    // 1) The reset prompt shows alone, without a stale-version reload.
    const region = await openInlineEditor(page);
    await region.getByLabel("End Time").fill("17:30");
    let put = eventUpdate(page, code);
    const saveButton = region.getByRole("button", { name: "Save changes" });
    await saveButton.click();
    expect((await put).status()).toBe(409);
    await expect(region).toContainText(RESET_TITLE);
    await expect(region).toContainText(
      "Saving will clear draft and submitted availability for 2 participants. Invitations and participant membership will remain.",
    );
    await expect(region.getByText(/The latest saved version is/)).toHaveCount(
      0,
    );
    await expect(
      region.getByRole("button", { name: "Reload latest event" }),
    ).toHaveCount(0);
    await expect(saveButton).toBeDisabled();
    await region.getByLabel(RESET_CONFIRMATION).check();
    await expect(saveButton).toBeEnabled();

    // 2) With live sync held, the list can only change through the save's
    // own refresh.
    const release = await freezeLiveSync(page);
    try {
      put = eventUpdate(page, code);
      await saveButton.click();
      const response = await put;
      expect(response.status()).toBe(200);
      expect((await response.json()).responsesReset).toBe(2);
      await expect(
        page.getByRole("status").filter({ hasText: SAVED }),
      ).toBeVisible();
      await expect(participantSummary(page)).toContainText("0 submitted");
      await expect(participantSummary(page)).toContainText("2 not submitted");
    } finally {
      await release();
    }
    await expect(overviewTile(page, "Schedule")).toContainText(
      "9:00 AM - 5:30 PM · UTC",
    );

    // 3) Ivy's invitation is back to joined, so she can be reminded again.
    expect(invitationStatus()).toEqual(["joined"]);
    expect((await rosterEntries(request, code, token)).overall.remindable).toBe(
      1,
    );
    await emailButton.click();
    await expect(remindersItem(1)).toBeVisible();
    await emailButton.click();
    await expect(emailMenu).toHaveCount(0);
  });

  test("a stale inline save shows the latest version, and Reload latest event loads it into the form for the edit to be redone", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "inline-conflict",
    );
    await page.goto(`/event?code=${code}`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    const region = await openInlineEditor(page);
    const nameBox = region.getByRole("textbox", { name: "Event Name" });
    const locationBox = region.getByRole("textbox", {
      name: "Location / Address",
    });
    const saveButton = region.getByRole("button", { name: "Save changes" });
    await expect(locationBox).toHaveValue(event.location);

    // Live sync is held so the workspace does not pick up the rename on its
    // own before the save.
    const release = await freezeLiveSync(page);
    try {
      const renamedName = `Renamed elsewhere ${runId}`;
      const renamed = await updateEventViaApi(request, token, code, {
        name: renamedName,
      });
      await locationBox.fill("Room 305");
      let put = eventUpdate(page, code);
      await saveButton.click();
      expect((await put).status()).toBe(409);
      await expect(region.locator(".create-event-error")).toHaveText(
        CONFLICT_ERROR,
      );
      await expect(region).toContainText(
        `The latest saved version is ${renamed.event.version}. Reload before deciding which edits to keep.`,
      );
      await region.getByRole("button", { name: "Reload latest event" }).click();
      await expect(region.locator(".create-event-error")).toHaveCount(0);
      await expect(
        region.getByRole("button", { name: "Reload latest event" }),
      ).toHaveCount(0);
      await expect(nameBox).toHaveValue(renamedName);
      await expect(locationBox).toHaveValue(event.location);

      await locationBox.fill("Room 305");
      put = eventUpdate(page, code);
      await saveButton.click();
      const response = await put;
      expect(response.status()).toBe(200);
      expect((await response.json()).event.version).toBe(
        renamed.event.version + 1,
      );
      await expect(region).toHaveCount(0);
      await expect(page.locator("h2.organizer-title")).toHaveText(renamedName);
      await expect(overviewTile(page, "Meeting")).toContainText("Room 305");
    } finally {
      await release();
    }
    expect(await eventState(request, token, code)).toMatchObject({
      name: `Renamed elsewhere ${runId}`,
      location: "Room 305",
    });
  });
});

test.describe("Event mutation guards", () => {
  test("PUT, DELETE and duplicate refuse other accounts, missing codes, versions and keys, and a wrong delete confirmation", async ({
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `guards-${runId}@example.com`,
      "Gail",
      "Guard",
    );
    const stranger = await registerAccountViaApi(
      request,
      `guards-stranger-${runId}@example.com`,
      "Sam",
      "Stranger",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `Guards ${runId}`,
      accessMode: "open_link",
    });
    const code = event.code;
    const version = event.version;
    const key = () => crypto.randomUUID();
    const refuse = async (method, url, auth, body, status, error) => {
      const { response, payload } = await apiJson(
        request,
        method,
        url,
        auth,
        body,
      );
      expect(
        response.status(),
        `${method} ${url} ${JSON.stringify(body)}`,
      ).toBe(status);
      expect(payload.error).toBe(error);
    };
    const deleteBody = { expectedVersion: version, confirmation: code };

    // No code.
    await refuse(
      "PUT",
      "/events",
      token,
      { expectedVersion: version },
      400,
      "code is required",
    );
    await refuse(
      "DELETE",
      "/events",
      token,
      { ...deleteBody, idempotencyKey: key() },
      400,
      "code is required",
    );
    await refuse(
      "POST",
      "/events/duplicate",
      token,
      { expectedVersion: version, idempotencyKey: key() },
      400,
      "code is required",
    );

    // An unknown code.
    const unknown = `UNKNOWN-${runId}`;
    await refuse(
      "PUT",
      `/events?code=${unknown}`,
      token,
      { expectedVersion: 1 },
      404,
      "Event not found",
    );
    await refuse(
      "DELETE",
      `/events?code=${unknown}`,
      token,
      { expectedVersion: 1, idempotencyKey: key(), confirmation: unknown },
      404,
      "Event not found",
    );
    await refuse(
      "POST",
      `/events/duplicate?code=${unknown}`,
      token,
      { expectedVersion: 1, idempotencyKey: key() },
      404,
      "Event not found",
    );

    // Another account, even one that can open this event.
    expect((await eventState(request, stranger.access, code)).code).toBe(code);
    await refuse(
      "PUT",
      `/events?code=${code}`,
      stranger.access,
      { expectedVersion: version, name: "Hijacked" },
      403,
      "Only the organizer can edit this event",
    );
    await refuse(
      "DELETE",
      `/events?code=${code}`,
      stranger.access,
      { ...deleteBody, idempotencyKey: key() },
      403,
      "Only the organizer can delete this event",
    );
    await refuse(
      "POST",
      `/events/duplicate?code=${code}`,
      stranger.access,
      { expectedVersion: version, idempotencyKey: key() },
      403,
      "Only the organizer can duplicate this event",
    );

    // A missing or malformed expected version.
    for (const expectedVersion of [undefined, String(version), true]) {
      await refuse(
        "PUT",
        `/events?code=${code}`,
        token,
        { expectedVersion, name: "No version" },
        428,
        "expectedVersion is required",
      );
      await refuse(
        "DELETE",
        `/events?code=${code}`,
        token,
        { ...deleteBody, expectedVersion, idempotencyKey: key() },
        428,
        "expectedVersion is required",
      );
      await refuse(
        "POST",
        `/events/duplicate?code=${code}`,
        token,
        { expectedVersion, idempotencyKey: key() },
        428,
        "expectedVersion is required",
      );
    }

    // A missing or malformed idempotency key.
    for (const idempotencyKey of [undefined, "not-a-uuid", 42]) {
      await refuse(
        "DELETE",
        `/events?code=${code}`,
        token,
        { ...deleteBody, idempotencyKey },
        400,
        "idempotencyKey must be a UUID",
      );
      await refuse(
        "POST",
        `/events/duplicate?code=${code}`,
        token,
        { expectedVersion: version, idempotencyKey },
        400,
        "idempotencyKey must be a UUID",
      );
    }

    // A reset flag that is not a boolean.
    await refuse(
      "PUT",
      `/events?code=${code}`,
      token,
      { expectedVersion: version, endTime: "17:30", resetResponses: "yes" },
      400,
      "resetResponses must be a boolean",
    );

    // The delete confirmation must be the exact code.
    for (const confirmation of [
      undefined,
      "",
      code.toLowerCase(),
      ` ${code}`,
    ]) {
      await refuse(
        "DELETE",
        `/events?code=${code}`,
        token,
        { expectedVersion: version, idempotencyKey: key(), confirmation },
        400,
        "Type the event code exactly to confirm deletion",
      );
    }

    // Nothing changed, and nobody got a copy.
    expect(await eventState(request, token, code)).toMatchObject({
      name: event.name,
      version,
      endTime: "17:00",
    });
    for (const account of [organizer, stranger]) {
      const dashboard = await apiJson(
        request,
        "GET",
        "/dashboard/events",
        account.access,
      );
      expect(dashboard.response.status()).toBe(200);
      expect(dashboard.payload.organized.map((entry) => entry.code)).toEqual(
        account === organizer ? [code] : [],
      );
    }
  });
});

test.describe("Duplicating events", () => {
  test("a stale card refreshes with the error, a lost response is retried with the same key, and an archived event is duplicated without its past deadline", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "duplicate-ui",
    );
    const archivedName = `Archived source ${runId}`;
    const archived = await createEvent(request, token, {
      name: archivedName,
      responseDeadline: noonDeadline(5),
    });
    const pastDeadline = noonDeadline(-2);
    await setLifecycleViaApi(request, token, archived.code, "archived", {
      responseDeadline: pastDeadline,
    });

    await page.goto("/dashboard");
    const errorAlert = page.getByRole("main").getByRole("alert");
    const statusAlert = page.getByRole("main").getByRole("status");
    const duplicateOf = (name) =>
      dashboardCard(page, name).getByRole("button", {
        name: "Duplicate",
        exact: true,
      });
    await expect(duplicateOf(event.name)).toBeVisible();

    // 1) Renamed in another session: the refusal refreshes the card.
    const renamed = `Duplicate renamed ${runId}`;
    await updateEventViaApi(request, token, code, { name: renamed });
    let posted = mutationResponse(page, "POST", "/events/duplicate");
    await duplicateOf(event.name).click();
    expect((await posted).status()).toBe(409);
    await expect(errorAlert).toHaveText(STALE_DUPLICATE);
    await expect(duplicateOf(renamed)).toBeVisible();
    await expect(
      page.getByRole("link", { name: event.name, exact: true }),
    ).toHaveCount(0);

    // 2) The server makes the copy but its answer is lost on the way back:
    // the retry sends the same key and gets that copy back instead of a
    // second one.
    const keys = [];
    page.on("request", (sent) => {
      if (
        sent.method() === "POST" &&
        sent.url().includes(`/events/duplicate?code=${code}`)
      ) {
        keys.push(sent.postDataJSON().idempotencyKey);
      }
    });
    const lostAnswer = "The connection dropped before the answer arrived.";
    const lostStatuses = [];
    const loseAnswer = async (route) => {
      if (route.request().method() !== "POST" || lostStatuses.length > 0) {
        await route.fallback();
        return;
      }
      const answered = await route.fetch();
      lostStatuses.push(answered.status());
      const headers = { ...answered.headers() };
      delete headers["content-length"];
      delete headers["content-encoding"];
      await route.fulfill({
        status: 503,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ error: lostAnswer }),
      });
    };
    const duplicateRoute = /\/events\/duplicate\?code=/;
    await page.route(duplicateRoute, loseAnswer);
    try {
      await duplicateOf(renamed).click();
      await expect(errorAlert).toHaveText(lostAnswer);
    } finally {
      await page.unroute(duplicateRoute, loseAnswer);
    }
    // The server did make the copy.
    expect(lostStatuses).toEqual([201]);
    const copyName = `${renamed} (copy)`;
    await expect(
      page.getByRole("link", { name: copyName, exact: true }),
    ).toHaveCount(0);
    posted = mutationResponse(page, "POST", "/events/duplicate");
    await duplicateOf(renamed).click();
    const retried = await posted;
    expect(retried.status()).toBe(200);
    const retriedCopy = await retried.json();
    expect(retriedCopy.idempotent).toBe(true);
    await expect(statusAlert).toHaveText(
      `${renamed} was duplicated as a new active event.`,
    );
    await expect(
      page.getByRole("link", { name: copyName, exact: true }),
    ).toHaveCount(1);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const dashboard = await apiJson(request, "GET", "/dashboard/events", token);
    expect(
      dashboard.payload.organized.filter((entry) => entry.name === copyName),
    ).toHaveLength(1);

    // 3) An archived event starts again as an active copy, and its past
    // deadline is not carried over.
    const archivedPanel = page.getByRole("region", { name: /^Archived \(1\)/ });
    await expect(archivedPanel).toContainText(
      "Archived events are read-only. Duplicate one to start again, or delete it permanently.",
    );
    posted = mutationResponse(page, "POST", "/events/duplicate");
    await archivedPanel
      .getByRole("button", { name: "Duplicate", exact: true })
      .click();
    const restarted = await posted;
    expect(restarted.status()).toBe(201);
    const restartedCopy = (await restarted.json()).event;
    await expect(statusAlert).toHaveText(
      `${archivedName} was duplicated as a new active event.`,
    );
    const restartedCard = dashboardCard(page, `${archivedName} (copy)`);
    await expect(restartedCard).toContainText("Status: active");
    await expect(restartedCard).not.toContainText("Deadline:");
    expect(await eventState(request, token, restartedCopy.code)).toMatchObject({
      name: `${archivedName} (copy)`,
      status: "active",
      responseDeadline: null,
    });
    const source = await eventState(request, token, archived.code);
    expect(source.status).toBe("archived");
    expect(Date.parse(source.responseDeadline)).toBe(Date.parse(pastDeadline));
  });

  test("the duplicate API replays a key, refuses it with other details or once its copy is deleted, trims long names to fit the suffix and refuses a stale version", async ({
    request,
  }) => {
    const runId = newRunId();
    const { access: token } = await registerAccountViaApi(
      request,
      `duplicate-api-${runId}@example.com`,
      "Dana",
      "Double",
    );
    const longName = `${runId} `.padEnd(200, "d");
    const source = await createEvent(request, token, { name: longName });
    const code = source.code;
    const duplicate = (body) =>
      apiJson(request, "POST", `/events/duplicate?code=${code}`, token, body);
    const key = crypto.randomUUID();

    // 1) The copy's name keeps the first 193 characters and the suffix.
    const first = await duplicate({
      expectedVersion: source.version,
      idempotencyKey: key,
    });
    expect(first.response.status()).toBe(201);
    expect(first.payload.idempotent).toBe(false);
    const copy = first.payload.event;
    expect(copy.name).toBe(`${longName.slice(0, 193)} (copy)`);
    expect(copy.name).toHaveLength(200);
    expect(copy.code).not.toBe(code);
    expect(copy.status).toBe("active");

    // 2) The same key and details answer with the same copy.
    const replay = await duplicate({
      expectedVersion: source.version,
      idempotencyKey: key,
    });
    expect(replay.response.status()).toBe(200);
    expect(replay.payload).toMatchObject({
      idempotent: true,
      event: { code: copy.code },
    });

    // 3) The same key with other details is refused.
    const reused = await duplicate({
      expectedVersion: source.version,
      idempotencyKey: key,
      name: "Other copy",
    });
    expect(reused.response.status()).toBe(409);
    expect(reused.payload.error).toBe(
      "This duplication key was already used with different details.",
    );

    // 4) A requested name is trimmed, and must be present and short enough.
    const named = await duplicate({
      expectedVersion: source.version,
      idempotencyKey: crypto.randomUUID(),
      name: `  Custom copy ${runId}  `,
    });
    expect(named.response.status()).toBe(201);
    expect(named.payload.event.name).toBe(`Custom copy ${runId}`);
    for (const [name, error] of [
      ["   ", "Duplicate event name cannot be empty"],
      ["n".repeat(201), "Event name too long (max 200)"],
    ]) {
      const refused = await duplicate({
        expectedVersion: source.version,
        idempotencyKey: crypto.randomUUID(),
        name,
      });
      expect(refused.response.status()).toBe(400);
      expect(refused.payload.error).toBe(error);
    }

    // 5) A new request against an old version is refused with the current
    // event; replaying the first key still answers with its copy.
    const renamed = await updateEventViaApi(request, token, code, {
      name: `Source ${runId} renamed`,
    });
    const stale = await duplicate({
      expectedVersion: source.version,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(stale.response.status()).toBe(409);
    expect(stale.payload.error).toBe(STALE_DUPLICATE);
    expect(stale.payload.event.version).toBe(renamed.event.version);
    const replayAfterRename = await duplicate({
      expectedVersion: source.version,
      idempotencyKey: key,
    });
    expect(replayAfterRename.response.status()).toBe(200);
    expect(replayAfterRename.payload.event.code).toBe(copy.code);

    // 6) Once the copy is deleted, its key reports it gone.
    const deleted = await apiJson(
      request,
      "DELETE",
      `/events?code=${copy.code}`,
      token,
      {
        expectedVersion: copy.version,
        idempotencyKey: crypto.randomUUID(),
        confirmation: copy.code,
      },
    );
    expect(deleted.response.status()).toBe(200);
    const gone = await duplicate({
      expectedVersion: source.version,
      idempotencyKey: key,
    });
    expect(gone.response.status()).toBe(410);
    expect(gone.payload.error).toBe(
      "The event created by this duplication request has been deleted.",
    );

    const dashboard = await apiJson(request, "GET", "/dashboard/events", token);
    expect(
      dashboard.payload.organized.map((entry) => entry.code).sort(),
    ).toEqual([code, named.payload.event.code].sort());
  });
});

test.describe("Deleting events", () => {
  test("the delete dialog closes on Cancel, Escape and the backdrop without deleting, and a stale version or an email in flight explains itself before the delete goes through", async ({
    page,
    request,
  }) => {
    const { runId, token, event, code } = await startEditor(
      { page, request },
      "delete-ui",
    );
    await page.goto("/dashboard");
    const deletes = requestRecorder(
      page,
      (sent) =>
        sent.method() === "DELETE" && sent.url().includes(`/events?code=`),
    );
    const openDialog = async (name) => {
      await dashboardCard(page, name)
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Event code confirmation")).toBeFocused();
      return dialog;
    };

    // 1) Cancel, Escape and a click on the backdrop each close the dialog
    // without asking the server anything.
    let dialog = await openDialog(event.name);
    await dialog.getByLabel("Event code confirmation").fill(code);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    dialog = await openDialog(event.name);
    await expect(dialog.getByLabel("Event code confirmation")).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    dialog = await openDialog(event.name);
    await page
      .locator(".app-modal-backdrop")
      .click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
    expect(deletes.entries).toEqual([]);
    expect((await eventState(request, token, code)).version).toBe(
      event.version,
    );

    // 2) Renamed in another session while the dialog is open: the refusal
    // shows in the dialog, which now names the current event.
    dialog = await openDialog(event.name);
    const renamed = `Delete renamed ${runId}`;
    await updateEventViaApi(request, token, code, { name: renamed });
    await dialog.getByLabel("Event code confirmation").fill(code);
    const confirm = page.getByRole("button", {
      name: "Delete event permanently",
    });
    let deleted = mutationResponse(page, "DELETE", "/events");
    await confirm.click();
    expect((await deleted).status()).toBe(409);
    dialog = page.getByRole("dialog", { name: `Delete ${renamed}?` });
    await expect(dialog.getByRole("alert")).toHaveText(STALE_DELETE);
    await expect(
      page.getByRole("link", { name: renamed, exact: true }),
    ).toHaveCount(1);

    // 3) An email to this event is being handed to the provider: the delete
    // waits for it.
    const jobId = seedInFlightJob(code, `inflight-${runId}@example.com`);
    try {
      deleted = mutationResponse(page, "DELETE", "/events");
      await confirm.click();
      const inFlight = await deleted;
      expect(inFlight.status()).toBe(409);
      expect(await inFlight.json()).toMatchObject({
        error: DELIVERY_IN_PROGRESS,
        retryable: true,
      });
      await expect(dialog.getByRole("alert")).toHaveText(DELIVERY_IN_PROGRESS);
      expect((await eventState(request, token, code)).name).toBe(renamed);
    } finally {
      // 4) Once it finishes, the same dialog deletes the event.
      expect(finishJob(jobId)).toBe(1);
    }
    deleted = mutationResponse(page, "DELETE", "/events");
    await confirm.click();
    const done = await deleted;
    expect(done.status()).toBe(200);
    expect(await done.json()).toEqual({ deletedCode: code, idempotent: false });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("status")).toHaveText(
      `${renamed} was permanently deleted.`,
    );
    await expect(
      page.getByRole("link", { name: renamed, exact: true }),
    ).toHaveCount(0);
    const lookup = await apiJson(request, "GET", `/events?code=${code}`, token);
    expect(lookup.response.status()).toBe(404);
  });

  test("a retried delete is idempotent, its key cannot delete another event, and a deleted code is never issued again", async ({
    request,
  }) => {
    const runId = newRunId();
    const { access: token } = await registerAccountViaApi(
      request,
      `delete-api-${runId}@example.com`,
      "Dee",
      "Lete",
    );
    const other = await registerAccountViaApi(
      request,
      `delete-other-${runId}@example.com`,
      "Otto",
      "Other",
    );
    const first = await createEvent(request, token, {
      name: `Delete once ${runId}`,
    });
    const second = await createEvent(request, token, { name: `Keep ${runId}` });
    const key = crypto.randomUUID();
    const body = {
      expectedVersion: first.version,
      idempotencyKey: key,
      confirmation: first.code,
    };
    const remove = (code, auth, payload) =>
      apiJson(request, "DELETE", `/events?code=${code}`, auth, payload);

    const done = await remove(first.code, token, body);
    expect(done.response.status()).toBe(200);
    expect(done.payload).toEqual({
      deletedCode: first.code,
      idempotent: false,
    });

    // 1) The same request again answers as done.
    const replay = await remove(first.code, token, body);
    expect(replay.response.status()).toBe(200);
    expect(replay.payload).toEqual({
      deletedCode: first.code,
      idempotent: true,
    });

    // 2) Other details, or another account, find no event.
    for (const [auth, payload] of [
      [token, { ...body, expectedVersion: first.version + 1 }],
      [token, { ...body, idempotencyKey: crypto.randomUUID() }],
      [other.access, body],
    ]) {
      const missing = await remove(first.code, auth, payload);
      expect(missing.response.status()).toBe(404);
      expect(missing.payload.error).toBe("Event not found");
    }

    // 3) The key cannot delete another event.
    const reused = await remove(second.code, token, {
      expectedVersion: second.version,
      idempotencyKey: key,
      confirmation: second.code,
    });
    expect(reused.response.status()).toBe(409);
    expect(reused.payload.error).toBe(
      "This deletion key was already used for another event.",
    );
    expect((await eventState(request, token, second.code)).version).toBe(
      second.version,
    );
    const lookup = await apiJson(
      request,
      "GET",
      `/events?code=${first.code}`,
      token,
    );
    expect(lookup.response.status()).toBe(404);

    // 4) The deleted code stays reserved: the code picker skips it even
    // when the random generator draws it, and gives up rather than reuse it.
    // Codes are random, so the generator is steered in-process; nothing is
    // written.
    const reserved = runDjangoJson(
      `
from unittest import mock

from apps.scheduling.models import Event, EventDeletionRecord
from apps.scheduling.services.events import mutations
from apps.scheduling.services.events.codes import generate_event_code

deleted = data["code"]
fresh = generate_event_code()
while Event.objects.filter(code=fresh).exists() or EventDeletionRecord.objects.filter(code=fresh).exists():
    fresh = generate_event_code()
with mock.patch.object(mutations, "generate_event_code", side_effect=[deleted, fresh]):
    picked = mutations._unique_event_code()
try:
    with mock.patch.object(mutations, "generate_event_code", return_value=deleted):
        mutations._unique_event_code()
    refused = None
except mutations.EventManagementError as exc:
    refused = str(exc)
record = EventDeletionRecord.objects.filter(code=deleted).first()
print(json.dumps({
    "pickedFresh": picked == fresh,
    "refused": refused,
    "record": {
        "organizer": str(record.organizer_id),
        "deletedVersion": record.deleted_version,
        "key": str(record.idempotency_key),
    },
    "eventExists": Event.objects.filter(code=deleted).exists(),
}))
`,
      { code: first.code },
    );
    const organizerId = (
      await apiJson(request, "GET", `/events?code=${second.code}`, token)
    ).payload.event.organizerUserId;
    expect(reserved).toEqual({
      pickedFresh: true,
      refused: "Failed to generate unique code",
      record: {
        organizer: organizerId,
        deletedVersion: first.version,
        key,
      },
      eventExists: false,
    });
  });

  test("deleting an event removes its responses, invitations, final meeting, emails and organizer-managed people", async ({
    request,
  }) => {
    const runId = newRunId();
    const { access: token } = await registerAccountViaApi(
      request,
      `delete-cascade-${runId}@example.com`,
      "Cass",
      "Cade",
    );
    const event = await createEvent(request, token, {
      name: `Cascade ${runId}`,
    });
    const code = event.code;

    // Ivy is invited and answers; Mo has no email and is kept by the
    // organizer; the best time is finalized, which emails Ivy.
    const ivy = `ivy-${runId}@example.com`;
    await addPersonApi(request, code, token, {
      name: "Ivy",
      email: ivy,
      sendInvitation: true,
    });
    await addPersonApi(request, code, token, {
      name: `Mo ${runId}`,
      organizerManaged: true,
    });
    await waitForInvitationStatus(request, code, token, ivy, "sent");
    const entries = (await rosterEntries(request, code, token)).participants;
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      await submitOnBehalf(request, token, event, entry);
    }
    const results = await freshResults(request, token, code);
    await finalizeViaApi(request, token, code, results.recommendations[0]);

    // Wait until nothing due is left for the worker, so the delete never
    // meets a send in progress, then queue one more email for tomorrow.
    await expect
      .poll(
        () =>
          runDjangoJson(
            `
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob

jobs = EmailDeliveryJob.objects.filter(event__code=data["code"])
print(json.dumps({
    "busy": jobs.filter(status__in=["pending", "processing", "retry"], next_attempt_at__lte=timezone.now()).count(),
    "confirmations": jobs.filter(message_type="final_confirmation", status="sent").count(),
}))
`,
            { code },
          ),
        { timeout: 30_000 },
      )
      .toEqual({ busy: 0, confirmations: 1 });

    const snapshot = runDjangoJson(
      `
import uuid
from datetime import timedelta

from django.db.models import Q
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import Event, EventInvitation, FinalMeeting, Participant, UserEvent

event = Event.objects.get(code=data["code"])
key = uuid.uuid4().hex
EmailDeliveryJob.objects.create(
    idempotency_key=f"e2e-editing:{key}",
    message_type="reminder",
    recipient=data["email"],
    subject="Queued by the event editing spec",
    body="Queued by the event editing spec.",
    message_id=f"<e2e-editing-{key}@releviz.local>",
    event=event,
    status="pending",
    next_attempt_at=timezone.now() + timedelta(days=1),
)
participants = Participant.objects.filter(event=event)
ids = lambda queryset: sorted(str(pk) for pk in queryset.values_list("pk", flat=True))
print(json.dumps({
    "eventId": str(event.pk),
    "eventUuid": str(event.event_id),
    "participants": ids(participants),
    "submitted": participants.filter(submitted=True).count(),
    "invitations": ids(EventInvitation.objects.filter(event=event)),
    "meetings": ids(FinalMeeting.objects.filter(event=event)),
    "jobs": ids(EmailDeliveryJob.objects.filter(event=event)),
    "queued": EmailDeliveryJob.objects.filter(event=event, status="pending").count(),
    "logs": ids(EmailMessageLog.objects.filter(
        Q(event=event) | Q(invitation__event=event) | Q(delivery_job__event=event)
    )),
    "userEvents": ids(UserEvent.objects.filter(event=event)),
    "managedMembers": sorted(str(pk) for pk in participants.filter(organizer_managed=True).values_list("member_id", flat=True)),
}))
`,
      { code, email: ivy },
    );
    expect(snapshot.participants).toHaveLength(2);
    expect(snapshot.submitted).toBe(2);
    expect(snapshot.invitations).toHaveLength(1);
    expect(snapshot.meetings).toHaveLength(1);
    expect(snapshot.queued).toBe(1);
    // The invitation, the confirmation and the queued reminder.
    expect(snapshot.jobs.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.logs.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.managedMembers).toHaveLength(1);

    const current = await eventState(request, token, code);
    const deleted = await apiJson(
      request,
      "DELETE",
      `/events?code=${code}`,
      token,
      {
        expectedVersion: current.version,
        idempotencyKey: crypto.randomUUID(),
        confirmation: code,
      },
    );
    expect(deleted.response.status()).toBe(200);

    const remaining = runDjangoJson(
      `
from django.contrib.auth import get_user_model

from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import (
    Event,
    EventDeletionRecord,
    EventInvitation,
    FinalMeeting,
    Participant,
    UserEvent,
)

print(json.dumps({
    "event": Event.objects.filter(pk=data["eventId"]).count(),
    "participants": Participant.objects.filter(pk__in=data["participants"]).count(),
    "invitations": EventInvitation.objects.filter(pk__in=data["invitations"]).count(),
    "meetings": FinalMeeting.objects.filter(pk__in=data["meetings"]).count(),
    "jobs": EmailDeliveryJob.objects.filter(pk__in=data["jobs"]).count(),
    "logs": EmailMessageLog.objects.filter(pk__in=data["logs"]).count(),
    "userEvents": UserEvent.objects.filter(pk__in=data["userEvents"]).count(),
    "managedMembers": get_user_model().objects.filter(pk__in=data["managedMembers"]).count(),
    "tombstones": EventDeletionRecord.objects.filter(event_id=data["eventUuid"], code=data["code"]).count(),
}))
`,
      { ...snapshot, code },
    );
    expect(remaining).toEqual({
      event: 0,
      participants: 0,
      invitations: 0,
      meetings: 0,
      jobs: 0,
      logs: 0,
      userEvents: 0,
      managedMembers: 0,
      tombstones: 1,
    });
  });
});
