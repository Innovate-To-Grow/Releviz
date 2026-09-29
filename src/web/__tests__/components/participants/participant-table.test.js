/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import ParticipantTable from "@/components/schedule/participants/ParticipantTable";

function person(id, overrides = {}) {
  return {
    id: String(id),
    participantId: String(id),
    name: `Person ${id}`,
    email: `p${id}@example.com`,
    phone: "",
    groups: [],
    allGroups: false,
    weight: 1,
    included: true,
    submitted: false,
    accountAccess: "temporary",
    organizerManaged: false,
    canOrganizerEditAvailability: true,
    isOrganizer: false,
    canOrganizerEditEmail: true,
    invitationStatus: "not_sent",
    invitationDelivery: null,
    version: 1,
    ...overrides,
  };
}

const people = [person(1), person(2), person(3)];

function renderTable(props = {}) {
  const handlers = {
    onToggleSelect: jest.fn(),
    onTogglePage: jest.fn(),
    onSelectAllMatching: jest.fn(),
    onOpen: jest.fn(),
    onEditSchedule: jest.fn(),
    onSendInvitation: jest.fn(),
    onToggleIncluded: jest.fn(),
    onRemove: jest.fn(),
    onApplyAgain: jest.fn(),
    onDismissConflict: jest.fn(),
  };
  render(<ParticipantTable participants={people} {...handlers} {...props} />);
  return handlers;
}

const pageBox = () =>
  screen.getByRole("checkbox", { name: "Select everyone on this page" });

describe("ParticipantTable", () => {
  test("renders the shell, caption, headers and one row per person", () => {
    renderTable();
    expect(
      screen.getByRole("region", { name: "Participant table" }),
    ).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("Participants")).toHaveClass("visually-hidden");
    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual(["", "Name", "Groups", "Response", "Invitation", "Actions"]);
    expect(
      screen.getAllByRole("checkbox", { name: /^Select Person/ }),
    ).toHaveLength(3);
    expect(pageBox()).not.toBeChecked();
    expect(pageBox().indeterminate).toBe(false);
  });

  test("the page checkbox reflects a partial and a full selection", async () => {
    const user = userEvent.setup();
    const handlers = renderTable({ selectedIds: new Set(["1"]) });
    expect(pageBox().indeterminate).toBe(true);
    expect(pageBox()).not.toBeChecked();
    await user.click(pageBox());
    expect(handlers.onTogglePage).toHaveBeenCalledWith(true);
    expect(screen.queryByText(/on this page are selected/)).toBeNull();
  });

  test("offers to extend a full-page selection to everyone matching", async () => {
    const user = userEvent.setup();
    const handlers = renderTable({
      selectedIds: new Set(["1", "2", "3"]),
      total: 12,
    });
    expect(pageBox()).toBeChecked();
    expect(pageBox().indeterminate).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent(
      "All 3 people on this page are selected.",
    );
    await user.click(
      screen.getByRole("button", { name: "Select all 12 matching" }),
    );
    expect(handlers.onSelectAllMatching).toHaveBeenCalledTimes(1);
    await user.click(pageBox());
    expect(handlers.onTogglePage).toHaveBeenCalledWith(false);
  });

  test("no helper when the page already holds everyone", () => {
    renderTable({ selectedIds: new Set(["1", "2", "3"]), total: 3 });
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("names the whole filtered set in select-all mode", () => {
    renderTable({
      selectedIds: new Set(["1", "2", "3"]),
      selectAllMode: true,
      total: 40,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Everyone matching the filter is selected (40).",
    );
    expect(screen.queryByRole("button", { name: /Select all/ })).toBeNull();
  });

  test("uses the singular for a one-person page", () => {
    renderTable({
      participants: [person(9)],
      selectedIds: new Set(["9"]),
      total: 5,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "All 1 person on this page are selected.",
    );
  });

  test("passes conflicts, selection and handlers down to rows", async () => {
    const user = userEvent.setup();
    const handlers = renderTable({
      selectedIds: new Set(["2"]),
      conflicts: { 2: { message: "Person 2 changed elsewhere." } },
    });
    const rows = screen.getAllByRole("row");
    expect(
      rows.find((row) => row.textContent.includes("changed elsewhere")),
    ).toHaveClass("participants-row__notice");
    expect(
      screen.getByRole("checkbox", { name: "Select Person 2" }),
    ).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Select Person 1" }));
    expect(handlers.onToggleSelect).toHaveBeenCalledWith("1", true);
    await user.click(screen.getByRole("button", { name: "Apply again" }));
    expect(handlers.onApplyAgain).toHaveBeenCalledWith(people[1]);
  });

  test("drops the selection column when not selectable", () => {
    renderTable({ selectable: false });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
  });

  test.each([
    ["with the selection column", {}],
    ["without the selection column", { selectable: false }],
  ])("every table part has an explicit role %s", (_label, props) => {
    renderTable({
      selectedIds: new Set(["1", "2", "3"]),
      total: 12,
      conflicts: { 2: { message: "Person 2 changed elsewhere." } },
      ...props,
    });
    const table = screen.getByRole("table");
    const parts = [
      table,
      ...table.querySelectorAll("thead, tbody, tr, th, td"),
    ];
    const expected = (part) =>
      ({
        TABLE: "table",
        THEAD: "rowgroup",
        TBODY: "rowgroup",
        TR: "row",
        TD: "cell",
      })[part.tagName] ??
      (part.closest("thead") ? "columnheader" : "rowheader");
    expect(
      parts
        .filter((part) => part.getAttribute("role") !== expected(part))
        .map((part) => part.outerHTML.slice(0, 60)),
    ).toEqual([]);
    expect(table.querySelectorAll("tbody th")).toHaveLength(3);
    expect(table.querySelectorAll(".participants-table__helper")).toHaveLength(
      1,
    );
    expect(table.querySelectorAll(".participants-row__notice")).toHaveLength(1);
  });

  test("disables page selection when read-only or empty", () => {
    const { unmount } = render(
      <ParticipantTable participants={people} readOnly />,
    );
    expect(pageBox()).toBeDisabled();
    unmount();
    render(<ParticipantTable participants={[]} />);
    expect(pageBox()).toBeDisabled();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
      1,
    );
  });
});
