const { expect } = require("@playwright/test");
const { openRecommendedTimes } = require("./releviz");
const { shortDate } = require("./time");

// Locators and retrying actions for the organizer workspace (meeting-time
// calendar, recommended times and the Finalize step, event controls,
// overview, results, live sync) and for the participant's availability grid.

const ROW_HEADER = 1; // every calendar row starts with its time label
const updateRoutePattern = /\/events\/participants\/update\?/;

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
  if (await dayHeader.count()) return;
  // Only "Next week" walks forward, so start from the current week when the
  // target may be behind the week on screen.
  const thisWeek = page.getByRole("button", { name: "This week" });
  if (await thisWeek.isEnabled()) await thisWeek.click();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await dayHeader.count()) return;
    await page.getByRole("button", { name: "Next week" }).click();
  }
  throw new Error(`The calendar never reached the week of ${date}.`);
}

// Clicks a calendar cell until the Finalize candidate reflects the pick. A
// pick made right after the grid re-renders (a rail choice reveals its week,
// a week change swaps every cell) can be dropped by slower engines, so the
// click is retried instead of asserted once; selecting is idempotent.
async function pickCell(page, cell, expectedText) {
  const candidate = page.locator(".final-candidate");
  await expect
    .poll(
      async () => {
        await cell.click();
        return candidate.textContent();
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toContain(expectedText);
}

// Whether `locator` is the topmost element at its own centre, i.e. not
// hidden under something pinned over it (the calendar while picking).
async function isUncovered(locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + Math.min(box.height / 2, 12),
    );
    return element.contains(hit);
  });
}

