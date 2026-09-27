/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import SendInvitationsDialog from "@/components/schedule/participants/SendInvitationsDialog";

function email(overrides = {}) {
  return {
    from: "noreply@releviz.local",
    replyTo: "",
    to: "Ada Lovelace <ada@example.com>",
    subject: "You're invited to Planning",
    html: "<!doctype html><p>Hello Ada</p>",
    text: "Hello Ada",
    attachments: [],
    ...overrides,
  };
}

function preview(overrides = {}) {
  return {
    willSend: 4,
    alreadyInvited: 2,
    noEmail: 1,
    inFlight: 3,
    organizer: 1,
    total: 11,
    email: email(),
    sample: { name: "Ada Lovelace", email: "ada@example.com" },
    ...overrides,
  };
}

function renderDialog(props = {}) {
  const onConfirm = jest.fn();
  const onClose = jest.fn();
  const onResendChange = jest.fn();
  const utils = render(
    <SendInvitationsDialog
      onConfirm={onConfirm}
      onClose={onClose}
      onResendChange={onResendChange}
      {...props}
    />,
  );
  return { onConfirm, onClose, onResendChange, ...utils };
}

const dialog = () => screen.getByRole("dialog", { name: "Send invitations" });
const button = (name) => screen.getByRole("button", { name });

describe("SendInvitationsDialog", () => {
  test("prepares the preview before anything can be sent", () => {
    renderDialog({ preview: null });
    expect(dialog()).toHaveTextContent("Step 1 of 2: Review");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing the email preview…",
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(button("Continue")).toBeDisabled();
  });

  test("lists every non-zero line, shows the email, and sends after a second confirmation", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ preview: preview() });
    const items = within(dialog())
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "4 will get an invitation now",
      "2 were already invitedEmail them again too",
      "1 have no email of their own and are never emailed",
      "3 are being sent right now",
    ]);
    expect(screen.getByTitle("Email preview")).toHaveAttribute("sandbox", "");
    expect(dialog()).toHaveTextContent("Ada Lovelace <ada@example.com>");
    expect(
      screen.getByText(
        "Shown for Ada Lovelace. Each person gets their own private link.",
      ),
    ).toBeInTheDocument();

    await user.click(button("Continue"));
    expect(
      screen.getByRole("heading", { name: "Send 4 invitations now?" }),
    ).toHaveFocus();
    expect(dialog()).toHaveTextContent(
      "Subject: You're invited to Planning · 4 recipients",
    );
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(button("Send 4 invitations"));
    expect(onConfirm).toHaveBeenCalledWith({ resend: false });
  });

  test("emailing the already-invited again asks for their preview and counts them in", async () => {
    const user = userEvent.setup();
    const base = preview({
      willSend: 0,
      alreadyInvited: 1,
      noEmail: 0,
      inFlight: 0,
      email: null,
      sample: null,
    });
    const { onResendChange, onConfirm, rerender } = renderDialog({
      preview: base,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Nobody in this selection can be invited.",
    );
    expect(button("Continue")).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: "Email them again too" }),
    );
    expect(onResendChange).toHaveBeenCalledWith(true);

    // The parent re-runs the preview with `resend`; until it answers the
    // checkbox stays and the email is still being prepared.
    const props = {
      onConfirm,
      onClose: jest.fn(),
      onResendChange,
      preview: base,
      resend: true,
    };
    rerender(<SendInvitationsDialog {...props} resendPreview={null} />);
    expect(
      screen.getByRole("checkbox", { name: "Email them again too" }),
    ).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing the email preview…",
    );
    expect(button("Continue")).toBeDisabled();

    rerender(
      <SendInvitationsDialog
        {...props}
        resendPreview={preview({
          willSend: 1,
          alreadyInvited: 0,
          sample: { name: "", email: "grace@example.com" },
          email: email({ to: "grace@example.com" }),
        })}
      />,
    );
    expect(
      screen.getByText(
        "Shown for grace@example.com. Each person gets their own private link.",
      ),
    ).toBeInTheDocument();
    await user.click(button("Continue"));
    expect(
      screen.getByRole("heading", { name: "Send 1 invitation now?" }),
    ).toBeInTheDocument();
    await user.click(button("Send 1 invitation"));
    expect(onConfirm).toHaveBeenCalledWith({ resend: true });

    // Unchecking goes back to the first preview.
    await user.click(button("Back"));
    await user.click(
      screen.getByRole("checkbox", { name: "Email them again too" }),
    );
    expect(onResendChange).toHaveBeenLastCalledWith(false);
  });

  test("omits zero lines, keeps errors on screen and cancels", async () => {
    const user = userEvent.setup();
    const { onClose, onConfirm } = renderDialog({
      preview: preview({ alreadyInvited: 0, noEmail: 0, inFlight: 0 }),
      error: "Something went wrong.",
    });
    expect(within(dialog()).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("busy locks the send and the resend choice", async () => {
    const user = userEvent.setup();
    const props = {
      onConfirm: jest.fn(),
      onClose: jest.fn(),
      onResendChange: jest.fn(),
      preview: preview({ willSend: 2 }),
    };
    const { rerender } = render(<SendInvitationsDialog {...props} />);
    await user.click(button("Continue"));
    rerender(<SendInvitationsDialog {...props} busy />);
    expect(button("Back")).toBeDisabled();
    expect(button("Send 2 invitations")).toBeDisabled();
    rerender(<SendInvitationsDialog {...props} busy={false} />);
    await user.click(button("Back"));
    rerender(<SendInvitationsDialog {...props} busy />);
    expect(
      screen.getByRole("checkbox", { name: "Email them again too" }),
    ).toBeDisabled();
    expect(button("Cancel")).toBeDisabled();
  });
});
