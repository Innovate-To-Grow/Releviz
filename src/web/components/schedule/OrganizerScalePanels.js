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
  DownloadIcon,
  EditIcon,
  FinalizeIcon,
  GroupIcon,
  RefreshIcon,
  ReminderIcon,
  ResultsIcon,
  VirtualIcon,
} from "@/components/ui/icons";
import CreateEventClient from "@/components/event/CreateEventClient";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
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
}) {
  const [request, setRequest] = useState(initialRequest || null);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const requestId = request?.id;

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
      <div className="delivery-progress__actions">
        <AppButton
          variant="outlined"
          icon={<RefreshIcon />}
          onClick={load}
          disabled={retrying}
        >
          Refresh progress
        </AppButton>
        {failed > 0 && (
          <AppButton variant="filled" onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry failed recipients"}
          </AppButton>
        )}
      </div>
      {error && (
        <Alert variant="danger" role="alert">
          {error}
        </Alert>
      )}
    </div>
  );
}

export function EventControls({
  event,
  setEvent,
  getToken,
  setDeliveryRequest,
}) {
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const reminderKey = useRef("");

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
      setStatus(
        nextStatus === "active"
          ? "This event is active and accepting responses."
          : nextStatus === "closed"
            ? "Responses are now closed."
            : nextStatus === "archived"
              ? "Event archived."
              : `Event is now ${nextStatus}.`,
      );
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

      {(status || error) && (
        <div className="organizer-event-controls__feedback w-100 d-flex flex-column gap-2">
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
      )}
    </section>
  );
}

export function OverviewPanel({ event, onEventSaved }) {
  const [editing, setEditing] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [saveStatus, setSaveStatus] = useState("");
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

/**
 * Results: the meeting-time calendar (group availability heatmap with the
 * ranked windows drawn on it, any startable cell pickable) plus a compact
 * side list of the ranked windows.
 */
export const ResultsSnapshotPanel = forwardRef(function ResultsSnapshotPanel(
  {
    event,
    getToken,
    invalidationKey,
    onChoose,
    onSelect,
    selection = null,
    headingRef,
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

  const load = useCallback(
    async (providedToken, { throwOnError = false } = {}) => {
      setLoading(true);
      try {
        const token =
          providedToken === undefined ? await getToken() : providedToken;
        const data = await fetchEventResults(event.code, token);
        setSnapshot(resultEnvelope(data));
        setNow(Date.now());
        setError("");
        return data;
      } catch (requestError) {
        setError(requestError.message || "Unable to load results.");
        if (throwOnError) throw requestError;
        return null;
      } finally {
        setLoading(false);
      }
    },
    [event.code, getToken],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      refresh: (token) => load(token, { throwOnError: true }),
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
      description={`Top continuous windows for a ${meetingMinutes}-minute meeting. Pick any window on the calendar or choose a ranked one.`}
      actions={
        <AppButton
          variant="outlined"
          icon={<RefreshIcon />}
          onClick={() => load()}
          disabled={loading}
        >
          Refresh results
        </AppButton>
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

          <aside
            className="meeting-results__rail"
            aria-labelledby="organizer-ranked-windows-heading"
          >
            <h4
              id="organizer-ranked-windows-heading"
              className="meeting-results__rail-title"
            >
              Ranked windows
            </h4>
            {recommendations.length > 0 ? (
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
                  const best = index === 0;
                  return (
                    <li
                      key={key}
                      className={`result-option result-option--compact${best ? " result-option--best" : ""}${selected ? " result-option--selected" : ""}`}
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
                          {best && (
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
                          onClick={() => handleChoose(recommendation)}
                        >
                          {selected ? "Selected time" : "Choose this time"}
                        </AppButton>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : loading || snapshot.status === "refreshing" ? (
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
                <p className="mb-0">
                  No valid meeting window is available yet.
                </p>
              </EmptyState>
            )}
          </aside>
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

function FinalizeScalePanelContent({
  event,
  setEvent,
  getToken,
  selection,
  onBrowseResults,
  headingRef,
}) {
  const [location, setLocation] = useState(event.location || "");
  const [review, setReview] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [deliveryRequest, setDeliveryRequest] = useState(null);
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
      setDeliveryRequest(
        data.deliveryRequest ||
          (data.deliveryRequestId
            ? {
                id: data.deliveryRequestId,
                operation: "final_confirmation",
                delivery: data.delivery,
              }
            : null),
      );
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
    <div className="organizer-panel-stack d-flex flex-column gap-3">
      <Panel
        className="organizer-panel organizer-finalize-panel"
        headingLevel={3}
        headingRef={headingRef}
        headingProps={{ tabIndex: -1 }}
        titleId="organizer-finalize-heading"
        title="Finalize"
        description="Confirm the selected window and send an iCalendar update to invited people."
      >
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
          <div className="organizer-finalize-workspace d-flex flex-column gap-3">
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
            <div className="organizer-finalize-workspace__actions d-flex flex-wrap gap-2">
              <AppButton variant="text" onClick={onBrowseResults}>
                Choose a different result
              </AppButton>
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
            headingLevel={4}
            className="organizer-empty-state organizer-empty-state--finalize"
            icon={<CalendarIcon />}
            title="No time selected yet"
            actions={
              <AppButton variant="filled" onClick={onBrowseResults}>
                Browse results
              </AppButton>
            }
          >
            <p className="mb-0">
              Pick a window on the calendar or choose a ranked result.
            </p>
          </EmptyState>
        )}

        {review && (
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
      </Panel>
      <DeliveryRequestProgress
        key={deliveryRequest?.id || "no-delivery"}
        initialRequest={deliveryRequest}
        getToken={getToken}
        onChange={setDeliveryRequest}
        ariaLabel="Finalization delivery progress"
      />
    </div>
  );
}
