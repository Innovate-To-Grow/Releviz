"use client";

import { useState, useContext, useEffect, useRef, useCallback } from "react";
import Button from "@/components/ui/Button";
import { Badge, Callout, LoadingState } from "@/components/ui/Feedback";
import SegmentedControl from "@/components/ui/Segmented";
import { Card, PageHeader, SectionHeader } from "@/components/ui/Surface";
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
import useAutosaveNavigationGuard from "@/components/schedule/useAutosaveNavigationGuard";

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
  const [participantRefreshKey, setParticipantRefreshKey] = useState(0);
  const [resultsRefreshKey, setResultsRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [draftSaveState, setDraftSaveState] = useState("idle");
  const [draftSaveError, setDraftSaveError] = useState("");
  const [saveConflict, setSaveConflict] = useState(null);
  const [deadlineClock, setDeadlineClock] = useState(() => Date.now());

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
  const participantLoadGenerationRef = useRef(0);

  const responseDeadline = event.responseDeadline
    ? new Date(event.responseDeadline).getTime()
    : Number.NaN;
  const responseDeadlinePassed =
    Number.isFinite(responseDeadline) && deadlineClock >= responseDeadline;
  const responseChangesDisabled =
    event.status !== "active" || responseDeadlinePassed;

  const applyParticipantResponse = useCallback((participant) => {
    // Any participant mutation is newer than reads that were already in flight.
    participantLoadGenerationRef.current += 1;
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

  useEffect(() => {
    autosaveRunnerRef.current = runAutosave;
  }, [runAutosave]);

  useEffect(() => {
    draftSaveStateRef.current = draftSaveState;
  }, [draftSaveState]);

  const queueAutosave = useCallback(() => {
    // Do not let a GET that started before this edit replace the local draft.
    participantLoadGenerationRef.current += 1;
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

  const flushPendingDraft = useCallback(async () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    while (draftDirtyRef.current || autosaveInFlightRef.current) {
      const saved = await autosaveRunnerRef.current?.();
      if (!saved) return false;
    }
    return true;
  }, []);

  const hasPendingDraft = useCallback(
    () =>
      draftDirtyRef.current ||
      Boolean(autosaveInFlightRef.current) ||
      draftSaveStateRef.current === "saving" ||
      draftSaveStateRef.current === "failed",
    [],
  );

  useAutosaveNavigationGuard({
    hasPending: hasPendingDraft,
    flush: flushPendingDraft,
    pending: draftSaveState === "saving" || draftSaveState === "failed",
  });

  useEffect(() => {
    if (!Number.isFinite(responseDeadline)) return undefined;
    let timer;
    const refreshDeadline = () => {
      const now = Date.now();
      setDeadlineClock(now);
      const remaining = responseDeadline - now;
      if (remaining > 0) {
        timer = window.setTimeout(
          refreshDeadline,
          Math.min(remaining, 2_147_483_647),
        );
      }
    };
    const remaining = responseDeadline - Date.now();
    timer = window.setTimeout(
      refreshDeadline,
      Math.max(0, Math.min(remaining, 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [responseDeadline]);

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
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
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
      const requestGeneration = ++participantLoadGenerationRef.current;
      let token;
      try {
        token = await getToken();
        const data = await fetchCurrentParticipant(event.code, token);
        if (
          !active ||
          requestGeneration !== participantLoadGenerationRef.current
        )
          return;
        if (data.participant) {
          const localVersion = Number(participantVersionRef.current);
          const fetchedVersion = Number(data.participant.version);
          const responseIsOlder =
            Number.isFinite(localVersion) &&
            Number.isFinite(fetchedVersion) &&
            fetchedVersion < localVersion;
          if (
            draftDirtyRef.current ||
            autosaveInFlightRef.current ||
            responseIsOlder
          ) {
            return;
          }
          applyParticipantResponse(data.participant);
          if (respondIntent) consumeRespondIntent();
          return;
        }
      } catch {
        // A person who has not joined yet has no current participant response.
      }
      if (
        !active ||
        requestGeneration !== participantLoadGenerationRef.current ||
        !respondIntent
      )
        return;
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
    participantRefreshKey,
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
  }, [loadResults, resultsRefreshKey]);

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
      setResultsRefreshKey((key) => key + 1);
    } catch (err) {
      setJoinError(`Failed to join: ${err.message}`);
    }
  };

  const handleInpersonPaint = useCallback(
    (idx) => {
      if (Number(scheduleInpersonRef.current[idx]) === availabilityValue)
        return;
      const next = [...scheduleInpersonRef.current];
      next[idx] = availabilityValue;
      scheduleInpersonRef.current = next;
      setScheduleInperson(next);
      queueAutosave();
    },
    [availabilityValue, queueAutosave],
  );

  const handleVirtualPaint = useCallback(
    (idx) => {
      if (Number(scheduleVirtualRef.current[idx]) === availabilityValue) return;
      const next = [...scheduleVirtualRef.current];
      next[idx] = availabilityValue;
      scheduleVirtualRef.current = next;
      setScheduleVirtual(next);
      queueAutosave();
    },
    [availabilityValue, queueAutosave],
  );

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
      const saved = await flushPendingDraft();
      if (!saved) {
        setSubmitError("Save the draft successfully before submitting.");
        return;
      }
      participantLoadGenerationRef.current += 1;
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
      setResultsRefreshKey((key) => key + 1);
    } catch (err) {
      setSubmitError(`Failed to submit: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const saved = await flushPendingDraft();
      if (!saved) return;
      setParticipantRefreshKey((key) => key + 1);
      setResultsRefreshKey((key) => key + 1);
    } finally {
      setIsRefreshing(false);
    }
  };

  if (authLoading || !user) {
    return (
      <main id="main" className="rv-page rv-page--centered">
        <LoadingState message="Loading..." />
      </main>
    );
  }

  if (!joined) {
    return (
      <main id="main" className="rv-page rv-page--form">
        <Card className="rv-stack--lg">
          <PageHeader
            plain
            as="h2"
            eyebrow="Your invitation"
            eyebrowIcon="mail"
            title="Join Event"
            description="Join, mark the times that work for you, then submit your response."
          />

          <EventDetailsGrid event={event} />

          {joinError && (
            <Callout tone="danger" role="alert">
              {joinError}
            </Callout>
          )}

          <div className="rv-btn-row">
            <Button
              variant="primary"
              size="lg"
              icon="check"
              onClick={handleJoin}
            >
              Join as {user.displayName}
            </Button>
          </div>
        </Card>
      </main>
    );
  }

  const activeChoice = AVAILABILITY_CHOICES.find(
    (choice) => choice.value === availabilityValue,
  );

  return (
    <main id="main" className="rv-page rv-page--wide">
      <div className="rv-stack rv-stack--lg">
        <PageHeader
          as="h2"
          eyebrow="Your availability"
          eyebrowIcon="calendar"
          title={`Welcome, ${participantName}`}
          description="Choose a status, then click or drag across the times below."
          actions={
            <>
              {submitted && (
                <Badge tone="success" icon="checkCircle">
                  Submitted
                </Badge>
              )}
              <Button
                icon="refresh"
                onClick={handleRefresh}
                disabled={isRefreshing}
                busy={isRefreshing}
              >
                {isRefreshing ? "Refreshing…" : "Refresh"}
              </Button>
            </>
          }
        />

        <Card as="section" aria-labelledby="participant-editor-title">
          <SectionHeader
            as="h3"
            titleId="participant-editor-title"
            title="Mark times as"
            description="Your changes save automatically."
            actions={
              <div className="rv-btn-row">
                <Button
                  size="sm"
                  onClick={() => fillAllAvailability(availabilityValue)}
                  disabled={responseChangesDisabled}
                >
                  Apply {activeChoice?.label} to all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => fillAllAvailability(0)}
                  disabled={responseChangesDisabled}
                >
                  Mark all Busy
                </Button>
              </div>
            }
          />

          <SegmentedControl
            label="Availability status"
            options={AVAILABILITY_CHOICES}
            value={availabilityValue}
            disabled={responseChangesDisabled}
            onChange={setAvailabilityValue}
          />

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
            <Callout
              tone={
                draftSaveState === "failed"
                  ? "danger"
                  : draftSaveState === "saving"
                    ? "neutral"
                    : "success"
              }
              icon={draftSaveState === "saving" ? "clock" : undefined}
              role={draftSaveState === "failed" ? "alert" : "status"}
              aria-live={draftSaveState === "failed" ? "assertive" : "polite"}
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
                  <div className="rv-btn-row">
                    <Button
                      size="sm"
                      icon="refresh"
                      onClick={() => applyParticipantResponse(saveConflict)}
                    >
                      Reload latest response
                    </Button>
                  </div>
                ) : (
                  <div className="rv-btn-row">
                    <Button
                      size="sm"
                      icon="refresh"
                      onClick={() => void runAutosave()}
                    >
                      Retry save
                    </Button>
                  </div>
                ))}
            </Callout>
          )}

          {submitError && (
            <Callout tone="danger" role="alert">
              {submitError}
            </Callout>
          )}
          {responseChangesDisabled && (
            <Callout tone="warning">
              {event.status !== "active"
                ? `Responses are locked while this event is ${event.status}.`
                : "The response deadline has passed."}
            </Callout>
          )}

          <div className="rv-btn-row rv-btn-row--stack rv-btn-row--end">
            <Button
              variant="primary"
              size="lg"
              icon="check"
              onClick={handleSubmit}
              busy={isSubmitting}
              disabled={isSubmitting || responseChangesDisabled}
            >
              {isSubmitting
                ? "Submitting..."
                : submitted
                  ? "Update Availability"
                  : "Submit Availability"}
            </Button>
          </div>
        </Card>

        {viewPermission !== "own_only" && (
          <Card as="aside" aria-label="Group availability">
            {resultSnapshot.status === "refreshing" && (
              <Callout tone="info" role="status" icon="refresh">
                Group availability is updating for revision{" "}
                {resultSnapshot.requestedRevision ??
                  event.resultsRevision ??
                  "latest"}
                .
                {results
                  ? " Showing the last completed snapshot meanwhile."
                  : ""}
              </Callout>
            )}
            {resultSnapshot.status === "failed" && (
              <Callout tone="danger" role="alert">
                Group availability could not be refreshed yet.
                {results ? " Showing the last completed snapshot." : ""}
              </Callout>
            )}
            {results ? (
              <section className="rv-stack rv-stack--md">
                <SectionHeader
                  as="h3"
                  title="Group Availability"
                  description={`Based on ${results.countedResponseTotal} submitted response(s). ${results.unansweredParticipantTotal} participant(s) are still unanswered.`}
                />
                <div className="rv-stack rv-stack--lg">
                  {mode !== "virtual" && (
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
                  )}
                  {mode !== "inperson" && (
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
                  )}
                </div>
              </section>
            ) : (
              <section className="rv-stack rv-stack--sm">
                <SectionHeader
                  as="h3"
                  title="Group Availability"
                  description="Submit a valid schedule before shared results become available."
                />
              </section>
            )}
          </Card>
        )}
      </div>
    </main>
  );
}

export default ParticipantView;
