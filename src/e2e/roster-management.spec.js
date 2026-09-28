const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  apiJson,
  beforeUnloadIsBlocked,
  dispatchEmailJobs,
  importRosterApi,
  latestEmailFor,
  latestVerificationCode,
  refreshWorkspace,
  setEventStatus,
  temporaryAccessPathFromEmail,
} = require("./helpers/releviz");
const {
  addPersonApi,
  expectRosterSummary,
  freezeLiveSync,
  gotoRoster,
  groupRow,
  invitationEmail,
  invitationJobCount,
  openBulkActions,
  openImportWizard,
  pasteRosterSource,
  previewImportRows,
  requestRecorder,
  rosterByEmail,
  rosterEntries,
  rosterRow,
  rosterStatus,
  sendInvitationsApi,
  startOrganizerEvent,
  submitOnBehalf,
  tsv,
  waitForInvitationStatus,
} = require("./helpers/roster");

// The organizer roster in a real browser: RosterPanel (search, filters,
// paging, selection, bulk updates, add person, invitations, inline row edits
// and version conflicts), RosterPersonDialog, the schedule drawer's discard
// guard, RosterGroups, the read-only lifecycle states and axe scans of the
// populated states. Every test registers its own organizer and event and
// asserts only on its own rows and recipients.

test.describe.configure({ mode: "parallel" });

const ROW_PATCH = /\/events\/roster\/[^/]+$/;
const BULK_PATCH = /\/events\/roster\/bulk$/;
const INVITATIONS_POST = /\/events\/roster\/invitations$/;

function personEmail(slug, runId) {
  return `${slug}-${runId}@example.com`;
}

function tableRows(page) {
  return page.locator("tr.roster-table__row");
}

// The selection bar renders above and below the table, so "n selected"
// appears twice while the roster is editable.
function selectionCount(page, count) {
  return page.getByText(`${count} selected`, { exact: true });
}

function alertWith(page, text) {
  return page.getByRole("alert").filter({ hasText: text });
}

// Runs an action and waits for the matching API response, so a status text
// that repeats the previous one is never read before the new request lands.
async function actAndWait(page, method, pathPattern, action) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === method &&
      pathPattern.test(new URL(candidate.url()).pathname),
  );
  await action();
  return response;
}

// Organizer-managed people are filed under the organizer's own address, so
// several of them cannot be keyed by email.
async function rosterByName(request, eventCode, token) {
  const payload = await rosterEntries(request, eventCode, token);
  return new Map(payload.participants.map((entry) => [entry.name, entry]));
}

function groupNames(entry) {
  return entry.groups.map((group) => group.name);
}

// Three people, two groups, one of them left out, so the group table shows
// a mixed Included box and Include everyone.
async function openAccessibleRoster({ page, request }) {
  const { runId, token, event } = await startOrganizerEvent(
    { page, request },
    "roster-a11y",
  );
  await importRosterApi(
    request,
    event.code,
    token,
    tsv([
      ["name", "email", "group", "included"],
      ["Ana Access", personEmail("ana", runId), "Team A", "true"],
      ["Ben Access", personEmail("ben", runId), "Team A; Team B", "false"],
      ["Cal NoEmail", "", "Team B", "true"],
    ]),
  );
  await gotoRoster(page, event);
  await expect(tableRows(page)).toHaveCount(3);
  return { runId, event };
}

