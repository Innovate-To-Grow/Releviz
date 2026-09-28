const { expect, test } = require("@playwright/test");
const {
  apiJson,
  createEvent,
  eventState,
  newRunId,
  readSession,
  recomputeEventResults,
  registerAccount,
  selectOption,
  setLifecycleViaApi,
  slotIndex,
  submitResponse,
  updateEventViaApi,
} = require("./helpers/releviz");
const { freezeLiveSync } = require("./helpers/roster");
const { overviewTile } = require("./helpers/workspace");

// Editing an existing event: the workspace's inline editor (cancel, save,
// the response-reset confirmation, a version-conflict reload), the /edit
// page's reset matrix (which fields need a response reset), its conflict
// reload and Cancel link, and the save error on an archived event. Every
// event carries one managed participant, Ada, with a submitted response, so
// a schedule change always asks for a reset.

const CONFLICT_ERROR =
  "The event changed in another session. Reload it and review your edits.";
const RESET_TITLE = "Schedule changes require a response reset";
const RESET_CONFIRMATION =
  "I understand that participant availability will be reset.";

async function rosterRow(request, token, code, email) {
  const roster = await apiJson(
    request,
    "GET",
    `/events/roster?code=${code}&search=${encodeURIComponent(email)}&pageSize=5`,
    token,
  );
  expect(roster.response.status()).toBe(200);
  const row = roster.payload.participants.find(
    (entry) => entry.email === email,
  );
  expect(row, `roster row for ${email}`).toBeTruthy();
  return row;
}

async function adaSubmitted(request, token, code, email) {
  return (await rosterRow(request, token, code, email)).submitted;
}

// Seeds the organizer's event with Ada's submitted response.
async function seedEvent(request, token, overrides, adaEmail) {
  const event = await createEvent(request, token, overrides);
  const mon10 = slotIndex(event, "weekday:1", "10:00");
  await submitResponse(request, token, event, {
    name: "Ada",
    email: adaEmail,
    inperson: [mon10, mon10 + 1],
  });
  expect(await adaSubmitted(request, token, event.code, adaEmail)).toBe(true);
  // A response queues a results invalidation that bumps resultsRevision when
  // it is flushed; flush it now so later revisions count only the edits.
  recomputeEventResults(event.code);
  return eventState(request, token, event.code);
}

function eventUpdate(page, code) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes(`/events?code=${code}`),
  );
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

// Opens /edit and waits for the form to hydrate from its fetch.
async function gotoEdit(page, code, expectedName) {
  await page.goto(`/edit?code=${code}`);
  await expect(page.getByRole("textbox", { name: "Event Name" })).toHaveValue(
    expectedName,
  );
}

