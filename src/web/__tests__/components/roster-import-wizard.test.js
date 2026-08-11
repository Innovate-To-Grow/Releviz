/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    />
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
  await userEvent.click(screen.getByRole("button", { name: "Continue to mapping" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Choose a .csv or .xlsx file");

  const input = screen.getByLabelText("CSV or XLSX file");
  fireEvent.change(input, {
    target: { files: [new File(["legacy"], "people.xls")] },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue to mapping" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Only .csv and .xlsx");

  const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "people.xlsx");
  fireEvent.change(input, { target: { files: [oversized] } });
  await userEvent.click(screen.getByRole("button", { name: "Continue to mapping" }));
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
  fireEvent.change(screen.getByLabelText("CSV or XLSX file"), { target: { files: [file] } });
  await userEvent.click(screen.getByRole("button", { name: "Continue to mapping" }));
  await userEvent.selectOptions(await screen.findByLabelText("Worksheet"), "People");
  fireEvent.change(screen.getByLabelText("Header row"), { target: { value: "2" } });
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Columns loaded");

  fireEvent.change(screen.getByLabelText("Default group"), { target: { value: "Guests" } });
  fireEvent.change(screen.getByLabelText("Default weight"), { target: { value: "0.75" } });
  await userEvent.click(screen.getByLabelText("Include by default"));
  await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
  expect(await screen.findByDisplayValue("ada@example.com")).toBeInTheDocument();
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
      "token"
    )
  );
  await userEvent.click(screen.getByLabelText("Included for row 3"));
  await waitFor(() =>
    expect(configureRosterImport).toHaveBeenCalledWith(
      event.code,
      "import-2",
      { rowUpdates: [{ id: "row-1", included: false }] },
      "token"
    )
  );
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(fetchRosterImportRows).toHaveBeenCalledWith(
      event.code,
      "import-2",
      { page: 2, pageSize: 50 },
      "token"
    )
  );

  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(cancelRosterImport).toHaveBeenCalledWith(event.code, "import-2", "token")
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
  await userEvent.click(screen.getByRole("button", { name: "Continue to mapping" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("source failed");
  unmount();

  createRosterImport.mockResolvedValue({ import: record });
  configureRosterImport.mockRejectedValueOnce(new Error("mapping failed"));
  renderWizard();
  fireEvent.change(screen.getByLabelText("CSV or XLSX file"), {
    target: { files: [new File(["name,email"], "people.csv")] },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue to mapping" }));
  await userEvent.click(await screen.findByRole("button", { name: "Preview rows" }));
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
  await userEvent.click(screen.getByRole("button", { name: "Paste spreadsheet" }));
  fireEvent.change(screen.getByLabelText("Pasted roster rows"), {
    target: { value: "name\temail\nAda\tada@example.com" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue to mapping" }));
  await userEvent.click(await screen.findByRole("button", { name: "Preview rows" }));
  await screen.findByDisplayValue("ada@example.com");

  await userEvent.click(screen.getByLabelText("Select row 2"));
  expect(await screen.findByRole("alert")).toHaveTextContent("row failed");
  await userEvent.click(screen.getByRole("button", { name: "Merge roster" }));
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
