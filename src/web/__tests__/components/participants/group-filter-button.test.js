/**
 * @jest-environment jsdom
 */

import { useState } from "react";
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

function Controlled({ onChange, ...props }) {
  const [value, setValue] = useState("");
  return (
    <GroupFilterButton
      groups={groups}
      everyoneCount={12}
      noGroupCount={2}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      {...props}
    />
  );
}

// Browsers move the check with the arrow keys by clicking the next radio
// while the key is still down; jsdom leaves that sequence to the test.
function arrowTo(from, to) {
  fireEvent.keyDown(from, { key: "ArrowDown" });
  fireEvent.click(to);
  fireEvent.keyUp(to, { key: "ArrowDown" });
}

describe("GroupFilterButton", () => {
  test("arrow keys apply each option without closing; Enter or a click closes", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Controlled onChange={onChange} />);
    const radio = (name) => screen.getByRole("radio", { name });
    const list = () => screen.queryByRole("group", { name: "Show" });
    await user.click(screen.getByRole("button", { name: "Group: Everyone" }));

    arrowTo(radio("Everyone"), radio("Design"));
    expect(onChange).toHaveBeenLastCalledWith("Design");
    expect(radio("Design")).toBeChecked();
    expect(list()).toBeInTheDocument();

    arrowTo(radio("Design"), radio("Engineering"));
    expect(onChange).toHaveBeenLastCalledWith("Engineering");
    expect(list()).toBeInTheDocument();

    fireEvent.keyDown(radio("Engineering"), { key: "Enter" });
    expect(list()).toBeNull();
    const trigger = screen.getByRole("button", { name: "Group: Engineering" });
    expect(trigger).toHaveFocus();
    expect(onChange).toHaveBeenCalledTimes(2);

    await user.click(trigger);
    await user.click(radio("No group"));
    expect(onChange).toHaveBeenLastCalledWith(UNGROUPED);
    expect(list()).toBeNull();
  });

  test("Enter picks the focused option and closes", async () => {
    const user = userEvent.setup();
    const handlers = renderButton();
    const trigger = screen.getByRole("button", { name: "Group: Everyone" });
    await user.click(trigger);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Design" }), {
      key: "Enter",
    });
    expect(handlers.onChange).toHaveBeenCalledWith("Design");
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  test("an arrow key that lands on the only option keeps the popover open", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<GroupFilterButton onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Group: Everyone" }));
    const only = screen.getByRole("radio", { name: "Everyone" });
    arrowTo(only, only);
    expect(screen.getByRole("group", { name: "Show" })).toBeInTheDocument();
    await user.click(only);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

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
