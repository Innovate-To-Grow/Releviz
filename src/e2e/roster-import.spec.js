const { expect, test } = require("@playwright/test");
const {
  apiJson,
  dispatchEmailJobs,
  importRosterApi,
} = require("./helpers/releviz");
const {
  XLSX_MIME,
  csvBuffer,
  expectRosterSummary,
  gotoRoster,
  groupRow,
  importRow,
  importTile,
  invitationJobCount,
  mappingSelect,
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
  uploadRosterFile,
  waitForInvitationStatus,
  xlsxBuffer,
} = require("./helpers/roster");

// Drives RosterImportWizard end to end with CSV/XLSX files built at runtime
// and pasted tables. Every wizard lookup is scoped to the wizard region:
// "Group", "Weight", "Previous" and "Next" also exist elsewhere on the page.

test.describe.configure({ mode: "parallel" });

function stepItem(wizard, label) {
  return wizard
    .getByRole("list", { name: "Import steps" })
    .locator("li", { hasText: label });
}

// A review-table control by its exact label: "Name for row 5" is a
// substring of "Name for row 50".
function reviewField(wizard, label) {
  return wizard.getByLabel(label, { exact: true });
}

// Every review-table save re-reads the rows page; waiting for that read keeps
// the next edit from landing while the inputs are disabled.
function rowsReloaded(page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/events\/roster-imports\/[^/?]+\/rows\?/.test(response.url()),
  );
}

async function editReviewCell(page, wizard, label, value) {
  const input = reviewField(wizard, label);
  const reloaded = rowsReloaded(page);
  await input.fill(value);
  await input.press("Tab");
  expect((await reloaded).status()).toBe(200);
  await expect(input).toHaveValue(value);
  await expect(input).toBeEnabled();
}

async function toggleReviewCheckbox(page, wizard, label, checked) {
  const box = reviewField(wizard, label);
  const reloaded = rowsReloaded(page);
  await box.click();
  expect((await reloaded).status()).toBe(200);
  if (checked) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
  await expect(box).toBeEnabled();
}

