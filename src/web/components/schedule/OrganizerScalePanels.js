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
  rankedRecommendations,
  selectionFromRecommendation,
  selectionKey,
  selectionMatchesRecommendation,
} from "@/lib/meetingWindows";
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

export function DeliveryRequestProgress({
  initialRequest,
  getToken,
  onChange,
  ariaLabel = "Delivery progress",
  refreshKey = 0,
}) {
  const [request, setRequest] = useState(initialRequest || null);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const requestId = request?.id;
  const loadRef = useRef(null);

  const load = useCallback(async () => {
    if (!requestId) return;
    try {
      const token = await getToken();
      const data = await fetchDeliveryRequest(requestId, token);
      const updated = data.deliveryRequest || data.request || data;
      setRequest(updated);
      onChange?.(updated);
      setError("");
    } catch (requestError) {
      setError(requestError.message || "Unable to refresh delivery progress.");
    }
  }, [getToken, onChange, requestId]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // The workspace's single Refresh button re-reads delivery progress too.
  useEffect(() => {
    if (refreshKey) loadRef.current?.();
  }, [refreshKey]);

  useEffect(() => {
    if (!request?.id || deliveryWaiting(deliveryFrom(request)) === 0)
      return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load, request]);

  if (!request) return null;
  const delivery = deliveryFrom(request);
  const waiting = deliveryWaiting(delivery);
  const failed = Number(delivery.permanentFailure || 0);
  const total =
    delivery.total ?? delivery.recipientTotal ?? request.recipientCount ?? 0;
  const state =
    waiting > 0
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
        <MetricListItem value={total} label="total" />
        <MetricListItem value={delivery.sent || 0} label="sent" />
        <MetricListItem value={waiting} label="queued" />
        <MetricListItem value={failed} label="failed" />
        {Number(delivery.canceled || 0) > 0 && (
          <MetricListItem value={delivery.canceled} label="canceled" />
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

  useEffect(() => {
    if (snapshot.status !== "refreshing" || !sectionVisible || !documentVisible)
      return undefined;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [documentVisible, load, sectionVisible, snapshot.status]);

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
    if (!finalizeOpen) setRankedOpen(false);
  }, []);

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
          : `Group availability for a ${meetingMinutes}-minute meeting. Pick a time on the calendar or from the recommended times in Finalize, then confirm it there.`
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

        <div className="meeting-results">
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
            blockedEditing={blockedOpen ? blockedDraft.surface : null}
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
              onOpenChange={closeRecommendedWithFinalize}
              picker={
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
        Confirm the selected time and email calendar invitations.
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

function FinalizeScalePanelContent({
  event,
  setEvent,
  getToken,
  selection,
  onDeliveryRequest,
  recommendedCount = 0,
}) {
  const [location, setLocation] = useState(event.location || "");
  const [review, setReview] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const confirmationKey = useRef("");

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
          <p className="mb-0">
            {recommendedCount > 0
              ? "Pick a time on the calendar or choose one of the recommended times above."
              : "Pick a time on the calendar."}
          </p>
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
