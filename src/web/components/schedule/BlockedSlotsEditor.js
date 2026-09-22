"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import { AvailabilitySwatch } from "@/components/ui/Availability";
import { RefreshIcon, SaveIcon } from "@/components/ui/icons";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import { updateEvent } from "@/lib/api/events";
import { reloadPage } from "@/lib/navigation";

const CONFLICT_MESSAGE =
  "The event changed in another session. Reload and try again.";
const DISCARDED_MESSAGE =
  "Unsaved blocked-time marks were discarded because the event changed.";

// The organizer paints with one of two brushes: 1 blocks a slot, 0 opens it.
const MARK_CHOICES = [
  { label: "Blocked", value: 1, swatch: "blocked-paint" },
  { label: "Open", value: 0, swatch: "open" },
];

function groupsOf(event) {
  return Array.isArray(event?.slotGroups) ? event.slotGroups : [];
}

/**
 * What the marks are hydrated from: the event's stored blocks (one mark per
 * slot index) and a key naming the index space they live in (the code, the
 * groups in order with their slot counts, and the blocks themselves). Rows
 * keep their meaning while the key is unchanged (the server keeps stored
 * blocks on the same terms), so unsaved marks can carry over.
 */
function hydrationOf(event) {
  const savedMarks = marksFromEvent(event);
  const geometry = groupsOf(event)
    .map((group) => `${group?.key}:${(group?.slots || []).length}`)
    .join(",");
  return {
    savedMarks,
    key: `${event?.code}|${geometry}|${savedMarks.join("")}`,
  };
}

/**
 * One mark per slot index: 1 where the event currently blocks the slot. The
 * length follows `slotCount`, or the highest slot index when a payload
 * omits it, so the array lines up with participant availability arrays.
 */
function marksFromEvent(event) {
  const slots = groupsOf(event).flatMap((group) => group?.slots || []);
  const blocked = new Set(
    slots.filter((slot) => slot?.blocked === true).map((slot) => slot.index),
  );
  const length =
    Number(event?.slotCount) ||
    slots.reduce((largest, slot) => Math.max(largest, slot.index + 1), 0);
  return Array.from({ length }, (_, index) => (blocked.has(index) ? 1 : 0));
}

// Wire shape: the marked rows of each group (positions within `group.slots`,
// which survive non-geometry edits); groups without marks are dropped.
function serializeMarks(marks, groups) {
  return groups.reduce((blockedSlots, group) => {
    const rows = (group?.slots || []).flatMap((slot, row) =>
      Number(marks[slot.index]) > 0 ? [row] : [],
    );
    if (rows.length > 0) blockedSlots[group.key] = rows;
    return blockedSlots;
  }, {});
}

