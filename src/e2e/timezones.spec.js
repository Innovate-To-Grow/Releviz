const fs = require("node:fs/promises");
const { expect, test } = require("@playwright/test");
const {
  createEvent,
  eventState,
  expandAdvancedOptions,
  fillTextbox,
  freshResults,
  newAccountContext,
  newRunId,
  readSession,
  registerAccount,
  selectOption,
  slotIndex,
  submitResponse,
} = require("./helpers/releviz");
const {
  cellAt,
  chooseRankedWindow,
  detailItem,
  finalizeCurrentSelection,
  overviewTile,
} = require("./helpers/workspace");
const {
  icsUtc,
  nextUsDstDates,
  zonedLocalDateTime,
  zonedWallClock,
} = require("./helpers/time");

// An event in America/New_York seen from browsers in Asia/Tokyo: the create
// form defaults to the browser zone, the deadline is converted in the event
// zone, every grid and summary shows event-local wall-clock times, the
// finalized meeting is the server's recommended instant, and the calendar
// file names the event zone. A fall-back date repeats its 1:00 AM rows.
//
// Browser-formatted strings are matched with `\s` (newer ICU puts U+202F
// before AM/PM) and `E[SD]T` (the 10-day horizon may cross a DST switch).
// The locale is pinned because toLocaleString([]) follows it.

const BROWSER_ZONE = "Asia/Tokyo";
const EVENT_ZONE = "America/New_York";

test.use({ timezoneId: BROWSER_ZONE, locale: "en-US" });

function weekdayIn(value, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(new Date(value));
}

