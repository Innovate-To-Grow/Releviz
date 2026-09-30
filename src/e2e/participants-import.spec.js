const { expect, test } = require("@playwright/test");
const {
  apiJson,
  importRosterApi,
  runDjangoJson,
} = require("./helpers/releviz");
const {
  XLSX_MIME,
  csvBuffer,
  emailField,
  expectToast,
  gotoParticipants,
  importColumnSelect,
  importRow,
  importStep,
  invitationJobCount,
  openImportSheet,
  participantRow,
  participantSummary,
  pasteParticipantRows,
  previewImportRows,
  requestRecorder,
  rosterByEmail,
  rosterEntries,
  sendInvitationsApi,
  startOrganizerEvent,
  submitOnBehalf,
  tsv,
  uploadParticipantFile,
  waitForInvitationStatus,
  xlsxBuffer,
} = require("./helpers/participants");

// The organizer's import sheet (RosterImportWizard) from end to end: the
// Source step's file and paste checks and its keyboard tabs, the Columns
// step's worksheet, header row, column and default choices, the Review
// step's statuses, filter, selection, inline edits and paging, the two ways
// to apply an import (merge onto the list, or replace it after typing the
// event code), the Done step's actions, and leaving an import (Back, the
// discard prompt, an expired preview). CSV and XLSX files are built at
// runtime. Every test registers its own organizer and event and asserts only
// on its own rows.

const IMPORT_CREATE = /\/events\/roster-imports\?/;
const IMPORT_DETAIL = /\/events\/roster-imports\/[^/?]+\?/;
const IMPORT_ROWS = /\/events\/roster-imports\/[^/?]+\/rows\?/;
const IMPORT_COMMIT = /\/events\/roster-imports\/[^/?]+\/commit\?/;

function importResponse(page, method, pattern) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method && pattern.test(response.url()),
  );
}

function personEmail(slug, runId) {
  return `${slug}-${runId}@example.com`;
}

// A control by its exact label: "Name for row 5" is a substring of
// "Name for row 50".
function reviewField(sheet, label) {
  return sheet.getByLabel(label, { exact: true });
}

function rowStatus(sheet, rowNumber) {
  return importRow(sheet, rowNumber).locator(".import-sheet__status");
}

function reviewSummary(sheet) {
  return sheet.locator(".import-sheet__summary");
}

function commitNote(sheet) {
  return sheet.locator(".import-sheet__footer-note");
}

// The Columns step's "Row N shows" cell for one field.
function sampleFor(sheet, field) {
  return sheet
    .getByRole("row")
    .filter({
      has: sheet
        .page()
        .getByRole("combobox", { name: `Column for ${field}`, exact: true }),
    })
    .locator(".import-sheet__sample");
}

function continueButton(sheet) {
  return sheet.getByRole("button", { name: "Continue", exact: true });
}

// Every Review-step change is saved (PUT) and then the page of rows is read
// again; waiting for both keeps the next edit from landing while the inputs
// are disabled.
async function savedAndReloaded(page, change) {
  const saved = importResponse(page, "PUT", IMPORT_DETAIL);
  const reloaded = importResponse(page, "GET", IMPORT_ROWS);
  await change();
  const savedResponse = await saved;
  expect(savedResponse.status(), await savedResponse.text()).toBe(200);
  expect((await reloaded).status()).toBe(200);
}

// An inline cell edit saves when the cell loses focus.
async function editReviewCell(page, sheet, label, value) {
  const input = reviewField(sheet, label);
  await savedAndReloaded(page, async () => {
    await input.fill(value);
    await input.press("Tab");
  });
}

async function toggleReviewCheckbox(page, sheet, label) {
  await savedAndReloaded(page, () => reviewField(sheet, label).click());
}

async function showRows(page, sheet, label) {
  const reloaded = importResponse(page, "GET", IMPORT_ROWS);
  await sheet
    .getByRole("combobox", { name: "Show", exact: true })
    .selectOption({ label });
  expect((await reloaded).status()).toBe(200);
}

// Commits from the Review step and waits for the Done step's receipt.
async function commitImport(page, sheet, label, receipt) {
  const committed = importResponse(page, "POST", IMPORT_COMMIT);
  await sheet.getByRole("button", { name: label, exact: true }).click();
  expect((await committed).status()).toBe(201);
  await expect(importStep(sheet)).toHaveText("Done");
  await expect(
    sheet.getByText("The participant import was committed successfully."),
  ).toBeVisible();
  await expect(sheet.getByRole("status")).toHaveText(receipt);
}

// Lets a test's own preview run out just as the sheet's next request to it
// (matching `pattern`) reaches the server. Moving it into the past up front
// would leave a stale preview in the shared database long enough for a
// concurrent cleanup_roster_imports run (platform.spec.js runs one over every
// event) to mark it expired first, and the request would then no longer be
// the one that finds it stale (the test below covers that case). So the
// preview gets a little over a second more, and the request is held until
// that has passed: the 24-hour lifetime is a real timer with no hook to end
// it on cue.
async function expireOnNextRequest(page, pattern, eventCode, importId) {
  const { updated, expiresAt } = runDjangoJson(
    `
from datetime import timedelta

from django.utils import timezone

from apps.scheduling.models import RosterImportBatch

expires_at = timezone.now() + timedelta(milliseconds=1500)
updated = RosterImportBatch.objects.filter(
    pk=data["id"],
    event__code=data["code"],
    status=RosterImportBatch.Status.PREVIEW,
).update(expires_at=expires_at)
print(json.dumps({"updated": updated, "expiresAt": expires_at.timestamp() * 1000}))
`,
    { id: importId, code: eventCode },
  );
  expect(updated).toBe(1);
  await page.route(
    pattern,
    async (route) => {
      const wait = expiresAt + 50 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await route.continue();
    },
    { times: 1 },
  );
}

// Expires a test's own preview the way cleanup_roster_imports (or a read of
// it from another tab) does: past its lifetime, then marked expired and
// scrubbed through the product's per-batch expiry, touching no other batch.
function scrubExpiredPreview(eventCode, importId) {
  const state = runDjangoJson(
    `
from datetime import timedelta

from django.utils import timezone

from apps.scheduling.models import RosterImportBatch
from apps.scheduling.services.roster_imports import expire_roster_import_preview

batches = RosterImportBatch.objects.filter(pk=data["id"], event__code=data["code"])
batches.update(expires_at=timezone.now() - timedelta(minutes=1))
batch = batches.get()
expired = expire_roster_import_preview(batch)
batch.refresh_from_db()
print(json.dumps({"expired": expired, "status": batch.status, "rows": batch.rows.count()}))
`,
    { id: importId, code: eventCode },
  );
  expect(state).toEqual({ expired: true, status: "expired", rows: 0 });
}

