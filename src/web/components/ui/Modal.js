"use client";

import { useEffect, useId, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog rendered by React (no Bootstrap JS).
 *
 * - Traps Tab focus inside, closes on Escape and backdrop click (unless
 *   `dismissible={false}` or `busy`), restores focus to the opener on close,
 *   and locks body scrolling while open.
 * - Render it conditionally (`open && <Modal …>`) or pass `open`.
 * - `as="form"` turns the dialog into a form so the footer can hold a submit
 *   button; `onSubmit` is forwarded.
 */
export default function Modal({
  open = true,
  title,
  eyebrow = null,
  description = null,
  onClose,
  dismissible = true,
  busy = false,
  size = "md",
  labelledBy,
  as: Component = "div",
  footer = null,
  className = "",
  children,
  ...props
}) {
  const dialogRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const generatedId = useId();
  const titleId = labelledBy || `${generatedId}-title`;
  const descriptionId = description ? `${generatedId}-description` : undefined;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const dialog = dialogRef.current;
    const initial =
      dialog?.querySelector("[data-autofocus]") ||
      dialog?.querySelector(FOCUSABLE) ||
      dialog;
    initial?.focus?.();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        if (dismissible && !busyRef.current) {
          event.preventDefault();
          onCloseRef.current?.();
        }
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [open, dismissible]);

  if (!open) return null;

  return (
    <div
      className="app-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (dismissible && !busy) onClose?.();
      }}
    >
      <Component
        ref={dialogRef}
        className={`app-modal app-modal--${size} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        {...props}
      >
        <div className="app-modal__header">
          <div className="min-w-0">
            {eyebrow && <p className="app-modal__eyebrow">{eyebrow}</p>}
            <h2 id={titleId}>{title}</h2>
            {description && (
              <p id={descriptionId} className="text-secondary mb-0 mt-1">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              className="btn-close"
              aria-label="Close dialog"
              onClick={onClose}
              disabled={busy}
            />
          )}
        </div>
        <div className="app-modal__body">{children}</div>
        {footer && <div className="app-modal__footer">{footer}</div>}
      </Component>
    </div>
  );
}
