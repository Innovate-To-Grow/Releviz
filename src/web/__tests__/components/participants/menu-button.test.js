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

describe("MenuButton placement", () => {
  function mockTrigger(rect, menuHeight = 120) {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute("aria-haspopup") === "menu") {
        return {
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          ...rect,
        };
      }
      return originalRect.call(this);
    };
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.getAttribute("role") === "menu" ? menuHeight : 0;
      },
    });
    return () => {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalHeight)
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetHeight",
          originalHeight,
        );
      else delete HTMLElement.prototype.offsetHeight;
    };
  }

  afterEach(() => {
    window.innerHeight = 768;
    window.innerWidth = 1024;
  });

  test("fixes the menu below the trigger, aligned to its right edge", async () => {
    const user = userEvent.setup();
    window.innerHeight = 800;
    window.innerWidth = 1200;
    const restore = mockTrigger({
      top: 100,
      bottom: 130,
      left: 900,
      right: 960,
    });
    try {
      render(<MenuButton label="Open menu" items={items()} />);
      await user.click(trigger());
      const menu = screen.getByRole("menu");
      expect(menu).toHaveStyle({
        position: "fixed",
        top: "134px",
        right: "240px",
      });
      expect(menu.style.bottom).toBe("");
    } finally {
      restore();
    }
  });

  test("opens upward and aligns left when there is no room below", async () => {
    const user = userEvent.setup();
    window.innerHeight = 300;
    window.innerWidth = 500;
    const restore = mockTrigger({ top: 250, bottom: 280, left: 20, right: 60 });
    try {
      render(<MenuButton label="Open menu" align="start" items={items()} />);
      await user.click(trigger());
      const menu = screen.getByRole("menu");
      expect(menu).toHaveStyle({
        position: "fixed",
        bottom: "54px",
        left: "20px",
      });
      expect(menu.style.top).toBe("");
    } finally {
      restore();
    }
  });

  test("follows the trigger on scroll and resize while open", async () => {
    const user = userEvent.setup();
    window.innerHeight = 800;
    window.innerWidth = 1200;
    const rect = { top: 100, bottom: 130, left: 900, right: 960 };
    const restore = mockTrigger(rect);
    try {
      render(<MenuButton label="Open menu" items={items()} />);
      await user.click(trigger());
      rect.top = 40;
      rect.bottom = 70;
      fireEvent.scroll(window);
      expect(screen.getByRole("menu")).toHaveStyle({ top: "74px" });
      window.innerWidth = 1000;
      fireEvent(window, new Event("resize"));
      expect(screen.getByRole("menu")).toHaveStyle({ right: "40px" });
      await user.click(trigger());
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });
});
