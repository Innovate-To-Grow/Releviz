const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  apiJson,
  openRankedWindows,
  readSession,
  recomputeEventResults,
  registerAccount,
} = require("./helpers/releviz");

// The organizer's meeting-time calendar: weighted shading, week and date
// paging, picking any slot-aligned window by pointer or keyboard, ranked
// windows drawn on the grid, and finalizing a custom window. Events and
// responses are seeded through the API so the assertions are deterministic;
// the browser only drives what the calendar itself does.

const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_HEADER = 1; // every calendar row starts with its time label

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Sunday-based weeks, matching the API's weekday numbering (Sun = 0).
function weekStartMs(now = Date.now()) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime() - day.getUTCDay() * DAY_MS;
}

function shortDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function cellAt(grid, row, column) {
  return grid
    .getByRole("row")
    .nth(row + ROW_HEADER)
    .getByRole("gridcell")
    .nth(column);
}

async function gotoWeekWith(page, grid, date) {
  const dayHeader = grid.getByRole("columnheader", {
    name: shortDate(date),
  });
  await page.getByRole("button", { name: "This week" }).click();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await dayHeader.count()) return;
    await page.getByRole("button", { name: "Next week" }).click();
  }
  throw new Error(`The calendar never reached the week of ${date}.`);
}

async function createEvent(request, token, overrides) {
  const created = await apiJson(request, "POST", "/events", token, {
    startTime: "09:00",
    endTime: "17:00",
    slotMinutes: 30,
    days: [1, 2, 3, 4, 5],
    mode: "inperson",
    location: "Calendar Room",
    participantViewPermission: "realtime",
    daySelectionType: "days_of_week",
    specificDates: [],
    responseDeadline: new Date(Date.now() + 5 * DAY_MS).toISOString(),
    timezone: "UTC",
    remindersEnabled: false,
    reminderHoursBefore: 24,
    accessMode: "invite_only",
    meetingDurationMinutes: 60,
    status: "active",
    ...overrides,
  });
  expect(created.response.status()).toBe(201);
  const definition = await apiJson(
    request,
    "GET",
    `/events?code=${created.payload.event.code}`,
    token,
  );
  expect(definition.response.status()).toBe(200);
  return definition.payload.event;
}

