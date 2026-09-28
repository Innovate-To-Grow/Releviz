/**
 * @jest-environment jsdom
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

jest.mock("@/lib/api/roster", () => ({
  cancelRosterImport: jest.fn(),
  commitRosterImport: jest.fn(),
  configureRosterImport: jest.fn(),
  createRosterImport: jest.fn(),
  fetchRosterImportRows: jest.fn(),
}));

import RosterImportWizard from "@/components/schedule/RosterImportWizard";
import {
  cancelRosterImport,
  commitRosterImport,
  configureRosterImport,
  createRosterImport,
  fetchRosterImportRows,
} from "@/lib/api/roster";

const event = { code: "IMPORT1" };
const getToken = jest.fn();

function importRecord(overrides = {}) {
  return {
    id: "import-1",
    status: "preview",
    sourceType: "paste",
    worksheets: [
      {
        name: "Pasted data",
        rowCount: 1,
        defaultHeaderRow: 1,
        headers: ["name", "email"],
      },
    ],
    selectedWorksheet: "Pasted data",
    headerRow: 1,
    headers: ["name", "email"],
    columnMapping: { name: 0, email: 1 },
    defaults: { group: "", weight: 1, included: true },
    summary: {
      total: 1,
      selected: 1,
      valid: 1,
      invalid: 0,
      conflicts: 0,
      ready: 1,
      needsFix: 0,
      mergedDuplicates: 0,
      skipped: 0,
    },
    sampleRow: null,
    ...overrides,
  };
}

function importRow(overrides = {}) {
  return {
    id: "row-1",
    rowNumber: 2,
    name: "Ada",
    email: "ada@example.com",
    group: "",
    phone: "",
    weight: 1,
    included: true,
    selected: true,
    valid: true,
    duplicate: "unique",
    errors: [],
    organizerManaged: false,
    ...overrides,
  };
}

function rowsResponse(record, rows, pagination) {
  return {
    import: record,
    rows,
    pagination: pagination || {
      page: 1,
      pageSize: 50,
      total: rows.length,
      pages: 1,
    },
  };
}

function httpError(message, status, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function renderWizard(props = {}) {
  return render(
    <RosterImportWizard
      event={event}
      getToken={getToken}
      onCommitted={jest.fn()}
      onClose={jest.fn()}
      {...props}
    />,
  );
}

const PASTE = "name\temail\nAda\tada@example.com";

async function pasteAndContinue(text = PASTE) {
  await userEvent.click(
    screen.getByRole("tab", { name: "Paste from a spreadsheet" }),
  );
  fireEvent.change(screen.getByLabelText("Pasted participant rows"), {
    target: { value: text },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

async function reachReview(text = PASTE) {
  await pasteAndContinue(text);
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  await screen.findByRole("region", { name: "Imported rows awaiting review" });
}

// The Columns step has one row per field; its <th scope="row"> names it.
function fieldRow(label) {
  return screen.getByRole("rowheader", { name: label }).closest("tr");
}

function reviewRow(rowNumber) {
  return screen.getByLabelText(`Name for row ${rowNumber}`).closest("tr");
}

function isBefore(node, other) {
  return Boolean(
    node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  getToken.mockResolvedValue("token");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: jest.fn().mockReturnValue("import-key") },
  });
});

test("opens as a dialog on the Source step and checks the file before creating a preview", async () => {
  renderWizard();
  const dialog = screen.getByRole("dialog", { name: "Import participants" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveAccessibleDescription(
    "Upload a CSV/XLSX file or paste cells from a spreadsheet.",
  );
  expect(screen.getByRole("list", { name: "Import steps" })).toHaveTextContent(
    "SourceColumnsReviewDone",
  );
  expect(screen.getByRole("tab", { name: "Upload a file" })).toHaveFocus();
  const input = screen.getByLabelText("CSV or XLSX file");
  expect(input).toHaveAccessibleDescription(
    "Up to 5 MiB. Formulas in the columns you import are rejected.",
  );

  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Choose a .csv or .xlsx file first.");
  // Errors sit at the top of the step, above its controls.
  expect(
    isBefore(alert, screen.getByRole("tablist", { name: "Import source" })),
  ).toBe(true);

  fireEvent.change(input, {
    target: { files: [new File(["legacy"], "people.xls")] },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Only .csv and .xlsx");

  fireEvent.change(input, {
    target: {
      files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], "people.xlsx")],
    },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("alert")).toHaveTextContent("5 MiB or smaller");
  expect(createRosterImport).not.toHaveBeenCalled();
});

test("moves between sources with the keyboard and refuses an empty paste", async () => {
  renderWizard();
  const fileTab = screen.getByRole("tab", { name: "Upload a file" });
  const pasteTab = screen.getByRole("tab", {
    name: "Paste from a spreadsheet",
  });
  fireEvent.keyDown(fileTab, { key: "ArrowRight" });
  expect(pasteTab).toHaveAttribute("aria-selected", "true");
  expect(pasteTab).toHaveFocus();
  fireEvent.keyDown(pasteTab, { key: "ArrowLeft" });
  expect(fileTab).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(fileTab, { key: "End" });
  expect(pasteTab).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(pasteTab, { key: "Home" });
  expect(fileTab).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(fileTab, { key: "Tab" });
  expect(fileTab).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(fileTab, { key: "ArrowDown" });
  expect(pasteTab).toHaveAttribute("aria-selected", "true");

  fireEvent.change(screen.getByLabelText("Pasted participant rows"), {
    target: { value: "  \n" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Paste rows copied from Google Sheets or Excel first.",
  );
  expect(createRosterImport).not.toHaveBeenCalled();
});

test("previews pasted rows, creates the import from the paste, and shows row 2 on the Columns step", async () => {
  const record = importRecord({
    headers: ["name", "email", "group"],
    columnMapping: { name: 0, email: 1, group: 2 },
  });
  let resolveCreate;
  createRosterImport.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveCreate = resolve;
    }),
  );
  renderWizard();
  await userEvent.click(
    screen.getByRole("tab", { name: "Paste from a spreadsheet" }),
  );
  expect(screen.getByText("Paste rows to see a preview.")).toBeInTheDocument();
  expect(
    screen.queryByRole("table", { name: "Pasted preview" }),
  ).not.toBeInTheDocument();

  const lines = [
    "name\temail\tgroup",
    "Ada\tada@example.com\tDesign",
    "Grace\tgrace@example.com",
    "Row 4\tfour@example.com",
    "Row 5\tfive@example.com",
    "Row 6\tsix@example.com",
    "Row 7\tseven@example.com",
    "Row 8\teight@example.com",
  ];
  const text = `${lines.join("\n")}\n`;
  fireEvent.change(screen.getByLabelText("Pasted participant rows"), {
    target: { value: text },
  });
  expect(screen.getByText("Found 8 rows and 3 columns")).toBeInTheDocument();
  const preview = screen.getByRole("table", { name: "Pasted preview" });
  const previewRows = within(preview).getAllByRole("row");
  expect(previewRows).toHaveLength(6);
  expect(previewRows[1]).toHaveTextContent("Adaada@example.comDesign");
  expect(within(previewRows[2]).getAllByRole("cell")).toHaveLength(3);

  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("button", { name: "Reading…" })).toBeDisabled();
  expect(createRosterImport).toHaveBeenCalledWith(
    "IMPORT1",
    { pastedText: text },
    "token",
  );
  resolveCreate({ import: record });

  expect(
    await screen.findByRole("columnheader", { name: "Row 2 shows" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("dialog", { name: "Import participants" }),
  ).toHaveAccessibleDescription(
    "Check which column fills each field. We matched them by their headers.",
  );
  expect(
    within(fieldRow("Name *")).getByRole("combobox", {
      name: "Column for Name",
    }),
  ).toHaveValue("0");
  expect(
    within(fieldRow("Email *")).getByRole("combobox", {
      name: "Column for Email",
    }),
  ).toHaveValue("1");
  // Without a server sample, the pasted row after the header fills the column.
  expect(fieldRow("Name *")).toHaveTextContent("Ada");
  expect(fieldRow("Email *")).toHaveTextContent("ada@example.com");
  expect(fieldRow("Email *")).toHaveTextContent(
    "No email: you enter their schedule",
  );
  expect(fieldRow("Group")).toHaveTextContent("Design");
  expect(fieldRow("Group")).toHaveTextContent("No group");
  expect(screen.queryByLabelText("Default group")).not.toBeInTheDocument();
  expect(fieldRow("Phone")).toHaveTextContent("—");
  expect(fieldRow("Phone")).toHaveTextContent("Left blank");
  expect(
    within(fieldRow("Weight")).getByLabelText("Default weight"),
  ).toHaveValue(1);
  expect(
    within(fieldRow("Included")).getByLabelText("Counted in results"),
  ).toBeChecked();

  // One worksheet: the sheet settings stay folded until asked for.
  expect(
    screen.getByText(/Sheet: Pasted data, headers in row 1/),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Header row")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "change" }));
  expect(screen.getByLabelText("Header row")).toHaveValue(1);
  expect(screen.queryByLabelText("Worksheet")).not.toBeInTheDocument();
});

test("keeps one column per field, shows the default group only without a column, and validates before previewing", async () => {
  const record = importRecord({
    headers: ["Full Name", "E-mail", "Team", "Mobile", "Weight", "Included"],
    columnMapping: {
      name: 0,
      email: 1,
      group: 2,
      phone: 3,
      weight: 4,
      included: 5,
    },
    sampleRow: ["Ada", "ada@example.com", "Design", "", "1", "yes"],
  });
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue(rowsResponse(record, [importRow()]));
  renderWizard();
  await pasteAndContinue(
    "Full Name\tE-mail\tTeam\tMobile\tWeight\tIncluded\nAda\tada@example.com\tDesign\t\t1\tyes",
  );

  const phone = await screen.findByRole("combobox", {
    name: "Column for Phone",
  });
  expect(fieldRow("Phone")).toHaveTextContent("(empty)");
  expect(fieldRow("Included")).toHaveTextContent("yes");
  expect(
    within(phone)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual([
    "No column",
    "Full Name",
    "E-mail",
    "Team",
    "Mobile",
    "Weight",
    "Included",
  ]);

  // Taking Name's column for Phone clears it from Name.
  await userEvent.selectOptions(phone, "0");
  const name = screen.getByRole("combobox", { name: "Column for Name" });
  expect(name).toHaveValue("");
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Map both the name and email columns.",
  );
  await userEvent.selectOptions(name, "0");
  expect(phone).toHaveValue("");

  // The default group appears only when no column feeds Group.
  expect(screen.queryByLabelText("Default group")).not.toBeInTheDocument();
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Column for Group" }),
    "",
  );
  const defaultGroup = screen.getByLabelText("Default group");
  expect(defaultGroup).toHaveAttribute("placeholder", "Everyone goes into…");
  expect(defaultGroup).toHaveAccessibleDescription(
    "Blank = no group. ALL = every group. Separate several names with ; or ,",
  );
  fireEvent.change(defaultGroup, { target: { value: "Guests" } });

  const weight = screen.getByLabelText("Default weight");
  fireEvent.change(weight, { target: { value: "" } });
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter a weight between 0 and 1.",
  );
  fireEvent.change(weight, { target: { value: "1.5" } });
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter a weight between 0 and 1.",
  );
  expect(configureRosterImport).not.toHaveBeenCalled();

  fireEvent.change(weight, { target: { value: "0.5" } });
  await userEvent.click(screen.getByLabelText("Counted in results"));
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenCalledWith(
      "IMPORT1",
      "import-1",
      {
        columnMapping: { name: "0", email: "1", weight: "4", included: "5" },
        defaults: { group: "Guests", weight: 0.5, included: false },
      },
      "token",
    ),
  );
  expect(
    await screen.findByRole("region", {
      name: "Imported rows awaiting review",
    }),
  ).toBeInTheDocument();
});

test("loads another worksheet or header row at once and takes the server's new suggestion", async () => {
  const base = importRecord({
    id: "import-2",
    sourceType: "xlsx",
    worksheets: [
      { name: "Notes", rowCount: 1, defaultHeaderRow: 1, headers: ["read me"] },
      {
        name: "People",
        rowCount: 3,
        defaultHeaderRow: 1,
        headers: ["title row"],
      },
    ],
    selectedWorksheet: null,
    headers: [],
    columnMapping: {},
    summary: {},
  });
  const withSheet = {
    ...base,
    selectedWorksheet: "People",
    headers: ["title row"],
    sampleRow: ["Full name", "Email"],
  };
  const withHeader = {
    ...withSheet,
    headerRow: 2,
    headers: ["Full name", "Email"],
    columnMapping: { name: 0, email: 1 },
    sampleRow: ["Ada", "ada@example.com"],
  };
  createRosterImport.mockResolvedValue({ import: base });
  configureRosterImport
    .mockResolvedValueOnce({ import: withSheet })
    .mockResolvedValueOnce({ import: withHeader })
    .mockRejectedValueOnce(
      new Error(
        "headerRow does not identify a non-empty row in the worksheet.",
      ),
    );
  renderWizard();

  const file = new File(["xlsx"], "people.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  fireEvent.change(screen.getByLabelText("CSV or XLSX file"), {
    target: { files: [file] },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(createRosterImport).toHaveBeenCalledWith("IMPORT1", { file }, "token");

  // Several worksheets: the settings start open and nothing is chosen yet.
  const worksheet = await screen.findByLabelText("Worksheet");
  expect(
    screen.getByText(/Sheet: not chosen yet, headers in row 1/),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a worksheet before mapping columns.",
  );

  await userEvent.selectOptions(worksheet, "People");
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenCalledWith(
      "IMPORT1",
      "import-2",
      { worksheet: "People" },
      "token",
    ),
  );
  expect(
    await screen.findByText(/Sheet: People, headers in row 1/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    within(
      screen.getByRole("combobox", { name: "Column for Name" }),
    ).getAllByRole("option"),
  ).toHaveLength(2);

  const headerRow = screen.getByLabelText("Header row");
  fireEvent.change(headerRow, { target: { value: "" } });
  fireEvent.change(headerRow, { target: { value: "1" } });
  expect(configureRosterImport).toHaveBeenCalledTimes(1);
  fireEvent.change(headerRow, { target: { value: "2" } });
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-2",
      { headerRow: 2 },
      "token",
    ),
  );
  expect(
    await screen.findByText(/Sheet: People, headers in row 2/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("columnheader", { name: "Row 3 shows" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Column for Name" })).toHaveValue(
    "0",
  );
  expect(
    screen.getByRole("combobox", { name: "Column for Email" }),
  ).toHaveValue("1");
  expect(fieldRow("Email *")).toHaveTextContent("ada@example.com");

  // A header row the sheet does not have is reported and changes nothing.
  fireEvent.change(headerRow, { target: { value: "9" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "headerRow does not identify a non-empty row in the worksheet.",
  );
  expect(
    screen.getByText(/Sheet: People, headers in row 2/),
  ).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "change" }));
  expect(screen.queryByLabelText("Worksheet")).not.toBeInTheDocument();
});

test("summarizes the review, filters with Show, selects the page, saves edits, and labels each row", async () => {
  const record = importRecord({
    id: "import-3",
    summary: {
      total: 5,
      selected: 3,
      valid: 2,
      invalid: 1,
      conflicts: 0,
      ready: 2,
      needsFix: 1,
      mergedDuplicates: 1,
      skipped: 1,
    },
  });
  const rows = [
    importRow({ id: "row-1", rowNumber: 2, group: "Design" }),
    importRow({
      id: "row-2",
      rowNumber: 3,
      name: "Grace",
      email: "grace",
      valid: false,
      errors: ["Email is invalid.", "Second problem."],
    }),
    importRow({
      id: "row-3",
      rowNumber: 4,
      name: "Skip Me",
      email: "skip@example.com",
      selected: false,
    }),
    importRow({
      id: "row-4",
      rowNumber: 5,
      name: "Guest",
      email: "",
      organizerManaged: true,
    }),
    importRow({
      id: "row-5",
      rowNumber: 6,
      name: "Ada",
      email: "ADA@example.com",
      selected: false,
      duplicate: "identical",
    }),
  ];
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue(
    rowsResponse(record, rows, { page: 1, pageSize: 50, total: 60, pages: 2 }),
  );
  renderWizard();
  await reachReview();

  expect(
    screen.getByText(
      "2 ready · 1 needs fixing · 1 duplicate merged · 1 skipped",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("dialog", { name: "Import participants" }),
  ).toHaveAccessibleDescription(
    "Review validation issues before changing the event's participants.",
  );
  expect(
    screen.getByRole("columnheader", { name: "Count" }),
  ).toBeInTheDocument();
  expect(reviewRow(2)).toHaveTextContent("Ready, merged with row 6");
  expect(reviewRow(3)).toHaveTextContent("Needs fixing: Email is invalid.");
  expect(reviewRow(3)).not.toHaveTextContent("Second problem.");
  expect(reviewRow(4)).toHaveTextContent("Skipped");
  expect(reviewRow(4)).toHaveClass("opacity-50");
  expect(reviewRow(5)).toHaveTextContent("Ready");
  expect(
    within(reviewRow(5)).getByText("No email: you enter their schedule"),
  ).toBeInTheDocument();
  expect(reviewRow(6)).toHaveTextContent("Merged into row 2");
  expect(reviewRow(6)).toHaveClass("opacity-50");

  // A row that needs fixing blocks the import, and the footer says so.
  expect(
    screen.getByRole("button", { name: "Import 2 people" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Fix or skip 1 row to continue."),
  ).toBeInTheDocument();

  // The header checkbox reflects a partly selected page and selects it all
  // in one request.
  const useAll = screen.getByLabelText("Use every row on this page");
  expect(useAll).not.toBeChecked();
  expect(useAll.indeterminate).toBe(true);
  await userEvent.click(useAll);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-3",
      { rowUpdates: rows.map((row) => ({ id: row.id, selected: true })) },
      "token",
    ),
  );
  await waitFor(() => expect(useAll).toBeEnabled());

  // Cells save on blur, numbers as numbers; unchanged values are not sent.
  const name = screen.getByLabelText("Name for row 2");
  fireEvent.change(name, { target: { value: "Ada Lovelace" } });
  fireEvent.blur(name);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-3",
      { rowUpdates: [{ id: "row-1", name: "Ada Lovelace" }] },
      "token",
    ),
  );
  await waitFor(() => expect(name).toBeEnabled());
  const weight = screen.getByLabelText("Weight for row 2");
  fireEvent.change(weight, { target: { value: "0.5" } });
  fireEvent.blur(weight);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-3",
      { rowUpdates: [{ id: "row-1", weight: 0.5 }] },
      "token",
    ),
  );
  await waitFor(() => expect(weight).toBeEnabled());
  const calls = configureRosterImport.mock.calls.length;
  const group = screen.getByLabelText("Group for row 2");
  fireEvent.change(group, { target: { value: "Design" } });
  fireEvent.blur(group);
  expect(configureRosterImport.mock.calls.length).toBe(calls);
  await userEvent.click(screen.getByLabelText("Included for row 2"));
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-3",
      { rowUpdates: [{ id: "row-1", included: false }] },
      "token",
    ),
  );
  await waitFor(() => expect(screen.getByLabelText("Show")).toBeEnabled());
  await userEvent.click(screen.getByLabelText("Select row 4"));
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-3",
      { rowUpdates: [{ id: "row-3", selected: true }] },
      "token",
    ),
  );
  await waitFor(() => expect(screen.getByLabelText("Show")).toBeEnabled());

  // Show asks the API for a subset and filters the page here as well, so an
  // API that ignores `show` still narrows the list.
  await userEvent.selectOptions(screen.getByLabelText("Show"), "needs_fix");
  await waitFor(() =>
    expect(fetchRosterImportRows).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-3",
      { page: 1, pageSize: 50, show: "needs_fix" },
      "token",
    ),
  );
  await waitFor(() =>
    expect(screen.queryByLabelText("Name for row 2")).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText("Name for row 3")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Show")).toBeEnabled());
  await userEvent.selectOptions(screen.getByLabelText("Show"), "skipped");
  await waitFor(() =>
    expect(screen.getByLabelText("Name for row 4")).toBeInTheDocument(),
  );
  expect(screen.queryByLabelText("Name for row 3")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Name for row 6")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Show")).toBeEnabled());
  await userEvent.selectOptions(screen.getByLabelText("Show"), "all");
  await waitFor(() =>
    expect(fetchRosterImportRows).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-3",
      { page: 1, pageSize: 50, show: undefined },
      "token",
    ),
  );
  await screen.findByLabelText("Name for row 2");

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(fetchRosterImportRows).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-3",
      { page: 2, pageSize: 50, show: undefined },
      "token",
    ),
  );
});

test("reports source, row, page and commit failures at the top of the step, with the server's 409 wording", async () => {
  const record = importRecord({ id: "import-4" });
  createRosterImport
    .mockRejectedValueOnce(httpError("The response deadline has passed.", 409))
    .mockResolvedValue({ import: record });
  configureRosterImport
    .mockResolvedValueOnce({ import: record })
    .mockRejectedValueOnce(new Error("row failed"));
  fetchRosterImportRows
    .mockResolvedValueOnce(
      rowsResponse(record, [importRow()], {
        page: 1,
        pageSize: 50,
        total: 60,
        pages: 2,
      }),
    )
    .mockRejectedValueOnce(new Error("page failed"));
  const closedEvent = { code: "IMPORT1", status: "closed" };
  commitRosterImport.mockRejectedValueOnce(
    httpError("Responses cannot change while the event is closed.", 409, {
      code: "event_not_active",
      event: closedEvent,
    }),
  );
  const onEventChange = jest.fn();
  renderWizard({ onEventChange });

  await pasteAndContinue();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The response deadline has passed.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  const region = await screen.findByRole("region", {
    name: "Imported rows awaiting review",
  });

  const name = screen.getByLabelText("Name for row 2");
  fireEvent.change(name, { target: { value: "Grace" } });
  fireEvent.blur(name);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("row failed");
  expect(isBefore(alert, region)).toBe(true);
  await waitFor(() => expect(name).toHaveValue("Ada"));

  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("page failed");

  await userEvent.click(
    screen.getByRole("button", { name: "Import 1 person" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Responses cannot change while the event is closed.",
  );
  expect(onEventChange).toHaveBeenCalledWith(closedEvent);
  expect(screen.getByRole("button", { name: "Import 1 person" })).toBeEnabled();
});

test("labels the commit by mode and count, guards a rebuild with the event code, and stays open on Done", async () => {
  const record = importRecord({
    id: "import-5",
    summary: {
      total: 2,
      selected: 2,
      valid: 2,
      invalid: 0,
      conflicts: 0,
      ready: 2,
      needsFix: 0,
      mergedDuplicates: 0,
      skipped: 0,
    },
  });
  const response = {
    receipt: {
      mode: "rebuild",
      importedCount: 2,
      createdCount: 2,
      updatedCount: 0,
    },
    autoInvitedCount: 0,
    event: { code: "IMPORT1", status: "active" },
    deliveryRequest: null,
    // A rebuild re-adds everyone, so every emailable row is up for review.
    addedParticipantIds: ["41"],
    importedParticipantIds: ["41", "43"],
  };
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue(
    rowsResponse(record, [
      importRow(),
      importRow({
        id: "row-2",
        rowNumber: 3,
        name: "Guest",
        email: "",
        organizerManaged: true,
      }),
    ]),
  );
  commitRosterImport.mockResolvedValue(response);
  const onCommitted = jest.fn();
  const onClose = jest.fn();
  const onSendInvitations = jest.fn();
  renderWizard({ onCommitted, onClose, onSendInvitations });
  await reachReview("name\temail\nAda\tada@example.com\nGuest\t");

  // Nobody is emailed from the import itself any more.
  expect(screen.getByRole("button", { name: "Import 2 people" })).toBeEnabled();
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /invitations/i })).toBeNull();

  await userEvent.click(screen.getByLabelText(/Replace the whole list/));
  const rebuild = screen.getByRole("button", {
    name: "Replace the list with 2 people",
  });
  expect(rebuild).toBeDisabled();
  expect(screen.getByRole("note")).toHaveTextContent(
    "Rebuilding clears schedules, invitations, and pending delivery. Everyone starts as Not sent and gets no reminders until you send invitations, which you can review once the import is done.",
  );
  const code = screen.getByLabelText("Rebuild confirmation code");
  fireEvent.change(code, { target: { value: "WRONG" } });
  expect(rebuild).toBeDisabled();
  fireEvent.change(code, { target: { value: " import1 " } });
  expect(rebuild).toBeEnabled();
  await userEvent.click(screen.getByLabelText(/Add and update people/));
  expect(screen.getByRole("button", { name: "Import 2 people" })).toBeEnabled();
  await userEvent.click(screen.getByLabelText(/Replace the whole list/));
  await userEvent.click(
    screen.getByRole("button", { name: "Replace the list with 2 people" }),
  );
  await waitFor(() =>
    expect(commitRosterImport).toHaveBeenCalledWith(
      "IMPORT1",
      "import-5",
      {
        mode: "rebuild",
        idempotencyKey: "import-key",
        sendInvitations: false,
        confirmationCode: " import1 ",
      },
      "token",
    ),
  );

  // Done: the sheet stays open with the result and what happens next.
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Imported 2 people: 2 added, 0 updated. No invitations were sent.",
  );
  expect(screen.queryByText(/invitations? queued/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("dialog", { name: "Import participants" }),
  ).toHaveAccessibleDescription(
    "The participant import was committed successfully.",
  );
  expect(onCommitted).toHaveBeenCalledWith({
    ...response,
    sendInvitations: false,
  });
  expect(onClose).not.toHaveBeenCalled();

  await userEvent.click(
    screen.getByRole("button", { name: "Back to participants" }),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
  // A finished import closes without asking or cancelling anything.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(cancelRosterImport).not.toHaveBeenCalled();

  // A rebuild offers invitations for everyone it imported: the sheet closes
  // and the participant list reviews them.
  await userEvent.click(
    screen.getByRole("button", { name: "Review and send invitations (2)…" }),
  );
  expect(onClose).toHaveBeenCalledTimes(3);
  expect(onSendInvitations).toHaveBeenCalledWith(["41", "43"]);
  expect(onClose.mock.invocationCallOrder[2]).toBeLessThan(
    onSendInvitations.mock.invocationCallOrder[0],
  );

  // Import another list starts over with an empty paste.
  await userEvent.click(
    screen.getByRole("button", { name: "Import another list" }),
  );
  expect(
    screen.getByRole("tab", { name: "Paste from a spreadsheet" }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Pasted participant rows")).toHaveValue("");
  expect(screen.getByText("Paste rows to see a preview.")).toBeInTheDocument();
});

test("a merge offers invitations for the people it added, not everyone it imported", async () => {
  const record = importRecord({ id: "import-6" });
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue(rowsResponse(record, [importRow()]));
  commitRosterImport.mockResolvedValue({
    receipt: {
      mode: "merge",
      importedCount: 2,
      createdCount: 1,
      updatedCount: 1,
    },
    autoInvitedCount: 0,
    deliveryRequest: null,
    addedParticipantIds: ["52"],
    importedParticipantIds: ["51", "52"],
  });
  const onClose = jest.fn();
  const onSendInvitations = jest.fn();
  renderWizard({ onClose, onSendInvitations });
  await reachReview();
  await userEvent.click(
    screen.getByRole("button", { name: "Import 1 person" }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Imported 2 people: 1 added, 1 updated. No invitations were sent.",
  );
  const review = screen.getByRole("button", {
    name: "Review and send invitations (1)…",
  });
  // The review is the way forward; going back to the list is secondary.
  expect(review).toHaveClass("btn-primary");
  expect(
    screen.getByRole("button", { name: "Back to participants" }),
  ).not.toHaveClass("btn-primary");
  await userEvent.click(review);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSendInvitations).toHaveBeenCalledWith(["52"]);
});

test("skips the invitation review when the import added nobody to invite", async () => {
  const record = importRecord({ id: "import-7" });
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue(rowsResponse(record, [importRow()]));
  commitRosterImport.mockResolvedValue({
    receipt: {
      mode: "merge",
      importedCount: 1,
      createdCount: 1,
      updatedCount: 0,
    },
    autoInvitedCount: 0,
    deliveryRequest: null,
  });
  renderWizard();
  await reachReview();
  await userEvent.click(
    screen.getByRole("button", { name: "Import 1 person" }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Imported 1 people: 1 added, 0 updated. No invitations were sent.",
  );
  expect(
    screen.queryByRole("button", { name: /^Review and send invitations/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Back to participants" }),
  ).toHaveClass("btn-primary");
  expect(screen.queryByText(/no email of their own/)).not.toBeInTheDocument();
  expect(commitRosterImport).toHaveBeenCalledWith(
    "IMPORT1",
    "import-7",
    { mode: "merge", idempotencyKey: "import-key", sendInvitations: false },
    "token",
  );
});

test("needs at least one ready row before anything can be imported", async () => {
  const record = importRecord({
    id: "import-8",
    summary: {
      total: 1,
      selected: 0,
      valid: 0,
      invalid: 0,
      conflicts: 0,
      ready: 0,
      needsFix: 0,
      mergedDuplicates: 0,
      skipped: 1,
    },
  });
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue(
    rowsResponse(record, [importRow({ selected: false })]),
  );
  renderWizard();
  await reachReview();
  expect(
    screen.getByText(
      "0 ready · 0 need fixing · 0 duplicates merged · 1 skipped",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Import 0 people" }),
  ).toBeDisabled();
  expect(screen.getByText("Select at least one row.")).toBeInTheDocument();
  const useAll = screen.getByLabelText("Use every row on this page");
  expect(useAll).not.toBeChecked();
  expect(useAll.indeterminate).toBe(false);
});

test("saves a cell the server refused on leaving it, even at the fallback it shows", async () => {
  const record = importRecord({ id: "import-9" });
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue(
    rowsResponse(record, [
      importRow({
        valid: false,
        errors: [
          "phone cannot contain a formula.",
          "weight must be between 0 and 1.",
        ],
      }),
    ]),
  );
  renderWizard();
  await reachReview();
  expect(reviewRow(2)).toHaveTextContent(
    "Needs fixing: phone cannot contain a formula.",
  );

  // The weight cell shows the fallback 1; leaving it settles on that 1.
  const weight = screen.getByLabelText("Weight for row 2");
  expect(weight).toHaveValue(1);
  fireEvent.blur(weight);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-9",
      { rowUpdates: [{ id: "row-1", weight: 1 }] },
      "token",
    ),
  );
  await waitFor(() => expect(weight).toBeEnabled());
  const phone = screen.getByLabelText("Phone for row 2");
  fireEvent.blur(phone);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-9",
      { rowUpdates: [{ id: "row-1", phone: "" }] },
      "token",
    ),
  );
  await waitFor(() => expect(phone).toBeEnabled());

  // Cells the server didn't refuse still save only a change.
  const calls = configureRosterImport.mock.calls.length;
  fireEvent.blur(screen.getByLabelText("Name for row 2"));
  expect(configureRosterImport.mock.calls.length).toBe(calls);
});

test("falls back to the older summary keys when the API sends only those", async () => {
  const record = importRecord({
    id: "import-9",
    summary: { total: 4, selected: 3, valid: 2, invalid: 1, conflicts: 1 },
  });
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue(
    rowsResponse(record, [
      importRow({
        id: "row-1",
        rowNumber: 2,
        selected: false,
        duplicate: "identical",
      }),
    ]),
  );
  renderWizard();
  await reachReview();
  expect(
    screen.getByText(
      "2 ready · 1 needs fixing · 0 duplicates merged · 1 skipped",
    ),
  ).toBeInTheDocument();
  // A merged copy whose survivor is on another page still reads as merged.
  expect(reviewRow(2)).toHaveTextContent("Merged into an identical row");
});

test("asks before discarding a live preview, cancels it, and closes at once when there is nothing to lose", async () => {
  const record = importRecord({ id: "import-10" });
  createRosterImport.mockResolvedValue({ import: record });
  cancelRosterImport
    .mockRejectedValueOnce(new Error("cancel failed"))
    .mockRejectedValueOnce(httpError("gone", 410));
  const onClose = jest.fn();
  renderWizard({ onClose });

  // Nothing created yet: Escape closes without a question.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(cancelRosterImport).not.toHaveBeenCalled();

  await pasteAndContinue();
  await screen.findByRole("button", { name: "Preview rows" });
  await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(
    screen.getByRole("dialog", { name: "Discard this import?" }),
  ).toBeInTheDocument();
  expect(onClose).toHaveBeenCalledTimes(1);

  // Escape only withdraws the question; the sheet stays.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.queryByRole("dialog", { name: "Discard this import?" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("dialog", { name: "Import participants" }),
  ).toBeInTheDocument();
  expect(onClose).toHaveBeenCalledTimes(1);

  // A cancel that fails for a real reason keeps the sheet open and says why.
  fireEvent.mouseDown(document.querySelector(".app-modal-backdrop"));
  await userEvent.click(
    within(
      screen.getByRole("dialog", { name: "Discard this import?" }),
    ).getByRole("button", { name: "Discard import" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("cancel failed");
  expect(
    screen.queryByRole("dialog", { name: "Discard this import?" }),
  ).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledTimes(1);

  // A preview that is already gone needs no cancelling: the sheet closes.
  await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  await userEvent.click(
    within(
      screen.getByRole("dialog", { name: "Discard this import?" }),
    ).getByRole("button", { name: "Discard import" }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  expect(cancelRosterImport).toHaveBeenCalledTimes(2);
  expect(cancelRosterImport).toHaveBeenLastCalledWith(
    "IMPORT1",
    "import-10",
    "token",
  );
});

test("offers Start again when the preview expired and keeps the pasted rows", async () => {
  const record = importRecord({ id: "import-11" });
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport
    .mockResolvedValueOnce({ import: record })
    .mockRejectedValueOnce(httpError("This import preview has expired.", 410));
  fetchRosterImportRows.mockResolvedValue(rowsResponse(record, [importRow()]));
  const onClose = jest.fn();
  renderWizard({ onClose });
  await reachReview();

  const name = screen.getByLabelText("Name for row 2");
  fireEvent.change(name, { target: { value: "Grace" } });
  fireEvent.blur(name);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("This import expired after 24 hours.");
  expect(
    screen.getByRole("button", { name: "Import 1 person" }),
  ).toBeDisabled();

  await userEvent.click(
    within(alert).getByRole("button", { name: "Start again" }),
  );
  expect(
    screen.getByRole("tab", { name: "Paste from a spreadsheet" }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Pasted participant rows")).toHaveValue(PASTE);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  // Nothing is live any more, so closing needs no confirmation.
  await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(cancelRosterImport).not.toHaveBeenCalled();
});

test("cancels the previous preview when continuing from Source again and warns before re-previewing edited rows", async () => {
  const first = importRecord({ id: "import-a" });
  const second = importRecord({ id: "import-b" });
  createRosterImport
    .mockResolvedValueOnce({ import: first })
    .mockResolvedValueOnce({ import: second });
  configureRosterImport.mockResolvedValue({ import: first });
  fetchRosterImportRows.mockResolvedValue(rowsResponse(first, [importRow()]));
  cancelRosterImport
    .mockRejectedValueOnce(new Error("cancel failed"))
    .mockResolvedValue({ status: "canceled" });
  renderWizard();
  await reachReview();

  const name = screen.getByLabelText("Name for row 2");
  fireEvent.change(name, { target: { value: "Ada Lovelace" } });
  fireEvent.blur(name);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-a",
      { rowUpdates: [{ id: "row-1", name: "Ada Lovelace" }] },
      "token",
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Back" }));

  // The mapping is kept, and the warning explains what a new preview does.
  expect(screen.getByRole("combobox", { name: "Column for Name" })).toHaveValue(
    "0",
  );
  expect(screen.getByRole("note")).toHaveTextContent(
    "Previewing again resets edits made on the Review step.",
  );

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByLabelText("Pasted participant rows")).toHaveValue(PASTE);
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("cancel failed");
  expect(createRosterImport).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(cancelRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-a",
      "token",
    ),
  );
  expect(
    await screen.findByText(/Sheet: Pasted data, headers in row 1/),
  ).toBeInTheDocument();
  expect(createRosterImport).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
});

test("saves email and phone edits, pages back, and reports a failed preview or Show reload", async () => {
  const record = importRecord({
    id: "import-12",
    headers: ["name", "email", "phone"],
    columnMapping: { name: 0, email: 1, phone: 2 },
  });
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport
    .mockRejectedValueOnce(new Error("mapping failed"))
    .mockResolvedValue({ import: record });
  const page2 = rowsResponse(
    record,
    [
      importRow({
        id: "row-9",
        rowNumber: 52,
        name: "Grace",
        email: "grace@example.com",
        phone: "+1 555 0100",
      }),
    ],
    { page: 2, pageSize: 50, total: 51, pages: 2 },
  );
  fetchRosterImportRows
    .mockResolvedValueOnce(page2)
    .mockResolvedValueOnce(page2)
    .mockResolvedValueOnce(page2)
    .mockRejectedValueOnce(new Error("show failed"))
    .mockResolvedValueOnce(page2);
  renderWizard();
  await pasteAndContinue("name\temail\tphone\nAda\tada@example.com\t");
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("mapping failed");
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  await screen.findByRole("region", { name: "Imported rows awaiting review" });

  const email = screen.getByLabelText("Email for row 52");
  fireEvent.change(email, { target: { value: "grace@releviz.test" } });
  fireEvent.blur(email);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-12",
      { rowUpdates: [{ id: "row-9", email: "grace@releviz.test" }] },
      "token",
    ),
  );
  await waitFor(() => expect(email).toBeEnabled());
  const phone = screen.getByLabelText("Phone for row 52");
  expect(phone).toHaveValue("+1 555 0100");
  // An unchanged phone is not sent.
  fireEvent.change(phone, { target: { value: "+1 555 0100" } });
  fireEvent.blur(phone);
  expect(configureRosterImport).toHaveBeenCalledTimes(3);
  fireEvent.change(phone, { target: { value: "555 010 3000" } });
  fireEvent.blur(phone);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-12",
      { rowUpdates: [{ id: "row-9", phone: "555 010 3000" }] },
      "token",
    ),
  );
  await waitFor(() => expect(phone).toBeEnabled());

  // A Show reload that fails is reported; the rows stay as they were.
  await userEvent.selectOptions(screen.getByLabelText("Show"), "skipped");
  expect(await screen.findByRole("alert")).toHaveTextContent("show failed");
  await waitFor(() => expect(screen.getByLabelText("Show")).toBeEnabled());
  expect(screen.getByLabelText("Phone for row 52")).toBeInTheDocument();

  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Previous" }));
  await waitFor(() =>
    expect(fetchRosterImportRows).toHaveBeenLastCalledWith(
      "IMPORT1",
      "import-12",
      { page: 1, pageSize: 50, show: "skipped" },
      "token",
    ),
  );
});
