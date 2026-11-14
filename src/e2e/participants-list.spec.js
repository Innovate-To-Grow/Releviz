const { expect, test } = require("@playwright/test");
const {
  expectAccessible,
  expectNoHorizontalScroll,
} = require("./helpers/accessibility");
const {
  apiJson,
  createEvent,
  importRosterApi,
  newRunId,
  registerAccountViaApi,
  runDjangoJson,
  setLifecycleViaApi,
} = require("./helpers/releviz");
const {
  LIVE_SYNC_TIMEOUT_MS,
  addPersonApi,
  continueToConfirm,
  emailField,
  expectToast,
  gotoParticipants,
  importStep,
  openImportSheet,
  openPersonPanel,
  participantRow,
  participantSummary,
  pasteParticipantRows,
  previewImportRows,
  rosterByEmail,
  rosterEntries,
  sendInvitationsApi,
  startOrganizerEvent,
  submitOnBehalf,
  tsv,
  waitForInvitationStatus,
} = require("./helpers/participants");
const { wakeLiveSync } = require("./helpers/workspace");

// The organizer's Participants list after the #177 redesign: the empty and
// failed states, search, the Filter popover and its chips, paging, the
// selection bar's bulk actions (select-all mode, the confirmation beyond a
// page, the group picker's mixed states), the Groups panel (rename, name
// rules, group-wide counting, selecting a group), per-person inclusion, the
// left-out banner, the toast actions, the bulk endpoint's idempotency, and
// axe/overflow checks of the populated list and its panels at phone width.
// Every test registers its own organizer and event and asserts only on its
// own rows.

function personEmail(slug, runId) {
  return `${slug}-${runId}@example.com`;
}

function roster(page) {
  return page.locator("#organizer-roster");
}

function listRows(page) {
  return page.locator("#organizer-roster tr.participants-row");
}

// The names on the current page of the list, in order.
function rowNames(page) {
  return listRows(page)
    .locator(".participants-row__title")
    .allTextContents()
    .then((names) => names.map((name) => name.trim()));
}

function selectionBar(page) {
  return page.getByRole("region", { name: "Selected people" });
}

function selectionHelper(page) {
  return page.locator(".participants-table__helper");
}

function filterButton(page) {
  return roster(page).getByRole("button", { name: /^Filter/ });
}

function filterChip(page, label) {
  return roster(page).getByRole("button", { name: `Remove filter ${label}` });
}

function activeFilters(page) {
  return roster(page).getByRole("list", { name: "Active filters" });
}

function pager(page) {
  return roster(page).locator(".participants-pagination");
}

function groupsPanel(page) {
  return page.getByRole("dialog", { name: "Groups", exact: true });
}

function groupRow(panel, name) {
  return panel.getByRole("row").filter({
    has: panel.page().getByRole("rowheader", { name, exact: true }),
  });
}

// While a group is renamed its name cell holds the input instead.
function renamingRow(panel, name) {
  return panel.getByRole("row").filter({
    has: panel.page().getByRole("textbox", { name: `New name for ${name}` }),
  });
}

// Opens a radio group of the Filter popover (Response, Results) and picks
// one option; the popover stays open for the next pick.
async function pickFilter(page, legend, option) {
  const popoverGroup = roster(page).getByRole("group", {
    name: legend,
    exact: true,
  });
  if (!(await popoverGroup.isVisible())) await filterButton(page).click();
  await popoverGroup.getByRole("radio", { name: option, exact: true }).check();
}

async function closeFilterPopover(page) {
  await filterButton(page).press("Escape");
  await expect(
    roster(page).getByRole("group", { name: "Response", exact: true }),
  ).toHaveCount(0);
}

// The next listing response whose query carries every one of `params`
// (a value of null means the parameter is absent).
function listingResponse(page, params = {}) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    if (
      response.request().method() !== "GET" ||
      !url.pathname.endsWith("/events/roster")
    )
      return false;
    return Object.entries(params).every(
      ([key, value]) => url.searchParams.get(key) === value,
    );
  });
}

function bulkResponse(page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.endsWith("/events/roster/bulk"),
  );
}

// The selection bar's More menu (Set weight…, Count in results, Leave out of
// results).
async function chooseMore(page, item) {
  await selectionBar(page).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

async function openRowMenu(page, name) {
  await participantRow(page, name)
    .getByRole("button", { name: `Actions for ${name}` })
    .click();
}

async function openGroupsPanel(page) {
  await roster(page)
    .getByRole("button", { name: /^Group: / })
    .click();
  await page.getByRole("button", { name: "Manage groups…" }).click();
  const panel = groupsPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function groupMenu(panel, name, item) {
  await groupRow(panel, name)
    .getByRole("button", { name: `Actions for ${name}` })
    .click();
  await panel.page().getByRole("menuitem", { name: item, exact: true }).click();
}

// Thirty people in three bands: Person 01-10 in Team A, 11-20 in Team B and
// 21-30 in no group; Person 12 has a phone number.
function thirtyPeople(runId) {
  return Array.from({ length: 30 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      name: `Person ${number}`,
      email: personEmail(`p${number}`, runId),
      group: index < 10 ? "Team A" : index < 20 ? "Team B" : "",
      phone: number === "12" ? "+1 (555) 424-2424" : "",
    };
  });
}

async function importThirty(request, event, token, runId) {
  const people = thirtyPeople(runId);
  await importRosterApi(
    request,
    event.code,
    token,
    tsv([
      ["name", "email", "group", "phone"],
      ...people.map((person) => [
        person.name,
        person.email,
        person.group,
        person.phone,
      ]),
    ]),
  );
  return people;
}

// Every listed participant (up to 100) keyed by name.
async function rosterByName(request, eventCode, token) {
  const payload = await rosterEntries(request, eventCode, token);
  return new Map(payload.participants.map((entry) => [entry.name, entry]));
}

function groupNames(entry) {
  return entry.groups.map((group) => group.name).sort();
}

test.describe("Participants list: empty and failed states", () => {
  test("adds, imports and adds the organizer from an empty list, and reads as empty once responses close", async ({
    page,
    request,
  }) => {
    const { runId, token, event, organizerName } = await startOrganizerEvent(
      { page, request },
      "list-empty",
    );
    await gotoParticipants(page, event);
    const list = roster(page).locator(".participants-list");
    await expect(
      list.getByRole("heading", { name: "No participants yet" }),
    ).toBeVisible();
    await expect(list).toContainText(
      "Add people one at a time or import a list. Nobody is emailed until you invite them.",
    );
    // An empty list has no search, filters or paging yet.
    await expect(
      roster(page).getByRole("searchbox", { name: "Search participants" }),
    ).toHaveCount(0);

    // The empty state's own buttons open the same panels as the header.
    await list.getByRole("button", { name: "+ Add person" }).click();
    const addPanel = page.getByRole("dialog", { name: "Add a person" });
    await expect(addPanel).toBeVisible();
    await expect(
      addPanel.getByRole("textbox", { name: "Full name" }),
    ).toBeVisible();
    await addPanel.getByRole("button", { name: "Done" }).click();
    await expect(addPanel).toHaveCount(0);

    await list.getByRole("button", { name: "Import a spreadsheet" }).click();
    const sheet = page.getByRole("dialog", { name: "Import participants" });
    await expect(sheet).toBeVisible();
    await expect(importStep(sheet)).toHaveText("Source");
    await sheet.getByRole("button", { name: "Close dialog" }).click();
    await expect(sheet).toHaveCount(0);

    // Add myself puts the organizer on the list and opens their schedule.
    await list.getByRole("button", { name: "Add myself" }).click();
    const ownDrawer = page.getByRole("dialog", { name: "Edit my schedule" });
    await expect(ownDrawer).toBeVisible();
    await expectToast(page, "You're on the list. Your schedule is open.");
    await ownDrawer
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(ownDrawer).toHaveCount(0);
    await expect(participantRow(page, organizerName)).toContainText(
      `${organizerName} (you)`,
    );
    await expect(
      page.getByRole("heading", { name: "No participants yet" }),
    ).toHaveCount(0);
    await expect(participantSummary(page)).toContainText("1 person");
    // With someone on it the list gets its search box.
    await expect(
      roster(page).getByRole("searchbox", { name: "Search participants" }),
    ).toBeVisible();
    const joined = await rosterEntries(request, event.code, token);
    expect(joined.organizerOnRoster).toBe(true);

    // An empty list on an event whose responses are closed offers nothing.
    const closedEvent = await createEvent(request, token, {
      name: `list-empty closed ${runId}`,
    });
    await setLifecycleViaApi(request, token, closedEvent.code, "closed");
    await gotoParticipants(page, closedEvent);
    const closedList = roster(page).locator(".participants-list");
    await expect(
      closedList.getByRole("heading", { name: "No participants yet" }),
    ).toBeVisible();
    await expect(closedList).toContainText(
      "This event does not have any participants.",
    );
    await expect(closedList.getByRole("button")).toHaveCount(0);
    await expect(
      roster(page).getByText(
        "Responses are closed, so this list is read-only. Reactivate the event to make changes.",
      ),
    ).toBeVisible();
    const actions = page.getByRole("group", { name: "Participant actions" });
    await expect(
      actions.getByRole("button", { name: "+ Add person" }),
    ).toBeDisabled();
    await expect(
      actions.getByRole("button", { name: "Import", exact: true }),
    ).toBeDisabled();
  });

  test("reports a failed list load and loads again with Try again", async ({
    page,
    request,
  }) => {
    const { token, event } = await startOrganizerEvent(
      { page, request },
      "list-error",
    );
    await addPersonApi(request, event.code, token, {
      name: "Rita Retry",
      organizerManaged: true,
    });
    // Every listing fails until the route is removed, so a second load while
    // the workspace settles cannot replace the failure. Live sync never
    // reloads a list that has not loaded once, so only Try again loads it
    // afterwards. The real response is fetched so the failure keeps the
    // backend's CORS headers.
    const listing = /\/events\/roster\?/;
    const failListing = async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "The participant list is temporarily unavailable.",
        }),
      });
    };
    await page.route(listing, failListing);
    await gotoParticipants(page, event);
    const failure = roster(page)
      .getByRole("alert")
      .filter({ hasText: "The participant list is temporarily unavailable." });
    await expect(failure).toBeVisible();
    await expect(listRows(page)).toHaveCount(0);

    await page.unroute(listing, failListing);
    const reloaded = listingResponse(page);
    await failure.getByRole("button", { name: "Try again" }).click();
    expect((await reloaded).status()).toBe(200);
    await expect(failure).toHaveCount(0);
    await expect(participantRow(page, "Rita Retry")).toBeVisible();
    await expect(participantSummary(page)).toContainText("1 person");
  });
});

