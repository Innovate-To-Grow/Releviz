"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import EmptyState from "@/components/ui/EmptyState";
import FormField from "@/components/ui/FormField";
import Panel from "@/components/ui/Panel";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  ArchiveIcon,
  BestIcon,
  CalendarCheckIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  EditIcon,
  FinalizeIcon,
  GroupIcon,
  ReminderIcon,
  ResultsIcon,
  VirtualIcon,
} from "@/components/ui/icons";
import CreateEventClient from "@/components/event/CreateEventClient";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import BlockedSlotsControls, {
  useBlockedSlotsDraft,
} from "@/components/schedule/BlockedSlotsEditor";
import MeetingCalendar from "@/components/schedule/MeetingCalendar";
import {
  LIVE_REFRESH_ACTIVE_PACE,
  LIVE_REFRESH_BACKSTOP_PACE,
  attachLiveRefreshTriggers,
  createLiveRefreshScheduler,
} from "@/lib/liveRefresh";
import {
  COLUMNS_PER_PAGE,
  dateFromMs,
  formatDate,
  formatWeekLabel,
  formatWindowTimes,
  groupKind,
  localDateOf,
  normalizeSlotGroups,
  rankedRecommendations,
  recommendationForWindow,
  selectionFromRecommendation,
  selectionFromWindow,
  selectionKey,
  selectionMatchesRecommendation,
  startableRows,
  upcomingColumns,
  weekStartOf,
  windowAt,
  windowMetrics,
  windowSlotCount,
} from "@/lib/meetingWindows";
import { createLocalDateTimeResolver } from "@/lib/time";
import {
  confirmFinalMeeting,
  downloadFinalCalendar,
  fetchDeliveryRequest,
  fetchEventResults,
  previewFinalMeeting,
  retryDeliveryRequest,
  sendReminders,
  updateEventLifecycle,
} from "@/lib/api/events";

