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

import RosterGroups, {
  UNGROUPED,
  groupFilterValue,
  summarizeGroups,
} from "@/components/schedule/RosterGroups";

const groups = [
  { name: "Faculty", count: 2, weight: 1 },
  { name: "Students", count: 3, weight: null },
  { name: "", count: 1, weight: 0.5 },
];

function renderGroups(props = {}) {
  const handlers = {
    onShowGroup: jest.fn(),
    onSetWeight: jest.fn().mockResolvedValue(true),
    onRename: jest.fn().mockResolvedValue(true),
    onMoveSelected: jest.fn().mockResolvedValue(true),
    onCreate: jest.fn().mockResolvedValue(true),
  };
  const utils = render(
    <RosterGroups groups={groups} selectedCount={2} {...handlers} {...props} />,
  );
  // Overridden handlers win so a test can assert on the mock it passed in.
  return { ...utils, ...handlers, ...props };
}

function row(name) {
  return screen
    .getByRole("region", { name: "Roster groups" })
    .querySelector(`[data-roster-group="${groupFilterValue(name)}"]`);
}

describe("summarizeGroups", () => {
  test("normalizes every stats shape and sorts ungrouped people last", () => {
    expect(
      summarizeGroups([
        { name: "", count: 1, weight: 0.5 },
        { name: "Zeta", count: 2, weight: 1 },
        "Alpha",
        { name: "Mixed", count: 4, weight: null },
        null,
        7,
      ]),
    ).toEqual([
      { name: "Alpha", count: null, weight: null },
      { name: "Mixed", count: 4, weight: null },
      { name: "Zeta", count: 2, weight: 1 },
      { name: "", count: 1, weight: 0.5 },
    ]);
    expect(summarizeGroups({ Faculty: 1, Staff: { count: 2 } })).toEqual([
      { name: "Faculty", count: 1, weight: null },
      { name: "Staff", count: 2, weight: null },
    ]);
    expect(summarizeGroups(undefined)).toEqual([]);
    expect(groupFilterValue("")).toBe(UNGROUPED);
    expect(groupFilterValue("Faculty")).toBe("Faculty");
  });
});