// Adds a managed participant and submits the given availability. `inperson`
// and `virtual` list the slot indices the person is free for.
async function submitResponse(
  request,
  token,
  event,
  { name, email, inperson = [], virtual = [], weight = null },
) {
  const created = await apiJson(
    request,
    "POST",
    `/events/participants/managed?code=${event.code}`,
    token,
    { name, email, idempotencyKey: crypto.randomUUID() },
  );
  expect(created.response.status()).toBe(201);
  const participant = created.payload.participant;
  const schedule = await apiJson(
    request,
    "GET",
    `/events/roster/${participant.id}/schedule?code=${event.code}`,
    token,
  );
  expect(schedule.response.status()).toBe(200);
  const version =
    schedule.payload.schedule?.version ?? schedule.payload.participant?.version;
  const toArray = (indices) =>
    Array.from({ length: event.slotCount }, (_, index) =>
      indices.includes(index) ? 1 : 0,
    );
  const updated = await apiJson(
    request,
    "PUT",
    `/events/participants/update?code=${event.code}&participantId=${participant.id}`,
    token,
    {
      availabilityInperson: toArray(inperson),
      availabilityVirtual: toArray(virtual),
      submitted: 1,
      expectedVersion: version,
    },
  );
  expect(updated.response.status()).toBe(200);
  if (weight !== null) {
    const roster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${event.code}&search=${encodeURIComponent(email)}&pageSize=5`,
      token,
    );
    const row = roster.payload.participants.find(
      (entry) => entry.email === email,
    );
    expect(row).toBeTruthy();
    const patched = await apiJson(
      request,
      "PATCH",
      `/events/roster/${row.id}?code=${event.code}`,
      token,
      { weight, expectedVersion: row.version },
    );
    expect(patched.response.status()).toBe(200);
  }
  return participant;
}

function slotIndex(event, groupKey, localStart) {
  const group = event.slotGroups.find((entry) => entry.key === groupKey);
  const slot = group?.slots.find((entry) => entry.localStart === localStart);
  if (!slot) throw new Error(`No slot ${groupKey} ${localStart}`);
  return slot.index;
}

// Clicks a calendar cell and waits for the Finalize card to show the pick.
// The grid re-renders around week navigation and selection, and WebKit has
// dropped a click that landed mid-render, so the click is retried until the
// card reflects it (re-picking the same cell is idempotent).
async function pickCell(cell, candidate, expectedText) {
  await expect(async () => {
    await cell.click();
    await expect(candidate).toContainText(expectedText, { timeout: 2000 });
  }).toPass({ timeout: 20000 });
}

async function finalizeCurrentSelection(page, eventCode) {
  await page.getByRole("button", { name: "Review attendance" }).click();
  await expect(
    page.getByText("Attendance review is current for this candidate."),
  ).toBeVisible();
  const finalization = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes(`/events/finalization?code=${eventCode}`),
  );
  await page.getByRole("button", { name: "Finalize meeting" }).click();
  expect((await finalization).status()).toBe(202);
  await expect(
    page.getByText(
      "The meeting is finalized and calendar invitations are queued.",
    ),
  ).toBeVisible();
}

test.describe("Organizer meeting-time calendar", () => {
  test("shades, navigates, picks and finalizes windows on a weekly event", async ({
    browser,
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    const organizerEmail = `calendar-organizer-${runId}@example.com`;
    await registerAccount(page, organizerEmail, "Cal", "Organizer");
    const session = await readSession(page);
    const token = session.access;

    const event = await createEvent(request, token, {
      name: `Calendar weekly ${runId}`,
    });
    expect(event.slotCount).toBe(80);
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    const tue11 = slotIndex(event, "weekday:2", "11:00");
    const wed14 = slotIndex(event, "weekday:3", "14:00");
    const thu9 = slotIndex(event, "weekday:4", "09:00");
    const people = [
      {
        name: "Ada",
        inperson: [
          mon10,
          mon10 + 1,
          tue11,
          tue11 + 1,
          wed14,
          wed14 + 1,
          thu9,
          thu9 + 1,
        ],
      },
      {
        name: "Ben",
        inperson: [mon10, mon10 + 1, tue11, tue11 + 1, wed14, wed14 + 1],
      },
      { name: "Cara", inperson: [mon10, mon10 + 1, tue11, tue11 + 1] },
      {
        name: "Dev",
        inperson: [mon10, mon10 + 1, thu9, thu9 + 1],
        weight: 0.5,
      },
    ];
    for (const person of people) {
      await submitResponse(request, token, event, {
        ...person,
        email: `${person.name.toLowerCase()}-${runId}@example.com`,
      });
    }
    recomputeEventResults(event.code);
    const results = await apiJson(
      request,
      "GET",
      `/events/results?code=${event.code}`,
      token,
    );
    expect(results.response.status()).toBe(200);
    const best = results.payload.results.recommendations[0];
    expect(best.label).toBe("Mon 10:00–11:00");
    expect(best.slotIndices).toEqual([mon10, mon10 + 1]);

    await page.goto(`/event?code=${event.code}`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    await expect(
      page.getByText(/Results are current at revision/),
    ).toBeVisible();
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    await expect(grid).toBeVisible();
    await expect(grid.getByRole("columnheader")).toHaveCount(6);
    await expect(grid.getByRole("columnheader").nth(1)).toContainText("Mon");
    await expect(grid.getByRole("columnheader").nth(5)).toContainText("Fri");
    const rail = page.getByRole("complementary", { name: "Ranked windows" });
    // The list starts collapsed with a one-line summary of the best window.
    await expect(rail.locator("details")).not.toHaveAttribute("open", "");
    await expect(rail).toContainText(/\d+ candidates · best /);
    await expect(
      rail.getByRole("button", { name: "Choose this time" }).first(),
    ).toBeHidden();
    await openRankedWindows(page);
    await expect(
      rail.getByRole("button", { name: "Choose this time" }).first(),
    ).toBeVisible();
    expect(
      await rail.getByRole("button", { name: "Choose this time" }).count(),
    ).toBeGreaterThanOrEqual(3);
    await expect(rail.locator(".result-option__rank").first()).toHaveText("#1");
    await expect(rail.getByText("Best match")).toBeVisible();
    await expectAccessible(page, "organizer results calendar");

    // Shading: the same cell reports both figures; the toggle changes the
    // value drawn in the cell.
    await page.getByRole("button", { name: "This week" }).click();
    await page.getByRole("button", { name: "Next week" }).click();
    const thisWeek = weekStartMs();
    const nextWeek = thisWeek + 7 * DAY_MS;
    const nextMonday = isoDate(nextWeek + 1 * DAY_MS);
    // Ranked windows resolve to their next occurrence, which is always within
    // the coming seven days, so a pick two weeks out is a custom window on
    // any day of the week the suite happens to run.
    const weekAfterNext = thisWeek + 14 * DAY_MS;
    const customMonday = isoDate(weekAfterNext + 1 * DAY_MS);
    const customWednesday = isoDate(weekAfterNext + 3 * DAY_MS);
    await expect(
      grid.getByRole("columnheader", { name: shortDate(nextMonday) }),
    ).toBeVisible();
    const monday10 = cellAt(grid, 2, 0);
    await expect(monday10).toHaveAttribute(
      "aria-label",
      /Weighted 100%, unweighted 100% of 4 responses/,
    );
    await expect(monday10).toHaveAttribute(
      "aria-label",
      /Inside ranked window #1/,
    );
    const thursday9 = cellAt(grid, 0, 3);
    await expect(thursday9).toHaveAttribute(
      "aria-label",
      /Weighted 43%, unweighted 50% of 4 responses/,
    );
    await expect(thursday9.locator(".meeting-calendar__cell-value")).toHaveText(
      "43%",
    );
    const weightedButton = page.getByRole("button", {
      name: "Weighted",
      exact: true,
    });
    const unweightedButton = page.getByRole("button", { name: "Unweighted" });
    await expect(weightedButton).toHaveAttribute("aria-pressed", "true");
    await unweightedButton.click();
    await expect(unweightedButton).toHaveAttribute("aria-pressed", "true");
    await expect(weightedButton).toHaveAttribute("aria-pressed", "false");
    await expect(thursday9.locator(".meeting-calendar__cell-value")).toHaveText(
      "50%",
    );
    await expect(
      page.getByText("0% → 100% of responses free (unweighted)"),
    ).toBeVisible();
    await weightedButton.click();
    await expect(thursday9.locator(".meeting-calendar__cell-value")).toHaveText(
      "43%",
    );

    // Ranked windows repeat every week and stay drawn wherever they can
    // still be picked.
    const rankBadges = page.locator(
      ".meeting-calendar__block--rank .meeting-calendar__rank",
    );
    await expect(rankBadges.first()).toHaveText("#1");
    await page.getByRole("button", { name: "Next week" }).click();
    await expect(
      grid.getByRole("columnheader", {
        name: shortDate(isoDate(nextWeek + 8 * DAY_MS)),
      }),
    ).toBeVisible();
    await expect(rankBadges.first()).toHaveText("#1");
    await page.getByRole("button", { name: "Previous week" }).click();
    await gotoWeekWith(page, grid, customWednesday);

    // Pointer pick: Wednesday 14:00 starts a 60-minute custom window.
    const wednesday14 = cellAt(grid, 10, 2);
    await expect(wednesday14).toHaveAttribute("data-state", "startable");
    const candidate = page.locator(".final-candidate");
    await pickCell(wednesday14, candidate, "Wed 14:00–15:00");
    await expect(page.getByRole("heading", { name: "Finalize" })).toBeFocused();
    await expect(candidate).toContainText("Custom window");
    await expect(candidate).toContainText(
      "At least 57% weighted · 50% unweighted across this window (lowest slot).",
    );
    await expect(wednesday14).toHaveAttribute("aria-selected", "true");
    await expect(cellAt(grid, 11, 2)).toHaveAttribute("aria-selected", "true");
    await expect(cellAt(grid, 12, 2)).not.toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.locator(".meeting-calendar__block--selected"),
    ).toBeVisible();

    // Keyboard pick: two rows down, Enter selects 15:00–16:00. The last row
    // cannot start a 60-minute window and stays inert.
    await wednesday14.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(cellAt(grid, 12, 2)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(candidate).toContainText("Wed 15:00–16:00");
    // A pick hands focus to the Finalize heading; come back to the grid.
    await cellAt(grid, 12, 2).focus();
    await page.keyboard.press("End");
    await expect(cellAt(grid, 12, 4)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(cellAt(grid, 12, 0)).toBeFocused();
    const lastRow = cellAt(grid, 15, 2);
    await expect(lastRow).toHaveAttribute("data-state", "tail");
    await expect(lastRow).toHaveAttribute("aria-disabled", "true");
    await lastRow.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press(" ");
    await expect(candidate).toContainText("Wed 15:00–16:00");
    await cellAt(grid, 12, 0).focus();
    await page.keyboard.press("PageDown");
    await expect(
      grid.getByRole("columnheader", {
        name: shortDate(isoDate(weekAfterNext + 8 * DAY_MS)),
      }),
    ).toBeVisible();
    await page.keyboard.press("PageUp");
    await expect(
      grid.getByRole("columnheader", { name: shortDate(customMonday) }),
    ).toBeVisible();

    // Choosing a ranked window from the rail reveals it on the calendar, and
    // clicking the first cell of a ranked window yields that exact result.
    const secondChoice = rail
      .getByRole("button", { name: "Choose this time" })
      .nth(1);
    await secondChoice.click();
    await expect(
      rail.getByRole("button", { name: "Selected time" }),
    ).toHaveCount(1);
    await expect(candidate).toContainText("Ranked #2");
    await expect(candidate).toContainText("Tue 11:00–12:00");
    await expect(candidate).toContainText(
      "86% weighted · 75% unweighted · 3 fully available",
    );
    await expect(grid.locator('[aria-selected="true"]')).toHaveCount(2);
    const bestDate = best.suggestedStartsAt.slice(0, 10);
    await gotoWeekWith(page, grid, bestDate);
    const bestCell = cellAt(grid, 2, 0);
    await expect(bestCell).toHaveAttribute(
      "aria-label",
      /Inside ranked window #1/,
    );
    await pickCell(bestCell, candidate, "Ranked #1");
    await expect(candidate).toContainText("Mon 10:00–11:00");
    await expect(candidate).toContainText(
      "100% weighted · 100% unweighted · 4 fully available",
    );
    await expect(rail.locator(".result-option").first()).toContainText(
      "Selected time",
    );

    // Finalize a custom window and confirm the API stored the cell's instant.
    await gotoWeekWith(page, grid, customWednesday);
    await pickCell(cellAt(grid, 10, 2), candidate, "Custom window");
    await finalizeCurrentSelection(page, event.code);
    const finalized = await apiJson(
      request,
      "GET",
      `/events?code=${event.code}`,
      token,
    );
    expect(finalized.payload.event.status).toBe("finalized");
    expect(finalized.payload.event.finalMeeting).toEqual(
      expect.objectContaining({
        startsAt: `${customWednesday}T14:00:00+00:00`,
        endsAt: `${customWednesday}T15:00:00+00:00`,
        channel: "inperson",
      }),
    );
    await expect(
      page.getByRole("button", { name: "Download calendar (.ics)" }),
    ).toBeVisible();
    await expect(page.locator(".meeting-calendar")).toHaveClass(
      /meeting-calendar--finalized/,
    );
    await expect(
      page.locator(".meeting-calendar__block--confirmed"),
    ).toBeVisible();
    await expect(
      grid.getByRole("columnheader", { name: shortDate(customWednesday) }),
    ).toBeVisible();
    await expect(cellAt(grid, 10, 2)).toHaveAttribute(
      "aria-label",
      /Inside the confirmed meeting/,
    );

    // A phone-sized viewport scrolls the calendar, not the page.
    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 740 },
      hasTouch: true,
      storageState: await page.context().storageState(),
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`/event?code=${event.code}`);
    const mobileGrid = mobilePage.getByRole("grid", {
      name: /^Meeting time calendar, /,
    });
    await expect(mobileGrid).toBeVisible();
    const overflow = await mobilePage.evaluate(() => ({
      page:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      calendar: (() => {
        const scroller = document.querySelector(".meeting-calendar__scroll");
        return scroller ? scroller.scrollWidth > scroller.clientWidth : null;
      })(),
    }));
    expect(overflow.page).toBe(false);
    expect(overflow.calendar).toBe(true);
    await expectAccessible(mobilePage, "organizer results calendar at 375px");
    await mobileContext.close();
  });

  test("switches channels and pages through specific dates on a hybrid event", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    await registerAccount(
      page,
      `calendar-hybrid-${runId}@example.com`,
      "Hy",
      "Brid",
    );
    const token = (await readSession(page)).access;
    const dates = Array.from({ length: 9 }, (_, offset) =>
      isoDate(Date.now() + (7 + offset) * DAY_MS),
    );
    const event = await createEvent(request, token, {
      name: `Calendar hybrid ${runId}`,
      mode: "mixed",
      location: "Studio B / video call",
      daySelectionType: "specific_dates",
      specificDates: dates,
      startTime: "09:00",
      endTime: "12:00",
    });
    expect(event.slotGroups).toHaveLength(9);
    expect(event.slotCount).toBe(54);
    const day = (offset, localStart) =>
      slotIndex(event, `date:${dates[offset]}`, localStart);
    const people = [
      {
        name: "Ines",
        inperson: [day(0, "09:00"), day(0, "09:30")],
        virtual: [day(8, "10:00"), day(8, "10:30")],
      },
      {
        name: "Jon",
        inperson: [day(0, "09:00"), day(0, "09:30")],
        virtual: [day(8, "10:00"), day(8, "10:30")],
      },
      {
        name: "Kim",
        inperson: [day(0, "09:00"), day(0, "09:30")],
        virtual: [day(7, "09:00"), day(7, "09:30")],
      },
    ];
    for (const person of people) {
      await submitResponse(request, token, event, {
        ...person,
        email: `${person.name.toLowerCase()}-${runId}@example.com`,
      });
    }
    recomputeEventResults(event.code);

    await page.goto(`/event?code=${event.code}`);
    await expect(
      page.getByText(/Results are current at revision/),
    ).toBeVisible();
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    await expect(grid).toBeVisible();
    await expect(
      page.getByText("Dates 1–7 of 9", { exact: false }),
    ).toBeVisible();
    await expect(grid.getByRole("columnheader")).toHaveCount(8);
    const rail = page.getByRole("complementary", { name: "Ranked windows" });
    await openRankedWindows(page);
    const channelGroup = page.getByRole("group", { name: "Meeting channel" });
    const inPerson = channelGroup.getByRole("button", { name: "In person" });
    const virtual = channelGroup.getByRole("button", { name: "Virtual" });
    await expect(inPerson).toHaveAttribute("aria-pressed", "true");
    await expect(rail.locator(".result-option__title").first()).toHaveText(
      `${dates[0]} 09:00–10:00`,
    );
    await expect(cellAt(grid, 0, 0)).toHaveAttribute(
      "aria-label",
      /Weighted 100%, unweighted 100% of 3 responses/,
    );

    await virtual.click();
    await expect(virtual).toHaveAttribute("aria-pressed", "true");
    // The rail keeps every ranked window; the calendar re-shades for the
    // chosen channel.
    const virtualBest = rail
      .locator(".result-option")
      .filter({ hasText: `${dates[8]} 10:00–11:00` });
    await expect(virtualBest).toContainText("Virtual");
    await expect(virtualBest).toContainText("#2");
    // Until the organizer pages by hand, the calendar opens on the page that
    // holds the channel's best window.
    await expect(
      page.getByText("Dates 8–9 of 9", { exact: false }),
    ).toBeVisible();
    await expect(grid.getByRole("columnheader")).toHaveCount(3);
    await expect(cellAt(grid, 0, 0)).toHaveAttribute(
      "aria-label",
      /Weighted 33%, unweighted 33% of 3 responses.*Inside ranked window #3/,
    );
    await page.getByRole("button", { name: "Previous dates" }).click();
    await expect(
      page.getByText("Dates 1–7 of 9", { exact: false }),
    ).toBeVisible();
    await expect(cellAt(grid, 0, 0)).toHaveAttribute(
      "aria-label",
      /Weighted 0%, unweighted 0% of 3 responses/,
    );
    await expect(
      page.getByRole("button", { name: "Previous dates" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Next dates" }).click();
    await expect(
      page.getByText("Dates 8–9 of 9", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Next dates" }),
    ).toBeDisabled();
    const lastDay10 = cellAt(grid, 2, 1);
    await expect(lastDay10).toHaveAttribute(
      "aria-label",
      /Weighted 67%, unweighted 67% of 3 responses.*Inside ranked window #2/,
    );
    await lastDay10.click();
    const candidate = page.locator(".final-candidate");
    await expect(candidate).toContainText("Ranked #2");
    await expect(candidate).toContainText("Virtual");
    await expect(
      rail.getByRole("button", { name: "Selected time" }),
    ).toHaveCount(1);

    // A custom virtual window on the second page keeps the slot's own
    // instants, so finalization stores exactly what the API defined.
    const customCell = cellAt(grid, 3, 0);
    await customCell.click();
    await expect(candidate).toContainText("Custom window");
    const expectedSlot = event.slotGroups[7].slots[3];
    const expectedEnd = event.slotGroups[7].slots[4];
    await finalizeCurrentSelection(page, event.code);
    const finalized = await apiJson(
      request,
      "GET",
      `/events?code=${event.code}`,
      token,
    );
    expect(finalized.payload.event.finalMeeting).toEqual(
      expect.objectContaining({
        startsAt: expectedSlot.startsAt,
        endsAt: expectedEnd.endsAt,
        channel: "virtual",
      }),
    );
    await expect(
      page.getByRole("button", { name: "Previous dates" }),
    ).toBeEnabled();
    await expect(
      page.locator(".meeting-calendar__block--confirmed"),
    ).toBeVisible();
  });
});
