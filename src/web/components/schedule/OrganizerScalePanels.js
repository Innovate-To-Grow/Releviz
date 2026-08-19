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
import AppButton from "@/components/ui/AppButton";
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
    <div aria-label={ariaLabel}>
      <div>
        <strong>
          {request.operation
            ? `${request.operation} delivery`
            : "Email delivery"}
        </strong>
        <span>
          {waiting > 0
            ? "In progress"
            : failed > 0
              ? "Needs attention"
              : "Complete"}
        </span>
      </div>
      <div>
        <span>
          {delivery.total ??
            delivery.recipientTotal ??
            request.recipientCount ??
            0}{" "}
          total
        </span>
        <span>{delivery.sent || 0} sent</span>
        <span>{waiting} queued</span>
        <span>{failed} failed</span>
        {Number(delivery.canceled || 0) > 0 && (
          <span>{delivery.canceled} canceled</span>
        )}
      </div>
      <div>
        <AppButton onClick={load} disabled={retrying}>
          Refresh progress
        </AppButton>
        {failed > 0 && (
          <AppButton onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry failed recipients"}
          </AppButton>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
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
    <section aria-labelledby="organizer-lifecycle-title">
      <div>
        <span>{event.status || "unknown"}</span>
        <h3 id="organizer-lifecycle-title">Event controls</h3>
      </div>

      <div>
        {event.status === "active" && (
          <>
            <AppButton onClick={remind} disabled={changing}>
              Queue reminders
            </AppButton>
            <AppButton
              onClick={() => changeLifecycle("closed")}
              disabled={changing}
            >
              Close responses
            </AppButton>
          </>
        )}
        {["closed", "finalized", "archived"].includes(event.status) && (
          <AppButton
            onClick={() => changeLifecycle("active")}
            disabled={changing}
          >
            Reactivate event
          </AppButton>
        )}
        {["active", "closed", "finalized"].includes(event.status) && (
          <AppButton
            onClick={() => changeLifecycle("archived")}
            disabled={changing}
          >
            Archive event
          </AppButton>
        )}
      </div>

      {(status || error) && (
        <div>
          {status && <p role="status">{status}</p>}
          {error && <p role="alert">{error}</p>}
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
    <section ref={panelRef}>
      <header>
        <div>
          <h3 id="organizer-overview-heading">Overview</h3>
          <p>Review the event schedule and response settings.</p>
        </div>
        {editLocked ? (
          <AppButton disabled title={editLockReason}>
            Edit event
          </AppButton>
        ) : (
          <AppButton
            onClick={openEditor}
            disabled={editing}
            aria-expanded={editing}
            aria-controls="organizer-inline-event-editor"
          >
            Edit event
          </AppButton>
        )}
      </header>
      <div>
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
      {saveStatus && <p role="status">{saveStatus}</p>}
      {editing && editingEvent && (
        <div
          id="organizer-inline-event-editor"
          role="region"
          aria-labelledby="organizer-inline-event-editor-heading"
        >
          <header>
            <div>
              <h4
                id="organizer-inline-event-editor-heading"
                ref={editorHeadingRef}
                tabIndex={-1}
              >
                Edit event
              </h4>
              <p>Update this event without leaving the workspace.</p>
            </div>
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
    </section>
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
  const recommendations = (results.recommendations || []).slice(0, 10);

  return (
    <section ref={sectionRef}>
      <div>
        <div>
          <h3 ref={headingRef} id="organizer-results-heading" tabIndex={-1}>
            Results
          </h3>
          <p>
            Top continuous windows for a{" "}
            {event.meetingDurationMinutes || event.slotMinutes}-minute meeting.
          </p>
        </div>
        <AppButton onClick={() => load()} disabled={loading}>
          Refresh results
        </AppButton>
      </div>

      {snapshot.status === "refreshing" && (
        <p role="status">
          Results are updating for revision{" "}
          {snapshot.requestedRevision ?? event.resultsRevision ?? "latest"}.
          {snapshot.results
            ? " Showing the last successful snapshot meanwhile."
            : ""}
        </p>
      )}
      {snapshot.status === "failed" && (
        <p role="alert">
          Result calculation failed. The worker will retry; the last successful
          snapshot remains visible.
        </p>
      )}
      {snapshot.status === "fresh" && (
        <p role="status">
          Results are current at revision{" "}
          {snapshot.computedRevision ?? "latest"}
          {snapshot.generatedAt
            ? ` · generated ${new Date(snapshot.generatedAt).toLocaleString()}`
            : ""}
          .
        </p>
      )}

      {recommendations.length > 0 ? (
        <ol>
          {recommendations.map((recommendation, index) => {
            const key = recommendationKey(recommendation, index);
            const selected =
              selectedRecommendationKey ===
              recommendationSelectionKey(recommendation);
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
            return (
              <li key={key}>
                <div>
                  <div>
                    <span>#{recommendation.rank || index + 1}</span>
                    <strong>
                      {recommendation.label ||
                        (startsAt
                          ? new Date(startsAt).toLocaleString([], {
                              timeZone: event.timezone,
                            })
                          : "Candidate window")}
                    </strong>
                  </div>
                  <p>
                    <span>
                      {recommendation.channel === "virtual"
                        ? "Virtual"
                        : "In person"}
                    </span>{" "}
                    · <span>{(weighted * 100).toFixed(0)}% weighted</span> ·{" "}
                    <span>{(unweighted * 100).toFixed(0)}% unweighted</span> ·{" "}
                    <span>
                      {recommendation.fullyAvailableParticipantTotal || 0} fully
                      available
                    </span>
                  </p>
                  {startsAt && endsAt && (
                    <small>
                      {new Date(startsAt).toLocaleString([], {
                        timeZone: event.timezone,
                      })}{" "}
                      –{" "}
                      {new Date(endsAt).toLocaleString([], {
                        timeZone: event.timezone,
                      })}
                    </small>
                  )}
                </div>
                <AppButton
                  aria-pressed={selected}
                  onClick={() => onChoose(recommendation)}
                >
                  {selected ? "Selected time" : "Choose this time"}
                </AppButton>
              </li>
            );
          })}
        </ol>
      ) : loading || snapshot.status === "refreshing" ? (
        <div>
          <h4>Calculating the best options</h4>
          <p>Recommendations will appear here as responses arrive.</p>
        </div>
      ) : (
        <div>
          <h4>No recommendation yet</h4>
          <p>No valid meeting window is available yet.</p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
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
    <div>
      <section>
        <header>
          <div>
            <h3 ref={headingRef} id="organizer-finalize-heading" tabIndex={-1}>
              Finalize
            </h3>
            <p>
              Confirm one ranked, continuous window and send an iCalendar update
              to invited people.
            </p>
          </div>
        </header>
        {["finalized", "archived"].includes(event.status) &&
        meeting &&
        meeting.active !== false ? (
          <div>
            <div>
              <strong>
                {new Date(meeting.startsAt).toLocaleString([], {
                  timeZone: event.timezone,
                })}{" "}
                –{" "}
                {new Date(meeting.endsAt).toLocaleString([], {
                  timeZone: event.timezone,
                })}
              </strong>
              <span>
                {meeting.channel === "virtual" ? "Virtual" : "In person"} ·{" "}
                {meeting.location || "Location TBD"}
              </span>
            </div>
            <div>
              <AppButton onClick={download} disabled={downloading}>
                {downloading ? "Preparing…" : "Download calendar (.ics)"}
              </AppButton>
            </div>
          </div>
        ) : recommendation ? (
          <div>
            <div>
              <div>
                <strong>{recommendation.label || "Selected candidate"}</strong>
                <span>
                  {recommendation.channel === "virtual"
                    ? "Virtual"
                    : "In person"}
                </span>
              </div>
              <p>
                {new Date(payload.startsAt).toLocaleString([], {
                  timeZone: event.timezone,
                })}{" "}
                –{" "}
                {new Date(payload.endsAt).toLocaleString([], {
                  timeZone: event.timezone,
                })}
              </p>
            </div>
            <div>
              <label>
                <strong>Location or meeting link</strong>
                <input
                  value={location}
                  maxLength={500}
                  onChange={(changeEvent) => {
                    setLocation(changeEvent.target.value);
                    setReview(null);
                  }}
                />
              </label>
              <div>
                <AppButton onClick={onBrowseResults}>
                  Choose a different result
                </AppButton>
                <AppButton
                  onClick={preview}
                  disabled={!canFinalize || reviewing || confirming}
                >
                  {reviewing ? "Reviewing…" : "Review attendance"}
                </AppButton>
                <AppButton
                  onClick={confirm}
                  disabled={!canFinalize || !review || reviewing || confirming}
                >
                  {confirming ? "Finalizing…" : "Finalize meeting"}
                </AppButton>
              </div>
              {!canFinalize && (
                <p role="note">
                  Reactivate this event before reviewing and finalizing a
                  meeting time.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div>
            <h4>No time selected yet</h4>
            <p>Choose a recommended window before finalizing.</p>
            <div>
              <AppButton onClick={onBrowseResults}>Browse results</AppButton>
            </div>
          </div>
        )}

        {review && (
          <div aria-label="Attendance review">
            {[
              ["Available", review.availableParticipantTotal],
              ["Partial", review.partialParticipantTotal],
              ["Unavailable", review.unavailableParticipantTotal],
              ["Unanswered", review.unansweredParticipantTotal],
              ["Excluded", review.excludedParticipantTotal],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value || 0}</strong>
              </div>
            ))}
          </div>
        )}
        {status && <p role="status">{status}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
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