async function invitationsByEmail(request, eventCode, token) {
  const listed = await apiJson(
    request,
    "GET",
    `/events/invitations?code=${eventCode}`,
    token,
  );
  expect(listed.response.status()).toBe(200);
  return new Map(
    listed.payload.invitations.map((invitation) => [
      invitation.email,
      invitation,
    ]),
  );
}

function groupNames(entry) {
  return entry.groups.map((group) => group.name).sort();
}

test.describe("Import sources", () => {
  test("refuses a missing, unsupported, oversized or unreadable file and an empty paste, and switches source tabs with the keyboard", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-source",
    );
    await gotoParticipants(page, event);
    const sheet = await openImportSheet(page);
    await expect(
      sheet.getByText(
        "Upload a CSV/XLSX file or paste cells from a spreadsheet.",
      ),
    ).toBeVisible();
    const uploadTab = sheet.getByRole("tab", { name: "Upload a file" });
    const pasteTab = sheet.getByRole("tab", {
      name: "Paste from a spreadsheet",
    });
    // The selected tab takes the sheet's first focus.
    await expect(uploadTab).toHaveAttribute("aria-selected", "true");
    await expect(uploadTab).toBeFocused();

    const error = sheet.getByRole("alert");
    const fileInput = sheet.getByLabel("CSV or XLSX file", { exact: true });
    const created = requestRecorder(
      page,
      (candidate) =>
        candidate.method() === "POST" && IMPORT_CREATE.test(candidate.url()),
    );

    // The client refuses these before anything is uploaded.
    await continueButton(sheet).click();
    await expect(error).toHaveText("Choose a .csv or .xlsx file first.");
    await fileInput.setInputFiles({
      name: "people.xls",
      mimeType: "application/vnd.ms-excel",
      buffer: Buffer.from("x"),
    });
    await continueButton(sheet).click();
    await expect(error).toHaveText("Only .csv and .xlsx files are supported.");
    await fileInput.setInputFiles({
      name: "big.csv",
      mimeType: "text/csv",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
    });
    await continueButton(sheet).click();
    await expect(error).toHaveText(
      "The compressed file must be 5 MiB or smaller.",
    );
    expect(created.entries).toEqual([]);

    // The server reads the rest and says why a file is unusable.
    for (const [file, message] of [
      [
        {
          name: "broken.xlsx",
          mimeType: XLSX_MIME,
          buffer: Buffer.from("not a zip"),
        },
        "The uploaded file is not a valid .xlsx workbook.",
      ],
      [
        {
          name: "latin.csv",
          mimeType: "text/csv",
          buffer: Buffer.from([0xff, 0xfe, 0x41]),
        },
        "CSV and pasted data must be UTF-8 encoded.",
      ],
      [
        {
          name: "blank.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("\n\n"),
        },
        "The table is empty.",
      ],
    ]) {
      await fileInput.setInputFiles(file);
      const refused = importResponse(page, "POST", IMPORT_CREATE);
      await continueButton(sheet).click();
      expect((await refused).status()).toBe(400);
      await expect(error).toHaveText(message);
      await expect(importStep(sheet)).toHaveText("Source");
    }

    // The source tabs are one tab stop: the arrow keys wrap, Home and End
    // jump to the ends, and the panel follows the selected tab.
    const pasted = sheet.getByLabel("Pasted participant rows");
    const expectTab = async (tab, other) => {
      await expect(tab).toBeFocused();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(tab).toHaveAttribute("tabindex", "0");
      await expect(other).toHaveAttribute("aria-selected", "false");
      await expect(other).toHaveAttribute("tabindex", "-1");
    };
    await uploadTab.focus();
    await page.keyboard.press("ArrowRight");
    await expectTab(pasteTab, uploadTab);
    await expect(pasted).toBeVisible();
    await expect(fileInput).toHaveCount(0);
    await page.keyboard.press("Home");
    await expectTab(uploadTab, pasteTab);
    await expect(fileInput).toBeVisible();
    await page.keyboard.press("End");
    await expectTab(pasteTab, uploadTab);
    await page.keyboard.press("ArrowLeft");
    await expectTab(uploadTab, pasteTab);
    await page.keyboard.press("ArrowLeft");
    await expectTab(pasteTab, uploadTab);
    await page.keyboard.press("ArrowDown");
    await expectTab(uploadTab, pasteTab);
    await page.keyboard.press("ArrowUp");
    await expectTab(pasteTab, uploadTab);

    await expect(sheet.getByText("Paste rows to see a preview.")).toBeVisible();
    await continueButton(sheet).click();
    await expect(error).toHaveText(
      "Paste rows copied from Google Sheets or Excel first.",
    );
    await pasted.fill(
      tsv([
        ["name", "email"],
        ["Sol Source", personEmail("sol", runId)],
      ]),
    );
    await expect(sheet.getByText("Found 2 rows and 2 columns")).toBeVisible();
    await expect(
      sheet.getByRole("table", { name: "Pasted preview" }),
    ).toContainText("Sol Source");

    // Nothing reached the server as a preview, so closing asks nothing.
    await sheet.getByRole("button", { name: "Close dialog" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Discard this import?" }),
    ).toHaveCount(0);
    expect(
      (await rosterEntries(request, event.code, token)).pagination.total,
    ).toBe(0);
  });
});