test.describe("Participants list: search, filters and paging", () => {
  test("searches by email, phone, group and name after a pause, with a removable chip", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-search",
    );
    await importThirty(request, event, token, runId);
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(30);
    const search = roster(page).getByRole("searchbox", {
      name: "Search participants",
    });

    await search.fill(`p07-${runId}`);
    await expect.poll(() => rowNames(page)).toEqual(["Person 07"]);
    await expect(filterChip(page, `Search: p07-${runId}`)).toBeVisible();
    await expect(participantSummary(page)).toContainText(
      "Showing 1 of 30 people",
    );

    await search.fill("(555) 424");
    await expect.poll(() => rowNames(page)).toEqual(["Person 12"]);
    await expect(participantRow(page, "Person 12")).toContainText(
      "+1 (555) 424-2424",
    );

    await search.fill("team b");
    await expect(listRows(page)).toHaveCount(10);
    await expect
      .poll(() => rowNames(page))
      .toEqual(
        Array.from({ length: 10 }, (_, index) => `Person ${index + 11}`),
      );
    await expect(participantSummary(page)).toContainText(
      "Showing 10 of 30 people",
    );

    // Removing the chip empties the box and shows everyone again.
    await filterChip(page, "Search: team b").click();
    await expect(search).toHaveValue("");
    await expect(listRows(page)).toHaveCount(30);
    await expect(activeFilters(page)).toHaveCount(0);

    // Typing waits for a 300 ms pause: the list is asked for the whole term,
    // not for each letter on the way there. Keys are sent back to back, but
    // one stall between two of them on a loaded machine could outlast the
    // pause, so a single partial term is tolerated (without the pause the
    // list would be asked seven times).
    const searched = [];
    page.on("request", (candidate) => {
      const url = new URL(candidate.url());
      if (
        candidate.method() === "GET" &&
        url.pathname.endsWith("/events/roster") &&
        url.searchParams.has("search")
      )
        searched.push(url.searchParams.get("search"));
    });
    await search.pressSequentially("PERSON 1");
    await expect(listRows(page)).toHaveCount(10);
    await expect
      .poll(() => rowNames(page))
      .toEqual(
        Array.from({ length: 10 }, (_, index) => `Person ${index + 10}`),
      );
    expect(searched.at(-1)).toBe("PERSON 1");
    expect(searched.filter((term) => !"PERSON 1".startsWith(term))).toEqual([]);
    expect(new Set(searched).size).toBeLessThanOrEqual(2);

    // A new search starts again from the first page.
    await search.fill("");
    await expect(listRows(page)).toHaveCount(30);
    await pager(page).getByLabel("Rows per page").selectOption("25");
    await expect(pager(page)).toContainText("Page 1 of 2");
    await pager(page).getByRole("button", { name: "Next" }).click();
    await expect(pager(page)).toContainText("Page 2 of 2");
    await expect(listRows(page)).toHaveCount(5);
    await search.fill("Person");
    await expect(pager(page)).toContainText("Page 1 of 2");
    await expect(listRows(page)).toHaveCount(25);
    await expect(participantRow(page, "Person 01")).toBeVisible();

    // ...and drops a selection of everyone matching the old search.
    await roster(page)
      .getByRole("checkbox", { name: "Select everyone on this page" })
      .check();
    await selectionHelper(page)
      .getByRole("button", { name: "Select all 30 matching" })
      .click();
    await expect(selectionBar(page)).toContainText(
      "30 selected · everyone matching the filter",
    );
    await search.fill("Person 0");
    await expect(listRows(page)).toHaveCount(9);
    await expect(selectionBar(page)).toContainText(
      "25 selected · 16 not on this page",
    );
    await expect(selectionHelper(page)).toHaveCount(0);
  });

  test("removing the search chip starts again from page one and drops a selection of everyone matching", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-search-chip",
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ...thirtyPeople(runId).map((person) => [person.name, person.email]),
        ["Zed Other", personEmail("zed", runId)],
        ["Yan Other", personEmail("yan", runId)],
      ]),
    );
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(32);
    await pager(page).getByLabel("Rows per page").selectOption("25");
    const search = roster(page).getByRole("searchbox", {
      name: "Search participants",
    });
    await search.fill("Person");
    await expect(participantSummary(page)).toContainText(
      "Showing 30 of 32 people",
    );
    await expect(pager(page)).toContainText("Page 1 of 2");
    await roster(page)
      .getByRole("checkbox", { name: "Select everyone on this page" })
      .check();
    await selectionHelper(page)
      .getByRole("button", { name: "Select all 30 matching" })
      .click();
    await expect(selectionBar(page)).toContainText(
      "30 selected · everyone matching the filter",
    );
    await pager(page).getByRole("button", { name: "Next" }).click();
    await expect(pager(page)).toContainText("Page 2 of 2");

    // Taking the search away changes the filter like removing any other chip
    // or clearing the box by hand: the list starts from page one, and the
    // selection falls back to the 25 people ticked on the page instead of
    // silently growing to everyone on the list.
    await filterChip(page, "Search: Person").click();
    await expect(search).toHaveValue("");
    await expect(participantSummary(page)).toHaveText(/^32 people ·/);
    await expect(selectionBar(page).getByRole("status")).toHaveText(
      "25 selected",
    );
    await expect(pager(page)).toContainText("Page 1 of 2");
    await expect(listRows(page).first()).toContainText("Person 01");
  });

  test("filters by response (answers and how far the invitation got) and results, and clears a filter that matches nobody", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-filters",
    );
    const emails = {
      ann: personEmail("ann", runId),
      ben: personEmail("ben", runId),
      sid: personEmail("sid", runId),
      quinn: personEmail("quinn", runId),
      fay: personEmail("fay", runId),
      acy: personEmail("acy", runId),
      lou: personEmail("lou", runId),
      nia: personEmail("nia", runId),
    };
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "included"],
        ["Ann Answered", emails.ann, "true"],
        ["Ben Answered", emails.ben, "true"],
        ["Sid Sent", emails.sid, "true"],
        ["Quinn Queued", emails.quinn, "true"],
        ["Fay Failed", emails.fay, "true"],
        ["Acy Accepted", emails.acy, "true"],
        ["Lou Leftout", emails.lou, "false"],
        ["Nia Nobody", emails.nia, "true"],
      ]),
    );
    const byEmail = await rosterByEmail(request, event.code, token);
    await submitOnBehalf(request, token, event, byEmail.get(emails.ann));
    await submitOnBehalf(request, token, event, byEmail.get(emails.ben));
    await sendInvitationsApi(request, event.code, token, [
      byEmail.get(emails.sid).id,
      byEmail.get(emails.quinn).id,
      byEmail.get(emails.fay).id,
      byEmail.get(emails.acy).id,
    ]);
    for (const email of [emails.sid, emails.quinn, emails.fay, emails.acy]) {
      await waitForInvitationStatus(request, event.code, token, email, "sent");
    }
    // Quinn's invitation email waits for a retry a day away (Sending invite…),
    // Fay's was given up on (Invite failed), and Acy followed the link
    // (Started, recorded the way joining through an invitation records it).
    // Only this event's rows are touched.
    const delivery = runDjangoJson(
      `
from datetime import timedelta

from django.utils import timezone

from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import EventInvitation

now = timezone.now()
jobs = EmailDeliveryJob.objects.filter(
    event__code=data["code"], message_type="invitation"
)
queued = jobs.filter(recipient__iexact=data["queued"]).update(
    status=EmailDeliveryJob.Status.RETRY,
    next_attempt_at=now + timedelta(days=1),
)
failed = jobs.filter(recipient__iexact=data["failed"]).update(
    status=EmailDeliveryJob.Status.PERMANENT_FAILURE,
)
accepted = EventInvitation.objects.filter(
    event__code=data["code"], email__iexact=data["accepted"]
).update(status=EventInvitation.Status.JOINED, accepted_at=now, joined_at=now)
print(json.dumps({"queued": queued, "failed": failed, "accepted": accepted}))
`,
      {
        code: event.code,
        queued: emails.quinn,
        failed: emails.fay,
        accepted: emails.acy,
      },
    );
    expect(delivery).toEqual({ queued: 1, failed: 1, accepted: 1 });

    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(8);
    await expect(filterButton(page)).toHaveText("Filter");

    let listed = listingResponse(page, { submitted: "true" });
    await pickFilter(page, "Response", "Submitted");
    expect(
      (await (await listed).json()).participants.map((entry) => entry.name),
    ).toEqual(["Ann Answered", "Ben Answered"]);
    await expect
      .poll(() => rowNames(page))
      .toEqual(["Ann Answered", "Ben Answered"]);
    await expect(filterChip(page, "Response: Submitted")).toBeVisible();
    await expect(
      filterButton(page).locator(".participants-popover__count"),
    ).toHaveText("1 active");
    await expect(participantSummary(page)).toContainText(
      "Showing 2 of 8 people",
    );

    await pickFilter(page, "Response", "Not submitted");
    await expect(listRows(page)).toHaveCount(6);
    await expect(filterChip(page, "Response: Not submitted")).toBeVisible();

    // The same Response group reads how far an invitation got, the delivery
    // state included. Each option sets the answer and the invitation filter
    // together, and still counts as one filter with one chip.
    const responseBadge = (name) =>
      participantRow(page, name).locator(".participants-table__response");
    listed = listingResponse(page, {
      submitted: null,
      invitationStatus: "queued",
    });
    await pickFilter(page, "Response", "Sending invite");
    expect(
      (await (await listed).json()).participants.map((entry) => entry.name),
    ).toEqual(["Quinn Queued"]);
    await expect.poll(() => rowNames(page)).toEqual(["Quinn Queued"]);
    await expect(responseBadge("Quinn Queued")).toHaveText("Sending invite…");
    await expect(filterChip(page, "Response: Sending invite")).toBeVisible();
    await expect(
      filterButton(page).locator(".participants-popover__count"),
    ).toHaveText("1 active");

    listed = listingResponse(page, { invitationStatus: "failed" });
    await pickFilter(page, "Response", "Invite failed");
    expect(
      (await (await listed).json()).participants.map((entry) => entry.name),
    ).toEqual(["Fay Failed"]);
    await expect.poll(() => rowNames(page)).toEqual(["Fay Failed"]);
    await expect(responseBadge("Fay Failed")).toHaveText("Invite failed");

    listed = listingResponse(page, {
      submitted: "false",
      invitationStatus: "accepted",
    });
    await pickFilter(page, "Response", "Started");
    expect(
      (await (await listed).json()).participants.map((entry) => entry.name),
    ).toEqual(["Acy Accepted"]);
    await expect.poll(() => rowNames(page)).toEqual(["Acy Accepted"]);
    await expect(responseBadge("Acy Accepted")).toHaveText("Started");

    // Invited is everyone invited who has not accepted or answered, whatever
    // became of the email; each row still says how far its email got.
    await pickFilter(page, "Response", "Invited");
    await expect
      .poll(() => rowNames(page))
      .toEqual(["Sid Sent", "Quinn Queued", "Fay Failed"]);
    await expect(responseBadge("Sid Sent")).toHaveText("Invited");
    await expect(responseBadge("Quinn Queued")).toHaveText("Sending invite…");
    await expect(responseBadge("Fay Failed")).toHaveText("Invite failed");
    await pickFilter(page, "Response", "Not invited yet");
    await expect
      .poll(() => rowNames(page))
      .toEqual(["Lou Leftout", "Nia Nobody"]);
    await expect(responseBadge("Nia Nobody")).toHaveText("Not invited");

    listed = listingResponse(page, { included: "false" });
    await pickFilter(page, "Results", "Left out");
    expect(
      (await (await listed).json()).participants.map((entry) => entry.name),
    ).toEqual(["Lou Leftout"]);
    await expect.poll(() => rowNames(page)).toEqual(["Lou Leftout"]);
    await expect(
      filterButton(page).locator(".participants-popover__count"),
    ).toHaveText("2 active");
    await expect(activeFilters(page).getByRole("button")).toHaveText([
      "Response: Not invited yet×",
      "Results: Left out×",
      "Clear all",
    ]);

    // Acy, the only one who started, is counted: nobody matches, and the
    // list says so and offers Clear all.
    await pickFilter(page, "Response", "Started");
    await closeFilterPopover(page);
    const list = roster(page).locator(".participants-list");
    await expect(
      list.getByRole("heading", { name: "No matching participants." }),
    ).toBeVisible();
    await expect(list).toContainText("Try another search, or Clear all");
    await expect(listRows(page)).toHaveCount(0);
    await expect(participantSummary(page)).toContainText(
      "Showing 0 of 8 people",
    );
    await list.getByRole("button", { name: "Clear all" }).click();
    await expect(listRows(page)).toHaveCount(8);
    await expect(activeFilters(page)).toHaveCount(0);
    await expect(filterButton(page)).toHaveText("Filter");
    await filterButton(page).click();
    await expect(
      roster(page).getByRole("group", { name: "Invitation", exact: true }),
    ).toHaveCount(0);
    for (const legend of ["Response", "Results"]) {
      await expect(
        roster(page)
          .getByRole("group", { name: legend, exact: true })
          .getByRole("radio", { name: "Any" }),
      ).toBeChecked();
    }

    // A chip removes its own filter; the chips' Clear all removes the rest.
    await pickFilter(page, "Results", "Counted");
    await expect(listRows(page)).toHaveCount(7);
    await expect(participantRow(page, "Lou Leftout")).toHaveCount(0);
    await pickFilter(page, "Response", "Not submitted");
    await expect(listRows(page)).toHaveCount(5);
    await closeFilterPopover(page);
    await filterChip(page, "Results: Counted").click();
    await expect(listRows(page)).toHaveCount(6);
    await expect(filterChip(page, "Response: Not submitted")).toBeVisible();
    await activeFilters(page)
      .getByRole("button", { name: "Clear all" })
      .click();
    await expect(listRows(page)).toHaveCount(8);
    await expect(activeFilters(page)).toHaveCount(0);
  });

  test("pages a list of more than 25 people and falls back to the last page when people leave", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-paging",
    );
    const people = await importThirty(request, event, token, runId);
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(30);
    const rowsPerPage = pager(page).getByLabel("Rows per page");
    const previous = pager(page).getByRole("button", { name: "Previous" });
    const next = pager(page).getByRole("button", { name: "Next" });
    await expect(rowsPerPage).toHaveValue("50");
    await expect(pager(page)).toContainText("Page 1 of 1");
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();

    let listed = listingResponse(page, { page: "1", pageSize: "25" });
    await rowsPerPage.selectOption("25");
    await listed;
    await expect(pager(page)).toContainText("Page 1 of 2");
    await expect(listRows(page)).toHaveCount(25);
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();

    listed = listingResponse(page, { page: "2", pageSize: "25" });
    await next.click();
    await listed;
    await expect(pager(page)).toContainText("Page 2 of 2");
    await expect
      .poll(() => rowNames(page))
      .toEqual(people.slice(25).map((person) => person.name));
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(pager(page)).toContainText("Page 1 of 2");
    await expect(listRows(page).first()).toContainText("Person 01");

    await rowsPerPage.selectOption("100");
    await expect(pager(page)).toContainText("Page 1 of 1");
    await expect(listRows(page)).toHaveCount(30);
    await rowsPerPage.selectOption("25");
    await next.click();
    await expect(pager(page)).toContainText("Page 2 of 2");
    await expect(listRows(page)).toHaveCount(5);

    // Everyone on page 2 is removed elsewhere: the list falls back to the
    // last page left, and with 25 people it no longer pages at all.
    const byEmail = await rosterByEmail(request, event.code, token);
    for (const person of people.slice(25)) {
      const removed = await apiJson(
        request,
        "DELETE",
        `/events/roster/${byEmail.get(person.email).id}?code=${event.code}`,
        token,
      );
      expect(removed.response.status()).toBe(200);
    }
    await wakeLiveSync(page);
    await expect(participantSummary(page)).toContainText("25 people", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(listRows(page)).toHaveCount(25);
    await expect(listRows(page).first()).toContainText("Person 01");
    await expect(pager(page)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "No matching participants." }),
    ).toHaveCount(0);
  });
});

