const { expect, test } = require("@playwright/test");
const {
  apiJson,
  eventState,
  expandAdvancedOptions,
  fillTextbox,
  latestEmailFor,
  newRunId,
  readSession,
  registerAccount,
  registerAccountViaApi,
  selectOption,
  updateEventViaApi,
} = require("./helpers/releviz");
const { cellAt, overviewDetail, overviewTile } = require("./helpers/workspace");
const {
  addPersonApi,
  invitationEmail,
  participantActions,
  waitForInvitationStatus,
} = require("./helpers/participants");
const {
  DAY_MS,
  dateListText,
  icsUtc,
  isoDate,
  nextUsDstDates,
  zonedLocalDateTime,
} = require("./helpers/time");

// The create form end to end: day selection (weekday chips and specific
// dates), the daily window (overnight included), the meeting type and
// location, the event timezone and access, the Advanced options (15-minute
// slots, a deadline typed in the event zone, reminders), the client
// validation errors, and the server and daylight-saving errors that keep the
// organizer on the form. Every saved value is read back from the API, and
// the organizer Overview, Time Table and dashboard show it. The events API's
// own rules for payloads the form never sends close the file.
//
// Browser-formatted strings (deadlines) are compared with what the browser
// itself formats, so ICU spacing (a narrow no-break space before PM) and the
// zone name always match; the locale is pinned because toLocaleString([])
// follows it.

test.use({ locale: "en-US" });

// The API's create call: POST /events (no sub-path, no query).
function isCreateCall(request) {
  return (
    request.method() === "POST" && new URL(request.url()).pathname === "/events"
  );
}

// Opens the create form from the dashboard's "Create New Event" link.
async function openCreateForm(page) {
  await page.getByRole("link", { name: "Create New Event" }).click();
  await expect(page).toHaveURL(/\/create$/);
  await expect(
    page.getByRole("heading", { name: "Create event" }),
  ).toBeVisible();
}

// Records every POST /events the page sends, so a test can prove that a
// refused submit never reached the server.
function createRequests(page) {
  const sent = [];
  page.on("request", (request) => {
    if (isCreateCall(request)) {
      sent.push(request);
    }
  });
  return sent;
}

// Resolves to the next POST /events response.
function createResponse(page) {
  return page.waitForResponse((response) => isCreateCall(response.request()));
}

// Submits the create form, expects the 201, and returns the organizer's full
// definition of the new event once its workspace shows.
async function createAndOpen(page, request, token) {
  const created = createResponse(page);
  await page.getByRole("button", { name: "Create Event" }).click();
  expect((await created).status()).toBe(201);
  await page.waitForURL(/\/event\?code=/);
  const code = new URL(page.url()).searchParams.get("code");
  const event = await eventState(request, token, code);
  await expect(
    page.getByRole("heading", { level: 2, name: event.name }),
  ).toBeVisible();
  return event;
}

// How the browser shows an instant in a zone with its short zone name, the
// format the Overview, dashboard and Email menu use.
function browserDateTime(page, value, timeZone) {
  return page.evaluate(
    ([instant, zone]) =>
      new Date(instant).toLocaleString([], {
        timeZone: zone,
        timeZoneName: "short",
      }),
    [value, timeZone],
  );
}