function marksMatch(first, second) {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

/**
 * Organizer editor for the slots an event blocks. Paints on a `ScheduleGrid`
 * in `blockedEditing` mode and saves the block map through `updateEvent`;
 * the parent stores the returned event, whose blocks then match the marks.
 *
 * `locked` follows the same rule as "Edit event": a finalized or archived
 * event must be reactivated before its blocks change.
 */
export default function BlockedSlotsEditor({
  event,
  onEventSaved,
  locked = false,
  lockReason = "",
}) {
  const { getToken } = useAuth();
  const groups = groupsOf(event);
  const { savedMarks, key: hydrationKey } = useMemo(
    () => hydrationOf(event),
    [event],
  );
  // Unsaved marks survive edits that leave the index space and the stored
  // blocks alone (a name, location or status change bumps `version` too);
  // the fresh version simply flows into the next save. They give way to the
  // stored blocks when the geometry or the blocks change, and on a conflict
  // reload. Adjusting state during render re-hydrates before the stale marks
  // can paint.
  const [reloadCount, setReloadCount] = useState(0);
  const [hydrated, setHydrated] = useState({
    key: hydrationKey,
    reloadCount,
    marks: savedMarks,
  });
  const [marks, setMarks] = useState(savedMarks);
  const [notice, setNotice] = useState("");
  if (hydrated.key !== hydrationKey || hydrated.reloadCount !== reloadCount) {
    // A conflict reload is the organizer's own choice, and the editor's own
    // save stores exactly what was painted; any other change that overwrites
    // marks not yet saved is announced so the loss is not silent.
    const overwritesUnsaved =
      hydrated.reloadCount === reloadCount &&
      !marksMatch(marks, hydrated.marks) &&
      !marksMatch(marks, savedMarks);
    setHydrated({ key: hydrationKey, reloadCount, marks: savedMarks });
    setMarks(savedMarks);
    setNotice(overwritesUnsaved ? DISCARDED_MESSAGE : "");
  }
  const [markValue, setMarkValue] = useState(1);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState(null);

  const dirty = !marksMatch(marks, savedMarks);
  const markedCount = marks.filter((value) => value > 0).length;
  const busy = locked || saving;
  const lockTitle = locked ? lockReason : undefined;

  const clearFeedback = () => {
    setStatus("");
    setFailure(null);
    setNotice("");
  };

  const paint = (index) => {
    clearFeedback();
    setMarks((current) => {
      if (Number(current[index]) === markValue) return current;
      const next = [...current];
      next[index] = markValue;
      return next;
    });
  };

  const clearAll = () => {
    clearFeedback();
    setMarks((current) => current.map(() => 0));
  };

  const save = async () => {
    setSaving(true);
    clearFeedback();
    try {
      const token = await getToken();
      const result = await updateEvent(
        event.code,
        {
          blockedSlots: serializeMarks(marks, groups),
          expectedVersion: event.version,
        },
        token,
      );
      await onEventSaved?.(result);
      setStatus("Blocked times saved.");
    } catch (requestError) {
      // Blocks are not geometry, so a 409 is only ever a version mismatch;
      // anything else (including an unexpected reset demand) shows as is.
      if (requestError.status === 409 && !requestError.requiresResponseReset) {
        setFailure({
          message: CONFLICT_MESSAGE,
          conflict: true,
          conflictEvent: requestError.event || null,
        });
      } else {
        setFailure({
          message: requestError.message || "Failed to save blocked times.",
          conflict: false,
          conflictEvent: null,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadLatest = async () => {
    const conflictEvent = failure?.conflictEvent;
    if (!conflictEvent) {
      reloadPage();
      return;
    }
    setFailure(null);
    // The newer event's blocks replace whatever was painted, even when they
    // happen to match the stale ones.
    setReloadCount((current) => current + 1);
    await onEventSaved?.({ event: conflictEvent });
  };

  return (
    <div className="blocked-slots-editor d-flex flex-column gap-3">
      <div className="schedule-toolbar mb-0">
        <div className="schedule-toolbar__group">
          <p className="schedule-toolbar__label">Mark times as</p>
          <div
            role="group"
            aria-label="Mark times as"
            className="btn-group availability-choice-group"
          >
            {MARK_CHOICES.map((choice) => {
              const active = markValue === choice.value;
              return (
                <button
                  key={choice.label}
                  type="button"
                  className={`btn ${active ? "btn-primary" : "btn-outline-secondary"}`}
                  aria-pressed={active}
                  disabled={locked}
                  onClick={() => setMarkValue(choice.value)}
                >
                  <AvailabilitySwatch level={choice.swatch} />
                  {choice.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="schedule-toolbar__actions">
          <AppButton
            variant="outlined"
            size="sm"
            onClick={clearAll}
            disabled={busy}
            title={lockTitle}
          >
            Clear all
          </AppButton>
        </div>
      </div>

      <ScheduleGrid
        blockedEditing
        schedule={marks}
        slotGroups={groups}
        readOnly={busy}
        onCellPaint={paint}
        ariaLabel="Blocked times"
      />

      {notice && (
        <Alert variant="warning" role="status">
          {notice}
        </Alert>
      )}
      {status && (
        <Alert variant="success" role="status">
          {status}
        </Alert>
      )}
      {failure && (
        <Alert
          variant="danger"
          role="alert"
          actions={
            failure.conflict ? (
              <AppButton
                variant="outlined"
                size="sm"
                icon={<RefreshIcon />}
                onClick={reloadLatest}
              >
                Reload latest event
              </AppButton>
            ) : null
          }
        >
          {failure.message}
        </Alert>
      )}

      <div className="d-flex flex-wrap align-items-center gap-3">
        <AppButton
          icon={<SaveIcon />}
          busy={saving}
          onClick={save}
          disabled={busy || !dirty}
          title={lockTitle}
        >
          {saving ? "Saving…" : "Save blocked times"}
        </AppButton>
        <p className="text-secondary small mb-0">{markedCount} slots marked</p>
      </div>
    </div>
  );
}
