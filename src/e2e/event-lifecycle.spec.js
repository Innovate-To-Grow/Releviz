const fs = require("node:fs/promises");
const { expect, test } = require("@playwright/test");
const {
  apiJson,
  createEvent,
  eventState,
  finalizeViaApi,
  freshResults,
  newAccountContext,
  newRunId,
  ownResponse,
  readSession,
  recomputeEventResults,
  refreshWorkspace,
  registerAccount,
  registerAccountViaApi,
  setLifecycleViaApi,
  slotIndex,
  submitResponse,
  updateEventViaApi,
} = require("./helpers/releviz");
const {
  attendanceTile,
  chooseRankedWindow,
  clickLifecycleButton,
  eventControls,
  joinEventInBrowser,
  overviewDetail,
  overviewTile,
  reviewAttendance,
  selectedCells,
  waitForAutosave,
} = require("./helpers/workspace");
const { freezeLiveSync } = require("./helpers/roster");
const { icsUtc } = require("./helpers/time");
const { expectAccessible } = require("./helpers/accessibility");

// The event lifecycle from both sides. The organizer drives close, reopen
// (a stale version is refused, an expired deadline is cleared), archive,
// reactivate and finalize from the workspace controls, and the Overview
// details and section links follow along. A participant paints "If needed"
// (counted as Partial), then sees the grid lock for every status that stops
// responses and once the deadline passes. A finalized event can be archived
// without losing its meeting, and a joined participant sees the confirmed
// meeting and downloads its calendar file.