test.describe("Roster management", () => {
  test("searches, filters, clears and pages a 30-person roster, and selects across pages", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-filters",
    );
    const people = Array.from({ length: 30 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        name: `Person ${number}`,
        email: personEmail(`p${number}`, runId),
        group: index < 10 ? "Team A" : index < 20 ? "Team B" : "",
        phone: number === "12" ? "+1 (555) 424-2424" : "",
      };
    });
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
    const byEmail = await rosterByEmail(request, event.code, token);
    const entryFor = (number) =>
      byEmail.get(people[number - 1].email.toLowerCase());
    await sendInvitationsApi(request, event.code, token, [entryFor(1).id]);
    dispatchEmailJobs();
    await waitForInvitationStatus(
      request,
      event.code,
      token,
      people[0].email,
      "sent",
    );
    await submitOnBehalf(request, token, event, entryFor(2));
    await submitOnBehalf(request, token, event, entryFor(3));

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(30);

    // Search covers email, phone, group and name.
    const search = page.getByLabel("Search roster");
    await search.fill("p07-");
    await expect(tableRows(page)).toHaveCount(1);
    await expect(rosterRow(page, "Person 07")).toBeVisible();
    await search.fill("(555) 424");
    await expect(tableRows(page)).toHaveCount(1);
    await expect(rosterRow(page, "Person 12")).toContainText(
      "+1 (555) 424-2424",
    );
    await search.fill("team b");
    await expect(tableRows(page)).toHaveCount(10);
    await expectRosterSummary(page, {
      people: 10,
      submitted: 0,
      awaiting: 10,
      groups: 2,
    });
    await search.fill("person 1");
    const groupFilter = page.getByLabel("Filter by group");
    const responseFilter = page.getByLabel("Filter by response");
    const invitationFilter = page.getByLabel("Filter by invitation");
    await groupFilter.selectOption("Team B");
    await expect(tableRows(page)).toHaveCount(9);
    for (let number = 11; number <= 19; number += 1) {
      await expect(rosterRow(page, `Person ${number}`)).toBeVisible();
    }

    // Nothing matches: the empty state offers Clear filters and hides the
    // selection and bulk tools.
    await invitationFilter.selectOption("accepted");
    await expect(
      page.getByRole("heading", { name: "No matching participants" }),
    ).toBeVisible();
    await expect(
      page.getByText("Try a different search or clear the current filters."),
    ).toBeVisible();
    await expect(
      page.locator('details[aria-label="Bulk roster actions"]'),
    ).toHaveCount(0);
    await expect(selectionCount(page, 0)).toHaveCount(0);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(search).toHaveValue("");
    await expect(groupFilter).toHaveValue("");
    await expect(responseFilter).toHaveValue("");
    await expect(invitationFilter).toHaveValue("");
    await expect(tableRows(page)).toHaveCount(30);
    await expectRosterSummary(page, {
      people: 30,
      submitted: 2,
      awaiting: 28,
      groups: 2,
    });

    await groupFilter.selectOption("Team A");
    await expect(tableRows(page)).toHaveCount(10);
    await expectRosterSummary(page, {
      people: 10,
      submitted: 2,
      awaiting: 8,
      groups: 2,
    });
    await groupFilter.selectOption("__ungrouped__");
    await expect(tableRows(page)).toHaveCount(10);
    for (let number = 21; number <= 30; number += 1) {
      await expect(rosterRow(page, `Person ${number}`)).toBeVisible();
    }
    await groupFilter.selectOption("");
    await expect(tableRows(page)).toHaveCount(30);

    await responseFilter.selectOption("true");
    await expect(tableRows(page)).toHaveCount(2);
    await expect(rosterRow(page, "Person 02")).toBeVisible();
    await expect(rosterRow(page, "Person 03")).toBeVisible();
    await expectRosterSummary(page, {
      people: 2,
      submitted: 2,
      awaiting: 0,
      groups: 2,
    });
    await responseFilter.selectOption("false");
    await expect(tableRows(page)).toHaveCount(28);
    await responseFilter.selectOption("");
    await expect(tableRows(page)).toHaveCount(30);

    await invitationFilter.selectOption("sent");
    await expect(tableRows(page)).toHaveCount(1);
    await expect(rosterRow(page, "Person 01")).toBeVisible();
    await invitationFilter.selectOption("not_sent");
    await expect(tableRows(page)).toHaveCount(29);
    await invitationFilter.selectOption("");
    await expect(tableRows(page)).toHaveCount(30);

    // Paging keeps the selection across pages.
    const list = page.getByRole("region", { name: "Roster entries" });
    await expect(list.getByText("Page 1 of 1")).toBeVisible();
    await expect(list.getByRole("button", { name: "Next" })).toBeDisabled();
    await list.getByLabel("Rows per page").selectOption("25");
    await expect(list.getByText("Page 1 of 2")).toBeVisible();
    await expect(tableRows(page)).toHaveCount(25);
    const selectAll = page.getByLabel("Select all on page");
    await selectAll.check();
    await expect(selectionCount(page, 25)).toHaveCount(2);
    await list.getByRole("button", { name: "Next" }).click();
    await expect(list.getByText("Page 2 of 2")).toBeVisible();
    await expect(tableRows(page)).toHaveCount(5);
    for (let number = 26; number <= 30; number += 1) {
      await expect(rosterRow(page, `Person ${number}`)).toBeVisible();
    }
    await expect(selectAll).not.toBeChecked();
    await selectAll.check();
    await expect(selectionCount(page, 30)).toHaveCount(2);
    await list.getByRole("button", { name: "Previous" }).click();
    await expect(list.getByText("Page 1 of 2")).toBeVisible();
    await expect(tableRows(page)).toHaveCount(25);
    await expect(selectAll).toBeChecked();

    const bulk = await openBulkActions(page);
    await expect(bulk.locator("p.roster-panel__bulk-hint")).toHaveText(
      "30 participants will be updated.",
    );
    await bulk.getByLabel("Apply bulk weight").check();
    await bulk
      .getByRole("spinbutton", { name: "Bulk weight", exact: true })
      .fill("0.5");
    await bulk.getByRole("button", { name: "Apply update" }).click();
    await expect(rosterStatus(page)).toHaveText("Updated 30 roster entries.");
    await expect(selectionCount(page, 0)).toHaveCount(2);

    const roster = await rosterEntries(request, event.code, token);
    expect(roster.participants).toHaveLength(30);
    expect(roster.participants.map((entry) => entry.weight)).toEqual(
      Array(30).fill(0.5),
    );
  });

  test("bulk-updates people by selection, by current filters and with every group action", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-bulk",
    );
    const emails = {
      ann: personEmail("ann-alpha", runId),
      al: personEmail("al-alpha", runId),
      bea: personEmail("bea-beta", runId),
      cy: personEmail("cy-gamma", runId),
    };
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group"],
        ["Ann Alpha", emails.ann, "Faculty"],
        ["Al Alpha", emails.al, "Faculty; Staff"],
        ["Bea Beta", emails.bea, ""],
        ["Cy Gamma", emails.cy, "Staff"],
      ]),
    );

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(4);
    const bulk = await openBulkActions(page);
    const hint = bulk.locator("p.roster-panel__bulk-hint");
    const scope = bulk.getByLabel("Bulk update scope");
    const apply = bulk.getByRole("button", { name: "Apply update" });
    const select = (name) =>
      page.getByLabel(`Select ${name}`, { exact: true }).check();
    const applyBulk = () =>
      actAndWait(page, "PATCH", BULK_PATCH, () => apply.click());

    // Validation before anything is sent.
    await expect(hint).toHaveText(
      "Select participants in the list before applying changes.",
    );
    await apply.click();
    await expect(
      alertWith(page, "Select at least one person for this bulk update."),
    ).toBeVisible();
    await scope.selectOption("group");
    await expect(hint).toHaveText(
      "Changes apply to everyone in the chosen group.",
    );
    await apply.click();
    await expect(
      alertWith(page, "Choose a group for this bulk update."),
    ).toBeVisible();
    await scope.selectOption("selected");
    await select("Ann Alpha");
    await expect(hint).toHaveText("1 participant will be updated.");
    await apply.click();
    await expect(
      alertWith(
        page,
        "Choose a group, weight, included status, or a combination for this bulk update.",
      ),
    ).toBeVisible();

    // Selected people: leave two out of the results.
    await select("Bea Beta");
    await expect(hint).toHaveText("2 participants will be updated.");
    await bulk.getByLabel("Apply bulk included status").check();
    const bulkIncluded = bulk.getByLabel("Bulk included", { exact: true });
    await expect(bulkIncluded).toBeEnabled();
    await expect(bulkIncluded).toBeChecked();
    await bulkIncluded.uncheck();
    await applyBulk();
    await expect(rosterStatus(page)).toHaveText("Updated 2 roster entries.");
    await expect(selectionCount(page, 0)).toHaveCount(2);
    await expect(
      page.getByLabel("Include Ann Alpha", { exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByLabel("Include Bea Beta", { exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByLabel("Include Al Alpha", { exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("button", { name: "Include everyone" }),
    ).toBeVisible();
    await bulk.getByLabel("Apply bulk included status").uncheck();

    // Everyone matching the current search.
    const search = page.getByLabel("Search roster");
    await search.fill("alpha");
    await expect(tableRows(page)).toHaveCount(2);
    await scope.selectOption("filter");
    await expect(hint).toHaveText(
      "Changes apply to everyone matching the current filters.",
    );
    await bulk.getByLabel("Apply bulk weight").check();
    await bulk
      .getByRole("spinbutton", { name: "Bulk weight", exact: true })
      .fill("0.25");
    await applyBulk();
    await expect(rosterStatus(page)).toHaveText("Updated 2 roster entries.");
    await expect(
      page.getByLabel("Weight for Ann Alpha", { exact: true }),
    ).toHaveValue("0.25");
    await expect(
      page.getByLabel("Weight for Al Alpha", { exact: true }),
    ).toHaveValue("0.25");
    await search.fill("");
    await expect(tableRows(page)).toHaveCount(4);
    await bulk.getByLabel("Apply bulk weight").uncheck();
    await scope.selectOption("selected");

    // Group actions: add, remove, replace, clear with every group.
    await bulk.getByLabel("Apply bulk groups").check();
    const groupAction = bulk.getByLabel("Bulk group action");
    const targetGroup = bulk.getByLabel("Bulk target group");
    await expect(groupAction).toHaveValue("add");
    await select("Bea Beta");
    await select("Cy Gamma");
    await apply.click();
    await expect(
      alertWith(page, "Choose a group for this bulk update."),
    ).toBeVisible();
    await targetGroup.selectOption("Faculty");
    await applyBulk();
    await expect(rosterStatus(page)).toHaveText("Updated 2 roster entries.");
    await expect(groupRow(page, "Faculty")).toContainText("4 people");
    await expect(
      page.getByLabel("Bea Beta in Faculty", { exact: true }),
    ).toBeChecked();
    await expect(
      page.getByLabel("Cy Gamma in Faculty", { exact: true }),
    ).toBeChecked();

    // Ann was never in Staff, so only Al's row changes.
    await select("Ann Alpha");
    await select("Al Alpha");
    await groupAction.selectOption("remove");
    await targetGroup.selectOption("Staff");
    await applyBulk();
    await expect(rosterStatus(page)).toHaveText("Updated 1 roster entries.");
    await expect(groupRow(page, "Staff")).toContainText("1 person");
    await expect(
      page.getByLabel("Al Alpha in Staff", { exact: true }),
    ).not.toBeChecked();

    await select("Cy Gamma");
    await groupAction.selectOption("replace");
    await targetGroup.selectOption("Staff");
    await applyBulk();
    await expect(rosterStatus(page)).toHaveText("Updated 1 roster entries.");
    await expect(
      page.getByLabel("Cy Gamma in Faculty", { exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByLabel("Cy Gamma in Staff", { exact: true }),
    ).toBeChecked();
    await expect(groupRow(page, "Faculty")).toContainText("3 people");

    await select("Bea Beta");
    await groupAction.selectOption("clear");
    await expect(targetGroup).toBeDisabled();
    await bulk.getByLabel("Bulk every group").check();
    await applyBulk();
    await expect(rosterStatus(page)).toHaveText("Updated 1 roster entries.");
    await expect(
      page.getByLabel("All groups for Bea Beta", { exact: true }),
    ).toBeChecked();
    const beaFaculty = page.getByLabel("Bea Beta in Faculty", { exact: true });
    await expect(beaFaculty).toBeChecked();
    await expect(beaFaculty).toBeDisabled();
    await expect(beaFaculty).toHaveAttribute(
      "title",
      "Faculty: included through All groups",
    );
    await expect(groupRow(page, "Faculty")).toContainText("3 people");
    await expect(groupRow(page, "Staff")).toContainText("2 people");

    const byEmail = await rosterByEmail(request, event.code, token);
    const ann = byEmail.get(emails.ann);
    expect(groupNames(ann)).toEqual(["Faculty"]);
    expect(ann).toMatchObject({ allGroups: false, included: false });
    expect(ann.weight).toBe(0.25);
    const al = byEmail.get(emails.al);
    expect(groupNames(al)).toEqual(["Faculty"]);
    expect(al).toMatchObject({ included: true, weight: 0.25 });
    const bea = byEmail.get(emails.bea);
    expect(groupNames(bea)).toEqual([]);
    expect(bea).toMatchObject({ allGroups: true, included: false, weight: 1 });
    const cy = byEmail.get(emails.cy);
    expect(groupNames(cy)).toEqual(["Staff"]);
    expect(cy).toMatchObject({ allGroups: false, weight: 1 });
  });

  test("validates the add-person form and adds someone with an immediate invitation only once", async ({
    page,
    request,
  }) => {
    const { runId, organizerEmail, event } = await startOrganizerEvent(
      { page, request },
      "roster-add",
    );
    const nia = personEmail("nia", runId);

    await gotoRoster(page, event);
    await expect(
      page.getByRole("heading", { name: "No participants yet" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add person", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Add a person" }),
    ).toBeVisible();
    const fullName = page.getByLabel("Full name");
    const email = page.getByLabel("Email address");
    const phone = page.getByLabel("Phone (optional)");
    await expect(fullName).toBeFocused();

    // Enter submits the form as Add only. A click on Add only here is lost
    // to a product bug, pinned in the expected-fail test below.
    await fullName.press("Enter");
    await expect(page.getByText("Full name is required.")).toBeVisible();
    await expect(
      page.getByText(
        'Email address is required. If they have none, tick "No email of their own".',
      ),
    ).toBeVisible();
    await expect(fullName).toBeFocused();
    await expect(fullName).toHaveAttribute("aria-invalid", "true");

    await fullName.fill("Nia New");
    await email.fill("bad@");
    await email.press("Tab");
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await phone.fill("12");
    await phone.press("Tab");
    await expect(page.getByText("Enter a valid phone number.")).toBeVisible();

    // The server refuses the organizer's own address.
    await email.fill(organizerEmail);
    await phone.fill("");
    await page.getByRole("button", { name: "Add only" }).click();
    await expect(page.locator(".roster-invite-form__error")).toHaveText(
      'That is one of your own addresses. Use Add myself to put yourself on the roster, or check "No email of their own" to add a person you manage.',
    );

    await email.fill(nia);
    await phone.fill("+1 555 010 3000");
    const startedAt = Date.now() - 1000;
    await page.getByRole("button", { name: "Add and send invitation" }).click();
    const notice = page.locator(".roster-panel__invite-notice");
    await expect(notice).toHaveText(
      "Nia New is ready to respond. Their invitation was queued.",
    );
    await expect(
      page.getByRole("heading", { name: "Add a person" }),
    ).toHaveCount(0);
    await expect(page.locator("#roster-invite-trigger")).toBeFocused();
    await expect(page.getByLabel("Event delivery progress")).toBeVisible();
    const niaRow = rosterRow(page, "Nia New");
    await expect(niaRow).toContainText("Temporary");
    await expect(niaRow).toContainText("+1 555 010 3000");

    dispatchEmailJobs();
    const invitation = await latestEmailFor(
      nia,
      startedAt,
      invitationEmail(event.code),
    );
    expect(invitation).toContain("Share your availability");
    expect(invitation).toContain(`/temp-access?code=${event.code}`);
    await refreshWorkspace(page);
    await expect(niaRow.getByText("Sent", { exact: true })).toBeVisible();

    // Adding the same person again sends nothing.
    await page.getByRole("button", { name: "Add person", exact: true }).click();
    await fullName.fill("Nia New");
    await email.fill(nia);
    await page.getByRole("button", { name: "Add and send invitation" }).click();
    await expect(notice).toHaveText(
      "Nia New is already on this roster. No new invitation was sent.",
    );
    await expect(tableRows(page)).toHaveCount(1);
    expect(invitationJobCount(event.code, nia)).toBe(1);
  });

  // The Full name field validates on blur (RosterPanel.js onBlur), and its
  // inline error is only rendered once set (FormField), so it is inserted
  // above the action buttons. A mouse click on Add only while the empty name
  // field has focus blurs it on mousedown, the buttons move down about 25 px
  // before mouseup, and the click never reaches the submit button.
  test("a click on Add only in an empty Add person form reports both missing fields", async ({
    page,
    request,
  }) => {
    test.fail(
      true,
      "Product bug: the name field's blur error moves the Add person buttons, so the first click on Add only is lost",
    );
    const { event } = await startOrganizerEvent(
      { page, request },
      "roster-add-click",
    );

    await gotoRoster(page, event);
    await page.getByRole("button", { name: "Add person", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Add a person" }),
    ).toBeVisible();
    await expect(page.getByLabel("Full name")).toBeFocused();

    await page.getByRole("button", { name: "Add only" }).click();
    await expect(page.getByText("Full name is required.")).toBeVisible();
    await expect(
      page.getByText(
        'Email address is required. If they have none, tick "No email of their own".',
      ),
    ).toBeVisible();
  });

  test("skips already-invited people, resends on request, and shows Accepted once the person opens their link", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(180_000);
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-resend",
    );
    const ola = personEmail("ola", runId);
    const pia = personEmail("pia", runId);
    const seededAt = Date.now() - 1000;
    await addPersonApi(request, event.code, token, {
      name: "Ola Sent",
      email: ola,
      sendInvitation: true,
    });
    await addPersonApi(request, event.code, token, {
      name: "Pia Pending",
      email: pia,
      sendInvitation: false,
    });
    await addPersonApi(request, event.code, token, {
      name: "Quinn Managed",
      email: "",
      organizerManaged: true,
      sendInvitation: false,
    });
    dispatchEmailJobs();
    const firstInvitation = await latestEmailFor(
      ola,
      seededAt,
      invitationEmail(event.code),
    );
    await waitForInvitationStatus(request, event.code, token, ola, "sent");

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(3);
    await expect(
      rosterRow(page, "Ola Sent").getByText("Sent", { exact: true }),
    ).toBeVisible();
    await expect(
      rosterRow(page, "Pia Pending").getByText("Not sent", { exact: true }),
    ).toBeVisible();

    const sendButton = page
      .getByRole("button", { name: "Send invitation", exact: true })
      .first();
    const send = () =>
      actAndWait(page, "POST", INVITATIONS_POST, () => sendButton.click());

    // Without Resend, someone already invited is skipped.
    await page.getByLabel("Select Ola Sent", { exact: true }).check();
    await send();
    await expect(rosterStatus(page)).toHaveText(
      "Queued 0 invitation(s). 1 already invited were skipped.",
    );
    await expect(selectionCount(page, 0)).toHaveCount(2);

    // The Resend box is shared by both selection bars.
    const resend = page.getByLabel("Resend to people already invited");
    await resend.first().check();
    await expect(resend.last()).toBeChecked();
    await page.getByLabel("Select Ola Sent", { exact: true }).check();
    const resentAt = Date.now() - 1000;
    await send();
    await expect(rosterStatus(page)).toHaveText("Queued 1 invitation(s).");
    dispatchEmailJobs();
    const resendEmail = await latestEmailFor(
      ola,
      resentAt,
      (body) => invitationEmail(event.code)(body) && body !== firstInvitation,
    );
    expect(invitationJobCount(event.code, ola)).toBe(2);

    await resend.first().uncheck();
    await expect(resend.last()).not.toBeChecked();
    await page.getByLabel("Select Pia Pending", { exact: true }).check();
    await send();
    await expect(rosterStatus(page)).toHaveText("Queued 1 invitation(s).");
    dispatchEmailJobs();
    await waitForInvitationStatus(request, event.code, token, pia, "sent");
    await refreshWorkspace(page);
    await expect(
      rosterRow(page, "Pia Pending").getByText("Sent", { exact: true }),
    ).toBeVisible();

    // Ola opens the resent link in their own browser.
    const tempContext = await browser.newContext();
    try {
      const tempPage = await tempContext.newPage();
      const accessAt = Date.now() - 1000;
      await tempPage.goto(temporaryAccessPathFromEmail(resendEmail));
      await expect(
        tempPage.getByRole("heading", { name: "Check your email" }),
      ).toBeVisible();
      const code = await latestVerificationCode(
        ola,
        accessAt,
        "temp_event_access",
      );
      await tempPage.getByLabel("Verification code").fill(code);
      await tempPage
        .getByRole("button", { name: "Verify and open schedule" })
        .click();
      await expect(
        tempPage.getByRole("heading", { name: event.name }),
      ).toBeVisible();
      await expect(
        tempPage.getByText("You are responding as Ola Sent"),
      ).toBeVisible();
    } finally {
      await tempContext.close();
    }

    await refreshWorkspace(page);
    await expect(
      rosterRow(page, "Ola Sent").getByText("Accepted", { exact: true }),
    ).toBeVisible();

    // Once they have signed in, their address is locked.
    await page
      .getByRole("button", { name: "Edit name and email for Ola Sent" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit Ola Sent",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/Email address/)).toBeDisabled();
    await expect(dialog).toContainText(
      "They have already signed in or answered, so their address can no longer be changed. Remove them and add them again if it is wrong.",
    );
    await expect(dialog.getByLabel("Full name")).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    const invitationFilter = page.getByLabel("Filter by invitation");
    await invitationFilter.selectOption("accepted");
    await expect(tableRows(page)).toHaveCount(1);
    await expect(rosterRow(page, "Ola Sent")).toBeVisible();
    await expectRosterSummary(page, {
      people: 1,
      submitted: 0,
      awaiting: 1,
      groups: 0,
    });
    await invitationFilter.selectOption("sent");
    await expect(tableRows(page)).toHaveCount(1);
    await expect(rosterRow(page, "Pia Pending")).toBeVisible();
    await invitationFilter.selectOption("not_sent");
    await expect(tableRows(page)).toHaveCount(1);
    await expect(rosterRow(page, "Quinn Managed")).toBeVisible();
    await invitationFilter.selectOption("");
    await expect(tableRows(page)).toHaveCount(3);

    const byEmail = await rosterByEmail(request, event.code, token);
    expect(byEmail.get(ola).invitationStatus).toBe("accepted");
    expect(byEmail.get(pia).invitationStatus).toBe("sent");
  });

  test("edits a row's phone and inclusion inline and recovers from a version conflict", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-inline",
    );
    const sid = personEmail("sid", runId);
    const tia = personEmail("tia", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Sid Settings", sid],
        ["Tia Other", tia],
      ]),
    );

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(2);

    const phone = page.getByLabel("Phone for Sid Settings", { exact: true });
    await phone.fill("+1 555 123 4567");
    await actAndWait(page, "PATCH", ROW_PATCH, () => phone.press("Tab"));
    await expect(rosterStatus(page)).toHaveText("Sid Settings was updated.");
    await expect(rosterRow(page, "Sid Settings")).toContainText(
      "+1 555 123 4567",
    );
    expect(
      (await rosterByEmail(request, event.code, token)).get(sid).phone,
    ).toBe("+1 555 123 4567");

    // An invalid phone is refused and the draft goes back to the saved value.
    await phone.fill("abc");
    await actAndWait(page, "PATCH", ROW_PATCH, () => phone.press("Tab"));
    await expect(alertWith(page, "Enter a valid phone number.")).toBeVisible();
    await expect(phone).toHaveValue("+1 555 123 4567");

    const includeSid = page.getByLabel("Include Sid Settings", { exact: true });
    await actAndWait(page, "PATCH", ROW_PATCH, () => includeSid.click());
    await expect(includeSid).not.toBeChecked();
    await expect(rosterStatus(page)).toHaveText("Sid Settings was updated.");
    await expect(
      page.getByRole("button", { name: "Include everyone" }),
    ).toBeVisible();
    expect(
      (await rosterByEmail(request, event.code, token)).get(sid).included,
    ).toBe(false);

    // Another session changes Tia while live sync is held.
    const release = await freezeLiveSync(page);
    try {
      const entry = (await rosterByEmail(request, event.code, token)).get(tia);
      const outside = await apiJson(
        request,
        "PATCH",
        `/events/roster/${entry.id}?code=${event.code}`,
        token,
        { weight: 0.3, expectedVersion: entry.version },
      );
      expect(outside.response.status(), JSON.stringify(outside.payload)).toBe(
        200,
      );

      const includeTia = page.getByLabel("Include Tia Other", { exact: true });
      const weightTia = page.getByLabel("Weight for Tia Other", {
        exact: true,
      });
      await actAndWait(page, "PATCH", ROW_PATCH, () => includeTia.click());
      const conflict = alertWith(
        page,
        "Tia Other was changed in another session. Reload the latest values before editing this row again.",
      );
      await expect(conflict).toBeVisible();
      await expect(
        conflict.getByRole("button", { name: "Reload latest participant" }),
      ).toBeVisible();
      await expect(includeTia).toBeChecked();
      await expect(includeTia).toBeDisabled();
      await expect(weightTia).toHaveValue("1");
      await expect(weightTia).toBeDisabled();
      await expect(
        page.getByLabel("Phone for Tia Other", { exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByLabel("All groups for Tia Other", { exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Edit name and email for Tia Other" }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Remove Tia Other" }),
      ).toBeDisabled();

      await page
        .getByRole("button", { name: "Reload latest participant" })
        .click();
      await expect(rosterStatus(page)).toHaveText(
        "Latest values loaded for Tia Other.",
      );
      await expect(conflict).toHaveCount(0);
      await expect(weightTia).toHaveValue("0.3");
      await expect(weightTia).toBeEnabled();
      await expect(includeTia).toBeEnabled();

      await actAndWait(page, "PATCH", ROW_PATCH, () => includeTia.click());
      await expect(includeTia).not.toBeChecked();
      await expect(rosterStatus(page)).toHaveText("Tia Other was updated.");
    } finally {
      await release();
    }

    const tiaEntry = (await rosterByEmail(request, event.code, token)).get(tia);
    expect(tiaEntry).toMatchObject({ included: false, weight: 0.3 });
  });

  test("edits names and emails in the details dialog and confirms before discarding schedule edits", async ({
    page,
    request,
  }) => {
    const { runId, organizerEmail, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-details",
    );
    const vic = personEmail("vic", runId);
    const wes = personEmail("wes", runId);
    const uma = personEmail("uma", runId);
    await addPersonApi(request, event.code, token, {
      name: "Uma Managed",
      email: "",
      organizerManaged: true,
      sendInvitation: false,
    });
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Vic Temp", vic],
        ["Wes Other", wes],
      ]),
    );
    const writes = requestRecorder(
      page,
      (candidate) =>
        ["PATCH", "PUT"].includes(candidate.method()) &&
        candidate.url().includes("/events/"),
    );

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(3);
    await expect(rosterRow(page, "Uma Managed")).toContainText(
      "Organizer-managed",
    );
    await expect(rosterRow(page, "Uma Managed")).toContainText("No email");

    // The dialog is named after the person, so its fields are re-located for
    // every opening.
    let dialog;
    let fullName;
    let email;
    let save;
    const openDetails = async (name) => {
      await page
        .getByRole("button", { name: `Edit name and email for ${name}` })
        .click();
      dialog = page.getByRole("dialog", { name: `Edit ${name}`, exact: true });
      fullName = dialog.getByLabel("Full name");
      email = dialog.getByLabel(/Email address/);
      save = dialog.getByRole("button", { name: "Save details" });
      await expect(dialog).toBeVisible();
    };

    await openDetails("Vic Temp");
    await expect(dialog).toContainText(
      "Fix a name or an email address entered by mistake.",
    );
    await expect(dialog).toContainText(
      "A new address gets a fresh invitation that is not sent until you send it.",
    );
    await expect(fullName).toBeFocused();
    await fullName.fill("Changed Name");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rosterRow(page, "Vic Temp")).toBeVisible();
    expect(writes.entries).toEqual([]);

    await openDetails("Vic Temp");
    await fullName.fill("");
    await save.click();
    await expect(dialog.getByText("Full name is required.")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(writes.entries).toEqual([]);

    await fullName.fill("Vic Temp");
    await email.fill(wes);
    await actAndWait(page, "PATCH", ROW_PATCH, () => save.click());
    await expect(dialog.getByRole("alert")).toHaveText(
      `${wes} is already on this roster.`,
    );
    await expect(dialog).toBeVisible();

    await email.fill(organizerEmail);
    await actAndWait(page, "PATCH", ROW_PATCH, () => save.click());
    await expect(dialog.getByRole("alert")).toHaveText(
      "That is one of your own addresses. Enter this person's own email, or use Add myself to put yourself on the roster.",
    );

    await email.fill("bad@");
    await save.click();
    await expect(
      dialog.getByText("Enter a valid email address."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    // Someone the organizer manages: rename, then give them an address.
    await openDetails("Uma Managed");
    await expect(email).toHaveAttribute("placeholder", "No email");
    await expect(email).toHaveValue("");
    await expect(dialog).toContainText(
      "They have no email of their own yet. Add one to invite them later; their schedule stays as you entered it.",
    );
    await fullName.fill("Uma Morgan");
    await actAndWait(page, "PATCH", ROW_PATCH, () => save.click());
    await expect(dialog).toHaveCount(0);
    await expect(rosterStatus(page)).toHaveText("Uma Morgan was updated.");
    await expect(rosterRow(page, "Uma Morgan")).toContainText(
      "Organizer-managed",
    );
    await expect(rosterRow(page, "Uma Managed")).toHaveCount(0);

    await openDetails("Uma Morgan");
    await email.fill(uma);
    await actAndWait(page, "PATCH", ROW_PATCH, () => save.click());
    await expect(rosterStatus(page)).toHaveText(
      `Uma Morgan now uses ${uma}. Their invitation has not been sent to this address yet.`,
    );
    const umaRow = rosterRow(page, "Uma Morgan");
    await expect(umaRow).toContainText("Temporary");
    await expect(umaRow).toContainText(uma);
    await expect(umaRow).not.toContainText("No email");
    await expect(umaRow).not.toContainText("Organizer-managed");
    await page.getByLabel("Select Uma Morgan", { exact: true }).check();
    await actAndWait(page, "POST", INVITATIONS_POST, () =>
      page
        .getByRole("button", { name: "Send invitation", exact: true })
        .first()
        .click(),
    );
    await expect(rosterStatus(page)).toHaveText("Queued 1 invitation(s).");

    // The schedule drawer closes at once without changes and asks first
    // with them.
    const drawer = page.getByRole("dialog", {
      name: "Edit Vic Temp's schedule",
    });
    const openDrawer = async () => {
      await rosterRow(page, "Vic Temp")
        .getByRole("button", { name: "Edit schedule" })
        .click();
      await expect(drawer).toBeVisible();
    };
    const confirm = page.getByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    await openDrawer();
    await drawer.locator(".managed-drawer__close").click();
    await expect(drawer).toHaveCount(0);
    await expect(confirm).toHaveCount(0);

    await openDrawer();
    const displayName = drawer.getByRole("textbox", {
      name: "Event display name",
    });
    await displayName.fill("Vic Draft");
    writes.clear();
    await drawer.locator(".managed-drawer__close").click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      "You have unsaved changes to this participant's schedule. Discard them?",
    );
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();

    // Escape closes only the confirmation.
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(displayName).toHaveValue("Vic Draft");

    await drawer.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(rosterRow(page, "Vic Temp")).toBeVisible();
    expect(
      writes.entries.filter((entry) =>
        entry.includes("/events/participants/update"),
      ),
    ).toEqual([]);

    const byName = await rosterByName(request, event.code, token);
    expect(byName.get("Vic Temp").email).toBe(vic);
    expect(byName.get("Uma Morgan").organizerManaged).toBe(false);
  });

  test("creates and renames groups with validation, and the group filter follows a rename", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-group-names",
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
      ]),
    );

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(2);
    await expectRosterSummary(page, {
      people: 2,
      submitted: 0,
      awaiting: 2,
      groups: 1,
    });

    await page.getByRole("button", { name: "New group", exact: true }).click();
    const createHeading = page.getByRole("heading", { name: "Create a group" });
    await expect(createHeading).toBeVisible();
    const newName = page.getByLabel("New group name");
    await expect(newName).toBeFocused();
    const create = page.getByRole("button", {
      name: "Create group",
      exact: true,
    });
    await create.click();
    await expect(alertWith(page, "Enter a group name.")).toBeVisible();
    await newName.fill("ALL");
    await create.click();
    await expect(
      alertWith(page, "ALL is reserved for every group."),
    ).toBeVisible();
    await newName.fill("A;B");
    await create.click();
    await expect(
      alertWith(page, "Group names cannot contain ; or ,."),
    ).toBeVisible();
    await newName.fill("team a");
    await create.click();
    await expect(
      alertWith(page, "A group named Team A already exists."),
    ).toBeVisible();
    await expect(createHeading).toBeVisible();
    await expectRosterSummary(page, {
      people: 2,
      submitted: 0,
      awaiting: 2,
      groups: 1,
    });

    await newName.fill("Team B");
    await create.click();
    await expect(rosterStatus(page)).toHaveText("Created Team B.");
    await expect(createHeading).toHaveCount(0);
    await expectRosterSummary(page, {
      people: 2,
      submitted: 0,
      awaiting: 2,
      groups: 2,
    });
    await expect(groupRow(page, "Team B")).toContainText("0 people");
    await expect(
      page.getByLabel("Gia Group in Team B", { exact: true }),
    ).toHaveCount(1);

    // Rename validation.
    await groupRow(page, "Team B")
      .getByRole("button", { name: "Rename" })
      .click();
    const renameInput = page.getByLabel("New name for group Team B");
    await expect(renameInput).toBeFocused();
    await expect(renameInput).toHaveValue("Team B");
    const saveName = groupRow(page, "Team B").getByRole("button", {
      name: "Save name",
    });
    await renameInput.fill("team a");
    await saveName.click();
    await expect(
      alertWith(page, "A group named Team A already exists."),
    ).toBeVisible();
    await expect(renameInput).toBeVisible();
    await renameInput.fill("A;B");
    await saveName.click();
    await expect(groupRow(page, "Team B").getByRole("alert")).toHaveText(
      "Group names cannot contain ; or ,.",
    );
    await renameInput.press("Escape");
    await expect(renameInput).toHaveCount(0);
    await expect(groupRow(page, "Team B")).toBeVisible();

    await groupRow(page, "Team B")
      .getByRole("button", { name: "Rename" })
      .click();
    await renameInput.fill("Team Beta");
    await saveName.click();
    await expect(rosterStatus(page)).toHaveText("Renamed Team B to Team Beta.");
    await expect(groupRow(page, "Team Beta")).toBeVisible();
    await expect(groupRow(page, "Team B")).toHaveCount(0);
    await expect(
      page.getByLabel("Gia Group in Team Beta", { exact: true }),
    ).toHaveCount(1);

    // The group filter follows a rename of the group being shown.
    const groupFilter = page.getByLabel("Filter by group");
    await groupRow(page, "Team A")
      .getByRole("button", { name: "Show people" })
      .click();
    await expect(tableRows(page)).toHaveCount(1);
    await expect(rosterRow(page, "Gia Group")).toBeVisible();
    await expect(groupFilter).toHaveValue("Team A");
    await expect(groupRow(page, "Team A")).toContainText("Showing");
    await expect(
      groupRow(page, "Team A").getByRole("button", { name: "Show everyone" }),
    ).toHaveAttribute("aria-pressed", "true");

    await groupRow(page, "Team A")
      .getByRole("button", { name: "Rename" })
      .click();
    const renameTeamA = page.getByLabel("New name for group Team A");
    await renameTeamA.fill("Team Alpha");
    await renameTeamA.press("Enter");
    await expect(rosterStatus(page)).toHaveText(
      "Renamed Team A to Team Alpha.",
    );
    await expect(groupFilter).toHaveValue("Team Alpha");
    await expect(groupRow(page, "Team Alpha")).toContainText("Showing");
    await expect(
      page.getByLabel("Gia Group in Team Alpha", { exact: true }),
    ).toBeChecked();
    await expect(tableRows(page)).toHaveCount(1);

    await groupRow(page, "Team Alpha")
      .getByRole("button", { name: "Show everyone" })
      .click();
    await expect(tableRows(page)).toHaveCount(2);
    await expect(groupFilter).toHaveValue("");

    const roster = await rosterEntries(request, event.code, token);
    const giaEntry = roster.participants.find((entry) => entry.email === gia);
    expect(groupNames(giaEntry)).toEqual(["Team Alpha"]);
    expect(
      roster.stats.groups
        .map((group) => group.name)
        .filter(Boolean)
        .sort(),
    ).toEqual(["Team Alpha", "Team Beta"]);
  });

  test("moves selected people between groups, sets group inclusion and weight, and guards unsaved group ticks", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-group-moves",
    );
    const emails = {
      ivy: personEmail("ivy", runId),
      jon: personEmail("jon", runId),
      kim: personEmail("kim", runId),
      lou: personEmail("lou", runId),
    };
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group"],
        ["Ivy Two", emails.ivy, "Team A; Team B"],
        ["Jon One", emails.jon, "Team A"],
        ["Kim None", emails.kim, ""],
        ["Lou Bee", emails.lou, "Team B"],
      ]),
    );

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(4);
    const teamA = groupRow(page, "Team A");
    const teamB = groupRow(page, "Team B");
    const ungrouped = groupRow(page, "");
    await expect(teamA).toContainText("2 people");
    await expect(ungrouped).toContainText("1 person");
    await expect(
      teamB.getByRole("button", { name: "Remove selected" }),
    ).toBeDisabled();

    // One member left out makes the group's Included box mixed.
    const includeJon = page.getByLabel("Include Jon One", { exact: true });
    await actAndWait(page, "PATCH", ROW_PATCH, () => includeJon.click());
    await expect(includeJon).not.toBeChecked();
    const includeTeamA = teamA.getByLabel("Include group Team A");
    await expect(includeTeamA).toHaveJSProperty("indeterminate", true);
    await expect(includeTeamA).not.toBeChecked();
    await expect(includeTeamA).toHaveAttribute(
      "title",
      "Some people in this group are left out",
    );
    await expect(teamA).toContainText("Some");

    await actAndWait(page, "PATCH", BULK_PATCH, () => includeTeamA.click());
    await expect(rosterStatus(page)).toHaveText("Included 1 person in Team A.");
    await expect(includeTeamA).toBeChecked();
    await expect(includeTeamA).toHaveJSProperty("indeterminate", false);
    await expect(teamA).not.toContainText("Some");
    await expect(includeJon).toBeChecked();

    const ungroupedWeight = ungrouped.getByRole("spinbutton", {
      name: "Weight for ungrouped people",
    });
    await ungroupedWeight.fill("0.4");
    await actAndWait(page, "PATCH", BULK_PATCH, () =>
      ungroupedWeight.press("Enter"),
    );
    await expect(rosterStatus(page)).toHaveText(
      "Weight 0.4 now applies to 1 person in Ungrouped.",
    );
    await expect(
      page.getByLabel("Weight for Kim None", { exact: true }),
    ).toHaveValue("0.4");

    await actAndWait(page, "PATCH", BULK_PATCH, () =>
      ungrouped.getByLabel("Include ungrouped people").click(),
    );
    await expect(rosterStatus(page)).toHaveText(
      "Left 1 person in Ungrouped out of the results.",
    );
    await expect(
      page.getByLabel("Include Kim None", { exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Include everyone" }),
    ).toBeVisible();

    const groupFilter = page.getByLabel("Filter by group");
    await teamB.getByRole("button", { name: "Show people" }).click();
    await expect(tableRows(page)).toHaveCount(2);
    await expect(rosterRow(page, "Ivy Two")).toBeVisible();
    await expect(rosterRow(page, "Lou Bee")).toBeVisible();
    await expect(teamB).toContainText("Showing");
    await expect(groupFilter).toHaveValue("Team B");
    const showEveryone = teamB.getByRole("button", { name: "Show everyone" });
    await expect(showEveryone).toHaveAttribute("aria-pressed", "true");
    await showEveryone.click();
    await expect(tableRows(page)).toHaveCount(4);
    await expect(groupFilter).toHaveValue("");

    // Selected people leave one group, then every group.
    await page.getByLabel("Select Ivy Two", { exact: true }).check();
    await actAndWait(page, "PATCH", BULK_PATCH, () =>
      teamB.getByRole("button", { name: "Remove selected" }).click(),
    );
    await expect(rosterStatus(page)).toHaveText(
      "Removed 1 person from Team B.",
    );
    await expect(teamB).toContainText("1 person");
    await expect(
      page.getByLabel("Ivy Two in Team B", { exact: true }),
    ).not.toBeChecked();
    await expect(selectionCount(page, 1)).toHaveCount(2);

    await actAndWait(page, "PATCH", BULK_PATCH, () =>
      ungrouped.getByRole("button", { name: "Ungroup selected" }).click(),
    );
    await expect(rosterStatus(page)).toHaveText(
      "Removed 1 person from their groups.",
    );
    await expect(selectionCount(page, 0)).toHaveCount(2);
    await expect(ungrouped).toContainText("2 people");
    await expect(
      page.getByLabel("Ivy Two in Team A", { exact: true }),
    ).not.toBeChecked();
    await expect(teamA).toContainText("1 person");

    // A ticked membership box stays a local draft until saved or discarded.
    const kimTeamB = page.getByLabel("Kim None in Team B", { exact: true });
    await kimTeamB.check();
    const drafts = page.getByRole("region", { name: "Unsaved group changes" });
    await expect(drafts).toContainText(
      "1 unsaved group change for 1 person. Ticked boxes are not saved until you save them.",
    );
    expect(await beforeUnloadIsBlocked(page)).toBe(true);
    await drafts.getByRole("button", { name: "Discard" }).click();
    await expect(rosterStatus(page)).toHaveText(
      "Unsaved group changes were discarded.",
    );
    await expect(kimTeamB).not.toBeChecked();
    await expect(drafts).toHaveCount(0);
    expect(await beforeUnloadIsBlocked(page)).toBe(false);
    await expect(teamB).toContainText("1 person");

    const byEmail = await rosterByEmail(request, event.code, token);
    expect(groupNames(byEmail.get(emails.ivy))).toEqual([]);
    expect(byEmail.get(emails.ivy).allGroups).toBe(false);
    expect(byEmail.get(emails.kim)).toMatchObject({
      weight: 0.4,
      included: false,
    });
    expect(byEmail.get(emails.jon).included).toBe(true);
  });

  test("keeps the roster read-only while the event is closed or archived and restores it on reactivation", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-readonly",
    );
    const rey = personEmail("rey", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group"],
        ["Rey Read", rey, "Team A"],
        ["Sam Still", personEmail("sam", runId), ""],
      ]),
    );

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Add person", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Add a person" }),
    ).toBeVisible();

    await setEventStatus(request, event.code, token, "closed");
    await refreshWorkspace(page);
    const note = (text) => page.getByRole("note").filter({ hasText: text });
    await expect(
      note(
        "This roster is read-only while responses are closed. Reactivate the event to make changes.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Add a person" }),
    ).toHaveCount(0);
    for (const name of ["Add person", "Import roster", "Add myself"]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
        0,
      );
    }
    await expect(
      page.locator('details[aria-label="Bulk roster actions"]'),
    ).toHaveCount(0);
    await expect(selectionCount(page, 0)).toHaveCount(0);
    for (const label of [
      "Select all on page",
      "Select Rey Read",
      "Include Rey Read",
      "Weight for Rey Read",
      "Phone for Rey Read",
      "Rey Read in Team A",
      "All groups for Rey Read",
    ]) {
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    }
    await expect(
      rosterRow(page, "Rey Read").getByRole("button", {
        name: "Edit schedule",
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Edit name and email for Rey Read" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove Rey Read" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "New group", exact: true }),
    ).toHaveCount(0);
    const teamA = groupRow(page, "Team A");
    for (const name of [
      "Rename",
      "Delete group",
      "Only this group",
      "Add selected",
    ]) {
      await expect(teamA.getByRole("button", { name })).toHaveCount(0);
    }
    await expect(teamA.getByLabel("Include group Team A")).toBeDisabled();
    await expect(teamA.getByLabel("Weight for group Team A")).toBeDisabled();

    // Reading still works.
    await teamA.getByRole("button", { name: "Show people" }).click();
    await expect(tableRows(page)).toHaveCount(1);
    await teamA.getByRole("button", { name: "Show everyone" }).click();
    await expect(tableRows(page)).toHaveCount(2);
    const search = page.getByLabel("Search roster");
    await search.fill("sam");
    await expect(tableRows(page)).toHaveCount(1);
    await search.fill("");
    await expect(tableRows(page)).toHaveCount(2);

    const reyEntry = (await rosterByEmail(request, event.code, token)).get(rey);
    const refused = await apiJson(
      request,
      "PATCH",
      `/events/roster/${reyEntry.id}?code=${event.code}`,
      token,
      { included: false, expectedVersion: reyEntry.version },
    );
    expect(refused.response.status()).toBe(409);
    expect(refused.payload.error).toBe(
      "Responses cannot change while the event is closed.",
    );

    await setEventStatus(request, event.code, token, "archived");
    await refreshWorkspace(page);
    await expect(
      note("Reactivate this event before changing its roster."),
    ).toBeVisible();

    await setEventStatus(request, event.code, token, "active");
    await refreshWorkspace(page);
    await expect(page.locator(".roster-panel__note")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add person", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('details[aria-label="Bulk roster actions"]'),
    ).toBeVisible();
    await expect(
      page.getByLabel("Include Rey Read", { exact: true }),
    ).toBeEnabled();
  });

  // Each axe scan of the workspace takes several seconds, so the populated
  // states are split over three tests that run side by side. axe checks the
  // DOM, so one engine covers them.
  test.describe("accessibility of the populated roster", () => {
    test.skip(
      ({ browserName }) => browserName !== "chromium",
      "axe results do not depend on the engine",
    );

    test("populated roster states meet WCAG A/AA", async ({
      page,
      request,
    }) => {
      await openAccessibleRoster({ page, request });
      await expect(groupRow(page, "Team A")).toContainText("Some");
      await expect(
        page.getByRole("button", { name: "Include everyone" }),
      ).toBeVisible();
      await expectAccessible(page, "populated roster");

      const bulk = await openBulkActions(page);
      await expect(bulk.getByLabel("Bulk update scope")).toBeVisible();
      await expectAccessible(page, "bulk actions");

      await page
        .getByRole("button", { name: "Add person", exact: true })
        .click();
      await expect(page.getByLabel("Full name")).toBeFocused();
      await page.getByLabel("Full name").press("Enter");
      await expect(page.getByText("Full name is required.")).toBeVisible();
      await expect(
        page.getByText("Email address is required.", { exact: false }),
      ).toBeVisible();
      await expectAccessible(page, "add person errors");
      await page
        .locator("#roster-invite-form")
        .getByRole("button", { name: "Cancel" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Add a person" }),
      ).toHaveCount(0);

      await groupRow(page, "Team B")
        .getByRole("button", { name: "Rename" })
        .click();
      const rename = page.getByLabel("New name for group Team B");
      await expect(rename).toBeFocused();
      await expectAccessible(page, "group rename");
      await rename.press("Escape");
      await expect(rename).toHaveCount(0);
    });

    test("roster dialogs meet WCAG A/AA", async ({ page, request }) => {
      await openAccessibleRoster({ page, request });

      await page
        .getByRole("button", { name: "Edit name and email for Ana Access" })
        .click();
      const details = page.getByRole("dialog", {
        name: "Edit Ana Access",
        exact: true,
      });
      await expect(details).toBeVisible();
      await expectAccessible(page, "details dialog");
      await details.getByRole("button", { name: "Cancel" }).click();
      await expect(details).toHaveCount(0);

      await page.getByRole("button", { name: "Remove Ana Access" }).click();
      const remove = page.getByRole("dialog", {
        name: "Remove Ana Access from the roster?",
      });
      await expect(remove).toBeVisible();
      await expectAccessible(page, "remove dialog");
      await remove.getByRole("button", { name: "Cancel" }).click();
      await expect(remove).toHaveCount(0);

      await groupRow(page, "Team B")
        .getByRole("button", { name: "Delete group" })
        .click();
      const deleteGroup = page.getByRole("dialog", {
        name: "Delete group Team B?",
      });
      await expect(deleteGroup).toBeVisible();
      await expectAccessible(page, "delete group dialog");
      await deleteGroup.getByRole("button", { name: "Cancel" }).click();
      await expect(deleteGroup).toHaveCount(0);

      await rosterRow(page, "Ana Access")
        .getByRole("button", { name: "Edit schedule" })
        .click();
      const drawer = page.getByRole("dialog", {
        name: "Edit Ana Access's schedule",
      });
      await expect(drawer).toBeVisible();
      await drawer
        .getByRole("textbox", { name: "Event display name" })
        .fill("Ana Draft");
      await drawer.locator(".managed-drawer__close").click();
      const confirm = page.getByRole("dialog", {
        name: "Discard unsaved changes?",
      });
      await expect(confirm).toBeVisible();
      await expectAccessible(page, "discard confirmation");
      await confirm.getByRole("button", { name: "Discard changes" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("roster import wizard steps meet WCAG A/AA", async ({
      page,
      request,
    }) => {
      const { runId } = await openAccessibleRoster({ page, request });

      const wizard = await openImportWizard(page);
      await expect(
        wizard.getByRole("tab", { name: "Paste spreadsheet" }),
      ).toBeVisible();
      await expectAccessible(page, "import source");
      await pasteRosterSource(
        page,
        wizard,
        tsv([
          ["name", "email"],
          ["Dee New", personEmail("dee", runId)],
          ["Eli New", personEmail("eli", runId)],
        ]),
      );
      await expectAccessible(page, "import mapping");
      await previewImportRows(wizard);
      await wizard
        .getByRole("radio", {
          name: "Rebuild the roster and clear schedules, invitations, and pending delivery",
        })
        .check();
      await expect(
        wizard.getByLabel("Rebuild confirmation code"),
      ).toBeVisible();
      await expectAccessible(page, "import preview with rebuild");
      await wizard.getByRole("button", { name: "Close", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "Import roster" }),
      ).toHaveCount(0);
    });
  });

  test("reports renames and skipped invitations in accurate words", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "roster-wording",
    );
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email"],
        ["Rae Rename", personEmail("rae", runId)],
      ]),
    );
    await addPersonApi(request, event.code, token, {
      name: "Quinn Managed",
      email: "",
      organizerManaged: true,
      sendInvitation: false,
    });

    await gotoRoster(page, event);
    await expect(tableRows(page)).toHaveCount(2);

    await page
      .getByRole("button", { name: "Edit name and email for Rae Rename" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit Rae Rename",
      exact: true,
    });
    await dialog.getByLabel("Full name").fill("Rae Renamed");
    await actAndWait(page, "PATCH", ROW_PATCH, () =>
      dialog.getByRole("button", { name: "Save details" }).click(),
    );
    await expect(dialog).toHaveCount(0);
    await expect(rosterRow(page, "Rae Renamed")).toBeVisible();
    await expect(rosterStatus(page)).toHaveText("Rae Renamed was updated.");

    // Someone with no email of their own was never invited, so they are not
    // reported as already invited.
    await page.getByLabel("Select Quinn Managed", { exact: true }).check();
    await actAndWait(page, "POST", INVITATIONS_POST, () =>
      page
        .getByRole("button", { name: "Send invitation", exact: true })
        .first()
        .click(),
    );
    await expect(rosterStatus(page)).toHaveText(
      "Queued 0 invitation(s). 1 with no email of their own were not invited.",
    );
    await expect(rosterStatus(page)).not.toContainText("already invited");
  });
});