test.describe("Columns step", () => {
  test("picks a worksheet from a multi-sheet XLSX, re-reads the columns from a later header row, and applies column changes and defaults", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-xlsx",
    );
    const email = (slug) => personEmail(slug, runId);
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

    await gotoParticipants(page, event);
    const sheet = await openImportSheet(page);
    await uploadParticipantFile(sheet, {
      name: "people.xlsx",
      mimeType: XLSX_MIME,
      buffer,
    });
    await expect(
      sheet.getByText(
        "Check which column fills each field. We matched them by their headers.",
      ),
    ).toBeVisible();

    // A workbook with several sheets opens its sheet settings: nothing is
    // mapped until a worksheet is chosen.
    const sheetLine = sheet.locator(".import-sheet__sheet-line");
    await expect(sheetLine).toHaveText(
      "Sheet: not chosen yet, headers in row 1 · change",
    );
    await expect(sheet.getByRole("button", { name: "change" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const worksheet = sheet.getByRole("combobox", {
      name: "Worksheet",
      exact: true,
    });
    await expect(worksheet.locator("option")).toHaveText([
      "Choose a worksheet",
      "Faculty (2 rows)",
      "TAs (4 rows)",
    ]);
    await expect(worksheet).toHaveValue("");
    const error = sheet.getByRole("alert");
    const preview = sheet.getByRole("button", { name: "Preview rows" });
    await preview.click();
    await expect(error).toHaveText(
      "Choose a worksheet before mapping columns.",
    );

    const name = importColumnSelect(sheet, "Name");
    const emailColumn = importColumnSelect(sheet, "Email");
    const group = importColumnSelect(sheet, "Group");
    const phone = importColumnSelect(sheet, "Phone");
    let configured = importResponse(page, "PUT", IMPORT_DETAIL);
    await worksheet.selectOption("TAs");
    expect((await configured).status()).toBe(200);
    await expect(sheetLine).toHaveText("Sheet: TAs, headers in row 1 · change");
    await expect(error).toHaveCount(0);
    const headerRow = sheet.getByRole("spinbutton", {
      name: "Header row",
      exact: true,
    });
    await expect(headerRow).toHaveValue("1");
    await expect(name.locator("option")).toHaveText([
      "No column",
      "Spring TAs",
    ]);
    await expect(name).toHaveValue("");
    await expect(
      sheet.getByRole("columnheader", { name: "Row 2 shows" }),
    ).toBeVisible();
    await preview.click();
    await expect(error).toHaveText("Map both the name and email columns.");

    // A later header row goes to the server, which suggests the mapping for
    // the new headers and samples the row under them.
    configured = importResponse(page, "PUT", IMPORT_DETAIL);
    await headerRow.fill("2");
    expect((await configured).status()).toBe(200);
    await expect(sheetLine).toHaveText("Sheet: TAs, headers in row 2 · change");
    await expect(name.locator("option")).toHaveText([
      "No column",
      "Full Name",
      "Work Email",
      "Section",
    ]);
    await expect(name).toHaveValue("0");
    await expect(emailColumn).toHaveValue("");
    await expect(
      sheet.getByRole("columnheader", { name: "Row 3 shows" }),
    ).toBeVisible();
    await expect(sampleFor(sheet, "Name")).toHaveText("Tara TA");
    await expect(sampleFor(sheet, "Email")).toHaveText("—");
    await preview.click();
    await expect(error).toHaveText("Map both the name and email columns.");

    await emailColumn.selectOption({ label: "Work Email" });
    await expect(emailColumn).toHaveValue("1");
    await expect(sampleFor(sheet, "Email")).toHaveText(email("tara"));

    // One column fills one field: picking Section for Phone takes it off
    // Group, and Group falls back to the default again.
    const defaultGroup = sheet.getByLabel("Default group", { exact: true });
    await group.selectOption({ label: "Section" });
    await expect(group).toHaveValue("2");
    await expect(sampleFor(sheet, "Group")).toHaveText("S1");
    await expect(defaultGroup).toHaveCount(0);
    await phone.selectOption({ label: "Section" });
    await expect(phone).toHaveValue("2");
    await expect(group).toHaveValue("");
    await expect(sampleFor(sheet, "Group")).toHaveText("—");
    await expect(defaultGroup).toBeVisible();
    await phone.selectOption({ label: "No column" });
    await expect(phone).toHaveValue("");

    await defaultGroup.fill("ALL");
    const defaultWeight = sheet.getByLabel("Default weight", { exact: true });
    await defaultWeight.fill("2");
    await preview.click();
    await expect(error).toHaveText("Enter a weight between 0 and 1.");
    await expect(importStep(sheet)).toHaveText("Columns");
    await defaultWeight.fill("0.5");
    await sheet.getByLabel("Counted in results", { exact: true }).uncheck();

    await previewImportRows(sheet);
    await expect(reviewSummary(sheet)).toHaveText(
      "3 ready · 0 need fixing · 0 duplicates merged · 0 skipped",
    );
    await expect(reviewField(sheet, "Name for row 2")).toHaveCount(0);
    await expect(reviewField(sheet, "Name for row 3")).toHaveValue("Tara TA");
    await expect(reviewField(sheet, "Email for row 3")).toHaveValue(
      email("tara"),
    );
    await expect(reviewField(sheet, "Group for row 3")).toHaveValue("ALL");
    await expect(reviewField(sheet, "Phone for row 3")).toHaveValue("");
    await expect(reviewField(sheet, "Weight for row 3")).toHaveValue("0.5");
    await expect(reviewField(sheet, "Included for row 3")).not.toBeChecked();
    await expect(reviewField(sheet, "Name for row 5")).toHaveValue("Tim TA");

    await commitImport(
      page,
      sheet,
      "Import 3 people",
      "Imported 3 people: 3 added, 0 updated. No invitations were sent.",
    );
    await sheet.getByRole("button", { name: "Back to participants" }).click();
    await expect(sheet).toHaveCount(0);
    await expectToast(
      page,
      "Imported 3 people: 3 added, 0 updated. No invitations were sent.",
    );
    await expect(participantRow(page, "Tara TA")).toBeVisible();

    const roster = await rosterByEmail(request, event.code, token);
    expect([...roster.keys()].sort()).toEqual(
      [email("tara"), email("theo"), email("tim")].sort(),
    );
    for (const entry of roster.values()) {
      expect(entry).toMatchObject({
        allGroups: true,
        weight: 0.5,
        included: false,
        phone: "",
      });
    }
  });
});

test.describe("Done step", () => {
  test("uploads a semicolon CSV with a byte-order mark, then imports another list from the Done step and goes back to participants", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-csv",
    );
    const email = (slug) => personEmail(slug, runId);
    await gotoParticipants(page, event);
    const sheet = await openImportSheet(page);
    await uploadParticipantFile(sheet, {
      name: "people.csv",
      mimeType: "text/csv",
      buffer: csvBuffer(
        [
          "name;email;group",
          `Cara Csv;${email("cara")};Faculty`,
          `Dev Csv;${email("dev")};Staff`,
        ].join("\n"),
        { bom: true },
      ),
    });

    // One sheet: the settings stay folded, and the ";" split plus the
    // stripped BOM let every header map itself.
    await expect(sheet.locator(".import-sheet__sheet-line")).toHaveText(
      "Sheet: CSV, headers in row 1 · change",
    );
    const change = sheet.getByRole("button", { name: "change" });
    await expect(change).toHaveAttribute("aria-expanded", "false");
    await expect(sheet.getByLabel("Header row")).toHaveCount(0);
    await change.click();
    await expect(change).toHaveAttribute("aria-expanded", "true");
    await expect(sheet.getByLabel("Header row")).toHaveValue("1");
    await expect(
      sheet.getByRole("combobox", { name: "Worksheet" }),
    ).toHaveCount(0);
    await expect(importColumnSelect(sheet, "Name")).toHaveValue("0");
    await expect(importColumnSelect(sheet, "Email")).toHaveValue("1");
    await expect(importColumnSelect(sheet, "Group")).toHaveValue("2");
    await expect(importColumnSelect(sheet, "Phone")).toHaveValue("");
    await expect(
      sheet.getByRole("columnheader", { name: "Row 2 shows" }),
    ).toBeVisible();
    await expect(sampleFor(sheet, "Name")).toHaveText("Cara Csv");
    await expect(sampleFor(sheet, "Email")).toHaveText(email("cara"));
    await expect(sampleFor(sheet, "Group")).toHaveText("Faculty");
    await expect(sampleFor(sheet, "Phone")).toHaveText("—");

    await previewImportRows(sheet);
    await expect(reviewSummary(sheet)).toHaveText(
      "2 ready · 0 need fixing · 0 duplicates merged · 0 skipped",
    );
    await expect(rowStatus(sheet, 2)).toHaveText("Ready");
    await commitImport(
      page,
      sheet,
      "Import 2 people",
      "Imported 2 people: 2 added, 0 updated. No invitations were sent.",
    );
    await expect(
      sheet.getByRole("button", { name: "Review and send invitations (2)…" }),
    ).toBeVisible();

    // Import another list starts over on the Source step with nothing
    // chosen or pasted.
    await sheet.getByRole("button", { name: "Import another list" }).click();
    await expect(importStep(sheet)).toHaveText("Source");
    await expect(sheet.getByRole("status")).toHaveCount(0);
    await expect(
      sheet.getByRole("tab", { name: "Upload a file" }),
    ).toHaveAttribute("aria-selected", "true");
    await continueButton(sheet).click();
    await expect(sheet.getByRole("alert")).toHaveText(
      "Choose a .csv or .xlsx file first.",
    );
    await sheet.getByRole("tab", { name: "Paste from a spreadsheet" }).click();
    await expect(sheet.getByLabel("Pasted participant rows")).toHaveValue("");
    await pasteParticipantRows(
      sheet,
      tsv([
        ["name", "email", "group"],
        ["Eli Paste", email("eli"), "Staff"],
      ]),
    );
    await previewImportRows(sheet);
    await commitImport(
      page,
      sheet,
      "Import 1 person",
      "Imported 1 people: 1 added, 0 updated. No invitations were sent.",
    );

    // Back to participants closes the sheet with the latest receipt as a
    // toast and opens no invitation review.
    await sheet.getByRole("button", { name: "Back to participants" }).click();
    await expect(sheet).toHaveCount(0);
    await expectToast(
      page,
      "Imported 1 people: 1 added, 0 updated. No invitations were sent.",
    );
    await expect(
      page.getByRole("dialog", { name: "Send invitations" }),
    ).toHaveCount(0);
    for (const person of ["Cara Csv", "Dev Csv", "Eli Paste"]) {
      await expect(participantRow(page, person)).toBeVisible();
    }
    await expect(participantSummary(page)).toHaveText(
      "3 people · 0 submitted · 3 not submitted · 2 groups",
    );

    const roster = await rosterByEmail(request, event.code, token);
    expect(roster.size).toBe(3);
    expect(roster.get(email("cara"))).toMatchObject({
      name: "Cara Csv",
      group: "Faculty",
      invitationStatus: "not_sent",
    });
    expect(roster.get(email("dev"))).toMatchObject({ group: "Staff" });
    expect(roster.get(email("eli"))).toMatchObject({ group: "Staff" });
  });
});

