const { expect, test } = require("@playwright/test");
const {
  apiJson,
  datetimeLocalHoursFromNow,
  dispatchEmailJobs,
  eventState,
  fillTextbox,
  importRoster,
  latestEmailFor,
  newRunId,
  readSession,
  registerAccount,
  selectOption,
} = require("./helpers/releviz");
const {
  cellAt,
  eventControls,
  overviewDetail,
  overviewTile,
} = require("./helpers/workspace");
const {
  DAY_MS,
  icsUtc,
  isoDate,
  nextUsDstDates,
  zonedLocalDateTime,
  zonedWallClock,
} = require("./helpers/time");

// The create form end to end: day selection (days of the week vs specific
// dates), overnight windows, the meeting type and location, event access,
// the Advanced options (15-minute slots, a deadline in the event timezone,
// reminders), and the client and server validation errors, daylight-saving
// gaps included. Every result is read back from the API and the organizer
// Overview. Each test picks the event timezone explicitly, so the host zone
// never matters.

// The Advanced options disclosure of the one create/edit form inside `scope`.
function advancedOptions(scope) {
  return scope.locator("details.create-event-disclosure");
}

// Opens the Advanced options inside `scope` (the inline editor collapses it).
async function openAdvancedOptions(scope) {
  const details = advancedOptions(scope);
  if ((await details.getAttribute("open")) === null) {
    await details.locator("summary").click();
  }
  await expect(details).toHaveAttribute("open", "");
}

// Opens the workspace's inline editor. A click that lands while the
// workspace re-renders after loading can be dropped by slower engines, so it
// is retried until the editor shows; the button is disabled while the editor
// is open, so a retry never closes it again.
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

async function createAndOpen(page, request, token) {
  await page.getByRole("button", { name: "Create Event" }).click();
  await page.waitForURL(/\/event\?code=/);
  const code = new URL(page.url()).searchParams.get("code");
  const event = await eventState(request, token, code);
  await expect(
    page.getByRole("heading", { level: 2, name: event.name }),
  ).toBeVisible();
  return { code, event };
}

