/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import ConfirmDialog from "@/components/ui/ConfirmDialog";

function renderDialog(props = {}) {
  return render(
    <ConfirmDialog
      title="Delete group Faculty?"
      confirmLabel="Delete group"
      onConfirm={jest.fn()}
      onClose={jest.fn()}
      {...props}
    >
      <p>People stay on the roster.</p>
    </ConfirmDialog>,
  );
}

describe("ConfirmDialog", () => {
  test("renders title, body, and actions with Cancel focused first", () => {
    renderDialog();
    expect(
      screen.getByRole("dialog", { name: "Delete group Faculty?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("People stay on the roster.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Delete group" }),
    ).toBeInTheDocument();
  });

  test("confirm button and form submission both call onConfirm", () => {
    const onConfirm = jest.fn();
    renderDialog({ onConfirm });
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.submit(
      screen.getByRole("dialog", { name: "Delete group Faculty?" }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  test("Cancel, Escape, and the backdrop call onClose", () => {
    const onClose = jest.fn();
    const first = renderDialog({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    renderDialog({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.mouseDown(document.querySelector(".app-modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  test("supports a custom cancel label", () => {
    renderDialog({ cancelLabel: "Keep group" });
    expect(
      screen.getByRole("button", { name: "Keep group" }),
    ).toBeInTheDocument();
  });

  test("busy blocks cancellation and shows the confirm spinner", () => {
    const onClose = jest.fn();
    renderDialog({ busy: true, onClose });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete group" }),
    ).toHaveAttribute("aria-busy", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