// Saves the /edit form and lands back on the workspace.
async function saveAndReturn(page, code) {
  const saved = eventUpdate(page, code);
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/event\\?code=${code}$`));
}

test.describe("Event editing", () => {
  test("edits an event inline: cancel, save, response reset confirmation, and version-conflict reload", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(page, `inline-${runId}@example.com`, "Ina", "Line");
    const token = (await readSession(page)).access;
    const ada = `ada-${runId}@example.com`;
    const event = await seedEvent(
      request,
      token,
      { name: `Inline ${runId}`, location: "Calendar Room" },
      ada,
    );
    const code = event.code;

    // 1) Open the editor.
    await page.goto(`/event?code=${code}`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    const editButton = page.getByRole("button", { name: "Edit event" });
    await expect(editButton).toHaveAttribute("aria-expanded", "false");
    const region = await openInlineEditor(page);
    await expect(
      page.getByRole("heading", { level: 4, name: "Edit event" }),
    ).toBeFocused();
    await expect(region).toContainText(
      "Update this event without leaving the workspace.",
    );
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute("aria-expanded", "true");
    for (const heading of [
      "Schedule",
      "Meeting & access",
      "Advanced options",
    ]) {
      await expect(
        region.getByRole("heading", { level: 5, name: heading }),
      ).toBeVisible();
    }
    await expect(
      region.locator("details.create-event-disclosure"),
    ).not.toHaveAttribute("open");
    const nameBox = region.getByRole("textbox", { name: "Event Name" });
    const locationBox = region.getByRole("textbox", {
      name: "Location / Address",
    });
    const saveButton = region.getByRole("button", { name: "Save changes" });
    await expect(nameBox).toHaveValue(event.name);

    // 2) Cancel closes it and returns focus to the Edit button.
    await region.getByRole("button", { name: "Cancel" }).click();
    await expect(region).toHaveCount(0);
    await expect(editButton).toBeEnabled();
    await expect(editButton).toBeFocused();

    // 3) A plain save needs no reset and leaves Ada's response alone.
    await openInlineEditor(page);
    await nameBox.fill(`Inline ${runId} edited`);
    await locationBox.fill("Room 204");
    let put = eventUpdate(page, code);
    await saveButton.click();
    expect((await put).status()).toBe(200);
    await expect(
      page.getByRole("status").filter({ hasText: "Event changes saved." }),
    ).toBeVisible();
    await expect(region).toHaveCount(0);
    await expect(editButton).toBeFocused();
    await expect(page.locator("h2.organizer-title")).toHaveText(
      `Inline ${runId} edited`,
    );
    await expect(page.locator("h1.event-header-title")).toHaveText(
      `Inline ${runId} edited`,
    );
    await expect(overviewTile(page, "Meeting")).toContainText("Room 204");
    let stored = await eventState(request, token, code);
    expect(stored.name).toBe(`Inline ${runId} edited`);
    expect(stored.location).toBe("Room 204");
    expect(stored.resultsRevision).toBe(event.resultsRevision);
    expect(await adaSubmitted(request, token, code, ada)).toBe(true);

    // 4) A schedule change asks for a response reset first.
    await openInlineEditor(page);
    await region.getByLabel("End Time").fill("17:30");
    put = eventUpdate(page, code);
    await saveButton.click();
    expect((await put).status()).toBe(409);
    await expect(region).toContainText(RESET_TITLE);
    await expect(region).toContainText(
      "Saving will clear draft and submitted availability for 1 participant. Invitations and participant membership will remain.",
    );
    await expect(saveButton).toBeDisabled();
    await region.getByLabel(RESET_CONFIRMATION).check();
    await expect(saveButton).toBeEnabled();
    put = eventUpdate(page, code);
    await saveButton.click();
    const resetResponse = await put;
    expect(resetResponse.status()).toBe(200);
    expect((await resetResponse.json()).responsesReset).toBe(1);
    await expect(
      page.getByRole("status").filter({ hasText: "Event changes saved." }),
    ).toBeVisible();
    await expect(overviewTile(page, "Schedule")).toContainText(
      "9:00 AM - 5:30 PM · UTC",
    );
    stored = await eventState(request, token, code);
    expect(stored.endTime).toBe("17:30");
    expect(stored.slotCount).toBe(85);
    expect(await adaSubmitted(request, token, code, ada)).toBe(false);

    // 5) A save over a newer version reports the conflict; reloading takes
    // the latest event into the form so the edit can be redone. Live sync is
    // held so the workspace never picks up the rename on its own.
    await openInlineEditor(page);
    await expect(nameBox).toHaveValue(`Inline ${runId} edited`);
    const releaseLiveSync = await freezeLiveSync(page);
    const renamed = await updateEventViaApi(request, token, code, {
      name: `Renamed elsewhere ${runId}`,
    });
    const latestVersion = renamed.event.version;
    await locationBox.fill("Room 305");
    put = eventUpdate(page, code);
    await saveButton.click();
    expect((await put).status()).toBe(409);
    await expect(region.locator(".create-event-error")).toHaveText(
      CONFLICT_ERROR,
    );
    await expect(region).toContainText(
      `The latest saved version is ${latestVersion}. Reload before deciding which edits to keep.`,
    );
    await region.getByRole("button", { name: "Reload latest event" }).click();
    await expect(region.locator(".create-event-error")).toHaveCount(0);
    await expect(nameBox).toHaveValue(`Renamed elsewhere ${runId}`);
    await expect(locationBox).toHaveValue("Room 204");
    await locationBox.fill("Room 305");
    put = eventUpdate(page, code);
    await saveButton.click();
    expect((await put).status()).toBe(200);
    await expect(region).toHaveCount(0);
    await releaseLiveSync();
    await expect(page.locator("h2.organizer-title")).toHaveText(
      `Renamed elsewhere ${runId}`,
    );
    await expect(overviewTile(page, "Meeting")).toContainText("Room 305");
    stored = await eventState(request, token, code);
    expect(stored.name).toBe(`Renamed elsewhere ${runId}`);
    expect(stored.location).toBe("Room 305");
  });

  test("saves /edit changes with or without a response reset, reloads after a conflict, and refuses to edit an archived event", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const runId = newRunId();
    await registerAccount(
      page,
      `edit-page-${runId}@example.com`,
      "Eddie",
      "Edit",
    );
    const token = (await readSession(page)).access;
    const ada = `ada-${runId}@example.com`;
    const event = await seedEvent(
      request,
      token,
      { name: `Edit page ${runId}`, meetingDurationMinutes: 60 },
      ada,
    );
    const code = event.code;
    const r0 = event.resultsRevision;

    // 1) The /edit page opens with its Advanced options expanded.
    await gotoEdit(page, code, event.name);
    await expect(page.getByText("Event setup")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Edit event" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Review the schedule and response rules before saving your changes.",
      ),
    ).toBeVisible();
    await expect(
      page.locator("details.create-event-disclosure"),
    ).toHaveAttribute("open", "");
    await expect(
      page.getByText(
        "Changing this updates people who have not started their schedule yet.",
      ),
    ).toBeVisible();

    // 2) A rename saves directly.
    const v2 = `Edit page ${runId} v2`;
    await page.getByRole("textbox", { name: "Event Name" }).fill(v2);
    await saveAndReturn(page, code);
    let stored = await eventState(request, token, code);
    expect(stored.name).toBe(v2);
    expect(stored.resultsRevision).toBe(r0);
    expect(await adaSubmitted(request, token, code, ada)).toBe(true);

    // 3) A meeting type change recomputes results but keeps responses.
    await gotoEdit(page, code, v2);
    await page
      .getByRole("group", { name: "Meeting type" })
      .getByRole("button", { name: "Virtual" })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Location / Address" }),
    ).toHaveCount(0);
    await saveAndReturn(page, code);
    await expect(overviewTile(page, "Meeting")).toContainText(
      "Virtual · 60 minutes",
    );
    await expect(overviewTile(page, "Meeting")).toContainText(
      "Location not set",
    );
    stored = await eventState(request, token, code);
    expect(stored.mode).toBe("virtual");
    expect(stored.location).toBe("");
    expect(stored.resultsRevision).toBe(r0 + 1);
    expect(await adaSubmitted(request, token, code, ada)).toBe(true);

    // 4) So does a meeting duration change.
    await gotoEdit(page, code, v2);
    await page.getByLabel("Meeting Duration").fill("90");
    await saveAndReturn(page, code);
    await expect(
      page.getByText("Top continuous windows for a 90-minute meeting."),
    ).toBeVisible();
    stored = await eventState(request, token, code);
    expect(stored.meetingDurationMinutes).toBe(90);
    expect(stored.resultsRevision).toBe(r0 + 2);
    expect(await adaSubmitted(request, token, code, ada)).toBe(true);

    // 5) A timezone change moves the slots, so it needs a response reset.
    await gotoEdit(page, code, v2);
    await selectOption(page, "Event timezone", "Europe/Berlin");
    const refused = eventUpdate(page, code);
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await refused).status()).toBe(409);
    await expect(page.getByText(RESET_TITLE)).toBeVisible();
    await expect(page.getByText(/for 1 participant\./)).toBeVisible();
    await expect(page).toHaveURL(/\/edit\?code=/);
    await page.getByLabel(RESET_CONFIRMATION).check();
    await saveAndReturn(page, code);
    await expect(overviewTile(page, "Schedule")).toContainText("Europe/Berlin");
    stored = await eventState(request, token, code);
    expect(stored.timezone).toBe("Europe/Berlin");
    expect(stored.resultsRevision).toBe(r0 + 3);
    expect(await adaSubmitted(request, token, code, ada)).toBe(false);

    // 6) A save over a newer version offers a full reload.
    await gotoEdit(page, code, v2);
    const changedName = `Changed elsewhere ${runId}`;
    await updateEventViaApi(request, token, code, { name: changedName });
    await page.getByLabel("Reminder Hours Before Deadline").fill("12");
    const conflicted = eventUpdate(page, code);
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await conflicted).status()).toBe(409);
    const formError = page.locator(".create-event-error");
    await expect(formError).toHaveText(CONFLICT_ERROR);
    await expect(
      page.getByText(
        /The latest saved version is \d+\. Reload before deciding which edits to keep\./,
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reload latest event" }).click();
    await expect(page.getByRole("textbox", { name: "Event Name" })).toHaveValue(
      changedName,
    );
    await expect(page.getByLabel("Reminder Hours Before Deadline")).toHaveValue(
      "24",
    );
    await expect(formError).toHaveCount(0);

    // 7) Cancel returns to the workspace.
    await page
      .getByRole("link", { name: "Cancel and return to event" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/event\\?code=${code}$`));
    await expect(
      page.getByRole("heading", { level: 2, name: changedName }),
    ).toBeVisible();

    // 8) An archived event's settings cannot change.
    await setLifecycleViaApi(request, token, code, "archived");
    await gotoEdit(page, code, changedName);
    await page
      .getByRole("textbox", { name: "Event Name" })
      .fill("Archived rename");
    const locked = eventUpdate(page, code);
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await locked).status()).toBe(400);
    await expect(formError).toHaveText(
      "Scheduling settings cannot change while the event is archived.",
    );
    await expect(page).toHaveURL(/\/edit\?code=/);
    stored = await eventState(request, token, code);
    expect(stored.name).toBe(changedName);
    expect(stored.status).toBe("archived");
  });

  test("a response-reset prompt does not also offer a stale-version reload", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `reset-prompt-${runId}@example.com`,
      "Rita",
      "Reset",
    );
    const token = (await readSession(page)).access;
    const ada = `ada-${runId}@example.com`;
    const event = await seedEvent(
      request,
      token,
      { name: `Reset prompt ${runId}` },
      ada,
    );
    const code = event.code;
    const staleVersionNotice = page.getByText(/The latest saved version is/);
    const reloadButton = page.getByRole("button", {
      name: "Reload latest event",
    });

    // On /edit, the reset prompt is answered in place.
    await gotoEdit(page, code, event.name);
    await page.getByLabel("End Time").fill("17:30");
    let put = eventUpdate(page, code);
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await put).status()).toBe(409);
    await expect(page.getByText(RESET_TITLE)).toBeVisible();
    await expect(staleVersionNotice).toHaveCount(0);
    await expect(reloadButton).toHaveCount(0);
    await page.getByLabel(RESET_CONFIRMATION).check();
    await saveAndReturn(page, code);

    // The inline editor behaves the same way.
    const region = await openInlineEditor(page);
    await region.getByLabel("End Time").fill("18:00");
    put = eventUpdate(page, code);
    await region.getByRole("button", { name: "Save changes" }).click();
    expect((await put).status()).toBe(409);
    await expect(region).toContainText(RESET_TITLE);
    await expect(region.getByText(/The latest saved version is/)).toHaveCount(
      0,
    );
    await expect(
      region.getByRole("button", { name: "Reload latest event" }),
    ).toHaveCount(0);
    await region.getByRole("button", { name: "Cancel" }).click();
    await expect(region).toHaveCount(0);
    expect((await eventState(request, token, code)).endTime).toBe("17:30");
  });
});
