/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import "@testing-library/jest-dom";

import Modal from "@/components/ui/Modal";

function Harness({ children, ...props }) {
  return (
    <div>
      <button type="button">Opener</button>
      <Modal title="Delete event" onClose={() => {}} {...props}>
        {children}
      </Modal>
    </div>
  );
}

describe("Modal", () => {
  afterEach(() => {
    document.body.style.overflow = "";
  });

  test("renders nothing while closed", () => {
    const { container } = render(<Harness open={false}>Hidden</Harness>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container).toHaveTextContent("Opener");
    expect(document.body.style.overflow).toBe("");
  });

  test("labels the dialog, locks scrolling, and restores focus on close", () => {
    const opener = () => screen.getByRole("button", { name: "Opener" });
    const { rerender } = render(<Harness open={false}>Body</Harness>);
    opener().focus();
    rerender(
      <Harness
        eyebrow="Danger zone"
        description="This cannot be undone."
        footer={<button type="button">Confirm</button>}
      >
        <input aria-label="Reason" />
      </Harness>,
    );
    const dialog = screen.getByRole("dialog", { name: "Delete event" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    expect(screen.getByText("Danger zone")).toHaveClass("app-modal__eyebrow");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(dialog).toHaveClass("app-modal--md");
    expect(document.body.style.overflow).toBe("hidden");
    // The first focusable control receives focus when nothing is marked.
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
    rerender(<Harness open={false}>Body</Harness>);
    expect(document.body.style.overflow).toBe("");
    expect(opener()).toHaveFocus();
  });

  test("prefers a data-autofocus control and falls back to the dialog itself", () => {
    const { unmount } = render(
      <Harness>
        <button type="button">First</button>
        <button type="button" data-autofocus="">
          Preferred
        </button>
      </Harness>,
    );
    expect(screen.getByRole("button", { name: "Preferred" })).toHaveFocus();
    unmount();
    render(
      <Harness dismissible={false}>
        <p>Read-only notice</p>
      </Harness>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Close dialog" }),
    ).not.toBeInTheDocument();
  });

  test("closes on Escape, the close button, and backdrop clicks unless busy or non-dismissible", () => {
    const onClose = jest.fn();
    const { rerender } = render(
      <Harness onClose={onClose}>
        <button type="button">Inside</button>
      </Harness>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    const backdrop = document.querySelector(".app-modal-backdrop");
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
    // Presses that start inside the dialog never dismiss it.
    fireEvent.mouseDown(screen.getByRole("button", { name: "Inside" }));
    expect(onClose).toHaveBeenCalledTimes(3);

    rerender(
      <Harness onClose={onClose} busy>
        <button type="button">Inside</button>
      </Harness>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".app-modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();

    rerender(
      <Harness onClose={onClose} dismissible={false}>
        <button type="button">Inside</button>
      </Harness>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".app-modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  test("traps Tab and Shift+Tab inside the dialog", () => {
    render(
      <Harness footer={<button type="button">Last</button>}>
        <input aria-label="Reason" />
      </Harness>,
    );
    const first = screen.getByRole("button", { name: "Close dialog" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    // Tabbing from the middle is left to the browser.
    screen.getByLabelText("Reason").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByLabelText("Reason")).toHaveFocus();
    // Other keys are ignored.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(screen.getByLabelText("Reason")).toHaveFocus();
  });

  test("keeps focus on the dialog when nothing inside can take it", () => {
    render(
      <Harness dismissible={false}>
        <p>Nothing focusable</p>
      </Harness>,
    );
    const dialog = screen.getByRole("dialog");
    document.body.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog).toHaveFocus();
  });

  test("renders as a form with a custom label and size", async () => {
    const onSubmit = jest.fn((event) => event.preventDefault());
    render(
      <div>
        <Modal
          as="form"
          size="lg"
          labelledBy="custom-title"
          title="Rename"
          onClose={() => {}}
          onSubmit={onSubmit}
          className="extra"
          footer={<button type="submit">Save</button>}
        >
          <input aria-label="Name" />
        </Modal>
      </div>,
    );
    const dialog = screen.getByRole("dialog", { name: "Rename" });
    // The title takes the given id, for a page that points at it.
    expect(dialog).toHaveAttribute("aria-labelledby", "custom-title");
    expect(document.getElementById("custom-title")).toBe(
      screen.getByRole("heading", { level: 2, name: "Rename" }),
    );
    expect(dialog.tagName).toBe("FORM");
    expect(dialog).toHaveClass("app-modal--lg", "extra");
    expect(dialog).not.toHaveAttribute("aria-describedby");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("renders on the page body, clear of a sticky parent's stacking context", () => {
    // A sticky column (the Results side rail) is its own stacking context:
    // a dialog drawn inside it sits under the sticky section nav however high
    // its z-index, so the dialog is drawn on the body instead.
    const onClose = jest.fn();
    const { container } = render(
      <div className="meeting-results__side" style={{ position: "sticky" }}>
        <Modal title="Finalize meeting" onClose={onClose}>
          <button type="button">Inside</button>
        </Modal>
      </div>,
    );
    const dialog = screen.getByRole("dialog", { name: "Finalize meeting" });
    const backdrop = dialog.parentElement;
    expect(backdrop).toHaveClass("app-modal-backdrop");
    expect(backdrop.parentElement).toBe(document.body);
    expect(container).not.toContainElement(dialog);
    // Focus and dismissal work as before.
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("server markup keeps the dialog in place until it is hydrated onto the body", async () => {
    const onClose = jest.fn();
    const tree = (
      <Harness onClose={onClose}>
        <button type="button">Inside</button>
      </Harness>
    );
    const html = renderToString(tree);
    expect(html).toContain('role="dialog"');
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    let root;
    await act(async () => {
      root = hydrateRoot(container, tree);
    });
    const dialog = screen.getByRole("dialog", { name: "Delete event" });
    expect(dialog.parentElement.parentElement).toBe(document.body);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // The dialog that moved is the one that has focus and hears Escape.
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    container.remove();
  });
});
