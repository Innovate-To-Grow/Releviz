/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import GroupFilterButton from "@/components/schedule/participants/GroupFilterButton";
import { UNGROUPED } from "@/lib/participants";

const groups = [
  { id: 1, name: "Design", count: 4 },
  { id: 2, name: "Engineering", count: 6 },
];

function renderButton(props = {}) {
  const handlers = {
    onChange: jest.fn(),
    onNewGroup: jest.fn(),
    onManageGroups: jest.fn(),
  };
  render(
    <GroupFilterButton
      groups={groups}
      everyoneCount={12}
      noGroupCount={2}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("GroupFilterButton", () => {
  test("lists everyone, each group and the ungrouped bucket with counts", async () => {
    const user = userEvent.setup();
    const handlers = renderButton();
    const trigger = screen.getByRole("button", { name: "Group: Everyone" });
    await user.click(trigger);
    expect(screen.getByRole("group", { name: "Show" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.nextSibling.textContent)).toEqual([
      "Everyone",
      "Design",
      "Engineering",
      "No group",
    ]);
    expect(screen.getByRole("radio", { name: "Everyone" })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Design" }),
    ).toHaveAccessibleDescription("4");
    await user.click(screen.getByRole("radio", { name: "Design" }));
    expect(handlers.onChange).toHaveBeenCalledWith("Design");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  test("names the current group and does not re-emit the same value", async () => {
    const user = userEvent.setup();
    const handlers = renderButton({ value: "Design" });
    await user.click(screen.getByRole("button", { name: "Group: Design" }));
    expect(screen.getByRole("radio", { name: "Design" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Design" }));
    expect(handlers.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  test("shows No group only when someone is ungrouped or it is selected", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <GroupFilterButton
        groups={groups}
        noGroupCount={0}
        onChange={jest.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Group: Everyone" }));
    expect(screen.queryByRole("radio", { name: "No group" })).toBeNull();
    unmount();

    const onChange = jest.fn();
    render(
      <GroupFilterButton
        groups={groups}
        noGroupCount={0}
        value={UNGROUPED}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Group: No group" }));
    expect(screen.getByRole("radio", { name: "No group" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Everyone" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  test("footer links create a group or open the groups panel", async () => {
    const user = userEvent.setup();
    const handlers = renderButton();
    await user.click(screen.getByRole("button", { name: "Group: Everyone" }));
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    expect(handlers.onNewGroup).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("radio")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Group: Everyone" }));
    await user.click(screen.getByRole("button", { name: "Manage groups…" }));
    expect(handlers.onManageGroups).toHaveBeenCalledTimes(1);
  });

  test("works without the optional footer handlers and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<GroupFilterButton onChange={jest.fn()} />);
    const trigger = screen.getByRole("button", { name: "Group: Everyone" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Manage groups…" }));
    await user.click(trigger);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Everyone" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("radio")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  test("can be disabled", () => {
    renderButton({ disabled: true });
    expect(
      screen.getByRole("button", { name: "Group: Everyone" }),
    ).toBeDisabled();
  });
});