// Picks the recommended time at `index` (0 is #1, the best) from the list
// inside Finalize and waits for the Finalize step to show it. The list
// re-renders as results load, and a click that lands mid-render can be
// dropped by slower engines, so the click is retried until the chip reports
// itself pressed; choosing is idempotent. Returns the chip.
async function chooseRecommendedTime(page, index = 0) {
  await openRecommendedTimes(page);
  const chip = page
    .locator("details.organizer-recommended-times .ranked-chip")
    .nth(index);
  await expect
    .poll(
      async () => {
        if ((await chip.getAttribute("aria-pressed")) !== "true") {
          await chip.click();
        }
        return chip.getAttribute("aria-pressed");
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBe("true");
  const rank = (await chip.locator(".ranked-chip__rank").textContent()).trim();
  await expect(page.locator(".final-candidate")).toContainText(
    `Recommended ${rank}`,
  );
  return chip;
}

// Clicks "Review attendance" until the preview lands. The Finalize step
// re-keys when a pick changes, so a click made right after can be dropped by
// slower engines (seen on WebKit); the preview is read-only, so retrying is
// safe.
async function reviewAttendance(page) {
  const notice = page.getByText(
    "Attendance review is current for this candidate.",
  );
  await expect
    .poll(
      async () => {
        if (await notice.isVisible()) return true;
        await page.getByRole("button", { name: "Review attendance" }).click();
        return notice.isVisible();
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
}

async function finalizeCurrentSelection(page, eventCode) {
  await page.getByRole("button", { name: "Review attendance" }).click();
  await expect(
    page.getByText("Attendance review is current for this candidate."),
  ).toBeVisible();
  // The count tiles are backed by a per-person breakdown.
  await expect(
    page
      .locator("#organizer-finalize")
      .getByRole("table", { name: "Attendance by person" }),
  ).toBeVisible();
  // Finalizing reviews the confirmation email before a second, explicit
  // step. The people on these events were added without an invitation, so
  // nobody would be emailed: the review says so and still lets the organizer
  // finalize.
  await page
    .locator("#organizer-finalize")
    .getByRole("button", { name: "Finalize meeting" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Finalize meeting" });
  await expect(dialog.getByText("Step 1 of 2: Review")).toBeVisible();
  await expect(
    dialog.getByText(
      "Nobody has been invited by email, so no confirmation emails will be sent.",
    ),
  ).toBeVisible();
  await expect(dialog.locator('iframe[title="Email preview"]')).toHaveCount(0);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Finalize without emailing anyone?" }),
  ).toBeFocused();
  await expect(dialog.getByText("No emails will be sent.")).toBeVisible();
  const finalization = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes(`/events/finalization?code=${eventCode}`),
  );
  await dialog
    .getByRole("button", { name: "Finalize meeting", exact: true })
    .click();
  expect((await finalization).status()).toBe(202);
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("The meeting is finalized. Nobody was emailed."),
  ).toBeVisible();
}

// The revision the Results panel says it is current at, or -1 while it is
// still updating.
async function currentResultsRevision(page) {
  const text = await page
    .getByText(/Results are current at revision \d+/)
    .textContent({ timeout: 500 })
    .catch(() => "");
  const match = String(text || "").match(/revision (\d+)/);
  return match ? Number(match[1]) : -1;
}

// The lifecycle controls in the workspace header (status badge, Close
// responses, Reactivate event, Archive event).
function eventControls(page) {
  return page.getByRole("region", { name: "Event controls" });
}

// Clicks a lifecycle button in the workspace header and returns the
// lifecycle response, so callers can assert its status and payload.
async function clickLifecycleButton(page, name, eventCode) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PUT" &&
      candidate.url().includes(`/events/lifecycle?code=${eventCode}`),
  );
  await eventControls(page).getByRole("button", { name, exact: true }).click();
  return response;
}

// Opens an event as a signed-in person who has not joined yet and joins it.
async function joinEventInBrowser(page, eventCode, displayName) {
  await page.goto(`/event?code=${eventCode}`);
  await expect(page.getByRole("heading", { name: "Join Event" })).toBeVisible();
  await page.getByRole("button", { name: `Join as ${displayName}` }).click();
  await expect(page.getByText(`Welcome, ${displayName}`)).toBeVisible();
}

function exactText(text) {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

// The value of one Attendance review tile (Available, Partial, Unavailable,
// Unanswered, Excluded).
function attendanceTile(page, label) {
  return page
    .getByRole("group", { name: "Attendance review" })
    .locator(".metric-tile")
    .filter({
      has: page.locator(".metric-tile__label", { hasText: exactText(label) }),
    })
    .locator(".attendance-review__value");
}

// The organizer overview's summary tile with exactly this label (Schedule,
// Meeting, Responses, Confirmed meeting), so "Meeting" never matches
// "Confirmed meeting".
function overviewTile(page, label) {
  return page.locator(".event-overview-summary__item").filter({
    has: page.locator(".event-overview-summary__label", {
      hasText: exactText(label),
    }),
  });
}

// A value in the organizer's "Show all details" list.
function overviewDetail(page, label) {
  return page
    .locator("dl[aria-label='Additional event details'] .detail-list__item")
    .filter({ has: page.locator("dt", { hasText: exactText(label) }) })
    .locator("dd");
}

// A value in the participant-facing details list inside `scope` (a page or
// a locator).
function detailItem(scope, label) {
  const page = typeof scope.page === "function" ? scope.page() : scope;
  return scope
    .locator("dl[aria-label='Event details'] .detail-list__item")
    .filter({ has: page.locator("dt", { hasText: exactText(label) }) })
    .locator("dd");
}

// Asks the organizer workspace for a live-sync pass now: the window
// regaining focus checks at once, instead of waiting for the next pushed
// change or the fallback poll (a minute while the event stream is up).
async function wakeLiveSync(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

// Autosave PUTs the response ~700ms after a change; resolve once the server
// has accepted one.
function waitForAutosave(page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      updateRoutePattern.test(response.url()) &&
      response.ok(),
  );
}

function selectedCells(grid) {
  return grid.locator("[role='gridcell'][data-cell-idx][aria-selected='true']");
}

function unselectedCells(grid) {
  return grid.locator(
    "[role='gridcell'][data-cell-idx][aria-selected='false']",
  );
}

module.exports = {
  ROW_HEADER,
  attendanceTile,
  cellAt,
  chooseRecommendedTime,
  clickLifecycleButton,
  currentResultsRevision,
  detailItem,
  eventControls,
  finalizeCurrentSelection,
  gotoWeekWith,
  isUncovered,
  joinEventInBrowser,
  overviewDetail,
  overviewTile,
  pickCell,
  reviewAttendance,
  selectedCells,
  unselectedCells,
  updateRoutePattern,
  wakeLiveSync,
  waitForAutosave,
};
