"use client";

import AppButton from "@/components/ui/AppButton";
import Modal from "@/components/ui/Modal";

/**
 * In-page replacement for window.confirm: a small destructive-action dialog
 * built on Modal. Rendered as a form so Enter confirms; initial focus lands on
 * Cancel (the safe action) via `data-autofocus`. Escape, the backdrop, and the
 * header close button all cancel.
 */
export default function ConfirmDialog({
  title,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onClose,
  size = "md",
  children,
}) {
  return (
    <Modal
      as="form"
      size={size}
      title={title}
      busy={busy}
      onClose={onClose}
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        onConfirm?.();
      }}
      footer={
        <>
          <AppButton
            variant="text"
            data-autofocus
            onClick={onClose}
            disabled={busy}
          >
            {cancelLabel}
          </AppButton>
          <AppButton type="submit" variant="danger-filled" busy={busy}>
            {confirmLabel}
          </AppButton>
        </>
      }
    >
      {children}
    </Modal>
  );
}