// "final_confirmation" → "Final confirmation"
function operationLabel(operation) {
  const words = String(operation).replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function deliveryFrom(request) {
  return request?.delivery || request?.summary || {};
}

function deliveryWaiting(delivery) {
  return (
    Number(delivery.pending || 0) +
    Number(delivery.processing || 0) +
    Number(delivery.retry || 0)
  );
}

// The numbers the delivery card shows for a run, which are also what two
// reads of the same run are compared on to tell whether anything moved.
function deliveryCounts(request) {
  const delivery = deliveryFrom(request);
  return {
    total:
      delivery.total ?? delivery.recipientTotal ?? request.recipientCount ?? 0,
    sent: Number(delivery.sent || 0),
    waiting: deliveryWaiting(delivery),
    failed: Number(delivery.permanentFailure || 0),
    canceled: Number(delivery.canceled || 0),
  };
}

// Weekday + date + time without seconds, e.g. "Mon, Sep 14, 2026, 9:00 AM".
function formatInTimezone(value, timezone) {
  const date = new Date(value);
  try {
    return date.toLocaleString([], {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    // An unknown zone name: fall back to the browser's own zone.
    return date.toLocaleString();
  }
}

// Rows across every group of the stored `blockedSlots` map ({ key: [rows] }).
function countBlockedSlots(blockedSlots) {
  if (!blockedSlots || typeof blockedSlots !== "object") return 0;
  return Object.values(blockedSlots).reduce(
    (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
}

// "Edit event" and the Blocked times editor follow one rule: a finalized or
// archived event, or one with a confirmed meeting, is reactivated first.
function editLockOf(event) {
  return {
    locked:
      ["finalized", "archived"].includes(event.status) ||
      Boolean(event.finalMeeting),
    reason: event.finalMeeting
      ? "Reactivate the event before editing a confirmed meeting."
      : `Reactivate this ${event.status} event before editing it.`,
  };
}

// A confirmed meeting that still stands (not cancelled by a reactivation).
function isFinalized(event) {
  const meeting = event.finalMeeting;
  return (
    ["finalized", "archived"].includes(event.status) &&
    Boolean(meeting) &&
    meeting.active !== false
  );
}

/**
 * One collapsible step under the Time Table calendar (Blocked times,
 * Finalize), or one nested in a step (Recommended times, inside Finalize).
 * The heading sits in the summary, so the step keeps its name while closed;
 * with `focusable` it takes programmatic focus (Finalize is focused after a
 * calendar pick), and the summary is always rendered, so that focus can land
 * even before the step is open.
 */
function TimeTableSection({
  id,
  className = "",
  headingId,
  headingLevel = 4,
  title,
  hint,
  open,
  onToggle,
  headingRef,
  focusable = false,
  children,
}) {
  const Heading = `h${headingLevel}`;
  return (
    <details
      id={id}
      className={`disclosure time-table__section ${className}`.trim()}
      aria-labelledby={headingId}
      open={open}
      onToggle={(toggleEvent) => {
        // A nested step's toggle is its own business, not this step's.
        if (toggleEvent.target !== toggleEvent.currentTarget) return;
        onToggle(toggleEvent.currentTarget.open);
      }}
    >
      <summary className="time-table__summary">
        <span className="disclosure__summary-copy">
          <Heading
            id={headingId}
            ref={headingRef}
            tabIndex={focusable ? -1 : undefined}
            className="time-table__section-title"
          >
            {title}
          </Heading>
          <small className="time-table__section-hint">{hint}</small>
        </span>
        <span className="disclosure__chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </summary>
      <div className="disclosure__content time-table__section-content d-flex flex-column gap-3">
        {children}
      </div>
    </details>
  );
}

function ChannelBadge({ channel, className = "" }) {
  const isVirtual = channel === "virtual";
  const Icon = isVirtual ? VirtualIcon : GroupIcon;
  return (
    <StatusBadge status="neutral" dot={false} className={className}>
      <span className="icon-inline" aria-hidden="true">
        <Icon />
      </span>
      {isVirtual ? "Virtual" : "In person"}
    </StatusBadge>
  );
}

function MetricListItem({ value, label }) {
  return (
    <li className="metric-list__item">
      <strong className="metric-list__value">{value}</strong>{" "}
      <span className="metric-list__label">{label}</span>
    </li>
  );
}

// `pushed` says the workspace is being told of changes by the server, and
// `liveVersion` counts the times it has been told to look again: each
// change, and each time the stream opens, since the run may have moved while
// it was down. While pushed, the card re-reads the run on each one instead
// of polling for it.
export function DeliveryRequestProgress({
  initialRequest,
  getToken,
  onChange,
  pushed = false,
  liveVersion = 0,
  ariaLabel = "Delivery progress",
}) {
  const [request, setRequest] = useState(initialRequest || null);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const requestId = request?.id;
  const waiting = deliveryWaiting(deliveryFrom(request)) > 0;
  // The run as shown, for a check to compare its read against, and the check
  // itself, both reached through refs so the scheduler outlives re-renders.
  const requestRef = useRef(request);
  const checkRef = useRef(null);
  // The scheduler while one runs, for a pushed change to wake, and the last
  // `liveVersion` the card acted on: a card mounted mid-session starts from
  // the count it was given rather than reading for changes it never saw.
  const schedulerRef = useRef(null);
  const seenVersionRef = useRef(liveVersion);

  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  // One check of the run on the shared live-refresh pace: re-read it and
  // report whether any count moved.
  const check = useCallback(async () => {
    try {
      const token = await getToken();
      const data = await fetchDeliveryRequest(requestId, token);
      const updated = data.deliveryRequest || data.request || data;
      const moved =
        JSON.stringify(deliveryCounts(updated)) !==
        JSON.stringify(deliveryCounts(requestRef.current));
      setRequest(updated);
      onChange?.(updated);
      setError("");
      return moved ? "changed" : "quiet";
    } catch (requestError) {
      setError(requestError.message || "Unable to refresh delivery progress.");
      return "failed";
    }
  }, [getToken, onChange, requestId]);

  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  // While recipients are still waiting, the card keeps itself current. With
  // the server pushing changes it re-reads on each one and only checks once
  // a minute as a backstop; otherwise it polls, quick while the counts move
  // and easing off while they stall. Either way never while the tab is
  // hidden, and at once when the tab is shown again, the window regains
  // focus, or the network returns. Once everyone is sent or failed there is
  // nothing left to read.
  useEffect(() => {
    if (!requestId || !waiting) return undefined;
    const scheduler = createLiveRefreshScheduler({
      check: () => checkRef.current(),
      pace: pushed ? LIVE_REFRESH_BACKSTOP_PACE : LIVE_REFRESH_ACTIVE_PACE,
    });
    schedulerRef.current = scheduler;
    const detach = attachLiveRefreshTriggers(scheduler, { activity: false });
    scheduler.start();
    return () => {
      detach();
      scheduler.stop();
      schedulerRef.current = null;
    };
  }, [requestId, waiting, pushed]);

  // This effect comes after the scheduler's on purpose. When the stream
  // opens, `pushed` and `liveVersion` change in the same render, and effects
  // run in the order they are declared, so the scheduler at the backstop
  // pace is already in place when this wakes it; the wake then reads the run
  // at once rather than a minute on.
  useEffect(() => {
    if (liveVersion === seenVersionRef.current) return;
    seenVersionRef.current = liveVersion;
    schedulerRef.current?.wake();
  }, [liveVersion]);

  if (!request) return null;
  const counts = deliveryCounts(request);
  const failed = counts.failed;
  const state =
    counts.waiting > 0
      ? { status: "info", label: "In progress" }
      : failed > 0
        ? { status: "warning", label: "Needs attention" }
        : { status: "success", label: "Complete" };

  const retry = async () => {
    setRetrying(true);
    setError("");
    try {
      const token = await getToken();
      const data = await retryDeliveryRequest(request.id, token);
      const updated = data.deliveryRequest || data.request || data;
      setRequest(updated);
      onChange?.(updated);
    } catch (requestError) {
      setError(requestError.message || "Unable to retry failed recipients.");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div role="group" aria-label={ariaLabel} className="delivery-progress">
      <div className="delivery-progress__header">
        <strong>
          {request.operation
            ? `${operationLabel(request.operation)} delivery`
            : "Email delivery"}
        </strong>
        <StatusBadge status={state.status}>{state.label}</StatusBadge>
      </div>
      <ul className="metric-list delivery-progress__metrics">
        <MetricListItem value={counts.total} label="total" />
        <MetricListItem value={counts.sent} label="sent" />
        <MetricListItem value={counts.waiting} label="queued" />
        <MetricListItem value={counts.failed} label="failed" />
        {counts.canceled > 0 && (
          <MetricListItem value={counts.canceled} label="canceled" />
        )}
      </ul>
      {failed > 0 && (
        <div className="delivery-progress__actions">
          <AppButton variant="filled" onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry failed recipients"}
          </AppButton>
        </div>
      )}
      {error && (
        <Alert variant="danger" role="alert">
          {error}
        </Alert>
      )}
    </div>
  );
}

// What each lifecycle state means for responses, shown beside the controls
// from first paint rather than only as a toast after a change.
const LIFECYCLE_SUMMARIES = {
  active: "This event is active and accepting responses.",
  closed: "Responses are now closed.",
  finalized:
    "The meeting is finalized. Reactivate the event to collect new responses.",
  archived: "This event is archived.",
};

export function EventControls({
  event,
  setEvent,
  getToken,
  setDeliveryRequest,
  onReactivated,
}) {
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const reminderKey = useRef("");
  const lifecycleSummary = LIFECYCLE_SUMMARIES[event.status] || "";

  const changeLifecycle = async (nextStatus) => {
    setChanging(true);
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      const responseDeadline =
        nextStatus === "active" &&
        event.responseDeadline &&
        Date.parse(event.responseDeadline) <= Date.now()
          ? null
          : event.responseDeadline || undefined;
      const data = await updateEventLifecycle(
        event.code,
        {
          status: nextStatus,
          expectedVersion: event.version,
          responseDeadline,
        },
        token,
      );
      setEvent(data.event);
      if (nextStatus === "active") onReactivated?.();
      if (data.cancellationDeliveryRequestId) {
        setDeliveryRequest({
          id: data.cancellationDeliveryRequestId,
          operation: "final_cancellation",
          recipientCount: data.cancellationEnqueued || 0,
          delivery: {
            total: data.cancellationEnqueued || 0,
            pending: data.cancellationEnqueued || 0,
          },
        });
      }
    } catch (requestError) {
      setError(requestError.message || "Unable to change the event status.");
    } finally {
      setChanging(false);
    }
  };

  const remind = async () => {
    if (!reminderKey.current) reminderKey.current = crypto.randomUUID();
    setChanging(true);
    setError("");
    try {
      const token = await getToken();
      const data = await sendReminders(
        event.code,
        { idempotencyKey: reminderKey.current },
        token,
      );
      setDeliveryRequest(
        data.deliveryRequest ||
          (data.deliveryRequestId
            ? {
                id: data.deliveryRequestId,
                operation: "reminder",
                recipientCount: data.recipientCount,
                delivery: data.delivery,
              }
            : null),
      );
      setStatus(
        `${data.recipientCount || data.deliveryRequest?.recipientCount || 0} reminder emails were queued.`,
      );
      reminderKey.current = "";
    } catch (requestError) {
      setError(requestError.message || "Unable to queue reminders.");
    } finally {
      setChanging(false);
    }
  };

  return (
    <section
      className="organizer-event-controls d-flex flex-wrap align-items-center gap-2 mw-100"
      aria-labelledby="organizer-lifecycle-title"
    >
      <div className="organizer-event-controls__label d-inline-flex align-items-center gap-2 me-1">
        <StatusBadge
          status={event.status}
          className="organizer-lifecycle-panel__status"
        >
          {event.status || "unknown"}
        </StatusBadge>
        <h3
          id="organizer-lifecycle-title"
          className="small fw-semibold text-secondary mb-0"
        >
          Event controls
        </h3>
      </div>

      {event.status === "active" && (
        <>
          <AppButton
            variant="outlined"
            icon={<ReminderIcon />}
            onClick={remind}
            disabled={changing}
          >
            Queue reminders
          </AppButton>
          <AppButton
            variant="outlined"
            onClick={() => changeLifecycle("closed")}
            disabled={changing}
          >
            Close responses
          </AppButton>
        </>
      )}
      {["closed", "finalized", "archived"].includes(event.status) && (
        <AppButton
          variant="outlined"
          onClick={() => changeLifecycle("active")}
          disabled={changing}
        >
          Reactivate event
        </AppButton>
      )}
      {["active", "closed", "finalized"].includes(event.status) && (
        <AppButton
          variant="outlined"
          icon={<ArchiveIcon />}
          onClick={() => changeLifecycle("archived")}
          disabled={changing}
        >
          Archive event
        </AppButton>
      )}

      <div className="organizer-event-controls__feedback w-100 d-flex flex-column gap-2">
        {lifecycleSummary && (
          <p
            className="organizer-event-controls__lifecycle small text-secondary mb-0"
            role="status"
          >
            {lifecycleSummary}
          </p>
        )}
        {status && (
          <Alert variant="success" role="status" className="py-2">
            {status}
          </Alert>
        )}
        {error && (
          <Alert variant="danger" role="alert" className="py-2">
            {error}
          </Alert>
        )}
      </div>
    </section>
  );
}

export function OverviewPanel({ event, onEventSaved }) {
  const [editing, setEditing] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [saveStatus, setSaveStatus] = useState("");
  const panelRef = useRef(null);
  const editorHeadingRef = useRef(null);
  const { locked: editLocked, reason: editLockReason } = editLockOf(event);

  const focusEditButton = () => {
    window.setTimeout(
      () =>
        panelRef.current
          ?.querySelector(".organizer-overview-edit-link")
          ?.focus(),
      0,
    );
  };

  const openEditor = () => {
    setSaveStatus("");
    setEditingEvent(event);
    setEditing(true);
    window.setTimeout(() => editorHeadingRef.current?.focus(), 0);
  };

  const closeEditor = () => {
    setEditing(false);
    setEditingEvent(null);
    focusEditButton();
  };

  const handleSaved = async (result) => {
    await onEventSaved?.(result);
    setSaveStatus("Event changes saved.");
    closeEditor();
  };

  return (
    <Panel
      ref={panelRef}
      className="organizer-panel organizer-overview-panel"
      headingLevel={3}
      titleId="organizer-overview-heading"
      title="Overview"
      description="Review the event schedule and response settings."
      actions={
        editLocked ? (
          <AppButton
            variant="outlined"
            className="organizer-overview-edit-link"
            icon={<EditIcon />}
            disabled
            title={editLockReason}
          >
            Edit event
          </AppButton>
        ) : (
          <AppButton
            variant="outlined"
            className="organizer-overview-edit-link"
            icon={<EditIcon />}
            onClick={openEditor}
            disabled={editing}
            aria-expanded={editing}
            aria-controls="organizer-inline-event-editor"
          >
            Edit event
          </AppButton>
        )
      }
    >
      <div className="organizer-overview-panel__snapshot">
        <EventDetailsGrid
          event={event}
          variant="organizer"
          extraCards={[
            {
              label: "Access",
              value:
                event.accessMode === "open_link"
                  ? "Anyone with code"
                  : "Invite only",
            },
            {
              label: "Meeting duration",
              value: `${event.meetingDurationMinutes || event.slotMinutes || 30} minutes`,
            },
            { label: "Result revision", value: event.resultsRevision ?? 1 },
          ]}
        />
      </div>
      {saveStatus && (
        <Alert
          variant="success"
          role="status"
          className="organizer-overview-edit-status mt-3"
        >
          {saveStatus}
        </Alert>
      )}
      {editing && editingEvent && (
        <div
          id="organizer-inline-event-editor"
          className="organizer-overview-editor mt-3 p-3 border rounded bg-body-tertiary"
          role="region"
          aria-labelledby="organizer-inline-event-editor-heading"
        >
          <header className="organizer-overview-editor__header mb-3">
            <h4
              id="organizer-inline-event-editor-heading"
              ref={editorHeadingRef}
              tabIndex={-1}
              className="h5 mb-1"
            >
              Edit event
            </h4>
            <p className="text-secondary mb-0">
              Update this event without leaving the workspace.
            </p>
          </header>
          <CreateEventClient
            operation="edit"
            presentation="inline"
            initialEvent={editingEvent}
            onSaved={handleSaved}
            onCancel={closeEditor}
          />
        </div>
      )}
    </Panel>
  );
}

/**
 * Blocked times: the first step under the Time Table calendar. While it is
 * open the calendar is the paint surface for `draft` (see
 * `useBlockedSlotsDraft`) and the panel shows the brush, the feedback and
 * Save in a bar pinned under the calendar; the step itself explains the
 * mode. The panel owns `open` because the calendar's mode follows it.
 */
export function BlockedTimesSection({ event, draft, open, onToggle }) {
  const blockedCount = countBlockedSlots(event.blockedSlots);
  return (
    <TimeTableSection
      id="organizer-blocked-times"
      className="organizer-blocked-times"
      headingId="organizer-blocked-times-heading"
      title="Blocked times"
      hint={
        <>
          {blockedCount} slots blocked
          {draft.dirty && <span> · unsaved changes</span>}
        </>
      }
      open={open}
      onToggle={onToggle}
    >
      <p className="text-secondary mb-0">
        While this step is open, paint on the calendar above to mark the parts
        of each day that are not available for this event. Participants see
        these times greyed out. The brush and Save stay in the bar under the
        calendar.
      </p>
    </TimeTableSection>
  );
}

function resultEnvelope(data) {
  if (!data) return { status: "refreshing", results: null };
  if (data.status) return data;
  return {
    status: "fresh",
    requestedRevision: data.results?.revision,
    computedRevision: data.results?.revision,
    generatedAt: data.results?.generatedAt,
    results: data.results || null,
  };
}

function recommendationKey(recommendation, index) {
  return (
    recommendation.id ||
    `${recommendation.channel || "channel"}:${recommendation.suggestedStartsAt || recommendation.startsAt || recommendation.slotIndex || index}`
  );
}

function percentOf(value) {
  const percent = Number((Number(value) * 100).toFixed(0));
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

// A share as the chips print it: a ranked window always has someone free,
// so a share that rounds to 0 reads "<1", never "0".
function shareOf(value) {
  const percent = percentOf(value);
  return percent === 0 && Number(value) > 0 ? "<1" : String(percent);
}

// A share the API found below `limit` (the floor). Whole percents can round
// it up to the floor's own figure, and so to a listed chip's; one decimal,
// rounded down, keeps it visibly under.
function shareBelow(value, limit) {
  if (percentOf(value) < percentOf(limit)) return shareOf(value);
  return (Math.floor(Number(value) * 1000) / 10).toFixed(1);
}

function defaultChannel(event) {
  return event?.mode === "virtual" ? "virtual" : "inperson";
}

// Why the ranked list is empty, keyed by the API's recommendation status:
// the collapsed hint, then the empty state's title and body.
function emptyRankingCopy({ basis, meetingMinutes, slotMinutes }) {
  switch (basis?.status) {
    case "no_viable_windows":
      return {
        hint: "No time works yet",
        title: "No time works yet",
        body: `${
          basis.zeroWeightOnlyAvailability
            ? `No upcoming ${meetingMinutes}-minute window has anyone with a weight above 0 free for all of it. Some times suit only people weighted 0, who don't count toward the recommendations.`
            : `No upcoming ${meetingMinutes}-minute window has anyone free for all of it.`
        } Ask for more availability, unblock times, or shorten the meeting.`,
      };
    case "no_weighted_responses":
      return {
        hint: "No weighted responses yet",
        title: "No one who counts has responded",
        body: "Everyone counted in the results so far has weight 0, so no time is recommended. Recommendations appear once someone with a weight above 0 is counted.",
      };
    case "no_future_slots":
      return {
        hint: "No upcoming times",
        title: "No upcoming times",
        body: `No upcoming open stretch fits a ${meetingMinutes}-minute meeting: the configured times have passed, are blocked, or leave gaps that are too short.`,
      };
    case "invalid_duration":
      return {
        hint: "Meeting length doesn't fit",
        title: "Meeting length doesn't fit",
        body: `The meeting length must be a whole number of ${slotMinutes}-minute slots.`,
      };
    case "waiting_for_submissions":
      return {
        hint: "Waiting for responses",
        title: "Waiting for responses",
        body: "Recommendations appear once someone included in the results submits availability.",
      };
    default:
      return {
        hint: "No recommendation yet",
        title: "No recommendation yet",
        body: "No valid meeting window is available yet.",
      };
  }
}

// How many windows qualified before the list's ceiling (v2 snapshots).
function qualifyingTotal(basis, count) {
  const total = Number(basis?.qualifyingWindowTotal);
  return Number.isFinite(total) && total > count ? total : count;
}

// The one-line state of the recommended times, shown while collapsed.
function recommendedTimesHint({
  event,
  recommendations,
  basis,
  meetingMinutes,
  loading,
  refreshing,
}) {
  const count = recommendations.length;
  const best = recommendations[0];
  const bestLabel = best
    ? best.label ||
      (best.suggestedStartsAt || best.startsAt
        ? formatInTimezone(
            best.suggestedStartsAt || best.startsAt,
            event.timezone,
          )
        : "")
    : "";
  if (count > 0) {
    const total = qualifyingTotal(basis, count);
    return `${count}${total > count ? ` of ${total}` : ""} recommended${bestLabel ? ` · best ${bestLabel}` : ""}`;
  }
  return loading || refreshing
    ? "Calculating recommendations"
    : emptyRankingCopy({
        basis,
        meetingMinutes,
        slotMinutes: event.slotMinutes,
      }).hint;
}

// What the list holds and why it ends where it does (v2 snapshots only;
// an older snapshot is on screen just until its recompute lands).
function recommendedTimesIntro({ basis, count, meetingMinutes, mixed }) {
  const pointer =
    "Point at one to find it on the calendar; click one to select it.";
  if (!(Number(basis?.ruleVersion) >= 2))
    return `The calendar outlines every recommended time. ${pointer}`;
  const sentences = [
    `We recommend times someone can attend for the whole ${meetingMinutes} minutes, at least half as available as the best, never overlapping${mixed ? " in the same format" : ""}.`,
  ];
  const total = qualifyingTotal(basis, count);
  if (basis.listEnd === "limit")
    sentences.push(`Showing the top ${count} of ${total}.`);
  else if (
    basis.listEnd === "belowFloor" &&
    basis.nextWeightedAvailability != null
  )
    sentences.push(
      `The next option drops to ${shareBelow(basis.nextWeightedAvailability, basis.weightedAvailabilityFloor)}% weighted, under half of the best.`,
    );
  else if (basis.listEnd === "noMoreWindows")
    sentences.push(
      count === 1
        ? "Every other upcoming time overlaps this one or scores 0% weighted."
        : "Every other upcoming time overlaps one of these or scores 0% weighted.",
    );
  // Judged on the share the best chip prints, so the two never disagree.
  if (percentOf(basis.bestWeightedAvailability) < 50)
    sentences.push(
      count === 1
        ? "No time suits even half of the weighted group; this is the closest."
        : "No time suits even half of the weighted group; these are the closest.",
    );
  sentences.push(pointer);
  return sentences.join(" ");
}

/**
 * Recommended times: the API's ranked windows, nested in the Finalize step
 * as the quick way to pick. Collapsed by default; while it is open the
 * calendar outlines the recommended times too (`open` is owned by the panel
 * for that reason, and closing Finalize closes it).
 */
function RecommendedTimesSection({
  event,
  recommendations,
  basis = null,
  meetingMinutes,
  selection,
  loading,
  refreshing,
  open,
  onToggle,
  onChoose,
  onHighlight,
  highlightKey = null,
}) {
  const count = recommendations.length;
  const mixed = event.mode === "mixed";
  // The chip with keyboard focus, by key. Choosing a time keeps focus on its
  // chip; React keeps it there when a live update only re-ranks the list,
  // but a chip that leaves the list takes focus with it, so focus goes to
  // the list's summary instead of the page.
  const focusedKey = useRef(null);
  useEffect(() => {
    const key = focusedKey.current;
    if (!key) return;
    if (
      recommendations.some(
        (recommendation, index) =>
          recommendationKey(recommendation, index) === key,
      )
    )
      return;
    focusedKey.current = null;
    onHighlight?.(null);
    const active = document.activeElement;
    if (!active || active === document.body)
      document.querySelector("#organizer-recommended-times > summary")?.focus();
  }, [recommendations, onHighlight]);
  // One entry per candidate; the chips show rank, window and weighted
  // share, and the detail line under them spells out the rest for the chip
  // under the pointer or focus, else the selected one, else the best.
  const entries = recommendations.map((recommendation, index) => {
    const startsAt =
      recommendation.suggestedStartsAt || recommendation.startsAt;
    const endsAt = recommendation.suggestedEndsAt || recommendation.endsAt;
    return {
      key: recommendationKey(recommendation, index),
      rank: recommendation.rank || index + 1,
      recommendation,
      selected: selectionMatchesRecommendation(selection, recommendation),
      weighted: shareOf(
        recommendation.weightedAvailability ??
          recommendation.weightedScore ??
          0,
      ),
      unweighted: shareOf(
        recommendation.unweightedAvailability ??
          recommendation.unweightedScore ??
          0,
      ),
      fully: recommendation.fullyAvailableParticipantTotal || 0,
      label:
        recommendation.label ||
        (startsAt
          ? formatInTimezone(startsAt, event.timezone)
          : "Recommended time"),
      timeRange:
        startsAt && endsAt
          ? `${formatInTimezone(startsAt, event.timezone)} – ${formatInTimezone(endsAt, event.timezone)}`
          : null,
      channelLabel:
        recommendation.channel === "virtual" ? "Virtual" : "In person",
      ChannelIcon:
        recommendation.channel === "virtual" ? VirtualIcon : GroupIcon,
      isBest: index === 0,
    };
  });
  const empty = emptyRankingCopy({
    basis,
    meetingMinutes,
    slotMinutes: event.slotMinutes,
  });
  const detailed =
    entries.find((entry) => entry.key === highlightKey) ||
    entries.find((entry) => entry.selected) ||
    entries[0];
  return (
    <TimeTableSection
      id="organizer-recommended-times"
      className="organizer-recommended-times time-table__section--nested"
      headingId="organizer-recommended-times-heading"
      headingLevel={5}
      title="Recommended times"
      hint={recommendedTimesHint({
        event,
        recommendations,
        basis,
        meetingMinutes,
        loading,
        refreshing,
      })}
      open={open}
      onToggle={onToggle}
    >
      {count > 0 ? (
        <>
          <p className="ranked-chips__intro text-secondary small mb-0">
            {recommendedTimesIntro({ basis, count, meetingMinutes, mixed })}
          </p>
          <ol className="ranked-chips">
            {entries.map((entry) => {
              const { ChannelIcon } = entry;
              return (
                <li key={entry.key} className="ranked-chips__item">
                  {/* Explicit spaces between the parts: a browser builds the
                      accessible name from the inline text as is. */}
                  <button
                    type="button"
                    className={`ranked-chip${entry.isBest ? " ranked-chip--best" : ""}${entry.selected ? " ranked-chip--selected" : ""}`}
                    aria-pressed={entry.selected}
                    onClick={() => onChoose(entry.recommendation)}
                    onPointerEnter={() => onHighlight?.(entry.key)}
                    onPointerLeave={() => onHighlight?.(null)}
                    onFocus={() => {
                      focusedKey.current = entry.key;
                      onHighlight?.(entry.key);
                    }}
                    onBlur={(blurEvent) => {
                      // A chip removed by a re-render blurs while detached;
                      // the effect above moves its focus.
                      if (!blurEvent.currentTarget.isConnected) return;
                      focusedKey.current = null;
                      onHighlight?.(null);
                    }}
                  >
                    <span className="ranked-chip__rank">#{entry.rank}</span>{" "}
                    {entry.isBest && (
                      <span
                        className="ranked-chip__best icon-inline"
                        aria-hidden="true"
                      >
                        <BestIcon />
                      </span>
                    )}
                    <span className="ranked-chip__title">{entry.label}</span>{" "}
                    {mixed && (
                      <span
                        className="ranked-chip__channel icon-inline"
                        aria-hidden="true"
                      >
                        <ChannelIcon />
                      </span>
                    )}
                    <span className="ranked-chip__share">
                      {entry.weighted}%
                      <span className="visually-hidden"> weighted</span>
                    </span>
                    {entry.selected && (
                      <span
                        className="ranked-chip__check icon-inline"
                        aria-hidden="true"
                      >
                        <CheckIcon />
                      </span>
                    )}
                    <span className="visually-hidden">
                      {`, ${entry.unweighted}% unweighted, ${entry.fully} fully available${mixed ? `, ${entry.channelLabel}` : ""}${entry.isBest ? ", best match" : ""}${entry.selected ? ", selected time" : ", choose this time"}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {detailed && (
            <p
              className="ranked-chips__detail text-secondary small mb-0"
              data-rank={detailed.rank}
            >
              <strong>
                #{detailed.rank} {detailed.label}
              </strong>
              {[
                detailed.timeRange,
                `${detailed.weighted}% weighted`,
                `${detailed.unweighted}% unweighted`,
                `${detailed.fully} fully available`,
                mixed ? detailed.channelLabel : null,
              ]
                .filter(Boolean)
                .map((part) => ` · ${part}`)
                .join("")}
            </p>
          )}
        </>
      ) : loading || refreshing ? (
        <EmptyState
          headingLevel={6}
          className="organizer-empty-state organizer-empty-state--loading"
          icon={
            <span
              className="spinner-border spinner-border-sm"
              aria-hidden="true"
            />
          }
          title="Calculating recommendations"
        >
          <p className="mb-0">
            Recommendations will appear here as responses arrive.
          </p>
        </EmptyState>
      ) : (
        <EmptyState
          headingLevel={6}
          className="organizer-empty-state"
          icon={<ResultsIcon />}
          title={empty.title}
        >
          <p className="mb-0">{empty.body}</p>
        </EmptyState>
      )}
    </TimeTableSection>
  );
}

// Weekly events list their enabled weekdays over this many weeks.
const OTHER_TIMES_WEEKS = 4;

/**
 * The days on which a meeting can still start, for Other times and the
 * Finalize prompt: `{ k, weekly, days, today }`. Weekly events look ahead
 * OTHER_TIMES_WEEKS weeks from the event-local today.
 */
function useStartableDays(event, now) {
  const timeZone = event.timezone || "UTC";
  const groups = useMemo(() => normalizeSlotGroups(event), [event]);
  const k = windowSlotCount(event);
  const resolver = useMemo(() => {
    try {
      return createLocalDateTimeResolver(timeZone);
    } catch (error) {
      return () => {
        throw error;
      };
    }
  }, [timeZone]);
  let today;
  try {
    today = localDateOf(new Date(now).toISOString(), timeZone);
  } catch {
    today = dateFromMs(now);
  }
  // The columns change with the day; which rows can start, with the minute.
  const columns = useMemo(
    () =>
      upcomingColumns({ groups, resolver, today, weeks: OTHER_TIMES_WEEKS }),
    [groups, resolver, today],
  );
  const days = useMemo(
    () => (k < 1 ? [] : startableRows(columns, k, now)),
    [columns, k, now],
  );
  return { k, weekly: groupKind(groups) === "weekday", days, today };
}

// One open time as a chip: its start (the chip's visible name), its full
// local times, the lowest slot's weighted share (an upper bound, as in
// Finalize), its rank when the same time is also recommended, and whether
// it is the current pick.
function otherTimeEntries({
  day,
  k,
  channel,
  results,
  recommendations,
  selectedKey,
}) {
  return day.rows.map((row, index) => {
    const window = windowAt(day.column, row, k);
    const share = windowMetrics(results, channel, window.slotIndices).weighted;
    const recommendation = recommendationForWindow(
      recommendations,
      channel,
      window,
    );
    const times = formatWindowTimes(day.column.slots.slice(row, row + k));
    const [start, end] = times.split("–");
    return {
      row,
      index,
      key: `${day.column.key}:${row}`,
      startsAt: window.startsAt,
      times,
      start,
      end,
      share:
        share == null ? null : share > 0 ? `up to ${shareOf(share)}%` : "0%",
      chipShare: share == null ? null : share > 0 ? shareOf(share) : "0",
      rank: recommendation?.rank ?? null,
      selected:
        selectedKey != null &&
        selectionKey({
          channel,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        }) === selectedKey,
    };
  });
}

function dayLabel(column) {
  return formatDate(column.date, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// The days shown together: a week of a weekly event (yesterday's
// after-midnight times join this week), or one of the calendar's pages of
// seven dates, so the groups match the calendar and stay put as dates pass.
function dayGroups(days, { weekly, today, datePositions }) {
  const groups = [];
  days.forEach((day, index) => {
    const date = day.column.date;
    const key = weekly
      ? weekStartOf(today && date < today ? today : date)
      : Math.floor(
          (datePositions.get(day.column.key) ?? index) / COLUMNS_PER_PAGE,
        );
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.days.push(day);
    else groups.push({ key, days: [day] });
  });
  return groups.map((group) => {
    const first = group.days[0].column.date;
    const final = group.days[group.days.length - 1].column.date;
    return {
      ...group,
      label: weekly
        ? formatWeekLabel(group.key)
        : first === final
          ? formatDate(first, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : `${formatDate(first, { month: "short", day: "numeric" })} – ${formatDate(final, { month: "short", day: "numeric", year: "numeric" })}`,
    };
  });
}

// Arrow keys, Home and End move between the time chips, which share one
// Tab stop (as the calendar grid's cells do).
const TIME_CHIP_KEYS = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Other times: any open meeting time, recommended or not, picked by clicking
 * inside Finalize, the same way as Recommended times: a day (a week, or a
 * calendar page of dates, at a time), then one of its start times as a
 * chip. The times are the windows the calendar lets the organizer pick
 * (`pickable` comes from useStartableDays). A click selects the time like a
 * calendar pick and shows it on the calendar; the chip turns pressed, keeps
 * focus, and the pick is announced. While it is open the calendar shows
 * what it is choosing: `onDayShown(columnKey)` highlights the day listed
 * (null when closed), `onBrowse(target)` takes the calendar to a day the
 * organizer opens here (their own actions only, never a data change), and
 * `onPreview(window)` draws the time under the pointer or focus.
 */
function OtherTimesSection({
  event,
  results,
  recommendations,
  channel,
  onChannelChange,
  pickable,
  meetingMinutes,
  selection,
  open,
  onToggle,
  onPick,
  onPreview,
  onDayShown,
  onBrowse,
}) {
  const [dayKey, setDayKey] = useState(null);
  const [focusKey, setFocusKey] = useState(null);
  const [tabKey, setTabKey] = useState(null);
  // What the status line says, and how many times it has spoken: a repeat
  // of the same words must still change the text to be announced again.
  const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
  const announce = (text) =>
    setAnnouncement((previous) => ({ text, count: previous.count + 1 }));
  const pickKey = selectionKey(selection);
  const [seenPick, setSeenPick] = useState(pickKey);
  if (pickKey !== seenPick) {
    setSeenPick(pickKey);
    // A pick made elsewhere (the calendar, Recommended times) brings the
    // list to its day; one made here leaves the list where it is.
    if (selection?.source !== "picker") setDayKey(null);
  }
  const listRef = useRef(null);
  const dayGroupRef = useRef(null);
  // The time chip with keyboard focus, so focus can move to its neighbour
  // when a clock tick or a refused pick removes it.
  const focusedTime = useRef(null);
  const timeZone = event.timezone || "UTC";
  const mixed = event.mode === "mixed";
  const { k, weekly, days, today } = pickable;
  const total = days.reduce((sum, day) => sum + day.rows.length, 0);
  const slotGroups = useMemo(() => normalizeSlotGroups(event), [event]);
  const datePositions = useMemo(
    () =>
      new Map(
        slotGroups
          .filter((group) => group.kind === "date")
          .map((group, position) => [group.key, position]),
      ),
    [slotGroups],
  );
  const groups = useMemo(
    () => dayGroups(days, { weekly, today, datePositions }),
    [days, weekly, today, datePositions],
  );
  // The pick counts here only in the format shown.
  const selectedKey =
    selection?.startsAt && selection.channel === channel ? pickKey : null;
  const pickedDayKey = useMemo(() => {
    if (!open || !selectedKey) return null;
    const start = Date.parse(selection.startsAt);
    const hit = days.find((day) =>
      day.rows.some(
        (row) => Date.parse(windowAt(day.column, row, k).startsAt) === start,
      ),
    );
    return hit ? hit.column.key : null;
  }, [open, selectedKey, selection, days, k]);
  const day =
    days.find((entry) => entry.column.key === dayKey) ||
    days.find((entry) => entry.column.key === pickedDayKey) ||
    days[0];
  const groupIndex = day
    ? groups.findIndex((group) => group.days.includes(day))
    : -1;
  const group = groups[groupIndex];
  const entries =
    open && day
      ? otherTimeEntries({
          day,
          k,
          channel,
          results,
          recommendations,
          selectedKey,
        })
      : [];
  const tabStop =
    entries.find((entry) => entry.key === tabKey) ||
    entries.find((entry) => entry.selected) ||
    entries[0];
  const detailed =
    entries.find((entry) => entry.key === focusKey) ||
    entries.find((entry) => entry.selected) ||
    entries[0];
  const entryKeys = entries.map((entry) => entry.key).join("|");

  useEffect(() => {
    const focused = focusedTime.current;
    if (!focused) return;
    if (entryKeys.split("|").includes(focused.key)) return;
    focusedTime.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const chips = listRef.current?.querySelectorAll("button") || [];
    const target =
      chips[Math.min(focused.index, chips.length - 1)] ||
      dayGroupRef.current?.querySelector('[aria-pressed="true"]') ||
      document.querySelector("#organizer-other-times > summary");
    target?.focus();
  }, [entryKeys]);

  // The calendar highlights the day listed (a passive mark, no navigation).
  const shownDay = open && day ? day.column.key : null;
  useEffect(() => {
    onDayShown?.(shownDay);
  }, [shownDay, onDayShown]);

  // The time under the pointer or focus, drawn on the calendar. Worked out
  // from the current chips, so it follows a new share and goes away with a
  // chip a clock tick removes; only plain values reach the effect.
  const previewEntry = entries.find((entry) => entry.key === focusKey);
  const previewStartsAt = previewEntry?.startsAt ?? null;
  const previewSlots = previewEntry
    ? windowAt(day.column, previewEntry.row, k).slotIndices.join(",")
    : "";
  const previewGroup = previewEntry ? day.column.groupKey : null;
  const previewLabel = previewEntry
    ? `${previewEntry.start}${previewEntry.chipShare != null ? ` · ${previewEntry.chipShare}%` : ""}`
    : "";
  useEffect(() => {
    onPreview?.(
      previewStartsAt
        ? {
            startsAt: previewStartsAt,
            slotIndices: previewSlots.split(",").map(Number),
            groupKey: previewGroup,
            label: previewLabel,
          }
        : null,
    );
  }, [previewStartsAt, previewSlots, previewGroup, previewLabel, onPreview]);

  // Takes the calendar to a day the organizer opens here, at `row` (else
  // its first open time); says whether the calendar's week or page moved.
  const browseTo = (target, row = target?.rows[0]) => {
    if (!target) return false;
    const window = windowAt(target.column, row, k);
    return Boolean(
      onBrowse?.({
        startsAt: window.startsAt,
        slotIndices: window.slotIndices,
        startDayOffset: target.column.slots[row].startDayOffset,
        groupKey: target.column.groupKey,
      }),
    );
  };

  // Where the list opens: at the pick (in this format), else the first day.
  const openingPlace = () => {
    if (selectedKey) {
      const start = Date.parse(selection.startsAt);
      for (const entry of days) {
        const row = entry.rows.find(
          (candidate) =>
            Date.parse(windowAt(entry.column, candidate, k).startsAt) === start,
        );
        if (row != null) return { day: entry, row };
      }
    }
    return { day: days[0], row: days[0]?.rows[0] };
  };

  const toggle = (next) => {
    onToggle(next);
    if (!next) return;
    // Reopening starts from the day of the pick again, and the calendar
    // goes there too.
    setDayKey(null);
    setFocusKey(null);
    const place = openingPlace();
    browseTo(place.day, place.row);
  };

  const choose = (entry) => {
    const picked = selectionFromWindow({
      column: day.column,
      row: entry.row,
      k,
      channel,
      results,
      event,
      recommendations,
    });
    // onPick refuses a start the clock has passed since the chips were built.
    const accepted = onPick(
      { ...picked, source: "picker" },
      {
        startsAt: picked.startsAt,
        slotIndices: picked.slotIndices,
        startDayOffset: day.column.slots[entry.row].startDayOffset,
        groupKey: day.column.groupKey,
      },
    );
    setTabKey(entry.key);
    announce(
      accepted
        ? `Selected ${dayLabel(day.column)}, ${entry.times}.`
        : "That time has just started. Pick another one.",
    );
  };

  const moveBetweenTimes = (keyDownEvent, entry) => {
    let index = null;
    if (keyDownEvent.key in TIME_CHIP_KEYS)
      index = entry.index + TIME_CHIP_KEYS[keyDownEvent.key];
    else if (keyDownEvent.key === "Home") index = 0;
    else if (keyDownEvent.key === "End") index = entries.length - 1;
    if (index == null) return;
    keyDownEvent.preventDefault();
    const next = entries[Math.max(0, Math.min(entries.length - 1, index))];
    setTabKey(next.key);
    listRef.current?.querySelectorAll("button")[next.index]?.focus();
  };

  const showDaysOf = (index) => {
    if (index < 0 || index >= groups.length) return;
    setDayKey(groups[index].days[0].column.key);
    // The calendar announces its own move; if it stayed put, say it here.
    if (!browseTo(groups[index].days[0]))
      announce(`Showing ${groups[index].label}.`);
  };

  let body = null;
  if (!open) {
    // Nothing until it opens, so no stale message shows while it opens.
  } else if (k < 1) {
    body = (
      <p className="text-secondary small mb-0">
        The meeting length does not divide into the slot length, so no time can
        be picked. Edit the event to fix the duration.
      </p>
    );
  } else if (!day) {
    body = (
      <p className="text-secondary small mb-0">
        {weekly
          ? `No ${meetingMinutes}-minute time can start in the next ${OTHER_TIMES_WEEKS} weeks.`
          : `No upcoming ${meetingMinutes}-minute time can start.`}
      </p>
    );
  } else {
    const atFirst = groupIndex <= 0;
    const atLast = groupIndex >= groups.length - 1;
    body = (
      <>
        <p className="ranked-chips__intro text-secondary small mb-0">
          {weekly
            ? `Any open time in the next ${OTHER_TIMES_WEEKS} weeks, recommended or not (the calendar reaches further).`
            : "Any open time the calendar lets you pick, recommended or not."}{" "}
          Choose a day, then click a start time: each starts a {meetingMinutes}
          -minute meeting. Shares are weighted, from each time&apos;s lowest
          slot; times are in {timeZone}.
        </p>
        {(mixed || groups.length > 1) && (
          <div className="other-times__controls">
            {groups.length > 1 && (
              <div
                role="group"
                aria-label={weekly ? "Week shown" : "Dates shown"}
                className="meeting-calendar__stepper other-times__stepper"
              >
                {/* Ends stay focusable (aria-disabled), so a keyboard user
                    reaching the first or last group keeps their place. */}
                <button
                  type="button"
                  className={`btn btn-outline-secondary app-btn${atFirst ? " other-times__step--end" : ""}`}
                  aria-label="Earlier days"
                  aria-disabled={atFirst}
                  onClick={() => showDaysOf(groupIndex - 1)}
                >
                  <span className="app-btn-icon" aria-hidden="true">
                    <ChevronLeftIcon />
                  </span>
                </button>
                {/* The calendar moves with it and announces its own range. */}
                <span className="meeting-calendar__range-label">
                  {group.label}
                </span>
                <button
                  type="button"
                  className={`btn btn-outline-secondary app-btn${atLast ? " other-times__step--end" : ""}`}
                  aria-label="Later days"
                  aria-disabled={atLast}
                  onClick={() => showDaysOf(groupIndex + 1)}
                >
                  <span className="app-btn-icon" aria-hidden="true">
                    <ChevronRightIcon />
                  </span>
                </button>
              </div>
            )}
            {mixed && (
              <div
                role="group"
                aria-label="Format"
                className="btn-group other-times__format"
              >
                {[
                  ["inperson", "In person"],
                  ["virtual", "Virtual"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`btn ${channel === key ? "btn-primary" : "btn-outline-secondary"}`}
                    aria-pressed={channel === key}
                    onClick={() => {
                      // Stay on the day shown (the calendar is there too).
                      setDayKey(day.column.key);
                      onChannelChange(key);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div
          ref={dayGroupRef}
          role="group"
          aria-label="Day"
          className="day-chips"
        >
          {group.days.map((entry) => {
            const active = entry === day;
            const picked = entry.column.key === pickedDayKey;
            return (
              <button
                key={entry.column.key}
                type="button"
                className={`day-chip${active ? " day-chip--active" : ""}${picked ? " day-chip--picked" : ""}`}
                aria-pressed={active}
                onClick={() => {
                  setDayKey(entry.column.key);
                  setFocusKey(null);
                  browseTo(entry);
                }}
              >
                <span className="day-chip__weekday">
                  {formatDate(entry.column.date, { weekday: "short" })}
                </span>{" "}
                <span className="day-chip__date">
                  {formatDate(entry.column.date, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                {picked && (
                  <>
                    <span className="day-chip__pick" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    <span className="visually-hidden">
                      , has the selected time
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
        <ol
          ref={listRef}
          role="list"
          className="ranked-chips other-times__chips"
          aria-label={`Start times on ${dayLabel(day.column)}`}
        >
          {entries.map((entry) => (
            <li key={entry.key} className="ranked-chips__item">
              {/* The visible start, then (for screen readers) the rest of
                  the name: its end, the day, the rank, the action. */}
              <button
                type="button"
                className={`ranked-chip other-time-chip${entry.rank == null ? " ranked-chip--plain" : ""}${entry.chipShare === "0" ? " ranked-chip--nobody" : ""}${entry.selected ? " ranked-chip--selected" : ""}`}
                aria-pressed={entry.selected}
                tabIndex={entry === tabStop ? 0 : -1}
                onClick={() => choose(entry)}
                onKeyDown={(keyDownEvent) =>
                  moveBetweenTimes(keyDownEvent, entry)
                }
                onPointerEnter={() => setFocusKey(entry.key)}
                onPointerLeave={() => setFocusKey(null)}
                onFocus={() => {
                  focusedTime.current = { key: entry.key, index: entry.index };
                  setFocusKey(entry.key);
                  setTabKey(entry.key);
                }}
                onBlur={(blurEvent) => {
                  // Removed by a re-render: the effect above moves focus.
                  if (!blurEvent.currentTarget.isConnected) return;
                  focusedTime.current = null;
                  setFocusKey(null);
                }}
              >
                {entry.rank != null && (
                  <>
                    <span className="ranked-chip__rank" aria-hidden="true">
                      #{entry.rank}
                    </span>{" "}
                  </>
                )}
                <span className="ranked-chip__title">{entry.start}</span>
                {entry.end && (
                  <span className="visually-hidden">{`–${entry.end}`}</span>
                )}{" "}
                {entry.chipShare != null && (
                  <span className="ranked-chip__share">
                    {entry.chipShare}%
                    <span className="visually-hidden"> weighted</span>
                  </span>
                )}
                {entry.selected && (
                  <span
                    className="ranked-chip__check icon-inline"
                    aria-hidden="true"
                  >
                    <CheckIcon />
                  </span>
                )}
                <span className="visually-hidden">
                  {`, ${dayLabel(day.column)}${entry.rank != null ? `, recommended #${entry.rank}` : ""}${entry.selected ? ", selected time" : ", select this time"}`}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {detailed && (
          <p className="ranked-chips__detail text-secondary small mb-0">
            <strong>
              {dayLabel(day.column)} {detailed.times}
            </strong>
            {[
              detailed.share ? `${detailed.share} weighted` : null,
              detailed.rank != null ? `recommended #${detailed.rank}` : null,
            ]
              .filter(Boolean)
              .map((part) => ` · ${part}`)
              .join("")}
          </p>
        )}
      </>
    );
  }

  return (
    <TimeTableSection
      id="organizer-other-times"
      className="organizer-other-times time-table__section--nested"
      headingId="organizer-other-times-heading"
      headingLevel={5}
      title="Other times"
      hint={
        k < 1
          ? "The meeting length does not fit the slots"
          : total === 0
            ? weekly
              ? `No open time in the next ${OTHER_TIMES_WEEKS} weeks`
              : "No upcoming open time"
            : `${total} open time${total === 1 ? "" : "s"}${weekly ? ` in the next ${OTHER_TIMES_WEEKS} weeks` : ""} · recommended or not`
      }
      open={open}
      onToggle={toggle}
    >
      {body}
      <p className="visually-hidden" role="status">
        {`${announcement.text}${announcement.count % 2 ? "\u00a0" : ""}`}
      </p>
    </TimeTableSection>
  );
}

// What the calendar says (to assistive technology) while it cannot pick.
const PICK_LOCK_FINALIZED =
  "The meeting is finalized. Reactivate the event to pick a different time.";

// What Finalize's empty state asks for: where a time can come from, or why
// none can.
function finalizePrompt({ pickable, recommendedCount }) {
  if (pickable.k < 1)
    return "No time can be picked until the meeting length divides into the slot length. Edit the event to fix it.";
  if (pickable.days.length === 0)
    return "No upcoming time can start. Edit the event's schedule or unblock times to add one.";
  return recommendedCount > 0
    ? "Pick a time on the calendar, or choose a recommended or other time above."
    : "Pick a time on the calendar, or choose one under Other times above.";
}

/**
 * Time Table: the meeting-time calendar (group availability heatmap, any
 * startable cell pickable) with two collapsed steps under it: Blocked times
 * (while it is open the calendar paints blocked times instead of picking,
 * with the tools in a bar pinned under the calendar) and Finalize (which
 * opens itself on a pick). Finalize holds the Recommended times, which also
 * switch the recommended outlines on the calendar on while they are open.
 */
export const ResultsSnapshotPanel = forwardRef(function ResultsSnapshotPanel(
  {
    event,
    setEvent,
    getToken,
    invalidationKey,
    onChoose,
    onSelect,
    onEventSaved,
    pushed = false,
    selection = null,
    headingRef,
    finalizeHeadingRef,
    onDeliveryRequest,
  },
  forwardedRef,
) {
  const [snapshot, setSnapshot] = useState({
    status: "refreshing",
    results: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sectionVisible, setSectionVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState === "visible",
  );
  const [channel, setChannel] = useState(() => defaultChannel(event));
  const [now, setNow] = useState(() => Date.now());
  // Recommended times (inside Finalize) are collapsed by default; the
  // calendar outlines them only while the list is open.
  const [rankedOpen, setRankedOpen] = useState(false);
  // Blocked times is closed by default too; while it is open the calendar
  // paints the draft instead of picking, so the draft lives here, next to
  // the calendar, and survives the step closing.
  const [blockedOpen, setBlockedOpen] = useState(false);
  // The recommended chip under the pointer (or focus), by key, so a live
  // re-rank keeps emphasizing the same time's outline on the calendar.
  const [highlightKey, setHighlightKey] = useState(null);
  // Other times (inside Finalize) is closed by default; while it is open the
  // calendar highlights the day it lists and previews the time pointed at.
  const [otherOpen, setOtherOpen] = useState(false);
  const [pickerDay, setPickerDay] = useState(null);
  const [pickerPreview, setPickerPreview] = useState(null);
  // A finalized meeting locks picking until the event is reactivated: the
  // lists leave Finalize and the calendar only shows the confirmed meeting.
  // Finalizing (here or live, from elsewhere) folds the lists away, so
  // reactivating brings them back closed.
  const finalized = isFinalized(event);
  const [seenFinalized, setSeenFinalized] = useState(finalized);
  if (finalized !== seenFinalized) {
    setSeenFinalized(finalized);
    if (finalized) {
      setRankedOpen(false);
      setOtherOpen(false);
      setPickerPreview(null);
      setHighlightKey(null);
    }
  }

  const { locked: editLocked, reason: editLockReason } = editLockOf(event);
  const blockedDraft = useBlockedSlotsDraft(event, {
    getToken,
    onEventSaved,
    locked: editLocked,
    lockReason: editLockReason,
  });
  const sectionRef = useRef(null);
  const calendarRef = useRef(null);
  // The freshness of the snapshot on screen, for the workspace's live sync to
  // compare against its activity poll. Null until the first successful load.
  const shownRef = useRef(null);

  // A silent load (the workspace's live sync) swaps the snapshot in place:
  // no loading hint, and a failure is reported to the caller, not the panel.
  const load = useCallback(
    async (providedToken, { throwOnError = false, silent = false } = {}) => {
      if (!silent) setLoading(true);
      try {
        const token =
          providedToken === undefined ? await getToken() : providedToken;
        const data = await fetchEventResults(event.code, token);
        const envelope = resultEnvelope(data);
        shownRef.current = {
          status: envelope.status,
          requestedRevision: envelope.requestedRevision ?? null,
          computedRevision: envelope.computedRevision ?? null,
          generatedAt: envelope.generatedAt ?? null,
        };
        setSnapshot(envelope);
        setNow(Date.now());
        setError("");
        return data;
      } catch (requestError) {
        if (!silent)
          setError(requestError.message || "Unable to load results.");
        if (throwOnError) throw requestError;
        return null;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [event.code, getToken],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      refresh: (token, { silent = false } = {}) =>
        load(token, { throwOnError: true, silent }),
      activity: () => shownRef.current,
    }),
    [load],
  );

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [invalidationKey, load]);

  // The calendar and Other times judge which times have passed by `now`:
  // keep it current, once a minute, while the Time Table is on screen.
  const refreshClock = useCallback(() => setNow(Date.now()), []);
  useEffect(() => {
    if (!sectionVisible || !documentVisible) return undefined;
    const timer = setInterval(refreshClock, 60_000);
    return () => clearInterval(timer);
  }, [documentVisible, refreshClock, sectionVisible]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === "undefined") {
      setSectionVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setSectionVisible(entry.isIntersecting),
      { threshold: 0.01 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const updateVisibility = () =>
      setDocumentVisible(document.visibilityState === "visible");
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  // A snapshot still being computed is re-read every couple of seconds
  // while it is in view, unless the server pushes changes to the workspace
  // (`pushed`): its digest pass then reloads the snapshot the moment the
  // worker publishes it. A panel whose last load failed polls as before
  // until one succeeds, though: the digest pass skips a panel that has never
  // shown a snapshot, and reloads one only once the snapshot moves again.
  useEffect(() => {
    if (
      (pushed && !error) ||
      snapshot.status !== "refreshing" ||
      !sectionVisible ||
      !documentVisible
    )
      return undefined;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [documentVisible, error, load, pushed, sectionVisible, snapshot.status]);

  const results = snapshot.results || null;
  // The API decides how many windows are worth listing (at most ten).
  const recommendations = useMemo(
    () => rankedRecommendations(results),
    [results],
  );
  const highlightRank = useMemo(() => {
    const index = recommendations.findIndex(
      (recommendation, position) =>
        recommendationKey(recommendation, position) === highlightKey,
    );
    return index < 0 ? null : recommendations[index].rank || index + 1;
  }, [recommendations, highlightKey]);
  // Snapshots computed before blocking shipped lack the key; the calendar
  // greys cells from `event.slotGroups` either way, so this is only a note.
  const blockedSlotIndices = Array.isArray(results?.blockedSlotIndices)
    ? results.blockedSlotIndices
    : [];
  const meetingMinutes = event.meetingDurationMinutes || event.slotMinutes;
  const mixed = event.mode === "mixed";
  const activeChannel = mixed ? channel : defaultChannel(event);
  const pickable = useStartableDays(event, now);

  // Close unmounts the bar (and the button that had focus), so focus moves
  // to the step's summary, right under the calendar.
  const closeBlockedTimes = useCallback(() => {
    setBlockedOpen(false);
    window.setTimeout(() => {
      document
        .getElementById("organizer-blocked-times")
        ?.querySelector("summary")
        ?.focus();
    }, 0);
  }, []);

  // The recommended times live inside Finalize, so closing Finalize hides
  // them, and their outlines leave the calendar with them.
  const closeRecommendedWithFinalize = useCallback((finalizeOpen) => {
    if (finalizeOpen) return;
    setRankedOpen(false);
    setOtherOpen(false);
    setPickerPreview(null);
  }, []);

  // A picker in Finalize is open (and blocked times are not being painted):
  // the grid shortens and the calendar pins under the section nav where the
  // screen has room, so what is pointed at or chosen shows on it.
  const picking = (rankedOpen || otherOpen) && !blockedOpen;
  // While picking, one rAF-throttled check (on scroll, resize and the
  // calendar resizing) keeps three things current: the calendar's height
  // (the scroll margin that keeps focused controls clear of it), its sticky
  // top (pinned under the nav until the end of the lists reaches its bottom
  // edge, then pushed up and out by them, so it never pops away), and
  // whether the lists are wholly scrolled past (then it unpins, already out
  // of sight). Its box is the same pinned or not, so nothing below moves.
  const [pastLists, setPastLists] = useState(false);
  useEffect(() => {
    if (!picking) return undefined;
    const calendar = sectionRef.current?.querySelector(
      ".meeting-results > .meeting-calendar",
    );
    const lists = document.getElementById("organizer-other-times");
    if (!calendar || !lists) return undefined;
    const root = document.documentElement;
    let frame = null;
    const check = () => {
      frame = null;
      const listsBox = lists.getBoundingClientRect();
      // Without layout (nothing measured) the lists count as in view.
      if (!listsBox.height) {
        setPastLists(false);
        return;
      }
      const rem = parseFloat(window.getComputedStyle(root).fontSize) || 16;
      const height = calendar.getBoundingClientRect().height;
      root.style.setProperty("--rv-pinned-calendar-h", `${height}px`);
      calendar.style.setProperty(
        "--rv-pinned-top",
        `${Math.min(rem * 3.75, listsBox.bottom - height)}px`,
      );
      setPastLists(listsBox.bottom < 0);
    };
    const schedule = () => {
      if (frame == null) frame = window.requestAnimationFrame(check);
    };
    // As it pins, the control that opened the picker may sit under the
    // calendar: bring it out, once, and only if it is actually covered.
    const opening = window.requestAnimationFrame(() => {
      check();
      const active = document.activeElement;
      if (
        !active ||
        !calendar.parentElement.contains(active) ||
        calendar.contains(active)
      )
        return;
      const activeBox = active.getBoundingClientRect();
      const calendarBox = calendar.getBoundingClientRect();
      if (
        activeBox.top < calendarBox.bottom &&
        activeBox.bottom > calendarBox.top
      )
        active.scrollIntoView?.({ block: "nearest" });
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(calendar);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(opening);
      if (frame != null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      root.style.removeProperty("--rv-pinned-calendar-h");
      calendar.style.removeProperty("--rv-pinned-top");
      setPastLists(false);
    };
  }, [picking]);
  const pinned = picking && !pastLists;

  // Other times browses to a day: the calendar shows its week (or page)
  // without moving the grid's tab stop, and says whether it moved. Not while
  // painting: the paint surface stays where the organizer is painting.
  const handleBrowse = useCallback(
    (target) =>
      blockedOpen ? false : Boolean(calendarRef.current?.showWindow(target)),
    [blockedOpen],
  );

  // A time chosen under Other times: selected like a calendar pick and
  // revealed on the calendar (painting would hide it, so painting stops),
  // unless the clock has passed its start since the chips were built; then
  // the chips catch up and it reports false.
  const handlePick = useCallback(
    (picked, revealTarget) => {
      if (Date.parse(picked.startsAt) < Date.now()) {
        refreshClock();
        return false;
      }
      setBlockedOpen(false);
      calendarRef.current?.reveal(revealTarget);
      onSelect?.(picked);
      return true;
    },
    [onSelect, refreshClock],
  );

  const handleChoose = useCallback(
    (recommendation) => {
      // A revealed pick is invisible on the paint surface: leave painting.
      setBlockedOpen(false);
      if (mixed && recommendation.channel) setChannel(recommendation.channel);
      // Reveal the occurrence the workspace will actually select: a stale
      // weekly suggestion moves to its next occurrence, not the suggested
      // week. Reading the clock here is an event, not render.
      const target = selectionFromRecommendation(recommendation, event, {
        now: Date.now(),
      });
      calendarRef.current?.reveal({
        startsAt: target.startsAt,
        slotIndices: recommendation.slotIndices,
        startDayOffset: recommendation.startDayOffset,
        groupKey: recommendation.groupKey,
      });
      onChoose?.(recommendation);
    },
    [event, mixed, onChoose],
  );

  return (
    <Panel
      ref={sectionRef}
      className="organizer-panel organizer-results-panel"
      headingLevel={3}
      headingRef={headingRef}
      headingProps={{ tabIndex: -1 }}
      titleId="organizer-results-heading"
      title="Time Table"
      description={
        blockedOpen
          ? "Marking blocked times: click or drag on the calendar to block or open times, then save with the bar under the calendar."
          : finalized
            ? `Group availability for a ${meetingMinutes}-minute meeting. The meeting is finalized: reactivate the event to pick a different time.`
            : `Group availability for a ${meetingMinutes}-minute meeting. Pick a time on the calendar, or from Recommended times or Other times in Finalize, then confirm it there.`
      }
    >
      <div className="d-flex flex-column gap-3">
        {snapshot.status === "refreshing" && (
          <Alert variant="info" role="status" icon={false}>
            <span className="d-inline-flex align-items-center gap-2">
              <span
                className="spinner-border spinner-border-sm"
                aria-hidden="true"
              />
              <span>
                Results are updating for revision{" "}
                {snapshot.requestedRevision ??
                  event.resultsRevision ??
                  "latest"}
                .
                {snapshot.results
                  ? " Showing the last successful snapshot meanwhile."
                  : ""}
              </span>
            </span>
          </Alert>
        )}
        {snapshot.status === "failed" && (
          <Alert variant="danger" role="alert">
            Result calculation failed. The worker will retry; the last
            successful snapshot remains visible.
          </Alert>
        )}
        {snapshot.status === "fresh" && (
          <Alert variant="secondary" role="status">
            Results are current at revision{" "}
            {snapshot.computedRevision ?? "latest"}
            {snapshot.generatedAt
              ? ` · generated ${new Date(snapshot.generatedAt).toLocaleString()}`
              : ""}
            .
          </Alert>
        )}
        {blockedSlotIndices.length > 0 && (
          <p className="text-secondary small mb-0">
            {blockedSlotIndices.length} blocked slots are excluded from these
            results.
          </p>
        )}

        {/* While a picker in Finalize is open, the calendar stays in view
            (pinned under the section nav where the screen has room), so
            what is pointed at or chosen below shows on it. */}
        <div
          className={`meeting-results${picking ? " meeting-results--picking" : ""}${pinned ? " meeting-results--pinned" : ""}`}
        >
          <MeetingCalendar
            ref={calendarRef}
            event={event}
            results={results}
            channel={activeChannel}
            onChannelChange={setChannel}
            selection={selection}
            onSelect={onSelect}
            now={now}
            showRankedWindows={rankedOpen}
            highlightRank={rankedOpen ? highlightRank : null}
            previewWindow={otherOpen ? pickerPreview : null}
            focusColumn={otherOpen ? pickerDay : null}
            blockedEditing={blockedOpen ? blockedDraft.surface : null}
            pickLock={finalized ? PICK_LOCK_FINALIZED : null}
          />

          {/* While painting, the brush and Save sit right under the calendar
              and stay pinned to the bottom of the screen while the calendar
              is taller than it, so the tools never drift away from the
              surface being painted. */}
          {blockedOpen && (
            <div
              className="time-table__paint-bar"
              role="region"
              aria-label="Blocked times tools"
            >
              <BlockedSlotsControls
                draft={blockedDraft}
                onDone={closeBlockedTimes}
              />
            </div>
          )}

          <div className="time-table__sections">
            <BlockedTimesSection
              event={event}
              draft={blockedDraft}
              open={blockedOpen}
              onToggle={setBlockedOpen}
            />
            <FinalizeScalePanel
              event={event}
              setEvent={setEvent}
              getToken={getToken}
              selection={selection}
              headingRef={finalizeHeadingRef}
              onDeliveryRequest={onDeliveryRequest}
              recommendedCount={recommendations.length}
              emptyPrompt={finalizePrompt({
                pickable,
                recommendedCount: recommendations.length,
              })}
              onOpenChange={closeRecommendedWithFinalize}
              picker={
                finalized ? null : (
                  <>
                    <RecommendedTimesSection
                      event={event}
                      recommendations={recommendations}
                      basis={results?.recommendationBasis || null}
                      meetingMinutes={meetingMinutes}
                      selection={selection}
                      loading={loading}
                      refreshing={snapshot.status === "refreshing"}
                      open={rankedOpen}
                      onToggle={setRankedOpen}
                      onChoose={handleChoose}
                      onHighlight={setHighlightKey}
                      highlightKey={highlightKey}
                    />
                    <OtherTimesSection
                      event={event}
                      results={results}
                      recommendations={recommendations}
                      channel={activeChannel}
                      onChannelChange={setChannel}
                      pickable={pickable}
                      meetingMinutes={meetingMinutes}
                      selection={selection}
                      open={otherOpen}
                      onToggle={setOtherOpen}
                      onPick={handlePick}
                      onPreview={setPickerPreview}
                      onDayShown={setPickerDay}
                      onBrowse={handleBrowse}
                    />
                  </>
                )
              }
            />
          </div>
        </div>

        {error && (
          <Alert variant="danger" role="alert">
            {error}
          </Alert>
        )}
      </div>
    </Panel>
  );
});

// Accepts either a calendar/list selection or a raw recommendation-like
// object ({ channel, startsAt|suggestedStartsAt, endsAt }) so callers and
// tests can pass recommendations straight through.
function normalizeSelection(value, event) {
  if (!value) return null;
  if (value.source && value.metrics) return value;
  return selectionFromRecommendation(value, event);
}

// The one-line state of the Finalize step, shown while it is collapsed.
function finalizeHint(event, selection, recommendedCount = 0) {
  if (isFinalized(event)) {
    return `Finalized · ${formatInTimezone(event.finalMeeting.startsAt, event.timezone)}`;
  }
  if (selection) {
    return `Selected · ${formatInTimezone(selection.startsAt, event.timezone)}`;
  }
  return recommendedCount > 0
    ? `No time selected yet · ${recommendedCount} recommended`
    : "No time selected yet";
}

/**
 * Finalize: the confirmation step, collapsed until a time is picked. A new
 * pick (the workspace hands over a new selection object) opens the step in
 * the same render, so the focus that follows a pick lands on content that
 * is showing; clearing the pick leaves the step as the organizer left it.
 * The disclosure lives outside the keyed content, so a re-pick resets the
 * step's own state without closing it. `picker` (the Recommended times)
 * sits outside the keyed content too: choosing one of them re-keys the
 * content but keeps the list open and the chosen chip focused.
 */
export function FinalizeScalePanel(props) {
  const { event, headingRef, picker = null, onOpenChange } = props;
  const selection = normalizeSelection(props.selection, event);
  const finalized = isFinalized(event);
  const [open, setOpen] = useState(() => Boolean(selection));
  const [seen, setSeen] = useState(props.selection);
  if (props.selection !== seen) {
    setSeen(props.selection);
    if (props.selection) setOpen(true);
  }
  const toggle = (next) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <TimeTableSection
      id="organizer-finalize"
      className="finalize-block"
      headingId="organizer-finalize-heading"
      title="Finalize"
      hint={finalizeHint(event, selection, props.recommendedCount)}
      open={open}
      onToggle={toggle}
      headingRef={headingRef}
      focusable
    >
      <p className="finalize-block__description">
        {finalized
          ? "This meeting is finalized. Reactivate the event to choose a different time."
          : "Confirm the selected time and email calendar invitations."}
      </p>
      {picker}
      <FinalizeScalePanelContent
        key={selectionKey(selection) || "no-selection"}
        {...props}
        selection={selection}
      />
    </TimeTableSection>
  );
}

function FinalizeStepIndicator({ selection, review, finalized }) {
  const hasSelection = Boolean(selection);
  const hasReview = Boolean(review);
  const steps = [
    {
      label: "Select a time",
      done: finalized || hasSelection,
      active: !finalized && !hasSelection,
    },
    {
      label: "Review attendance",
      done: finalized || hasReview,
      active: !finalized && hasSelection && !hasReview,
    },
    {
      label: "Finalize meeting",
      done: finalized,
      active: !finalized && hasReview,
    },
  ];
  return (
    <ol className="step-indicator" aria-label="Finalize steps">
      {steps.map((step) => (
        <li
          key={step.label}
          className={`step-indicator__item${step.done ? " step-indicator__item--done" : ""}${step.active ? " step-indicator__item--active" : ""}`}
          aria-current={step.active ? "step" : undefined}
        >
          {step.label}
        </li>
      ))}
    </ol>
  );
}

function SelectionMetrics({ metrics }) {
  if (!metrics) return null;
  if (metrics.weighted === null && metrics.unweighted === null) {
    return (
      <p className="final-candidate__metrics mb-0">
        No responses have been counted yet.
      </p>
    );
  }
  if (metrics.exact) {
    const parts = [
      `${percentOf(metrics.weighted)}% weighted`,
      `${percentOf(metrics.unweighted)}% unweighted`,
    ];
    if (metrics.fullyAvailableParticipantTotal != null)
      parts.push(`${metrics.fullyAvailableParticipantTotal} fully available`);
    if (metrics.partiallyAvailableParticipantTotal != null)
      parts.push(
        `${metrics.partiallyAvailableParticipantTotal} partially available`,
      );
    if (metrics.unavailableParticipantTotal != null)
      parts.push(`${metrics.unavailableParticipantTotal} unavailable`);
    return <p className="final-candidate__metrics mb-0">{parts.join(" · ")}</p>;
  }
  return (
    <p className="final-candidate__metrics mb-0">
      Up to {percentOf(metrics.weighted)}% weighted ·{" "}
      {percentOf(metrics.unweighted)}% unweighted across this window (its lowest
      slot; people must be free for all of it). Exact attendance counts appear
      after Review attendance.
    </p>
  );
}

const ATTENDANCE_STATUS_LABELS = {
  available: "Fully available",
  partial: "Partly available",
  unavailable: "Not available",
};

const EXCLUSION_REASON_LABELS = {
  organizerExcluded: "Excluded by organizer",
  hidden: "Hidden from results",
  invalidResponse: "Invalid response",
};

// Per-person breakdown behind the attendance count tiles: counted responses
// first, then people who never answered, then anyone left out of results.
function AttendanceReviewTable({ review }) {
  const rows = [
    ...(review.participants || []).map((participant) => ({
      key: `counted:${participant.participantId}`,
      name: participant.name,
      response: "Submitted",
      availability: `${ATTENDANCE_STATUS_LABELS[participant.status]} · ${Math.round(participant.minimumAvailability * 100)}%`,
    })),
    ...(review.unansweredParticipants || []).map((participant) => ({
      key: `unanswered:${participant.participantId}`,
      name: participant.name,
      response: "Not submitted",
      availability: "—",
    })),
    ...(review.excludedParticipants || []).map((participant) => ({
      key: `excluded:${participant.participantId}`,
      name: participant.name,
      response: "Not included",
      availability:
        EXCLUSION_REASON_LABELS[participant.reason] || participant.reason,
    })),
  ];
  if (rows.length === 0) return null;
  return (
    <div
      className="table-responsive attendance-table mt-3"
      role="region"
      aria-label="Attendance by person"
      tabIndex={0}
    >
      <table className="table table-sm align-middle attendance-table__table">
        <caption className="visually-hidden">Attendance by person</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Response</th>
            <th scope="col">Availability</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.name}</th>
              <td>{row.response}</td>
              <td>{row.availability}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function focusIsInFinalize() {
  if (typeof document === "undefined") return false;
  const section = document.getElementById("organizer-finalize");
  return Boolean(section?.contains(document.activeElement));
}

function FinalizeScalePanelContent({
  event,
  setEvent,
  getToken,
  selection,
  onDeliveryRequest,
  emptyPrompt = "Pick a time on the calendar.",
}) {
  const [location, setLocation] = useState(event.location || "");
  const [review, setReview] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const confirmationKey = useRef("");
  // Set by this tab's own successful Finalize meeting (see below).
  const handOffFocus = useRef(false);
  const downloadRef = useRef(null);

  const payload = useMemo(() => {
    if (!selection) return null;
    return {
      startsAt: selection.startsAt,
      endsAt: selection.endsAt,
      channel: selection.channel,
      location: location.trim(),
    };
  }, [location, selection]);

  const preview = async () => {
    if (!payload?.startsAt || !payload?.endsAt) return;
    setReviewing(true);
    setError("");
    try {
      const token = await getToken();
      const data = await previewFinalMeeting(event.code, payload, token);
      setReview(data.attendance || data.finalMeeting?.attendance || null);
      setStatus("Attendance review is current for this candidate.");
    } catch (requestError) {
      setError(requestError.message || "Unable to review this meeting time.");
    } finally {
      setReviewing(false);
    }
  };

  const confirm = async () => {
    if (!review || !payload) return;
    if (!confirmationKey.current) confirmationKey.current = crypto.randomUUID();
    setConfirming(true);
    setError("");
    try {
      const token = await getToken();
      const data = await confirmFinalMeeting(
        event.code,
        {
          ...payload,
          expectedVersion: event.version,
          idempotencyKey: confirmationKey.current,
        },
        token,
      );
      handOffFocus.current = isFinalized(data.event);
      setEvent(data.event);
      setReview(data.finalMeeting?.attendance || review);
      // Invitation delivery is tracked in the workspace banner with every
      // other email run, so it survives re-picks and refreshes.
      const delivery =
        data.deliveryRequest ||
        (data.deliveryRequestId
          ? {
              id: data.deliveryRequestId,
              operation: "final_confirmation",
              delivery: data.delivery,
            }
          : null);
      if (delivery) onDeliveryRequest?.(delivery);
      setStatus(
        "The meeting is finalized and calendar invitations are queued.",
      );
      confirmationKey.current = "";
    } catch (requestError) {
      setError(requestError.message || "Unable to finalize this meeting.");
    } finally {
      setConfirming(false);
    }
  };

  const download = async () => {
    setDownloading(true);
    setError("");
    try {
      const token = await getToken();
      const { blob, filename } = await downloadFinalCalendar(event.code, token);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch (requestError) {
      setError(
        requestError.message || "Unable to download the calendar invitation.",
      );
    } finally {
      setDownloading(false);
    }
  };

  const meeting = event.finalMeeting;
  const canFinalize = ["active", "closed"].includes(event.status);
  const finalized = isFinalized(event);
  // Finalizing swaps the review workspace (and, above it, the Recommended
  // and Other times lists) for the confirmed meeting. Focus that was in
  // Finalize when that happened (this tab's Finalize meeting, or a chip when
  // the meeting was finalized elsewhere) would drop to the page: it moves to
  // the Download button instead. Focus anywhere else is never moved.
  const [seenFinalized, setSeenFinalized] = useState(finalized);
  const [focusWasInside, setFocusWasInside] = useState(false);
  if (finalized !== seenFinalized) {
    setSeenFinalized(finalized);
    // Read before the swap commits: the focused control is still there.
    setFocusWasInside(finalized && focusIsInFinalize());
  }
  useEffect(() => {
    if (!finalized || !(handOffFocus.current || focusWasInside)) return;
    handOffFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) downloadRef.current?.focus();
  }, [finalized, focusWasInside]);

  return (
    <div className="finalize-block__body">
      <FinalizeStepIndicator
        selection={selection}
        review={review}
        finalized={finalized}
      />
      {finalized ? (
        <div className="finalized-meeting">
          <div className="finalized-meeting__summary">
            <strong className="finalized-meeting__time">
              {formatInTimezone(meeting.startsAt, event.timezone)} –{" "}
              {formatInTimezone(meeting.endsAt, event.timezone)}
            </strong>
            <span className="finalized-meeting__meta">
              <span className="icon-inline me-1" aria-hidden="true">
                <CalendarCheckIcon />
              </span>
              {meeting.channel === "virtual" ? "Virtual" : "In person"} ·{" "}
              {meeting.location || "Location TBD"}
            </span>
          </div>
          <div className="finalized-meeting__actions">
            <AppButton
              ref={downloadRef}
              variant="outlined"
              icon={<DownloadIcon />}
              onClick={download}
              disabled={downloading}
            >
              {downloading ? "Preparing…" : "Download calendar (.ics)"}
            </AppButton>
          </div>
        </div>
      ) : selection ? (
        <div className="finalize-block__workspace d-flex flex-column gap-3">
          <div className="final-candidate">
            <div className="final-candidate__heading">
              <strong className="final-candidate__title">
                {selection.label || "Selected window"}
              </strong>
              <ChannelBadge
                channel={selection.channel}
                className="final-candidate__channel"
              />
              {selection.metrics?.rank != null ? (
                <StatusBadge status="primary" dot={false}>
                  Recommended #{selection.metrics.rank}
                </StatusBadge>
              ) : (
                <StatusBadge status="neutral" dot={false}>
                  Custom window
                </StatusBadge>
              )}
            </div>
            <p className="final-candidate__time">
              {formatInTimezone(selection.startsAt, event.timezone)} –{" "}
              {formatInTimezone(selection.endsAt, event.timezone)}{" "}
              <small className="text-secondary">
                ({event.timezone || "UTC"})
              </small>
            </p>
            <SelectionMetrics metrics={selection.metrics} />
            {selection.rescheduled && (
              <p className="final-candidate__note mb-0 mt-1 small text-secondary">
                The suggested date has passed; this uses the next occurrence.
              </p>
            )}
          </div>
          <FormField label="Location or meeting link">
            <input
              type="text"
              className="form-control"
              value={location}
              maxLength={500}
              onChange={(changeEvent) => {
                setLocation(changeEvent.target.value);
                setReview(null);
              }}
            />
          </FormField>
          <div className="finalize-block__actions d-flex flex-wrap gap-2">
            <AppButton
              variant="outlined"
              onClick={preview}
              disabled={!canFinalize || reviewing || confirming}
            >
              {reviewing ? "Reviewing…" : "Review attendance"}
            </AppButton>
            <AppButton
              variant="filled"
              icon={<FinalizeIcon />}
              onClick={confirm}
              disabled={!canFinalize || !review || reviewing || confirming}
            >
              {confirming ? "Finalizing…" : "Finalize meeting"}
            </AppButton>
          </div>
          {!canFinalize && (
            <Alert variant="warning" role="note">
              Reactivate this event before reviewing and finalizing a meeting
              time.
            </Alert>
          )}
        </div>
      ) : (
        <EmptyState
          headingLevel={5}
          className="organizer-empty-state organizer-empty-state--finalize"
          icon={<CalendarIcon />}
          title="No time selected yet"
        >
          <p className="mb-0">{emptyPrompt}</p>
        </EmptyState>
      )}

      {review && (
        <>
          <div
            role="group"
            className="metric-tiles attendance-review mt-3"
            aria-label="Attendance review"
          >
            {[
              ["Available", review.availableParticipantTotal],
              ["Partial", review.partialParticipantTotal],
              ["Unavailable", review.unavailableParticipantTotal],
              ["Unanswered", review.unansweredParticipantTotal],
              ["Excluded", review.excludedParticipantTotal],
            ].map(([label, value]) => (
              <div key={label} className="metric-tile attendance-review__item">
                <span className="metric-tile__label">{label}</span>
                <strong className="metric-tile__value attendance-review__value">
                  {value || 0}
                </strong>
              </div>
            ))}
          </div>
          <AttendanceReviewTable review={review} />
        </>
      )}
      {(status || error) && (
        <div className="d-flex flex-column gap-2 mt-3">
          {status && (
            <Alert variant="success" role="status">
              {status}
            </Alert>
          )}
          {error && (
            <Alert variant="danger" role="alert">
              {error}
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