test.describe("Review step", () => {
  test("flags duplicate and invalid rows, blocks the import until each is fixed or skipped, filters and pages the rows, and imports the edited rest", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-review",
    );
    const email = (slug) => personEmail(slug, runId);
    const pad = (number) => String(number).padStart(2, "0");
    // Six rows to sort out, then fifty good ones so the review has a
    // second page (fifty rows a page): rows 2-51, then rows 52-57.
    const fillers = Array.from({ length: 50 }, (_, index) => [
      `Person ${pad(index + 1)}`,
      email(`p${pad(index + 1)}`),
      "",
      "",
    ]);
    await gotoParticipants(page, event);
    const sheet = await openImportSheet(page);
    await pasteParticipantRows(
      sheet,
      tsv([
        ["name", "email", "group", "weight"],
        ["Ada Lovelace", email("ada"), "Team A", ""],
        ["Ada Lovelace", email("ada"), "Team B", ""],
        ["Bob Stone", email("bob"), "", ""],
        ["Robert Stone", email("bob"), "", ""],
        ["Eve Invalid", "not-an-email", "", ""],
        ["Zed Heavy", email("zed"), "", "2"],
        ...fillers,
      ]),
    );
    await previewImportRows(sheet);
    await expect(
      sheet.getByText(
        "Review validation issues before changing the event's participants.",
      ),
    ).toBeVisible();

    // The same person under two groups folds into the first row; the same
    // email with different details, a bad email and a bad weight need a hand.
    await expect(reviewSummary(sheet)).toHaveText(
      "51 ready · 4 need fixing · 1 duplicate merged · 0 skipped",
    );
    await expect(rowStatus(sheet, 2)).toHaveText("Ready, merged with row 3");
    await expect(reviewField(sheet, "Group for row 2")).toHaveValue(
      "Team A; Team B",
    );
    await expect(rowStatus(sheet, 3)).toHaveText("Merged into row 2");
    await expect(importRow(sheet, 3)).toHaveClass(/opacity-50/);
    await expect(reviewField(sheet, "Select row 3")).not.toBeChecked();
    for (const rowNumber of [4, 5]) {
      await expect(rowStatus(sheet, rowNumber)).toHaveText(
        "Needs fixing: Conflicting duplicate email.",
      );
    }
    await expect(rowStatus(sheet, 6)).toHaveText(
      "Needs fixing: email is invalid.",
    );
    await expect(rowStatus(sheet, 7)).toHaveText(
      "Needs fixing: weight must be between 0 and 1.",
    );
    await expect(rowStatus(sheet, 8)).toHaveText("Ready");
    await expect(commitNote(sheet)).toHaveText(
      "Fix or skip 4 rows to continue.",
    );
    await expect(
      sheet.getByRole("button", { name: "Import 51 people", exact: true }),
    ).toBeDisabled();

    // Paging: fifty rows a page, and the header box uses or skips every row
    // on the page shown (mixed while row 3 sits out on page 1).
    const everyRow = sheet.getByLabel("Use every row on this page", {
      exact: true,
    });
    await expect(everyRow).toBeChecked({ indeterminate: true });
    await expect(sheet.getByText("Page 1 of 2")).toBeVisible();
    await expect(reviewField(sheet, "Name for row 51")).toHaveValue(
      "Person 44",
    );
    await expect(reviewField(sheet, "Name for row 52")).toHaveCount(0);
    let reloaded = importResponse(page, "GET", IMPORT_ROWS);
    await sheet.getByRole("button", { name: "Next", exact: true }).click();
    expect((await reloaded).status()).toBe(200);
    await expect(sheet.getByText("Page 2 of 2")).toBeVisible();
    await expect(reviewField(sheet, "Name for row 57")).toHaveValue(
      "Person 50",
    );
    await expect(reviewField(sheet, "Name for row 51")).toHaveCount(0);
    await expect(everyRow).toBeChecked();
    await toggleReviewCheckbox(page, sheet, "Use every row on this page");
    await expect(everyRow).not.toBeChecked();
    for (const rowNumber of [52, 57]) {
      await expect(rowStatus(sheet, rowNumber)).toHaveText("Skipped");
      await expect(
        reviewField(sheet, `Select row ${rowNumber}`),
      ).not.toBeChecked();
    }
    await expect(reviewSummary(sheet)).toHaveText(
      "45 ready · 4 need fixing · 1 duplicate merged · 6 skipped",
    );
    await toggleReviewCheckbox(page, sheet, "Use every row on this page");
    await expect(everyRow).toBeChecked();
    await expect(rowStatus(sheet, 57)).toHaveText("Ready");
    await expect(reviewSummary(sheet)).toHaveText(
      "51 ready · 4 need fixing · 1 duplicate merged · 0 skipped",
    );
    reloaded = importResponse(page, "GET", IMPORT_ROWS);
    await sheet.getByRole("button", { name: "Previous", exact: true }).click();
    expect((await reloaded).status()).toBe(200);
    await expect(sheet.getByText("Page 1 of 2")).toBeVisible();

    // Needs fixing shows only the rows in the way; each fix or skip takes
    // its row out of that view.
    await showRows(page, sheet, "Needs fixing");
    const reviewTable = sheet.getByRole("region", {
      name: "Imported rows awaiting review",
    });
    await expect(
      reviewTable.getByRole("textbox", { name: /^Name for row/ }),
    ).toHaveCount(4);
    await expect(reviewField(sheet, "Name for row 2")).toHaveCount(0);
    await expect(sheet.getByText(/^Page \d+ of \d+$/)).toHaveCount(0);
    await expect(
      sheet.getByRole("button", { name: "Next", exact: true }),
    ).toHaveCount(0);

    await editReviewCell(page, sheet, "Email for row 5", email("robert"));
    await expect(reviewField(sheet, "Name for row 4")).toHaveCount(0);
    await expect(reviewField(sheet, "Name for row 5")).toHaveCount(0);
    await expect(reviewSummary(sheet)).toHaveText(
      "53 ready · 2 need fixing · 1 duplicate merged · 0 skipped",
    );
    await expect(commitNote(sheet)).toHaveText(
      "Fix or skip 2 rows to continue.",
    );

    await toggleReviewCheckbox(page, sheet, "Select row 6");
    await expect(reviewField(sheet, "Name for row 6")).toHaveCount(0);
    await expect(reviewSummary(sheet)).toHaveText(
      "53 ready · 1 needs fixing · 1 duplicate merged · 1 skipped",
    );
    await expect(commitNote(sheet)).toHaveText(
      "Fix or skip 1 row to continue.",
    );

    await editReviewCell(page, sheet, "Weight for row 7", "0.5");
    await expect(reviewField(sheet, "Name for row 7")).toHaveCount(0);
    await expect(reviewSummary(sheet)).toHaveText(
      "54 ready · 0 need fixing · 1 duplicate merged · 1 skipped",
    );
    await expect(everyRow).toBeDisabled();
    await expect(commitNote(sheet)).toHaveCount(0);
    const commit = sheet.getByRole("button", {
      name: "Import 54 people",
      exact: true,
    });
    await expect(commit).toBeEnabled();

    // Skipped shows the rows left out: the folded copy (whose surviving row
    // is not in this view, so it cannot be named) and the skipped one.
    await showRows(page, sheet, "Skipped");
    await expect(
      reviewTable.getByRole("textbox", { name: /^Name for row/ }),
    ).toHaveCount(2);
    await expect(rowStatus(sheet, 3)).toHaveText(
      "Merged into an identical row",
    );
    await expect(rowStatus(sheet, 6)).toHaveText("Skipped");
    await expect(importRow(sheet, 6)).toHaveClass(/opacity-50/);

    // Back on every row: the fixed rows are ready, and the rest of their
    // cells can still be edited in place.
    await showRows(page, sheet, "All rows");
    await expect(sheet.getByText("Page 1 of 2")).toBeVisible();
    for (const rowNumber of [4, 5, 7]) {
      await expect(rowStatus(sheet, rowNumber)).toHaveText("Ready");
    }
    await expect(rowStatus(sheet, 6)).toHaveText("Skipped");
    await expect(reviewField(sheet, "Email for row 5")).toHaveValue(
      email("robert"),
    );
    await expect(reviewField(sheet, "Weight for row 7")).toHaveValue("0.5");
    await editReviewCell(page, sheet, "Group for row 4", "Team C");
    await editReviewCell(page, sheet, "Phone for row 4", "+1 555 010 4000");
    await editReviewCell(page, sheet, "Name for row 5", "Robbie Stone");
    await toggleReviewCheckbox(page, sheet, "Included for row 5");
    await expect(reviewField(sheet, "Group for row 4")).toHaveValue("Team C");
    await expect(reviewField(sheet, "Phone for row 4")).toHaveValue(
      "+1 555 010 4000",
    );
    await expect(reviewField(sheet, "Name for row 5")).toHaveValue(
      "Robbie Stone",
    );
    await expect(reviewField(sheet, "Included for row 5")).not.toBeChecked();
    await expect(rowStatus(sheet, 5)).toHaveText("Ready");

    await commitImport(
      page,
      sheet,
      "Import 54 people",
      "Imported 54 people: 54 added, 0 updated. No invitations were sent.",
    );
    await expect(
      sheet.getByRole("button", {
        name: "Review and send invitations (54)…",
      }),
    ).toBeVisible();
    await sheet.getByRole("button", { name: "Back to participants" }).click();
    await expectToast(
      page,
      "Imported 54 people: 54 added, 0 updated. No invitations were sent.",
    );
    await expect(participantSummary(page)).toHaveText(
      "54 people · 0 submitted · 54 not submitted · 3 groups",
    );

    const roster = await rosterByEmail(request, event.code, token);
    expect(roster.size).toBe(54);
    expect(groupNames(roster.get(email("ada")))).toEqual(["Team A", "Team B"]);
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
    expect([...roster.values()].map((entry) => entry.name)).not.toContain(
      "Eve Invalid",
    );
    expect(roster.get(email("p50"))).toMatchObject({ name: "Person 50" });
  });
});

