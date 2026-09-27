"use client";

import { useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import LoadingState from "@/components/ui/LoadingState";
import Modal from "@/components/ui/Modal";
import { SendIcon } from "@/components/ui/icons";

/**
 * Confirms a bulk invitation: who gets one now, who was already invited (with
 * an opt-in to email them again), who can never be emailed, and who is being
 * sent right now. `preview` is null while the parent is still counting.
 */
export default function SendInvitationsDialog({
  preview,
  error = "",
  busy = false,
  onConfirm,
  onClose,
}) {
  const [resend, setResend] = useState(false);
  const willSend = preview?.willSend ?? 0;
  const alreadyInvited = preview?.alreadyInvited ?? 0;
  const noEmail = preview?.noEmail ?? 0;
  const inFlight = preview?.inFlight ?? 0;
  const sending = willSend + (resend ? alreadyInvited : 0);
  const nobody = Boolean(preview) && sending === 0;

  return (
    <Modal
      as="form"
      title="Send invitations"
      busy={busy}
      onClose={onClose}
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        if (!preview || sending === 0) return;
        onConfirm?.({ resend });
      }}
      footer={
        <>
          <AppButton variant="text" onClick={onClose} disabled={busy}>
            Cancel
          </AppButton>
          <AppButton
            type="submit"
            icon={<SendIcon />}
            busy={busy}
            disabled={busy || !preview || sending === 0}
          >
            Send {sending} {sending === 1 ? "invitation" : "invitations"}
          </AppButton>
        </>
      }
    >
      {!preview ? (
        <LoadingState label="Checking who can be invited…" />
      ) : (
        <ul className="list-unstyled d-flex flex-column gap-2 mb-0 participants-send-summary">
          {willSend > 0 && <li>{willSend} will get an invitation now</li>}
          {alreadyInvited > 0 && (
            <li>
              {alreadyInvited} were already invited
              <div className="form-check mt-1">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="participants-send-resend"
                  checked={resend}
                  disabled={busy}
                  onChange={(event) => setResend(event.target.checked)}
                />
                <label
                  className="form-check-label"
                  htmlFor="participants-send-resend"
                >
                  Email them again too
                </label>
              </div>
            </li>
          )}
          {noEmail > 0 && (
            <li>{noEmail} have no email of their own and are never emailed</li>
          )}
          {inFlight > 0 && <li>{inFlight} are being sent right now</li>}
          {nobody && (
            <li className="text-secondary">
              Nobody in this selection can be invited.
            </li>
          )}
        </ul>
      )}
      {error && (
        <Alert variant="danger" role="alert" className="mt-3">
          {error}
        </Alert>
      )}
    </Modal>
  );
}
