/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import SendInvitationsDialog from "@/components/schedule/participants/SendInvitationsDialog";

function renderDialog(props = {}) {
  const onConfirm = jest.fn();
  const onClose = jest.fn();
  render(
    <SendInvitationsDialog
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    />,
  );
  return { onConfirm, onClose };
}

describe("SendInvitationsDialog", () => {
  test("shows a loading state until the preview arrives", () => {
    const { onConfirm } = renderDialog({ preview: null });
    expect(
      screen.getByRole("dialog", { name: "Send invitations" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking who can be invited…",
    );
    expect(
      screen.getByRole("button", { name: "Send 0 invitations" }),
    ).toBeDisabled();
    fireEvent.submit(screen.getByRole("dialog"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("lists every non-zero line and confirms with the plain count", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      preview: {
        willSend: 4,
        alreadyInvited: 2,
        noEmail: 1,
        inFlight: 3,
        organizer: 1,
        total: 11,
      },
    });
    const items = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items[0]).toBe("4 will get an invitation now");
    expect(items[1]).toContain("2 were already invited");
    expect(items[2]).toBe("1 have no email of their own and are never emailed");
    expect(items[3]).toBe("3 are being sent right now");
    expect(items).toHaveLength(4);
    await user.click(
      screen.getByRole("button", { name: "Send 4 invitations" }),
    );
    expect(onConfirm).toHaveBeenCalledWith({ resend: false });
  });

  test("emailing the already-invited again adds them to the count", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      preview: {
        willSend: 0,
        alreadyInvited: 1,
        noEmail: 0,
        inFlight: 0,
        organizer: 0,
        total: 1,
      },
    });
    expect(
      screen.getByRole("button", { name: "Send 0 invitations" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Nobody in this selection can be invited."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Email them again too" }),
    );
    expect(
      screen.queryByText("Nobody in this selection can be invited."),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send 1 invitation" }));
    expect(onConfirm).toHaveBeenCalledWith({ resend: true });
  });

  test("omits zero lines, shows errors and cancels", async () => {
    const user = userEvent.setup();
    const { onClose, onConfirm } = renderDialog({
      preview: {
        willSend: 1,
        alreadyInvited: 0,
        noEmail: 0,
        inFlight: 0,
        organizer: 0,
        total: 1,
      },
      error: "Something went wrong.",
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong.",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("busy disables both buttons", () => {
    renderDialog({
      preview: {
        willSend: 2,
        alreadyInvited: 0,
        noEmail: 0,
        inFlight: 0,
        organizer: 0,
        total: 2,
      },
      busy: true,
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Send 2 invitations" }),
    ).toBeDisabled();
  });
});