describe("RosterGroups", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("lists every group with its head count and shared weight", () => {
    renderGroups();
    const table = screen.getByRole("region", { name: "Roster groups" });
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((entry) => entry.getAttribute("data-roster-group")),
    ).toEqual(["Faculty", "Students", UNGROUPED]);
    expect(row("Faculty")).toHaveTextContent("2 people");
    expect(row("")).toHaveTextContent("1 person");
    expect(row("")).toHaveTextContent("Ungrouped");
    expect(screen.getByLabelText("Weight for group Faculty")).toHaveValue(1);
    expect(screen.getByLabelText("Weight for ungrouped people")).toHaveValue(
      0.5,
    );
    // Members of Students carry different weights.
    const mixed = screen.getByLabelText("Weight for group Students");
    expect(mixed).toHaveValue(null);
    expect(mixed).toHaveAttribute("placeholder", "Mixed");
    expect(row("Students")).toHaveTextContent("Mixed");
    expect(screen.queryByText(/No groups yet/)).not.toBeInTheDocument();
  });

  test("commits a changed group weight on blur or Enter and ignores no-ops", async () => {
    const { onSetWeight } = renderGroups();
    const faculty = screen.getByLabelText("Weight for group Faculty");
    fireEvent.change(faculty, { target: { value: "0.5" } });
    fireEvent.blur(faculty);
    expect(onSetWeight).toHaveBeenCalledWith("Faculty", 0.5);

    // Unchanged, out-of-range, and blank drafts never reach the server.
    fireEvent.change(faculty, { target: { value: "1" } });
    fireEvent.blur(faculty);
    fireEvent.change(faculty, { target: { value: "2" } });
    fireEvent.blur(faculty);
    fireEvent.change(faculty, { target: { value: "" } });
    fireEvent.blur(faculty);
    fireEvent.blur(faculty);
    expect(onSetWeight).toHaveBeenCalledTimes(1);

    const students = screen.getByLabelText("Weight for group Students");
    fireEvent.change(students, { target: { value: "0.25" } });
    // A draft replaces the Mixed marker until it is committed.
    expect(row("Students")).not.toHaveTextContent("Mixed");
    fireEvent.keyDown(students, { key: "Enter" });
    fireEvent.blur(students);
    expect(onSetWeight).toHaveBeenLastCalledWith("Students", 0.25);
  });

  test("renames a group inline with validation and keyboard shortcuts", async () => {
    const { onRename } = renderGroups();
    await userEvent.click(
      within(row("Faculty")).getByRole("button", { name: "Rename" }),
    );
    const input = screen.getByLabelText("New name for group Faculty");
    expect(input).toHaveValue("Faculty");

    fireEvent.change(input, { target: { value: "   " } });
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a group name.");
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "x".repeat(101) } });
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "100 characters or fewer",
    );

    fireEvent.change(input, { target: { value: "Teachers" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("Faculty", "Teachers");
    await waitFor(() =>
      expect(
        screen.queryByLabelText("New name for group Faculty"),
      ).not.toBeInTheDocument(),
    );

    // Escape and Cancel close the editor; an unchanged name is a no-op.
    await userEvent.click(
      within(row("Students")).getByRole("button", { name: "Rename" }),
    );
    fireEvent.keyDown(screen.getByLabelText("New name for group Students"), {
      key: "Escape",
    });
    expect(
      screen.queryByLabelText("New name for group Students"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(row("Students")).getByRole("button", { name: "Rename" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(onRename).toHaveBeenCalledTimes(1);
    await userEvent.click(
      within(row("Students")).getByRole("button", { name: "Rename" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByLabelText("New name for group Students"),
    ).not.toBeInTheDocument();
    // Ungrouped is not a group and cannot be renamed.
    expect(
      within(row("")).queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();
  });

  test("keeps a failed rename open", async () => {
    const { onRename } = renderGroups({
      onRename: jest.fn().mockResolvedValue(false),
    });
    await userEvent.click(
      within(row("Faculty")).getByRole("button", { name: "Rename" }),
    );
    fireEvent.change(screen.getByLabelText("New name for group Faculty"), {
      target: { value: "Teachers" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(onRename).toHaveBeenCalledWith("Faculty", "Teachers");
    expect(
      screen.getByLabelText("New name for group Faculty"),
    ).toBeInTheDocument();
  });

  test("moves the selected people into a group or out of every group", async () => {
    const { onMoveSelected, rerender } = renderGroups();
    await userEvent.click(
      within(row("Students")).getByRole("button", {
        name: "Move selected here",
      }),
    );
    expect(onMoveSelected).toHaveBeenCalledWith("Students");
    await userEvent.click(
      within(row("")).getByRole("button", { name: "Ungroup selected" }),
    );
    expect(onMoveSelected).toHaveBeenCalledWith("");

    rerender(
      <RosterGroups
        groups={groups}
        selectedCount={0}
        onShowGroup={jest.fn()}
        onSetWeight={jest.fn()}
        onRename={jest.fn()}
        onMoveSelected={onMoveSelected}
        onCreate={jest.fn()}
      />,
    );
    const move = within(row("Faculty")).getByRole("button", {
      name: "Move selected here",
    });
    expect(move).toBeDisabled();
    expect(move).toHaveAttribute("title", "Select people in the list first");
  });

  test("creates a group from the selected people with validation", async () => {
    const { onCreate, rerender } = renderGroups({ selectedCount: 0 });
    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    const form = screen.getByRole("form", {
      name: "New group from the selected people",
    });
    expect(form).toHaveTextContent("Select people in the list first");
    await userEvent.click(
      within(form).getByRole("button", { name: "Create group" }),
    );
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Enter a group name.",
    );
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: "Board" },
    });
    await userEvent.click(
      within(form).getByRole("button", { name: "Create group" }),
    );
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Select the people to put in this group first.",
    );
    expect(onCreate).not.toHaveBeenCalled();

    rerender(
      <RosterGroups
        groups={groups}
        selectedCount={3}
        onShowGroup={jest.fn()}
        onSetWeight={jest.fn()}
        onRename={jest.fn()}
        onMoveSelected={jest.fn()}
        onCreate={onCreate}
      />,
    );
    expect(form).toHaveTextContent("3 selected in the list");
    fireEvent.change(screen.getByLabelText("New group weight"), {
      target: { value: "1.5" },
    });
    await userEvent.click(
      within(form).getByRole("button", { name: "Create group" }),
    );
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Weight must be between 0 and 1.",
    );
    fireEvent.change(screen.getByLabelText("New group weight"), {
      target: { value: "0.75" },
    });
    await userEvent.click(
      within(form).getByRole("button", { name: "Create group" }),
    );
    expect(onCreate).toHaveBeenCalledWith({ name: "Board", weight: 0.75 });
    await screen.findByRole("button", { name: "New group" });
    expect(
      screen.queryByRole("form", {
        name: "New group from the selected people",
      }),
    ).not.toBeInTheDocument();
  });

  test("keeps the new-group form open when creation fails, and cancels cleanly", async () => {
    renderGroups({ onCreate: jest.fn().mockResolvedValue(false) });
    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: "Board" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    expect(screen.getByLabelText("New group name")).toHaveValue("Board");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New group name")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    expect(screen.getByLabelText("New group name")).toHaveValue("");
    await userEvent.click(
      screen.getByRole("button", { name: "Close new group" }),
    );
    expect(screen.queryByLabelText("New group name")).not.toBeInTheDocument();
  });

  test("filters the roster to one group and back", async () => {
    const { onShowGroup, rerender } = renderGroups();
    await userEvent.click(
      within(row("Faculty")).getByRole("button", { name: "Show people" }),
    );
    expect(onShowGroup).toHaveBeenCalledWith("Faculty");
    await userEvent.click(
      within(row("")).getByRole("button", { name: "Show people" }),
    );
    expect(onShowGroup).toHaveBeenCalledWith(UNGROUPED);

    rerender(
      <RosterGroups
        groups={groups}
        selectedCount={0}
        activeGroup="Faculty"
        onShowGroup={onShowGroup}
        onSetWeight={jest.fn()}
        onRename={jest.fn()}
        onMoveSelected={jest.fn()}
        onCreate={jest.fn()}
      />,
    );
    expect(row("Faculty")).toHaveTextContent("Showing");
    const showEveryone = within(row("Faculty")).getByRole("button", {
      name: "Show everyone",
    });
    expect(showEveryone).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(showEveryone);
    expect(onShowGroup).toHaveBeenLastCalledWith("");
  });

  test("is read-only while the roster is locked and marks busy rows", () => {
    const { rerender } = renderGroups({ readOnly: true });
    expect(
      screen.queryByRole("button", { name: "New group" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Weight for group Faculty")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Move selected here" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();
    expect(
      within(row("Faculty")).getByRole("button", { name: "Show people" }),
    ).toBeEnabled();

    rerender(
      <RosterGroups
        groups={groups}
        selectedCount={1}
        busyGroup="Students"
        onShowGroup={jest.fn()}
        onSetWeight={jest.fn()}
        onRename={jest.fn()}
        onMoveSelected={jest.fn()}
        onCreate={jest.fn()}
      />,
    );
    expect(
      within(row("Students")).getByRole("button", {
        name: "Move selected here",
      }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "New group" })).toBeDisabled();
    expect(screen.getByLabelText("Weight for group Faculty")).toBeDisabled();
  });

  test("explains what to do when nobody is grouped yet", () => {
    const { rerender } = renderGroups({
      groups: [{ name: "", count: 4, weight: 1 }],
    });
    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
    expect(row("")).toHaveTextContent("4 people");
    rerender(
      <RosterGroups
        groups={[]}
        selectedCount={0}
        onShowGroup={jest.fn()}
        onSetWeight={jest.fn()}
        onRename={jest.fn()}
        onMoveSelected={jest.fn()}
        onCreate={jest.fn()}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Roster groups" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
  });
});