test.describe("Participants list: selection and bulk changes", () => {
  test("selects everyone matching a filter and confirms bulk changes that reach past the page", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-select-all",
    );
    await importThirty(request, event, token, runId);
    const byName = await rosterByName(request, event.code, token);
    await submitOnBehalf(request, token, event, byName.get("Person 01"));
    await submitOnBehalf(request, token, event, byName.get("Person 02"));
    const bulkRequests = [];
    page.on("request", (candidate) => {
      if (
        candidate.method() === "PATCH" &&
        new URL(candidate.url()).pathname.endsWith("/events/roster/bulk")
      )
        bulkRequests.push(candidate.postDataJSON());
    });

    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(30);
    await pager(page).getByLabel("Rows per page").selectOption("25");
    await pickFilter(page, "Response", "Not submitted");
    await closeFilterPopover(page);
    await expect(participantSummary(page)).toContainText(
      "Showing 28 of 30 people",
    );
    await expect(listRows(page)).toHaveCount(25);

    await roster(page)
      .getByRole("checkbox", { name: "Select everyone on this page" })
      .check();
    await expect(selectionBar(page)).toContainText("25 selected");
    await expect(selectionHelper(page)).toContainText(
      "All 25 people on this page are selected.",
    );
    await selectionHelper(page)
      .getByRole("button", { name: "Select all 28 matching" })
      .click();
    await expect(selectionHelper(page)).toHaveText(
      "Everyone matching the filter is selected (28).",
    );
    await expect(selectionBar(page)).toContainText(
      "28 selected · everyone matching the filter",
    );

    // Select-all mode always asks first; Cancel sends nothing.
    await chooseMore(page, "Leave out of results");
    const confirm = page.getByRole("dialog", { name: "Apply to 28 people?" });
    await expect(confirm).toContainText(
      "This changes everyone selected, including people not on this page.",
    );
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(bulkRequests).toEqual([]);

    await chooseMore(page, "Leave out of results");
    let bulk = bulkResponse(page);
    await confirm.getByRole("button", { name: "Apply", exact: true }).click();
    let answered = await bulk;
    expect(answered.request().postDataJSON()).toMatchObject({
      filter: { submitted: "false" },
      updates: { included: false },
    });
    expect(answered.request().postDataJSON()).not.toHaveProperty(
      "participantIds",
    );
    expect(await answered.json()).toMatchObject({ matchedCount: 28 });
    await expectToast(page, "Left 28 people out of the results.");
    await expect(
      roster(page).getByText("28 people are left out of the results."),
    ).toBeVisible();
    let entries = await rosterByName(request, event.code, token);
    expect(entries.get("Person 01").included).toBe(true);
    expect(entries.get("Person 02").included).toBe(true);
    expect(entries.get("Person 03").included).toBe(false);
    expect(entries.get("Person 30").included).toBe(false);

    // The picker for everyone matching starts with every box mixed and no
    // counts, and Apply waits for a real change.
    await selectionBar(page).getByRole("button", { name: "Groups…" }).click();
    const picker = page.getByRole("dialog", {
      name: "Groups for 28 selected people",
    });
    const apply = picker.getByRole("button", { name: "Apply", exact: true });
    const everyGroup = picker.getByRole("checkbox", {
      name: "Every group, including groups added later",
    });
    const teamA = picker.getByRole("checkbox", { name: "Team A" });
    const teamB = picker.getByRole("checkbox", { name: "Team B" });
    for (const box of [everyGroup, teamA, teamB]) {
      await expect(box).toBeChecked({ indeterminate: true });
    }
    await expect(picker.locator(".participants-picker__count")).toHaveCount(0);
    await expect(apply).toBeDisabled();
    // A mixed box cycles through all and none back to mixed.
    await teamB.click();
    await expect(teamB).toBeChecked();
    await expect(apply).toBeEnabled();
    await teamB.click();
    // Unchecked and no longer mixed (toBeChecked ignores the mixed state).
    await expect(teamB).not.toBeChecked();
    await expect(teamB).not.toBeChecked({ indeterminate: true });
    await teamB.click();
    await expect(teamB).toBeChecked({ indeterminate: true });
    await expect(apply).toBeDisabled();
    await teamB.click();
    await expect(teamB).toBeChecked();
    await apply.click();
    const groupsConfirm = page.getByRole("dialog", {
      name: "Apply to 28 people?",
    });
    bulk = bulkResponse(page);
    await groupsConfirm
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    answered = await bulk;
    expect(answered.request().postDataJSON()).toMatchObject({
      filter: { submitted: "false" },
      updates: { addGroups: ["Team B"] },
    });
    expect(answered.request().postDataJSON().updates).toEqual({
      addGroups: ["Team B"],
    });
    // The toast counts the people whose groups changed: Person 11-20 were
    // in Team B already.
    expect(await answered.json()).toMatchObject({
      matchedCount: 28,
      updatedCount: 18,
    });
    await expectToast(page, "Updated groups for 18 people.");
    entries = await rosterByName(request, event.code, token);
    expect(groupNames(entries.get("Person 01"))).toEqual(["Team A"]);
    expect(groupNames(entries.get("Person 03"))).toEqual(["Team A", "Team B"]);
    expect(groupNames(entries.get("Person 25"))).toEqual(["Team B"]);

    // Picked person by person across both pages, 30 people also ask first,
    // and the request names each of them.
    await selectionBar(page).getByRole("button", { name: "Clear" }).click();
    await expect(selectionBar(page)).toHaveCount(0);
    await filterChip(page, "Response: Not submitted").click();
    await expect(pager(page)).toContainText("Page 1 of 2");
    const selectPage = roster(page).getByRole("checkbox", {
      name: "Select everyone on this page",
    });
    await selectPage.check();
    await pager(page).getByRole("button", { name: "Next" }).click();
    await expect(pager(page)).toContainText("Page 2 of 2");
    await expect(selectPage).not.toBeChecked();
    await selectPage.check();
    await expect(selectionBar(page)).toContainText(
      "30 selected · 25 not on this page",
    );
    await chooseMore(page, "Count in results");
    const everyoneConfirm = page.getByRole("dialog", {
      name: "Apply to 30 people?",
    });
    bulk = bulkResponse(page);
    await everyoneConfirm
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    answered = await bulk;
    const countedIn = answered.request().postDataJSON();
    expect(countedIn.participantIds).toHaveLength(30);
    expect(countedIn).not.toHaveProperty("filter");
    expect(countedIn.updates).toEqual({ included: true });
    // Person 01 and 02 were counted already.
    expect(await answered.json()).toMatchObject({
      matchedCount: 30,
      updatedCount: 28,
    });
    await expectToast(page, "28 people now count in the results.");
    await expect(
      roster(page).getByText(/left out of the results\./),
    ).toHaveCount(0);

    // A few people on one page change straight away.
    await selectionBar(page).getByRole("button", { name: "Clear" }).click();
    await page.getByRole("checkbox", { name: "Select Person 26" }).check();
    await page.getByRole("checkbox", { name: "Select Person 27" }).check();
    bulk = bulkResponse(page);
    await chooseMore(page, "Leave out of results");
    answered = await bulk;
    expect(answered.request().postDataJSON().participantIds).toHaveLength(2);
    await expectToast(page, "Left 2 people out of the results.");
    await expect(page.getByRole("dialog", { name: /^Apply to / })).toHaveCount(
      0,
    );
    await expect(participantRow(page, "Person 26")).toContainText(
      "Left out of results",
    );
    await expect(
      roster(page).getByText("2 people are left out of the results."),
    ).toBeVisible();
  });

  test("shows mixed group membership with counts and adds, removes and widens groups for several people", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-picker",
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group"],
        ["Ann Alpha", personEmail("ann", runId), "Faculty"],
        ["Al Alpha", personEmail("al", runId), "Faculty; Staff"],
        ["Bea Beta", personEmail("bea", runId), ""],
        ["Cy Gamma", personEmail("cy", runId), "Staff"],
      ]),
    );
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(4);
    const select = (name) =>
      page.getByRole("checkbox", { name: `Select ${name}`, exact: true });
    await select("Ann Alpha").check();
    await select("Al Alpha").check();
    await select("Cy Gamma").check();
    await expect(selectionBar(page)).toContainText("3 selected");

    await selectionBar(page).getByRole("button", { name: "Groups…" }).click();
    const picker = page.getByRole("dialog", {
      name: "Groups for 3 selected people",
    });
    const everyGroup = picker.getByRole("checkbox", {
      name: "Every group, including groups added later",
    });
    const faculty = picker.getByRole("checkbox", { name: "Faculty" });
    const staff = picker.getByRole("checkbox", { name: "Staff" });
    const apply = picker.getByRole("button", { name: "Apply", exact: true });
    await expect(everyGroup).not.toBeChecked();
    await expect(everyGroup).toHaveAccessibleDescription("0 of 3");
    await expect(faculty).toBeChecked({ indeterminate: true });
    await expect(faculty).toHaveAccessibleDescription("2 of 3");
    await expect(staff).toBeChecked({ indeterminate: true });
    await expect(staff).toHaveAccessibleDescription("2 of 3");
    await expect(apply).toBeDisabled();

    // Faculty: mixed, then everyone, then nobody, then back to mixed.
    await faculty.click();
    await expect(faculty).toHaveAccessibleDescription("3 of 3");
    await faculty.click();
    await expect(faculty).toHaveAccessibleDescription("0 of 3");
    await faculty.click();
    await expect(faculty).toBeChecked({ indeterminate: true });
    await expect(faculty).toHaveAccessibleDescription("2 of 3");
    // Take Faculty away from everyone and give everyone Staff.
    await faculty.click();
    await faculty.click();
    await expect(faculty).not.toBeChecked();
    await staff.click();
    await expect(staff).toBeChecked();
    await expect(staff).toHaveAccessibleDescription("3 of 3");
    let bulk = bulkResponse(page);
    await apply.click();
    let answered = await bulk;
    const moved = answered.request().postDataJSON();
    expect(moved.participantIds).toHaveLength(3);
    expect(moved.updates).toEqual({
      addGroups: ["Staff"],
      removeGroups: ["Faculty"],
    });
    // Cy already had Staff and no Faculty, so two of the three changed.
    expect(await answered.json()).toMatchObject({
      matchedCount: 3,
      updatedCount: 2,
    });
    await expectToast(page, "Updated groups for 2 people.");
    for (const name of ["Ann Alpha", "Al Alpha", "Cy Gamma"]) {
      await expect(
        participantRow(page, name).locator(".participants-table__groups"),
      ).toHaveText("Staff");
    }
    await expect(
      participantRow(page, "Bea Beta").locator(".participants-table__groups"),
    ).toHaveText("—No group");

    // Every group, for two of them: the named boxes step aside while it is on.
    await select("Cy Gamma").uncheck();
    await expect(selectionBar(page)).toContainText("2 selected");
    await selectionBar(page).getByRole("button", { name: "Groups…" }).click();
    const pairPicker = page.getByRole("dialog", {
      name: "Groups for 2 selected people",
    });
    const pairEvery = pairPicker.getByRole("checkbox", {
      name: "Every group, including groups added later",
    });
    await expect(
      pairPicker.getByRole("checkbox", { name: "Staff" }),
    ).toHaveAccessibleDescription("2 of 2");
    await expect(
      pairPicker.getByRole("checkbox", { name: "Faculty" }),
    ).not.toBeChecked();
    await pairEvery.check();
    await expect(pairEvery).toHaveAccessibleDescription("2 of 2");
    await expect(
      pairPicker.getByRole("checkbox", { name: "Faculty" }),
    ).toBeDisabled();
    await expect(
      pairPicker.getByRole("checkbox", { name: "Staff" }),
    ).toBeDisabled();
    bulk = bulkResponse(page);
    await pairPicker
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    answered = await bulk;
    expect(answered.request().postDataJSON().updates).toEqual({
      allGroups: true,
    });
    await expectToast(page, "Updated groups for 2 people.");
    await expect(
      participantRow(page, "Ann Alpha").locator(".participants-table__groups"),
    ).toHaveText("Every group");
    await expect(
      participantRow(page, "Al Alpha").locator(".participants-table__groups"),
    ).toHaveText("Every group");

    // One with every group and one without: the flag itself is mixed.
    await select("Al Alpha").uncheck();
    await select("Cy Gamma").check();
    await selectionBar(page).getByRole("button", { name: "Groups…" }).click();
    const mixedPicker = page.getByRole("dialog", {
      name: "Groups for 2 selected people",
    });
    const mixedEvery = mixedPicker.getByRole("checkbox", {
      name: "Every group, including groups added later",
    });
    await expect(mixedEvery).toBeChecked({ indeterminate: true });
    await expect(mixedEvery).toHaveAccessibleDescription("1 of 2");
    await mixedPicker.getByRole("button", { name: "Cancel" }).click();
    await expect(mixedPicker).toHaveCount(0);

    const entries = await rosterByName(request, event.code, token);
    expect(entries.get("Ann Alpha").allGroups).toBe(true);
    expect(entries.get("Al Alpha").allGroups).toBe(true);
    expect(entries.get("Cy Gamma").allGroups).toBe(false);
    expect(groupNames(entries.get("Cy Gamma"))).toEqual(["Staff"]);
    expect(groupNames(entries.get("Al Alpha"))).toEqual(["Staff"]);
    expect(entries.get("Bea Beta").groups).toEqual([]);
  });
});

