/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import Drawer from "@/components/schedule/participants/Drawer";

function renderDrawer(props = {}, children = null) {
  const onClose = jest.fn();
  const utils = render(
    <Drawer title="Panel" onClose={onClose} {...props}>
      {children ?? (
        <>
          <input aria-label="First field" />
          <button type="button">Middle</button>
        </>
      )}
    </Drawer>,
  );
  return { onClose, ...utils };
}

const closeButton = () =>
  screen.getAllByRole("button", { name: "Close" }).at(-1);
const tab = (target, shiftKey = false) =>
  fireEvent.keyDown(target, { key: "Tab", shiftKey });

describe("Drawer", () => {
  test("renders the header pieces, footer and children, focusing the close button", () => {
    renderDrawer({
      eyebrow: <span>1 of 3</span>,
      subtitle: "A short line.",
      headerActions: <button type="button">Extra</button>,
      footer: <button type="button">Done</button>,
    });
    const dialog = screen.getByRole("dialog", { name: "Panel" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass("app-drawer--narrow");
    expect(dialog).toHaveTextContent("1 of 3");
    expect(dialog).toHaveTextContent("A short line.");
    expect(screen.getByRole("button", { name: "Extra" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(closeButton()).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("prefers a data-autofocus element for initial focus", () => {
    renderDrawer({}, <input aria-label="Name" data-autofocus />);
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  test("Tab wraps from the last control to the first and Shift+Tab back", () => {
    renderDrawer({ footer: <button type="button">Done</button> });
    const done = screen.getByRole("button", { name: "Done" });
    const first = closeButton();

    done.focus();
    tab(done);
    expect(first).toHaveFocus();

    tab(first, true);
    expect(done).toHaveFocus();

    // In the middle the browser's own order is left alone.
    const middle = screen.getByRole("button", { name: "Middle" });
    middle.focus();
    const event = tab(middle);
    expect(event).toBe(true);
    expect(middle).toHaveFocus();
  });

  test("with nothing focusable, Tab is left alone", () => {
    renderDrawer({ busy: true }, <p>Just text</p>);
    expect(closeButton()).toBeDisabled();
    expect(tab(document.body)).toBe(true);
  });

  test("Escape closes unless busy or a nested dialog is open", () => {
    const { onClose, rerender } = renderDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Drawer title="Panel" onClose={onClose} busy>
        <input aria-label="First field" />
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Drawer title="Panel" onClose={onClose} dialogOpen>
        <input aria-label="First field" />
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    closeButton().focus();
    tab(closeButton(), true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(closeButton()).toHaveFocus();
    fireEvent.keyDown(document, { key: "a" });
  });

  test("leaves an Escape a control inside already handled to that control", () => {
    const { onClose } = renderDrawer(
      {},
      <input
        aria-label="Inline name"
        onKeyDown={(event) => {
          if (event.key === "Escape") event.preventDefault();
        }}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("Inline name"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the backdrop and the x close the drawer, and focus goes back on unmount", async () => {
    const user = userEvent.setup();
    render(<button type="button">Opener</button>);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    document.body.style.overflow = "auto";

    const { onClose, unmount } = renderDrawer({ closeLabel: "Close panel" });
    const [backdrop, x] = screen.getAllByRole("button", {
      name: "Close panel",
    });
    expect(x).toHaveFocus();
    await user.click(backdrop);
    await user.click(x);
    expect(onClose).toHaveBeenCalledTimes(2);

    unmount();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("auto");
  });

  test("busy disables the backdrop and the x", () => {
    renderDrawer({ busy: true });
    screen
      .getAllByRole("button", { name: "Close" })
      .forEach((button) => expect(button).toBeDisabled());
  });
});

test("renders the wide size on request", () => {
  renderDrawer({ size: "wide" });
  expect(screen.getByRole("dialog")).toHaveClass("app-drawer--wide");
  expect(screen.getByRole("dialog")).not.toHaveClass("app-drawer--narrow");
});
