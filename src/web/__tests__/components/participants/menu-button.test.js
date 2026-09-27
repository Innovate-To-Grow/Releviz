/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import MenuButton, {
  IconMenuButton,
} from "@/components/schedule/participants/MenuButton";

function items(overrides = {}) {
  return [
    { key: "one", label: "First", onSelect: jest.fn(), ...overrides.one },
    {
      key: "two",
      label: "Second",
      description: "More about it",
      onSelect: jest.fn(),
      ...overrides.two,
    },
    {
      key: "three",
      label: "Third",
      danger: true,
      onSelect: jest.fn(),
      ...overrides.three,
    },
  ];
}

const trigger = (name = "Open menu") => screen.getByRole("button", { name });

describe("MenuButton", () => {
  test("opens on click, lists visible items and closes after a choice", async () => {
    const user = userEvent.setup();
    const list = items({ two: { hidden: true } });
    render(
      <MenuButton
        label="Open menu"
        header={<span>Header line</span>}
        items={list}
      />,
    );

    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Header line")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "First" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Second/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Third" })).toHaveClass(
      "text-danger",
    );

    await user.click(screen.getByRole("menuitem", { name: "Third" }));
    expect(list[2].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  test("renders descriptions and disabled items", async () => {
    const user = userEvent.setup();
    const list = items({ one: { disabled: true } });
    render(<MenuButton label="Open menu" items={list} />);
    await user.click(trigger());
    expect(screen.getByRole("menuitem", { name: /Second/ })).toHaveTextContent(
      "More about it",
    );
    expect(screen.getByRole("menuitem", { name: "First" })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "First" }));
    expect(list[0].onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  test("ArrowDown and ArrowUp open the menu with the first or last item focused", () => {
    const { unmount } = render(
      <MenuButton label="Open menu" items={items()} />,
    );
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    // Pressing again while open just moves focus into the menu.
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Third" })).toHaveFocus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    unmount();

    render(<MenuButton label="Open menu" items={items()} />);
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Third" })).toHaveFocus();
  });

  test("arrows wrap, Home and End jump, and disabled items are skipped", () => {
    render(
      <MenuButton
        label="Open menu"
        items={items({ two: { disabled: true } })}
      />,
    );
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    const first = screen.getByRole("menuitem", { name: "First" });
    const third = screen.getByRole("menuitem", { name: "Third" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(third).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(third).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(third).toHaveFocus();
    fireEvent.keyDown(menu, { key: "a" });
    expect(third).toHaveFocus();
  });

  test("Escape and Tab close the menu and refocus the trigger", () => {
    render(<MenuButton label="Open menu" items={items()} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();

    // Escape while closed is left alone.
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("a pointer press outside closes the menu; one inside does not", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <MenuButton label="Open menu" items={items()} />
        <button type="button">Elsewhere</button>
      </div>,
    );
    await user.click(trigger());
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "First" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("keyboard navigation with no focusable items is a no-op", () => {
    render(
      <MenuButton
        label="Open menu"
        items={[{ key: "x", label: "Only", disabled: true }]}
      />,
    );
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger()).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(trigger()).toHaveFocus();
  });

  test("disabled and busy triggers cannot open", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MenuButton label="Open menu" items={items()} disabled />,
    );
    expect(trigger()).toBeDisabled();
    await user.click(trigger());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    rerender(<MenuButton label="Open menu" items={items()} busy />);
    expect(trigger()).toBeDisabled();
    expect(trigger()).toHaveAttribute("aria-busy", "true");
  });

  test("aligns to the start when asked and names the menu after the label", async () => {
    const user = userEvent.setup();
    render(
      <MenuButton
        label={<span>Node label</span>}
        ariaLabel="Named menu"
        align="start"
        items={items()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Named menu" }));
    const menu = screen.getByRole("menu", { name: "Named menu" });
    expect(menu).not.toHaveClass("dropdown-menu-end");
  });

  test("IconMenuButton renders the ⋯ glyph behind an accessible name", async () => {
    const user = userEvent.setup();
    const list = items();
    render(<IconMenuButton ariaLabel="Actions for Ada" items={list} />);
    const button = screen.getByRole("button", { name: "Actions for Ada" });
    expect(button).toHaveTextContent("⋯");
    await user.click(button);
    await user.click(screen.getByRole("menuitem", { name: "First" }));
    expect(list[0].onSelect).toHaveBeenCalled();
  });
});