test.describe("Review step: invalid weights", () => {
  test("a row flagged for its weight is fixed by entering the weight its cell shows", async ({
    page,
    request,
  }) => {
    // The server stores 1 in place of a weight it refuses and keeps the row
    // flagged until the weight is set; the cell shows that 1, and leaving
    // the cell saves it even unchanged.
    const { runId, event } = await startOrganizerEvent(
      { page, request },
      "import-weight",
    );
    await gotoParticipants(page, event);
    const sheet = await openImportSheet(page);
    await pasteParticipantRows(
      sheet,
      tsv([
        ["name", "email", "weight"],
        ["Wes Weight", personEmail("wes", runId), "2"],
      ]),
    );
    await previewImportRows(sheet);
    await expect(rowStatus(sheet, 2)).toHaveText(
      "Needs fixing: weight must be between 0 and 1.",
    );
    await expect(commitNote(sheet)).toHaveText(
      "Fix or skip 1 row to continue.",
    );

    // Renaming the person leaves the refused weight flagged instead of
    // importing the 1 nobody chose.
    await editReviewCell(page, sheet, "Name for row 2", "Wes Renamed");
    await expect(rowStatus(sheet, 2)).toHaveText(
      "Needs fixing: weight must be between 0 and 1.",
    );

    // The organizer settles on a weight of 1 for the row.
    const weight = reviewField(sheet, "Weight for row 2");
    await weight.fill("1");
    await weight.press("Tab");
    await expect(rowStatus(sheet, 2)).toHaveText("Ready", { timeout: 5_000 });
    await expect(commitNote(sheet)).toHaveCount(0);
    await expect(
      sheet.getByRole("button", { name: "Import 1 person", exact: true }),
    ).toBeEnabled();
  });
});