test.describe("Participants list: groups", () => {
  test("rejects invalid group names in the new-group dialog, the Groups panel, the picker and rename", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-group-names",
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group"],
        ["Gia Group", personEmail("gia", runId), "Team A"],
      ]),
    );
    const groupRequests = [];
    page.on("request", (candidate) => {
      if (
        candidate.method() !== "GET" &&
        /\/events\/roster\/groups(?:\/\d+)?\?/.test(candidate.url())
      )
        groupRequests.push(
          `${candidate.method()} ${candidate.postDataJSON()?.name}`,
        );
    });
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(1);

    // The New group dialog from the Group filter.
    await roster(page).getByRole("button", { name: "Group: Everyone" }).click();
    await page.getByRole("button", { name: "+ New group" }).click();
    const dialog = page.getByRole("dialog", { name: "New group" });
    const name = dialog.getByRole("textbox", { name: "Group name" });
    const create = dialog.getByRole("button", { name: "Create" });
    for (const [value, message] of [
      ["   ", "Enter a group name."],
      ["all", "ALL is reserved for every group."],
      ["Staff; Faculty", "Group names cannot contain ; or ,."],
      ["Staff, Faculty", "Group names cannot contain ; or ,."],
    ]) {
      await name.fill(value);
      // Typing clears the last error, so each one below is new.
      await expect(name).not.toHaveAttribute("aria-invalid");
      await create.click();
      await expect(dialog).toContainText(message);
      await expect(name).toHaveAttribute("aria-invalid", "true");
    }
    // The field stops at 100 characters: a 101st key press adds nothing.
    await name.fill("x".repeat(100));
    await name.press("y");
    await expect(name).toHaveValue("x".repeat(100));
    expect(groupRequests).toEqual([]);
    // A case variant of an existing name is refused by the server.
    await name.fill("team a");
    await create.click();
    await expect(dialog).toContainText("A group named Team A already exists.");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    // The Groups panel's own form, and rename.
    const panel = await openGroupsPanel(page);
    await panel.getByRole("button", { name: "+ New group" }).click();
    const panelName = panel.getByRole("textbox", { name: "New group name" });
    await expect(panelName).toBeFocused();
    const panelCreate = panel.getByRole("button", {
      name: "Create",
      exact: true,
    });
    await panelCreate.click();
    await expect(panel.getByRole("alert")).toHaveText("Enter a group name.");
    await panelName.fill("ALL");
    await panelCreate.click();
    await expect(panel.getByRole("alert")).toHaveText(
      "ALL is reserved for every group.",
    );
    await panelName.fill("TEAM A");
    await panelCreate.click();
    await expect(panel.getByRole("alert")).toHaveText(
      "A group named Team A already exists.",
    );
    await expect(panelName).toBeVisible();
    await panelName.fill("Team B");
    await panelCreate.click();
    await expectToast(page, "Created group Team B.");
    await expect(groupRow(panel, "Team B")).toContainText("0 people");

    await groupMenu(panel, "Team B", "Rename");
    const rename = panel.getByRole("textbox", { name: "New name for Team B" });
    await expect(rename).toBeFocused();
    await expect(rename).toHaveValue("Team B");
    const save = renamingRow(panel, "Team B").getByRole("button", {
      name: "Save",
    });
    await rename.fill("");
    await save.click();
    await expect(renamingRow(panel, "Team B").getByRole("alert")).toHaveText(
      "Enter a group name.",
    );
    await rename.fill("Team B, Team C");
    await save.click();
    await expect(renamingRow(panel, "Team B").getByRole("alert")).toHaveText(
      "Group names cannot contain ; or ,.",
    );
    await rename.fill("team a");
    await save.click();
    await expect(
      panel.getByRole("alert").filter({ hasText: "already exists" }),
    ).toHaveText("A group named Team A already exists.");
    await expect(rename).toBeVisible();
    await renamingRow(panel, "Team B")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(rename).toHaveCount(0);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toHaveCount(0);

    // The group picker's own form.
    await page.getByRole("checkbox", { name: "Select Gia Group" }).check();
    await selectionBar(page).getByRole("button", { name: "Groups…" }).click();
    const picker = page.getByRole("dialog", {
      name: "Groups for 1 selected people",
    });
    await picker.getByRole("button", { name: "+ New group" }).click();
    const pickerName = picker.getByRole("textbox", { name: "New group name" });
    const pickerCreate = picker.getByRole("button", {
      name: "Create",
      exact: true,
    });
    await pickerCreate.click();
    await expect(picker.getByRole("alert")).toHaveText("Enter a group name.");
    await pickerName.fill("All");
    await pickerCreate.click();
    await expect(picker.getByRole("alert")).toHaveText(
      "ALL is reserved for every group.",
    );
    await pickerName.fill("A;B");
    await pickerCreate.click();
    await expect(picker.getByRole("alert")).toHaveText(
      "Group names cannot contain ; or ,.",
    );
    await pickerName.fill("team b");
    await pickerCreate.click();
    await expect(picker.getByRole("alert")).toHaveText(
      "A group named Team B already exists.",
    );
    // The form's Cancel closes the form; the footer's closes the picker.
    await picker.getByRole("button", { name: "Cancel" }).first().click();
    await expect(pickerName).toHaveCount(0);
    await picker.getByRole("button", { name: "Cancel" }).click();
    await expect(picker).toHaveCount(0);

    // Only the valid names and the three duplicates reached the server.
    expect(groupRequests.sort()).toEqual(
      [
        "PATCH team a",
        "POST TEAM A",
        "POST Team B",
        "POST team a",
        "POST team b",
      ].sort(),
    );

    // The server applies the same rules to anyone calling it directly.
    const groupsUrl = `/events/roster/groups?code=${event.code}`;
    for (const [value, status, message] of [
      ["", 400, "Group name is required."],
      [" all ", 400, "ALL is reserved for every group."],
      ["A;B", 400, "Group names cannot contain ; or ,."],
      ["x".repeat(101), 400, "group is too long (max 100)."],
      ["TEAM B", 409, "A group named Team B already exists."],
    ]) {
      const refused = await apiJson(request, "POST", groupsUrl, token, {
        name: value,
      });
      expect(refused.response.status(), value).toBe(status);
      expect(refused.payload.error).toBe(message);
    }
    const listed = await rosterEntries(request, event.code, token);
    expect(
      listed.stats.groups
        .map((entry) => entry.name)
        .filter(Boolean)
        .sort(),
    ).toEqual(["Team A", "Team B"]);
    const teamB = listed.stats.groups.find((entry) => entry.name === "Team B");
    const renamed = await apiJson(
      request,
      "PATCH",
      `/events/roster/groups/${teamB.id}?code=${event.code}`,
      token,
      { name: "y".repeat(101) },
    );
    expect(renamed.response.status()).toBe(400);
    expect(renamed.payload.error).toBe("group is too long (max 100).");
  });

  test("renames groups inline with Save or Enter and keeps an active group filter on the new name", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-rename",
    );
    const gia = personEmail("gia", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group"],
        ["Gia Group", gia, "Team A"],
        ["Hal Hollow", personEmail("hal", runId), ""],
        ["Ivy Other", personEmail("ivy", runId), "Team B"],
      ]),
    );
    const renames = [];
    page.on("request", (candidate) => {
      if (
        candidate.method() === "PATCH" &&
        /\/events\/roster\/groups\/\d+\?/.test(candidate.url())
      )
        renames.push(candidate.postDataJSON().name);
    });
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(3);

    // Show Team A only.
    await roster(page).getByRole("button", { name: "Group: Everyone" }).click();
    // Choosing an option applies it and closes the popover.
    await page.getByRole("radio", { name: "Team A", exact: true }).click();
    await expect.poll(() => rowNames(page)).toEqual(["Gia Group"]);
    await expect(filterChip(page, "Group: Team A")).toBeVisible();

    const panel = await openGroupsPanel(page);
    // Cancel leaves the name as it was.
    await groupMenu(panel, "Team B", "Rename");
    const renameB = panel.getByRole("textbox", { name: "New name for Team B" });
    await expect(renameB).toBeFocused();
    await expect(renameB).toHaveValue("Team B");
    await renameB.fill("Team Beta");
    await renamingRow(panel, "Team B")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(renameB).toHaveCount(0);
    await expect(groupRow(panel, "Team B")).toBeVisible();
    expect(renames).toEqual([]);

    // Saving the same name sends nothing.
    await groupMenu(panel, "Team B", "Rename");
    await renamingRow(panel, "Team B")
      .getByRole("button", { name: "Save" })
      .click();
    await expect(renameB).toHaveCount(0);
    expect(renames).toEqual([]);

    // Save renames it.
    await groupMenu(panel, "Team B", "Rename");
    await renameB.fill("Team Beta");
    await renamingRow(panel, "Team B")
      .getByRole("button", { name: "Save" })
      .click();
    await expectToast(page, "Renamed Team B to Team Beta.");
    await expect(groupRow(panel, "Team Beta")).toContainText("1 person");
    await expect(groupRow(panel, "Team B")).toHaveCount(0);

    // Enter renames too; the filter showing that group follows the name.
    await groupMenu(panel, "Team A", "Rename");
    const renameA = panel.getByRole("textbox", { name: "New name for Team A" });
    await renameA.fill("Team Alpha");
    const reloaded = listingResponse(page, { group: "Team Alpha" });
    await renameA.press("Enter");
    await expectToast(page, "Renamed Team A to Team Alpha.");
    await reloaded;
    expect(renames).toEqual(["Team Beta", "Team Alpha"]);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(
      roster(page).getByRole("button", {
        name: "Group: Team Alpha",
        exact: true,
      }),
    ).toBeVisible();
    await expect(filterChip(page, "Group: Team Alpha")).toBeVisible();
    await expect.poll(() => rowNames(page)).toEqual(["Gia Group"]);
    await expect(
      participantRow(page, "Gia Group").locator(".participants-table__groups"),
    ).toHaveText("Team Alpha");
    await expect(participantSummary(page)).toContainText(
      "Showing 1 of 3 people",
    );

    const entries = await rosterEntries(request, event.code, token);
    const giaEntry = entries.participants.find((entry) => entry.email === gia);
    expect(groupNames(giaEntry)).toEqual(["Team Alpha"]);
    expect(
      entries.stats.groups
        .map((entry) => entry.name)
        .filter(Boolean)
        .sort(),
    ).toEqual(["Team Alpha", "Team Beta"]);
  });

  test("Escape in the Groups panel cancels only the rename, the new-group form or the open menu", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-group-escape",
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group"],
        ["Gia Group", personEmail("gia", runId), "Team A"],
      ]),
    );
    const groupWrites = [];
    page.on("request", (candidate) => {
      if (
        candidate.method() !== "GET" &&
        /\/events\/roster\/groups(?:\/\d+)?\?/.test(candidate.url())
      )
        groupWrites.push(candidate.method());
    });
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(1);
    const panel = await openGroupsPanel(page);

    // Escape in the rename box drops the new name; the panel stays open.
    await groupMenu(panel, "Team A", "Rename");
    const rename = panel.getByRole("textbox", { name: "New name for Team A" });
    await rename.fill("Team Alpha");
    await rename.press("Escape");
    await expect(rename).toHaveCount(0);
    expect(groupWrites).toEqual([]);
    await expect(panel).toBeVisible();
    await expect(groupRow(panel, "Team A")).toBeVisible();

    // Escape in the new-group form closes the form only.
    await panel.getByRole("button", { name: "+ New group" }).click();
    const newName = panel.getByRole("textbox", { name: "New group name" });
    await newName.fill("Team B");
    await newName.press("Escape");
    await expect(newName).toHaveCount(0);
    await expect(panel).toBeVisible();

    // Escape on a row's open menu closes the menu only.
    await groupRow(panel, "Team A")
      .getByRole("button", { name: "Actions for Team A" })
      .click();
    const renameItem = page.getByRole("menuitem", { name: "Rename" });
    await expect(renameItem).toBeVisible();
    // Pressed from inside the menu, since a click does not focus the trigger
    // in every browser.
    await renameItem.press("Escape");
    await expect(renameItem).toHaveCount(0);
    await expect(panel).toBeVisible();
    expect(groupWrites).toEqual([]);
  });

  test("counts whole groups in or out from the Groups panel and selects a group's people", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-group-counted",
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group", "included"],
        ["Amy Alpha", personEmail("amy", runId), "Team A", "true"],
        ["Abe Alpha", personEmail("abe", runId), "Team A", "false"],
        ["Ari Alpha", personEmail("ari", runId), "Team A", "false"],
        ["Bo Beta", personEmail("bo", runId), "Team B", "true"],
        ["Bix Beta", personEmail("bix", runId), "Team B", "true"],
        ["Nel None", personEmail("nel", runId), "", "true"],
        ["Ned None", personEmail("ned", runId), "", "true"],
      ]),
    );
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(7);
    const panel = await openGroupsPanel(page);
    const counted = (name) =>
      groupRow(panel, name).locator(".participants-groups-table__counted");
    const countBox = (name) =>
      panel.getByRole("checkbox", { name: `Count ${name} in the results` });

    await expect(countBox("Team A")).toBeChecked({ indeterminate: true });
    await expect(counted("Team A")).toHaveText("Some");
    await expect(countBox("Team B")).toBeChecked();
    await expect(counted("Team B")).toHaveText("All");
    await expect(countBox("No group")).toBeChecked();
    await expect(counted("No group")).toHaveText("All");
    await expect(groupRow(panel, "No group")).toContainText("2 people");

    // The No group bucket is a bulk change by the empty group name.
    // The box follows the saved state, so it changes once the list reloads.
    let bulk = bulkResponse(page);
    await countBox("No group").click();
    let answered = await bulk;
    expect(answered.request().postDataJSON()).toMatchObject({
      group: "",
      updates: { included: false },
    });
    await expectToast(page, "Left 2 people out of the results.");
    await expect(counted("No group")).toHaveText("None");
    await expect(countBox("No group")).not.toBeChecked();

    // A partly counted group is counted in full by one click.
    bulk = bulkResponse(page);
    await countBox("Team A").click();
    answered = await bulk;
    expect(answered.request().postDataJSON()).toMatchObject({
      group: "Team A",
      updates: { included: true },
    });
    expect(await answered.json()).toMatchObject({
      matchedCount: 3,
      updatedCount: 2,
    });
    await expectToast(page, "2 people now count in the results.");
    await expect(counted("Team A")).toHaveText("All");
    await expect(countBox("Team A")).toBeChecked();

    // Select these people: the panel closes onto that group, everyone in it
    // selected.
    await groupMenu(panel, "Team A", "Select these 3 people");
    await expect(panel).toHaveCount(0);
    await expect(
      roster(page).getByRole("button", { name: "Group: Team A", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => rowNames(page))
      .toEqual(["Amy Alpha", "Abe Alpha", "Ari Alpha"]);
    await expect(selectionHelper(page)).toHaveText(
      "Everyone matching the filter is selected (3).",
    );
    await expect(selectionBar(page)).toContainText(
      "3 selected · everyone matching the filter",
    );
    await chooseMore(page, "Leave out of results");
    const confirm = page.getByRole("dialog", { name: "Apply to 3 people?" });
    bulk = bulkResponse(page);
    await confirm.getByRole("button", { name: "Apply", exact: true }).click();
    answered = await bulk;
    expect(answered.request().postDataJSON()).toMatchObject({
      filter: { group: "Team A" },
      updates: { included: false },
    });
    await expectToast(page, "Left 3 people out of the results.");
    await expect(
      roster(page).getByText("5 people are left out of the results."),
    ).toBeVisible();

    const entries = await rosterByName(request, event.code, token);
    for (const name of ["Amy Alpha", "Abe Alpha", "Ari Alpha"]) {
      expect(entries.get(name).included, name).toBe(false);
    }
    for (const name of ["Nel None", "Ned None"]) {
      expect(entries.get(name).included, name).toBe(false);
    }
    for (const name of ["Bo Beta", "Bix Beta"]) {
      expect(entries.get(name).included, name).toBe(true);
    }
  });
});

