"use client";

import { useEffect, useId, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Narrow side drawer shared by the person, add-person and groups panels: the
 * `.app-drawer` markup from the schedule editor with the same focus trap
 * (Tab cycles inside, Escape closes, focus goes back to the opener on
 * close). While a nested dialog is open (`dialogOpen`) the drawer leaves the
 * keyboard to that dialog.
 */
export default function Drawer({
  title,
  eyebrow = null,
  subtitle = null,
  headerActions = null,
  onClose,
  busy = false,
  dialogOpen = false,
  closeLabel = "Close",
  footer = null,
  className = "",
  bodyClassName = "",
  children,
  ...props
}) {
  const closeButtonRef = useRef(null);
  const drawerRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const stateRef = useRef({ onClose, busy, dialogOpen });
  const titleId = `${useId()}-title`;

  useEffect(() => {
    stateRef.current = { onClose, busy, dialogOpen };
  }, [onClose, busy, dialogOpen]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const initial =
      drawerRef.current?.querySelector("[data-autofocus]") ||
      closeButtonRef.current;
    initial?.focus();
    const handleKeyDown = (keyboardEvent) => {
      const current = stateRef.current;
      if (current.dialogOpen) return;
      if (keyboardEvent.key === "Escape") {
        if (!current.busy) current.onClose();
        return;
      }
      if (keyboardEvent.key !== "Tab") return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll(FOCUSABLE) || [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (keyboardEvent.shiftKey && document.activeElement === first) {
        keyboardEvent.preventDefault();
        last.focus();
      } else if (!keyboardEvent.shiftKey && document.activeElement === last) {
        keyboardEvent.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, []);

  return (
    <div className="app-drawer-layer participants-drawer-layer">
      <button
        type="button"
        className="app-drawer-backdrop"
        aria-label={closeLabel}
        onClick={onClose}
        disabled={busy}
      />
      <aside
        ref={drawerRef}
        className={`app-drawer app-drawer--narrow participants-drawer ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...props}
      >
        <header className="app-drawer__header">
          <div className="min-w-0 flex-grow-1">
            {eyebrow && (
              <div className="participants-drawer__eyebrow">{eyebrow}</div>
            )}
            <h2 id={titleId} className="text-break">
              {title}
            </h2>
            {subtitle && (
              <p className="small text-secondary mb-0 mt-1">{subtitle}</p>
            )}
          </div>
          <div className="d-flex align-items-center gap-2 flex-shrink-0">
            {headerActions}
            <button
              ref={closeButtonRef}
              type="button"
              className="btn-close"
              aria-label={closeLabel}
              onClick={onClose}
              disabled={busy}
            />
          </div>
        </header>
        <div className={`app-drawer__body ${bodyClassName}`.trim()}>
          {children}
        </div>
        {footer && <footer className="app-drawer__footer">{footer}</footer>}
      </aside>
    </div>
  );
}
