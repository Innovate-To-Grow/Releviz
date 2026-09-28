const { expect, test } = require("@playwright/test");
const {
  createEvent,
  eventState,
  newRunId,
  readSession,
  recomputeEventResults,
  refreshWorkspace,
  registerAccount,
  slotIndex,
  submitResponse,
  updateEventViaApi,
} = require("./helpers/releviz");
const {
  cellAt,
  chooseRankedWindow,
  gotoWeekWith,
  pickCell,
  reviewAttendance,
  wakeLiveSync,
} = require("./helpers/workspace");
const { DAY_MS, isoDate, weekStartMs } = require("./helpers/time");

// Organizer workspace states the main flows never reach: the blocked-times
// editor's Open brush, Clear all, version conflict and discarded marks; the
// results panel while a snapshot is missing, refreshing, failed or stale;
// live sync pausing, recovering and picking up another session's edit; and
// the header's Copy share link.
//
// The results and activity endpoints are cross-origin API calls, so every
// mocked answer is built from the real response (route.fetch) and keeps its
// CORS headers; only the field under test changes. RegExp routes are used
// because glob "?" semantics changed across Playwright versions.
const RESULTS_ROUTE = /\/events\/results\?/;
const ACTIVITY_ROUTE = /\/events\/activity\?/;

// Routes `pattern` through a switchable override and returns its switch.
// While the override is null requests reach the server untouched; otherwise
// the real response is fetched and answered with its JSON body passed
// through `change` (and with `status` when one is set). Switching the
// override off, rather than unrouting, never races a handler still in
// flight, and live sync's own reads get the same answer as the test's.
async function overrideJson(page, pattern) {
  let current = null;
  await page.route(pattern, async (route) => {
    const override = current;
    if (!override) return route.fallback();
    const response = await route.fetch();
    const json = await response.json();
    return route.fulfill({
      response,
      status: override.status ?? response.status(),
      json: override.change(json),
    });
  });
  return (next) => {
    current = next;
  };
}

function shiftedBack(value, days) {
  return new Date(Date.parse(value) - days * DAY_MS).toISOString();
}

