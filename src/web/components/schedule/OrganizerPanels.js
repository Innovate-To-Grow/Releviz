"use client";

import { useEffect, useRef } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import {
  AvailabilityChoice,
  startingAvailabilityValue,
} from "@/components/ui/Availability";
import { SaveIcon, VerifiedIcon } from "@/components/ui/icons";
import StatusBadge from "@/components/ui/StatusBadge";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";

function formatClockTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The live-sync line under the event name: whether new responses are being
 * picked up on their own, and when the workspace last changed because of it.
 * There is no manual refresh; a failed pass is retried on its own. `live` is
 * null while the event is not active (the workspace still syncs then, at a
 * slower pace, but there are no responses to speak of).
 */
export function LiveSyncStatus({ live }) {
  if (!live) return null;
  const paused = Boolean(live.error);
  return (
    <p className="organizer-heading__live small mb-0">
      <StatusBadge
        status={paused ? "warning" : "success"}
        className="organizer-heading__live-badge me-2"
      >
        {paused ? "Live updates paused" : "Live"}
      </StatusBadge>
      {/* Only the state line is announced; the timestamp changes too often
          to be read out every time. */}
      <span role="status" className="text-secondary">
        {paused
          ? `${live.error} Retrying automatically.`
          : "New responses load automatically."}
      </span>
      {live.updatedAt ? (
        <>
          {" "}
          {/* The separator and the time wrap as one unit on narrow screens. */}
          <span className="organizer-heading__live-time text-secondary text-nowrap">
            <span aria-hidden="true">·</span>{" "}
            <time dateTime={new Date(live.updatedAt).toISOString()}>
              Updated {formatClockTime(live.updatedAt)}
            </time>
          </span>
        </>
      ) : null}
    </p>
  );
}

export function OrganizerHeader({ event, controls = null, live = null }) {
  return (
    <header className="organizer-heading page-header">
      <div className="page-header__copy organizer-heading__content">
        <span className="eyebrow organizer-eyebrow">Event workspace</span>
        <h2 className="organizer-title mb-1">
          {event?.name?.trim() || "Untitled event"}
        </h2>
        <LiveSyncStatus live={live} />
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
      </div>
    </header>
  );
}

const CLOSED_NOTE =
  "Availability can only be edited while this event is active.";

/**
 * The organizer's schedule editor for one participant (or for their own
 * row). `responsesOpen` false locks the grid with `lockReason` as the note;
 * `leftOut` locks it because the person is not counted in the results, with
 * `onCountIn` to bring them back; `saved` turns Cancel into Close once a
 * save has landed.
 */
export function ManagedScheduleDrawer({
  event,
  mode,
  participant,
  inperson,
  virtual,
  availabilityValue,
  onAvailabilityValueChange,
  responsesOpen,
  lockReason = CLOSED_NOTE,
  leftOut = false,
  saved = false,
  saving,
  error,
  status,
  conflictParticipant,
  onInpersonPaint,
  onVirtualPaint,
  onCopy,
  onCountIn,
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

  // The organizer's own row: they answer for themselves, under the name on
  // their account, so there is nobody to act for.
  const ownResponse = Boolean(participant.isOrganizer);
  const editingLocked =
    !responsesOpen || leftOut || saving || Boolean(conflictParticipant);
  const actionsLocked = editingLocked;
  // A full account stays organizer-editable only until the person responds
  // themselves; organizer-managed and temporary rows are always shared.
  const fullAccount =
    !participant.organizerManaged && participant.accountAccess === "full";
  const eyebrow = ownResponse
    ? "Your own response"
    : participant.organizerManaged
      ? "Organizer-managed participant"
      : fullAccount
        ? "Full account · not responded yet"
        : "Temporary participant";

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
            <span className="eyebrow">{eyebrow}</span>
            <h2 id="managed-drawer-title">
              {ownResponse
                ? "Edit my schedule"
                : `Edit ${participant.name}'s schedule`}
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
          {ownResponse ? (
            <p className="text-secondary mb-0">
              You answer as {participant.name}, the name on your account. Your
              answers count in the results like everyone else&apos;s.
            </p>
          ) : (
            <p className="text-secondary mb-0">
              {fullAccount
                ? "You can enter this schedule until they join, save, or submit it themselves; after that only they can change it."
                : "You and this participant edit the same response."}
            </p>
          )}

          {leftOut && (
            <Alert
              variant="warning"
              role="status"
              className="managed-drawer__left-out"
              actions={
                <AppButton
                  variant="outlined"
                  onClick={onCountIn}
                  disabled={saving}
                >
                  Count them again
                </AppButton>
              }
            >
              {participant.name} is left out of the results, so their schedule
              can&apos;t change.
            </Alert>
          )}

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
            startingValue={startingAvailabilityValue(event)}
            readOnly={editingLocked}
            onInpersonPaint={onInpersonPaint}
            onVirtualPaint={onVirtualPaint}
            onCopy={onCopy}
            legend={false}
          />

          {!responsesOpen && (
            <Alert variant="warning" role="note">
              {lockReason}
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
            {saved ? "Close" : "Cancel"}
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
            {saving ? "Saving..." : ownResponse ? "Submit" : "Submit on behalf"}
          </AppButton>
        </footer>
      </aside>
    </div>
  );
}