// GET /events?code= as another signed-in account: 200 when that account may
// see the event, 404 when the event is hidden from it.
async function strangerStatus(request, runId, code) {
  const stranger = await registerAccountViaApi(
    request,
    `config-stranger-${runId}@example.com`,
    "Sam",
    "Stranger",
  );
  const seen = await apiJson(
    request,
    "GET",
    `/events?code=${code}`,
    stranger.access,
  );
  return seen.response.status();
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

test.describe("Create form: schedule, meeting and access", () => {
  test("creates a specific-dates overnight virtual event open to anyone with the code", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `config-dates-${runId}@example.com`,
      "Dana",
      "Dates",
    );
    const token = (await readSession(page)).access;
    const d1 = isoDate(Date.now() + 7 * DAY_MS);
    const d2 = isoDate(Date.now() + 9 * DAY_MS);
    const d3 = isoDate(Date.now() + 12 * DAY_MS);
    const name = `Overnight dates ${runId}`;

    await openCreateForm(page);
    await fillTextbox(page, "Event Name", name);

    // Day selection: specific dates replace the weekday chips.
    const typeGroup = page.getByRole("group", { name: "Day selection type" });
    const daysOfWeek = typeGroup.getByRole("button", { name: "Days of Week" });
    const specificDates = typeGroup.getByRole("button", {
      name: "Specific Dates",
    });
    await expect(daysOfWeek).toHaveAttribute("aria-pressed", "true");
    await specificDates.click();
    await expect(specificDates).toHaveAttribute("aria-pressed", "true");
    await expect(daysOfWeek).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("group", { name: "Days of the week" }),
    ).toHaveCount(0);

    // Dates stay sorted whatever order they are added in. A date already on
    // the list is ignored (and stays in the input, which clears only when a
    // date is added), and one can be removed again.
    const dateInput = page.getByLabel("Specific event date");
    const selected = page.getByRole("list", { name: "Selected dates" });
    const addDate = page.getByRole("button", { name: "Add date" });
    await expect(selected).toHaveCount(0);
    for (const [date, expected] of [
      [d2, [d2]],
      [d1, [d1, d2]],
      [d3, [d1, d2, d3]],
    ]) {
      await dateInput.fill(date);
      await expect(dateInput).toHaveValue(date);
      await addDate.click();
      await expect(selected.getByRole("listitem")).toHaveText(expected);
      await expect(dateInput).toHaveValue("");
    }
    await dateInput.fill(d1);
    await addDate.click();
    await expect(selected.getByRole("listitem")).toHaveText([d1, d2, d3]);
    await expect(dateInput).toHaveValue(d1);
    await page.getByRole("button", { name: `Remove ${d3}` }).click();
    await expect(selected.getByRole("listitem")).toHaveText([d1, d2]);

    // An end time before the start time makes an overnight window.
    await expect(page.getByLabel("Start Time")).toHaveValue("09:00");
    await expect(page.getByLabel("End Time")).toHaveValue("17:00");
    await page.getByLabel("Start Time").fill("22:00");
    await page.getByLabel("End Time").fill("02:00");
    await expect(
      page.getByText(
        "An end time earlier than the start time creates an overnight window.",
      ),
    ).toBeVisible();

    // Meeting type: In-Person by default. A virtual event has no location
    // field, and a location typed while it was Mixed is dropped.
    const meeting = page.getByRole("group", { name: "Meeting type" });
    await expect(
      meeting.getByRole("button", { name: "In-Person" }),
    ).toHaveAttribute("aria-pressed", "true");
    await meeting.getByRole("button", { name: "Mixed" }).click();
    await expect(
      meeting.getByRole("button", { name: "Mixed" }),
    ).toHaveAttribute("aria-pressed", "true");
    await fillTextbox(page, "Location / Address", "Hybrid Hall");
    await meeting.getByRole("button", { name: "Virtual" }).click();
    await expect(
      meeting.getByRole("button", { name: "Virtual" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      meeting.getByRole("button", { name: "Mixed" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("textbox", { name: "Location / Address" }),
    ).toHaveCount(0);

    await selectOption(page, "Event timezone", "UTC");
    await expect(
      page.getByRole("combobox", { name: "Event Access" }),
    ).toHaveValue("invite_only");
    await selectOption(
      page,
      "Event Access",
      "Anyone with the event code",
      "open_link",
    );

    const event = await createAndOpen(page, request, token);
    expect(event).toMatchObject({
      name,
      daySelectionType: "specific_dates",
      specificDates: [d1, d2],
      days: [],
      startTime: "22:00",
      endTime: "02:00",
      crossesMidnight: true,
      slotMinutes: 30,
      slotCount: 16,
      mode: "virtual",
      location: "",
      accessMode: "open_link",
      timezone: "UTC",
      meetingDurationMinutes: 30,
      startingAvailability: "available",
      remindersEnabled: true,
      reminderHoursBefore: 24,
      responseDeadline: null,
    });
    // Rows after midnight belong to the next day of their date.
    expect(event.slotGroups.map((group) => group.key)).toEqual([
      `date:${d1}`,
      `date:${d2}`,
    ]);
    const firstNight = event.slotGroups[0].slots;
    expect(firstNight.map((slot) => slot.localStart)).toEqual([
      "22:00",
      "22:30",
      "23:00",
      "23:30",
      "00:00",
      "00:30",
      "01:00",
      "01:30",
    ]);
    expect(firstNight[3]).toMatchObject({
      startDayOffset: 0,
      endDayOffset: 1,
    });
    expect(firstNight[4]).toMatchObject({
      startDayOffset: 1,
      startsAt: `${isoDate(Date.parse(d1) + DAY_MS)}T00:00:00+00:00`,
    });

    // The Overview says so, with the dates written out ("Oct 7, 9, 2026").
    await expect(overviewTile(page, "Schedule")).toContainText(
      dateListText([d1, d2]),
    );
    await expect(overviewTile(page, "Schedule")).toContainText(
      "10:00 PM - 2:00 AM (next day) · UTC",
    );
    await expect(overviewTile(page, "Meeting")).toContainText(
      "Virtual · 30 minutes",
    );
    await expect(overviewTile(page, "Meeting")).toContainText(
      "Location not set",
    );
    await expect(overviewTile(page, "Responses")).toContainText(
      "Anyone with code",
    );
    await expect(overviewTile(page, "Responses")).toContainText("No deadline");

    // The Time Table marks the rows after midnight as the next day, and a
    // virtual-only event has no channel switch.
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    await expect(grid).toBeVisible();
    await expect(page.locator(".meeting-calendar")).toHaveClass(
      /meeting-calendar--overnight/,
    );
    await expect(
      page.getByRole("group", { name: "Meeting channel" }),
    ).toHaveCount(0);
    await expect(page.locator(".meeting-calendar")).toHaveAttribute(
      "data-channel",
      "virtual",
    );
    await expect(grid.getByRole("columnheader")).toHaveCount(3);
    await expect(grid.getByRole("rowheader")).toHaveCount(8);
    await expect(grid.getByRole("rowheader").nth(3)).toHaveText("11:30 PM");
    await expect(grid.getByRole("rowheader").nth(4)).toHaveText("12:00 AM +1d");
    await expect(cellAt(grid, 3, 0)).toHaveAttribute(
      "aria-label",
      /11:30 PM – 12:00 AM \+1d/,
    );
    await expect(cellAt(grid, 4, 0)).toHaveAttribute(
      "aria-label",
      /12:00 AM \+1d – 12:30 AM \+1d/,
    );

    // Anyone signed in with the code can open it.
    expect(await strangerStatus(request, runId, event.code)).toBe(200);
  });

  test("toggles weekday chips and saves the window, location, browser-zone default and invite-only access", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `config-weekdays-${runId}@example.com`,
      "Wes",
      "Weekday",
    );
    const token = (await readSession(page)).access;
    const name = `Weekday chips ${runId}`;
    const location = `Room 101, Building ${runId}`;

    await openCreateForm(page);
    await fillTextbox(page, "Event Name", name);
    await expect(
      page.getByRole("textbox", { name: "Event Name" }),
    ).toHaveAttribute("maxlength", "200");

    // Mon-Fri are on by default; the chips toggle one weekday each.
    const weekdays = page.getByRole("group", { name: "Days of the week" });
    const chip = (day) =>
      weekdays.getByRole("button", { name: day, exact: true });
    for (const [day, pressed] of [
      ["Sun", "false"],
      ["Mon", "true"],
      ["Tue", "true"],
      ["Wed", "true"],
      ["Thu", "true"],
      ["Fri", "true"],
      ["Sat", "false"],
    ]) {
      await expect(chip(day)).toHaveAttribute("aria-pressed", pressed);
    }
    for (const day of ["Mon", "Fri", "Sun", "Sat"]) {
      const before = await chip(day).getAttribute("aria-pressed");
      await chip(day).click();
      await expect(chip(day)).toHaveAttribute(
        "aria-pressed",
        before === "true" ? "false" : "true",
      );
    }
    // A second click turns a day back off.
    await chip("Wed").click();
    await expect(chip("Wed")).toHaveAttribute("aria-pressed", "false");
    await chip("Wed").click();
    await expect(chip("Wed")).toHaveAttribute("aria-pressed", "true");

    // A non-default daily window.
    await page.getByLabel("Start Time").fill("08:00");
    await page.getByLabel("End Time").fill("12:30");

    await fillTextbox(page, "Location / Address", `  ${location}  `);

    // The zone defaults to the browser's own, and access to invite only.
    const browserZone = await page.evaluate(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    await expect(
      page.getByRole("combobox", { name: "Event timezone" }),
    ).toHaveValue(browserZone);
    await expect(
      page.getByRole("combobox", { name: "Event Access" }),
    ).toHaveValue("invite_only");

    const event = await createAndOpen(page, request, token);
    expect(event).toMatchObject({
      name,
      daySelectionType: "days_of_week",
      days: [0, 2, 3, 4, 6],
      startTime: "08:00",
      endTime: "12:30",
      crossesMidnight: false,
      slotMinutes: 30,
      slotCount: 45,
      mode: "inperson",
      location,
      timezone: browserZone,
      accessMode: "invite_only",
      responseDeadline: null,
    });
    expect(event.specificDates).toBeUndefined();
    expect(event.slotGroups.map((group) => group.label)).toEqual([
      "Sun",
      "Tue",
      "Wed",
      "Thu",
      "Sat",
    ]);

    await expect(overviewTile(page, "Schedule")).toContainText(
      "Sun, Tue, Wed, Thu, Sat",
    );
    await expect(overviewTile(page, "Schedule")).toContainText(
      `8:00 AM - 12:30 PM · ${browserZone}`,
    );
    await expect(overviewTile(page, "Schedule")).not.toContainText("next day");
    await expect(overviewTile(page, "Meeting")).toContainText(
      "In-Person · 30 minutes",
    );
    await expect(overviewTile(page, "Meeting")).toContainText(location);
    await expect(overviewTile(page, "Responses")).toContainText("Invite only");

    // The Time Table has a column per chosen weekday and a row per slot.
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    const dayHeaders = grid.locator(".meeting-calendar__column-day");
    await expect(dayHeaders).toHaveText(["Sun", "Tue", "Wed", "Thu", "Sat"]);
    await expect(grid.getByRole("rowheader")).toHaveCount(9);
    await expect(grid.getByRole("rowheader").first()).toHaveText("8:00 AM");
    await expect(grid.getByRole("rowheader").last()).toHaveText("12:00 PM");

    // The Schedule tile also counts blocked slots: block Tuesday's first
    // hour (rows 0 and 1 of its group) and reload.
    expect(event.slotGroups[1].key).toBe("weekday:2");
    await updateEventViaApi(request, token, event.code, {
      blockedSlots: { "weekday:2": [0, 1] },
    });
    await page.reload();
    await expect(overviewTile(page, "Schedule")).toContainText(
      `8:00 AM - 12:30 PM · ${browserZone} · 2 slots blocked`,
    );

    // The dashboard card shows the stored location.
    await page.goto("/dashboard");
    await expect(dashboardCard(page, name)).toContainText(location);

    // An invite-only event stays hidden from someone who is not on it.
    expect(await strangerStatus(request, runId, event.code)).toBe(404);
  });
});

test.describe("Create form: Advanced options", () => {
  test("applies 15-minute slots, a deadline in the event timezone, reminder settings and a blank location", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `config-advanced-${runId}@example.com`,
      "Avery",
      "Advanced",
    );
    const token = (await readSession(page)).access;
    const name = `Fine tuning ${runId}`;
    const invitee = `config-rita-${runId}@example.com`;
    // A zone with a half-hour offset and no daylight saving, so the typed
    // wall clock maps to exactly one instant, far from UTC's. (Chromium
    // lists India under its old name Asia/Calcutta, so Darwin it is.)
    const zone = "Australia/Darwin";
    const deadline = zonedLocalDateTime(30, "17:00", zone);

    await openCreateForm(page);
    await fillTextbox(page, "Event Name", name);
    await expect(
      page.getByRole("textbox", { name: "Location / Address" }),
    ).toHaveAttribute("placeholder", "TBD");
    await selectOption(page, "Event timezone", zone);

    await expandAdvancedOptions(page);
    await expect(
      page.getByRole("heading", { name: "Fine tuning" }),
    ).toBeVisible();
    await expect(page.getByLabel("Slot Duration")).toHaveValue("30");
    await selectOption(page, "Slot Duration", "15 minutes", "15");
    // 45 minutes needs 15-minute slots.
    await page.getByLabel("Meeting Duration").fill("45");
    await page.getByLabel("Response Deadline").fill(deadline);
    const reminderHours = page.getByLabel("Reminder Hours Before Deadline");
    await expect(reminderHours).toHaveValue("24");
    await reminderHours.fill("6");
    await expect(
      page.getByRole("checkbox", {
        name: "Send reminder emails before the deadline",
      }),
    ).toBeChecked();

    const event = await createAndOpen(page, request, token);
    expect(event).toMatchObject({
      slotMinutes: 15,
      meetingDurationMinutes: 45,
      slotCount: 5 * 32,
      timezone: zone,
      remindersEnabled: true,
      reminderHoursBefore: 6,
      location: "TBD",
      mode: "inperson",
    });
    // The typed wall clock is 17:00 in Darwin (UTC+09:30).
    expect(Date.parse(event.responseDeadline)).toBe(
      Date.parse(`${deadline}:00+09:30`),
    );
    expect(event.slotGroups[0].slots.slice(0, 3)).toMatchObject([
      { localStart: "09:00", localEnd: "09:15" },
      { localStart: "09:15", localEnd: "09:30" },
      { localStart: "09:30", localEnd: "09:45" },
    ]);

    // Overview: the blank location shows as the stored TBD, and the deadline
    // is 5 PM in the event zone.
    const shownDeadline = await browserDateTime(
      page,
      event.responseDeadline,
      zone,
    );
    expect(shownDeadline).toMatch(/5:00:00\sPM/);
    await expect(overviewTile(page, "Meeting")).toContainText(
      "In-Person · 45 minutes",
    );
    await expect(overviewTile(page, "Meeting")).toContainText("TBD");
    await expect(overviewTile(page, "Responses")).toContainText("Invite only");
    await expect(overviewTile(page, "Responses")).toContainText(shownDeadline);

    // "Show all details" opens the rest of the facts; "Hide details" closes
    // them again. The toggle flips on every click, so a retry clicks only
    // while it still reads collapsed.
    const detailsToggle = page.getByRole("button", {
      name: /^(Show all details|Hide details)$/,
    });
    await expect(detailsToggle).toHaveText("Show all details");
    await expect
      .poll(async () => {
        if ((await detailsToggle.getAttribute("aria-expanded")) === "false") {
          await detailsToggle.click();
        }
        return detailsToggle.getAttribute("aria-expanded");
      })
      .toBe("true");
    await expect(detailsToggle).toHaveText("Hide details");
    await expect(overviewDetail(page, "Availability interval")).toHaveText(
      "15 minutes",
    );
    await expect(overviewDetail(page, "Participants start as")).toHaveText(
      "Available",
    );
    await expect(overviewDetail(page, "Event code")).toHaveText(event.code);
    await expect(overviewDetail(page, "Status")).toHaveText("Active");
    await expect(overviewDetail(page, "Result revision")).toHaveText(
      String(event.resultsRevision),
    );
    await detailsToggle.click();
    await expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(detailsToggle).toHaveText("Show all details");
    await expect(
      page.locator("dl[aria-label='Additional event details']"),
    ).toHaveCount(0);

    // The Time Table has quarter-hour rows.
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    await expect(grid.getByRole("rowheader")).toHaveCount(32);
    await expect(grid.getByRole("rowheader").nth(1)).toHaveText("9:15 AM");
    await expect(cellAt(grid, 1, 0)).toHaveAttribute(
      "aria-label",
      /9:15 AM – 9:30 AM/,
    );

    // An invitation carries the deadline as a calendar file whose alarm
    // follows the reminder hours, and the person becomes remindable once it
    // is sent.
    const invitedAt = Date.now() - 1000;
    await addPersonApi(request, event.code, token, {
      name: "Rita Reminder",
      email: invitee,
      sendInvitation: true,
    });
    const invitation = await latestEmailFor(
      invitee,
      invitedAt,
      invitationEmail(event.code),
    );
    expect(invitation).toContain("TRIGGER:-PT6H");
    expect(invitation).toContain(`DTSTART:${icsUtc(event.responseDeadline)}`);
    await waitForInvitationStatus(request, event.code, token, invitee, "sent");
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();

    // The Email menu names the next automatic reminder: six hours before
    // the deadline, in the event zone.
    const nextReminder = await browserDateTime(
      page,
      new Date(
        Date.parse(event.responseDeadline) - 6 * 3_600_000,
      ).toISOString(),
      zone,
    );
    expect(nextReminder).toMatch(/11:00:00\sAM/);
    const emailButton = participantActions(page).getByRole("button", {
      name: "Email",
      exact: true,
    });
    const emailMenu = page.getByRole("menu", { name: "Email" });
    await emailButton.click();
    await expect(emailMenu).toContainText(
      `Next automatic reminder: ${nextReminder}`,
    );
    const sendReminders = emailMenu.getByRole("menuitem", {
      name: "Send reminders (1)…",
    });
    await expect(sendReminders).toBeEnabled();
    // The trigger toggles the menu (Escape would need focus inside it,
    // which a click does not give every engine).
    await emailButton.click();
    await expect(emailMenu).toHaveCount(0);

    // The editor round-trips the advanced settings and keeps TBD out of the
    // location field; turning the reminders off keeps the deadline and the
    // hours.
    const region = await openInlineEditor(page);
    await expect(
      region.getByRole("textbox", { name: "Location / Address" }),
    ).toHaveValue("");
    await region.locator("details.create-event-disclosure > summary").click();
    await expect(
      region.locator("details.create-event-disclosure"),
    ).toHaveAttribute("open", "");
    await expect(region.getByLabel("Slot Duration")).toHaveValue("15");
    await expect(region.getByLabel("Response Deadline")).toHaveValue(deadline);
    await expect(
      region.getByLabel("Reminder Hours Before Deadline"),
    ).toHaveValue("6");
    const remindersBox = region.getByRole("checkbox", {
      name: "Send reminder emails before the deadline",
    });
    await remindersBox.uncheck();
    await expect(remindersBox).not.toBeChecked();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events?code=${event.code}`),
    );
    await region.getByRole("button", { name: "Save changes" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText("Event changes saved.")).toBeVisible();

    const updated = await eventState(request, token, event.code);
    expect(updated).toMatchObject({
      remindersEnabled: false,
      reminderHoursBefore: 6,
      responseDeadline: event.responseDeadline,
      location: "TBD",
      slotMinutes: 15,
    });
    await emailButton.click();
    await expect(emailMenu).toContainText("Reminders are off");
    await expect(emailMenu).not.toContainText("Next automatic reminder");
    // Nobody can be reminded while reminders are off.
    await expect(sendReminders).toBeDisabled();
    await emailButton.click();
    await expect(emailMenu).toHaveCount(0);

    // The dashboard card shows the deadline in the event zone and hides the
    // TBD placeholder location.
    await page.goto("/dashboard");
    const card = dashboardCard(page, name);
    await expect(card).toContainText(`Deadline: ${shownDeadline}`);
    await expect(card).not.toContainText("TBD");
  });
});

test.describe("Create form: validation", () => {
  test("reports required fields, window, duration and reminder errors without sending anything, then saves the corrected form", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `config-validate-${runId}@example.com`,
      "Val",
      "Idator",
    );
    const token = (await readSession(page)).access;
    await openCreateForm(page);
    const sent = createRequests(page);
    const create = page.getByRole("button", { name: "Create Event" });

    // 1) The name is required, and focus lands on it. Typing clears it.
    await create.click();
    const nameError = page.locator("#event-name-error");
    await expect(nameError).toHaveText("Event name is required");
    const nameBox = page.getByRole("textbox", { name: "Event Name" });
    await expect(nameBox).toHaveAttribute("aria-invalid", "true");
    await expect(nameBox).toHaveAttribute(
      "aria-describedby",
      "event-name-error",
    );
    await expect(nameBox).toBeFocused();
    await nameBox.fill(`Validation ${runId}`);
    await expect(nameError).toHaveCount(0);
    await expect(nameBox).not.toHaveAttribute("aria-invalid", "true");

    // 2) At least one day, or one date.
    const weekdays = page.getByRole("group", { name: "Days of the week" });
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      const chip = weekdays.getByRole("button", { name: day, exact: true });
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "false");
    }
    await create.click();
    const dayError = page.locator("#day-selection-error");
    await expect(dayError).toHaveText("Select at least one day");
    const typeGroup = page.getByRole("group", { name: "Day selection type" });
    await expect(typeGroup).toHaveAttribute(
      "aria-describedby",
      "day-selection-error",
    );
    await expect(
      typeGroup.getByRole("button", { name: "Days of Week" }),
    ).toBeFocused();
    await typeGroup.getByRole("button", { name: "Specific Dates" }).click();
    await expect(dayError).toHaveCount(0);
    await create.click();
    await expect(dayError).toHaveText("Select at least one date");
    // Adding a date clears it.
    await page
      .getByLabel("Specific event date")
      .fill(isoDate(Date.now() + 5 * DAY_MS));
    await page.getByRole("button", { name: "Add date" }).click();
    await expect(dayError).toHaveCount(0);
    await typeGroup.getByRole("button", { name: "Days of Week" }).click();
    const wednesday = weekdays.getByRole("button", {
      name: "Wed",
      exact: true,
    });
    await wednesday.click();
    await expect(wednesday).toHaveAttribute("aria-pressed", "true");

    // 3) Both times are needed, they must align to the slots, and differ.
    const startTime = page.getByLabel("Start Time");
    const endTime = page.getByLabel("End Time");
    const timeError = page.locator("#time-range-error");
    await endTime.fill("");
    await create.click();
    await expect(timeError).toHaveText(
      "Choose both a start time and an end time",
    );
    await expect(startTime).toBeFocused();
    await endTime.fill("17:00");
    await expect(timeError).toHaveCount(0);
    await startTime.fill("09:15");
    await create.click();
    await expect(timeError).toHaveText("Times must align to 30-minute slots");
    await expect(startTime).toHaveAttribute("aria-invalid", "true");
    await expect(endTime).toHaveAttribute("aria-invalid", "true");
    await expect(startTime).toBeFocused();
    await startTime.fill("10:00");
    await expect(timeError).toHaveCount(0);
    await endTime.fill("10:00");
    await create.click();
    await expect(timeError).toHaveText("Start and end times must be different");
    await endTime.fill("11:00");
    await expect(timeError).toHaveCount(0);

    // 4) The meeting duration must be 15-480 minutes, a slot multiple, and
    // fit in the daily window.
    const duration = page.getByLabel("Meeting Duration");
    const durationError = page.locator("#meeting-duration-error");
    const alignMessage =
      "Meeting duration must be 15–480 minutes and align to 30-minute slots";
    await duration.fill("45");
    await create.click();
    await expect(durationError).toHaveText(alignMessage);
    await expect(duration).toHaveAttribute("aria-invalid", "true");
    await expect(duration).toBeFocused();
    await duration.fill("510");
    await create.click();
    await expect(durationError).toHaveText(alignMessage);
    await duration.fill("0");
    await create.click();
    await expect(durationError).toHaveText(alignMessage);
    await duration.fill("120");
    await create.click();
    await expect(durationError).toHaveText(
      "Meeting duration must fit within the configured daily time window",
    );
    await duration.fill("60");
    await expect(durationError).toHaveCount(0);

    // 5) A reminder error re-opens the collapsed Advanced options.
    await expandAdvancedOptions(page);
    const reminderHours = page.getByLabel("Reminder Hours Before Deadline");
    await reminderHours.fill("721");
    const advanced = page.locator("details.create-event-disclosure");
    await advanced.locator("summary").click();
    await expect(advanced).not.toHaveAttribute("open");
    await create.click();
    await expect(advanced).toHaveAttribute("open", "");
    const reminderError = page.locator("#reminder-hours-error");
    await expect(reminderError).toHaveText(
      "Reminder timing must be a whole number of hours between 0 and 720",
    );
    await expect(reminderHours).toHaveAttribute("aria-invalid", "true");
    await expect(reminderHours).toBeFocused();
    await reminderHours.fill("-1");
    await create.click();
    await expect(reminderError).toHaveText(
      "Reminder timing must be a whole number of hours between 0 and 720",
    );
    await reminderHours.fill("720");
    await expect(reminderError).toHaveCount(0);

    // None of these submits left the browser.
    await expect(page).toHaveURL(/\/create$/);
    expect(sent).toHaveLength(0);

    // The corrected form saves exactly what it shows: Wednesday only,
    // 10:00-11:00, a 60-minute meeting and the 720-hour upper bound. The
    // reminders checkbox is turned off on the create form, with a deadline
    // 40 days ahead: were reminders on, one would be due 10 days from now.
    await selectOption(page, "Event timezone", "UTC");
    const deadline = zonedLocalDateTime(40, "12:00", "UTC");
    await page.getByLabel("Response Deadline").fill(deadline);
    const remindersBox = page.getByRole("checkbox", {
      name: "Send reminder emails before the deadline",
    });
    await expect(remindersBox).toBeChecked();
    await remindersBox.uncheck();
    await expect(remindersBox).not.toBeChecked();
    const event = await createAndOpen(page, request, token);
    expect(sent).toHaveLength(1);
    expect(event).toMatchObject({
      name: `Validation ${runId}`,
      daySelectionType: "days_of_week",
      days: [3],
      startTime: "10:00",
      endTime: "11:00",
      slotCount: 2,
      meetingDurationMinutes: 60,
      timezone: "UTC",
      remindersEnabled: false,
      reminderHoursBefore: 720,
    });
    expect(Date.parse(event.responseDeadline)).toBe(
      Date.parse(`${deadline}:00Z`),
    );
    // The Email menu schedules nothing although the deadline is ahead.
    const emailButton = participantActions(page).getByRole("button", {
      name: "Email",
      exact: true,
    });
    const emailMenu = page.getByRole("menu", { name: "Email" });
    await emailButton.click();
    await expect(emailMenu).toContainText("Reminders are off");
    await expect(emailMenu).not.toContainText("Next automatic reminder");
    await emailButton.click();
    await expect(emailMenu).toHaveCount(0);
  });

  test("shows server and daylight-saving errors on the form and keeps the organizer on /create", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `config-server-${runId}@example.com`,
      "Sierra",
      "Server",
    );
    const token = (await readSession(page)).access;
    const { springForward, fallBack } = nextUsDstDates();
    const name = `Server errors ${runId}`;

    await openCreateForm(page);
    const sent = createRequests(page);
    const create = page.getByRole("button", { name: "Create Event" });
    const formError = page.locator(".create-event-error");
    await fillTextbox(page, "Event Name", name);

    // 1) The server refuses a past deadline for an active event.
    await selectOption(page, "Event timezone", "UTC");
    await expandAdvancedOptions(page);
    const deadline = page.getByLabel("Response Deadline");
    await deadline.fill(zonedLocalDateTime(-2, "12:00", "UTC"));
    let refused = createResponse(page);
    await create.click();
    expect((await refused).status()).toBe(400);
    await expect(formError).toHaveText(
      "An active event must have a future response deadline",
    );
    await expect(formError).toHaveAttribute("role", "alert");
    await expect(page).toHaveURL(/\/create$/);
    await expect(create).toBeEnabled();
    expect(sent).toHaveLength(1);

    // 2) A deadline inside New York's spring-forward gap, or in the repeated
    // fall-back hour, never reaches the server.
    await selectOption(page, "Event timezone", "America/New_York");
    await deadline.fill(`${springForward}T02:30`);
    await create.click();
    await expect(formError).toHaveText(
      "That local time does not exist because of a daylight-saving change.",
    );
    await deadline.fill(`${fallBack}T01:30`);
    await create.click();
    await expect(formError).toHaveText(
      "That local time is ambiguous because of a daylight-saving change.",
    );
    expect(sent).toHaveLength(1);

    // 3) A date whose window starts inside the gap is refused by the server.
    // The deadline is cleared first.
    await deadline.fill("");
    await expect(deadline).toHaveValue("");
    await page
      .getByRole("group", { name: "Day selection type" })
      .getByRole("button", { name: "Specific Dates" })
      .click();
    await page.getByLabel("Specific event date").fill(springForward);
    await page.getByRole("button", { name: "Add date" }).click();
    await expect(
      page.getByRole("list", { name: "Selected dates" }).getByRole("listitem"),
    ).toHaveText([springForward]);
    await page.getByLabel("Start Time").fill("02:00");
    await page.getByLabel("End Time").fill("04:00");
    refused = createResponse(page);
    await create.click();
    expect((await refused).status()).toBe(400);
    await expect(formError).toHaveText(
      `${springForward}T02:00 is a nonexistent local time in America/New_York.`,
    );
    await expect(page).toHaveURL(/\/create$/);

    // 4) Moving the window out of the gap creates the event, with no
    // deadline.
    await page.getByLabel("Start Time").fill("09:00");
    await page.getByLabel("End Time").fill("11:00");
    const event = await createAndOpen(page, request, token);
    expect(sent).toHaveLength(3);
    expect(event).toMatchObject({
      name,
      daySelectionType: "specific_dates",
      specificDates: [springForward],
      timezone: "America/New_York",
      startTime: "09:00",
      endTime: "11:00",
      slotCount: 4,
      responseDeadline: null,
    });
    await expect(overviewTile(page, "Responses")).toContainText("No deadline");
  });

  test("refuses fractional reminder hours instead of saving them truncated", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `config-fraction-${runId}@example.com`,
      "Fran",
      "Fraction",
    );
    const token = (await readSession(page)).access;
    const name = `Fractional reminder ${runId}`;
    await openCreateForm(page);
    await fillTextbox(page, "Event Name", name);
    await expandAdvancedOptions(page);
    await page.getByLabel("Reminder Hours Before Deadline").fill("1.5");
    await page.getByRole("button", { name: "Create Event" }).click();

    // Reminder hours are whole hours (a small integer column): the form
    // refuses 1.5 beside the field rather than sending it to become 1.
    await expect(page.locator("#reminder-hours-error")).toHaveText(
      "Reminder timing must be a whole number of hours between 0 and 720",
    );
    await expect(
      page.getByLabel("Reminder Hours Before Deadline"),
    ).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/create$/);

    // The API refuses the string "1.5" as "must be an integer", and the
    // number 1.5 (and 60.5 meeting minutes) the same way, not truncated.
    for (const overrides of [
      { reminderHoursBefore: 1.5 },
      { meetingDurationMinutes: 60.5 },
    ]) {
      const posted = await apiJson(request, "POST", "/events", token, {
        name: `${name} API`,
        status: "active",
        timezone: "UTC",
        ...overrides,
      });
      expect(posted.response.status(), JSON.stringify(overrides)).toBe(400);
      expect(posted.payload.error).toBe(
        `${Object.keys(overrides)[0]} must be an integer`,
      );
    }
  });
});

test.describe("Events API rules", () => {
  test("refuses create and update payloads the form never sends", async ({
    request,
  }) => {
    const runId = newRunId();
    const { access: token } = await registerAccountViaApi(
      request,
      `config-api-${runId}@example.com`,
      "Ada",
      "Api",
    );
    const base = {
      name: `API rules ${runId}`,
      startTime: "09:00",
      endTime: "17:00",
      slotMinutes: 30,
      days: [1, 2, 3, 4, 5],
      mode: "inperson",
      location: "Rules Room",
      daySelectionType: "days_of_week",
      timezone: "UTC",
      remindersEnabled: true,
      reminderHoursBefore: 24,
      accessMode: "invite_only",
      startingAvailability: "available",
      meetingDurationMinutes: 60,
      status: "active",
    };
    const day = (offset) => isoDate(Date.now() + offset * DAY_MS);
    const dated = (specificDates) => ({
      daySelectionType: "specific_dates",
      days: [],
      specificDates,
    });
    const thirtyTwoDays = Array.from({ length: 32 }, (_, i) => day(i + 1));

    const refusals = [
      [{ status: "draft" }, "New events must start as active."],
      [{ status: "finalized" }, "New events must start as active."],
      [{ name: "   " }, "Name is required"],
      [{ name: "n".repeat(201) }, "Event name too long (max 200)"],
      [{ location: "l".repeat(501) }, "Location too long (max 500)"],
      [
        { startHour: 9, endHour: 17 },
        "Use startTime and endTime in HH:MM format.",
      ],
      [{ startTime: "9am" }, "startTime must use HH:MM format."],
      [{ endTime: "24:00" }, "endTime must be a valid time."],
      [{ endTime: "09:00" }, "Event start and end times must be different."],
      [
        { startTime: "09:10" },
        "Start and end times must align to 30-minute slots.",
      ],
      [{ slotMinutes: 20 }, "slotMinutes must be 15 or 30."],
      [
        { mode: "hybrid" },
        "Invalid mode. Must be 'inperson', 'virtual', or 'mixed'",
      ],
      [{ daySelectionType: "weekly" }, "Invalid daySelectionType"],
      [{ days: [] }, "days must be a non-empty array of integers 0-6"],
      [{ days: [1, 7] }, "days must be a non-empty array of integers 0-6"],
      [
        { accessMode: "public" },
        "accessMode must be 'invite_only' or 'open_link'",
      ],
      [
        { startingAvailability: "maybe" },
        "startingAvailability must be 'available' or 'busy'",
      ],
      [
        { timezone: "Mars/Olympus_Mons" },
        "timezone must be a valid IANA timezone",
      ],
      [
        { responseDeadline: "next Friday" },
        "responseDeadline must be an ISO datetime",
      ],
      [
        { responseDeadline: new Date(Date.now() - DAY_MS).toISOString() },
        "An active event must have a future response deadline",
      ],
      [{ remindersEnabled: "yes" }, "remindersEnabled must be a boolean"],
      [
        { reminderHoursBefore: 721 },
        "reminderHoursBefore must be between 0 and 720",
      ],
      [
        { meetingDurationMinutes: 510 },
        "meetingDurationMinutes must be between 15 and 480",
      ],
      [
        { meetingDurationMinutes: 45 },
        "meetingDurationMinutes must be a multiple of slotMinutes",
      ],
      [
        { endTime: "10:00", meetingDurationMinutes: 120 },
        "meetingDurationMinutes does not fit within any configured day",
      ],
      [dated([]), "specificDates must be a non-empty array"],
      [
        dated([day(3), "2026-13-01"]),
        "specificDates must be ISO date strings (YYYY-MM-DD)",
      ],
      [
        dated(["2026-1-5"]),
        "specificDates must be ISO date strings (YYYY-MM-DD)",
      ],
      [
        dated([day(3), day(4), day(3)]),
        "specificDates must not contain duplicates",
      ],
      [dated(thirtyTwoDays), "specificDates may contain at most 31 dates"],
    ];
    for (const [overrides, message] of refusals) {
      const refused = await apiJson(request, "POST", "/events", token, {
        ...base,
        ...overrides,
      });
      expect(
        refused.response.status(),
        `${JSON.stringify(overrides).slice(0, 120)} should be refused`,
      ).toBe(400);
      expect(refused.payload.error).toBe(message);
    }

    // The limits themselves are accepted: a 200-character name, a
    // 500-character location and 31 dates, which are stored sorted.
    const longName = `${runId} `.padEnd(200, "n");
    const longLocation = "l".repeat(500);
    const thirtyOneDays = thirtyTwoDays.slice(0, 31);
    const accepted = await apiJson(request, "POST", "/events", token, {
      ...base,
      ...dated([...thirtyOneDays].reverse()),
      name: longName,
      location: longLocation,
      endTime: "10:00",
    });
    expect(accepted.response.status()).toBe(201);
    expect(accepted.payload.event).toMatchObject({
      name: longName,
      location: longLocation,
      specificDates: thirtyOneDays,
      slotCount: 62,
      status: "active",
    });
    const code = accepted.payload.event.code;
    const version = accepted.payload.event.version;

    // Updates follow the same configuration rules.
    for (const [changes, message] of [
      [{ startHour: 9 }, "Use startTime and endTime in HH:MM format."],
      [{ name: "n".repeat(201) }, "Event name too long (max 200)"],
      [{ location: "l".repeat(501) }, "Location too long (max 500)"],
      [
        { mode: "hybrid" },
        "Invalid mode. Must be 'inperson', 'virtual', or 'mixed'",
      ],
      [
        { accessMode: "public" },
        "accessMode must be 'invite_only' or 'open_link'",
      ],
      [
        { specificDates: [...thirtyOneDays, day(40)] },
        "specificDates may contain at most 31 dates",
      ],
    ]) {
      const refused = await apiJson(
        request,
        "PUT",
        `/events?code=${code}`,
        token,
        { expectedVersion: version, ...changes },
      );
      expect(refused.response.status(), JSON.stringify(changes)).toBe(400);
      expect(refused.payload.error).toBe(message);
    }
    const unchanged = await eventState(request, token, code);
    expect(unchanged).toMatchObject({ version, name: longName });

    // Nothing refused was stored: the organizer has exactly the one event.
    const dashboard = await apiJson(request, "GET", "/dashboard/events", token);
    expect(dashboard.response.status()).toBe(200);
    expect(dashboard.payload.organized.map((event) => event.code)).toEqual([
      code,
    ]);
  });
});