test.describe("Applying an import", () => {
  // Pat has a submitted schedule and Rex has been emailed an invitation.
  async function seedKeptPeople(request, event, token, runId) {
    const pat = personEmail("pat", runId);
    const rex = personEmail("rex", runId);
    await importRosterApi(
      request,
      event.code,
      token,
      tsv([
        ["name", "email", "group", "weight"],
        ["Pat Keep", pat, "Team A", "0.5"],
        ["Rex Invited", rex, "Team A", "1"],
      ]),
    );
    const seeded = await rosterByEmail(request, event.code, token);
    await submitOnBehalf(request, token, event, seeded.get(pat));
    await sendInvitationsApi(request, event.code, token, [seeded.get(rex).id]);
    await waitForInvitationStatus(request, event.code, token, rex, "sent");
    return { pat, rex, seeded };
  }

  test("merges onto people already on the list, keeping their schedules and invitations, and offers invitations only to the people it added", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-merge",
    );
    const { pat, rex, seeded } = await seedKeptPeople(
      request,
      event,
      token,
      runId,
    );
    const nia = personEmail("nia", runId);
    const rexSentAt = (
      await invitationsByEmail(request, event.code, token)
    ).get(rex).firstSentAt;
    expect(rexSentAt).toBeTruthy();

    await gotoParticipants(page, event);
    await expect(participantSummary(page)).toHaveText(
      "2 people · 1 submitted · 1 not submitted · 1 group",
    );
    const sheet = await openImportSheet(page);
    await pasteParticipantRows(
      sheet,
      tsv([
        ["name", "email", "group", "weight"],
        ["Pat Renamed", pat, "Team B", "0.25"],
        ["Rex Invited", rex, "", ""],
        ["Nia New", nia, "Team B", ""],
      ]),
    );
    await previewImportRows(sheet);
    await expect(reviewSummary(sheet)).toHaveText(
      "3 ready · 0 need fixing · 0 duplicates merged · 0 skipped",
    );
    await expect(
      sheet.getByRole("radio", {
        name: "Add and update people. Schedules, invitations and history are kept.",
      }),
    ).toBeChecked();
    await commitImport(
      page,
      sheet,
      "Import 3 people",
      "Imported 3 people: 1 added, 2 updated. No invitations were sent.",
    );

    // Only the person the merge added is offered an invitation, and the
    // review asks before anyone is emailed.
    await sheet
      .getByRole("button", { name: "Review and send invitations (1)…" })
      .click();
    await expect(sheet).toHaveCount(0);
    await expectToast(
      page,
      "Imported 3 people: 1 added, 2 updated. No invitations were sent.",
    );
    const review = page.getByRole("dialog", { name: "Send invitations" });
    await expect(
      review.getByText("1 will get an invitation now", { exact: true }),
    ).toBeVisible();
    await expect(
      review.getByText(
        "Shown for Nia New. Each person gets their own private link.",
      ),
    ).toBeVisible();
    await expect(emailField(review, "To")).toHaveText(`Nia New <${nia}>`);
    await expect(review.getByText(/already invited/)).toHaveCount(0);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).toHaveCount(0);

    await expect(participantRow(page, "Pat Renamed")).toBeVisible();
    await expect(participantRow(page, "Pat Keep")).toHaveCount(0);
    await expect(participantRow(page, "Nia New")).toBeVisible();
    await expect(participantSummary(page)).toHaveText(
      "3 people · 1 submitted · 2 not submitted · 2 groups",
    );

    // Pat keeps the submitted schedule and gains a group and a weight. Rex's
    // blank group cell leaves his group alone (a merge never removes one),
    // his blank weight cell applies the default 1 he already had, and his
    // invitation stays sent.
    const roster = await rosterByEmail(request, event.code, token);
    expect(roster.size).toBe(3);
    expect(roster.get(pat)).toMatchObject({
      id: seeded.get(pat).id,
      name: "Pat Renamed",
      submitted: true,
      weight: 0.25,
      invitationStatus: "not_sent",
    });
    expect(groupNames(roster.get(pat))).toEqual(["Team A", "Team B"]);
    expect(roster.get(rex)).toMatchObject({
      id: seeded.get(rex).id,
      weight: 1,
      invitationStatus: "sent",
    });
    expect(groupNames(roster.get(rex))).toEqual(["Team A"]);
    expect(roster.get(nia)).toMatchObject({
      name: "Nia New",
      submitted: false,
      invitationStatus: "not_sent",
    });
    const schedule = await apiJson(
      request,
      "GET",
      `/events/roster/${seeded.get(pat).id}/schedule?code=${event.code}`,
      token,
    );
    expect(schedule.response.status()).toBe(200);
    expect(schedule.payload.schedule.availabilityInperson).toEqual(
      Array(event.slotCount).fill(1),
    );
    const invitations = await invitationsByEmail(request, event.code, token);
    expect(invitations.get(rex).firstSentAt).toBe(rexSentAt);
    expect(invitationJobCount(event.code, rex)).toBe(1);
    expect(invitationJobCount(event.code, pat)).toBe(0);
    expect(invitationJobCount(event.code, nia)).toBe(0);
  });

  test("replaces the whole list only once the event code is typed, clearing schedules, invitations and groups, and offers invitations to everyone imported", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-rebuild",
    );
    const { pat, rex } = await seedKeptPeople(request, event, token, runId);
    const newcomer = personEmail("new", runId);

    await gotoParticipants(page, event);
    await expect(participantSummary(page)).toHaveText(
      "2 people · 1 submitted · 1 not submitted · 1 group",
    );
    const sheet = await openImportSheet(page);
    await pasteParticipantRows(
      sheet,
      tsv([
        ["name", "email"],
        ["Pat Keep", pat],
        ["New One", newcomer],
      ]),
    );
    await previewImportRows(sheet);

    const confirmation = sheet.getByLabel("Rebuild confirmation code", {
      exact: true,
    });
    const warning = sheet.getByRole("note");
    await expect(confirmation).toHaveCount(0);
    await expect(warning).toHaveCount(0);
    await sheet
      .getByRole("radio", {
        name: "Replace the whole list. Deletes every schedule, invitation and pending email.",
      })
      .check();
    await expect(warning).toHaveText(
      "Rebuilding clears schedules, invitations, and pending delivery. Everyone starts as Not invited and gets no reminders until you send invitations, which you can review once the import is done.",
    );
    await expect(
      sheet.getByText(`Type ${event.code} to confirm`, { exact: true }),
    ).toBeVisible();
    const replace = sheet.getByRole("button", {
      name: "Replace the list with 2 people",
      exact: true,
    });
    await expect(replace).toBeDisabled();
    await confirmation.fill(event.code.slice(0, -1));
    await expect(replace).toBeDisabled();
    await confirmation.fill(`${event.code}X`);
    await expect(replace).toBeDisabled();
    // Case and surrounding spaces do not matter, as on the server.
    await confirmation.fill(` ${event.code.toLowerCase()} `);
    await expect(replace).toBeEnabled();

    // Switching back to merging hides the guard and relabels the import.
    await sheet
      .getByRole("radio", {
        name: "Add and update people. Schedules, invitations and history are kept.",
      })
      .check();
    await expect(confirmation).toHaveCount(0);
    await expect(
      sheet.getByRole("button", { name: "Import 2 people", exact: true }),
    ).toBeEnabled();
    await sheet
      .getByRole("radio", { name: /^Replace the whole list\./ })
      .check();
    await confirmation.fill(event.code);
    await commitImport(
      page,
      sheet,
      "Replace the list with 2 people",
      "Imported 2 people: 2 added, 0 updated. No invitations were sent.",
    );

    // A rebuild starts everyone over as Not invited, so the review offers every
    // person it imported.
    await sheet
      .getByRole("button", { name: "Review and send invitations (2)…" })
      .click();
    await expect(sheet).toHaveCount(0);
    await expectToast(
      page,
      "Imported 2 people: 2 added, 0 updated. No invitations were sent.",
    );
    const review = page.getByRole("dialog", { name: "Send invitations" });
    await expect(
      review.getByText("2 will get an invitation now", { exact: true }),
    ).toBeVisible();
    await expect(review.getByText(/already invited/)).toHaveCount(0);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).toHaveCount(0);

    await expect(participantRow(page, "New One")).toBeVisible();
    await expect(participantRow(page, "Rex Invited")).toHaveCount(0);
    await expect(participantSummary(page)).toHaveText(
      "2 people · 0 submitted · 2 not submitted · 0 groups",
    );

    const roster = await rosterByEmail(request, event.code, token);
    expect([...roster.keys()].sort()).toEqual([newcomer, pat].sort());
    for (const entry of roster.values()) {
      expect(entry).toMatchObject({
        submitted: false,
        invitationStatus: "not_sent",
        groups: [],
        allGroups: false,
      });
    }
    const invitations = await invitationsByEmail(request, event.code, token);
    expect([...invitations.keys()].sort()).toEqual([newcomer, pat].sort());
    for (const invitation of invitations.values()) {
      expect(invitation.firstSentAt).toBeNull();
    }
    expect(invitations.has(rex)).toBe(false);
  });
});

