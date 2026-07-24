"use client";

import { useState, useContext, useEffect, useRef, useCallback } from "react";
import { MdLogin, MdRefresh, MdSend } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import EventContext from "@/components/event/EventContext";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchParticipants, joinEvent, updateParticipant } from "@/lib/api/participants";
import { fetchEventResults } from "@/lib/api/events";
import "@material/web/slider/slider.js";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";

function ParticipantView() {
  const { event, numSlots } = useContext(EventContext);
  const { user, loading: authLoading, getToken } = useAuth();
  const mode = event?.mode || "inperson";
  const viewPermission = event?.participantViewPermission || "own_only";

  const [participantName, setParticipantName] = useState("");
  const [joined, setJoined] = useState(false);
  const [scheduleInperson, setScheduleInperson] = useState([]);
  const [scheduleVirtual, setScheduleVirtual] = useState([]);
  const [sliderValue, setSliderValue] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [preJoinParticipants, setPreJoinParticipants] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [results, setResults] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [joinError, setJoinError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [draftSaveState, setDraftSaveState] = useState("idle");
  const [draftSaveError, setDraftSaveError] = useState("");
  const [saveConflict, setSaveConflict] = useState(null);

  const paintModeRef = useRef(null);
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

  const responseDeadlinePassed =
    Boolean(event.responseDeadline) && Date.now() >= new Date(event.responseDeadline).getTime();
  const responseChangesDisabled = event.status !== "open" || responseDeadlinePassed;

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
      setDraftSaveError("Responses are locked, so this draft could not be saved.");
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
          token
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
    if (!event?.code || !user?.id) return;

    async function load() {
      try {
        const token = await getToken();
        const data = await fetchParticipants(event.code, token);
        const parsed = data.participants.map((participant) => ({
          ...participant,
          inpersonArray: participant.availabilityInperson.map(Number),
          virtualArray: participant.availabilityVirtual.map(Number),
        }));

        setParticipants(parsed);
        setPreJoinParticipants(
          parsed.map((participant) => ({
            id: participant.id,
            name: participant.name,
            submitted: !!participant.submitted,
          }))
        );

        const mine = parsed.find((participant) => participant.user_id === user.id);
        if (mine) {
          applyParticipantResponse(mine);
        }
        try {
          const resultData = await fetchEventResults(event.code, token);
          setResults(resultData.results);
        } catch {
          setResults(null);
        }
      } catch {
        setParticipants([]);
        setResults(null);
      }
    }
    load();
  }, [event?.code, user?.id, refreshKey, getToken, applyParticipantResponse]);

  const avgInperson = results?.channels?.inperson?.unweighted ?? Array(numSlots).fill(0);
  const avgVirtual = results?.channels?.virtual?.unweighted ?? Array(numSlots).fill(0);

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

  const makeCellPaintHandler = (channel) => (idx, e) => {
    if (e.type === "mousedown") {
      const current =
        channel === "inperson" ? scheduleInpersonRef.current : scheduleVirtualRef.current;
      paintModeRef.current = current[idx] > 0 ? "erase" : "paint";
    }

    const scheduleRef = channel === "inperson" ? scheduleInpersonRef : scheduleVirtualRef;
    const next = [...scheduleRef.current];
    next[idx] = paintModeRef.current === "erase" ? 0 : sliderValue;
    scheduleRef.current = next;
    if (channel === "inperson") setScheduleInperson(next);
    else setScheduleVirtual(next);
    queueAutosave();
  };

  const handleInpersonPaint = makeCellPaintHandler("inperson");
  const handleVirtualPaint = makeCellPaintHandler("virtual");

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
        token
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
      <div
        className="page-pad"
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "calc(100vh - 76px)",
        }}
      >
        <p style={{ color: "var(--md-sys-color-on-surface-variant)" }}>Loading...</p>
      </div>
    );
  }

  if (!joined) {
    return (
      <div
        className="page-pad"
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "calc(100vh - 76px)",
        }}
      >
        <div
          className="md-card"
          style={{
            maxWidth: "760px",
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: "24px",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <h2 style={{ color: "var(--md-sys-color-primary)", margin: 0 }}>Join Event</h2>
            <p style={{ color: "var(--md-sys-color-on-surface-variant)", margin: "8px 0 0 0" }}>
              Your account will be used as your participant identity.
            </p>
          </div>

          <EventDetailsGrid event={event} />

          <div
            style={{
              border: "1px solid var(--md-sys-color-surface-variant)",
              borderRadius: "12px",
              padding: "12px",
              background: "var(--md-sys-color-surface)",
            }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>
              Participants ({preJoinParticipants.length})
            </p>
            {preJoinParticipants.length > 0 ? (
              <div style={{ marginTop: "10px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {preJoinParticipants.map((participant) => (
                  <span
                    key={participant.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "4px 10px",
                      borderRadius: "999px",
                      border: "1px solid var(--md-sys-color-outline)",
                      fontSize: "0.85rem",
                    }}
                  >
                    <span
                      style={{
                        color: participant.submitted
                          ? "var(--md-sys-color-primary)"
                          : "var(--md-sys-color-outline)",
                      }}
                    >
                      {participant.submitted ? "●" : "○"}
                    </span>
                    {participant.name}
                  </span>
                ))}
              </div>
            ) : (
              <p
                style={{
                  margin: "8px 0 0 0",
                  color: "var(--md-sys-color-on-surface-variant)",
                  fontSize: "0.9rem",
                }}
              >
                No participants yet.
              </p>
            )}
          </div>

          {joinError && (
            <p style={{ color: "var(--md-sys-color-error)", margin: 0, fontSize: "0.9rem" }}>
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
    <div className="page-pad" style={{ maxWidth: "1400px", margin: "0 auto" }}>
      <div
        style={{
          marginBottom: "32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <div>
          <h2
            style={{
              color: "var(--md-sys-color-primary)",
              margin: "0 0 4px 0",
              fontSize: "1.8rem",
            }}
          >
            Welcome, {participantName}
            {submitted && (
              <span
                style={{
                  fontSize: "0.8rem",
                  color: "var(--md-sys-color-on-surface-variant)",
                  marginLeft: "12px",
                }}
              >
                (submitted)
              </span>
            )}
          </h2>
          <p style={{ color: "var(--md-sys-color-on-surface-variant)", margin: 0 }}>
            Set your availability.
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

      <div className="two-pane">
        <div
          style={{
            flex: viewPermission === "own_only" ? "1 1 100%" : "1 1 350px",
            display: "flex",
            flexDirection: "column",
            gap: "24px",
          }}
        >
          <div
            className="md-card"
            style={{ display: "flex", flexDirection: "column", gap: "24px" }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <label style={{ fontWeight: "500" }}>
                Availability Level:{" "}
                <span style={{ color: "var(--md-sys-color-primary)" }}>{sliderValue}</span>
              </label>
              <md-slider
                min="0"
                max="1"
                step="0.25"
                value={sliderValue}
                onInput={(e) => setSliderValue(Number(e.target.value))}
                style={{ width: "100%", maxWidth: "300px" }}
              ></md-slider>
              <p
                style={{
                  fontSize: "0.85rem",
                  color: "var(--md-sys-color-on-surface-variant)",
                  margin: 0,
                }}
              >
                0 = Busy, 1 = Free
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                <AppButton
                  onClick={() => fillAllAvailability(sliderValue)}
                  variant="outlined"
                  disabled={responseChangesDisabled}
                >
                  Apply level to all
                </AppButton>
                <AppButton
                  onClick={() => fillAllAvailability(0)}
                  variant="outlined"
                  disabled={responseChangesDisabled}
                >
                  Clear all
                </AppButton>
              </div>
            </div>

            {mode !== "virtual" && (
              <ScheduleGrid
                schedule={scheduleInperson}
                slotGroups={event.slotGroups}
                readOnly={responseChangesDisabled}
                showValues={false}
                onCellPaint={handleInpersonPaint}
                label={mode === "mixed" ? "In-Person" : undefined}
              />
            )}
            {mode !== "inperson" && (
              <ScheduleGrid
                schedule={scheduleVirtual}
                slotGroups={event.slotGroups}
                readOnly={responseChangesDisabled}
                showValues={false}
                onCellPaint={handleVirtualPaint}
                label={mode === "mixed" ? "Virtual" : undefined}
                virtual
              />
            )}

            {draftSaveState !== "idle" && (
              <div
                role={draftSaveState === "failed" ? "alert" : "status"}
                aria-live={draftSaveState === "failed" ? "assertive" : "polite"}
                style={{
                  alignItems: "center",
                  background:
                    draftSaveState === "failed"
                      ? "color-mix(in srgb, #b3261e 8%, transparent)"
                      : "var(--md-sys-color-surface-container-low)",
                  border: `1px solid ${
                    draftSaveState === "failed" ? "#b3261e" : "var(--md-sys-color-surface-variant)"
                  }`,
                  borderRadius: "8px",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "10px",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                }}
              >
                <span>
                  {draftSaveState === "saving" && "Saving draft…"}
                  {draftSaveState === "saved" && "Draft saved. Submit when you are ready."}
                  {draftSaveState === "submitted" && "Schedule submitted."}
                  {draftSaveState === "failed" && (draftSaveError || "Draft autosave failed.")}
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
                    <AppButton variant="outlined" onClick={() => void runAutosave()}>
                      Retry save
                    </AppButton>
                  ))}
              </div>
            )}

            {submitError && (
              <p
                role="alert"
                style={{ color: "var(--md-sys-color-error)", margin: 0, fontSize: "0.9rem" }}
              >
                {submitError}
              </p>
            )}
            {responseChangesDisabled && (
              <p style={{ color: "var(--md-sys-color-error)", margin: 0, fontSize: "0.9rem" }}>
                {event.status !== "open"
                  ? `Responses are locked while this event is ${event.status}.`
                  : "The response deadline has passed."}
              </p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <AppButton
                onClick={handleSubmit}
                disabled={isSubmitting || responseChangesDisabled}
                icon={<MdSend />}
              >
                {isSubmitting ? "Saving..." : submitted ? "Update Schedule" : "Submit Schedule"}
              </AppButton>
            </div>
          </div>
        </div>

        {viewPermission !== "own_only" && (
          <div
            style={{
              flex: "2 1 700px",
              display: "flex",
              flexDirection: "column",
              gap: "24px",
            }}
          >
            {results ? (
              <div className="md-card" style={{ overflowX: "auto" }}>
                <h3 style={{ margin: "0 0 8px 0", color: "var(--md-sys-color-on-surface)" }}>
                  Group Availability
                </h3>
                <p
                  style={{
                    margin: "0 0 16px 0",
                    color: "var(--md-sys-color-on-surface-variant)",
                    fontSize: "0.9rem",
                  }}
                >
                  Based on {results.countedResponseTotal} submitted response(s).{" "}
                  {results.unansweredParticipantTotal} participant(s) are still unanswered.
                </p>
                <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
                  {mode !== "virtual" && (
                    <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                      <ScheduleGrid
                        schedule={avgInperson}
                        slotGroups={event.slotGroups}
                        readOnly={true}
                        showValues={true}
                        label={mode === "mixed" ? "In-Person Availability" : "Availability"}
                      />
                    </div>
                  )}
                  {mode !== "inperson" && (
                    <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                      <ScheduleGrid
                        schedule={avgVirtual}
                        slotGroups={event.slotGroups}
                        readOnly={true}
                        showValues={true}
                        label={mode === "mixed" ? "Virtual Availability" : "Availability"}
                        virtual
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="md-card">
                <h3 style={{ margin: "0 0 8px 0" }}>Group Availability</h3>
                <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
                  Submit a valid schedule before shared results become available.
                </p>
              </div>
            )}

            {results && viewPermission !== "own_only" && participants.length > 0 && (
              <div>
                <h3 style={{ margin: "0 0 16px 0", color: "var(--md-sys-color-on-surface)" }}>
                  Individual Schedules
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                  {participants.map((participant) => (
                    <div className="md-card" key={participant.id} style={{ overflowX: "auto" }}>
                      <h4 style={{ margin: "0 0 16px 0", fontSize: "1.2rem" }}>
                        {participant.name}
                      </h4>
                      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
                        {mode !== "virtual" && (
                          <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                            <ScheduleGrid
                              schedule={participant.inpersonArray}
                              slotGroups={event.slotGroups}
                              readOnly={true}
                              showValues={true}
                              label={mode === "mixed" ? "In-Person" : "Availability"}
                            />
                          </div>
                        )}
                        {mode !== "inperson" && (
                          <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                            <ScheduleGrid
                              schedule={participant.virtualArray}
                              slotGroups={event.slotGroups}
                              readOnly={true}
                              showValues={true}
                              label={mode === "mixed" ? "Virtual" : "Availability"}
                              virtual
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ParticipantView;
