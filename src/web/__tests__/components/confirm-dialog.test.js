/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import ConfirmDialog from "@/components/ui/ConfirmDialog";

function renderDialog(props = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const utils = render(
    <div>
      <button type="button">Opener</button>
      <ConfirmDialog
        title="Delete group Faculty?"
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />
    </div>,
  );
  return { ...utils, onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  afterEach(() => {
    document.body.style.overflow = "";
  });

  test("renders nothing while closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  test("asks as an alert dialog with the safe choice focused", () => {
    const { onConfirm, onCancel } = renderDialog({
      description: "People stay on the roster.",
      confirmLabel: "Delete group",
    });
    const dialog = screen.getByRole("alertdialog", {
      name: "Delete group Faculty?",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("People stay on the roster.");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", {
      name: "Delete group",
    });
    expect(cancel).toHaveFocus();
    expect(confirm).toHaveClass("btn-danger");

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("cancels on Escape, the close button, and a backdrop click", () => {
    const { container, onCancel, onConfirm } = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.mouseDown(container.querySelector(".app-modal-backdrop"));
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("uses the default labels, extra content, and a non-destructive style", () => {
    renderDialog({
      danger: false,
      cancelLabel: "Keep editing",
      children: <p>Two people are affected.</p>,
    });
    const dialog = screen.getByRole("alertdialog", {
      name: "Delete group Faculty?",
    });
    expect(dialog).not.toHaveAttribute("aria-describedby");
    expect(dialog).toHaveTextContent("Two people are affected.");
    expect(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    ).toHaveFocus();
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toHaveClass("btn-primary");
    expect(confirm).not.toHaveClass("btn-danger");
  });

  test("locks both choices and ignores Escape while busy", () => {
    const { onCancel } = renderDialog({ busy: true });
    const dialog = screen.getByRole("alertdialog", {
      name: "Delete group Faculty?",
    });
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-busy", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
