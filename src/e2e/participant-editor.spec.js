const { expect, test } = require("@playwright/test");
const {
  createEvent,
  eventState,
  newAccountContext,
  newRunId,
  ownResponse,
  readSession,
  recomputeEventResults,
  registerAccount,
  slotIndex,
  submitResponse,
} = require("./helpers/releviz");
const {
  chooseRankedWindow,
  joinEventInBrowser,
  reviewAttendance,
  waitForAutosave,
} = require("./helpers/workspace");

// The participant schedule editors beyond the in-person default. A mixed
// event keeps an In person and a Virtual schedule behind "Schedule channel"
// tabs, with a copy between them that asks before it overwrites a painted
// schedule; a virtual-only event edits only the virtual array and skips the
// slots the organizer blocked. Every paint is followed by its own autosave,
// and the API is the source of truth for what was stored.

const BLOCKED_NOTE =
  "Grey striped times are blocked by the organizer and do not apply to this event.";

// Paints, copies or fills, then waits for the autosave PUT it triggers.
async function saved(page, action) {
  const save = waitForAutosave(page);
  await action();
  await save;
}

test.describe("Participant schedule editors", () => {
  test("edits mixed In person and Virtual schedules with copy and replace, and a virtual-only schedule around organizer blocks", async ({
    browser,
    page,
    request,
  }) => {
    // Two accounts register through the passwordless flow.
    test.setTimeout(180_000);

    const runId = newRunId();
    await registerAccount(
      page,
      `editor-org-${runId}@example.com`,
      "Olga",
      "Organizer",
    );
    const token = (await readSession(page)).access;
    const mixed = await createEvent(request, token, {
      name: `Hybrid editor ${runId}`,
      mode: "mixed",
      location: "Hybrid Room",
      accessMode: "open_link",
    });
    const virtualEvent = await createEvent(request, token, {
      name: `Virtual editor ${runId}`,
      mode: "virtual",
      location: "",
      accessMode: "open_link",
      blockedSlots: { "weekday:1": [0] },
    });
    const allAvailable = Array(mixed.slotCount).fill(1);
    const allBusy = Array(mixed.slotCount).fill(0);

    const participant = await newAccountContext(
      browser,
      `editor-pat-${runId}@example.com`,
      "Pat",
      "Painter",
    );
    const ppage = participant.page;
    const ptoken = participant.token;
    const stored = () => ownResponse(request, ptoken, mixed.code);

    // Mixed event: two tabs, In person first, both channels all Available.
    await joinEventInBrowser(ppage, mixed.code, "Pat Painter");
    const tabs = ppage.getByRole("tablist", { name: "Schedule channel" });
    const inTab = tabs.getByRole("tab", { name: "In person" });
    const vTab = tabs.getByRole("tab", { name: "Virtual" });
    await expect(inTab).toHaveAttribute("aria-selected", "true");
    await expect(vTab).toHaveAttribute("aria-selected", "false");
    await expect(
      ppage.getByRole("heading", { level: 4, name: "In-Person", exact: true }),
    ).toBeVisible();
    const inGrid = ppage.getByRole("grid", { name: "In-Person", exact: true });
    const vGrid = ppage.getByRole("grid", { name: "Virtual", exact: true });
    await expect(inGrid).toBeVisible();
    const copyToVirtual = ppage.getByRole("button", {
      name: "Copy In-Person to Virtual",
    });
    // Both channels start at the same level, so there is nothing to copy.
    await expect(copyToVirtual).toBeDisabled();
    // Nothing is blocked, so the editor shows no legend.
    await expect(
      ppage.getByRole("list", { name: "Availability legend" }),
    ).toHaveCount(0);

    // Busy over the first In person slot changes only that channel.
    const inFirst = inGrid.locator('[data-cell-idx="0"]');
    await saved(ppage, () => inFirst.click());
    await expect(inFirst).toHaveAttribute("aria-selected", "false");
    let response = await stored();
    expect(response.availabilityInperson[0]).toBe(0);
    expect(response.availabilityVirtual).toEqual(allAvailable);

    // Virtual is still untouched, so the copy lands without asking and the
    // editor moves to the channel it just filled.
    await saved(ppage, () => copyToVirtual.click());
    await expect(vTab).toHaveAttribute("aria-selected", "true");
    await expect(vGrid).toBeVisible();
    response = await stored();
    expect(response.availabilityVirtual).toEqual(response.availabilityInperson);
    await expect(
      ppage.getByRole("button", { name: "Copy Virtual to In-Person" }),
    ).toBeDisabled();

    // A Virtual-only paint makes the two schedules differ again.
    await saved(ppage, () => vGrid.locator('[data-cell-idx="1"]').click());
    response = await stored();
    expect(response.availabilityVirtual[1]).toBe(0);
    expect(response.availabilityInperson[1]).toBe(1);

    // The tabs switch from the keyboard.
    await vTab.focus();
    await ppage.keyboard.press("ArrowLeft");
    await expect(inTab).toHaveAttribute("aria-selected", "true");
    await expect(inTab).toBeFocused();

    // Copying over the painted Virtual schedule asks first; Cancel keeps it.
    await copyToVirtual.click();
    const replace = ppage.getByRole("alertdialog", {
      name: "Replace Virtual availability?",
    });
    await expect(replace).toContainText(
      "This copies every In-Person value and replaces the current Virtual schedule.",
    );
    await replace.getByRole("button", { name: "Cancel" }).click();
    await expect(replace).toHaveCount(0);
    await expect(inTab).toHaveAttribute("aria-selected", "true");
    response = await stored();
    expect(response.availabilityVirtual[1]).toBe(0);

    // Replace schedule copies it over and shows the Virtual tab.
    await copyToVirtual.click();
    await saved(ppage, () =>
      replace.getByRole("button", { name: "Replace schedule" }).click(),
    );
    await expect(vTab).toHaveAttribute("aria-selected", "true");
    response = await stored();
    expect(response.availabilityVirtual).toEqual(response.availabilityInperson);
    expect(response.availabilityVirtual[0]).toBe(0);
    expect(response.availabilityVirtual[1]).toBe(1);

    // Apply to all fills both channels of a mixed event.
    await saved(ppage, () =>
      ppage.getByRole("button", { name: "Apply Busy to all" }).click(),
    );
    response = await stored();
    expect(response.availabilityInperson).toEqual(allBusy);
    expect(response.availabilityVirtual).toEqual(allBusy);

    // Virtual-only event: one grid, the organizer's block is greyed out and
    // explained, and the legend lists it.
    const tue9 = slotIndex(virtualEvent, "weekday:2", "09:00");
    const virtualStored = () => ownResponse(request, ptoken, virtualEvent.code);
    await joinEventInBrowser(ppage, virtualEvent.code, "Pat Painter");
    const grid = ppage.getByRole("grid", { name: "Availability", exact: true });
    await expect(
      ppage.getByRole("tablist", { name: "Schedule channel" }),
    ).toHaveCount(0);
    await expect(ppage.getByText("Times shown in UTC")).toBeVisible();
    const notice = ppage.getByRole("note").filter({ hasText: BLOCKED_NOTE });
    await expect(notice).toHaveText(BLOCKED_NOTE);
    await expect(
      ppage.getByRole("list", { name: "Availability legend" }),
    ).toContainText("Blocked");
    const blockedCell = grid.locator('[data-cell-idx="0"]');
    await expect(blockedCell).toHaveAttribute("data-blocked", "true");
    await expect(blockedCell).toHaveAttribute("aria-disabled", "true");

    // Joining seeds both arrays at the starting level, the blocked slot too.
    const startingSchedule = Array(virtualEvent.slotCount).fill(1);
    const joined = await virtualStored();
    expect(joined.availabilityVirtual).toEqual(startingSchedule);
    expect(joined.availabilityInperson).toEqual(startingSchedule);

    // A paint changes only the virtual array.
    await saved(ppage, () => grid.locator('[data-cell-idx="2"]').click());
    let virtualResponse = await virtualStored();
    expect(virtualResponse.availabilityVirtual[2]).toBe(0);
    expect(virtualResponse.availabilityVirtual[0]).toBe(1);
    expect(virtualResponse.availabilityInperson).toEqual(startingSchedule);

    // Fills skip the in-person array and leave the blocked slot at 0.
    await saved(ppage, () =>
      ppage.getByRole("button", { name: "Apply Busy to all" }).click(),
    );
    await saved(ppage, () =>
      ppage.getByRole("button", { name: "Mark all Available" }).click(),
    );
    virtualResponse = await virtualStored();
    expect(virtualResponse.availabilityVirtual[0]).toBe(0);
    expect(virtualResponse.availabilityVirtual.slice(1)).toEqual(
      Array(virtualEvent.slotCount - 1).fill(1),
    );
    expect(virtualResponse.availabilityInperson).toEqual(startingSchedule);
    await participant.context.close();

    // Organizer: a virtual event has no channel switch, ranks virtual
    // windows, and finalizes with a meeting link.
    for (const name of ["Vic", "Val"]) {
      await submitResponse(request, token, virtualEvent, {
        name,
        email: `editor-${name.toLowerCase()}-${runId}@example.com`,
        virtual: [tue9, tue9 + 1],
      });
    }
    recomputeEventResults(virtualEvent.code);
    await page.goto(`/event?code=${virtualEvent.code}`);
    await chooseRankedWindow(page, 0);
    await expect(
      page.getByRole("group", { name: "Meeting channel" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("1 blocked slots are excluded from these results."),
    ).toBeVisible();
    const best = page.locator(".result-option").first();
    await expect(best).toContainText("Tue 09:00–10:00");
    await expect(best).toContainText("Virtual");
    await expect(page.locator(".final-candidate")).toContainText("Virtual");

    // The link is typed before the review, because typing resets it.
    const location = page.getByLabel("Location or meeting link");
    await expect(location).toHaveValue("");
    await location.fill("https://meet.example.com/releviz");
    await reviewAttendance(page);
    const finalization = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PUT" &&
        candidate
          .url()
          .includes(`/events/finalization?code=${virtualEvent.code}`),
    );
    await page.getByRole("button", { name: "Finalize meeting" }).click();
    expect((await finalization).status()).toBe(202);
    await expect(page.locator(".finalized-meeting__meta")).toHaveText(
      "Virtual · https://meet.example.com/releviz",
    );
    const finalState = await eventState(request, token, virtualEvent.code);
    expect(finalState.finalMeeting).toMatchObject({
      channel: "virtual",
      location: "https://meet.example.com/releviz",
    });
  });
});
