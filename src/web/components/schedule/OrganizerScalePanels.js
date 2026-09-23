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
import BlockedSlotsEditor from "@/components/schedule/BlockedSlotsEditor";
import MeetingCalendar from "@/components/schedule/MeetingCalendar";
import {
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
  const blockedCount = countBlockedSlots(event.blockedSlots);
  // Open on the page the organizer lands on right after creating the event
  // (no blocks yet); decided once, so saving blocks does not collapse it.
  const [blockedTimesOpen, setBlockedTimesOpen] = useState(
    () => blockedCount === 0,
  );
  const panelRef = useRef(null);
  const editorHeadingRef = useRef(null);
  const editLocked =
    ["finalized", "archived"].includes(event.status) ||
    Boolean(event.finalMeeting);
  const editLockReason = event.finalMeeting
    ? "Reactivate the event before editing a confirmed meeting."
    : `Reactivate this ${event.status} event before editing it.`;

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
      <details
        className="disclosure organizer-blocked-times mt-3"
        aria-labelledby="organizer-blocked-times-heading"
        open={blockedTimesOpen}
        onToggle={(toggleEvent) =>
          setBlockedTimesOpen(toggleEvent.currentTarget.open)
        }
      >
        <summary className="organizer-blocked-times__summary">
          <span className="disclosure__summary-copy">
            <h4
              id="organizer-blocked-times-heading"
              className="h6 fw-semibold mb-0"
            >
              Blocked times
            </h4>
            <small className="text-secondary d-block">
              {blockedCount} slots blocked
            </small>
          </span>
          <span className="disclosure__chevron" aria-hidden="true">
            <ChevronDownIcon />
          </span>
        </summary>
        <div className="disclosure__content d-flex flex-column gap-3">
          <p className="text-secondary mb-0">
            Mark the parts of each day that are not available for this event.
            Participants see these times greyed out.
          </p>
          <BlockedSlotsEditor
            event={event}
            onEventSaved={onEventSaved}
            locked={editLocked}
            lockReason={editLockReason}
          />
        </div>
      </details>
    </Panel>
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

function defaultChannel(event) {
  return event?.mode === "virtual" ? "virtual" : "inperson";
}

function RankedWindowsRail({
  event,
  recommendations,
  selection,
  loading,
  refreshing,
  onChoose,
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
  const hint =
    count > 0
      ? `${count} candidate${count === 1 ? "" : "s"}${bestLabel ? ` · best ${bestLabel}` : ""}`
      : loading || refreshing
        ? "Calculating the best options"
        : "No recommendation yet";

  return (
    <aside
      className="meeting-results__rail"
      aria-labelledby="organizer-ranked-windows-heading"
    >
      {/* Collapsed by default: the calendar already draws every ranked
          window, so the list is a detail the organizer opens on demand. */}
      <details className="disclosure meeting-results__rail-disclosure">
        <summary className="meeting-results__rail-summary">
          <span className="disclosure__summary-copy">
            <h4
              id="organizer-ranked-windows-heading"
              className="meeting-results__rail-title"
            >
              Ranked windows
            </h4>
            <small className="meeting-results__rail-hint">{hint}</small>
          </span>
          <span className="disclosure__chevron" aria-hidden="true">
            <ChevronDownIcon />
          </span>
        </summary>
        <div className="disclosure__content meeting-results__rail-content">
          {count > 0 ? (
            <ol className="results-list results-list--compact">
              {recommendations.map((recommendation, index) => {
                const key = recommendationKey(recommendation, index);
                const selected = selectionMatchesRecommendation(
                  selection,
                  recommendation,
                );
                const weighted =
                  recommendation.weightedAvailability ??
                  recommendation.weightedScore ??
                  0;
                const unweighted =
                  recommendation.unweightedAvailability ??
                  recommendation.unweightedScore ??
                  0;
                const startsAt =
                  recommendation.suggestedStartsAt || recommendation.startsAt;
                const endsAt =
                  recommendation.suggestedEndsAt || recommendation.endsAt;
                const isBest = index === 0;
                return (
                  <li
                    key={key}
                    className={`result-option result-option--compact${isBest ? " result-option--best" : ""}${selected ? " result-option--selected" : ""}`}
                  >
                    <div className="result-option__content">
                      <div className="result-option__heading">
                        <span className="result-option__rank">
                          #{recommendation.rank || index + 1}
                        </span>
                        <strong className="result-option__title">
                          {recommendation.label ||
                            (startsAt
                              ? formatInTimezone(startsAt, event.timezone)
                              : "Candidate window")}
                        </strong>
                        <ChannelBadge channel={recommendation.channel} />
                        {isBest && (
                          <StatusBadge status="primary" dot={false}>
                            <span className="icon-inline" aria-hidden="true">
                              <BestIcon />
                            </span>
                            Best match
                          </StatusBadge>
                        )}
                      </div>
                      {startsAt && endsAt && (
                        <small className="result-option__time">
                          {formatInTimezone(startsAt, event.timezone)} –{" "}
                          {formatInTimezone(endsAt, event.timezone)}
                        </small>
                      )}
                      <dl className="result-option__metrics">
                        <div className="result-option__metric">
                          <dt>Weighted</dt>
                          <dd>{`${percentOf(weighted)}% weighted`}</dd>
                        </div>
                        <div className="result-option__metric">
                          <dt>Unweighted</dt>
                          <dd>{`${percentOf(unweighted)}% unweighted`}</dd>
                        </div>
                        <div className="result-option__metric">
                          <dt>Participants</dt>
                          <dd>{`${recommendation.fullyAvailableParticipantTotal || 0} fully available`}</dd>
                        </div>
                      </dl>
                    </div>
                    <div className="result-option__actions">
                      <AppButton
                        variant={selected ? "filled" : "outlined"}
                        icon={selected ? <CheckIcon /> : null}
                        aria-pressed={selected}
                        onClick={() => onChoose(recommendation)}
                      >
                        {selected ? "Selected time" : "Choose this time"}
                      </AppButton>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : loading || refreshing ? (
            <EmptyState
              headingLevel={5}
              className="organizer-empty-state organizer-empty-state--loading"
              icon={
                <span
                  className="spinner-border spinner-border-sm"
                  aria-hidden="true"
                />
              }
              title="Calculating the best options"
            >
              <p className="mb-0">
                Recommendations will appear here as responses arrive.
              </p>
            </EmptyState>
          ) : (
            <EmptyState
              headingLevel={5}
              className="organizer-empty-state"
              icon={<ResultsIcon />}
              title="No recommendation yet"
            >
              <p className="mb-0">No valid meeting window is available yet.</p>
            </EmptyState>
          )}
        </div>
      </details>
    </aside>
  );
}

/**
 * Results: the meeting-time calendar (group availability heatmap with the
 * ranked windows drawn on it, any startable cell pickable) beside a side
 * column holding the collapsible ranked list and the Finalize step, so a
 * pick and its confirmation stay on one screen.
 */
export const ResultsSnapshotPanel = forwardRef(function ResultsSnapshotPanel(
  {
    event,
    setEvent,
    getToken,
    invalidationKey,
    onChoose,
    onSelect,
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
  const recommendations = (results?.recommendations || []).slice(0, 10);
  // Snapshots computed before blocking shipped lack the key; the calendar
  // greys cells from `event.slotGroups` either way, so this is only a note.
  const blockedSlotIndices = Array.isArray(results?.blockedSlotIndices)
    ? results.blockedSlotIndices
    : [];
  const meetingMinutes = event.meetingDurationMinutes || event.slotMinutes;
  const mixed = event.mode === "mixed";
  const activeChannel = mixed ? channel : defaultChannel(event);

  const handleChoose = useCallback(
    (recommendation) => {
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
      title="Results"
      description={`Top continuous windows for a ${meetingMinutes}-minute meeting. Pick any window on the calendar or choose a ranked one, then confirm it in Finalize.`}
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
          />

          <div className="meeting-results__side">
            <RankedWindowsRail
              event={event}
              recommendations={recommendations}
              selection={selection}
              loading={loading}
              refreshing={snapshot.status === "refreshing"}
              onChoose={handleChoose}
            />
            <FinalizeScalePanel
              event={event}
              setEvent={setEvent}
              getToken={getToken}
              selection={selection}
              headingRef={finalizeHeadingRef}
              onDeliveryRequest={onDeliveryRequest}
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

export function FinalizeScalePanel(props) {
  const selection = normalizeSelection(props.selection, props.event);
  return (
    <FinalizeScalePanelContent
      key={selectionKey(selection) || "no-selection"}
      {...props}
      selection={selection}
    />
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
      At least {percentOf(metrics.weighted)}% weighted ·{" "}
      {percentOf(metrics.unweighted)}% unweighted across this window (lowest
      slot). Exact attendance counts appear after Review attendance.
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
  headingRef,
  onDeliveryRequest,
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
  const finalized =
    ["finalized", "archived"].includes(event.status) &&
    Boolean(meeting) &&
    meeting.active !== false;

  return (
    <section
      id="organizer-finalize"
      className="finalize-block"
      aria-labelledby="organizer-finalize-heading"
    >
      <div className="finalize-block__header">
        <h4
          id="organizer-finalize-heading"
          ref={headingRef}
          tabIndex={-1}
          className="finalize-block__title"
        >
          Finalize
        </h4>
        <p className="finalize-block__description">
          Confirm the selected window and email calendar invitations.
        </p>
      </div>
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
                  Ranked #{selection.metrics.rank}
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
            Pick a window on the calendar or choose a ranked one.
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
    </section>
  );
}
