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
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";
import { Badge, Callout, EmptyState, Stat } from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/Form";
import { Card, SectionHeader } from "@/components/ui/Surface";
import CreateEventClient from "@/components/event/CreateEventClient";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
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

const LIFECYCLE_TONE = {
  active: "success",
  closed: "warning",
  finalized: "accent",
  archived: "neutral",
};

function operationLabel(operation) {
  if (!operation) return "Email delivery";
  const words = String(operation).replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} delivery`;
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

function peopleCount(total) {
  const value = Number(total || 0);
  return `${value} ${value === 1 ? "person" : "people"}`;
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(0)}%`;
}

function channelLabel(channel) {
  return channel === "virtual" ? "Virtual" : "In person";
}

function formatWindow(startsAt, endsAt, timezone) {
  if (!startsAt || !endsAt) return "";
  return `${new Date(startsAt).toLocaleString([], {
    timeZone: timezone,
  })} – ${new Date(endsAt).toLocaleString([], { timeZone: timezone })}`;
}

/**
 * Live progress for a queued email batch. Email delivery is asynchronous, so
 * the organizer sees the queue drain instead of a fire-and-forget toast.
 */
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
    <div aria-label={ariaLabel} className="rv-delivery">
      <div className="rv-split">
        <p className="rv-cluster rv-cluster--sm">
          <Icon name="mail" className="rv-meta__icon" />
          <strong>{operationLabel(request.operation)}</strong>
        </p>
        <Badge
          dot
          tone={waiting > 0 ? "accent" : failed > 0 ? "danger" : "success"}
        >
          {waiting > 0
            ? "In progress"
            : failed > 0
              ? "Needs attention"
              : "Complete"}
        </Badge>
      </div>
      <div className="rv-delivery__counts">
        <span className="rv-delivery__count">
          <strong>{total}</strong> total
        </span>
        <span className="rv-delivery__count">
          <strong>{delivery.sent || 0}</strong> sent
        </span>
        <span className="rv-delivery__count">
          <strong>{waiting}</strong> queued
        </span>
        <span className="rv-delivery__count">
          <strong>{failed}</strong> failed
        </span>
        {Number(delivery.canceled || 0) > 0 && (
          <span className="rv-delivery__count">
            <strong>{delivery.canceled}</strong> canceled
          </span>
        )}
      </div>
      <div className="rv-btn-row">
        <Button size="sm" icon="refresh" onClick={load} disabled={retrying}>
          Refresh progress
        </Button>
        {failed > 0 && (
          <Button
            size="sm"
            variant="subtle"
            onClick={retry}
            disabled={retrying}
            busy={retrying}
          >
            {retrying ? "Retrying…" : "Retry failed recipients"}
          </Button>
        )}
      </div>
      {error && (
        <Callout tone="danger" role="alert" bare>
          {error}
        </Callout>
      )}
    </div>
  );
}

/** Lifecycle actions for the event: reminders, close, reactivate, archive. */
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
      aria-labelledby="organizer-lifecycle-title"
      className="rv-stack rv-stack--sm"
    >
      <h3 id="organizer-lifecycle-title" className="rv-visually-hidden">
        Event controls
      </h3>

      <div className="rv-cluster rv-cluster--sm rv-cluster--end">
        <Badge tone={LIFECYCLE_TONE[event.status] || "neutral"} dot>
          {String(event.status || "unknown").replace(/^./, (character) =>
            character.toUpperCase(),
          )}
        </Badge>
      </div>

      <div className="rv-btn-row rv-btn-row--end">
        {event.status === "active" && (
          <>
            <Button size="sm" icon="mail" onClick={remind} disabled={changing}>
              Queue reminders
            </Button>
            <Button
              size="sm"
              onClick={() => changeLifecycle("closed")}
              disabled={changing}
            >
              Close responses
            </Button>
          </>
        )}
        {["closed", "finalized", "archived"].includes(event.status) && (
          <Button
            size="sm"
            variant="subtle"
            onClick={() => changeLifecycle("active")}
            disabled={changing}
          >
            Reactivate event
          </Button>
        )}
        {["active", "closed", "finalized"].includes(event.status) && (
          <Button
            size="sm"
            onClick={() => changeLifecycle("archived")}
            disabled={changing}
          >
            Archive event
          </Button>
        )}
      </div>

      {status && (
        <Callout tone="success" role="status" bare>
          {status}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" role="alert" bare>
          {error}
        </Callout>
      )}
    </section>
  );
}