test.describe("Roster import", () => {
  test("uploads a BOM, semicolon-delimited CSV, pages the review table and merges 55 people", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-csv",
    );
    const pad = (n) => String(n).padStart(2, "0");
    const lines = ["name;email;group"];
    for (let n = 1; n <= 55; n += 1) {
      lines.push(
        `Person ${pad(n)};p${pad(n)}-${runId}@example.com;${n <= 30 ? "Faculty" : "Staff"}`,
      );
    }
    const buffer = csvBuffer(lines.join("\n"), { bom: true });

    await gotoRoster(page, event);
    await expect(page.getByText("No participants yet")).toBeVisible();

    const wizard = await openImportWizard(page);
    await expect(stepItem(wizard, "Upload or paste")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(
      wizard.getByRole("tab", { name: "File upload" }),
    ).toHaveAttribute("aria-selected", "true");

    await uploadRosterFile(wizard, {
      name: "roster.csv",
      mimeType: "text/csv",
      buffer,
    });
    await wizard.getByRole("button", { name: "Continue to mapping" }).click();

    // One CSV sheet: no worksheet choice, and the ";" split plus the stripped
    // BOM let every header auto-map.
    await expect(
      wizard.getByText("Choose a worksheet and map its columns."),
    ).toBeVisible();
    await expect(stepItem(wizard, "Map columns")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(
      wizard.getByRole("combobox", { name: "Worksheet" }),
    ).toHaveCount(0);
    await expect(mappingSelect(wizard, "Name *")).toHaveValue("0");
    await expect(mappingSelect(wizard, "Email *")).toHaveValue("1");
    await expect(mappingSelect(wizard, "Group")).toHaveValue("2");
    await expect(
      wizard.getByRole("spinbutton", { name: "Header row" }),
    ).toHaveValue("1");

    await previewImportRows(wizard);
    await expect(importTile(page, wizard, "Selected")).toHaveText("55");
    await expect(importTile(page, wizard, "Valid")).toHaveText("55");
    await expect(importTile(page, wizard, "Invalid")).toHaveText("0");
    await expect(importTile(page, wizard, "Conflicts")).toHaveText("0");
    await expect(stepItem(wizard, "Review and commit")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(wizard.getByText("Page 1 of 2")).toBeVisible();
    await expect(reviewField(wizard, "Name for row 2")).toHaveValue(
      "Person 01",
    );
    await expect(reviewField(wizard, "Name for row 51")).toBeVisible();
    await expect(reviewField(wizard, "Name for row 52")).toHaveCount(0);

    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await expect(wizard.getByText("Page 2 of 2")).toBeVisible();
    await expect(reviewField(wizard, "Name for row 56")).toHaveValue(
      "Person 55",
    );
    await expect(reviewField(wizard, "Name for row 51")).toHaveCount(0);

    await wizard.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(wizard.getByText("Page 1 of 2")).toBeVisible();
    await expect(reviewField(wizard, "Name for row 2")).toHaveValue(
      "Person 01",
    );

    await wizard
      .getByRole("button", { name: "Merge roster", exact: true })
      .click();
    await expect(rosterStatus(page)).toHaveText(
      "Imported 55 people: 55 added, 0 updated. No invitations were sent.",
    );
    await expect(
      page.getByRole("region", { name: "Import roster" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Import roster", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await expectRosterSummary(page, {
      people: 55,
      submitted: 0,
      awaiting: 55,
      groups: 2,
    });
    await expect(
      page
        .getByRole("region", { name: "Roster entries" })
        .getByText("Page 1 of 2"),
    ).toBeVisible();

    const roster = await rosterEntries(request, event.code, token);
    expect(roster.pagination.total).toBe(55);
    const byEmail = new Map(
      roster.participants.map((entry) => [entry.email, entry]),
    );
    expect(byEmail.get(`p55-${runId}@example.com`)).toMatchObject({
      name: "Person 55",
      group: "Staff",
    });
    expect(byEmail.get(`p01-${runId}@example.com`)).toMatchObject({
      name: "Person 01",
      group: "Faculty",
    });
  });

  test("picks a worksheet from a multi-sheet XLSX, reloads columns from a later header row, and applies mapping overrides and defaults", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-xlsx",
    );
    const email = (label) => `${label}-${runId}@example.com`;
    const buffer = xlsxBuffer([
      {
        name: "Faculty",
        rows: [
          ["name", "email", "group"],
          ["Fay Faculty", email("fay"), "Faculty"],
          ["Gus Faculty", email("gus"), "Faculty"],
        ],
      },
      {
        name: "TAs",
        rows: [
          ["Spring TAs"],
          ["Full Name", "Work Email", "Section"],
          ["Tara TA", email("tara"), "S1"],
          ["Theo TA", email("theo"), "S2"],
          ["Tim TA", email("tim"), "S3"],
        ],
      },
    ]);

    await gotoRoster(page, event);
    const wizard = await openImportWizard(page);
    await uploadRosterFile(wizard, {
      name: "roster.xlsx",
      mimeType: XLSX_MIME,
      buffer,
    });
    await wizard.getByRole("button", { name: "Continue to mapping" }).click();

    const sheet = wizard.getByRole("combobox", { name: "Worksheet" });
    await expect(sheet.locator("option")).toHaveText([
      "Choose a worksheet",
      "Faculty (2 rows)",
      "TAs (4 rows)",
    ]);
    await expect(sheet).toHaveValue("");
    const error = wizard.getByRole("alert");
    const preview = wizard.getByRole("button", { name: "Preview rows" });

    await preview.click();
    await expect(error).toHaveText(
      "Choose a worksheet before mapping columns.",
    );

    await sheet.selectOption("TAs");
    const headerRow = wizard.getByRole("spinbutton", { name: "Header row" });
    await expect(headerRow).toHaveValue("1");
    await expect(mappingSelect(wizard, "Name *")).toHaveValue("");
    await expect(
      mappingSelect(wizard, "Name *").locator("option", {
        hasText: "Spring TAs",
      }),
    ).toHaveCount(1);

    await preview.click();
    await expect(error).toHaveText("Map both the name and email columns.");

    // A later header row is read from the server before anything is mapped.
    await headerRow.fill("2");
    await preview.click();
    await expect(wizard.getByRole("status")).toHaveText(
      "Columns loaded from the selected header row. Check the mapping, then preview.",
    );
    await expect(error).toHaveCount(0);
    await expect(mappingSelect(wizard, "Name *")).toHaveValue("0");
    await expect(mappingSelect(wizard, "Name *").locator("option")).toHaveText([
      "Select a column",
      "Full Name",
      "Work Email",
      "Section",
    ]);
    await expect(mappingSelect(wizard, "Email *")).toHaveValue("");

    await preview.click();
    await expect(error).toHaveText("Map both the name and email columns.");

    await mappingSelect(wizard, "Email *").selectOption({
      label: "Work Email",
    });
    await expect(mappingSelect(wizard, "Email *")).toHaveValue("1");

    await wizard.getByLabel("Default group", { exact: true }).fill("ALL");
    await wizard.getByLabel("Default weight", { exact: true }).fill("0.5");
    await wizard.getByLabel("Include by default", { exact: true }).uncheck();
    await expect(
      mappingSelect(wizard, "Group").locator("option").first(),
    ).toHaveText("No column (everyone in ALL)");
    await expect(
      mappingSelect(wizard, "Weight").locator("option").first(),
    ).toHaveText("No column (weight 0.5)");
    await expect(
      mappingSelect(wizard, "Included").locator("option").first(),
    ).toHaveText("No column (everyone left out)");

    await previewImportRows(wizard);
    await expect(importTile(page, wizard, "Selected")).toHaveText("3");
    await expect(importTile(page, wizard, "Valid")).toHaveText("3");
    await expect(reviewField(wizard, "Name for row 3")).toHaveValue("Tara TA");
    await expect(reviewField(wizard, "Name for row 2")).toHaveCount(0);
    await expect(reviewField(wizard, "Group for row 3")).toHaveValue("ALL");
    await expect(reviewField(wizard, "Weight for row 3")).toHaveValue("0.5");
    await expect(reviewField(wizard, "Included for row 3")).not.toBeChecked();

    await wizard
      .getByRole("button", { name: "Merge roster", exact: true })
      .click();
    await expect(rosterStatus(page)).toHaveText(
      "Imported 3 people: 3 added, 0 updated. No invitations were sent.",
    );
    await expect(
      page.getByLabel("All groups for Tara TA", { exact: true }),
    ).toBeChecked();
    await expect(
      page.getByLabel("Include Tara TA", { exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByLabel("Weight for Tara TA", { exact: true }),
    ).toHaveValue("0.5");

    const roster = await rosterByEmail(request, event.code, token);
    expect([...roster.keys()].sort()).toEqual(
      [email("tara"), email("theo"), email("tim")].sort(),
    );
    for (const entry of roster.values()) {
      expect(entry).toMatchObject({
        allGroups: true,
        weight: 0.5,
        included: false,
      });
    }
  });

  test("flags invalid and duplicate rows, blocks the commit, and fixes every field in the review table", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-review",
    );
    const email = (label) => `${label}-${runId}@example.com`;
    const text = tsv([
      ["name", "email", "group", "weight"],
      ["Ada Lovelace", email("ada"), "Team A", ""],
      ["Ada Lovelace", email("ada"), "Team B", ""],
      ["Bob Stone", email("bob"), "", ""],
      ["Robert Stone", email("bob"), "", ""],
      ["Eve Invalid", "not-an-email", "", ""],
      ["Zed Heavy", email("zed"), "", "2"],
    ]);

    await gotoRoster(page, event);
    const wizard = await openImportWizard(page);
    await pasteRosterSource(page, wizard, text);
    await previewImportRows(wizard);

    await expect(importTile(page, wizard, "Selected")).toHaveText("5");
    await expect(importTile(page, wizard, "Valid")).toHaveText("1");
    await expect(importTile(page, wizard, "Invalid")).toHaveText("4");
    await expect(importTile(page, wizard, "Conflicts")).toHaveText("2");

    // The same person under two groups collapses into the first row.
    await expect(importRow(page, wizard, 2)).toContainText("Ready");
    await expect(reviewField(wizard, "Group for row 2")).toHaveValue(
      "Team A; Team B",
    );
    await expect(importRow(page, wizard, 3)).toContainText(
      "Identical duplicate merged",
    );
    await expect(reviewField(wizard, "Select row 3")).not.toBeChecked();
    await expect(importRow(page, wizard, 3)).toHaveClass(/opacity-50/);
    for (const rowNumber of [4, 5]) {
      await expect(importRow(page, wizard, rowNumber)).toContainText("Invalid");
      await expect(importRow(page, wizard, rowNumber)).toContainText(
        "Conflicting duplicate email.",
      );
    }
    await expect(importRow(page, wizard, 6)).toContainText("Invalid");
    await expect(importRow(page, wizard, 6)).toContainText("email is invalid.");
    await expect(importRow(page, wizard, 7)).toContainText("Invalid");
    await expect(importRow(page, wizard, 7)).toContainText(
      "weight must be between 0 and 1.",
    );
    await expect(reviewField(wizard, "Weight for row 7")).toHaveValue("1");

    // One valid row enables the button, but the server refuses the commit.
    const merge = wizard.getByRole("button", {
      name: "Merge roster",
      exact: true,
    });
    await expect(merge).toBeEnabled();
    await merge.click();
    await expect(wizard.locator(".roster-import__error")).toHaveText(
      "Resolve or deselect invalid roster rows before committing.",
    );

    await editReviewCell(page, wizard, "Email for row 5", email("robert"));
    await expect(importTile(page, wizard, "Conflicts")).toHaveText("0");
    await expect(importRow(page, wizard, 4)).toContainText("Ready");
    await expect(importRow(page, wizard, 5)).toContainText("Ready");
    await expect(importTile(page, wizard, "Valid")).toHaveText("3");
    await expect(importTile(page, wizard, "Invalid")).toHaveText("2");
    await expect(wizard.locator(".roster-import__error")).toHaveCount(0);

    await toggleReviewCheckbox(page, wizard, "Select row 6", false);
    await expect(importTile(page, wizard, "Selected")).toHaveText("4");
    await expect(importTile(page, wizard, "Invalid")).toHaveText("1");

    await editReviewCell(page, wizard, "Weight for row 7", "0.5");
    await expect(importRow(page, wizard, 7)).toContainText("Ready");
    await expect(importTile(page, wizard, "Invalid")).toHaveText("0");
    await expect(importTile(page, wizard, "Valid")).toHaveText("4");

    await editReviewCell(page, wizard, "Group for row 4", "Team C");
    await editReviewCell(page, wizard, "Phone for row 4", "+1 555 010 4000");
    await expect(importRow(page, wizard, 4)).toContainText("Ready");
    await editReviewCell(page, wizard, "Name for row 5", "Robbie Stone");
    await toggleReviewCheckbox(page, wizard, "Included for row 5", false);
    await expect(reviewField(wizard, "Group for row 4")).toHaveValue("Team C");
    await expect(reviewField(wizard, "Phone for row 4")).toHaveValue(
      "+1 555 010 4000",
    );
    await expect(reviewField(wizard, "Name for row 5")).toHaveValue(
      "Robbie Stone",
    );
    await expect(importTile(page, wizard, "Valid")).toHaveText("4");

    await merge.click();
    await expect(rosterStatus(page)).toHaveText(
      "Imported 4 people: 4 added, 0 updated. No invitations were sent.",
    );
    await expectRosterSummary(page, {
      people: 4,
      submitted: 0,
      awaiting: 4,
      groups: 3,
    });
    await expect(
      page.getByLabel("Ada Lovelace in Team A", { exact: true }),
    ).toBeChecked();
    await expect(
      page.getByLabel("Ada Lovelace in Team B", { exact: true }),
    ).toBeChecked();
    await expect(groupRow(page, "Team C")).toContainText("1 person");
    await expect(rosterRow(page, "Eve Invalid")).toHaveCount(0);

    const roster = await rosterByEmail(request, event.code, token);
    expect(roster.size).toBe(4);
    expect(roster.get(email("bob"))).toMatchObject({
      name: "Bob Stone",
      group: "Team C",
      phone: "+1 555 010 4000",
    });
    expect(roster.get(email("robert"))).toMatchObject({
      name: "Robbie Stone",
      included: false,
    });
    expect(roster.get(email("zed"))).toMatchObject({ weight: 0.5 });
    expect(
      roster
        .get(email("ada"))
        .groups.map((group) => group.name)
        .sort(),
    ).toEqual(["Team A", "Team B"]);
  });

  test("merges onto existing people without touching their schedules, then rebuilds only after the exact event code", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-rebuild",
    );
    const email = (label) => `${label}-${runId}@example.com`;
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group", "weight"],
        ["Pat Keep", email("pat"), "Team A", "0.5"],
        ["Rex Invited", email("rex"), "Team A", "1"],
      ]),
    );
    const seeded = await rosterByEmail(request, event.code, token);
    await submitOnBehalf(request, token, event, seeded.get(email("pat")));
    await sendInvitationsApi(request, event.code, token, [
      seeded.get(email("rex")).id,
    ]);
    dispatchEmailJobs();
    await waitForInvitationStatus(
      request,
      event.code,
      token,
      email("rex"),
      "sent",
    );
    const joined = await apiJson(
      request,
      "POST",
      `/events/participants?code=${event.code}`,
      token,
      {},
    );
    expect(joined.response.status(), JSON.stringify(joined.payload)).toBe(201);

    await gotoRoster(page, event);
    await expect(page.locator("tr.roster-table__row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Add myself" })).toHaveCount(
      0,
    );
    await expectRosterSummary(page, {
      people: 3,
      submitted: 1,
      awaiting: 2,
      groups: 1,
    });

    // Merge: the existing person is renamed, gains a group and a weight, keeps
    // the submitted schedule, and is not invited again.
    let wizard = await openImportWizard(page);
    await pasteRosterSource(
      page,
      wizard,
      tsv([
        ["name", "email", "group", "weight"],
        ["Pat Renamed", email("pat"), "Team B", "0.25"],
      ]),
    );
    await previewImportRows(wizard);
    await expect(importRow(page, wizard, 2)).toContainText("Ready");
    await wizard
      .getByLabel("Send invitations to newly added people", { exact: true })
      .check();
    await wizard
      .getByRole("button", { name: "Merge roster and invite new people" })
      .click();
    await expect(rosterStatus(page)).toHaveText(
      "Imported 1 people: no new participants were added, so no invitations were sent.",
    );
    await expect(rosterRow(page, "Pat Renamed")).toBeVisible();
    await expect(rosterRow(page, "Pat Keep")).toHaveCount(0);
    await expect(rosterRow(page, "Pat Renamed")).toContainText(
      /Response\s*Submitted/,
    );
    await expect(
      page.getByLabel("Pat Renamed in Team A", { exact: true }),
    ).toBeChecked();
    await expect(
      page.getByLabel("Pat Renamed in Team B", { exact: true }),
    ).toBeChecked();
    await expect(
      page.getByLabel("Weight for Pat Renamed", { exact: true }),
    ).toHaveValue("0.25");
    await expectRosterSummary(page, {
      people: 3,
      submitted: 1,
      awaiting: 2,
      groups: 2,
    });
    expect(invitationJobCount(event.code, email("pat"))).toBe(0);

    // Rebuild: nothing may be mid-delivery, and the commit stays disabled
    // until the event code is typed exactly.
    dispatchEmailJobs();
    wizard = await openImportWizard(page);
    await pasteRosterSource(
      page,
      wizard,
      tsv([
        ["name", "email"],
        ["New One", email("new1")],
        ["New Two", email("new2")],
      ]),
    );
    await previewImportRows(wizard);
    await wizard
      .getByLabel(
        "Rebuild the roster and clear schedules, invitations, and pending delivery",
        { exact: true },
      )
      .check();
    await expect(wizard.getByRole("note")).toContainText(
      "Rebuilding clears schedules, invitations, and pending delivery.",
    );
    await expect(
      wizard.getByText(`Type ${event.code} to confirm`, { exact: true }),
    ).toBeVisible();
    const commit = wizard.getByRole("button", {
      name: "Rebuild roster",
      exact: true,
    });
    const confirmation = wizard.getByLabel("Rebuild confirmation code", {
      exact: true,
    });
    await expect(commit).toBeDisabled();
    if (event.code.toLowerCase() !== event.code) {
      await confirmation.fill(event.code.toLowerCase());
      await expect(commit).toBeDisabled();
    }
    await confirmation.fill(event.code);
    await expect(commit).toBeEnabled();
    await commit.click();

    await expect(rosterStatus(page)).toHaveText(
      "Imported 2 people: 2 added, 0 updated. No invitations were sent.",
    );
    await expectRosterSummary(page, {
      people: 2,
      submitted: 0,
      awaiting: 2,
      groups: 0,
    });
    await expect(page.locator("tr.roster-table__row")).toHaveCount(2);
    await expect(rosterRow(page, "New One")).toBeVisible();
    await expect(rosterRow(page, "New Two")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add myself" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "No groups yet. Create a group, then tick its column for each person once they are on the roster.",
      ),
    ).toBeVisible();
    await expect(rosterRow(page, "New One")).toContainText("Not sent");

    const invitations = await apiJson(
      request,
      "GET",
      `/events/invitations?code=${event.code}`,
      token,
    );
    expect(invitations.response.status()).toBe(200);
    expect(
      invitations.payload.invitations
        .map((invitation) => invitation.email)
        .sort(),
    ).toEqual([email("new1"), email("new2")].sort());
    const roster = await rosterEntries(request, event.code, token);
    expect(roster.organizerOnRoster).toBe(false);
  });

  test("rejects unusable sources and navigates the wizard with the keyboard, Back, Hide import and Close", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-nav",
    );
    const deletes = requestRecorder(
      page,
      (request) =>
        request.method() === "DELETE" &&
        request.url().includes("/events/roster-imports/"),
    );

    await gotoRoster(page, event);
    const wizard = await openImportWizard(page);
    await expect(
      page.getByRole("button", { name: "Hide import", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    const error = wizard.locator(".roster-import__error");
    const next = wizard.getByRole("button", { name: "Continue to mapping" });
    const upload = async (file, message) => {
      await uploadRosterFile(wizard, file);
      await next.click();
      await expect(error).toHaveText(message);
    };

    await next.click();
    await expect(error).toHaveText("Choose a .csv or .xlsx file first.");
    await upload(
      {
        name: "people.xls",
        mimeType: "application/vnd.ms-excel",
        buffer: Buffer.from("x"),
      },
      "Only .csv and .xlsx files are supported.",
    );
    await upload(
      {
        name: "big.csv",
        mimeType: "text/csv",
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
      },
      "The compressed file must be 5 MiB or smaller.",
    );
    await upload(
      {
        name: "bad.xlsx",
        mimeType: XLSX_MIME,
        buffer: Buffer.from("not a zip"),
      },
      "The uploaded file is not a valid .xlsx workbook.",
    );
    await upload(
      {
        name: "latin.csv",
        mimeType: "text/csv",
        buffer: Buffer.from([0xff, 0xfe, 0x41]),
      },
      "CSV and pasted data must be UTF-8 encoded.",
    );
    await upload(
      { name: "empty.csv", mimeType: "text/csv", buffer: Buffer.from("\n\n") },
      "The table is empty.",
    );

    // Roving-tabindex source tabs follow the arrow, Home and End keys.
    const fileTab = wizard.getByRole("tab", { name: "File upload" });
    const pasteTab = wizard.getByRole("tab", { name: "Paste spreadsheet" });
    const pasted = wizard.getByRole("textbox", { name: "Pasted roster rows" });
    const expectTab = async (tab) => {
      await expect(tab).toBeFocused();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    };
    await fileTab.focus();
    await page.keyboard.press("ArrowRight");
    await expectTab(pasteTab);
    await expect(pasted).toBeVisible();
    await page.keyboard.press("Home");
    await expectTab(fileTab);
    await expect(wizard.getByLabel("CSV or XLSX file")).toBeVisible();
    await page.keyboard.press("End");
    await expectTab(pasteTab);
    await page.keyboard.press("ArrowLeft");
    await expectTab(fileTab);
    await page.keyboard.press("End");
    await expectTab(pasteTab);

    await next.click();
    await expect(error).toHaveText(
      "Paste rows copied from Google Sheets or Excel first.",
    );

    const text = tsv([
      ["name", "email"],
      ["Nav Test", `nav-${runId}@example.com`],
    ]);
    await pasted.fill(text);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/events\/roster-imports\?/.test(response.url()),
    );
    await next.click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const firstImportId = (await createdResponse.json()).import.id;
    await expect(stepItem(wizard, "Map columns")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(error).toHaveCount(0);

    const back = wizard.getByRole("button", { name: "Back", exact: true });
    await back.click();
    await expect(stepItem(wizard, "Upload or paste")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(pasteTab).toHaveAttribute("aria-selected", "true");
    await expect(pasted).toHaveValue(text);

    // Continuing again creates a second preview batch; that one is hidden.
    const recreated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/events\/roster-imports\?/.test(response.url()),
    );
    await next.click();
    const recreatedResponse = await recreated;
    expect(recreatedResponse.status()).toBe(201);
    const hiddenImportId = (await recreatedResponse.json()).import.id;
    expect(hiddenImportId).not.toBe(firstImportId);
    await expect(stepItem(wizard, "Map columns")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await previewImportRows(wizard);
    await back.click();
    await expect(mappingSelect(wizard, "Name *")).toBeVisible();
    await expect(stepItem(wizard, "Map columns")).toHaveAttribute(
      "aria-current",
      "step",
    );

    // Hide import only hides the wizard: the preview stays on the server.
    await page
      .getByRole("button", { name: "Hide import", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Import roster" }),
    ).toHaveCount(0);
    expect(deletes.entries).toEqual([]);
    const kept = await apiJson(
      request,
      "GET",
      `/events/roster-imports/${hiddenImportId}/rows?code=${event.code}`,
      token,
    );
    expect(kept.response.status()).toBe(200);
    expect(kept.payload.import.status).toBe("preview");
    expect(kept.payload.rows).toHaveLength(1);

    const reopened = await openImportWizard(page);
    await expect(stepItem(reopened, "Upload or paste")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(
      reopened.getByRole("tab", { name: "File upload" }),
    ).toHaveAttribute("aria-selected", "true");

    // Close cancels the preview on the server.
    await pasteRosterSource(page, reopened, text);
    const canceled = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/events/roster-imports/"),
    );
    await reopened.getByRole("button", { name: "Close", exact: true }).click();
    const canceledResponse = await canceled;
    expect(canceledResponse.status()).toBe(200);
    expect(await canceledResponse.json()).toMatchObject({ status: "canceled" });
    await expect(
      page.getByRole("region", { name: "Import roster" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Import roster", exact: true }),
    ).toBeVisible();
  });
});
