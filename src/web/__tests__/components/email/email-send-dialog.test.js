/**
 * @jest-environment jsdom
 */

import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import EmailSendDialog from "@/components/schedule/email/EmailSendDialog";

const EMAIL = {
  from: "Releviz <noreply@releviz.com>",
  replyTo: "",
  to: "Ada Lovelace <ada@example.com>",
  subject: "You're invited to Planning",
  html: "<!doctype html><p>Hello Ada</p>",
  text: "Hello Ada",
  attachments: [],
};

function renderDialog(props = {}) {
  const onConfirm = props.onConfirm || jest.fn();
  const onClose = props.onClose || jest.fn();
  const utils = render(
    <div>
      <button type="button">Opener</button>
      <EmailSendDialog
        title="Send invitations"
        recipientCount={3}
        email={EMAIL}
        {...props}
        onConfirm={onConfirm}
        onClose={onClose}
      />
    </div>,
  );
  return { ...utils, onConfirm, onClose };
}

const dialog = () => screen.getByRole("dialog", { name: "Send invitations" });
const button = (name) => screen.getByRole("button", { name });
const queryButton = (name) => screen.queryByRole("button", { name });

describe("EmailSendDialog", () => {
  afterEach(() => {
    document.body.style.overflow = "";
  });

  test("opens on the Review step with the summary, the preview and a safe initial focus", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog({
      recipientsSummary: <p>3 will get an invitation now</p>,
      emailNote:
        "Shown for Ada Lovelace. Each person gets their own private link.",
      children: <p>Extra review content</p>,
    });

    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog()).toHaveAccessibleDescription(
      "Check what people will receive before anything is sent.",
    );
    expect(screen.getByText("Step 1 of 2: Review")).toBeInTheDocument();
    expect(
      screen.getByText("3 will get an invitation now"),
    ).toBeInTheDocument();
    expect(screen.getByText("Extra review content")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Shown for Ada Lovelace. Each person gets their own private link.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Email preview")).toHaveAttribute("sandbox", "");
    expect(
      within(dialog()).getByRole("tab", { name: "Plain text" }),
    ).toBeInTheDocument();
    // Cancel is the safe place to start.
    expect(button("Cancel")).toHaveFocus();
    expect(button("Continue")).toBeEnabled();
    expect(queryButton("Back")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("shows a loading state and keeps Continue disabled until the preview arrives", () => {
    const summary = <p>Counting people</p>;
    const { rerender, onConfirm, onClose } = renderDialog({
      loading: true,
      email: null,
      recipientsSummary: summary,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing the email preview…",
    );
    // The summary stays so its controls keep their state while re-previewing.
    expect(screen.getByText("Counting people")).toBeInTheDocument();
    expect(button("Continue")).toBeDisabled();
    expect(screen.queryByTitle("Email preview")).not.toBeInTheDocument();
    fireEvent.click(button("Continue"));
    expect(screen.getByText("Step 1 of 2: Review")).toBeInTheDocument();

    rerender(
      <EmailSendDialog
        title="Send invitations"
        recipientCount={3}
        email={EMAIL}
        recipientsSummary={summary}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(
      screen.queryByText("Preparing the email preview…"),
    ).not.toBeInTheDocument();
    expect(screen.getByTitle("Email preview")).toBeInTheDocument();
    expect(button("Continue")).toBeEnabled();
  });

  test("with nobody to email it explains why and does not continue", () => {
    const { rerender, onConfirm, onClose } = renderDialog({
      recipientCount: 0,
      email: null,
    });
    const status = screen.getByRole("status");
    expect(status).toHaveClass("alert-info");
    expect(status).toHaveTextContent("Nobody will receive this email.");
    expect(button("Continue")).toBeDisabled();
    expect(screen.queryByTitle("Email preview")).not.toBeInTheDocument();

    rerender(
      <EmailSendDialog
        title="Send invitations"
        recipientCount={0}
        email={null}
        emptyMessage="Nobody in this selection can be invited."
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Nobody in this selection can be invited.",
    );
    expect(button("Continue")).toBeDisabled();
  });

  test("without a count or an email it treats the send as reaching nobody", () => {
    render(<EmailSendDialog title="Send reminders" onClose={jest.fn()} />);
    expect(
      screen.getByRole("dialog", { name: "Send reminders" }),
    ).toHaveTextContent("Nobody will receive this email.");
    expect(button("Continue")).toBeDisabled();
  });

  test("allowEmpty lets the organizer continue when nobody will be emailed", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      title: "Finalize meeting",
      recipientCount: 0,
      email: null,
      allowEmpty: true,
      emptyMessage:
        "Nobody has been invited by email, so no confirmation emails will be sent.",
      confirmTitle: "Finalize without emailing anyone?",
      sendLabel: "Finalize meeting",
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Nobody has been invited by email, so no confirmation emails will be sent.",
    );
    await user.click(button("Continue"));
    expect(
      screen.getByRole("heading", {
        name: "Finalize without emailing anyone?",
      }),
    ).toHaveFocus();
    expect(screen.getByText("No emails will be sent.")).toBeInTheDocument();
    await user.click(button("Finalize meeting"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("Continue moves to Confirm with the default wording, and Back returns", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      recipientsSummary: <p>Summary line</p>,
    });

    await user.click(button("Continue"));
    expect(screen.getByText("Step 2 of 2: Confirm")).toBeInTheDocument();
    const heading = screen.getByRole("heading", {
      level: 3,
      name: "Send 3 emails now?",
    });
    expect(heading).toHaveFocus();
    expect(dialog()).not.toHaveAttribute("aria-describedby");
    expect(
      screen.getByText(
        "Emails go out right away and can't be recalled. Each person receives the email you just reviewed.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Subject: You're invited to Planning · 3 recipients"),
    ).toBeInTheDocument();
    // The review content is gone; nothing has been sent yet.
    expect(screen.queryByTitle("Email preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Summary line")).not.toBeInTheDocument();
    expect(queryButton("Continue")).not.toBeInTheDocument();
    expect(queryButton("Cancel")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    // Enter on the focused heading does not send.
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(button("Back"));
    expect(screen.getByText("Step 1 of 2: Review")).toBeInTheDocument();
    expect(button("Continue")).toHaveFocus();
    expect(screen.getByText("Summary line")).toBeInTheDocument();
    expect(screen.getByTitle("Email preview")).toBeInTheDocument();

    await user.click(button("Continue"));
    await user.click(button("Send 3 emails"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("uses singular wording for one recipient and the caller's wording when given", async () => {
    const user = userEvent.setup();
    const { unmount } = renderDialog({ recipientCount: 1 });
    await user.click(button("Continue"));
    expect(
      screen.getByRole("heading", { name: "Send 1 email now?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Subject: You're invited to Planning · 1 recipient"),
    ).toBeInTheDocument();
    expect(button("Send 1 email")).toBeInTheDocument();
    unmount();

    const { onConfirm } = renderDialog({
      recipientCount: 2,
      confirmTitle: "Send 2 invitations now?",
      confirmBody: <p>Custom body</p>,
      sendLabel: "Send 2 invitations",
    });
    await user.click(button("Continue"));
    expect(
      screen.getByRole("heading", { name: "Send 2 invitations now?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Custom body")).toBeInTheDocument();
    expect(screen.queryByText(/can't be recalled/)).not.toBeInTheDocument();
    await user.click(button("Send 2 invitations"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("while sending, the dialog cannot be closed or left, and the send button shows progress", async () => {
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    const onClose = jest.fn();
    function Harness() {
      const [busy, setBusy] = useState(false);
      return (
        <EmailSendDialog
          title="Send invitations"
          recipientCount={2}
          email={EMAIL}
          busy={busy}
          onConfirm={() => {
            onConfirm();
            setBusy(true);
          }}
          onClose={onClose}
        />
      );
    }
    render(<Harness />);
    await user.click(button("Continue"));
    await user.click(button("Send 2 emails"));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    const send = button("Send 2 emails");
    expect(send).toHaveAttribute("aria-busy", "true");
    expect(send).toBeDisabled();
    expect(button("Back")).toBeDisabled();
    expect(button("Close dialog")).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".app-modal-backdrop"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(send);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("Escape, the backdrop and the close button dismiss from either step", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(button("Continue"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(document.querySelector(".app-modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
    await user.click(button("Close dialog"));
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  test("a preview error shows at the top of the Review step", () => {
    renderDialog({
      error: "Could not prepare the preview.",
      recipientsSummary: <p>Summary line</p>,
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not prepare the preview.");
    // The error comes before the summary.
    expect(
      alert.compareDocumentPosition(screen.getByText("Summary line")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("an error from sending stays on the Confirm step with a way back", async () => {
    const user = userEvent.setup();
    const { rerender, onConfirm, onClose } = renderDialog();
    await user.click(button("Continue"));
    await user.click(button("Send 3 emails"));
    rerender(
      <div>
        <button type="button">Opener</button>
        <EmailSendDialog
          title="Send invitations"
          recipientCount={3}
          email={EMAIL}
          error="Too many invitation requests. Try again in a minute."
          onConfirm={onConfirm}
          onClose={onClose}
        />
      </div>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many invitation requests. Try again in a minute.",
    );
    expect(
      screen.getByRole("heading", { name: "Send 3 emails now?" }),
    ).toBeInTheDocument();
    expect(button("Back")).toBeEnabled();
    expect(button("Send 3 emails")).toBeEnabled();
  });

  test("a rejected send shows its message on the Confirm step until the organizer goes back", async () => {
    const user = userEvent.setup();
    const onConfirm = jest
      .fn()
      .mockRejectedValueOnce(new Error("The event is closed."))
      .mockRejectedValueOnce({})
      .mockResolvedValueOnce(undefined);
    renderDialog({ onConfirm });

    await user.click(button("Continue"));
    await user.click(button("Send 3 emails"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The event is closed.",
    );
    expect(
      screen.getByRole("heading", { name: "Send 3 emails now?" }),
    ).toBeInTheDocument();

    await user.click(button("Back"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(button("Continue"));
    await user.click(button("Send 3 emails"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The emails could not be sent. Try again.",
    );

    await user.click(button("Send 3 emails"));
    await act(async () => {});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onConfirm).toHaveBeenCalledTimes(3);
  });

  test("works without an onConfirm handler", async () => {
    const user = userEvent.setup();
    render(
      <EmailSendDialog
        title="Send invitations"
        recipientCount={1}
        email={EMAIL}
        onClose={jest.fn()}
      />,
    );
    await user.click(button("Continue"));
    await user.click(button("Send 1 email"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
