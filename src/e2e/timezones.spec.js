const { expect, test } = require("@playwright/test");
const {
  createEvent,
  eventState,
  expandAdvancedOptions,
  fillTextbox,
  finalizeViaApi,
  freshResults,
  latestEmailFor,
  newRunId,
  readSession,
  registerAccount,
  registerAccountViaApi,
  selectOption,
  slotIndex,
  submitResponse,
  temporaryAccessPathFromEmail,
} = require("./helpers/releviz");
const {
  cellAt,
  chooseRecommendedTime,
  detailItem,
  overviewTile,
  waitForAttendanceReview,
} = require("./helpers/workspace");
const {
  addPersonApi,
  continueToConfirm,
  invitationEmail,
  participantActions,
  reviewEmail,
  textLine,
} = require("./helpers/participants");
const {
  icsUtc,
  nextUsDstDates,
  zonedLocalDateTime,
  zonedWallClock,
} = require("./helpers/time");

// Events in America/New_York seen from browsers in Asia/Tokyo, 13 or 14
// hours ahead (a different calendar day for most of the morning): the create
// form defaults to the browser's zone, the deadline is typed as New York
// wall-clock time, and every time the organizer, a participant, a temporary
// participant and the emails see is New York's, never Tokyo's. A fall-back
// date repeats its 1:00 AM rows, told apart by their UTC offsets.
//
// Browser-formatted strings are compared with what the browser itself
// formats (ICU puts a narrow no-break space before AM/PM in newer builds),
// and each check also proves the Tokyo rendering is absent. The locale is
// pinned because toLocaleString([]) follows it.

const BROWSER_ZONE = "Asia/Tokyo";
const EVENT_ZONE = "America/New_York";
const CONTEXT_OPTIONS = {
  timezoneId: BROWSER_ZONE,
  locale: "en-US",
  reducedMotion: "reduce",
};

test.use({ timezoneId: BROWSER_ZONE, locale: "en-US" });

// The instant a zone-local "YYYY-MM-DDTHH:MM" names (an unambiguous time).
function zonedIso(localDateTime, timeZone) {
  const wallClockUtc = Date.parse(`${localDateTime}:00Z`);
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = wallClockUtc - offset * 60_000;
    if (zonedWallClock(candidate, timeZone) === localDateTime) {
      return new Date(candidate).toISOString();
    }
  }
  throw new Error(`${localDateTime} does not exist in ${timeZone}`);
}

// How the browser formats an instant in a zone (the page's own formatting
// call, so ICU spacing always matches).
function browserFormat(page, value, timeZone, options = {}) {
  return page.evaluate(
    ([instant, zone, extra]) =>
      new Date(instant).toLocaleString([], { timeZone: zone, ...extra }),
    [value, timeZone, options],
  );
}

// The Time Table's Finalize format: "Mon, Oct 5, 2026, 9:00 AM".
const FINALIZE_FORMAT = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

// An instant as the event emails spell it (email_formatting.py), e.g.
// "Thursday, October 8, 2026 at 5:00 PM EDT".
function emailParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(new Date(value));
  const part = Object.fromEntries(
    parts.map((entry) => [entry.type, entry.value]),
  );
  return {
    date: `${part.weekday}, ${part.month} ${part.day}, ${part.year}`,
    clock: `${part.hour}:${part.minute} ${part.dayPeriod}`,
    zone: part.timeZoneName,
  };
}

function emailDateTime(value, timeZone) {
  const local = emailParts(value, timeZone);
  return `${local.date} at ${local.clock} ${local.zone}`;
}

// "Monday, October 5, 2026, 9:00 AM to 10:00 AM EDT" for a same-day range.
function emailTimeRange(start, end, timeZone) {
  const from = emailParts(start, timeZone);
  const to = emailParts(end, timeZone);
  expect(from.date).toBe(to.date);
  return `${from.date}, ${from.clock} to ${to.clock} ${to.zone}`;
}

// Adds and invites a new address (a temporary identity) and opens the
// emailed link in a fresh Tokyo context; the link alone opens the schedule.
// Returns the temporary page, its context and the invitation email.
async function openTemporaryAccess(
  browser,
  request,
  token,
  event,
  email,
  name,
) {
  const invitedAt = Date.now() - 1000;
  await addPersonApi(request, event.code, token, {
    name,
    email,
    sendInvitation: true,
  });
  const invitation = await latestEmailFor(
    email,
    invitedAt,
    invitationEmail(event.code),
  );
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();
  await page.goto(temporaryAccessPathFromEmail(invitation));
  await expect(page.getByRole("heading", { name: event.name })).toBeVisible();
  await expect(page.getByText(`You are responding as ${name}`)).toBeVisible();
  return { context, page, invitation };
}

