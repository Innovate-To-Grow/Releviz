/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import SelectionBar from "@/components/schedule/participants/SelectionBar";

function renderBar(props = {}) {
  const handlers = {
    onClear: jest.fn(),
    onSendInvitation: jest.fn(),
    onGroups: jest.fn(),
    onSetWeight: jest.fn(),
    onCountIn: jest.fn(),
    onLeaveOut: jest.fn(),
  };
  render(<SelectionBar count={3} {...handlers} {...props} />);
  return handlers;
}

const openMore = (user) =>
  user.click(screen.getByRole("button", { name: "More" }));

describe("SelectionBar", () => {
  test("describes the selection and wires the direct actions", async () => {
    const user = userEvent.setup();
    const handlers = renderBar({ notOnPage: 2 });
    expect(
      screen.getByRole("region", { name: "Selected people" }),
    ).toHaveTextContent("3 selected · 2 not on this page");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Send invitation…" }));
    await user.click(screen.getByRole("button", { name: "Groups…" }));
    expect(handlers.onClear).toHaveBeenCalledTimes(1);
    expect(handlers.onSendInvitation).toHaveBeenCalledTimes(1);
    expect(handlers.onGroups).toHaveBeenCalledTimes(1);
  });

  test("the More menu counts people in or out", async () => {
    const user = userEvent.setup();
    const handlers = renderBar({ mode: "all" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "3 selected · everyone matching the filter",
    );
    await openMore(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Count in results" }),
    );
    expect(handlers.onCountIn).toHaveBeenCalledTimes(1);
    await openMore(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Leave out of results" }),
    );
    expect(handlers.onLeaveOut).toHaveBeenCalledTimes(1);
  });

  test("Set weight… opens a dialog that validates before applying", async () => {
    const user = userEvent.setup();
    const handlers = renderBar({ count: 1 });
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: "Set weight…" }));
    const dialog = screen.getByRole("dialog", { name: "Set weight" });
    expect(dialog).toHaveTextContent("Applies to the 1 selected person.");
    const input = screen.getByLabelText("Weight");
    expect(input).toHaveFocus();
    expect(input).toHaveValue(1);

    await user.clear(input);
    await user.type(input, "2");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a weight between 0 and 1.",
    );
    expect(handlers.onSetWeight).not.toHaveBeenCalled();

    await user.clear(input);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.type(input, "0.25");
    fireEvent.submit(screen.getByLabelText("Weight").closest("form"));
    expect(handlers.onSetWeight).toHaveBeenCalledWith(0.25);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the weight dialog can be cancelled and reopens fresh", async () => {
    const user = userEvent.setup();
    renderBar();
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: "Set weight…" }));
    await user.clear(screen.getByLabelText("Weight"));
    await user.type(screen.getByLabelText("Weight"), "0.5");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: "Set weight…" }));
    expect(screen.getByLabelText("Weight")).toHaveValue(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("busy and read-only lock the changing actions but not Clear", () => {
    const { rerender } = render(
      <SelectionBar count={2} readOnly onClear={jest.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Send invitation…" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Groups…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "More" })).toBeDisabled();
    rerender(<SelectionBar count={2} busy onClear={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Groups…" })).toBeDisabled();
  });
});
