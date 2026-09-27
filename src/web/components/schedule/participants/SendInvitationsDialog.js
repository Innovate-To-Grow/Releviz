"use client";

import EmailSendDialog from "@/components/schedule/email/EmailSendDialog";

const invitations = (count) =>
  `${count} ${count === 1 ? "invitation" : "invitations"}`;

/**
 * Sends invitations in two steps (see EmailSendDialog): first who gets one
 * now, who was already invited (with an opt-in to email them again), who can
 * never be emailed and who is being sent right now, above the invitation the
 * first of them would receive; then a second, explicit confirmation.
 *
 * `preview` is the parent's count without `resend` (null while it is still
 * counting): its lines stay the breakdown whichever way the checkbox is set.
 * Checking `Email them again too` asks the parent (`onResendChange`) for the
 * same preview with `resend`, whose email is shown once it arrives as
 * `resendPreview`. Each carries `email` and `sample` from the API.
 */
export default function SendInvitationsDialog({
  preview,
  resendPreview = null,
  resend = false,
  onResendChange,
  error = "",
  busy = false,
  onConfirm,
  onClose,
}) {
  const willSend = preview?.willSend ?? 0;
  const alreadyInvited = preview?.alreadyInvited ?? 0;
  const noEmail = preview?.noEmail ?? 0;
  const inFlight = preview?.inFlight ?? 0;
  const sending = willSend + (resend ? alreadyInvited : 0);
  const shown = resend ? resendPreview : preview;
  const sampleName = shown?.sample?.name || shown?.sample?.email;

  const summary = preview && (
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
              onChange={(event) => onResendChange?.(event.target.checked)}
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
    </ul>
  );

  return (
    <EmailSendDialog
      title="Send invitations"
      recipientCount={sending}
      recipientsSummary={summary}
      email={shown?.email ?? null}
      emailNote={
        sampleName
          ? `Shown for ${sampleName}. Each person gets their own private link.`
          : null
      }
      loading={!shown}
      error={error}
      busy={busy}
      confirmTitle={`Send ${invitations(sending)} now?`}
      sendLabel={`Send ${invitations(sending)}`}
      emptyMessage="Nobody in this selection can be invited."
      onConfirm={() => onConfirm?.({ resend })}
      onClose={onClose}
    />
  );
}
