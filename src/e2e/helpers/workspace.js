const { expect } = require("@playwright/test");
const { openRankedWindows } = require("./releviz");
const { shortDate } = require("./time");

// Locators and retrying actions for the organizer workspace (calendar,
// ranked windows, Finalize, lifecycle controls, overview) and for the
// participant's availability grid.

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
  await reviewAttendance(page);
  // The count tiles are backed by a per-person breakdown.
  await expect(
    page
      .locator("#organizer-finalize")
      .getByRole("table", { name: "Attendance by person" }),
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

// Picks the nth ranked window from the rail. The rail re-renders as the
// ranked windows load, and a click that lands mid-render is dropped on slower
// engines (WebKit), so the pick is retried until one window reports itself
// selected.
async function chooseRankedWindow(page, index = 0) {
  await openRankedWindows(page);
  const rail = page.getByRole("complementary", { name: "Ranked windows" });
  const selected = rail.getByRole("button", { name: "Selected time" });
  await expect
    .poll(
      async () => {
        if ((await selected.count()) === 0) {
          await rail
            .getByRole("button", { name: "Choose this time" })
            .nth(index)
            .click();
        }
        return selected.count();
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBe(1);
}

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

// The value of one Attendance review tile (Available, Partial, ...).
function attendanceTile(page, label) {
  return page
    .getByRole("group", { name: "Attendance review" })
    .locator(".metric-tile")
    .filter({
      has: page.locator(".metric-tile__label", { hasText: exactText(label) }),
    })
    .locator(".attendance-review__value");
}

// The organizer overview's summary tile with exactly this label, so
// "Meeting" never matches "Confirmed meeting".
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

// A value in the participant-facing details list inside `scope`.
function detailItem(scope, label) {
  return scope
    .locator("dl[aria-label='Event details'] .detail-list__item")
    .filter({ has: scope.page().locator("dt", { hasText: exactText(label) }) })
    .locator("dd");
}

// The live-sync scheduler checks immediately on window focus instead of
// waiting up to 15 s.
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
  chooseRankedWindow,
  clickLifecycleButton,
  detailItem,
  eventControls,
  finalizeCurrentSelection,
  gotoWeekWith,
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
