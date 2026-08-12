"use client";

import { useEffect, useRef } from "react";
import { GoVerified } from "react-icons/go";
import { MdClose, MdRefresh, MdSave } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";

function formatStatus(status) {
  const normalized = status || "draft";
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function OrganizerHeader({ event, onRefresh }) {
  const status = event?.status || "draft";
  const statusClass = status.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const meetingDuration =
    event?.meetingDurationMinutes || event?.slotMinutes || 30;

  return (
    <header className="organizer-heading">
      <div className="organizer-heading__content">
        <span className="organizer-eyebrow">Event workspace</span>
        <h2 className="organizer-title">Organizer Dashboard</h2>
        <p>Manage participants and find the best meeting time.</p>
        <div className="organizer-heading__meta" aria-label="Event summary">
          <span
            className={`organizer-status organizer-status--${statusClass}`}
            aria-label={`Event status: ${formatStatus(status)}`}
          >
            {formatStatus(status)}
          </span>
          <span className="organizer-heading__meta-item">
            {event?.timezone || "UTC"} timezone
          </span>
          <span className="organizer-heading__meta-item">
            {meetingDuration}-minute meeting
          </span>
        </div>
      </div>
      <div className="organizer-heading__actions">
        <AppButton onClick={onRefresh} variant="outlined" icon={<MdRefresh />}>
          Refresh
        </AppButton>
      </div>
    </header>
  );
}

export function ManagedScheduleDrawer({
  event,
  mode,
  participant,
  participantName,
  setParticipantName,
  inperson,
  virtual,
  availabilityValue,
  onAvailabilityValueChange,
  responsesOpen,
  saving,
  error,
  status,
  conflictParticipant,
  onInpersonPaint,
  onVirtualPaint,
  onCopy,
  onSaveDraft,
  onSubmit,
  onReloadLatest,
  onClose,
}) {
  const closeButtonRef = useRef(null);
  const drawerRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const savingRef = useRef(saving);
  const onCloseRef = useRef(onClose);
  const participantId = participant?.id;

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!participantId) return undefined;
    restoreFocusRef.current = document.activeElement;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (keyboardEvent) => {
      if (keyboardEvent.key === "Escape" && !savingRef.current) {
        onCloseRef.current();
        return;
      }
      if (keyboardEvent.key !== "Tab") return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) || [],
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
  }, [participantId]);

  if (!participant) return null;

  return (
    <div className="managed-drawer-layer">
      <button
        type="button"
        className="managed-drawer-backdrop"
        aria-label="Close schedule editor"
        onClick={onClose}
        disabled={saving}
      />
      <aside
        ref={drawerRef}
        className="managed-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="managed-drawer-title"
      >
        <header className="managed-drawer__header">
          <div>
            <p>Temporary participant</p>
            <h2 id="managed-drawer-title">
              Edit {participant.name}&apos;s schedule
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="managed-drawer__close"
            aria-label="Close schedule editor"
            onClick={onClose}
            disabled={saving}
          >
            <MdClose aria-hidden="true" />
          </button>
        </header>

        <div className="managed-drawer__body">
          <label className="managed-drawer__name">
            <span>Event display name</span>
            <input
              value={participantName}
              onChange={(changeEvent) =>
                setParticipantName(changeEvent.target.value)
              }
              maxLength={100}
              disabled={!responsesOpen || saving}
            />
          </label>
          <p className="managed-drawer__hint">
            You and this participant edit the same response. A version conflict
            will never be silently overwritten.
          </p>

          <div>
            <p className="managed-drawer__hint">Mark times as</p>
            <div
              className="managed-drawer__choices"
              role="group"
              aria-label="Availability status"
            >
              {[
                { label: "Busy", value: 0 },
                { label: "If needed", value: 0.5 },
                { label: "Available", value: 1 },
              ].map((choice) => (
                <AppButton
                  key={choice.value}
                  variant={
                    availabilityValue === choice.value ? "filled" : "outlined"
                  }
                  aria-pressed={availabilityValue === choice.value}
                  disabled={
                    !responsesOpen || saving || Boolean(conflictParticipant)
                  }
                  onClick={() => onAvailabilityValueChange(choice.value)}
                >
                  {choice.label}
                </AppButton>
              ))}
            </div>
          </div>

          <ScheduleChannelEditor
            mode={mode}
            slotGroups={event.slotGroups}
            inperson={inperson}
            virtual={virtual}
            readOnly={!responsesOpen || saving || Boolean(conflictParticipant)}
            onInpersonPaint={onInpersonPaint}
            onVirtualPaint={onVirtualPaint}
            onCopy={onCopy}
          />

          {!responsesOpen && (
            <p className="managed-participants__error" role="note">
              Availability is locked while this event is finalized or archived.
            </p>
          )}
          {error && (
            <div className="managed-drawer__error" role="alert">
              <p>{error}</p>
              {conflictParticipant && (
                <AppButton variant="outlined" onClick={onReloadLatest}>
                  Reload latest response
                </AppButton>
              )}
            </div>
          )}
          {status && (
            <p className="managed-drawer__status" role="status">
              {status}
            </p>
          )}
        </div>

        <footer className="managed-drawer__footer">
          <AppButton variant="outlined" onClick={onClose} disabled={saving}>
            Cancel
          </AppButton>
          <AppButton
            variant="outlined"
            icon={<MdSave />}
            onClick={onSaveDraft}
            disabled={
              saving ||
              !responsesOpen ||
              Boolean(conflictParticipant) ||
              !participantName.trim()
            }
          >
            {saving ? "Saving..." : "Save draft"}
          </AppButton>
          <AppButton
            icon={<GoVerified />}
            onClick={onSubmit}
            disabled={
              saving ||
              !responsesOpen ||
              Boolean(conflictParticipant) ||
              !participantName.trim()
            }
          >
            {saving ? "Saving..." : "Submit on behalf"}
          </AppButton>
        </footer>
      </aside>
    </div>
  );
}