// Two managed responses make Monday 9:00-10:00 the best window.
async function seedMondayMorning(request, token, event, runId) {
  const mon9 = slotIndex(event, "weekday:1", "09:00");
  for (const who of ["nia", "ned"]) {
    await submitResponse(request, token, event, {
      name: `${who} Early`,
      email: `tz-${who}-${runId}@example.com`,
      inperson: [mon9, mon9 + 1],
    });
  }
  const results = await freshResults(request, token, event.code);
  const best = results.recommendations[0];
  expect(best.label).toBe("Mon 09:00–10:00");
  expect(zonedWallClock(best.suggestedStartsAt, EVENT_ZONE)).toMatch(/T09:00$/);
  return best;
}

test.describe("Timezones", () => {
  test("an America/New_York event created from Asia/Tokyo keeps event-local times in the organizer workspace and its emails", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const name = `Zoned ${runId}`;
    const invitee = `tz-invitee-${runId}@example.com`;
    const deadline = zonedLocalDateTime(10, "17:00", EVENT_ZONE);

    await registerAccount(page, `tz-org-${runId}@example.com`, "Tomo", "Zone");
    const { access: token } = await readSession(page);

    // The form starts in the browser's zone; the organizer switches it to
    // the event zone and types the deadline as New York wall-clock time.
    await page.goto("/create");
    await expect(
      page.getByRole("combobox", { name: "Event timezone" }),
    ).toHaveValue(BROWSER_ZONE);
    await fillTextbox(page, "Event Name", name);
    await selectOption(page, "Event timezone", EVENT_ZONE);
    await page.getByLabel("Meeting Duration").fill("60");
    await expandAdvancedOptions(page);
    await page.getByLabel("Response Deadline").fill(deadline);
    await page.getByRole("button", { name: "Create Event" }).click();
    await page.waitForURL(/\/event\?code=/);
    const code = new URL(page.url()).searchParams.get("code");
    const event = await eventState(request, token, code);
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();

    expect(event.timezone).toBe(EVENT_ZONE);
    expect(event.responseDeadline).toBeTruthy();
    expect(Date.parse(event.responseDeadline)).toBe(
      Date.parse(zonedIso(deadline, EVENT_ZONE)),
    );
    expect(zonedWallClock(event.responseDeadline, BROWSER_ZONE)).not.toBe(
      deadline,
    );

    // Overview: the window and the deadline are New York's.
    const withZone = { timeZoneName: "short" };
    const deadlineNewYork = await browserFormat(
      page,
      event.responseDeadline,
      EVENT_ZONE,
      withZone,
    );
    const deadlineTokyo = await browserFormat(
      page,
      event.responseDeadline,
      BROWSER_ZONE,
      withZone,
    );
    expect(deadlineNewYork).toMatch(/5:00:00\sPM\sE[SD]T/);
    await expect(overviewTile(page, "Schedule")).toContainText(
      `9:00 AM - 5:00 PM · ${EVENT_ZONE}`,
    );
    await expect(overviewTile(page, "Responses")).toContainText(
      deadlineNewYork,
    );
    await expect(overviewTile(page, "Responses")).not.toContainText(
      deadlineTokyo,
    );

    // The Time Table's rows are New York's 9:00 AM onwards.
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    await expect(grid.getByRole("rowheader").first()).toHaveText("9:00 AM");
    await expect(grid.getByRole("rowheader")).toHaveCount(16);
    await expect(cellAt(grid, 0, 0)).toHaveAttribute(
      "aria-label",
      /^Mon, .+, 9:00 AM – 9:30 AM\./,
    );

    // The Email menu's next automatic reminder is 24 hours before the
    // deadline, in the event zone with its zone named.
    const reminderAt = new Date(
      Date.parse(event.responseDeadline) - 24 * 3_600_000,
    ).toISOString();
    const reminderNewYork = await browserFormat(
      page,
      reminderAt,
      EVENT_ZONE,
      withZone,
    );
    const emailButton = participantActions(page).getByRole("button", {
      name: "Email",
      exact: true,
    });
    await emailButton.click();
    const emailMenu = page.getByRole("menu", { name: "Email" });
    await expect(emailMenu).toContainText(
      `Next automatic reminder: ${reminderNewYork}`,
    );
    // The trigger toggles the menu closed again.
    await emailButton.click();
    await expect(emailMenu).toHaveCount(0);

    // The invitation spells the deadline in New York time and names the
    // zone; its calendar file holds the same instant.
    const invitedAt = Date.now() - 1000;
    await addPersonApi(request, code, token, {
      name: "Ivy Invitee",
      email: invitee,
      sendInvitation: true,
    });
    const invitation = await latestEmailFor(
      invitee,
      invitedAt,
      invitationEmail(code),
    );
    expect(invitation).toContain(
      `Please respond by ${emailDateTime(event.responseDeadline, EVENT_ZONE)} (${EVENT_ZONE}).`,
    );
    expect(invitation).toContain(`DTSTART:${icsUtc(event.responseDeadline)}`);
    expect(invitation).toContain("TRIGGER:-PT24H");

    // Two responses make Monday 9:00-10:00 New York time the best window.
    const best = await seedMondayMorning(request, token, event, runId);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();

    // Other times lists its times in the event zone and says so.
    await chooseRecommendedTime(page, 0);
    const otherTimes = page.locator("details#organizer-other-times");
    await otherTimes.locator("> summary").click();
    await expect(otherTimes).toHaveAttribute("open", "");
    await expect(otherTimes.locator(".ranked-chips__intro")).toContainText(
      `Times are in ${EVENT_ZONE}.`,
    );
    await otherTimes.locator("> summary").click();
    await expect(otherTimes).not.toHaveAttribute("open", "");

    // The Finalize candidate shows the New York times and names the zone.
    const startNewYork = await browserFormat(
      page,
      best.suggestedStartsAt,
      EVENT_ZONE,
      FINALIZE_FORMAT,
    );
    const endNewYork = await browserFormat(
      page,
      best.suggestedEndsAt,
      EVENT_ZONE,
      FINALIZE_FORMAT,
    );
    const startTokyo = await browserFormat(
      page,
      best.suggestedStartsAt,
      BROWSER_ZONE,
      FINALIZE_FORMAT,
    );
    expect(startNewYork).toMatch(/^Mon, .+, 9:00\sAM$/);
    expect(endNewYork).toMatch(/10:00\sAM$/);
    const candidateTime = page.locator(".final-candidate__time");
    await expect(page.locator(".final-candidate")).toContainText(
      "Mon 09:00–10:00",
    );
    await expect(candidateTime).toContainText(
      `${startNewYork} – ${endNewYork}`,
    );
    await expect(candidateTime).toContainText(`(${EVENT_ZONE})`);
    await expect(candidateTime).not.toContainText(startTokyo);

    // The confirmation email under review spells the meeting in New York
    // time too.
    const when = emailTimeRange(
      best.suggestedStartsAt,
      best.suggestedEndsAt,
      EVENT_ZONE,
    );
    expect(when).toMatch(/, 9:00 AM to 10:00 AM E[SD]T$/);
    await waitForAttendanceReview(page);
    await page
      .locator("#organizer-finalize")
      .getByRole("button", { name: "Finalize meeting" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Finalize meeting" });
    const envelope = await reviewEmail(dialog, {
      summary: [
        "1 invited person will receive the confirmation and a calendar invitation.",
      ],
      to: invitee,
      subject: `Confirmed: ${name}`,
      attachments: `releviz-${code}-final.ics`,
      heading: "Meeting confirmed",
      text: [`When: ${when}`, `Timezone: ${EVENT_ZONE}`],
    });
    expect(textLine(envelope.text, "When: ")).toBe(`When: ${when}`);
    const send = await continueToConfirm(
      dialog,
      "Finalize and email 1 person?",
      "Finalize and send 1 email",
    );
    const finalizedAt = Date.now() - 1000;
    const finalization = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes(`/events/finalization?code=${code}`),
    );
    await send.click();
    expect((await finalization).status()).toBe(202);
    await expect(dialog).toHaveCount(0);

    // The finalized card and the Confirmed meeting tile are New York's.
    await expect(page.locator(".finalized-meeting__time")).toHaveText(
      `${startNewYork} – ${endNewYork}`,
    );
    const confirmedStart = await browserFormat(
      page,
      best.suggestedStartsAt,
      EVENT_ZONE,
    );
    const confirmedEnd = await browserFormat(
      page,
      best.suggestedEndsAt,
      EVENT_ZONE,
    );
    await expect(overviewTile(page, "Confirmed meeting")).toContainText(
      `${confirmedStart} - ${confirmedEnd}`,
    );
    const finalMeeting = (await eventState(request, token, code)).finalMeeting;
    expect(finalMeeting.timezone).toBe(EVENT_ZONE);
    expect(Date.parse(finalMeeting.startsAt)).toBe(
      Date.parse(best.suggestedStartsAt),
    );

    // The delivered confirmation says what the review showed, and its
    // calendar file names the event zone and the UTC instant.
    const confirmation = await latestEmailFor(invitee, finalizedAt, (body) =>
      body.includes("The final meeting time"),
    );
    expect(confirmation).toContain(`When: ${when}`);
    expect(confirmation).toContain(`X-WR-TIMEZONE:${EVENT_ZONE}`);
    expect(confirmation).toContain(`DTSTART:${icsUtc(finalMeeting.startsAt)}`);
  });

  test("participants in Asia/Tokyo see the event's New York times on the join panel, their grid, the temporary page and the confirmed meeting", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const { access: token } = await registerAccountViaApi(
      request,
      `tz-host-${runId}@example.com`,
      "Hana",
      "Host",
    );
    const deadline = zonedIso(
      zonedLocalDateTime(10, "17:00", EVENT_ZONE),
      EVENT_ZONE,
    );
    const event = await createEvent(request, token, {
      name: `Zoned join ${runId}`,
      timezone: EVENT_ZONE,
      accessMode: "open_link",
      responseDeadline: deadline,
      meetingDurationMinutes: 60,
    });
    const { fallBack } = nextUsDstDates();
    const fallBackEvent = await createEvent(request, token, {
      name: `Fall back join ${runId}`,
      timezone: EVENT_ZONE,
      accessMode: "open_link",
      daySelectionType: "specific_dates",
      specificDates: [fallBack],
      days: [],
      startTime: "00:00",
      endTime: "03:00",
      meetingDurationMinutes: 60,
    });

    await registerAccount(page, `tz-pat-${runId}@example.com`, "Pat", "Zone");
    const withZone = { timeZoneName: "short" };
    const deadlineNewYork = await browserFormat(
      page,
      deadline,
      EVENT_ZONE,
      withZone,
    );
    expect(deadlineNewYork).toMatch(/5:00:00\sPM\sE[SD]T/);

    // The join panel's details are the event's.
    await page.goto(`/event?code=${event.code}`);
    await expect(
      page.getByRole("heading", { name: "Join Event" }),
    ).toBeVisible();
    await expect(detailItem(page, "Timezone")).toHaveText(EVENT_ZONE);
    await expect(detailItem(page, "Availability window")).toHaveText(
      "9:00 AM - 5:00 PM",
    );
    await expect(detailItem(page, "Response Deadline")).toHaveText(
      deadlineNewYork,
    );

    // Joined, the editor says which zone its grid uses, and its rows and
    // cells are New York's.
    await page.getByRole("button", { name: "Join as Pat Zone" }).click();
    await expect(page.getByText("Welcome, Pat Zone")).toBeVisible();
    await expect(page.getByText(`Times shown in ${EVENT_ZONE}`)).toBeVisible();
    const grid = page.getByRole("grid", { name: "Availability" });
    await expect(grid.getByRole("rowheader").first()).toHaveText("9:00 AM");
    await expect(grid.locator('[data-cell-idx="0"]')).toHaveAttribute(
      "aria-label",
      "Mon, 9:00 AM – 9:30 AM, availability 1",
    );

    // On a fall-back date the 1:00 AM rows repeat, told apart by offset.
    await page.goto(`/event?code=${fallBackEvent.code}`);
    await page.getByRole("button", { name: "Join as Pat Zone" }).click();
    await expect(page.getByText(`Times shown in ${EVENT_ZONE}`)).toBeVisible();
    const dstGrid = page.getByRole("grid", { name: "Availability" });
    await expect(dstGrid.getByRole("rowheader")).toHaveText([
      "12:00 AM",
      "12:30 AM",
      "1:00 AM",
      "1:30 AM",
      "1:00 AM",
      "1:30 AM",
      "2:00 AM",
      "2:30 AM",
    ]);
    await expect(dstGrid.locator('[data-cell-idx="2"]')).toHaveAttribute(
      "aria-label",
      `${fallBack}, 1:00 AM -04:00 – 1:30 AM -04:00, availability 1`,
    );
    await expect(dstGrid.locator('[data-cell-idx="4"]')).toHaveAttribute(
      "aria-label",
      `${fallBack}, 1:00 AM -05:00 – 1:30 AM -05:00, availability 1`,
    );

    // A temporary participant's page shows the same event-zone facts.
    const temporary = await openTemporaryAccess(
      browser,
      request,
      token,
      event,
      `tz-temp-${runId}@example.com`,
      "Tia Temporary",
    );
    try {
      const tempPage = temporary.page;
      await expect(detailItem(tempPage, "Timezone")).toHaveText(EVENT_ZONE);
      await expect(detailItem(tempPage, "Response Deadline")).toHaveText(
        deadlineNewYork,
      );
      await expect(
        tempPage.getByText(`Times shown in ${EVENT_ZONE}`),
      ).toBeVisible();
      const tempGrid = tempPage.getByRole("grid", { name: "Availability" });
      await expect(tempGrid.getByRole("rowheader").first()).toHaveText(
        "9:00 AM",
      );
      await expect(tempGrid.locator('[data-cell-idx="0"]')).toHaveAttribute(
        "aria-label",
        "Mon, 9:00 AM – 9:30 AM, availability 1",
      );

      // Once the meeting is confirmed, both show its New York times.
      const best = await seedMondayMorning(request, token, event, runId);
      await finalizeViaApi(request, token, event.code, best);
      const finalStart = await browserFormat(
        page,
        best.suggestedStartsAt,
        EVENT_ZONE,
      );
      const finalEnd = await browserFormat(
        page,
        best.suggestedEndsAt,
        EVENT_ZONE,
      );
      const finalStartTokyo = await browserFormat(
        page,
        best.suggestedStartsAt,
        BROWSER_ZONE,
      );
      expect(finalStart).toMatch(/9:00:00\sAM$/);
      expect(finalStartTokyo).not.toBe(finalStart);

      await page.goto(`/event?code=${event.code}`);
      const confirmed = page.locator("dl[aria-label='Confirmed meeting']");
      const confirmedItem = (label) =>
        confirmed
          .locator(".detail-list__item")
          .filter({ has: page.locator("dt", { hasText: label }) })
          .locator("dd");
      await expect(confirmedItem("Final Start")).toHaveText(finalStart);
      await expect(confirmedItem("Final End")).toHaveText(finalEnd);

      await tempPage.reload();
      await expect(detailItem(tempPage, "Final Start")).toHaveText(finalStart);
      await expect(detailItem(tempPage, "Final End")).toHaveText(finalEnd);
    } finally {
      await temporary.context.close();
    }
  });

  test("the organizer's Time Table repeats 1:00 AM on a New York fall-back date, labelled by UTC offset", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(page, `tz-dst-${runId}@example.com`, "Dee", "Est");
    const { access: token } = await readSession(page);
    const { fallBack } = nextUsDstDates();
    const event = await createEvent(request, token, {
      name: `Fall back ${runId}`,
      timezone: EVENT_ZONE,
      daySelectionType: "specific_dates",
      specificDates: [fallBack],
      days: [],
      startTime: "00:00",
      endTime: "03:00",
      meetingDurationMinutes: 60,
    });
    // 00:00-03:00 holds four elapsed hours: 1:00 and 1:30 happen once in
    // EDT and again in EST.
    expect(event.slotCount).toBe(8);
    const slots = event.slotGroups[0].slots;
    expect(slots.map((slot) => slot.localStart)).toEqual([
      "00:00",
      "00:30",
      "01:00",
      "01:30",
      "01:00",
      "01:30",
      "02:00",
      "02:30",
    ]);
    expect(slots.map((slot) => slot.startOffset)).toEqual([
      "-04:00",
      "-04:00",
      "-04:00",
      "-04:00",
      "-05:00",
      "-05:00",
      "-05:00",
      "-05:00",
    ]);

    await page.goto(`/event?code=${event.code}`);
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    await expect(grid.getByRole("rowheader")).toHaveText([
      "12:00 AM",
      "12:30 AM",
      "1:00 AM",
      "1:30 AM",
      "1:00 AM",
      "1:30 AM",
      "2:00 AM",
      "2:30 AM",
    ]);
    await expect(cellAt(grid, 2, 0)).toHaveAttribute(
      "aria-label",
      /1:00 AM – 1:30 AM \(UTC-04:00\)/,
    );
    await expect(cellAt(grid, 4, 0)).toHaveAttribute(
      "aria-label",
      /1:00 AM – 1:30 AM \(UTC-05:00\)/,
    );
  });
});