/** Event summary plus in-place editing without leaving the workspace. */
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
          ?.querySelector('[aria-controls="organizer-inline-event-editor"]')
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
    <Card as="section" ref={panelRef}>
      <SectionHeader
        as="h3"
        titleId="organizer-overview-heading"
        title="Overview"
        description="Review the event schedule and response settings."
        actions={
          editLocked ? (
            <Button size="sm" icon="sliders" disabled title={editLockReason}>
              Edit event
            </Button>
          ) : (
            <Button
              size="sm"
              icon="sliders"
              onClick={openEditor}
              disabled={editing}
              aria-expanded={editing}
              aria-controls="organizer-inline-event-editor"
            >
              Edit event
            </Button>
          )
        }
      />

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

      {saveStatus && (
        <Callout tone="success" role="status" bare>
          {saveStatus}
        </Callout>
      )}

      {editing && editingEvent && (
        <div
          id="organizer-inline-event-editor"
          role="region"
          aria-labelledby="organizer-inline-event-editor-heading"
          className="rv-inline-editor"
        >
          <header className="rv-stack rv-stack--xs">
            <h4
              id="organizer-inline-event-editor-heading"
              ref={editorHeadingRef}
              tabIndex={-1}
            >
              Edit event
            </h4>
            <p className="rv-field__hint">
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
    </Card>
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

function recommendationSelectionKey(recommendation) {
  if (!recommendation) return null;
  return (
    recommendation.id ||
    [
      recommendation.suggestedStartsAt || recommendation.startsAt,
      recommendation.suggestedEndsAt || recommendation.endsAt,
      recommendation.channel,
    ].join("-")
  );
}

function normalizeRecommendation(recommendation, index, timezone) {
  const startsAt =
    recommendation.suggestedStartsAt || recommendation.startsAt || null;
  const endsAt =
    recommendation.suggestedEndsAt || recommendation.endsAt || null;
  return {
    raw: recommendation,
    key: recommendationKey(recommendation, index),
    rank: recommendation.rank || index + 1,
    startsAt,
    endsAt,
    window: formatWindow(startsAt, endsAt, timezone),
    label:
      recommendation.label ||
      (startsAt
        ? new Date(startsAt).toLocaleString([], { timeZone: timezone })
        : "Candidate window"),
    channel: recommendation.channel,
    weighted:
      recommendation.weightedAvailability ?? recommendation.weightedScore ?? 0,
    unweighted:
      recommendation.unweightedAvailability ??
      recommendation.unweightedScore ??
      0,
    fullyAvailable: recommendation.fullyAvailableParticipantTotal || 0,
  };
}

/**
 * Versioned result snapshot. Recommendations are ranked; the strongest one is
 * presented as a decision, and the rest as a compact comparison list.
 */
export const ResultsSnapshotPanel = forwardRef(function ResultsSnapshotPanel(
  {
    event,
    getToken,
    invalidationKey,
    onChoose,
    selectedRecommendationKey,
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
  const sectionRef = useRef(null);

  const load = useCallback(
    async (providedToken, { throwOnError = false } = {}) => {
      setLoading(true);
      try {
        const token =
          providedToken === undefined ? await getToken() : providedToken;
        const data = await fetchEventResults(event.code, token);
        setSnapshot(resultEnvelope(data));
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

  const results = snapshot.results || {};
  const recommendations = (results.recommendations || [])
    .slice(0, 10)
    .map((recommendation, index) =>
      normalizeRecommendation(recommendation, index, event.timezone),
    );
  const [topPick, ...runnersUp] = recommendations;
  const isSelected = (recommendation) =>
    selectedRecommendationKey ===
    recommendationSelectionKey(recommendation.raw);

  return (
    <Card as="section" ref={sectionRef}>
      <SectionHeader
        as="h3"
        titleId="organizer-results-heading"
        titleRef={headingRef}
        title="Results"
        description={`Top continuous windows for a ${
          event.meetingDurationMinutes || event.slotMinutes
        }-minute meeting.`}
        actions={
          <Button
            size="sm"
            icon="refresh"
            onClick={() => load()}
            disabled={loading}
          >
            Refresh results
          </Button>
        }
      />

      {snapshot.status === "refreshing" && (
        <Callout tone="info" role="status" icon="refresh">
          Results are updating for revision{" "}
          {snapshot.requestedRevision ?? event.resultsRevision ?? "latest"}.
          {snapshot.results
            ? " Showing the last successful snapshot meanwhile."
            : ""}
        </Callout>
      )}
      {snapshot.status === "failed" && (
        <Callout tone="danger" role="alert">
          Result calculation failed. The worker will retry; the last successful
          snapshot remains visible.
        </Callout>
      )}
      {snapshot.status === "fresh" && (
        <Callout tone="success" role="status" bare>
          Results are current at revision{" "}
          {snapshot.computedRevision ?? "latest"}
          {snapshot.generatedAt
            ? ` · generated ${new Date(snapshot.generatedAt).toLocaleString()}`
            : ""}
          .
        </Callout>
      )}

      {topPick ? (
        <>
          <div className="rv-top-pick">
            <div className="rv-cluster rv-cluster--sm">
              <Badge tone="accent" icon="sparkle">
                Best overlap
              </Badge>
              <Badge
                tone="outline"
                icon={topPick.channel === "virtual" ? "video" : "mapPin"}
              >
                {channelLabel(topPick.channel)}
              </Badge>
            </div>
            <div className="rv-stack rv-stack--xs">
              <p className="rv-top-pick__when">{topPick.label}</p>
              {topPick.window && (
                <p className="rv-field__hint">{topPick.window}</p>
              )}
            </div>
            <div className="rv-top-pick__stats">
              <Stat
                tone="accent"
                label="Weighted"
                value={percent(topPick.weighted)}
                hint="Counts group Weight"
              />
              <Stat
                label="Unweighted"
                value={percent(topPick.unweighted)}
                hint="Everyone counted equally"
              />
              <Stat
                label="Fully available"
                value={peopleCount(topPick.fullyAvailable)}
                hint="Free for the whole window"
              />
              <Stat
                label="Missing responses"
                value={peopleCount(results.unansweredParticipantTotal)}
                hint={`${results.excludedParticipantTotal ?? 0} excluded`}
              />
            </div>
            <div className="rv-btn-row">
              <Button
                variant="primary"
                icon={isSelected(topPick) ? "check" : "arrowRight"}
                aria-pressed={isSelected(topPick)}
                onClick={() => onChoose(topPick.raw)}
              >
                {isSelected(topPick) ? "Selected time" : "Choose this time"}
              </Button>
            </div>
          </div>

          {runnersUp.length > 0 && (
            <div className="rv-stack rv-stack--sm">
              <h4 className="rv-field__label">Other strong options</h4>
              <ol className="rv-rank-list">
                {runnersUp.map((recommendation) => (
                  <li
                    key={recommendation.key}
                    className={`rv-rank${isSelected(recommendation) ? " rv-rank--selected" : ""}`}
                  >
                    <span className="rv-rank__index" aria-hidden="true">
                      {recommendation.rank}
                    </span>
                    <div className="rv-rank__body">
                      <span className="rv-rank__when">
                        <span className="rv-visually-hidden">
                          Rank {recommendation.rank}:{" "}
                        </span>
                        {recommendation.label}
                      </span>
                      <span className="rv-meta">
                        <span className="rv-meta__item">
                          {channelLabel(recommendation.channel)}
                        </span>
                        <span className="rv-meta__item">
                          {percent(recommendation.weighted)} weighted
                        </span>
                        <span className="rv-meta__item">
                          {percent(recommendation.unweighted)} unweighted
                        </span>
                        <span className="rv-meta__item">
                          {recommendation.fullyAvailable} fully available
                        </span>
                      </span>
                      {recommendation.window && (
                        <span className="rv-field__hint">
                          {recommendation.window}
                        </span>
                      )}
                    </div>
                    <Button
                      className="rv-rank__action"
                      size="sm"
                      variant={
                        isSelected(recommendation) ? "primary" : "secondary"
                      }
                      aria-pressed={isSelected(recommendation)}
                      onClick={() => onChoose(recommendation.raw)}
                    >
                      {isSelected(recommendation)
                        ? "Selected time"
                        : "Choose this time"}
                    </Button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      ) : loading || snapshot.status === "refreshing" ? (
        <EmptyState
          icon="clock"
          headingLevel={4}
          title="Calculating the best options"
          description="Recommendations will appear here as responses arrive."
        />
      ) : (
        <EmptyState
          icon="search"
          headingLevel={4}
          title="No recommendation yet"
          description="No valid meeting window is available yet."
        />
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
    </Card>
  );
});

export function FinalizeScalePanel(props) {
  const selectedRecommendationKey = props.recommendation
    ? recommendationKey(props.recommendation, 0)
    : "no-recommendation";

  return (
    <FinalizeScalePanelContent key={selectedRecommendationKey} {...props} />
  );
}

function FinalizeScalePanelContent({
  event,
  setEvent,
  getToken,
  recommendation,
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
    if (!recommendation) return null;
    return {
      startsAt: recommendation.suggestedStartsAt || recommendation.startsAt,
      endsAt: recommendation.suggestedEndsAt || recommendation.endsAt,
      channel: recommendation.channel,
      location: location.trim(),
    };
  }, [location, recommendation]);

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
  return (
    <div className="rv-stack rv-stack--md">
      <Card as="section">
        <SectionHeader
          as="h3"
          titleId="organizer-finalize-heading"
          titleRef={headingRef}
          title="Finalize"
          description="Confirm one ranked, continuous window and send an iCalendar update to invited people."
        />

        {["finalized", "archived"].includes(event.status) &&
        meeting &&
        meeting.active !== false ? (
          <div className="rv-top-pick">
            <Badge tone="success" icon="checkCircle">
              Meeting confirmed
            </Badge>
            <p className="rv-top-pick__when">
              {formatWindow(meeting.startsAt, meeting.endsAt, event.timezone)}
            </p>
            <p className="rv-field__hint">
              {channelLabel(meeting.channel)} ·{" "}
              {meeting.location || "Location TBD"}
            </p>
            <div className="rv-btn-row">
              <Button
                icon="download"
                onClick={download}
                disabled={downloading}
                busy={downloading}
              >
                {downloading ? "Preparing…" : "Download calendar (.ics)"}
              </Button>
            </div>
          </div>
        ) : recommendation ? (
          <div className="rv-stack rv-stack--md">
            <div className="rv-top-pick">
              <div className="rv-cluster rv-cluster--sm">
                <Badge tone="accent">Selected candidate</Badge>
                <Badge tone="outline">
                  {channelLabel(recommendation.channel)}
                </Badge>
              </div>
              <p className="rv-top-pick__when">
                {recommendation.label || "Selected candidate"}
              </p>
              <p className="rv-field__hint">
                {formatWindow(payload.startsAt, payload.endsAt, event.timezone)}
              </p>
            </div>

            <Field
              label="Location or meeting link"
              hint="Included in the calendar invitation sent to every attendee."
            >
              <TextInput
                value={location}
                maxLength={500}
                onChange={(changeEvent) => {
                  setLocation(changeEvent.target.value);
                  setReview(null);
                }}
              />
            </Field>

            <div className="rv-btn-row">
              <Button variant="ghost" onClick={onBrowseResults}>
                Choose a different result
              </Button>
              <Button
                onClick={preview}
                disabled={!canFinalize || reviewing || confirming}
                busy={reviewing}
              >
                {reviewing ? "Reviewing…" : "Review attendance"}
              </Button>
              <Button
                variant="primary"
                icon="checkCircle"
                onClick={confirm}
                disabled={!canFinalize || !review || reviewing || confirming}
                busy={confirming}
              >
                {confirming ? "Finalizing…" : "Finalize meeting"}
              </Button>
            </div>
            {!canFinalize && (
              <Callout tone="warning" role="note">
                Reactivate this event before reviewing and finalizing a meeting
                time.
              </Callout>
            )}
          </div>
        ) : (
          <EmptyState
            icon="calendar"
            headingLevel={4}
            title="No time selected yet"
            description="Choose a recommended window before finalizing."
            action={
              <Button variant="subtle" onClick={onBrowseResults}>
                Browse results
              </Button>
            }
          />
        )}

        {review && (
          <div aria-label="Attendance review" className="rv-top-pick__stats">
            {[
              ["Available", review.availableParticipantTotal],
              ["Partial", review.partialParticipantTotal],
              ["Unavailable", review.unavailableParticipantTotal],
              ["Unanswered", review.unansweredParticipantTotal],
              ["Excluded", review.excludedParticipantTotal],
            ].map(([label, value]) => (
              <Stat key={label} label={label} value={value || 0} />
            ))}
          </div>
        )}
        {status && (
          <Callout tone="success" role="status" bare>
            {status}
          </Callout>
        )}
        {error && (
          <Callout tone="danger" role="alert" bare>
            {error}
          </Callout>
        )}
      </Card>
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
