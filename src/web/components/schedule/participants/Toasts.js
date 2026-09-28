"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";

const AUTO_DISMISS_MS = 6000;

/**
 * Toast list for the Participants section. Success and info toasts fade
 * after six seconds; failures stay until dismissed (`sticky` overrides
 * either way).
 */
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());
  const counterRef = useRef(0);

  const dismiss = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    ({ tone = "info", message, action = null, sticky } = {}) => {
      counterRef.current += 1;
      const id = `toast-${counterRef.current}`;
      const stays = sticky ?? tone === "danger";
      setToasts((current) => [
        ...current,
        { id, tone, message, action, sticky: stays },
      ]);
      if (!stays) {
        timersRef.current.set(
          id,
          setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

export function ToastRegion({ toasts, onDismiss }) {
  return (
    <div
      className="participants-toasts"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <Alert
          key={toast.id}
          variant={toast.tone}
          role={toast.tone === "danger" ? "alert" : "status"}
          className="participants-toast shadow"
          actions={
            <>
              {toast.action && (
                <AppButton
                  variant="text"
                  size="sm"
                  className="p-0"
                  onClick={toast.action.onClick}
                >
                  {toast.action.label}
                </AppButton>
              )}
              <button
                type="button"
                className="btn-close participants-toast__close"
                aria-label="Dismiss"
                onClick={() => onDismiss(toast.id)}
              />
            </>
          }
        >
          {toast.message}
        </Alert>
      ))}
    </div>
  );
}
