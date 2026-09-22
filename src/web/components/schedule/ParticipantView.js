"use client";

import { useState, useContext, useEffect, useRef, useCallback } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import {
  AVAILABILITY_CHOICES,
  AvailabilityChoice,
  availabilityLabel,
  startingAvailabilityValue,
  startingBrushValue,
} from "@/components/ui/Availability";
import LoadingState from "@/components/ui/LoadingState";
import PageHeader from "@/components/ui/PageHeader";
import Panel from "@/components/ui/Panel";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  RefreshIcon,
  SendIcon,
  SignInIcon,
  SuccessIcon,
  TimezoneIcon,
} from "@/components/ui/icons";
import EventContext from "@/components/event/EventContext";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchEvent } from "@/lib/api/events";
import {
  fetchCurrentParticipant,
  joinEvent,
  updateParticipant,
} from "@/lib/api/participants";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import useAutosaveNavigationGuard from "@/components/schedule/useAutosaveNavigationGuard";

const NOOP = () => {};

function ParticipantView() {
  const {
    event,
    setEvent = NOOP,
    numSlots,
    respondIntent = false,
    consumeRespondIntent = NOOP,
  } = useContext(EventContext);
  const { user, loading: authLoading, getToken } = useAuth();
  const mode = event?.mode || "inperson";
  // Every slot starts at the organizer's chosen level, so the brush defaults
  // to the opposite: people paint over the times that differ.
  const startingValue = startingAvailabilityValue(event);
  const startingBrush = startingBrushValue(event);
  const startsAvailable = startingValue === 1;
  const startingLabel = availabilityLabel(startingValue);

  const [participantName, setParticipantName] = useState("");
  const [joined, setJoined] = useState(false);
  const [scheduleInperson, setScheduleInperson] = useState([]);
  const [scheduleVirtual, setScheduleVirtual] = useState([]);
  const [availabilityValue, setAvailabilityValue] = useState(startingBrush);
  // A changed starting level (after the event refreshes) flips the brush too.
  const [brushBaseline, setBrushBaseline] = useState(startingBrush);
  if (brushBaseline !== startingBrush) {
    setBrushBaseline(startingBrush);
    setAvailabilityValue(startingBrush);
  }
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [participantRefreshKey, setParticipantRefreshKey] = useState(0);
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

  const handleJoin = async () => {
    setJoinError("");

    try {
      const token = await getToken();
      const { participant } = await joinEvent(event.code, token);
      applyParticipantResponse(participant);
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
      // The organizer may have changed the event since this page loaded (for
      // example the starting schedule, which drives the brush and copy), so
      // reload it alongside the response; a failed event read is not fatal.
      try {
        const token = await getToken();
        const { event: latest } = await fetchEvent(event.code, token);
        setEvent(latest);
      } catch {
        // The response refresh below still runs against the current event.
      }
      setParticipantRefreshKey((key) => key + 1);
    } finally {
      setIsRefreshing(false);
    }
  };

  if (authLoading || !user) {
    return (
      <main className="page-shell" aria-busy="true">
        <LoadingState label="Loading..." />
      </main>
    );
  }

  if (!joined) {
    return (
      <main className="page-shell page-shell--narrow">
        <Panel bodyClassName="d-flex flex-column gap-3">
          <PageHeader
            headingLevel={2}
            eyebrow="Your invitation"
            title="Join Event"
            lede={
              startsAvailable
                ? "Join, mark the times that do not work for you, then submit your response."
                : "Join, mark the times that work for you, then submit your response."
            }
            className="mb-0"
          />

          <EventDetailsGrid event={event} />

          {joinError && (
            <Alert variant="danger" role="alert" className="participant-error">
              {joinError}
            </Alert>
          )}

          <AppButton
            onClick={handleJoin}
            fullWidth
            className="text-wrap"
            icon={<SignInIcon />}
          >
            Join as {user.displayName}
          </AppButton>
        </Panel>
      </main>
    );
  }

  const activeChoiceLabel = AVAILABILITY_CHOICES.find(
    (choice) => choice.value === availabilityValue,
  )?.label;
  const saveStatusVariant =
    draftSaveState === "failed"
      ? "danger"
      : draftSaveState === "submitted"
        ? "success"
        : "info";

  return (
    <main className="page-shell page-shell--wide participant-workspace">
      <PageHeader
        headingLevel={2}
        eyebrow="Your availability"
        title={
          <>
            Welcome, {participantName}{" "}
            {submitted ? (
              <StatusBadge
                status="submitted"
                dot={false}
                className="ms-1 align-middle"
              >
                <span className="icon-inline" aria-hidden="true">
                  <SuccessIcon />
                </span>
                Submitted
              </StatusBadge>
            ) : (
              <StatusBadge status="draft" className="ms-1 align-middle">
                Draft
              </StatusBadge>
            )}
          </>
        }
        lede={
          startsAvailable
            ? "Every time starts as Available. Paint Busy over the times that do not work for you."
            : "Choose a status, then click or drag across the times below."
        }
        actions={
          <AppButton
            onClick={handleRefresh}
            variant="outlined"
            icon={<RefreshIcon />}
            disabled={isRefreshing}
            busy={isRefreshing}
          >
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </AppButton>
        }
      />

      {/* Participants only ever see and edit their own calendar; group
          availability is the organizer's view. */}
      <div className="participant-columns">
        <Panel
          as="section"
          className="participant-editor"
          aria-labelledby="participant-editor-title"
          title="Mark times as"
          titleId="participant-editor-title"
          headingLevel={3}
        >
          <div className="d-flex flex-column gap-3">
            <div className="schedule-toolbar mb-0">
              <div className="schedule-toolbar__group">
                <AvailabilityChoice
                  value={availabilityValue}
                  onChange={setAvailabilityValue}
                  disabled={responseChangesDisabled}
                  label="Availability status"
                  virtual={mode === "virtual"}
                  className="flex-wrap"
                />
              </div>
              <div className="schedule-toolbar__actions">
                <AppButton
                  onClick={() => fillAllAvailability(availabilityValue)}
                  variant="outlined"
                  size="sm"
                  disabled={responseChangesDisabled}
                >
                  Apply {activeChoiceLabel} to all
                </AppButton>
                <AppButton
                  onClick={() => fillAllAvailability(startingValue)}
                  variant="outlined"
                  size="sm"
                  disabled={responseChangesDisabled}
                >
                  Mark all {startingLabel}
                </AppButton>
              </div>
              <p className="w-100 mb-0 small text-secondary d-flex flex-wrap align-items-center gap-2">
                <span className="d-inline-flex align-items-center gap-1">
                  <span className="icon-inline" aria-hidden="true">
                    <TimezoneIcon />
                  </span>
                  Times shown in {event.timezone || "UTC"}
                </span>
                <span aria-hidden="true">·</span>
                <span>Your changes save automatically.</span>
              </p>
            </div>

            <ScheduleChannelEditor
              mode={mode}
              slotGroups={event.slotGroups}
              inperson={scheduleInperson}
              virtual={scheduleVirtual}
              startingValue={startingValue}
              readOnly={responseChangesDisabled}
              onInpersonPaint={handleInpersonPaint}
              onVirtualPaint={handleVirtualPaint}
              onCopy={handleCopySchedule}
              legend={false}
            />

            {draftSaveState !== "idle" && (
              <Alert
                variant={saveStatusVariant}
                role={draftSaveState === "failed" ? "alert" : "status"}
                icon={draftSaveState !== "saving"}
                className={`participant-save-status${draftSaveState === "failed" ? " participant-save-status-failed" : ""}`}
                actions={
                  draftSaveState === "failed" ? (
                    saveConflict ? (
                      <AppButton
                        variant="outlined"
                        size="sm"
                        onClick={() => applyParticipantResponse(saveConflict)}
                      >
                        Reload latest response
                      </AppButton>
                    ) : (
                      <AppButton
                        variant="outlined"
                        size="sm"
                        onClick={() => void runAutosave()}
                      >
                        Retry save
                      </AppButton>
                    )
                  ) : null
                }
              >
                <span className="save-status__text">
                  {draftSaveState === "saving" && (
                    <span
                      className="spinner-border spinner-border-sm"
                      aria-hidden="true"
                    />
                  )}
                  <span>
                    {draftSaveState === "saving" && "Saving draft…"}
                    {draftSaveState === "saved" &&
                      "Draft saved. Submit when you are ready."}
                    {draftSaveState === "submitted" && "Schedule submitted."}
                    {draftSaveState === "failed" &&
                      (draftSaveError || "Draft autosave failed.")}
                  </span>
                </span>
              </Alert>
            )}

            {submitError && (
              <Alert
                variant="danger"
                role="alert"
                className="participant-error"
              >
                {submitError}
              </Alert>
            )}
            {responseChangesDisabled && (
              <Alert
                variant="warning"
                role="status"
                className="participant-locked-notice"
              >
                {event.status !== "active"
                  ? `Responses are locked while this event is ${event.status}.`
                  : "The response deadline has passed."}
              </Alert>
            )}
            <div className="d-flex flex-wrap gap-2">
              <AppButton
                onClick={handleSubmit}
                disabled={isSubmitting || responseChangesDisabled}
                busy={isSubmitting}
                icon={<SendIcon />}
              >
                {isSubmitting
                  ? "Submitting..."
                  : submitted
                    ? "Update Availability"
                    : "Submit Availability"}
              </AppButton>
            </div>
          </div>
        </Panel>
      </div>
    </main>
  );
}

export default ParticipantView;
