"use client";

import { useId } from "react";
import AppButton from "@/components/ui/AppButton";
import Modal from "@/components/ui/Modal";

/**
 * In-app replacement for `window.confirm`, built on Modal so it keeps the
 * focus trap, Escape handling and focus restore.
 *
 * - Renders as an `alertdialog`; the description is its accessible
 *   description.
 * - The cancel (safe) button receives focus first, so pressing Enter right
 *   away never runs the destructive action. Escape, the close button and a
 *   backdrop click all cancel.
 * - `danger` (the default) styles the confirm button as destructive.
 */
export default function ConfirmDialog({
  open = true,
  title,
  description = null,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  busy = false,
  danger = true,
  children,
}) {
  const descriptionId = useId();

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      busy={busy}
      role="alertdialog"
      aria-describedby={description ? descriptionId : undefined}
      footer={
        <>
          <AppButton
            variant="text"
            onClick={onCancel}
            disabled={busy}
            data-autofocus
          >
            {cancelLabel}
          </AppButton>
          <AppButton
            variant={danger ? "danger-filled" : "filled"}
            onClick={onConfirm}
            busy={busy}
            disabled={busy}
          >
            {confirmLabel}
          </AppButton>
        </>
      }
    >
      {description && (
        <p id={descriptionId} className="mb-0">
          {description}
        </p>
      )}
      {children}
    </Modal>
  );
}