test.describe("Timezones", () => {
  test("an America/New_York event viewed from Asia/Tokyo keeps event-local labels, deadlines and final instants, and DST fall-back repeats 1:00 AM", async ({
    browser,
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const runId = newRunId();
    const deadline = zonedLocalDateTime(10, "17:00", EVENT_ZONE);

    await registerAccount(page, `tz-org-${runId}@example.com`, "Tomo", "Zone");
    const { access: token } = await readSession(page);
    const participant = await newAccountContext(
      browser,
      `tz-pat-${runId}@example.com`,
      "Pat",
      "Zone",
      { timezoneId: BROWSER_ZONE, locale: "en-US" },
    );
    const ppage = participant.page;

    try {
      // The create form starts in the browser's zone; the organizer switches
      // it to the event zone and enters the deadline as New York wall time.
      await page.goto("/create");
      await expect(
        page.getByRole("combobox", { name: "Event timezone" }),
      ).toHaveValue(BROWSER_ZONE);
      await fillTextbox(page, "Event Name", `Zoned ${runId}`);
      await selectOption(page, "Event timezone", EVENT_ZONE);
      await page.getByLabel("Meeting Duration").fill("60");
      await selectOption(
        page,
        "Event Access",
        "Anyone with the event code",
        "open_link",
      );
      await expandAdvancedOptions(page);
      await page.getByLabel("Response Deadline").fill(deadline);
      await page.getByRole("button", { name: "Create Event" }).click();
      await page.waitForURL(/\/event\?code=/);
      const code = new URL(page.url()).searchParams.get("code");
      let event = await eventState(request, token, code);

      expect(event.timezone).toBe(EVENT_ZONE);
      expect(zonedWallClock(event.responseDeadline, EVENT_ZONE)).toBe(deadline);
      expect(zonedWallClock(event.responseDeadline, BROWSER_ZONE)).not.toBe(
        deadline,
      );
      await expect(overviewTile(page, "Schedule")).toContainText(
        `9:00 AM - 5:00 PM · ${EVENT_ZONE}`,
      );
      await expect(overviewTile(page, "Responses")).toContainText(
        /5:00:00\sPM\sE[SD]T/,
      );

      // The participant's join panel and grid use the event zone too.
      await ppage.goto(`/event?code=${code}`);
      await expect(
        ppage.getByRole("heading", { name: "Join Event" }),
      ).toBeVisible();
      // detailItem needs a Locator scope (it calls scope.page()).
      const joinPanel = ppage.locator("body");
      await expect(detailItem(joinPanel, "Timezone")).toHaveText(EVENT_ZONE);
      await expect(detailItem(joinPanel, "Response Deadline")).toHaveText(
        /5:00:00\sPM\sE[SD]T/,
      );
      await ppage.getByRole("button", { name: "Join as Pat Zone" }).click();
      await expect(
        ppage.getByText(`Times shown in ${EVENT_ZONE}`),
      ).toBeVisible();
      const participantGrid = ppage.getByRole("grid", { name: "Availability" });
      await expect(participantGrid.getByRole("rowheader").first()).toHaveText(
        "9:00 AM",
      );
      await expect(
        participantGrid.locator('[data-cell-idx="0"]'),
      ).toHaveAttribute("aria-label", "Mon, 9:00 AM – 9:30 AM, availability 1");

      // Two managed responses make Monday 9:00-10:00 the top window, whose
      // instant the server computes in the event zone.
      const mon9 = slotIndex(event, "weekday:1", "09:00");
      for (const [name, last] of [
        ["Nia", "Early"],
        ["Ned", "Early"],
      ]) {
        await submitResponse(request, token, event, {
          name: `${name} ${last}`,
          email: `tz-${name.toLowerCase()}-${runId}@example.com`,
          inperson: [mon9, mon9 + 1],
        });
      }
      const results = await freshResults(request, token, code);
      const recommendation = results.recommendations[0];
      expect(recommendation.label).toBe("Mon 09:00–10:00");
      expect(
        zonedWallClock(recommendation.suggestedStartsAt, EVENT_ZONE),
      ).toMatch(/T09:00$/);
      expect(weekdayIn(recommendation.suggestedStartsAt, EVENT_ZONE)).toBe(
        "Mon",
      );

      // The organizer (also in Tokyo) sees the candidate in New York time.
      await page.goto(`/event?code=${code}`);
      await chooseRankedWindow(page, 0);
      const candidate = page.locator(".final-candidate");
      await expect(candidate).toContainText("Mon 09:00–10:00");
      await expect(page.locator(".final-candidate__time")).toContainText(
        `(${EVENT_ZONE})`,
      );
      await expect(page.locator(".final-candidate__time")).toContainText(
        /9:00\sAM\s–\s.*10:00\sAM/,
      );
      await finalizeCurrentSelection(page, code);
      await expect(page.locator(".finalized-meeting__time")).toContainText(
        /9:00\sAM\s–\s.*10:00\sAM/,
      );
      await expect(overviewTile(page, "Confirmed meeting")).toContainText(
        /9:00:00\sAM\s-\s.*10:00:00\sAM/,
      );
      event = await eventState(request, token, code);
      const finalMeeting = event.finalMeeting;
      expect(finalMeeting.timezone).toBe(EVENT_ZONE);
      expect(Date.parse(finalMeeting.startsAt)).toBe(
        Date.parse(recommendation.suggestedStartsAt),
      );

      // The participant's confirmed-meeting cards are event-local as well.
      await ppage.reload();
      const confirmed = ppage.locator("dl[aria-label='Confirmed meeting']");
      await expect(
        confirmed
          .locator(".detail-list__item")
          .filter({ hasText: "Final Start" }),
      ).toContainText(/9:00:00\sAM/);

      // The downloaded calendar names the event zone and the UTC instant.
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download calendar (.ics)" })
        .click();
      const ics = await fs.readFile(await (await download).path(), "utf8");
      expect(ics).toContain(`X-WR-TIMEZONE:${EVENT_ZONE}`);
      expect(ics).toContain(`DTSTART:${icsUtc(finalMeeting.startsAt)}`);

      // A fall-back date keeps elapsed time: 00:00-03:00 holds four hours,
      // with 1:00 and 1:30 once in EDT and again in EST.
      const { fallBack } = nextUsDstDates();
      const dstEvent = await createEvent(request, token, {
        name: `Fall back ${runId}`,
        timezone: EVENT_ZONE,
        daySelectionType: "specific_dates",
        specificDates: [fallBack],
        days: [],
        startTime: "00:00",
        endTime: "03:00",
        meetingDurationMinutes: 60,
      });
      expect(dstEvent.slotCount).toBe(8);
      const dstSlots = dstEvent.slotGroups[0].slots;
      expect(dstSlots.map((slot) => slot.localStart)).toEqual([
        "00:00",
        "00:30",
        "01:00",
        "01:30",
        "01:00",
        "01:30",
        "02:00",
        "02:30",
      ]);
      expect(dstSlots[2].startOffset).toBe("-04:00");
      expect(dstSlots[4].startOffset).toBe("-05:00");

      await page.goto(`/event?code=${dstEvent.code}`);
      const grid = page.getByRole("grid", {
        name: /^Meeting time calendar, /,
      });
      await expect(grid.getByRole("rowheader").nth(2)).toHaveText("1:00 AM");
      await expect(grid.getByRole("rowheader").nth(4)).toHaveText("1:00 AM");
      await expect(cellAt(grid, 2, 0)).toHaveAttribute(
        "aria-label",
        /1:00 AM – 1:30 AM \(UTC-04:00\)/,
      );
      await expect(cellAt(grid, 4, 0)).toHaveAttribute(
        "aria-label",
        /1:00 AM – 1:30 AM \(UTC-05:00\)/,
      );
    } finally {
      await participant.context.close();
    }
  });
});