test.describe("Participants list: counting people in the results", () => {
  test("leaves one person out and counts them in again from the row menu and the person panel", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-include",
    );
    await addPersonApi(request, event.code, token, {
      name: "Ann Include",
      email: personEmail("ann", runId),
    });
    await addPersonApi(request, event.code, token, {
      name: "Ben Include",
      email: personEmail("ben", runId),
    });
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(2);
    const ann = participantRow(page, "Ann Include");
    const ben = participantRow(page, "Ben Include");
    const rowPatch = () =>
      page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          /\/events\/roster\/\d+$/.test(new URL(response.url()).pathname),
      );

    await openRowMenu(page, "Ann Include");
    let patched = rowPatch();
    await page
      .getByRole("menuitem", { name: "Leave out of results", exact: true })
      .click();
    expect((await patched).request().postDataJSON()).toMatchObject({
      included: false,
    });
    await expectToast(page, "Ann Include is left out of the results.");
    await expect(ann).toContainText("Left out of results");
    await expect(
      roster(page).getByText("1 person is left out of the results."),
    ).toBeVisible();

    await openRowMenu(page, "Ann Include");
    patched = rowPatch();
    await page
      .getByRole("menuitem", { name: "Count in results", exact: true })
      .click();
    expect((await patched).request().postDataJSON()).toMatchObject({
      included: true,
    });
    await expectToast(page, "Ann Include now counts in the results.");
    await expect(ann).not.toContainText("Left out of results");
    await expect(
      roster(page).getByText(/left out of the results\./),
    ).toHaveCount(0);

    // The person panel's checkbox is saved with the rest of the panel.
    const panel = await openPersonPanel(page, "Ben Include");
    const counts = panel.getByRole("checkbox", {
      name: "Count Ben Include's answers",
    });
    await expect(counts).toBeChecked();
    await counts.uncheck();
    patched = rowPatch();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    const saved = (await patched).request().postDataJSON();
    expect(saved).toMatchObject({ included: false });
    expect(Object.keys(saved).sort()).toEqual(["expectedVersion", "included"]);
    await expectToast(page, "Saved.");
    await expect(ben).toContainText("Left out of results");
    let entries = await rosterByName(request, event.code, token);
    expect(entries.get("Ben Include").included).toBe(false);

    await counts.check();
    patched = rowPatch();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    expect((await patched).request().postDataJSON()).toMatchObject({
      included: true,
    });
    await expectToast(page, "Saved.");
    await expect(ben).not.toContainText("Left out of results");
    await panel.getByRole("button", { name: "Close details" }).first().click();
    await expect(panel).toHaveCount(0);

    entries = await rosterByName(request, event.code, token);
    expect(entries.get("Ann Include").included).toBe(true);
    expect(entries.get("Ben Include").included).toBe(true);
  });

  test("a bulk count-in of one person reads in the singular", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-count-one",
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "included"],
        ["Una Single", personEmail("una", runId), "false"],
        ["Vic Counted", personEmail("vic", runId), "true"],
      ]),
    );
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(2);
    await page.getByRole("checkbox", { name: "Select Una Single" }).check();
    const bulk = bulkResponse(page);
    await chooseMore(page, "Count in results");
    expect(await (await bulk).json()).toMatchObject({ updatedCount: 1 });
    await expect(participantRow(page, "Una Single")).not.toContainText(
      "Left out of results",
    );
    await expectToast(page, "1 person now counts in the results.");
  });

  test("shows the people left out from the banner, and keeps the banner read-only once responses close", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-left-out",
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "included"],
        ["Lou Leftout", personEmail("lou", runId), "false"],
        ["Lea Leftout", personEmail("lea", runId), "false"],
        ["Max Counted", personEmail("max", runId), "true"],
      ]),
    );
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(3);
    const banner = roster(page)
      .getByRole("status")
      .filter({ hasText: "2 people are left out of the results." });
    await expect(banner).toBeVisible();

    const listed = listingResponse(page, { included: "false" });
    await banner.getByRole("button", { name: "Show them" }).click();
    await listed;
    await expect
      .poll(() => rowNames(page))
      .toEqual(["Lou Leftout", "Lea Leftout"]);
    await expect(filterChip(page, "Results: Left out")).toBeVisible();
    await expect(
      filterButton(page).locator(".participants-popover__count"),
    ).toHaveText("1 active");
    await expect(participantSummary(page)).toContainText(
      "Showing 2 of 3 people",
    );
    await activeFilters(page)
      .getByRole("button", { name: "Clear all" })
      .click();
    await expect(listRows(page)).toHaveCount(3);

    // Once responses close, the banner can still show the people but can
    // no longer count them back in.
    await setLifecycleViaApi(request, token, event.code, "closed");
    await gotoParticipants(page, event);
    await expect(
      roster(page).getByText(
        "Responses are closed, so this list is read-only. Reactivate the event to make changes.",
      ),
    ).toBeVisible();
    await expect(banner).toBeVisible();
    await expect(
      banner.getByRole("button", { name: "Count everyone again" }),
    ).toBeDisabled();
    await expect(
      banner.getByRole("button", { name: "Show them" }),
    ).toBeEnabled();
    await banner.getByRole("button", { name: "Show them" }).click();
    await expect
      .poll(() => rowNames(page))
      .toEqual(["Lou Leftout", "Lea Leftout"]);
    await expect(filterChip(page, "Results: Left out")).toBeVisible();
    const entries = await rosterByName(request, event.code, token);
    expect(entries.get("Lou Leftout").included).toBe(false);
    expect(entries.get("Lea Leftout").included).toBe(false);
  });

  test("toast actions scroll to the delivery progress and review an invitation to a corrected address", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-toasts",
    );
    const ivyEmail = personEmail("ivy", runId);
    const fixedEmail = personEmail("ada", runId);
    await addPersonApi(request, event.code, token, {
      name: "Ivy Invitee",
      email: ivyEmail,
    });
    await addPersonApi(request, event.code, token, {
      name: "Ada Typo",
      email: `ada-${runId}@exmaple.com`,
    });
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(2);

    await openRowMenu(page, "Ivy Invitee");
    await page
      .getByRole("menuitem", { name: "Send invitation", exact: true })
      .click();
    const sendDialog = page.getByRole("dialog", { name: "Send invitations" });
    await expect(emailField(sendDialog, "To")).toContainText(ivyEmail);
    const send = await continueToConfirm(
      sendDialog,
      "Send 1 invitation now?",
      "Send 1 invitation",
    );
    await send.click();
    await expect(sendDialog).toHaveCount(0);
    const delivery = page.locator(".organizer-workspace__delivery");
    await expect(delivery).toBeAttached();
    await expect(delivery).not.toBeInViewport();
    const sentToast = page
      .getByRole("region", { name: "Notifications" })
      .locator(".participants-toast", { hasText: "Queued 1 invitation." });
    await sentToast.getByRole("button", { name: "View progress" }).click();
    await expect(delivery).toBeInViewport();

    // The toast after fixing an address offers that person's invitation.
    const panel = await openPersonPanel(page, "Ada Typo");
    await panel.getByRole("textbox", { name: "Email" }).fill(fixedEmail);
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    const fixToast = page
      .getByRole("region", { name: "Notifications" })
      .locator(".participants-toast", {
        hasText: "Saved. The new address hasn't been invited yet.",
      });
    await fixToast.getByRole("button", { name: "Send invitation" }).click();
    const fixDialog = page.getByRole("dialog", { name: "Send invitations" });
    await expect(fixDialog.getByText("Step 1 of 2: Review")).toBeVisible();
    await expect(
      fixDialog.getByText("1 will get an invitation now", { exact: true }),
    ).toBeVisible();
    await expect(emailField(fixDialog, "To")).toHaveText(
      `Ada Typo <${fixedEmail}>`,
    );
    await fixDialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(fixDialog).toHaveCount(0);
    await expect(panel).toBeVisible();

    // Only Ivy's invitation went out.
    await waitForInvitationStatus(request, event.code, token, ivyEmail, "sent");
    const entries = await rosterByEmail(request, event.code, token);
    expect(entries.get(fixedEmail)?.invitationStatus).toBe("not_sent");
  });
});

