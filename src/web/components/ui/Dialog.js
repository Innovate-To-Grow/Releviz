"use client";

import { useEffect, useId, useRef } from "react";
import Button from "@/components/ui/Button";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog and slide-over drawer.
 *
 * Owns the behaviour every dialog in the product needs: focus moves in on open
 * and back to the trigger on close, Tab is trapped, Escape closes unless the
 * dialog is mid-save, and the page behind it cannot scroll.
 */
export default function Dialog({
  open,
  title,
  titleId,
  description,
  eyebrow,
  onClose,
  closeDisabled = false,
  closeLabel = "Close",
  variant = "modal",
  wide = false,
  footer,
  children,
  className = "",
  ...props
}) {
  const generatedId = useId();
  const headingId = titleId || `rv-dialog-${generatedId}`;
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const closeDisabledRef = useRef(closeDisabled);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    closeDisabledRef.current = closeDisabled;
    onCloseRef.current = onClose;
  }, [closeDisabled, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !closeDisabledRef.current) {
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll(FOCUSABLE) || [],
      );
      if (!focusable.length) return;
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
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={`rv-overlay ${variant === "drawer" ? "rv-overlay--drawer" : ""}`.trim()}
    >
      {/* Decorative click-away surface. Escape and the Close button provide
          the keyboard paths, so this stays out of the accessibility tree. */}
      <div
        className="rv-overlay__scrim"
        aria-hidden="true"
        onClick={closeDisabled ? undefined : onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={[
          "rv-dialog",
          variant === "drawer" ? "rv-dialog--drawer" : "",
          wide ? "rv-dialog--wide" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...props}
      >
        <header className="rv-dialog__header">
          <div className="rv-fill">
            {eyebrow && <p className="rv-eyebrow">{eyebrow}</p>}
            <h2 className="rv-dialog__title" id={headingId}>
              {title}
            </h2>
            {description && (
              <p className="rv-dialog__description">{description}</p>
            )}
          </div>
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="sm"
            iconOnly
            icon="close"
            aria-label={closeLabel}
            onClick={onClose}
            disabled={closeDisabled}
          />
        </header>
        <div className="rv-dialog__body">{children}</div>
        {footer && <footer className="rv-dialog__footer">{footer}</footer>}
      </div>
    </div>
  );
}