test.describe("Workspace states", () => {
  test("blocked-times editor opens and clears blocks, reloads after a conflict, announces discarded marks, and rejects blocks that leave no window", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `blocked-${runId}@example.com`,
      "Bo",
      "Blocker",
    );
    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Blocked ${runId}`,
      blockedSlots: { "weekday:1": [0, 1] },
    });
    recomputeEventResults(event.code);
    const tue9 = slotIndex(event, "weekday:2", "09:00");
    const wed9 = slotIndex(event, "weekday:3", "09:00");
    const fri9 = slotIndex(event, "weekday:5", "09:00");
    const event2 = await createEvent(request, token, {
      name: `No window ${runId}`,
      days: [1],
      meetingDurationMinutes: 480,
    });
    const storedBlocks = async (code) =>
      (await eventState(request, token, code)).blockedSlots;

    // Live sync is frozen, so only the test decides when the workspace
    // re-reads the event; the header may show "Live updates paused".
    await page.route(ACTIVITY_ROUTE, (route) => route.abort());

    await page.goto(`/event?code=${event.code}`);
    const blocked = page.locator("details.organizer-blocked-times");
    const summary = blocked.locator("summary");
    await expect(
      page.getByText("2 blocked slots are excluded from these results."),
    ).toBeVisible();
    await expect(summary).toContainText("2 slots blocked");
    // An event with blocks starts with the editor folded away.
    await expect(blocked).not.toHaveAttribute("open", "");
    await summary.click();
    await expect(blocked).toHaveAttribute("open", "");
    const editor = page.locator(".blocked-slots-editor");
    const brushes = page.getByRole("group", { name: "Mark times as" });
    const grid = page.getByRole("grid", { name: "Blocked times" });
    const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);
    const save = page.getByRole("button", { name: "Save blocked times" });

    // The Open brush unblocks a single slot.
    const openBrush = brushes.getByRole("button", {
      name: "Open",
      exact: true,
    });
    await openBrush.click();
    await expect(openBrush).toHaveAttribute("aria-pressed", "true");
    await cell(0).click();
    await expect(cell(0)).toHaveAttribute("data-blocked-paint", "false");
    await expect(editor).toContainText("1 slots marked");
    await save.click();
    await expect(page.getByText("Blocked times saved.")).toBeVisible();
    await expect(summary).toContainText("1 slots blocked");
    expect(await storedBlocks(event.code)).toEqual({ "weekday:1": [1] });

    // Clear all opens every slot.
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(cell(1)).toHaveAttribute("data-blocked-paint", "false");
    await expect(editor).toContainText("0 slots marked");
    await save.click();
    await expect(summary).toContainText("0 slots blocked");
    await expect.poll(() => storedBlocks(event.code)).toEqual({});

    // Another session saves first: the stale save is refused, and Reload
    // latest event takes the newer event and drops the marks.
    const blockedBrush = brushes.getByRole("button", {
      name: "Blocked",
      exact: true,
    });
    await blockedBrush.click();
    await expect(blockedBrush).toHaveAttribute("aria-pressed", "true");
    await cell(tue9).click();
    await expect(cell(tue9)).toHaveAttribute("data-blocked-paint", "true");
    await updateEventViaApi(request, token, event.code, {
      name: `Blocked ${runId} renamed`,
    });
    await save.click();
    const failure = editor.getByRole("alert");
    await expect(failure).toContainText(
      "The event changed in another session. Reload and try again.",
    );
    await failure.getByRole("button", { name: "Reload latest event" }).click();
    await expect(failure).toHaveCount(0);
    await expect(editor).toContainText("0 slots marked");
    await expect(cell(tue9)).toHaveAttribute("data-blocked-paint", "false");
    await expect(save).toBeDisabled();
    // A reload the organizer chose is not announced as a loss.
    await expect(
      page.getByText(
        "Unsaved blocked-time marks were discarded because the event changed.",
      ),
    ).toHaveCount(0);
    await expect(page.locator("h2.organizer-title")).toHaveText(
      `Blocked ${runId} renamed`,
    );

    // New blocks from elsewhere replace unsaved marks, and the loss is said.
    await cell(wed9).click();
    await expect(cell(wed9)).toHaveAttribute("data-blocked-paint", "true");
    await updateEventViaApi(request, token, event.code, {
      blockedSlots: { "weekday:5": [0] },
    });
    await refreshWorkspace(page);
    await expect(
      page.getByText(
        "Unsaved blocked-time marks were discarded because the event changed.",
      ),
    ).toBeVisible();
    await expect(summary).toContainText("1 slots blocked");
    await expect(cell(fri9)).toHaveAttribute("data-blocked-paint", "true");
    await expect(cell(wed9)).toHaveAttribute("data-blocked-paint", "false");
    await expect(editor).toContainText("1 slots marked");

    // Blocks that leave no room for the meeting are refused, and there is
    // nothing to reload.
    await page.goto(`/event?code=${event2.code}`);
    // No blocks yet, so the editor starts open.
    await expect(
      page.locator("details.organizer-blocked-times"),
    ).toHaveAttribute("open", "");
    await page
      .getByRole("grid", { name: "Blocked times" })
      .locator('[data-cell-idx="5"]')
      .click();
    await page.getByRole("button", { name: "Save blocked times" }).click();
    const refused = page.locator(".blocked-slots-editor").getByRole("alert");
    await expect(refused).toHaveText(
      "Blocked slots leave no open window for a 480-minute meeting.",
    );
    await expect(
      refused.getByRole("button", { name: "Reload latest event" }),
    ).toHaveCount(0);
    expect(await storedBlocks(event2.code)).toEqual({});
  });

  test("results panel shows empty, refreshing, failed and stale-recommendation states; live sync pauses, recovers and picks up other sessions; the share link copies", async ({
    browserName,
    context,
    page,
    request,
  }) => {
    // Every engine records what the page hands the clipboard; only Chromium
    // can also be granted a clipboard to read back.
    await page.addInitScript(() => {
      window.__relevizCopied = [];
      const clipboard = navigator.clipboard;
      if (!clipboard) return;
      const original =
        typeof clipboard.writeText === "function"
          ? clipboard.writeText.bind(clipboard)
          : null;
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          window.__relevizCopied.push(text);
          if (original) await original(text);
        },
      });
    });
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }

    const runId = newRunId();
    await registerAccount(page, `states-${runId}@example.com`, "Stu", "States");
    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `States ${runId}`,
    });
    recomputeEventResults(event.code);
    const mon10 = slotIndex(event, "weekday:1", "10:00");

    const rail = page.getByRole("complementary", { name: "Ranked windows" });
    const hint = rail.locator(".meeting-results__rail-hint");
    const grid = page.getByRole("grid", { name: /^Meeting time calendar, / });
    const candidate = page.locator(".final-candidate");

    // Fresh results with nobody counted: nothing to recommend yet.
    await page.goto(`/event?code=${event.code}`);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /Results are current at revision \d+/ }),
    ).toBeVisible();
    await expect(hint).toHaveText("No recommendation yet");
    await rail.locator("summary").click();
    await expect(
      rail.getByRole("heading", { level: 5, name: "No recommendation yet" }),
    ).toBeVisible();
    await expect(
      rail.getByText("No valid meeting window is available yet."),
    ).toBeVisible();
    const finalize = page.locator("#organizer-finalize");
    await expect(finalize).toContainText("No time selected yet");
    await expect(finalize).toContainText(
      "Pick a window on the calendar or choose a ranked one.",
    );

    const overrideResults = await overrideJson(page, RESULTS_ROUTE);

    // Refreshing before any snapshot exists: the rail waits, the calendar
    // is neutral, and a picked window has no counts yet.
    overrideResults({
      change: () => ({
        status: "refreshing",
        requestedRevision: 7,
        computedRevision: null,
        generatedAt: null,
        results: null,
      }),
    });
    await refreshWorkspace(page);
    await expect(
      page.getByText("Results are updating for revision 7.", { exact: true }),
    ).toBeVisible();
    await expect(hint).toHaveText("Calculating the best options");
    await expect(
      rail.getByRole("heading", {
        level: 5,
        name: "Calculating the best options",
      }),
    ).toBeVisible();
    await expect(
      rail.getByText("Recommendations will appear here as responses arrive."),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Availability shading appears once the first results snapshot is ready. You can already pick any window.",
      ),
    ).toBeVisible();
    await gotoWeekWith(page, grid, isoDate(weekStartMs() + 8 * DAY_MS));
    await pickCell(page, cellAt(grid, 0, 0), "Custom window");
    await expect(candidate).toContainText(
      "No responses have been counted yet.",
    );

    // Refreshing with an earlier snapshot keeps showing it.
    await submitResponse(request, token, event, {
      name: "Ada",
      email: `states-ada-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    recomputeEventResults(event.code);
    overrideResults({
      change: (json) => ({
        ...json,
        status: "refreshing",
        requestedRevision: json.computedRevision + 1,
      }),
    });
    await refreshWorkspace(page);
    await expect(
      page.getByText(
        /Results are updating for revision \d+\. Showing the last successful snapshot meanwhile\./,
      ),
    ).toBeVisible();
    await expect(hint).toHaveText(/\d+ candidates? · best /);

    // A failed calculation says so and keeps the snapshot listed.
    overrideResults({ change: (json) => ({ ...json, status: "failed" }) });
    await refreshWorkspace(page);
    await expect(
      page.getByRole("alert").filter({
        hasText:
          "Result calculation failed. The worker will retry; the last successful snapshot remains visible.",
      }),
    ).toBeVisible();
    await expect(rail.locator(".result-option").first()).toBeVisible();

    // A weekly recommendation whose suggested date has passed moves to its
    // next occurrence, and the preview accepts the moved instant.
    overrideResults({
      change: (json) => {
        const [first, ...rest] = json.results.recommendations;
        return {
          ...json,
          status: "fresh",
          results: {
            ...json.results,
            recommendations: [
              {
                ...first,
                suggestedStartsAt: shiftedBack(first.suggestedStartsAt, 7),
                suggestedEndsAt: shiftedBack(first.suggestedEndsAt, 7),
              },
              ...rest,
            ],
          },
        };
      },
    });
    await refreshWorkspace(page);
    // The failed notice gives way once the moved snapshot is on screen.
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /Results are current at revision \d+/ }),
    ).toBeVisible();
    await chooseRankedWindow(page, 0);
    await expect(page.locator(".final-candidate__note")).toHaveText(
      "The suggested date has passed; this uses the next occurrence.",
    );
    await expect(
      rail.getByRole("button", { name: "Selected time" }),
    ).toHaveCount(1);
    await reviewAttendance(page);
    await expect(
      page.getByText("Attendance review is current for this candidate."),
    ).toBeVisible();
    overrideResults(null);

    // Live sync pauses when the activity digest fails. A 503 JSON body keeps
    // the message the same in every engine.
    const badge = page.locator(".organizer-heading__live-badge");
    const liveStatus = page.locator('.organizer-heading__live [role="status"]');
    const overrideActivity = await overrideJson(page, ACTIVITY_ROUTE);
    overrideActivity({
      status: 503,
      change: () => ({ error: "Activity digest offline" }),
    });
    await expect
      .poll(
        async () => {
          await wakeLiveSync(page);
          return (await badge.textContent())?.trim();
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
      )
      .toBe("Live updates paused");
    await expect(liveStatus).toHaveText(
      "New responses could not be loaded automatically (Activity digest offline). Use Refresh to load new responses.",
    );

    // It recovers on the next successful check.
    overrideActivity(null);
    await expect
      .poll(
        async () => {
          await wakeLiveSync(page);
          return (await badge.textContent())?.trim();
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
      )
      .toBe("Live");
    await expect(liveStatus).toHaveText("New responses load automatically.");

    // An edit in another session shows up without Refresh.
    await updateEventViaApi(request, token, event.code, {
      name: `States ${runId} renamed`,
    });
    await wakeLiveSync(page);
    await expect(page.locator("h2.organizer-title")).toHaveText(
      `States ${runId} renamed`,
      { timeout: 20_000 },
    );
    await expect(page.locator("h1.event-header-title")).toHaveText(
      `States ${runId} renamed`,
      { timeout: 20_000 },
    );
    await expect(page.locator(".organizer-heading__live-time time")).toHaveText(
      /^Updated /,
    );

    // Copy share link copies the event URL and confirms it for two seconds.
    await page.getByRole("button", { name: "Copy share link" }).click();
    await expect(
      page.getByRole("button", { name: "Link copied" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy share link" }),
    ).toBeVisible();
    const shareUrl = `${new URL(page.url()).origin}/event?code=${event.code}`;
    expect(await page.evaluate(() => window.__relevizCopied.at(-1))).toBe(
      shareUrl,
    );
    if (browserName === "chromium") {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        shareUrl,
      );
    }
  });
});