test.describe("Participants list: bulk endpoint", () => {
  test("replays a bulk update by its idempotency key and rejects reused keys and malformed requests", async ({
    request,
  }) => {
    const runId = newRunId();
    const { access: token } = await registerAccountViaApi(
      request,
      `list-bulk-api-${runId}@example.com`,
      "Bea",
      "Bulk",
    );
    const event = await createEvent(request, token, {
      name: `list-bulk-api ${runId}`,
    });
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Kai Keyed", personEmail("kai", runId)],
        ["Lee Keyed", personEmail("lee", runId)],
      ]),
    );
    let byName = await rosterByName(request, event.code, token);
    const kai = byName.get("Kai Keyed");
    const lee = byName.get("Lee Keyed");
    const bulkUrl = `/events/roster/bulk?code=${event.code}`;
    const patch = (body) => apiJson(request, "PATCH", bulkUrl, token, body);

    const key = crypto.randomUUID();
    const body = {
      participantIds: [kai.id],
      updates: { weight: 0.5 },
      idempotencyKey: key,
    };
    const first = await patch(body);
    expect(first.response.status()).toBe(200);
    expect(first.payload).toMatchObject({
      updatedCount: 1,
      matchedCount: 1,
      idempotent: false,
    });
    const revision = first.payload.resultsRevision;

    // A later change, then a replay of the first: the stored counts come
    // back and nothing is applied again.
    const later = await patch({
      participantIds: [kai.id],
      updates: { weight: 0.8 },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(later.response.status()).toBe(200);
    byName = await rosterByName(request, event.code, token);
    const versionBeforeReplay = byName.get("Kai Keyed").version;
    const replay = await patch(body);
    expect(replay.response.status()).toBe(200);
    expect(replay.payload).toEqual({
      updatedCount: 1,
      matchedCount: 1,
      resultsRevision: revision,
      idempotent: true,
    });
    byName = await rosterByName(request, event.code, token);
    expect(byName.get("Kai Keyed").weight).toBe(0.8);
    expect(byName.get("Kai Keyed").version).toBe(versionBeforeReplay);

    const reused = await patch({ ...body, updates: { weight: 0.25 } });
    expect(reused.response.status()).toBe(409);
    expect(reused.payload.error).toBe(
      "This idempotency key was used for a different bulk update.",
    );

    // Malformed requests are refused before anything is stored, so their
    // keys stay free.
    const rejectedKey = crypto.randomUUID();
    for (const [request400, message] of [
      [
        { ...body, idempotencyKey: rejectedKey, extra: true },
        "Unknown bulk request field: extra.",
      ],
      [
        {
          participantIds: [lee.id],
          updates: { colour: "red" },
          idempotencyKey: rejectedKey,
        },
        "Unknown bulk update field: colour.",
      ],
      [
        { updates: { weight: 0.3 }, idempotencyKey: rejectedKey },
        "Choose participantIds, group, or filter for a bulk update.",
      ],
      [
        { filter: {}, updates: { weight: 0.3 }, idempotencyKey: rejectedKey },
        "filter must contain a participant filter or explicit all=true.",
      ],
      [
        {
          filter: { all: false },
          updates: { weight: 0.3 },
          idempotencyKey: rejectedKey,
        },
        "filter.all must be true when provided.",
      ],
      [
        {
          filter: { colour: "red" },
          updates: { weight: 0.3 },
          idempotencyKey: rejectedKey,
        },
        "Unknown participant filter: colour.",
      ],
      [
        {
          participantIds: [],
          updates: { weight: 0.3 },
          idempotencyKey: rejectedKey,
        },
        "participantIds must be a non-empty array.",
      ],
      [
        {
          participantIds: [lee.id],
          updates: {},
          idempotencyKey: rejectedKey,
        },
        "updates must be a non-empty object.",
      ],
      [
        {
          participantIds: [lee.id],
          updates: { weight: 0.3 },
          idempotencyKey: "not-a-uuid",
        },
        "idempotencyKey must be a UUID.",
      ],
    ]) {
      const refused = await patch(request400);
      expect(refused.response.status(), message).toBe(400);
      expect(refused.payload.error).toBe(message);
    }
    byName = await rosterByName(request, event.code, token);
    expect(byName.get("Lee Keyed").weight).toBe(1);

    const retried = await patch({
      participantIds: [lee.id],
      updates: { weight: 0.3 },
      idempotencyKey: rejectedKey,
    });
    expect(retried.response.status()).toBe(200);
    expect(retried.payload).toMatchObject({
      updatedCount: 1,
      matchedCount: 1,
      idempotent: false,
    });
    byName = await rosterByName(request, event.code, token);
    expect(byName.get("Lee Keyed").weight).toBe(0.3);
    expect(byName.get("Kai Keyed").weight).toBe(0.8);
  });
});

