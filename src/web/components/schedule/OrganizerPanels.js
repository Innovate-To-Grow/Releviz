"use client";

import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { Badge, Callout } from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/Form";
import SegmentedControl from "@/components/ui/Segmented";
import { Eyebrow } from "@/components/ui/Surface";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";

const AVAILABILITY_CHOICES = [
  { label: "Busy", value: 0 },
  { label: "If needed", value: 0.5 },
  { label: "Available", value: 1 },
];

export function OrganizerHeader({
  event,
  onRefresh,
  refreshing = false,
  controls = null,
}) {
  return (
    <header className="rv-page-header rv-page-header--plain rv-event-identity">
      <div className="rv-split">
        <div className="rv-stack rv-stack--sm rv-fill">
          <Eyebrow icon="sliders">Event workspace</Eyebrow>
          <h2 className="rv-event-identity__title">
            {event?.name?.trim() || "Untitled event"}
          </h2>
          {/* Status lives with its lifecycle controls so the workspace never
              shows the same state twice. */}
          {event?.code && (
            <div className="rv-cluster rv-cluster--sm">
              <Badge tone="outline" mono>
                #{event.code}
              </Badge>
            </div>
          )}
        </div>
        <div
          role="group"
          aria-label="Workspace actions"
          className="rv-stack rv-stack--sm"
        >
          {controls}
          <div className="rv-btn-row rv-btn-row--end">
            <Button
              icon="refresh"
              onClick={onRefresh}
              disabled={refreshing}
              busy={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

/**
 * Organizer-side editor for a temporary participant's availability. It shares
 * the same response record as the participant, so the conflict and read-only
 * states are surfaced explicitly rather than silently overwriting.
 */
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
  if (!participant) return null;

  const locked = !responsesOpen || saving || Boolean(conflictParticipant);
  const canSave =
    !saving &&
    responsesOpen &&
    !conflictParticipant &&
    Boolean(participantName.trim());

  return (
    <Dialog
      open
      variant="drawer"
      titleId="managed-drawer-title"
      eyebrow="Temporary participant"
      title={`Edit ${participant.name}'s schedule`}
      description="You and this participant edit the same response. A version conflict will never be silently overwritten."
      closeLabel="Close schedule editor"
      closeDisabled={saving}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSaveDraft} disabled={!canSave} busy={saving}>
            {saving ? "Saving..." : "Save draft"}
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            disabled={!canSave}
            busy={saving}
          >
            {saving ? "Saving..." : "Submit on behalf"}
          </Button>
        </>
      }
    >
      <Field label="Event display name">
        <TextInput
          value={participantName}
          onChange={(changeEvent) =>
            setParticipantName(changeEvent.target.value)
          }
          maxLength={100}
          disabled={!responsesOpen || saving}
        />
      </Field>

      <div className="rv-stack rv-stack--sm">
        <p className="rv-field__label">Mark times as</p>
        <SegmentedControl
          label="Availability status"
          options={AVAILABILITY_CHOICES}
          value={availabilityValue}
          disabled={locked}
          onChange={onAvailabilityValueChange}
        />
      </div>

      <ScheduleChannelEditor
        mode={mode}
        slotGroups={event.slotGroups}
        inperson={inperson}
        virtual={virtual}
        readOnly={locked}
        onInpersonPaint={onInpersonPaint}
        onVirtualPaint={onVirtualPaint}
        onCopy={onCopy}
      />

      {!responsesOpen && (
        <Callout tone="warning" role="note">
          Availability can only be edited while this event is active.
        </Callout>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          <p>{error}</p>
          {conflictParticipant && (
            <Button icon="refresh" onClick={onReloadLatest}>
              Reload latest response
            </Button>
          )}
        </Callout>
      )}
      {status && (
        <Callout tone="success" role="status">
          {status}
        </Callout>
      )}
    </Dialog>
  );
}