test.describe("Leaving an import", () => {
  test("Back keeps the pasted rows and the mapping, and closing a live preview asks before discarding it on the server", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-leave",
    );
    const text = tsv([
      ["name", "email", "team", "cell"],
      ["Gil Guest", personEmail("gil", runId), "Crew", "+1 555 010 1000"],
      ["Hal Guest", personEmail("hal", runId), "Crew", ""],
    ]);
    await gotoParticipants(page, event);
    const sheet = await openImportSheet(page);
    let created = importResponse(page, "POST", IMPORT_CREATE);
    await pasteParticipantRows(sheet, text);
    const first = await created;
    expect(first.status()).toBe(201);
    const firstId = (await first.json()).import.id;
    await expect(importColumnSelect(sheet, "Group")).toHaveValue("2");
    await expect(importColumnSelect(sheet, "Phone")).toHaveValue("3");

    // Back from Columns returns to the pasted rows; continuing again swaps
    // the server preview for a new one.
    await sheet.getByRole("button", { name: "Back", exact: true }).click();
    await expect(importStep(sheet)).toHaveText("Source");
    await expect(
      sheet.getByRole("tab", { name: "Paste from a spreadsheet" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(sheet.getByLabel("Pasted participant rows")).toHaveValue(text);
    const replaced = importResponse(page, "DELETE", IMPORT_DETAIL);
    created = importResponse(page, "POST", IMPORT_CREATE);
    await continueButton(sheet).click();
    const canceled = await replaced;
    expect(canceled.status()).toBe(200);
    expect(canceled.url()).toContain(`/roster-imports/${firstId}?`);
    expect(await canceled.json()).toEqual({
      importId: firstId,
      status: "canceled",
    });
    const second = await created;
    expect(second.status()).toBe(201);
    const secondId = (await second.json()).import.id;
    expect(secondId).not.toBe(firstId);
    await expect(importStep(sheet)).toHaveText("Columns");

    await importColumnSelect(sheet, "Group").selectOption({
      label: "No column",
    });
    const defaultGroup = sheet.getByLabel("Default group", { exact: true });
    await defaultGroup.fill("Guests");
    await previewImportRows(sheet);
    await expect(reviewField(sheet, "Group for row 2")).toHaveValue("Guests");
    await expect(reviewField(sheet, "Phone for row 2")).toHaveValue(
      "+1 555 010 1000",
    );
    await editReviewCell(page, sheet, "Name for row 2", "Gil Renamed");
    await expect(reviewField(sheet, "Name for row 2")).toHaveValue(
      "Gil Renamed",
    );

    // Back from Review keeps the mapping and the defaults, and warns that
    // previewing again drops the Review edits.
    await sheet.getByRole("button", { name: "Back", exact: true }).click();
    await expect(importStep(sheet)).toHaveText("Columns");
    await expect(importColumnSelect(sheet, "Name")).toHaveValue("0");
    await expect(importColumnSelect(sheet, "Group")).toHaveValue("");
    await expect(importColumnSelect(sheet, "Phone")).toHaveValue("3");
    await expect(defaultGroup).toHaveValue("Guests");
    await expect(sheet.getByRole("note")).toHaveText(
      "Previewing again resets edits made on the Review step.",
    );
    await previewImportRows(sheet);
    await expect(reviewField(sheet, "Name for row 2")).toHaveValue("Gil Guest");
    await expect(reviewField(sheet, "Group for row 2")).toHaveValue("Guests");

    // Closing a live preview asks first; Cancel keeps the sheet as it was.
    const deletes = requestRecorder(
      page,
      (candidate) =>
        candidate.method() === "DELETE" && IMPORT_DETAIL.test(candidate.url()),
    );
    await sheet.getByRole("button", { name: "Close dialog" }).click();
    const discard = page.getByRole("dialog", { name: "Discard this import?" });
    await expect(discard).toBeVisible();
    await expect(
      discard.getByText(
        "The rows you previewed and any edits are thrown away. Nothing has changed on the participant list.",
      ),
    ).toBeVisible();
    await expect(
      discard.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await discard.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(discard).toHaveCount(0);
    await expect(importStep(sheet)).toHaveText("Review");
    expect(deletes.entries).toEqual([]);

    // Escape asks the same question; Discard import cancels the preview on
    // the server and closes the sheet without touching the list.
    await page.keyboard.press("Escape");
    await expect(discard).toBeVisible();
    const discarded = importResponse(page, "DELETE", IMPORT_DETAIL);
    await discard
      .getByRole("button", { name: "Discard import", exact: true })
      .click();
    const discardedResponse = await discarded;
    expect(discardedResponse.status()).toBe(200);
    expect(await discardedResponse.json()).toEqual({
      importId: secondId,
      status: "canceled",
    });
    await expect(discard).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText("No participants yet")).toBeVisible();

    const kept = await apiJson(
      request,
      "GET",
      `/events/roster-imports/${secondId}/rows?code=${event.code}`,
      token,
    );
    expect(kept.response.status()).toBe(200);
    expect(kept.payload.import.status).toBe("canceled");
    expect(kept.payload.rows).toEqual([]);
    expect(
      (await rosterEntries(request, event.code, token)).pagination.total,
    ).toBe(0);
  });

  test("an expired preview says so, starts again from the same rows, and closes without asking", async ({
    page,
    request,
  }) => {
    const { runId, token, event } = await startOrganizerEvent(
      { page, request },
      "import-expired",
    );
    const text = tsv([
      ["name", "email"],
      ["Ivy Late", personEmail("ivy", runId)],
    ]);
    await gotoParticipants(page, event);
    const sheet = await openImportSheet(page);
    let created = importResponse(page, "POST", IMPORT_CREATE);
    await pasteParticipantRows(sheet, text);
    let createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    await expireOnNextRequest(
      page,
      IMPORT_DETAIL,
      event.code,
      (await createdResponse.json()).import.id,
    );

    const error = sheet.getByRole("alert");
    const preview = sheet.getByRole("button", { name: "Preview rows" });
    const configured = importResponse(page, "PUT", IMPORT_DETAIL);
    await preview.click();
    expect((await configured).status()).toBe(410);
    await expect(error).toContainText("This import expired after 24 hours.");
    await expect(preview).toBeDisabled();

    // Start again goes back to the Source step with the same rows pasted.
    await error.getByRole("button", { name: "Start again" }).click();
    await expect(importStep(sheet)).toHaveText("Source");
    await expect(error).toHaveCount(0);
    await expect(sheet.getByLabel("Pasted participant rows")).toHaveValue(text);
    created = importResponse(page, "POST", IMPORT_CREATE);
    await continueButton(sheet).click();
    createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const importId = (await createdResponse.json()).import.id;
    await previewImportRows(sheet);
    await expect(rowStatus(sheet, 2)).toHaveText("Ready");

    // A preview that expires on the Review step refuses the import.
    await expireOnNextRequest(page, IMPORT_COMMIT, event.code, importId);
    const commit = sheet.getByRole("button", {
      name: "Import 1 person",
      exact: true,
    });
    const committed = importResponse(page, "POST", IMPORT_COMMIT);
    await commit.click();
    expect((await committed).status()).toBe(410);
    await expect(error).toContainText("This import expired after 24 hours.");
    await expect(
      error.getByRole("button", { name: "Start again" }),
    ).toBeVisible();
    await expect(commit).toBeDisabled();

    // Nothing is left to lose, so Close neither asks nor calls the server.
    const deletes = requestRecorder(
      page,
      (candidate) =>
        candidate.method() === "DELETE" && IMPORT_DETAIL.test(candidate.url()),
    );
    await sheet.getByRole("button", { name: "Close dialog" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Discard this import?" }),
    ).toHaveCount(0);
    expect(deletes.entries).toEqual([]);
    expect(
      (await rosterEntries(request, event.code, token)).pagination.total,
    ).toBe(0);
  });

  test("a preview already expired by the cleanup still says it expired and offers Start again", async ({
    page,
    request,
  }) => {
    // The cleanup marks the preview expired before the sheet's next request:
    // the column step must still read that as expired, like a preview that
    // runs out on the request itself.
    const { runId, event } = await startOrganizerEvent(
      { page, request },
      "import-scrubbed",
    );
    await gotoParticipants(page, event);
    const sheet = await openImportSheet(page);
    const created = importResponse(page, "POST", IMPORT_CREATE);
    await pasteParticipantRows(
      sheet,
      tsv([
        ["name", "email"],
        ["Uma Stale", personEmail("uma", runId)],
      ]),
    );
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    scrubExpiredPreview(event.code, (await createdResponse.json()).import.id);

    const error = sheet.getByRole("alert");
    const preview = sheet.getByRole("button", { name: "Preview rows" });
    const configured = importResponse(page, "PUT", IMPORT_DETAIL);
    await preview.click();
    expect((await configured).status()).toBe(410);
    await expect(error).toContainText("This import expired after 24 hours.");
    await expect(
      error.getByRole("button", { name: "Start again" }),
    ).toBeVisible();
    await expect(preview).toBeDisabled();
  });
});