test.describe("Participants list: accessibility at phone width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the populated list, its panels, the selection bar, the picker and the import sheet pass axe without sideways scrolling", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "list-a11y",
    );
    const longGroups = [
      "Department of Interdisciplinary Research and Graduate Studies",
      "Undergraduate Teaching Assistants Coordination Committee",
      "Visiting Scholars",
    ];
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group", "included"],
        [
          "Maximiliana Alexandrovna Konstantinopoulou-Worthington",
          personEmail("maximiliana-alexandrovna", runId),
          longGroups.join("; "),
          "true",
        ],
        ["Ben Brief", personEmail("ben", runId), longGroups[0], "false"],
        ["Cai Short", personEmail("cai", runId), longGroups[1], "true"],
        ["Dee Nogroup", personEmail("dee", runId), "", "true"],
      ]),
    );
    await addPersonApi(request, event.code, token, {
      name: "Eli Noemail",
      organizerManaged: true,
    });
    await gotoParticipants(page, event);
    await expect(listRows(page)).toHaveCount(5);
    await expect(
      roster(page).getByText("1 person is left out of the results."),
    ).toBeVisible();
    // At phone width each person's groups fold under their name instead of
    // widening the table.
    const longName = "Maximiliana Alexandrovna Konstantinopoulou-Worthington";
    const inlineGroups = participantRow(page, longName).locator(
      ".participants-row__groups-inline",
    );
    await expect(inlineGroups).toBeVisible();
    await expect(inlineGroups).toHaveText(longGroups.slice().sort().join(", "));
    await expectNoHorizontalScroll(page, "populated participants list");
    await expectAccessible(page, "populated participants list at 375px");

    // The selection bar.
    await page.getByRole("checkbox", { name: "Select Ben Brief" }).check();
    await page.getByRole("checkbox", { name: "Select Cai Short" }).check();
    await expect(selectionBar(page)).toContainText("2 selected");
    await expectNoHorizontalScroll(page, "selection bar");
    await expectAccessible(page, "participants selection bar at 375px");

    // The group picker with mixed boxes and counts.
    await selectionBar(page).getByRole("button", { name: "Groups…" }).click();
    const picker = page.getByRole("dialog", {
      name: "Groups for 2 selected people",
    });
    await expect(
      picker.getByRole("checkbox", { name: longGroups[0] }),
    ).toBeChecked({ indeterminate: true });
    await expectNoHorizontalScroll(page, "group picker");
    await expectAccessible(page, "group picker at 375px");
    await picker.getByRole("button", { name: "Cancel" }).click();
    await expect(picker).toHaveCount(0);
    await selectionBar(page).getByRole("button", { name: "Clear" }).click();

    // The person panel for the long-named person in all three groups.
    const personPanel = await openPersonPanel(page, longName);
    await expect(
      personPanel.getByRole("list", { name: "Groups" }),
    ).toContainText(longGroups[0]);
    await expectNoHorizontalScroll(page, "person panel");
    await expectAccessible(page, "person panel at 375px");
    await personPanel
      .getByRole("button", { name: "Close details" })
      .first()
      .click();
    await expect(personPanel).toHaveCount(0);

    // The add panel.
    await page
      .getByRole("group", { name: "Participant actions" })
      .getByRole("button", { name: "+ Add person" })
      .click();
    const addPanel = page.getByRole("dialog", { name: "Add a person" });
    await expect(addPanel).toBeVisible();
    await expectNoHorizontalScroll(page, "add panel");
    await expectAccessible(page, "add person panel at 375px");
    await addPanel.getByRole("button", { name: "Done" }).click();
    await expect(addPanel).toHaveCount(0);

    // The Groups panel with long names, a left-out member and No group.
    const panel = await openGroupsPanel(page);
    await expect(groupRow(panel, longGroups[0])).toContainText("2 people");
    await expect(groupRow(panel, "No group")).toContainText("2 people");
    await expectNoHorizontalScroll(page, "groups panel");
    await expectAccessible(page, "groups panel at 375px");
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toHaveCount(0);

    // The import sheet's Source, Columns and Review steps.
    const sheet = await openImportSheet(page);
    await expectNoHorizontalScroll(page, "import sheet");
    await expectAccessible(page, "import sheet at 375px");
    await pasteParticipantRows(
      sheet,
      tsv([
        ["name", "email", "group"],
        ["Fay Fresh", personEmail("fay", runId), longGroups[2]],
      ]),
    );
    await expectNoHorizontalScroll(page, "import sheet columns");
    await expectAccessible(page, "import sheet columns at 375px");
    await previewImportRows(sheet);
    await expectNoHorizontalScroll(page, "import sheet review");
    await expectAccessible(page, "import sheet review at 375px");
    await sheet.getByRole("button", { name: "Close dialog" }).click();
    const discard = page.getByRole("dialog", { name: "Discard this import?" });
    await discard.getByRole("button", { name: "Discard import" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(listRows(page)).toHaveCount(5);
  });
});
