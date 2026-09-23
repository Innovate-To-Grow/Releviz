/**
 * @jest-environment jsdom
 */

import {
  act,
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

// Await the full user interaction and the async handler updates before
// checking the resulting group state.
const click = (element) =>
  act(async () => {
    await userEvent.click(element);
  });
const pressEnter = (element) =>
  act(async () => {
    fireEvent.keyDown(element, { key: "Enter" });
  });

// Alumni is a real group with nobody in it yet; Students members carry
// different weights; the trailing entry is the ungrouped row.
const groups = [
  { id: 3, name: "Alumni", count: 0, weight: null },
  { id: 1, name: "Faculty", count: 2, weight: 1 },
  { id: 2, name: "Students", count: 3, weight: null },
  { id: null, name: "", count: 1, weight: 0.5 },
];

function makeHandlers() {
  return {
    onShowGroup: jest.fn(),
    onSetWeight: jest.fn().mockResolvedValue(true),
    onRename: jest.fn().mockResolvedValue(true),
    onDelete: jest.fn().mockResolvedValue(true),
    onAddSelected: jest.fn().mockResolvedValue(true),
    onRemoveSelected: jest.fn().mockResolvedValue(true),
    onMoveSelected: jest.fn().mockResolvedValue(true),
    onCreate: jest.fn().mockResolvedValue(true),
  };
}

function renderGroups(props = {}) {
  // Overridden handlers win so a test can assert on the mock it passed in;
  // `handlers` carries only the callbacks, so a rerender can spread it and
  // then set whatever other props it needs.
  const handlers = makeHandlers();
  const rest = {};
  for (const [key, value] of Object.entries(props)) {
    if (key in handlers) handlers[key] = value;
    else rest[key] = value;
  }
  const utils = render(
    <RosterGroups groups={groups} selectedCount={2} {...rest} {...handlers} />,
  );
  return { ...utils, ...handlers, handlers };
}

function row(name) {
  return screen
    .getByRole("region", { name: "Roster groups" })
    .querySelector(`[data-roster-group="${groupFilterValue(name)}"]`);
}

function buttonNames(element) {
  return within(element)
    .getAllByRole("button")
    .map((button) => button.textContent);
}

describe("summarizeGroups", () => {
  test("normalizes every stats shape, keeps ids, and sorts ungrouped people last", () => {
    expect(
      summarizeGroups([
        { name: "", count: 1, weight: 0.5 },
        { id: 2, name: "Zeta", count: 2, weight: 1 },
        "Alpha",
        { id: 3, name: "Mixed", count: 4, weight: null },
        { id: 5, name: "Empty", count: 0, weight: null },
        null,
        7,
        { id: 9, count: "2" },
      ]),
    ).toEqual([
      { id: null, name: "Alpha", count: null, weight: null },
      { id: 5, name: "Empty", count: 0, weight: null },
      { id: 3, name: "Mixed", count: 4, weight: null },
      { id: 2, name: "Zeta", count: 2, weight: 1 },
      { id: null, name: "", count: 1, weight: 0.5 },
      { id: 9, name: "", count: 2, weight: null },
    ]);
    expect(
      summarizeGroups({ Faculty: 1, Staff: { count: 2 }, Guests: null }),
    ).toEqual([
      { id: null, name: "Faculty", count: 1, weight: null },
      { id: null, name: "Guests", count: null, weight: null },
      { id: null, name: "Staff", count: 2, weight: null },
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
    expect(
      screen.getByText(
        "People can belong to several groups. Setting a group's weight applies it to everyone currently in that group, including people who are also in other groups.",
      ),
    ).toBeInTheDocument();
    const table = screen.getByRole("region", { name: "Roster groups" });
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((entry) => entry.getAttribute("data-roster-group")),
    ).toEqual(["Alumni", "Faculty", "Students", UNGROUPED]);
    expect(row("Alumni")).toHaveTextContent("0 people");
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
    expect(mixed).toBeEnabled();
    expect(mixed).toHaveAttribute("placeholder", "Mixed");
    expect(row("Students")).toHaveTextContent("Mixed");
    // An empty group has no weight to share and nothing to edit.
    const empty = screen.getByLabelText("Weight for group Alumni");
    expect(empty).toBeDisabled();
    expect(empty).toHaveValue(null);
    expect(empty).toHaveAttribute("placeholder", "");
    expect(row("Alumni")).not.toHaveTextContent("Mixed");
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
    fireEvent.change(faculty, { target: { value: "-1" } });
    fireEvent.blur(faculty);
    fireEvent.change(faculty, { target: { value: "1e400" } });
    fireEvent.blur(faculty);
    fireEvent.change(faculty, { target: { value: "" } });
    fireEvent.blur(faculty);
    fireEvent.blur(faculty);
    expect(onSetWeight).toHaveBeenCalledTimes(1);

    const students = screen.getByLabelText("Weight for group Students");
    fireEvent.change(students, { target: { value: "0.25" } });
    // A draft replaces the Mixed marker until it is committed.
    expect(row("Students")).not.toHaveTextContent("Mixed");
    // Other keys leave the draft alone; Enter commits it.
    fireEvent.keyDown(students, { key: "a" });
    expect(onSetWeight).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(students, { key: "Enter" });
    fireEvent.blur(students);
    expect(onSetWeight).toHaveBeenLastCalledWith("Students", 0.25);
  });

  test("renames a group inline with validation and keyboard shortcuts", async () => {
    const { onRename } = renderGroups();
    await click(within(row("Faculty")).getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New name for group Faculty");
    expect(input).toHaveValue("Faculty");
    expect(
      within(row("Faculty")).queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "   " } });
    await click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a group name.");
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "x".repeat(101) } });
    await click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "100 characters or fewer",
    );

    fireEvent.change(input, { target: { value: "Teachers; Staff" } });
    await click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Group names cannot contain ;.",
    );

    fireEvent.change(input, { target: { value: " all " } });
    await click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "ALL is reserved for every group.",
    );
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Teachers" } });
    fireEvent.keyDown(input, { key: "a" });
    expect(onRename).not.toHaveBeenCalled();
    await pressEnter(input);
    // The summarized group (with its id) goes back to the parent.
    expect(onRename).toHaveBeenCalledWith(
      { id: 1, name: "Faculty", count: 2, weight: 1 },
      "Teachers",
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("New name for group Faculty"),
      ).not.toBeInTheDocument(),
    );

    // Escape and Cancel close the editor; an identical name is a no-op.
    await click(
      within(row("Students")).getByRole("button", { name: "Rename" }),
    );
    fireEvent.keyDown(screen.getByLabelText("New name for group Students"), {
      key: "Escape",
    });
    expect(
      screen.queryByLabelText("New name for group Students"),
    ).not.toBeInTheDocument();
    await click(
      within(row("Students")).getByRole("button", { name: "Rename" }),
    );
    await click(screen.getByRole("button", { name: "Save name" }));
    expect(onRename).toHaveBeenCalledTimes(1);
    await click(
      within(row("Students")).getByRole("button", { name: "Rename" }),
    );
    await click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByLabelText("New name for group Students"),
    ).not.toBeInTheDocument();

    // A case-only rename is a real change, not a no-op.
    await click(
      within(row("Students")).getByRole("button", { name: "Rename" }),
    );
    fireEvent.change(screen.getByLabelText("New name for group Students"), {
      target: { value: "students" },
    });
    await click(screen.getByRole("button", { name: "Save name" }));
    expect(onRename).toHaveBeenLastCalledWith(
      { id: 2, name: "Students", count: 3, weight: null },
      "students",
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("New name for group Students"),
      ).not.toBeInTheDocument(),
    );
    // Ungrouped is not a group and cannot be renamed.
    expect(
      within(row("")).queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();
  });

  test("keeps a failed rename open", async () => {
    const { onRename } = renderGroups({
      onRename: jest.fn().mockResolvedValue(false),
    });
    await click(within(row("Faculty")).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name for group Faculty"), {
      target: { value: "Teachers" },
    });
    await click(screen.getByRole("button", { name: "Save name" }));
    expect(onRename).toHaveBeenCalledWith(groups[1], "Teachers");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save name" }),
      ).not.toHaveAttribute("aria-busy"),
    );
    expect(
      screen.getByLabelText("New name for group Faculty"),
    ).toBeInTheDocument();
  });

  test("adds or removes the selected people from a group, or ungroups them", async () => {
    const { onAddSelected, onRemoveSelected, onMoveSelected } = renderGroups();
    expect(buttonNames(row("Students"))).toEqual([
      "Add selected",
      "Remove selected",
      "Rename",
      "Delete group",
      "Show people",
    ]);
    // The ungrouped row is not a group: it can only be emptied or shown.
    expect(buttonNames(row(""))).toEqual(["Ungroup selected", "Show people"]);
    expect(
      screen.queryByRole("button", { name: "Move selected here" }),
    ).not.toBeInTheDocument();

    await click(
      within(row("Students")).getByRole("button", { name: "Add selected" }),
    );
    expect(onAddSelected).toHaveBeenCalledWith("Students");
    await click(
      within(row("Students")).getByRole("button", {
        name: "Remove selected",
      }),
    );
    expect(onRemoveSelected).toHaveBeenCalledWith("Students");
    await click(
      within(row("")).getByRole("button", { name: "Ungroup selected" }),
    );
    expect(onMoveSelected).toHaveBeenCalledWith("");
    await waitFor(() =>
      expect(
        within(row("")).getByRole("button", { name: "Ungroup selected" }),
      ).not.toHaveAttribute("aria-busy"),
    );
  });

  test("disables selection actions when nobody is selected", () => {
    renderGroups({ selectedCount: 0 });
    expect(
      within(row("Faculty")).getByRole("button", { name: "Add selected" }),
    ).toBeDisabled();
    expect(
      within(row("Faculty")).getByRole("button", { name: "Remove selected" }),
    ).toBeDisabled();
    expect(
      within(row("")).getByRole("button", { name: "Ungroup selected" }),
    ).toBeDisabled();
    // Rename, delete, and show never need a selection.
    expect(
      within(row("Faculty")).getByRole("button", { name: "Rename" }),
    ).toBeEnabled();
    expect(
      within(row("Faculty")).getByRole("button", { name: "Delete group" }),
    ).toBeEnabled();
    expect(
      within(row("Faculty")).getByRole("button", { name: "Show people" }),
    ).toBeEnabled();
  });

  test("deletes a group only after the organizer confirms", async () => {
    const { onDelete } = renderGroups();
    const remove = within(row("Faculty")).getByRole("button", {
      name: "Delete group",
    });
    const confirmDialog = () =>
      screen.getByRole("alertdialog", { name: "Delete group Faculty?" });

    // Cancel is the safe default: it has focus, sends nothing, and hands
    // focus back to the row's button.
    await click(remove);
    expect(confirmDialog()).toHaveAccessibleDescription(
      "People stay on the roster.",
    );
    const cancel = within(confirmDialog()).getByRole("button", {
      name: "Cancel",
    });
    expect(cancel).toHaveFocus();
    await click(cancel);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    expect(remove).toHaveFocus();

    // Escape cancels too.
    await click(remove);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    await click(remove);
    await click(
      within(confirmDialog()).getByRole("button", { name: "Delete group" }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith({
      id: 1,
      name: "Faculty",
      count: 2,
      weight: 1,
    });
    await waitFor(() => expect(remove).not.toHaveAttribute("aria-busy"));
    // The deleted row's button goes away, so focus lands on the heading.
    expect(screen.getByRole("heading", { name: "Groups" })).toHaveFocus();
  });

  test("keeps focus on the row when a confirmed delete fails", async () => {
    const { onDelete } = renderGroups({
      onDelete: jest.fn().mockResolvedValue(false),
    });
    const remove = within(row("Faculty")).getByRole("button", {
      name: "Delete group",
    });
    await click(remove);
    await click(
      within(
        screen.getByRole("alertdialog", { name: "Delete group Faculty?" }),
      ).getByRole("button", { name: "Delete group" }),
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(remove).not.toHaveAttribute("aria-busy"));
    expect(remove).toHaveFocus();
  });

  test("drops an open delete confirmation when the roster locks", async () => {
    const { handlers, onDelete, rerender } = renderGroups();
    await click(
      within(row("Faculty")).getByRole("button", { name: "Delete group" }),
    );
    expect(
      screen.getByRole("alertdialog", { name: "Delete group Faculty?" }),
    ).toBeInTheDocument();
    rerender(
      <RosterGroups {...handlers} groups={groups} selectedCount={2} readOnly />,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Reactivating later must not bring the old question back.
    rerender(<RosterGroups {...handlers} groups={groups} selectedCount={2} />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  test("drops an open delete confirmation when the group changes underneath it", async () => {
    const { handlers, onDelete, rerender } = renderGroups();
    await click(
      within(row("Faculty")).getByRole("button", { name: "Delete group" }),
    );
    // Another session renames Faculty; the question named the old group.
    const renamed = groups.map((group) =>
      group.id === 1 ? { ...group, name: "Staff" } : group,
    );
    rerender(<RosterGroups {...handlers} groups={renamed} selectedCount={2} />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await click(
      within(row("Students")).getByRole("button", { name: "Delete group" }),
    );
    rerender(
      <RosterGroups
        {...handlers}
        groups={renamed.filter((group) => group.id !== 2)}
        selectedCount={2}
      />,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  test("returns focus to the row once a failed delete leaves the roster idle", async () => {
    // The roster disables every group button while the request runs, which
    // drops focus in a real browser; the row must get it back afterwards.
    let rejectDelete;
    const { handlers, rerender } = renderGroups({
      onDelete: jest.fn(
        () =>
          new Promise((resolve) => {
            rejectDelete = () => resolve(false);
          }),
      ),
    });
    const remove = within(row("Faculty")).getByRole("button", {
      name: "Delete group",
    });
    await click(remove);
    await click(
      within(
        screen.getByRole("alertdialog", { name: "Delete group Faculty?" }),
      ).getByRole("button", { name: "Delete group" }),
    );
    // Browsers drop focus from a button once it is disabled; jsdom cannot
    // blur a disabled element, so drop it just before the roster disables it.
    act(() => remove.blur());
    rerender(
      <RosterGroups
        {...handlers}
        groups={groups}
        selectedCount={2}
        busyGroup="Faculty"
      />,
    );
    expect(remove).toBeDisabled();
    await act(async () => rejectDelete());
    expect(remove).not.toHaveFocus();

    rerender(<RosterGroups {...handlers} groups={groups} selectedCount={2} />);
    expect(remove).toBeEnabled();
    expect(remove).toHaveFocus();
  });

  test("creates an empty group with validation", async () => {
    // No selection is needed (and `selectedCount` may be left out entirely).
    const handlers = makeHandlers();
    render(<RosterGroups groups={groups} {...handlers} />);
    const { onCreate } = handlers;
    await click(screen.getByRole("button", { name: "New group" }));
    const form = screen.getByRole("form", { name: "Create a group" });
    expect(form).not.toHaveTextContent("Select people in the list first");
    expect(screen.queryByLabelText("New group weight")).not.toBeInTheDocument();
    const create = within(form).getByRole("button", { name: "Create group" });

    await click(create);
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Enter a group name.",
    );
    const input = screen.getByLabelText("New group name");
    fireEvent.change(input, { target: { value: "y".repeat(101) } });
    await click(create);
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Group names must be 100 characters or fewer.",
    );
    fireEvent.change(input, { target: { value: "Board; Staff" } });
    await click(create);
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Group names cannot contain ;.",
    );
    fireEvent.change(input, { target: { value: "ALL" } });
    await click(create);
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "ALL is reserved for every group.",
    );
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "  Board  " } });
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
    await click(create);
    expect(onCreate).toHaveBeenCalledWith({ name: "Board" });
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "Create a group" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "New group" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("keeps the new-group form open when creation fails, and cancels cleanly", async () => {
    renderGroups({ onCreate: jest.fn().mockResolvedValue(false) });
    await click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: "Board" },
    });
    await click(screen.getByRole("button", { name: "Create group" }));
    expect(screen.getByLabelText("New group name")).toHaveValue("Board");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create group" }),
      ).not.toHaveAttribute("aria-busy"),
    );
    await click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New group name")).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: "New group" }));
    expect(screen.getByLabelText("New group name")).toHaveValue("");
    await click(screen.getByRole("button", { name: "Close new group" }));
    expect(screen.queryByLabelText("New group name")).not.toBeInTheDocument();
  });

  test("filters the roster to one group and back", async () => {
    const { onShowGroup, handlers, rerender } = renderGroups();
    await click(
      within(row("Faculty")).getByRole("button", { name: "Show people" }),
    );
    expect(onShowGroup).toHaveBeenCalledWith("Faculty");
    await click(within(row("")).getByRole("button", { name: "Show people" }));
    expect(onShowGroup).toHaveBeenCalledWith(UNGROUPED);

    rerender(
      <RosterGroups
        groups={groups}
        selectedCount={0}
        activeGroup="Faculty"
        {...handlers}
      />,
    );
    expect(row("Faculty")).toHaveTextContent("Showing");
    const showEveryone = within(row("Faculty")).getByRole("button", {
      name: "Show everyone",
    });
    expect(showEveryone).toHaveAttribute("aria-pressed", "true");
    await click(showEveryone);
    expect(onShowGroup).toHaveBeenLastCalledWith("");
  });

  test("hides the create form when the roster locks mid-edit", async () => {
    const { handlers, rerender } = renderGroups();
    await click(screen.getByRole("button", { name: "New group" }));
    expect(screen.getByRole("form", { name: "Create a group" })).toBeVisible();
    rerender(
      <RosterGroups {...handlers} groups={groups} selectedCount={2} readOnly />,
    );
    expect(
      screen.queryByRole("form", { name: "Create a group" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close new group" }),
    ).not.toBeInTheDocument();
  });

  test("is read-only while the roster is locked and marks the busy action", async () => {
    const { handlers, rerender } = renderGroups({ readOnly: true });
    expect(
      screen.queryByRole("button", { name: "New group" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Weight for group Faculty")).toBeDisabled();
    for (const name of [
      "Add selected",
      "Remove selected",
      "Ungroup selected",
      "Rename",
      "Delete group",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(
      within(row("Faculty")).getByRole("button", { name: "Show people" }),
    ).toBeEnabled();

    let finishAdd;
    const onAddSelected = jest.fn(
      () =>
        new Promise((resolve) => {
          finishAdd = resolve;
        }),
    );
    rerender(
      <RosterGroups
        groups={groups}
        selectedCount={1}
        {...handlers}
        onAddSelected={onAddSelected}
      />,
    );
    const add = within(row("Students")).getByRole("button", {
      name: "Add selected",
    });
    await click(add);
    // Only the clicked button spins; the parent's busyGroup disables the rest.
    expect(add).toHaveAttribute("aria-busy", "true");
    expect(
      within(row("Students")).getByRole("button", { name: "Remove selected" }),
    ).not.toHaveAttribute("aria-busy");
    rerender(
      <RosterGroups
        groups={groups}
        selectedCount={1}
        busyGroup="Students"
        {...handlers}
        onAddSelected={onAddSelected}
      />,
    );
    expect(screen.getByRole("button", { name: "New group" })).toBeDisabled();
    expect(screen.getByLabelText("Weight for group Faculty")).toBeDisabled();
    expect(
      within(row("Faculty")).getByRole("button", { name: "Delete group" }),
    ).toBeDisabled();
    expect(
      within(row("Faculty")).getByRole("button", { name: "Show people" }),
    ).toBeEnabled();
    finishAdd(true);
    await waitFor(() => expect(add).not.toHaveAttribute("aria-busy"));
  });

  test("explains what to do when there are no groups yet", () => {
    const { handlers, rerender } = renderGroups({
      groups: [{ id: null, name: "", count: null, weight: 1 }],
    });
    expect(
      screen.getByText(
        "No groups yet. Create a group, then select people in the list and add them to it.",
      ),
    ).toBeInTheDocument();
    // An unknown head count renders as nothing rather than "null people".
    expect(row("").querySelector(".roster-groups__count")).toHaveTextContent(
      "",
    );
    rerender(<RosterGroups groups={[]} selectedCount={0} {...handlers} />);
    expect(
      screen.queryByRole("region", { name: "Roster groups" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
  });
});
