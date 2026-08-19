"use client";

import { useEffect, useRef } from "react";
import AppButton from "@/components/ui/AppButton";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";

export function OrganizerHeader({
  event,
  onRefresh,
  refreshing = false,
  controls = null,
}) {
  return (
    <header>
      Event workspace
      <h2>{event?.name?.trim() || "Untitled event"}</h2>
      <div role="group" aria-label="Workspace actions">
        {controls}
        <AppButton
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
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
    <>
      <button
        type="button"
        aria-label="Close schedule editor"
        onClick={onClose}
        disabled={saving}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="managed-drawer-title"
      >
        <header>
          <p>Temporary participant</p>
          <h2 id="managed-drawer-title">
            Edit {participant.name}&apos;s schedule
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close schedule editor"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>
        </header>

        <label>
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
        <p>
          You and this participant edit the same response. A version conflict
          will never be silently overwritten.
        </p>

        <p>Mark times as</p>
        <div role="group" aria-label="Availability status">
          {[
            { label: "Busy", value: 0 },
            { label: "If needed", value: 0.5 },
            { label: "Available", value: 1 },
          ].map((choice) => (
            <AppButton
              key={choice.value}
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
          <p role="note">
            Availability can only be edited while this event is active.
          </p>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            {conflictParticipant && (
              <AppButton onClick={onReloadLatest}>
                Reload latest response
              </AppButton>
            )}
          </div>
        )}
        {status && <p role="status">{status}</p>}

        <footer>
          <AppButton onClick={onClose} disabled={saving}>
            Cancel
          </AppButton>
          <AppButton
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
    </>
  );
}
