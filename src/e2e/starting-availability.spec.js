const { expect, test } = require("@playwright/test");
const {
  apiJson,
  createEvent,
  readSession,
  registerAccount,
} = require("./helpers/releviz");

// The starting schedule: every slot begins Available so people paint Busy
// over the times that do not work, the editor pre-selects the opposite brush,
// and the organizer's "Participants start as" setting re-seeds anyone who has
// not touched their schedule yet. The event is created through the API with
// the product default; the browser drives the participant editor.

const updateRoutePattern = /\/events\/participants\/update\?/;

// A participant's own response as the API reports it (the caller is not the
// organizer, so the payload carries their schedule and nobody else's).
async function ownResponse(request, token, eventCode) {
  const state = await apiJson(
    request,
    "GET",
    `/events/participants?code=${eventCode}`,
    token,
  );
  expect(state.response.status()).toBe(200);
  expect(state.payload.participants).toHaveLength(1);
  return state.payload.participants[0];
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

test.describe("Starting availability", () => {
  test("participants start Available, paint Busy over conflicts, and follow the organizer's setting", async ({
    browser,
    page,
    request,
  }) => {
    // Three accounts register through the passwordless flow.
    test.setTimeout(180_000);

    const runId = `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
    await registerAccount(
      page,
      `start-organizer-${runId}@example.com`,
      "Sam",
      "Starter",
    );
    const organizerToken = (await readSession(page)).access;
    const event = await createEvent(request, organizerToken, {
      name: `Starting availability ${runId}`,
      accessMode: "open_link",
    });
    // Left unset by the helper, so the API applied the product default.
    expect(event.startingAvailability).toBe("available");
    expect(event.slotCount).toBe(80);
    const allAvailable = Array(event.slotCount).fill(1);
    const allBusy = Array(event.slotCount).fill(0);

    // A participant joins in the browser and lands on an all-Available grid
    // with the Busy brush ready.
    const painterContext = await browser.newContext();
    const painterPage = await painterContext.newPage();
    await registerAccount(
      painterPage,
      `start-painter-${runId}@example.com`,
      "Pia",
      "Painter",
    );
    const painterToken = (await readSession(painterPage)).access;
    await painterPage.goto(`/event?code=${event.code}`);
    await expect(
      painterPage.getByRole("heading", { name: "Join Event" }),
    ).toBeVisible();
    await expect(
      painterPage.getByText(
        "Join, mark the times that do not work for you, then submit your response.",
      ),
    ).toBeVisible();
    await painterPage
      .getByRole("button", { name: "Join as Pia Painter" })
      .click();
    await expect(painterPage.getByText(/Welcome, Pia Painter/)).toBeVisible();

    const grid = painterPage.getByRole("grid", { name: "Availability" });
    await expect(grid).toBeVisible();
    await expect(selectedCells(grid)).toHaveCount(event.slotCount);
    await expect(unselectedCells(grid)).toHaveCount(0);
    const brush = painterPage.getByRole("group", {
      name: "Availability status",
    });
    const busyBrush = brush.getByRole("button", { name: "Busy", exact: true });
    const availableBrush = brush.getByRole("button", {
      name: "Available",
      exact: true,
    });
    await expect(busyBrush).toHaveAttribute("aria-pressed", "true");
    await expect(availableBrush).toHaveAttribute("aria-pressed", "false");
    await expect(
      painterPage
        .getByText(
          "Every time starts as Available. Paint Busy over the times that do not work for you.",
        )
        .first(),
    ).toBeVisible();
    await expect(
      painterPage.getByRole("button", { name: "Apply Busy to all" }),
    ).toBeVisible();
    const markAllAvailable = painterPage.getByRole("button", {
      name: "Mark all Available",
    });
    await expect(markAllAvailable).toBeVisible();
    await expect(
      painterPage.getByRole("button", { name: "Mark all Busy" }),
    ).toHaveCount(0);
    const joinedPainter = await ownResponse(request, painterToken, event.code);
    expect(joinedPainter.availabilityInperson).toEqual(allAvailable);
    expect(joinedPainter.availabilityVirtual).toEqual(allAvailable);
    expect(joinedPainter.submitted).toBe(0);

    // Painting one cell with the pre-selected brush marks just that time
    // Busy; everything else stays Available.
    const firstCell = grid.locator('[data-cell-idx="0"]');
    const firstSave = waitForAutosave(painterPage);
    await firstCell.click();
    await firstSave;
    await expect(firstCell).toHaveAttribute("aria-selected", "false");
    await expect(selectedCells(grid)).toHaveCount(event.slotCount - 1);
    await expect(
      painterPage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();
    let painter = await ownResponse(request, painterToken, event.code);
    expect(painter.availabilityInperson[0]).toBe(0);
    expect(
      painter.availabilityInperson.slice(1).every((value) => value === 1),
    ).toBe(true);
    // An in-person event never touches the virtual channel.
    expect(painter.availabilityVirtual).toEqual(allAvailable);
    expect(painter.version).toBeGreaterThan(joinedPainter.version);

    // "Mark all Available" restores the starting state.
    const restore = waitForAutosave(painterPage);
    await markAllAvailable.click();
    await restore;
    await expect(selectedCells(grid)).toHaveCount(event.slotCount);
    painter = await ownResponse(request, painterToken, event.code);
    expect(painter.availabilityInperson).toEqual(allAvailable);

    // Paint again so this response differs from the default before the
    // organizer changes the setting: only untouched schedules follow it.
    const secondSave = waitForAutosave(painterPage);
    await firstCell.click();
    await secondSave;
    await expect(firstCell).toHaveAttribute("aria-selected", "false");
    const painterBeforeFlip = await ownResponse(
      request,
      painterToken,
      event.code,
    );
    expect(painterBeforeFlip.availabilityInperson[0]).toBe(0);

    // A third person joins through the API and never opens the editor, so
    // their schedule is still exactly the seeded default.
    const untouchedContext = await browser.newContext();
    const untouchedPage = await untouchedContext.newPage();
    await registerAccount(
      untouchedPage,
      `start-untouched-${runId}@example.com`,
      "Uma",
      "Untouched",
    );
    const untouchedToken = (await readSession(untouchedPage)).access;
    const joinedUntouched = await apiJson(
      request,
      "POST",
      `/events/participants?code=${event.code}`,
      untouchedToken,
      {},
    );
    expect(joinedUntouched.response.status()).toBe(201);
    expect(joinedUntouched.payload.participant.availabilityInperson).toEqual(
      allAvailable,
    );
    expect(joinedUntouched.payload.participant.availabilityVirtual).toEqual(
      allAvailable,
    );

    // The organizer's workspace reports the current setting.
    await page.goto(`/event?code=${event.code}`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show all details" }).click();
    const startingDetail = page
      .locator("dl[aria-label='Additional event details'] .detail-list__item")
      .filter({ hasText: "Participants start as" });
    await expect(startingDetail).toContainText("Available");

    // Switching the event to a Busy start is a plain settings change: no
    // response reset is demanded, and the untouched participant is re-seeded
    // while the painted response keeps its values.
    const beforeFlip = await apiJson(
      request,
      "GET",
      `/events?code=${event.code}`,
      organizerToken,
    );
    expect(beforeFlip.response.status()).toBe(200);
    const flipped = await apiJson(
      request,
      "PUT",
      `/events?code=${event.code}`,
      organizerToken,
      {
        name: event.name,
        startingAvailability: "busy",
        expectedVersion: beforeFlip.payload.event.version,
      },
    );
    expect(flipped.response.status()).toBe(200);
    expect(flipped.payload.event.startingAvailability).toBe("busy");
    expect(flipped.payload.event.version).toBe(
      beforeFlip.payload.event.version + 1,
    );

    const untouched = await ownResponse(request, untouchedToken, event.code);
    expect(untouched.availabilityInperson).toEqual(allBusy);
    expect(untouched.availabilityVirtual).toEqual(allBusy);
    expect(untouched.submitted).toBe(0);
    expect(untouched.version).toBeGreaterThan(
      joinedUntouched.payload.participant.version,
    );
    const painterAfterFlip = await ownResponse(
      request,
      painterToken,
      event.code,
    );
    expect(painterAfterFlip.availabilityInperson).toEqual(
      painterBeforeFlip.availabilityInperson,
    );
    expect(painterAfterFlip.availabilityVirtual).toEqual(
      painterBeforeFlip.availabilityVirtual,
    );
    expect(painterAfterFlip.version).toBe(painterBeforeFlip.version);

    // A Busy-start event shows the legacy editor: nothing selected, the
    // Available brush ready, and "Mark all Busy" as the reset.
    await untouchedPage.goto(`/event?code=${event.code}`);
    await expect(
      untouchedPage.getByText(/Welcome, Uma Untouched/),
    ).toBeVisible();
    const untouchedGrid = untouchedPage.getByRole("grid", {
      name: "Availability",
    });
    await expect(unselectedCells(untouchedGrid)).toHaveCount(event.slotCount);
    await expect(selectedCells(untouchedGrid)).toHaveCount(0);
    const untouchedBrush = untouchedPage.getByRole("group", {
      name: "Availability status",
    });
    await expect(
      untouchedBrush.getByRole("button", { name: "Available", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      untouchedBrush.getByRole("button", { name: "Busy", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      untouchedPage.getByRole("button", { name: "Mark all Busy" }),
    ).toBeVisible();
    await expect(
      untouchedPage.getByRole("button", { name: "Apply Available to all" }),
    ).toBeVisible();
    await expect(
      untouchedPage.getByRole("button", { name: "Mark all Available" }),
    ).toHaveCount(0);
    await expect(
      untouchedPage.getByText(
        "Every time starts as Available. Paint Busy over the times that do not work for you.",
      ),
    ).toHaveCount(0);
    await expect(
      untouchedPage.getByText(
        "Choose a status, then click or drag across the times below.",
      ),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show all details" }).click();
    await expect(startingDetail).toContainText("Busy");

    await untouchedContext.close();
    await painterContext.close();
  });
});
