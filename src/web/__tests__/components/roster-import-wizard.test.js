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
const getToken = jest.fn().mockResolvedValue("token");

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

beforeEach(() => {
  jest.resetAllMocks();
  getToken.mockResolvedValue("token");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: jest.fn().mockReturnValue("import-key") },
  });
});

test("validates file type and size before creating a preview", async () => {
  renderWizard();
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a .csv or .xlsx file",
  );

  const input = screen.getByLabelText("CSV or XLSX file");
  fireEvent.change(input, {
    target: { files: [new File(["legacy"], "people.xls")] },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Only .csv and .xlsx");

  const oversized = new File(
    [new Uint8Array(5 * 1024 * 1024 + 1)],
    "people.xlsx",
  );
  fireEvent.change(input, { target: { files: [oversized] } });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("5 MiB or smaller");
  expect(createRosterImport).not.toHaveBeenCalled();
});

test("supports multi-sheet headers, editable preview rows, pagination, and cancellation", async () => {
  const sourceRecord = {
    id: "import-2",
    status: "preview",
    sourceType: "xlsx",
    worksheets: [
      { name: "Notes", rowCount: 1, defaultHeaderRow: 1, headers: ["read me"] },
      {
        name: "People",
        rowCount: 4,
        defaultHeaderRow: 1,
        headers: ["title row"],
      },
    ],
    selectedWorksheet: null,
    headerRow: 1,
    headers: [],
    columnMapping: {},
    defaults: { group: "", weight: 1, included: true },
    summary: {},
  };
  const headerRecord = {
    ...sourceRecord,
    selectedWorksheet: "People",
    headerRow: 2,
    headers: ["name", "email", "group", "weight", "included"],
  };
  const previewRecord = {
    ...headerRecord,
    columnMapping: { name: 0, email: 1, group: 2, weight: 3, included: 4 },
    defaults: { group: "Guests", weight: 0.75, included: false },
    summary: { total: 3, selected: 3, valid: 2, invalid: 1, conflicts: 1 },
  };
  const rows = [
    {
      id: "row-1",
      rowNumber: 3,
      name: "Ada",
      email: "ada@example.com",
      group: "Faculty",
      weight: 1,
      included: true,
      selected: true,
      valid: true,
      duplicate: "identical",
      errors: [],
    },
    {
      id: "row-2",
      rowNumber: 4,
      name: "Grace",
      email: "grace@example.com",
      group: "Staff",
      weight: 0.5,
      included: true,
      selected: true,
      valid: false,
      duplicate: "conflict",
      errors: ["Conflicting duplicate email."],
    },
  ];
  createRosterImport.mockResolvedValue({ import: sourceRecord });
  configureRosterImport
    .mockResolvedValueOnce({ import: headerRecord })
    .mockResolvedValue({ import: previewRecord });
  fetchRosterImportRows.mockResolvedValue({
    import: previewRecord,
    rows,
    pagination: { page: 1, pageSize: 50, total: 51, pages: 2 },
  });
  cancelRosterImport.mockResolvedValue({ status: "canceled" });
  const onClose = jest.fn();
  renderWizard({ onClose });

  const file = new File(["xlsx"], "people.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  fireEvent.change(screen.getByLabelText("CSV or XLSX file"), {
    target: { files: [file] },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  await userEvent.selectOptions(
    await screen.findByLabelText("Worksheet"),
    "People",
  );
  fireEvent.change(screen.getByLabelText("Header row"), {
    target: { value: "2" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Columns loaded");

  // The default group cell accepts the same "ALL"/";" syntax as a column.
  const defaultGroup = screen.getByLabelText("Default group");
  expect(defaultGroup).toHaveAccessibleDescription(
    "Blank = unassigned, ALL = every group, separate several names with ;",
  );
  expect(defaultGroup).not.toHaveAttribute("maxlength");
  fireEvent.change(defaultGroup, {
    target: { value: "Guests" },
  });
  fireEvent.change(screen.getByLabelText("Default weight"), {
    target: { value: "0.75" },
  });
  await userEvent.click(screen.getByLabelText("Include by default"));
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(
    await screen.findByDisplayValue("ada@example.com"),
  ).toBeInTheDocument();
  expect(screen.getByText("Identical duplicate merged")).toBeInTheDocument();
  expect(screen.getByText("Conflicting duplicate email.")).toBeInTheDocument();

  const name = screen.getByLabelText("Name for row 3");
  fireEvent.change(name, { target: { value: "Ada Lovelace" } });
  fireEvent.blur(name);
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenCalledWith(
      event.code,
      "import-2",
      { rowUpdates: [{ id: "row-1", name: "Ada Lovelace" }] },
      "token",
    ),
  );
  await userEvent.click(screen.getByLabelText("Included for row 3"));
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenCalledWith(
      event.code,
      "import-2",
      { rowUpdates: [{ id: "row-1", included: false }] },
      "token",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(fetchRosterImportRows).toHaveBeenCalledWith(
      event.code,
      "import-2",
      { page: 2, pageSize: 50 },
      "token",
    ),
  );

  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(cancelRosterImport).toHaveBeenCalledWith(
      event.code,
      "import-2",
      "token",
    ),
  );
  expect(onClose).toHaveBeenCalled();
});

test("surfaces source and mapping failures", async () => {
  const record = {
    id: "import-3",
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
    columnMapping: {},
    defaults: { weight: 1, included: true },
    summary: { valid: 1 },
  };
  createRosterImport.mockRejectedValueOnce(new Error("source failed"));
  const { unmount } = renderWizard();
  fireEvent.change(screen.getByLabelText("CSV or XLSX file"), {
    target: { files: [new File(["name,email"], "people.csv")] },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("source failed");
  unmount();

  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockRejectedValueOnce(new Error("mapping failed"));
  renderWizard();
  fireEvent.change(screen.getByLabelText("CSV or XLSX file"), {
    target: { files: [new File(["name,email"], "people.csv")] },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("mapping failed");
});

test("surfaces preview-row, commit, and cancel failures", async () => {
  const record = {
    id: "import-4",
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
    defaults: { weight: 1, included: true },
    summary: { total: 1, selected: 1, valid: 1, invalid: 0, conflicts: 0 },
  };
  const row = {
    id: "row-4",
    rowNumber: 2,
    name: "Ada",
    email: "ada@example.com",
    weight: 1,
    included: true,
    selected: true,
    valid: true,
    duplicate: "unique",
    errors: [],
  };
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport
    .mockResolvedValueOnce({ import: record })
    .mockRejectedValueOnce(new Error("row failed"));
  fetchRosterImportRows.mockResolvedValue({
    import: record,
    rows: [row],
    pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
  });
  commitRosterImport.mockRejectedValueOnce(new Error("commit failed"));
  cancelRosterImport.mockRejectedValueOnce(new Error("cancel failed"));
  renderWizard();
  await userEvent.click(screen.getByRole("tab", { name: "Paste spreadsheet" }));
  fireEvent.change(screen.getByLabelText("Pasted roster rows"), {
    target: { value: "name\temail\nAda\tada@example.com" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  await screen.findByDisplayValue("ada@example.com");

  const rowName = screen.getByLabelText("Name for row 2");
  fireEvent.change(rowName, { target: { value: "Grace" } });
  fireEvent.blur(rowName);
  expect(await screen.findByRole("alert")).toHaveTextContent("row failed");
  await waitFor(() => expect(rowName).toHaveValue("Ada"));
  await userEvent.click(
    screen.getByRole("button", { name: "Merge roster and invite new people" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("commit failed");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("cancel failed");
});

test("closes immediately before a preview exists", async () => {
  const onClose = jest.fn();
  renderWizard({ onClose });
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
  expect(cancelRosterImport).not.toHaveBeenCalled();
  expect(commitRosterImport).not.toHaveBeenCalled();
});

test("moves between sources with the keyboard, edits every preview column, and guards a rebuild", async () => {
  const record = {
    id: "import-5",
    worksheets: [
      {
        name: "Pasted data",
        rowCount: 2,
        defaultHeaderRow: 1,
        headers: ["Full Name", "E-mail", "Team", "Weight", "Included"],
      },
    ],
    selectedWorksheet: "Pasted data",
    headerRow: 1,
    headers: ["Full Name", "E-mail", "Team", "Weight", "Included"],
    columnMapping: {},
    defaults: { group: "", weight: 1, included: true },
    summary: { total: 1, selected: 1, valid: 1, invalid: 0, conflicts: 0 },
  };
  const row = {
    id: "row-5",
    rowNumber: 2,
    name: "Ada",
    email: "ada@example.com",
    group: "",
    weight: 1,
    included: true,
    selected: true,
    valid: true,
    duplicate: "unique",
    errors: [],
  };
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue({
    import: record,
    rows: [row],
    pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
  });
  commitRosterImport.mockResolvedValue({
    receipt: { importedCount: 1, createdCount: 0, updatedCount: 1 },
    autoInvitedCount: 0,
  });
  const onCommitted = jest.fn();
  renderWizard({ onCommitted });

  // Arrow keys and Home/End move the source tab focus and selection.
  const fileTab = screen.getByRole("tab", { name: "File upload" });
  const pasteTab = screen.getByRole("tab", { name: "Paste spreadsheet" });
  fileTab.focus();
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

  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Paste rows copied from Google Sheets or Excel first.",
  );
  // The paste example shows the multi-group cell syntax.
  const pasteArea = screen.getByLabelText("Pasted roster rows");
  expect(pasteArea).toHaveAttribute(
    "placeholder",
    "name\temail\tgroup\nAda\tada@example.com\tFaculty; Team 3",
  );
  fireEvent.change(pasteArea, {
    target: { value: "Full Name\tE-mail\nAda\tada@example.com" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  // Headers are matched by their normalized aliases; the preview refuses
  // to continue until both mandatory columns are mapped.
  const nameSelect = await screen.findByLabelText("Name *");
  expect(nameSelect).toHaveValue("0");
  expect(screen.getByLabelText("Email *")).toHaveValue("1");
  expect(screen.getByLabelText("Group")).toHaveValue("2");
  await userEvent.selectOptions(nameSelect, "");
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Map both the name and email columns.",
  );
  await userEvent.selectOptions(nameSelect, "0");
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("tab", { name: "Paste spreadsheet" })).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  await screen.findByDisplayValue("ada@example.com");

  // Group cells stay free text so several names (or ALL) round-trip as one
  // joined string, with no length cap on the cell.
  for (const [label, value, field] of [
    ["Email for row 2", "ada@releviz.test", "email"],
    ["Group for row 2", "ALL; Faculty; Team 3", "group"],
    ["Weight for row 2", "0.5", "weight"],
  ]) {
    const input = screen.getByLabelText(label);
    expect(input).not.toHaveAttribute("maxlength");
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(configureRosterImport).toHaveBeenLastCalledWith(
        event.code,
        "import-5",
        {
          rowUpdates: [
            { id: "row-5", [field]: field === "weight" ? 0.5 : value },
          ],
        },
        "token",
      ),
    );
  }
  // Unchanged values are not sent.
  const groupInput = screen.getByLabelText("Group for row 2");
  const callsBefore = configureRosterImport.mock.calls.length;
  fireEvent.change(groupInput, { target: { value: "" } });
  fireEvent.blur(groupInput);
  expect(configureRosterImport.mock.calls.length).toBe(callsBefore);
  await userEvent.click(screen.getByLabelText("Select row 2"));
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      event.code,
      "import-5",
      { rowUpdates: [{ id: "row-5", selected: false }] },
      "token",
    ),
  );

  // A rebuild needs the exact event code before it can be committed.
  await userEvent.click(screen.getByLabelText(/Rebuild the roster/));
  const commit = screen.getByRole("button", {
    name: "Rebuild roster and send invitations",
  });
  expect(commit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Rebuild confirmation code"), {
    target: { value: "WRONG" },
  });
  expect(commit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Rebuild confirmation code"), {
    target: { value: "IMPORT1" },
  });
  await userEvent.click(commit);
  await waitFor(() =>
    expect(commitRosterImport).toHaveBeenCalledWith(
      event.code,
      "import-5",
      {
        mode: "rebuild",
        idempotencyKey: "import-key",
        confirmationCode: "IMPORT1",
      },
      "token",
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Imported 1 people: no new participants were added, so no invitations were sent.",
  );
  expect(onCommitted).toHaveBeenCalled();
});

test("explains a closed event on commit and reports paging failures", async () => {
  const record = {
    id: "import-6",
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
    defaults: { weight: 1, included: true },
    summary: { total: 60, selected: 60, valid: 60, invalid: 0, conflicts: 0 },
  };
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows
    .mockResolvedValueOnce({
      import: record,
      rows: [
        {
          id: "row-6",
          rowNumber: 2,
          name: "Ada",
          email: "ada@example.com",
          weight: 1,
          included: true,
          selected: true,
          valid: true,
          duplicate: "unique",
          errors: [],
        },
      ],
      pagination: { page: 2, pageSize: 50, total: 60, pages: 2 },
    })
    .mockRejectedValueOnce(new Error("page failed"));
  const closedError = Object.assign(new Error("closed"), {
    code: "event_not_active",
    event: { code: "IMPORT1", status: "closed" },
  });
  commitRosterImport.mockRejectedValueOnce(closedError);
  const onEventChange = jest.fn();
  renderWizard({ onEventChange });
  await userEvent.click(screen.getByRole("tab", { name: "Paste spreadsheet" }));
  fireEvent.change(screen.getByLabelText("Pasted roster rows"), {
    target: { value: "name\temail\nAda\tada@example.com" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  await screen.findByDisplayValue("ada@example.com");
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("page failed");
  await userEvent.click(
    screen.getByRole("button", { name: "Merge roster and invite new people" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This event is closed. Reactivate it before committing this roster.",
  );
  expect(onEventChange).toHaveBeenCalledWith(closedError.event);
});

test("flags rows bound to blocked accounts and lets them be deselected", async () => {
  const record = {
    id: "import-7",
    worksheets: [
      {
        name: "Pasted data",
        rowCount: 6,
        defaultHeaderRow: 1,
        headers: ["name", "email"],
      },
    ],
    selectedWorksheet: "Pasted data",
    headerRow: 1,
    headers: ["name", "email"],
    columnMapping: { name: 0, email: 1 },
    defaults: { weight: 1, included: true },
    summary: { total: 6, selected: 6, valid: 5, invalid: 1, conflicts: 0 },
  };
  const rows = [
    {
      id: "row-7",
      rowNumber: 2,
      name: "Ada",
      email: "ada@example.com",
      weight: 1,
      included: true,
      selected: true,
      valid: true,
      duplicate: "unique",
      errors: [],
    },
    {
      id: "row-8",
      rowNumber: 3,
      name: "Inactive",
      email: "inactive@example.com",
      weight: 1,
      included: true,
      selected: true,
      valid: false,
      duplicate: "unique",
      errors: ["This email belongs to an inactive account."],
    },
  ];
  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockResolvedValue({ import: record });
  fetchRosterImportRows.mockResolvedValue({
    import: record,
    rows,
    pagination: { page: 1, pageSize: 50, total: 2, pages: 1 },
  });
  renderWizard();
  await userEvent.click(screen.getByRole("tab", { name: "Paste spreadsheet" }));
  fireEvent.change(screen.getByLabelText("Pasted roster rows"), {
    target: {
      value:
        "name\temail\nAda\tada@example.com\nInactive\tinactive@example.com",
    },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  await screen.findByDisplayValue("inactive@example.com");

  // The server-side account check surfaces as an Invalid badge with its
  // sentence, and the summary tiles echo the server counts.
  const region = screen.getByRole("region", {
    name: "Imported rows awaiting review",
  });
  expect(
    within(region).getByText("This email belongs to an inactive account."),
  ).toBeVisible();
  expect(within(region).getByText("Invalid")).toBeVisible();
  expect(within(region).getByText("Ready")).toBeVisible();
  expect(
    screen
      .getByText("Invalid", { selector: ".metric-tile__label" })
      .closest(".metric-tile"),
  ).toHaveTextContent("Invalid1");

  await userEvent.click(screen.getByLabelText("Select row 3"));
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenLastCalledWith(
      event.code,
      "import-7",
      { rowUpdates: [{ id: "row-8", selected: false }] },
      "token",
    ),
  );
});
