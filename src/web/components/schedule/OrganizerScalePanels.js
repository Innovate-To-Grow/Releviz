"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import {
  confirmFinalMeeting,
  downloadFinalCalendar,
  fetchDeliveryRequest,
  fetchEventResults,
  launchEvent,
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
    <div aria-label="Delivery progress" className="delivery-progress">
      <div className="delivery-progress__header">
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
      <div className="delivery-progress__metrics">
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
      <div className="delivery-progress__actions">
        <AppButton variant="outlined" onClick={load} disabled={retrying}>
          Refresh progress
        </AppButton>
        {failed > 0 && (
          <AppButton onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry failed recipients"}
          </AppButton>
        )}
      </div>
      {error && (
        <p role="alert" className="organizer-message organizer-message--error">
          {error}
        </p>
      )}
    </div>
  );
}

export function OverviewPanel({
  event,
  setEvent,
  getToken,
  deliveryRequest,
  setDeliveryRequest,
  launchParticipantIds = [],
  launchSelectionMode = "all",
  setLaunchSelectionMode,
}) {
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const launchKey = useRef("");
  const reminderKey = useRef("");

  const launch = async () => {
    if (!launchKey.current) launchKey.current = crypto.randomUUID();
    setChanging(true);
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      const selection =
        launchSelectionMode === "selected"
          ? { participantIds: launchParticipantIds }
          : launchSelectionMode === "exclude_selected"
            ? {
                allEligible: true,
                excludedParticipantIds: launchParticipantIds,
              }
            : { allEligible: true };
      const data = await launchEvent(
        event.code,
        {
          expectedVersion: event.version,
          idempotencyKey: launchKey.current,
          selection,
        },
        token,
      );
      setEvent(data.event);
      setDeliveryRequest(data.deliveryRequest || null);
      setStatus(
        `Event launched. ${data.deliveryRequest?.recipientCount || 0} invitation emails were queued.`,
      );
      launchKey.current = "";
    } catch (requestError) {
      if (requestError.event) setEvent(requestError.event);
      setError(requestError.message || "Unable to launch this event.");
    } finally {
      setChanging(false);
    }
  };

  const changeLifecycle = async (nextStatus) => {
    setChanging(true);
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      const responseDeadline =
        nextStatus === "open" &&
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
      setStatus(`Event is now ${nextStatus}.`);
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
    <div className="organizer-panel-stack">
      <div className="organizer-overview-layout">
        <section className="md-card organizer-panel organizer-overview-panel">
          <header className="organizer-panel__header">
            <div>
              <h2 className="organizer-panel__title">Overview</h2>
              <p className="organizer-panel__description">
                Prepare the roster while the event is a draft, then launch
                invitations atomically.
              </p>
            </div>
          </header>
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
        </section>

        <aside
          className="md-card organizer-panel organizer-lifecycle-panel"
          aria-labelledby="organizer-lifecycle-title"
        >
          <header className="organizer-panel__header organizer-lifecycle-panel__header">
            <div>
              <span className="organizer-lifecycle-panel__status">
                {event.status || "draft"}
              </span>
              <h2
                id="organizer-lifecycle-title"
                className="organizer-panel__title"
              >
                Event controls
              </h2>
            </div>
          </header>

          {event.status === "draft" && (
            <div className="organizer-launch-form">
              <label className="organizer-field">
                Invitation audience
                <select
                  aria-label="Invitation audience"
                  value={launchSelectionMode}
                  onChange={(changeEvent) =>
                    setLaunchSelectionMode?.(changeEvent.target.value)
                  }
                >
                  <option value="all">All eligible roster members</option>
                  <option value="selected">Only selected roster members</option>
                  <option value="exclude_selected">
                    All except selected roster members
                  </option>
                </select>
              </label>
              <span className="organizer-selection-count">
                {launchParticipantIds.length} selected in Roster
              </span>
              <div className="organizer-launch-form__actions">
                <AppButton
                  onClick={launch}
                  disabled={
                    changing ||
                    (launchSelectionMode !== "all" &&
                      launchParticipantIds.length === 0)
                  }
                >
                  {changing ? "Launching…" : "Launch and send invitations"}
                </AppButton>
              </div>
            </div>
          )}

          {event.status !== "draft" && (
            <div className="organizer-panel__actions organizer-lifecycle-panel__actions">
              {event.status === "open" && (
                <>
                  <AppButton
                    variant="outlined"
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
              {event.status === "closed" && (
                <AppButton
                  variant="outlined"
                  onClick={() => changeLifecycle("open")}
                  disabled={changing}
                >
                  Reopen responses
                </AppButton>
              )}
              {["finalized", "archived"].includes(event.status) && (
                <AppButton
                  variant="outlined"
                  onClick={() => changeLifecycle("open")}
                  disabled={changing}
                >
                  Reopen event
                </AppButton>
              )}
              {!["archived", "draft"].includes(event.status) && (
                <AppButton
                  variant="outlined"
                  onClick={() => changeLifecycle("archived")}
                  disabled={changing}
                >
                  Archive event
                </AppButton>
              )}
            </div>
          )}

          {status && (
            <p
              role="status"
              className="organizer-message organizer-message--success"
            >
              {status}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="organizer-message organizer-message--error"
            >
              {error}
            </p>
          )}
        </aside>
      </div>
      <DeliveryRequestProgress
        key={deliveryRequest?.id || "no-delivery"}
        initialRequest={deliveryRequest}
        getToken={getToken}
        onChange={setDeliveryRequest}
      />
    </div>
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

export function ResultsSnapshotPanel({
  event,
  getToken,
  invalidationKey,
  onChoose,
}) {
  const [snapshot, setSnapshot] = useState({
    status: "refreshing",
    results: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const data = await fetchEventResults(event.code, token);
      setSnapshot(resultEnvelope(data));
      setError("");
    } catch (requestError) {
      setError(requestError.message || "Unable to load results.");
    } finally {
      setLoading(false);
    }
  }, [event.code, getToken]);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [invalidationKey, load]);

  useEffect(() => {
    if (snapshot.status !== "refreshing") return undefined;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load, snapshot.status]);

  const results = snapshot.results || {};
  const recommendations = (results.recommendations || []).slice(0, 10);

  return (
    <section className="md-card organizer-panel organizer-results-panel">
      <div className="organizer-panel__header">
        <div>
          <h2 className="organizer-panel__title">Results</h2>
          <p className="organizer-panel__description">
            Top continuous windows for a{" "}
            {event.meetingDurationMinutes || event.slotMinutes}-minute meeting.
          </p>
        </div>
        <AppButton variant="outlined" onClick={load} disabled={loading}>
          Refresh results
        </AppButton>
      </div>

      {snapshot.status === "refreshing" && (
        <p role="status" className="organizer-message">
          Results are updating for revision{" "}
          {snapshot.requestedRevision ?? event.resultsRevision ?? "latest"}.
          {snapshot.results
            ? " Showing the last successful snapshot meanwhile."
            : ""}
        </p>
      )}
      {snapshot.status === "failed" && (
        <p role="alert" className="organizer-message organizer-message--error">
          Result calculation failed. The worker will retry; the last successful
          snapshot remains visible.
        </p>
      )}
      {snapshot.status === "fresh" && (
        <p role="status" className="organizer-message">
          Results are current at revision{" "}
          {snapshot.computedRevision ?? "latest"}
          {snapshot.generatedAt
            ? ` · generated ${new Date(snapshot.generatedAt).toLocaleString()}`
            : ""}
          .
        </p>
      )}

      {recommendations.length > 0 ? (
        <ol className="results-list">
          {recommendations.map((recommendation, index) => {
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
              <li
                key={recommendationKey(recommendation, index)}
                className="result-option"
              >
                <div className="result-option__content">
                  <div className="result-option__heading">
                    <span className="result-option__rank">
                      #{recommendation.rank || index + 1}
                    </span>
                    <strong className="result-option__title">
                      {recommendation.label ||
                        (startsAt
                          ? new Date(startsAt).toLocaleString([], {
                              timeZone: event.timezone,
                            })
                          : "Candidate window")}
                    </strong>
                  </div>
                  <p className="result-option__summary">
                    <span className="result-option__metric">
                      {recommendation.channel === "virtual"
                        ? "Virtual"
                        : "In person"}
                    </span>{" "}
                    ·{" "}
                    <span className="result-option__metric">
                      {(weighted * 100).toFixed(0)}% weighted
                    </span>{" "}
                    ·{" "}
                    <span className="result-option__metric">
                      {(unweighted * 100).toFixed(0)}% unweighted
                    </span>{" "}
                    ·{" "}
                    <span className="result-option__metric">
                      {recommendation.fullyAvailableParticipantTotal || 0} fully
                      available
                    </span>
                  </p>
                  {startsAt && endsAt && (
                    <small className="result-option__time">
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
                  variant="outlined"
                  onClick={() => onChoose(recommendation)}
                >
                  Choose this time
                </AppButton>
              </li>
            );
          })}
        </ol>
      ) : loading || snapshot.status === "refreshing" ? (
        <div className="organizer-empty-state organizer-empty-state--loading">
          <h3>Calculating the best options</h3>
          <p>Recommendations will appear here as responses arrive.</p>
        </div>
      ) : (
        <div className="organizer-empty-state">
          <h3>No recommendation yet</h3>
          <p>No valid meeting window is available yet.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="organizer-message organizer-message--error">
          {error}
        </p>
      )}
    </section>
  );
}

export function FinalizeScalePanel({
  event,
  setEvent,
  getToken,
  recommendation,
  onBrowseResults,
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
  const canFinalize = ["open", "closed"].includes(event.status);
  return (
    <div className="organizer-panel-stack">
      <section className="md-card organizer-panel organizer-finalize-panel">
        <header className="organizer-panel__header">
          <div>
            <h2 className="organizer-panel__title">Finalize</h2>
            <p className="organizer-panel__description">
              Confirm one ranked, continuous window and send an iCalendar update
              to invited people.
            </p>
          </div>
        </header>
        {["finalized", "archived"].includes(event.status) &&
        meeting &&
        meeting.active !== false ? (
          <div className="finalized-meeting">
            <div className="finalized-meeting__summary">
              <strong className="finalized-meeting__time">
                {new Date(meeting.startsAt).toLocaleString([], {
                  timeZone: event.timezone,
                })}{" "}
                –{" "}
                {new Date(meeting.endsAt).toLocaleString([], {
                  timeZone: event.timezone,
                })}
              </strong>
              <span className="finalized-meeting__meta">
                {meeting.channel === "virtual" ? "Virtual" : "In person"} ·{" "}
                {meeting.location || "Location TBD"}
              </span>
            </div>
            <div className="finalized-meeting__actions">
              <AppButton
                variant="outlined"
                onClick={download}
                disabled={downloading}
              >
                {downloading ? "Preparing…" : "Download calendar (.ics)"}
              </AppButton>
            </div>
          </div>
        ) : recommendation ? (
          <div className="organizer-finalize-workspace">
            <div className="final-candidate">
              <div className="final-candidate__heading">
                <strong className="final-candidate__title">
                  {recommendation.label || "Selected candidate"}
                </strong>
                <span className="final-candidate__channel">
                  {recommendation.channel === "virtual"
                    ? "Virtual"
                    : "In person"}
                </span>
              </div>
              <p className="final-candidate__time">
                {new Date(payload.startsAt).toLocaleString([], {
                  timeZone: event.timezone,
                })}{" "}
                –{" "}
                {new Date(payload.endsAt).toLocaleString([], {
                  timeZone: event.timezone,
                })}
              </p>
            </div>
            <div className="organizer-finalize-workspace__form">
              <label className="organizer-field">
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
              <div className="organizer-panel__actions organizer-finalize-workspace__actions">
                <AppButton variant="outlined" onClick={onBrowseResults}>
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
                  onClick={confirm}
                  disabled={!canFinalize || !review || reviewing || confirming}
                >
                  {confirming ? "Finalizing…" : "Finalize meeting"}
                </AppButton>
              </div>
              {!canFinalize && (
                <p role="note" className="organizer-message">
                  Launch this event before reviewing and finalizing a meeting
                  time.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="organizer-empty-state organizer-empty-state--finalize">
            <h3>No time selected yet</h3>
            <p>Choose a recommended window before finalizing.</p>
            <div className="organizer-empty-state__actions">
              <AppButton onClick={onBrowseResults}>Browse results</AppButton>
            </div>
          </div>
        )}

        {review && (
          <div className="attendance-review" aria-label="Attendance review">
            {[
              ["Available", review.availableParticipantTotal],
              ["Partial", review.partialParticipantTotal],
              ["Unavailable", review.unavailableParticipantTotal],
              ["Unanswered", review.unansweredParticipantTotal],
              ["Excluded", review.excludedParticipantTotal],
            ].map(([label, value]) => (
              <div key={label} className="attendance-review__item">
                <span>{label}</span>
                <strong className="attendance-review__value">
                  {value || 0}
                </strong>
              </div>
            ))}
          </div>
        )}
        {status && (
          <p
            role="status"
            className="organizer-message organizer-message--success"
          >
            {status}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="organizer-message organizer-message--error"
          >
            {error}
          </p>
        )}
      </section>
      <DeliveryRequestProgress
        key={deliveryRequest?.id || "no-delivery"}
        initialRequest={deliveryRequest}
        getToken={getToken}
        onChange={setDeliveryRequest}
      />
    </div>
  );
}
