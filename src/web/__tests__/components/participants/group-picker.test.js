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

import GroupPicker from "@/components/schedule/participants/GroupPicker";

const groups = [
  { id: 1, name: "Design" },
  { id: 2, name: "Engineering" },
  { id: 3, name: "Sales" },
];

function renderPicker(props = {}) {
  const handlers = {
    onApply: jest.fn(),
    onClose: jest.fn(),
    onCreateGroup: jest.fn(),
    ...props,
  };
  render(
    <GroupPicker
      title="Groups for Ada"
      groups={groups}
      state={{ allGroups: "none", byGroup: { 1: "all", 2: "mixed" } }}
      {...handlers}
    />,
  );
  return handlers;
}

const box = (name) => screen.getByRole("checkbox", { name });
const apply = () => screen.getByRole("button", { name: "Apply" });
const every = () => box("Every group, including groups added later");

describe("GroupPicker", () => {
  test("shows each group's state and applies only the changes", async () => {
    const user = userEvent.setup();
    const handlers = renderPicker();
    expect(
      screen.getByRole("dialog", { name: "Groups for Ada" }),
    ).toBeInTheDocument();
    expect(box("Design")).toBeChecked();
    expect(box("Engineering")).not.toBeChecked();
    expect(box("Engineering").indeterminate).toBe(true);
    expect(box("Sales")).not.toBeChecked();
    expect(apply()).toBeDisabled();

    await user.click(box("Sales"));
    await user.click(box("Design"));
    expect(apply()).toBeEnabled();
    await user.click(apply());
    expect(handlers.onApply).toHaveBeenCalledWith({
      addGroupIds: [3],
      removeGroupIds: [1],
    });
  });

  test("a mixed box cycles mixed → all → none → mixed", async () => {
    const user = userEvent.setup();
    const handlers = renderPicker();
    const mixed = box("Engineering");
    await user.click(mixed);
    expect(mixed).toBeChecked();
    expect(mixed.indeterminate).toBe(false);
    await user.click(mixed);
    expect(mixed).not.toBeChecked();
    expect(mixed.indeterminate).toBe(false);
    await user.click(apply());
    expect(handlers.onApply).toHaveBeenCalledWith({ removeGroupIds: [2] });
    await user.click(mixed);
    expect(mixed.indeterminate).toBe(true);
    expect(apply()).toBeDisabled();
  });

  test("Every group disables the per-group boxes and is sent when changed", async () => {
    const user = userEvent.setup();
    const handlers = renderPicker();
    await user.click(every());
    expect(every()).toBeChecked();
    expect(box("Design")).toBeDisabled();
    await user.click(apply());
    expect(handlers.onApply).toHaveBeenCalledWith({ allGroups: true });
  });

  test("a mixed Every group box follows the same cycle", async () => {
    const user = userEvent.setup();
    const handlers = renderPicker({
      state: { allGroups: "mixed", byGroup: { 1: "mixed" } },
      counts: { total: 5, allGroups: 2, byGroup: { 1: 3 } },
    });
    expect(every().indeterminate).toBe(true);
    expect(every()).toHaveAccessibleDescription("2 of 5");
    expect(box("Design")).toHaveAccessibleDescription("3 of 5");
    expect(box("Sales")).toHaveAccessibleDescription("0 of 5");
    await user.click(every());
    expect(every()).toHaveAccessibleDescription("5 of 5");
    await user.click(every());
    expect(every()).toHaveAccessibleDescription("0 of 5");
    await user.click(apply());
    expect(handlers.onApply).toHaveBeenCalledWith({ allGroups: false });
    await user.click(every());
    expect(every().indeterminate).toBe(true);
    expect(apply()).toBeDisabled();
  });

  test("creates a group inline and ticks it", async () => {
    const user = userEvent.setup();
    const handlers = renderPicker({
      onCreateGroup: jest.fn().mockResolvedValue({ id: 9, name: "Ops" }),
    });
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    const input = screen.getByRole("textbox", { name: "New group name" });
    expect(input).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a group name.");
    expect(handlers.onCreateGroup).not.toHaveBeenCalled();

    await user.type(input, "Ops");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(box("Ops")).toBeChecked());
    expect(handlers.onCreateGroup).toHaveBeenCalledWith("Ops");
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(apply());
    expect(handlers.onApply).toHaveBeenCalledWith({ addGroupIds: [9] });
  });

  test("reports a failed create and lets the form be cancelled", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker({
      onCreateGroup: jest.fn().mockRejectedValue(new Error("Name taken.")),
    });
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    await user.type(screen.getByRole("textbox"), "Design");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Name taken.");

    await user.click(
      within(screen.getByRole("textbox").closest("form")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "+ New group" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("falls back to a generic create error message", async () => {
    const user = userEvent.setup();
    renderPicker({ onCreateGroup: jest.fn().mockRejectedValue({}) });
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    await user.type(screen.getByRole("textbox"), "Ops");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The group could not be created.",
    );
  });

  test("handles no groups, no state and busy", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker({
      groups: [],
      state: undefined,
      busy: true,
    });
    expect(screen.getByText("No groups yet.")).toBeInTheDocument();
    expect(every()).toBeDisabled();
    expect(apply()).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ New group" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  test("Cancel closes the picker", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