test.describe("Event configuration", () => {
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

    await page.getByRole("link", { name: "Create New Event" }).click();
    await expect(page).toHaveURL(/\/create$/);
    await fillTextbox(page, "Event Name", `Overnight dates ${runId}`);

    // Day selection: switching to specific dates hides the weekday chips.
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

    // Dates are kept sorted, a repeated date is ignored, and one can be
    // removed again.
    const dateInput = page.getByLabel("Specific event date");
    const selected = page.getByRole("list", { name: "Selected dates" });
    const addDate = page.getByRole("button", { name: "Add date" });
    for (const [date, expected] of [
      [d2, [d2]],
      [d1, [d1, d2]],
      [d1, [d1, d2]],
      [d3, [d1, d2, d3]],
    ]) {
      await dateInput.fill(date);
      await expect(dateInput).toHaveValue(date);
      await addDate.click();
      await expect(selected.getByRole("listitem")).toHaveText(expected);
    }
    await page.getByRole("button", { name: `Remove ${d3}` }).click();
    await expect(selected.getByRole("listitem")).toHaveText([d1, d2]);

    // An end time before the start time makes an overnight window.
    await page.getByLabel("Start Time").fill("22:00");
    await page.getByLabel("End Time").fill("02:00");
    await expect(
      page.getByText(
        "An end time earlier than the start time creates an overnight window.",
      ),
    ).toBeVisible();

    // Meeting type: a virtual event has no location field, and a location
    // typed while it was Mixed is dropped by the server.
    const meeting = page.getByRole("group", { name: "Meeting type" });
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
      page.getByRole("textbox", { name: "Location / Address" }),
    ).toHaveCount(0);

    await selectOption(page, "Event timezone", "UTC");
    await selectOption(
      page,
      "Event Access",
      "Anyone with the event code",
      "open_link",
    );

    const { event } = await createAndOpen(page, request, token);
    expect(event).toMatchObject({
      daySelectionType: "specific_dates",
      specificDates: [d1, d2],
      days: [],
      startTime: "22:00",
      endTime: "02:00",
      crossesMidnight: true,
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
    expect(event.slotGroups.map((group) => group.key)).toEqual([
      `date:${d1}`,
      `date:${d2}`,
    ]);
    expect(event.slotGroups[0].slots[4]).toMatchObject({
      localStart: "00:00",
      startDayOffset: 1,
    });

    // The organizer Overview.
    await expect(overviewTile(page, "Schedule")).toContainText(`${d1}, ${d2}`);
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

    // The calendar marks the rows after midnight as the next day.
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    await expect(grid).toBeVisible();
    await expect(page.locator(".meeting-calendar")).toHaveClass(
      /meeting-calendar--overnight/,
    );
    await expect(
      page.getByRole("group", { name: "Meeting channel" }),
    ).toHaveCount(0);
    await expect(grid.getByRole("columnheader")).toHaveCount(3);
    await expect(grid.getByRole("rowheader").nth(4)).toHaveText("12:00 AM +1d");
    await expect(cellAt(grid, 4, 0)).toHaveAttribute(
      "aria-label",
      /12:00 AM \+1d – 12:30 AM \+1d/,
    );
  });

  test("applies 15-minute slots, a deadline in the event timezone, and reminder settings from Advanced options", async ({
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
    const ivy = `ivy-${runId}@example.com`;
    const zone = "America/New_York";

    await page.goto("/create");
    await fillTextbox(page, "Event Name", `Fine tuning ${runId}`);
    await selectOption(page, "Event timezone", zone);

    await openAdvancedOptions(page);
    await expect(
      page.getByRole("heading", { name: "Fine tuning" }),
    ).toBeVisible();
    await selectOption(page, "Slot Duration", "15 minutes", "15");
    await page.getByLabel("Meeting Duration").fill("45");

    // The deadline is a wall-clock time in the event timezone.
    const deadline = zonedLocalDateTime(30, "17:00", zone);
    await page.getByLabel("Response Deadline").fill(deadline);
    await page.getByLabel("Reminder Hours Before Deadline").fill("6");
    await expect(
      page.getByRole("checkbox", {
        name: "Send reminder emails before the deadline",
      }),
    ).toBeChecked();

    const { code, event } = await createAndOpen(page, request, token);
    expect(event).toMatchObject({
      slotMinutes: 15,
      meetingDurationMinutes: 45,
      slotCount: 160,
      timezone: zone,
      remindersEnabled: true,
      reminderHoursBefore: 6,
    });
    expect(zonedWallClock(event.responseDeadline, zone)).toBe(deadline);
    expect(zonedWallClock(event.responseDeadline, "UTC")).not.toBe(deadline);

    await expect(
      page.getByText("Top continuous windows for a 45-minute meeting."),
    ).toBeVisible();
    // The toggle flips on every click, so a retry clicks only while it is
    // still collapsed after the previous click had time to render.
    const detailsToggle = page.getByRole("button", {
      name: /^(Show all details|Hide details)$/,
    });
    await expect
      .poll(async () => {
        if ((await detailsToggle.getAttribute("aria-expanded")) === "false") {
          await detailsToggle.click();
          await expect(detailsToggle)
            .toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })
            .catch(() => {});
        }
        return detailsToggle.getAttribute("aria-expanded");
      })
      .toBe("true");
    await expect(detailsToggle).toHaveText("Hide details");
    await expect(overviewDetail(page, "Availability interval")).toHaveText(
      "15 minutes",
    );
    await expect(overviewTile(page, "Meeting")).toContainText(
      "In-Person · 45 minutes",
    );
    await expect(overviewTile(page, "Meeting")).toContainText("TBD");
    // The deadline reads 5 PM New York time whatever the host zone. The
    // expected text is formatted by the browser itself, so the engine's
    // locale and ICU spacing (a narrow no-break space before PM) match.
    const shownDeadline = await page.evaluate(
      ([value, timeZone]) =>
        new Date(value).toLocaleString([], { timeZone, timeZoneName: "short" }),
      [event.responseDeadline, zone],
    );
    expect(shownDeadline).toMatch(/(5:00:00\sPM|17:00:00)/);
    expect(shownDeadline).toMatch(/E[SD]T|GMT-[45]/);
    await expect(overviewTile(page, "Responses")).toContainText(shownDeadline);

    // The invitation carries the deadline as a calendar file whose alarm
    // follows the reminder hours.
    const startedAt = Date.now() - 1000;
    const imported = await importRoster(
      request,
      code,
      token,
      `name,email\nIvy Invitee,${ivy}`,
    );
    expect(imported.autoInvitedCount).toBe(1);
    dispatchEmailJobs();
    const invite = await latestEmailFor(
      ivy,
      startedAt,
      (body) =>
        body.includes("BEGIN:VCALENDAR") && body.includes(`code=${code}`),
    );
    expect(invite).toContain("TRIGGER:-PT6H");
    expect(invite).toContain(`releviz-${code}-availability.ics`);
    expect(invite).toContain(`DTSTART:${icsUtc(event.responseDeadline)}`);

    const invitationFor = async () => {
      const listed = await apiJson(
        request,
        "GET",
        `/events/invitations?code=${code}`,
        token,
      );
      expect(listed.response.status()).toBe(200);
      return listed.payload.invitations.find(
        (invitation) => invitation.email === ivy,
      );
    };
    await expect
      .poll(async () => (await invitationFor())?.awaitingReminder)
      .toBe(true);

    // The inline editor round-trips the advanced settings, and turning the
    // reminders off keeps the deadline and hours.
    const region = await openInlineEditor(page);
    await openAdvancedOptions(region);
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
        response.url().includes(`/events?code=${code}`),
    );
    await region.getByRole("button", { name: "Save changes" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText("Event changes saved.")).toBeVisible();

    const updated = await eventState(request, token, code);
    expect(updated.remindersEnabled).toBe(false);
    expect(updated.reminderHoursBefore).toBe(6);
    expect(Date.parse(updated.responseDeadline)).toBe(
      Date.parse(event.responseDeadline),
    );
    expect((await invitationFor()).awaitingReminder).toBe(false);

    // With reminders off, a manual reminder run reaches nobody.
    await eventControls(page)
      .getByRole("button", { name: "Queue reminders" })
      .click();
    await expect(eventControls(page)).toContainText(
      "0 reminder emails were queued.",
    );
  });

  test("reports client and server validation errors on the create form, including daylight-saving gaps", async ({
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
    const { springForward } = nextUsDstDates();

    await page.goto("/create");
    const create = page.getByRole("button", { name: "Create Event" });
    const formError = page.locator(".create-event-error");

    // 1) The name is required, and focus lands on it.
    await create.click();
    await expect(page.locator("#event-name-error")).toHaveText(
      "Event name is required",
    );
    const nameBox = page.getByRole("textbox", { name: "Event Name" });
    await expect(nameBox).toHaveAttribute("aria-invalid", "true");
    await expect(nameBox).toHaveAttribute(
      "aria-describedby",
      /event-name-error/,
    );
    await expect(nameBox).toBeFocused();
    await fillTextbox(page, "Event Name", `Validation ${runId}`);
    await expect(page.locator("#event-name-error")).toHaveCount(0);

    // 2) At least one day or one date.
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
    await typeGroup.getByRole("button", { name: "Days of Week" }).click();
    const wednesday = weekdays.getByRole("button", {
      name: "Wed",
      exact: true,
    });
    await wednesday.click();
    await expect(wednesday).toHaveAttribute("aria-pressed", "true");

    // 3) Times must align to the slots and differ.
    const startTime = page.getByLabel("Start Time");
    const endTime = page.getByLabel("End Time");
    const timeError = page.locator("#time-range-error");
    await startTime.fill("09:15");
    await create.click();
    await expect(timeError).toHaveText("Times must align to 30-minute slots");
    await expect(startTime).toHaveAttribute("aria-invalid", "true");
    await expect(startTime).toBeFocused();
    await startTime.fill("10:00");
    await endTime.fill("10:00");
    await create.click();
    await expect(timeError).toHaveText("Start and end times must be different");
    await endTime.fill("11:00");
    await expect(timeError).toHaveCount(0);

    // 4) The meeting duration must align and fit in the daily window.
    const duration = page.getByLabel("Meeting Duration");
    const durationError = page.locator("#meeting-duration-error");
    await duration.fill("45");
    await create.click();
    await expect(durationError).toHaveText(
      "Meeting duration must be 15–480 minutes and align to 30-minute slots",
    );
    await expect(duration).toHaveAttribute("aria-invalid", "true");
    await duration.fill("120");
    await create.click();
    await expect(durationError).toHaveText(
      "Meeting duration must fit within the configured daily time window",
    );
    await duration.fill("60");
    await expect(durationError).toHaveCount(0);

    // 5) A reminder error re-opens the collapsed Advanced options.
    await openAdvancedOptions(page);
    const reminderHours = page.getByLabel("Reminder Hours Before Deadline");
    await reminderHours.fill("721");
    const advanced = advancedOptions(page);
    await advanced.locator("summary").click();
    await expect(advanced).not.toHaveAttribute("open");
    await create.click();
    await expect(advanced).toHaveAttribute("open", "");
    await expect(page.locator("#reminder-hours-error")).toHaveText(
      "Reminder timing must be between 0 and 720 hours",
    );
    await expect(reminderHours).toHaveAttribute("aria-invalid", "true");
    await reminderHours.fill("24");
    await expect(page.locator("#reminder-hours-error")).toHaveCount(0);

    // 6) The server refuses a past deadline for an active event.
    await selectOption(page, "Event timezone", "UTC");
    const deadline = page.getByLabel("Response Deadline");
    await deadline.fill(datetimeLocalHoursFromNow(-48));
    await create.click();
    await expect(formError).toHaveText(
      "An active event must have a future response deadline",
    );
    await expect(page).toHaveURL(/\/create$/);

    // 7) A deadline inside the spring-forward gap never reaches the server.
    await selectOption(page, "Event timezone", "America/New_York");
    await deadline.fill(`${springForward}T02:30`);
    await create.click();
    await expect(formError).toHaveText(
      "That local time does not exist because of a daylight-saving change.",
    );

    // 8) A specific date whose window starts inside the gap is refused by
    // the server.
    await deadline.fill("");
    await expect(deadline).toHaveValue("");
    await typeGroup.getByRole("button", { name: "Specific Dates" }).click();
    await page.getByLabel("Specific event date").fill(springForward);
    await page.getByRole("button", { name: "Add date" }).click();
    await expect(
      page.getByRole("list", { name: "Selected dates" }).getByRole("listitem"),
    ).toHaveText([springForward]);
    await startTime.fill("02:00");
    await endTime.fill("04:00");
    await create.click();
    await expect(formError).toHaveText(
      `${springForward}T02:00 is a nonexistent local time in America/New_York.`,
    );

    // 9) Moving the window out of the gap creates the event.
    await startTime.fill("09:00");
    await endTime.fill("11:00");
    await create.click();
    await page.waitForURL(/\/event\?code=/);
    const code = new URL(page.url()).searchParams.get("code");
    const event = await eventState(request, token, code);
    expect(event).toMatchObject({
      name: `Validation ${runId}`,
      daySelectionType: "specific_dates",
      specificDates: [springForward],
      timezone: "America/New_York",
      startTime: "09:00",
      endTime: "11:00",
      meetingDurationMinutes: 60,
      slotCount: 4,
      responseDeadline: null,
    });
  });
});
