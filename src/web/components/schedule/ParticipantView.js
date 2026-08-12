"use client";

import { useState, useContext, useEffect, useRef, useCallback } from "react";
import { MdLogin, MdRefresh, MdSend } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import EventContext from "@/components/event/EventContext";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import { useAuth } from "@/components/auth/AuthContext";
import {
  fetchCurrentParticipant,
  joinEvent,
  updateParticipant,
} from "@/lib/api/participants";
import { fetchEventResults } from "@/lib/api/events";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";

const AVAILABILITY_CHOICES = [
  { label: "Busy", value: 0 },
  { label: "If needed", value: 0.5 },
  { label: "Available", value: 1 },
];

const NOOP = () => {};

function resultEnvelope(data) {
  if (!data) return { status: "unavailable", results: null };
  if (data.status) return data;
  return {
    status: "fresh",
    requestedRevision: data.results?.revision,
    computedRevision: data.results?.revision,
    generatedAt: data.results?.generatedAt,
    results: data.results || null,
  };
}

function ParticipantView() {
  const {
    event,
    numSlots,
    respondIntent = false,
    consumeRespondIntent = NOOP,
  } = useContext(EventContext);
  const { user, loading: authLoading, getToken } = useAuth();
  const mode = event?.mode || "inperson";
  const viewPermission = event?.participantViewPermission || "own_only";

  const [participantName, setParticipantName] = useState("");
  const [joined, setJoined] = useState(false);
  const [scheduleInperson, setScheduleInperson] = useState([]);
  const [scheduleVirtual, setScheduleVirtual] = useState([]);
  const [availabilityValue, setAvailabilityValue] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [resultSnapshot, setResultSnapshot] = useState({
    status: "unavailable",
    results: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const [joinError, setJoinError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [draftSaveState, setDraftSaveState] = useState("idle");
  const [draftSaveError, setDraftSaveError] = useState("");
  const [saveConflict, setSaveConflict] = useState(null);

  const participantIdRef = useRef(null);
  const participantVersionRef = useRef(null);
  const scheduleInpersonRef = useRef([]);
  const scheduleVirtualRef = useRef([]);
  const draftDirtyRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  const autosaveInFlightRef = useRef(null);
  const autosavePendingRef = useRef(false);
  const autosaveRunnerRef = useRef(null);
  const draftSaveStateRef = useRef("idle");
  const respondJoinAttemptedRef = useRef(false);

  const responseDeadlinePassed =
    Boolean(event.responseDeadline) &&
    Date.now() >= new Date(event.responseDeadline).getTime();
  const responseChangesDisabled =
    event.status !== "open" || responseDeadlinePassed;

  const applyParticipantResponse = useCallback((participant) => {
    const inperson = participant.availabilityInperson.map(Number);
    const virtual = participant.availabilityVirtual.map(Number);
    participantIdRef.current = participant.id;
    participantVersionRef.current = participant.version;
    scheduleInpersonRef.current = inperson;
    scheduleVirtualRef.current = virtual;
    draftDirtyRef.current = false;
    autosavePendingRef.current = false;
    setParticipantName(participant.name);
    setScheduleInperson(inperson);
    setScheduleVirtual(virtual);
    setSubmitted(Boolean(participant.submitted));
    setJoined(true);
    setDraftSaveState(participant.submitted ? "submitted" : "saved");
    setDraftSaveError("");
    setSaveConflict(null);
  }, []);

  const runAutosave = useCallback(async () => {
    if (autosaveInFlightRef.current) {
      autosavePendingRef.current = true;
      return autosaveInFlightRef.current;
    }
    if (!draftDirtyRef.current) return true;
    if (responseChangesDisabled) {
      setDraftSaveState("failed");
      setDraftSaveError(
        "Responses are locked, so this draft could not be saved.",
      );
      return false;
    }

    const currentParticipantId = participantIdRef.current;
    const currentVersion = participantVersionRef.current;
    if (!currentParticipantId || currentVersion === null) return false;

    const inperson = [...scheduleInpersonRef.current];
    const virtual = [...scheduleVirtualRef.current];
    const fingerprint = JSON.stringify([inperson, virtual]);
    autosavePendingRef.current = false;
    setDraftSaveState("saving");
    setDraftSaveError("");

    const request = (async () => {
      try {
        const token = await getToken();
        const { participant } = await updateParticipant(
          event.code,
          currentParticipantId,
          {
            availabilityInperson: inperson,
            availabilityVirtual: virtual,
            submitted: 0,
            expectedVersion: currentVersion,
          },
          token,
        );
        participantVersionRef.current = participant.version;
        setSubmitted(false);
        setSaveConflict(null);
        const currentFingerprint = JSON.stringify([
          scheduleInpersonRef.current,
          scheduleVirtualRef.current,
        ]);
        draftDirtyRef.current = currentFingerprint !== fingerprint;
        autosavePendingRef.current = draftDirtyRef.current;
        setDraftSaveState(draftDirtyRef.current ? "saving" : "saved");
        return true;
      } catch (err) {
        draftDirtyRef.current = true;
        setDraftSaveState("failed");
        setDraftSaveError(err.message || "Draft autosave failed.");
        setSaveConflict(err.participant || null);
        return false;
      }
    })();

    autosaveInFlightRef.current = request;
    const saved = await request;
    autosaveInFlightRef.current = null;
    if (saved && autosavePendingRef.current && draftDirtyRef.current) {
      autosaveTimerRef.current = setTimeout(() => {
        void autosaveRunnerRef.current?.();
      }, 0);
    }
    return saved;
  }, [event.code, getToken, responseChangesDisabled]);

  autosaveRunnerRef.current = runAutosave;
  draftSaveStateRef.current = draftSaveState;

  const queueAutosave = useCallback(() => {
    draftDirtyRef.current = true;
    autosavePendingRef.current = true;
    setSubmitted(false);
    setDraftSaveState("saving");
    setDraftSaveError("");
    setSaveConflict(null);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void autosaveRunnerRef.current?.();
    }, 700);
  }, []);

  useEffect(() => {
    const warnBeforeUnload = (event) => {
      if (
        !draftDirtyRef.current &&
        draftSaveStateRef.current !== "saving" &&
        draftSaveStateRef.current !== "failed"
      ) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    respondJoinAttemptedRef.current = false;
  }, [event?.code]);

  useEffect(() => {
    if (!event?.code || !user?.id) return;
    let active = true;

    async function joinFromIntent(token) {
      if (!respondIntent || respondJoinAttemptedRef.current) return;
      respondJoinAttemptedRef.current = true;

      if (responseChangesDisabled) {
        setJoinError("This event is no longer accepting responses.");
        consumeRespondIntent();
        return;
      }

      try {
        const { participant } = await joinEvent(event.code, token);
        if (!active) return;
        applyParticipantResponse(participant);
      } catch (err) {
        if (!active) return;
        setJoinError(
          `We couldn't start your response: ${err.message || "Please try again."}`,
        );
      } finally {
        if (active) consumeRespondIntent();
      }
    }

    async function loadCurrentParticipant() {
      let token;
      try {
        token = await getToken();
        const data = await fetchCurrentParticipant(event.code, token);
        if (!active) return;
        if (data.participant) {
          applyParticipantResponse(data.participant);
          if (respondIntent) consumeRespondIntent();
          return;
        }
      } catch {
        // A person who has not joined yet has no current participant response.
      }
      if (!active || !respondIntent) return;
      if (!token) {
        try {
          token = await getToken();
        } catch (err) {
          if (!active) return;
          setJoinError(
            `We couldn't start your response: ${err.message || "Please try again."}`,
          );
          consumeRespondIntent();
          return;
        }
      }
      await joinFromIntent(token);
    }

    const timer = setTimeout(loadCurrentParticipant, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    event?.code,
    user?.id,
    refreshKey,
    getToken,
    applyParticipantResponse,
    respondIntent,
    consumeRespondIntent,
    responseChangesDisabled,
  ]);

  const loadResults = useCallback(async () => {
    if (!event.code || viewPermission === "own_only") {
      setResultSnapshot({ status: "unavailable", results: null });
      return;
    }
    try {
      const token = await getToken();
      const data = await fetchEventResults(event.code, token);
      setResultSnapshot(resultEnvelope(data));
    } catch {
      setResultSnapshot({ status: "unavailable", results: null });
    }
  }, [event.code, getToken, viewPermission]);

  useEffect(() => {
    const timer = setTimeout(loadResults, 0);
    return () => clearTimeout(timer);
  }, [loadResults, refreshKey]);

  useEffect(() => {
    if (resultSnapshot.status !== "refreshing") return undefined;
    const timer = setInterval(loadResults, 2000);
    return () => clearInterval(timer);
  }, [loadResults, resultSnapshot.status]);

  const results = resultSnapshot.results;
  const avgInperson =
    results?.channels?.inperson?.unweighted ?? Array(numSlots).fill(0);
  const avgVirtual =
    results?.channels?.virtual?.unweighted ?? Array(numSlots).fill(0);

  const handleJoin = async () => {
    setJoinError("");

    try {
      const token = await getToken();
      const { participant } = await joinEvent(event.code, token);
      applyParticipantResponse(participant);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setJoinError(`Failed to join: ${err.message}`);
    }
  };

  const makeCellPaintHandler = (channel) => (idx) => {
    const scheduleRef =
      channel === "inperson" ? scheduleInpersonRef : scheduleVirtualRef;
    if (Number(scheduleRef.current[idx]) === availabilityValue) return;
    const next = [...scheduleRef.current];
    next[idx] = availabilityValue;
    scheduleRef.current = next;
    if (channel === "inperson") setScheduleInperson(next);
    else setScheduleVirtual(next);
    queueAutosave();
  };

  const handleInpersonPaint = makeCellPaintHandler("inperson");
  const handleVirtualPaint = makeCellPaintHandler("virtual");

  const handleCopySchedule = (source, target) => {
    const sourceValues =
      source === "inperson"
        ? scheduleInpersonRef.current
        : scheduleVirtualRef.current;
    const next = [...sourceValues];
    if (target === "inperson") {
      scheduleInpersonRef.current = next;
      setScheduleInperson(next);
    } else {
      scheduleVirtualRef.current = next;
      setScheduleVirtual(next);
    }
    queueAutosave();
  };

  const fillAllAvailability = (value) => {
    if (responseChangesDisabled) return;
    if (mode !== "virtual") {
      const next = Array(numSlots).fill(value);
      scheduleInpersonRef.current = next;
      setScheduleInperson(next);
    }
    if (mode !== "inperson") {
      const next = Array(numSlots).fill(value);
      scheduleVirtualRef.current = next;
      setScheduleVirtual(next);
    }
    queueAutosave();
  };

  const handleSubmit = async () => {
    if (!participantIdRef.current) return;

    setIsSubmitting(true);
    setSubmitError("");

    try {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      while (draftDirtyRef.current || autosaveInFlightRef.current) {
        const saved = await autosaveRunnerRef.current();
        if (!saved) {
          setSubmitError("Save the draft successfully before submitting.");
          return;
        }
      }
      const token = await getToken();
      const { participant } = await updateParticipant(
        event.code,
        participantIdRef.current,
        {
          submitted: 1,
          expectedVersion: participantVersionRef.current,
        },
        token,
      );
      applyParticipantResponse(participant);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setSubmitError(`Failed to submit: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authLoading || !user) {
    return (
      <div className="page-pad participant-loading">
        <p>Loading...</p>
      </div>
    );
  }

  if (!joined) {
    return (
      <div className="page-pad participant-join-shell">
        <div className="participant-join-card">
          <div className="participant-join-heading">
            <p className="participant-eyebrow">Your invitation</p>
            <h2>Join Event</h2>
            <p>
              Join, mark the times that work for you, then submit your response.
            </p>
          </div>

          <EventDetailsGrid event={event} />

          {joinError && (
            <p className="participant-error" role="alert">
              {joinError}
            </p>
          )}

          <AppButton onClick={handleJoin} fullWidth icon={<MdLogin />}>
            Join as {user.displayName}
          </AppButton>
        </div>
      </div>
    );
  }

  return (
    <div className="page-pad participant-workspace">
      <div className="participant-heading">
        <div>
          <p className="participant-eyebrow">Your availability</p>
          <h2 className="participant-title">
            Welcome, {participantName}
            {submitted && (
              <span className="participant-submitted">
                <span aria-hidden="true">✓</span> Submitted
              </span>
            )}
          </h2>
          <p className="participant-heading-copy">
            Choose a status, then click or drag across the times below.
          </p>
        </div>
        <AppButton
          onClick={() => setRefreshKey((key) => key + 1)}
          variant="outlined"
          icon={<MdRefresh />}
        >
          Refresh
        </AppButton>
      </div>

      <div className="participant-columns">
        <div
          className={`participant-editor-pane${viewPermission === "own_only" ? " participant-editor-pane-wide" : ""}`}
        >
          <section
            className="participant-editor"
            aria-labelledby="participant-editor-title"
          >
            <div className="participant-choice-block">
              <h3 id="participant-editor-title">Mark times as</h3>
              <div
                role="group"
                aria-label="Availability status"
                className="participant-choice-group"
              >
                {AVAILABILITY_CHOICES.map((choice) => (
                  <AppButton
                    key={choice.value}
                    onClick={() => setAvailabilityValue(choice.value)}
                    variant={
                      availabilityValue === choice.value ? "filled" : "outlined"
                    }
                    aria-pressed={availabilityValue === choice.value}
                    disabled={responseChangesDisabled}
                  >
                    {choice.label}
                  </AppButton>
                ))}
              </div>
              <p className="participant-hint">
                Your changes save automatically.
              </p>
              <div className="participant-actions">
                <AppButton
                  onClick={() => fillAllAvailability(availabilityValue)}
                  variant="outlined"
                  disabled={responseChangesDisabled}
                >
                  Apply{" "}
                  {
                    AVAILABILITY_CHOICES.find(
                      (choice) => choice.value === availabilityValue,
                    )?.label
                  }{" "}
                  to all
                </AppButton>
                <AppButton
                  onClick={() => fillAllAvailability(0)}
                  variant="outlined"
                  disabled={responseChangesDisabled}
                >
                  Mark all Busy
                </AppButton>
              </div>
            </div>

            <ScheduleChannelEditor
              mode={mode}
              slotGroups={event.slotGroups}
              inperson={scheduleInperson}
              virtual={scheduleVirtual}
              readOnly={responseChangesDisabled}
              onInpersonPaint={handleInpersonPaint}
              onVirtualPaint={handleVirtualPaint}
              onCopy={handleCopySchedule}
            />

            {draftSaveState !== "idle" && (
              <div
                role={draftSaveState === "failed" ? "alert" : "status"}
                aria-live={draftSaveState === "failed" ? "assertive" : "polite"}
                className={`participant-save-status${draftSaveState === "failed" ? " participant-save-status-failed" : ""}`}
              >
                <span>
                  {draftSaveState === "saving" && "Saving draft…"}
                  {draftSaveState === "saved" &&
                    "Draft saved. Submit when you are ready."}
                  {draftSaveState === "submitted" && "Schedule submitted."}
                  {draftSaveState === "failed" &&
                    (draftSaveError || "Draft autosave failed.")}
                </span>
                {draftSaveState === "failed" &&
                  (saveConflict ? (
                    <AppButton
                      variant="outlined"
                      onClick={() => applyParticipantResponse(saveConflict)}
                    >
                      Reload latest response
                    </AppButton>
                  ) : (
                    <AppButton
                      variant="outlined"
                      onClick={() => void runAutosave()}
                    >
                      Retry save
                    </AppButton>
                  ))}
              </div>
            )}

            {submitError && (
              <p role="alert" className="participant-error">
                {submitError}
              </p>
            )}
            {responseChangesDisabled && (
              <p className="participant-error">
                {event.status !== "open"
                  ? `Responses are locked while this event is ${event.status}.`
                  : "The response deadline has passed."}
              </p>
            )}
            <div className="participant-submit-row">
              <AppButton
                onClick={handleSubmit}
                disabled={isSubmitting || responseChangesDisabled}
                icon={<MdSend />}
              >
                {isSubmitting
                  ? "Submitting..."
                  : submitted
                    ? "Update Availability"
                    : "Submit Availability"}
              </AppButton>
            </div>
          </section>
        </div>

        {viewPermission !== "own_only" && (
          <aside
            className="participant-results-pane"
            aria-label="Group availability"
          >
            {resultSnapshot.status === "refreshing" && (
              <div className="participant-result-notice" role="status">
                Group availability is updating for revision{" "}
                {resultSnapshot.requestedRevision ??
                  event.resultsRevision ??
                  "latest"}
                .
                {results
                  ? " Showing the last completed snapshot meanwhile."
                  : ""}
              </div>
            )}
            {resultSnapshot.status === "failed" && (
              <div
                className="participant-result-notice participant-result-notice-error"
                role="alert"
              >
                Group availability could not be refreshed yet.
                {results ? " Showing the last completed snapshot." : ""}
              </div>
            )}
            {results ? (
              <section className="participant-results-card">
                <h3>Group Availability</h3>
                <p className="participant-results-summary">
                  Based on {results.countedResponseTotal} submitted response(s).{" "}
                  {results.unansweredParticipantTotal} participant(s) are still
                  unanswered.
                </p>
                <div className="participant-results-grids">
                  {mode !== "virtual" && (
                    <div className="participant-result-grid">
                      <ScheduleGrid
                        schedule={avgInperson}
                        slotGroups={event.slotGroups}
                        readOnly={true}
                        showValues={true}
                        label={
                          mode === "mixed"
                            ? "In-Person Availability"
                            : "Availability"
                        }
                      />
                    </div>
                  )}
                  {mode !== "inperson" && (
                    <div className="participant-result-grid">
                      <ScheduleGrid
                        schedule={avgVirtual}
                        slotGroups={event.slotGroups}
                        readOnly={true}
                        showValues={true}
                        label={
                          mode === "mixed"
                            ? "Virtual Availability"
                            : "Availability"
                        }
                        virtual
                      />
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <section className="participant-results-card participant-results-empty">
                <h3>Group Availability</h3>
                <p>
                  Submit a valid schedule before shared results become
                  available.
                </p>
              </section>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

export default ParticipantView;
