"use client";

import { useEffect, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import LoadingState from "@/components/ui/LoadingState";
import Modal from "@/components/ui/Modal";
import { SendIcon } from "@/components/ui/icons";
import EmailPreview from "./EmailPreview";

const REVIEW_DESCRIPTION =
  "Check what people will receive before anything is sent.";
const DEFAULT_CONFIRM_BODY =
  "Emails go out right away and can't be recalled. Each person receives the email you just reviewed.";
const DEFAULT_EMPTY_MESSAGE = "Nobody will receive this email.";
const SEND_FAILED = "The emails could not be sent. Try again.";

const emails = (count) => `${count} ${count === 1 ? "email" : "emails"}`;
const recipients = (count) =>
  `${count} ${count === 1 ? "recipient" : "recipients"}`;

/**
 * Two-step send dialog for every organizer-initiated email: nothing is sent
 * until the organizer has seen the email and then confirmed a second time.
 *
 * 1. Review: an optional `error`, `recipientsSummary` (always shown, so its
 *    controls survive a re-preview), then the `EmailPreview` of `email` with
 *    `emailNote` — or a loading state while `loading`, or `emptyMessage` when
 *    `recipientCount` is 0 — and any `children`. `Continue` is disabled while
 *    loading and, unless `allowEmpty`, when nobody would be emailed.
 * 2. Confirm: `confirmTitle` (default `Send {n} emails now?`), `confirmBody`,
 *    and a recap of the subject and recipient count. `Back` returns to Review;
 *    the primary `sendLabel` button calls `onConfirm`.
 *
 * The parent owns `busy` and `error`. An `error` shows on whichever step is
 * open, so a failed send stays on Confirm with `Back` available; a promise
 * rejected by `onConfirm` is shown there too. While `busy`, Escape, the
 * backdrop and the close button do nothing (Modal) and Back is disabled.
 *
 * Continue moves focus to the Confirm heading (so a second Enter can't send);
 * Back moves it to Continue.
 */
export default function EmailSendDialog({
  title,
  recipientCount = 0,
  recipientsSummary = null,
  email = null,
  emailNote = null,
  loading = false,
  error = "",
  busy = false,
  confirmTitle,
  confirmBody,
  sendLabel,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  allowEmpty = false,
  onConfirm,
  onClose,
  children = null,
}) {
  const [step, setStep] = useState("review");
  const [sendError, setSendError] = useState("");
  const confirmHeadingRef = useRef(null);
  const continueRef = useRef(null);
  const pendingFocusRef = useRef(null);

  useEffect(() => {
    const target = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (target === "confirm") confirmHeadingRef.current?.focus();
    if (target === "review") continueRef.current?.focus();
  }, [step]);

  const empty = !loading && recipientCount === 0;
  const canContinue = !loading && (recipientCount > 0 || allowEmpty);
  const shownError = error || sendError;

  const goToConfirm = () => {
    pendingFocusRef.current = "confirm";
    setStep("confirm");
  };

  const goBack = () => {
    setSendError("");
    pendingFocusRef.current = "review";
    setStep("review");
  };

  const send = async () => {
    setSendError("");
    try {
      await onConfirm?.();
    } catch (sendFailure) {
      setSendError(sendFailure?.message || SEND_FAILED);
    }
  };

  const errorAlert = shownError ? (
    <Alert variant="danger" className="mb-3">
      {shownError}
    </Alert>
  ) : null;

  if (step === "confirm") {
    return (
      <Modal
        size="xl"
        title={title}
        eyebrow="Step 2 of 2: Confirm"
        busy={busy}
        onClose={onClose}
        footer={
          <>
            <AppButton variant="text" onClick={goBack} disabled={busy}>
              Back
            </AppButton>
            <AppButton
              icon={<SendIcon />}
              busy={busy}
              disabled={busy}
              onClick={send}
            >
              {sendLabel || `Send ${emails(recipientCount)}`}
            </AppButton>
          </>
        }
      >
        {errorAlert}
        <div className="email-send-dialog__confirm">
          <h3
            ref={confirmHeadingRef}
            tabIndex={-1}
            className="h5 email-send-dialog__confirm-title"
          >
            {confirmTitle || `Send ${emails(recipientCount)} now?`}
          </h3>
          {confirmBody ?? <p className="mb-0">{DEFAULT_CONFIRM_BODY}</p>}
          <p className="email-send-dialog__recap">
            {email
              ? `Subject: ${email.subject} · ${recipients(recipientCount)}`
              : "No emails will be sent."}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      size="xl"
      title={title}
      eyebrow="Step 1 of 2: Review"
      description={REVIEW_DESCRIPTION}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <AppButton
            variant="text"
            data-autofocus
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </AppButton>
          <AppButton
            ref={continueRef}
            disabled={!canContinue}
            onClick={goToConfirm}
          >
            Continue
          </AppButton>
        </>
      }
    >
      {errorAlert}
      <div className="email-send-dialog__review">
        {recipientsSummary}
        {loading ? (
          <LoadingState label="Preparing the email preview…" />
        ) : empty ? (
          <Alert variant="info">{emptyMessage}</Alert>
        ) : (
          <EmailPreview email={email} note={emailNote} />
        )}
        {children}
      </div>
    </Modal>
  );
}
