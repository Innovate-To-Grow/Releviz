"use client";

import { useEffect, useRef } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import { AvailabilityChoice } from "@/components/ui/Availability";
import FormField from "@/components/ui/FormField";
import { RefreshIcon, SaveIcon, VerifiedIcon } from "@/components/ui/icons";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";

export function OrganizerHeader({
  event,
  onRefresh,
  refreshing = false,
  controls = null,
}) {
  return (
    <header className="organizer-heading page-header">
      <div className="page-header__copy organizer-heading__content">
        <span className="eyebrow organizer-eyebrow">Event workspace</span>
        <h2 className="organizer-title mb-1">
          {event?.name?.trim() || "Untitled event"}
        </h2>
      </div>
      {/* The lifecycle badge lives in EventControls (passed as `controls`), so
          the header does not repeat it. `mw-100` lets the action row wrap
          inside narrow viewports instead of overflowing the page. */}
      <div
        className="page-header__actions organizer-heading__actions align-items-start mw-100"
        role="group"
        aria-label="Workspace actions"
      >
        {controls}
        <AppButton
          onClick={onRefresh}
          variant="outlined"
          icon={<RefreshIcon />}
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

  const editingLocked =
    !responsesOpen || saving || Boolean(conflictParticipant);
  const actionsLocked =
    saving ||
    !responsesOpen ||
    Boolean(conflictParticipant) ||
    !participantName.trim();

  return (
    <div className="app-drawer-layer managed-drawer-layer">
      <button
        type="button"
        className="app-drawer-backdrop managed-drawer-backdrop"
        aria-label="Close schedule editor"
        onClick={onClose}
        disabled={saving}
      />
      <aside
        ref={drawerRef}
        className="app-drawer managed-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="managed-drawer-title"
      >
        <header className="app-drawer__header managed-drawer__header">
          <div className="min-w-0">
            <span className="eyebrow">Temporary participant</span>
            <h2 id="managed-drawer-title">
              Edit {participant.name}&apos;s schedule
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn-close managed-drawer__close"
            aria-label="Close schedule editor"
            onClick={onClose}
            disabled={saving}
          />
        </header>

        <div className="app-drawer__body managed-drawer__body">
          <FormField
            label="Event display name"
            help="You and this participant edit the same response. A version conflict will never be silently overwritten."
          >
            <input
              type="text"
              className="form-control"
              value={participantName}
              onChange={(changeEvent) =>
                setParticipantName(changeEvent.target.value)
              }
              maxLength={100}
              disabled={!responsesOpen || saving}
            />
          </FormField>

          <div className="schedule-toolbar__group">
            <p className="schedule-toolbar__label">Mark times as</p>
            <AvailabilityChoice
              label="Availability status"
              value={availabilityValue}
              onChange={onAvailabilityValueChange}
              disabled={editingLocked}
              virtual={mode === "virtual"}
              className="flex-wrap"
            />
          </div>

          <ScheduleChannelEditor
            mode={mode}
            slotGroups={event.slotGroups}
            inperson={inperson}
            virtual={virtual}
            readOnly={editingLocked}
            onInpersonPaint={onInpersonPaint}
            onVirtualPaint={onVirtualPaint}
            onCopy={onCopy}
            legend={false}
          />

          {!responsesOpen && (
            <Alert variant="warning" role="note">
              Availability can only be edited while this event is active.
            </Alert>
          )}
          {error && (
            <Alert
              variant="danger"
              role="alert"
              className="managed-drawer__error"
              actions={
                conflictParticipant ? (
                  <AppButton variant="outlined" onClick={onReloadLatest}>
                    Reload latest response
                  </AppButton>
                ) : null
              }
            >
              <p className="mb-0">{error}</p>
            </Alert>
          )}
          {status && (
            <Alert
              variant="success"
              role="status"
              className="managed-drawer__status"
            >
              {status}
            </Alert>
          )}
        </div>

        <footer className="app-drawer__footer managed-drawer__footer">
          <AppButton variant="outlined" onClick={onClose} disabled={saving}>
            Cancel
          </AppButton>
          <AppButton
            variant="outlined"
            icon={<SaveIcon />}
            onClick={onSaveDraft}
            disabled={actionsLocked}
          >
            {saving ? "Saving..." : "Save draft"}
          </AppButton>
          <AppButton
            variant="filled"
            icon={<VerifiedIcon />}
            onClick={onSubmit}
            disabled={actionsLocked}
          >
            {saving ? "Saving..." : "Submit on behalf"}
          </AppButton>
        </footer>
      </aside>
    </div>
  );
}