// Every control that changes a response is disabled and the grid is
// read-only (no tab stops, no selected cells) behind the locked notice.
async function expectLocked(ppage, message) {
  await expect(ppage.locator(".participant-locked-notice")).toHaveText(message);
  const brush = ppage.getByRole("group", { name: "Availability status" });
  for (const name of ["Busy", "If needed", "Available"]) {
    await expect(
      brush.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    ppage.getByRole("button", { name: /^Apply .+ to all$/ }),
  ).toBeDisabled();
  await expect(
    ppage.getByRole("button", { name: /^Mark all / }),
  ).toBeDisabled();
  await expect(
    ppage.getByRole("button", { name: /^(Submit|Update) Availability$/ }),
  ).toBeDisabled();
  const grid = ppage.getByRole("grid", { name: "Availability" });
  await expect(grid).toHaveAttribute("aria-readonly", "true");
  await expect(grid.locator("[data-cell-idx][tabindex]")).toHaveCount(0);
  await expect(selectedCells(grid)).toHaveCount(0);
}

// A value in the participant's "Confirmed meeting" card list.
function finalMeetingItem(ppage, label) {
  return ppage
    .locator(
      "main.participant-workspace dl[aria-label='Confirmed meeting'] .detail-list__item",
    )
    .filter({ has: ppage.locator("dt", { hasText: label }) })
    .locator("dd");
}

// Clicks a "Download calendar (.ics)" button and returns the file's text.
async function downloadCalendar(ppage) {
  const pending = ppage.waitForEvent("download");
  await ppage.getByRole("button", { name: "Download calendar (.ics)" }).click();
  const download = await pending;
  const filePath = await download.path();
  return {
    filename: download.suggestedFilename(),
    body: await fs.readFile(filePath, "utf8"),
  };
}

// The saved file name comes from the API's Content-Disposition header, which
// the cross-origin web app can read only because the API exposes it over CORS.
function expectMeetingCalendar(calendar, code, meeting) {
  expect(calendar.filename).toBe(`releviz-${code}-final.ics`);
  expect(calendar.body).toContain("BEGIN:VCALENDAR");
  expect(calendar.body).toContain(`UID:${meeting.calendarUid}`);
  expect(calendar.body).toContain(`DTSTART:${icsUtc(meeting.startsAt)}`);
  expect(calendar.body).toContain(`DTEND:${icsUtc(meeting.endsAt)}`);
}

test.describe("Event lifecycle", () => {
  test("drives close, stale reopen, archive, reactivate, and finalize-from-closed from the workspace controls", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `lifecycle-${runId}@example.com`,
      "Lee",
      "Cycle",
    );
    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Lifecycle ${runId}`,
    });
    const { code } = event;
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, token, event, {
      name: "Ada",
      email: `ada-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    recomputeEventResults(code);

    const controls = eventControls(page);
    const badge = controls.locator(".organizer-lifecycle-panel__status");
    const summary = controls.locator(".organizer-event-controls__lifecycle");
    const live = page.locator(".organizer-heading__live");
    const button = (name) =>
      controls.getByRole("button", { name, exact: true });
    const editButton = page.getByRole("button", { name: "Edit event" });
    const clearAll = page.getByRole("button", { name: "Clear all" });
    const markTimes = page.getByRole("group", { name: "Mark times as" });

    // 1) The Overview details and the section links.
    await page.goto(`/event?code=${code}`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show all details" }).click();
    const hideDetails = page.getByRole("button", { name: "Hide details" });
    await expect(hideDetails).toHaveAttribute("aria-expanded", "true");
    await expect(overviewDetail(page, "Availability interval")).toHaveText(
      "30 minutes",
    );
    await expect(overviewDetail(page, "Participants start as")).toHaveText(
      "Available",
    );
    await expect(overviewDetail(page, "Event code")).toHaveText(code);
    await expect(overviewDetail(page, "Status")).toHaveText("Active");
    await page
      .getByRole("navigation", { name: "Workspace sections" })
      .getByRole("link", { name: "Roster" })
      .click();
    await expect(page).toHaveURL(/#organizer-roster$/);
    await expect(
      page.getByRole("heading", { level: 3, name: "Roster", exact: true }),
    ).toBeInViewport();

    // 2) An active event offers reminders, closing and archiving, and syncs
    // new responses on its own.
    await expect(badge).toHaveText("active");
    await expect(summary).toHaveText(
      "This event is active and accepting responses.",
    );
    await expect(button("Queue reminders")).toBeVisible();
    await expect(button("Close responses")).toBeVisible();
    await expect(button("Archive event")).toBeVisible();
    await expect(button("Reactivate event")).toHaveCount(0);
    await expect(live).toContainText("New responses load automatically.");

    // 3) Closing stops responses and live sync but keeps editing open. A
    // live-sync pass already in flight when the event closes could still
    // re-read it after the change below, so polls are held until step 6.
    const releaseLiveSync = await freezeLiveSync(page);
    let response = await clickLifecycleButton(page, "Close responses", code);
    expect(response.status()).toBe(200);
    await expect(badge).toHaveText("closed");
    await expect(summary).toHaveText("Responses are now closed.");
    await expect(button("Reactivate event")).toBeVisible();
    await expect(button("Archive event")).toBeVisible();
    await expect(button("Queue reminders")).toHaveCount(0);
    await expect(button("Close responses")).toHaveCount(0);
    await expect(live).toHaveCount(0);
    await expect(editButton).toBeEnabled();
    await expect(overviewDetail(page, "Status")).toHaveText("Closed");
    expect((await eventState(request, token, code)).status).toBe("closed");

    // 4-5) Another session moves the deadline into the past. Live sync is off
    // while the event is closed (and held), so this page's version is now
    // stale and reopening is refused.
    await updateEventViaApi(request, token, code, {
      responseDeadline: new Date(Date.now() - 3_600_000).toISOString(),
    });
    response = await clickLifecycleButton(page, "Reactivate event", code);
    expect(response.status()).toBe(409);
    await expect(controls.getByRole("alert")).toHaveText(
      "The event changed in another session. Refresh and try again.",
    );
    await expect(badge).toHaveText("closed");

    // 6) After a refresh, reopening clears the expired deadline.
    await releaseLiveSync();
    await refreshWorkspace(page);
    response = await clickLifecycleButton(page, "Reactivate event", code);
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().responseDeadline).toBeNull();
    await expect(controls.getByRole("alert")).toHaveCount(0);
    await expect(badge).toHaveText("active");
    await expect(overviewTile(page, "Responses")).toContainText("No deadline");
    await expect(live).toBeVisible();
    expect(
      (await eventState(request, token, code)).responseDeadline,
    ).toBeNull();

    // 7) Archiving locks editing, blocked times and finalizing; a window can
    // still be picked to look at.
    response = await clickLifecycleButton(page, "Archive event", code);
    expect(response.status()).toBe(200);
    await expect(badge).toHaveText("archived");
    await expect(summary).toHaveText("This event is archived.");
    await expect(button("Reactivate event")).toBeVisible();
    await expect(button("Archive event")).toHaveCount(0);
    await expect(button("Close responses")).toHaveCount(0);
    await expect(button("Queue reminders")).toHaveCount(0);
    const archivedReason = "Reactivate this archived event before editing it.";
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute("title", archivedReason);
    await expect(clearAll).toBeDisabled();
    await expect(clearAll).toHaveAttribute("title", archivedReason);
    await expect(
      markTimes.getByRole("button", { name: "Blocked", exact: true }),
    ).toBeDisabled();
    await expect(
      markTimes.getByRole("button", { name: "Open", exact: true }),
    ).toBeDisabled();
    await chooseRankedWindow(page, 0);
    await expect(page.locator(".final-candidate")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review attendance" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("note").filter({
        hasText:
          "Reactivate this event before reviewing and finalizing a meeting time.",
      }),
    ).toBeVisible();

    // 8) Reactivating clears the pick.
    response = await clickLifecycleButton(page, "Reactivate event", code);
    expect(response.status()).toBe(200);
    await expect(badge).toHaveText("active");
    await expect(page.locator("#organizer-finalize")).toContainText(
      "No time selected yet",
    );

    // 9) A closed event can still be finalized.
    response = await clickLifecycleButton(page, "Close responses", code);
    expect(response.status()).toBe(200);
    await expect(badge).toHaveText("closed");
    await chooseRankedWindow(page, 0);
    await reviewAttendance(page);
    const finalization = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PUT" &&
        candidate.url().includes(`/events/finalization?code=${code}`),
    );
    await page.getByRole("button", { name: "Finalize meeting" }).click();
    expect((await finalization).status()).toBe(202);
    await expect(
      page.getByText(
        "The meeting is finalized and calendar invitations are queued.",
      ),
    ).toBeVisible();
    await expect(badge).toHaveText("finalized");
    await expect(summary).toHaveText(
      "The meeting is finalized. Reactivate the event to collect new responses.",
    );
    const confirmedReason =
      "Reactivate the event before editing a confirmed meeting.";
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute("title", confirmedReason);
    await expect(clearAll).toBeDisabled();
    await expect(clearAll).toHaveAttribute("title", confirmedReason);
    await expect(overviewTile(page, "Confirmed meeting")).toBeVisible();
    await expect(overviewDetail(page, "Status")).toHaveText("Finalized");
    const finalized = await eventState(request, token, code);
    expect(finalized.status).toBe("finalized");
    expect(finalized.finalMeeting).not.toBeNull();

    // 10) The details collapse again, and a section hash lands on Results.
    await hideDetails.click();
    await expect(
      page.locator("dl[aria-label='Additional event details']"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Show all details" }),
    ).toHaveAttribute("aria-expanded", "false");
    await page.goto(`/event?code=${code}#organizer-results`);
    await expect(
      page.getByRole("heading", { level: 3, name: "Results", exact: true }),
    ).toBeInViewport();
  });

  test("a participant paints If needed, is counted as Partial, and sees the grid lock when the event is finalized, closed, archived, or past its deadline", async ({
    browser,
    page,
    request,
  }) => {
    // Two accounts register through the passwordless flow, and one event's
    // deadline really passes during the test.
    test.setTimeout(180_000);
    const runId = newRunId();
    await registerAccount(
      page,
      `locked-org-${runId}@example.com`,
      "Omar",
      "Organizer",
    );
    const token = (await readSession(page)).access;
    const {
      context: participantContext,
      page: ppage,
      token: ptoken,
    } = await newAccountContext(
      browser,
      `locked-pat-${runId}@example.com`,
      "Pat",
      "Painter",
    );

    const event1 = await createEvent(request, token, {
      name: `Locked ${runId}`,
      accessMode: "open_link",
      startingAvailability: "busy",
    });
    const event2 = await createEvent(request, token, {
      name: `Locked closed ${runId}`,
      accessMode: "open_link",
    });
    await setLifecycleViaApi(request, token, event2.code, "closed");
    const event3 = await createEvent(request, token, {
      name: `Locked deadline ${runId}`,
      accessMode: "open_link",
      responseDeadline: new Date(Date.now() + 45_000).toISOString(),
    });
    const mon9 = slotIndex(event1, "weekday:1", "09:00");
    const mon930 = slotIndex(event1, "weekday:1", "09:30");

    // 1) Join the deadline event first, while its deadline is still ahead.
    await joinEventInBrowser(ppage, event3.code, "Pat Painter");

    // 2) A closed event cannot be joined.
    await ppage.goto(`/event?code=${event2.code}`);
    await expect(
      ppage.getByRole("heading", { name: "Join Event" }),
    ).toBeVisible();
    await ppage.getByRole("button", { name: "Join as Pat Painter" }).click();
    await expect(ppage.locator(".participant-error")).toHaveText(
      "Failed to join: Responses cannot change while the event is closed.",
    );
    await expect(ppage.getByText(/Welcome/)).toHaveCount(0);

    // 3) On a Busy-start event the Available brush is preselected; If needed
    // paints half availability.
    await joinEventInBrowser(ppage, event1.code, "Pat Painter");
    const grid = ppage.getByRole("grid", { name: "Availability" });
    const brush = ppage.getByRole("group", { name: "Availability status" });
    await expect(
      brush.getByRole("button", { name: "Available", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const ifNeeded = brush.getByRole("button", {
      name: "If needed",
      exact: true,
    });
    await ifNeeded.click();
    await expect(ifNeeded).toHaveAttribute("aria-pressed", "true");
    await expect(
      ppage.getByRole("button", { name: "Apply If needed to all" }),
    ).toBeVisible();
    for (const idx of [mon9, mon930]) {
      const saved = waitForAutosave(ppage);
      await grid.locator(`[data-cell-idx="${idx}"]`).click();
      await saved;
    }
    for (const [idx, label] of [
      [mon9, "Mon, 9:00 AM – 9:30 AM, availability 0.5"],
      [mon930, "Mon, 9:30 AM – 10:00 AM, availability 0.5"],
    ]) {
      const cell = grid.locator(`[data-cell-idx="${idx}"]`);
      await expect(cell).toHaveAttribute("data-availability", "partial");
      await expect(cell).toHaveAttribute("aria-selected", "true");
      await expect(cell).toHaveAttribute("aria-label", label);
      await expect(cell.locator(".schedule-grid-cell__glyph")).toHaveText("◐");
    }
    const painted = await ownResponse(request, ptoken, event1.code);
    expect(painted.availabilityInperson.map(Number)).toEqual(
      Array.from({ length: event1.slotCount }, (_, index) =>
        index === mon9 || index === mon930 ? 0.5 : 0,
      ),
    );

    // 4) Submit.
    await ppage.getByRole("button", { name: "Submit Availability" }).click();
    await expect(ppage.getByText("Schedule submitted.")).toBeVisible();
    await expect(
      ppage.getByRole("heading", { level: 2, name: /Welcome, Pat Painter/ }),
    ).toContainText("Submitted");

    // 5) The organizer sees If needed as Partial and finalizes.
    recomputeEventResults(event1.code);
    await page.goto(`/event?code=${event1.code}`);
    await chooseRankedWindow(page, 0);
    const candidate = page.locator(".final-candidate");
    await expect(candidate).toContainText("Ranked #1");
    await expect(candidate).toContainText("Mon 09:00–10:00");
    await expect(candidate).toContainText("50% weighted");
    await expect(
      page
        .getByRole("grid", { name: /^Meeting time calendar, / })
        .locator('[aria-selected="true"]')
        .first(),
    ).toHaveAttribute(
      "aria-label",
      /Weighted 50%, unweighted 50% of 1 responses\./,
    );
    await reviewAttendance(page);
    await expect(attendanceTile(page, "Partial")).toHaveText("1");
    await expect(attendanceTile(page, "Available")).toHaveText("0");
    await expect(attendanceTile(page, "Unavailable")).toHaveText("0");
    const patRow = page
      .getByRole("table", { name: "Attendance by person" })
      .getByRole("row", { name: /Pat Painter/ });
    await expect(patRow).toContainText("Submitted");
    await expect(patRow).toContainText("Partly available · 50%");
    const finalization = page.waitForResponse(
      (candidateResponse) =>
        candidateResponse.request().method() === "PUT" &&
        candidateResponse
          .url()
          .includes(`/events/finalization?code=${event1.code}`),
    );
    await page.getByRole("button", { name: "Finalize meeting" }).click();
    expect((await finalization).status()).toBe(202);

    // 6) The participant page does not poll; its Refresh shows the lock.
    const participantRefresh = ppage.getByRole("button", {
      name: "Refresh",
      exact: true,
    });
    await participantRefresh.click();
    await expectLocked(
      ppage,
      "Responses are locked while this event is finalized.",
    );

    // 7) Reactivating unlocks the grid and keeps the painted response.
    let response = await clickLifecycleButton(
      page,
      "Reactivate event",
      event1.code,
    );
    expect(response.status()).toBe(202);
    await participantRefresh.click();
    await expect(ppage.locator(".participant-locked-notice")).toHaveCount(0);
    await expect(grid).not.toHaveAttribute("aria-readonly");
    await expect(
      ppage.getByRole("button", { name: "Update Availability" }),
    ).toBeEnabled();
    await expect(grid.locator(`[data-cell-idx="${mon9}"]`)).toHaveAttribute(
      "data-availability",
      "partial",
    );

    // 8) Closed.
    response = await clickLifecycleButton(page, "Close responses", event1.code);
    expect(response.status()).toBe(200);
    await participantRefresh.click();
    await expectLocked(
      ppage,
      "Responses are locked while this event is closed.",
    );

    // 9) Archived.
    response = await clickLifecycleButton(page, "Archive event", event1.code);
    expect(response.status()).toBe(200);
    await participantRefresh.click();
    await expectLocked(
      ppage,
      "Responses are locked while this event is archived.",
    );

    // 10) The deadline event locks itself once its deadline passes, and the
    // API refuses the write too.
    await ppage.goto(`/event?code=${event3.code}`);
    await expect(ppage.locator(".participant-locked-notice")).toHaveText(
      "The response deadline has passed.",
      { timeout: 60_000 },
    );
    await expect(
      ppage.getByRole("button", { name: /^(Submit|Update) Availability$/ }),
    ).toBeDisabled();
    const mine = await ownResponse(request, ptoken, event3.code);
    const late = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${event3.code}&participantId=${mine.id}`,
      ptoken,
      {
        availabilityInperson: mine.availabilityInperson,
        submitted: 1,
        expectedVersion: mine.version,
      },
    );
    expect(late.response.status()).toBe(409);
    expect(late.payload.error).toBe("The response deadline has passed.");
    await participantContext.close();
  });

  test("archiving a finalized event keeps its confirmed meeting until it is reactivated", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `archive-final-${runId}@example.com`,
      "Ari",
      "Archive",
    );
    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Archive final ${runId}`,
    });
    const { code } = event;
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, token, event, {
      name: "Ada",
      email: `ada-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    const results = await freshResults(request, token, code);
    await finalizeViaApi(request, token, code, results.recommendations[0], {
      location: "Calendar Room",
    });
    const meeting = (await eventState(request, token, code)).finalMeeting;
    expect(meeting).not.toBeNull();

    const controls = eventControls(page);
    const badge = controls.locator(".organizer-lifecycle-panel__status");
    const download = page.getByRole("button", {
      name: "Download calendar (.ics)",
    });

    // 1) Finalized: Archive is offered alongside the calendar download.
    await page.goto(`/event?code=${code}`);
    await expect(badge).toHaveText("finalized");
    await expect(
      controls.getByRole("button", { name: "Archive event", exact: true }),
    ).toBeVisible();
    await expect(download).toBeVisible();

    // 2) Archiving keeps the confirmed meeting and its calendar file.
    const archived = await clickLifecycleButton(page, "Archive event", code);
    expect(archived.status()).toBe(200);
    await expect(badge).toHaveText("archived");
    await expect(
      controls.locator(".organizer-event-controls__lifecycle"),
    ).toHaveText("This event is archived.");
    await expect(
      controls.getByRole("button", { name: "Reactivate event", exact: true }),
    ).toBeVisible();
    await expect(
      controls.getByRole("button", { name: "Archive event", exact: true }),
    ).toHaveCount(0);
    await expect(controls.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".finalized-meeting")).toBeVisible();
    await expect(download).toBeVisible();
    await expect(overviewTile(page, "Confirmed meeting")).toBeVisible();
    const editButton = page.getByRole("button", { name: "Edit event" });
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute(
      "title",
      "Reactivate the event before editing a confirmed meeting.",
    );
    const archivedState = await eventState(request, token, code);
    expect(archivedState.status).toBe("archived");
    expect(archivedState.finalMeeting).not.toBeNull();
    expect(archivedState.finalMeeting.calendarUid).toBe(meeting.calendarUid);
    await expectAccessible(page, "archived workspace with a confirmed meeting");
    expectMeetingCalendar(await downloadCalendar(page), code, meeting);

    // 3) Reactivating cancels the meeting (202, cancellations queued).
    const reactivated = await clickLifecycleButton(
      page,
      "Reactivate event",
      code,
    );
    expect(reactivated.status()).toBe(202);
    await expect(badge).toHaveText("active");
    await expect(page.locator("#organizer-finalize")).toContainText(
      "No time selected yet",
    );
    await expect(page.locator(".finalized-meeting")).toHaveCount(0);
    expect((await eventState(request, token, code)).finalMeeting).toBeNull();
  });

  test("a joined participant sees the confirmed meeting and downloads its calendar file, also after the event is archived", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `final-org-${runId}@example.com`,
      "Flo",
      "Organizer",
    );
    const token = organizer.access;
    await registerAccount(
      page,
      `final-fay-${runId}@example.com`,
      "Fay",
      "Final",
    );
    const ptoken = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Final ${runId}`,
      accessMode: "open_link",
      location: "Board Room",
    });
    const { code } = event;

    // The participant joins and submits through the API.
    const joined = await apiJson(
      request,
      "POST",
      `/events/participants?code=${code}`,
      ptoken,
    );
    expect(joined.response.status()).toBe(201);
    const submitted = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${code}&participantId=${joined.payload.participant.id}`,
      ptoken,
      { submitted: 1, expectedVersion: joined.payload.participant.version },
    );
    expect(submitted.response.status()).toBe(200);
    const results = await freshResults(request, token, code);
    await finalizeViaApi(request, token, code, results.recommendations[0], {
      location: "Board Room",
    });
    const meeting = (await eventState(request, token, code)).finalMeeting;
    expect(meeting).not.toBeNull();
    const [expectedStart, expectedEnd] = await page.evaluate(
      ([startsAt, endsAt]) =>
        [startsAt, endsAt].map((value) =>
          new Date(value).toLocaleString([], { timeZone: "UTC" }),
        ),
      [meeting.startsAt, meeting.endsAt],
    );

    // 1-2) The joined view shows the lock, then the confirmed meeting.
    await page.goto(`/event?code=${code}`);
    await expect(page.getByText(/Welcome, Fay Final/)).toBeVisible();
    const notice = page.locator(".participant-locked-notice");
    await expect(notice).toHaveText(
      "Responses are locked while this event is finalized.",
    );
    const cards = page.locator(
      "main.participant-workspace dl[aria-label='Confirmed meeting']",
    );
    await expect(cards).toBeVisible();
    await expect(cards.locator("dt")).toHaveText([
      "Final Start",
      "Final End",
      "Final Method",
    ]);
    await expect(finalMeetingItem(page, "Final Start")).toHaveText(
      expectedStart,
    );
    await expect(finalMeetingItem(page, "Final End")).toHaveText(expectedEnd);
    await expect(finalMeetingItem(page, "Final Method")).toHaveText(
      "In-Person · Board Room",
    );
    await expectAccessible(page, "participant view of a confirmed meeting");
    expectMeetingCalendar(await downloadCalendar(page), code, meeting);

    // Archiving keeps the meeting on the participant's side too.
    await setLifecycleViaApi(request, token, code, "archived");
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await refresh.click();
    await expect(notice).toHaveText(
      "Responses are locked while this event is archived.",
    );
    await expect(finalMeetingItem(page, "Final Method")).toHaveText(
      "In-Person · Board Room",
    );

    // A failed download reports the API's error in an alert. The failure is
    // stubbed so it does not depend on this page holding a stale event; the
    // next real download clears the alert.
    const calendarUrl = /\/events\/finalization\/calendar\?/;
    const failCalendar = (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({
              error: "No active final meeting has been confirmed",
            }),
          })
        : route.fallback();
    await page.route(calendarUrl, failCalendar);
    await page
      .getByRole("button", { name: "Download calendar (.ics)" })
      .click();
    const calendarAlert = page
      .getByRole("alert")
      .filter({ hasText: "We couldn't download" });
    await expect(calendarAlert).toHaveText(
      "We couldn't download the calendar invitation: No active final meeting has been confirmed",
    );
    await page.unroute(calendarUrl, failCalendar);
    expectMeetingCalendar(await downloadCalendar(page), code, meeting);
    await expect(calendarAlert).toHaveCount(0);

    // Reactivating cancels the meeting: after a refresh the lock, the
    // meeting cards and the download are gone.
    await setLifecycleViaApi(request, token, code, "active");
    await refresh.click();
    await expect(notice).toHaveCount(0);
    await expect(cards).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Download calendar (.ics)" }),
    ).toHaveCount(0);
  });

  // Without Access-Control-Expose-Headers: Content-Disposition the browser
  // hides the header and the web app falls back to saving <code>.ics.
  test("the downloaded calendar file keeps the server's file name", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `ics-name-${runId}@example.com`,
      "Ivy",
      "Calendar",
    );
    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Calendar name ${runId}`,
    });
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, token, event, {
      name: "Ada",
      email: `ada-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    const results = await freshResults(request, token, event.code);
    await finalizeViaApi(
      request,
      token,
      event.code,
      results.recommendations[0],
    );
    await page.goto(`/event?code=${event.code}`);
    const calendar = await downloadCalendar(page);
    expect(calendar.filename).toBe(`releviz-${event.code}-final.ics`);
  });
});
