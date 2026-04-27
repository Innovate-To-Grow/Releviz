"use client";

import { useState, useContext, useEffect, useRef } from "react";
import { MdLogin, MdRefresh, MdSend } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import EventContext from "@/components/event/EventContext";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchParticipants, joinEvent, updateParticipant } from "@/lib/api/participants";
import "@material/web/slider/slider.js";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";

function ParticipantView() {
  const { event, numSlots } = useContext(EventContext);
  const { user, loading: authLoading, getToken } = useAuth();
  const mode = event?.mode || "inperson";
  const viewPermission = event?.participantViewPermission || "own_only";

  const [participantId, setParticipantId] = useState(null);
  const [participantName, setParticipantName] = useState("");
  const [joined, setJoined] = useState(false);
  const [scheduleInperson, setScheduleInperson] = useState([]);
  const [scheduleVirtual, setScheduleVirtual] = useState([]);
  const [sliderValue, setSliderValue] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [preJoinParticipants, setPreJoinParticipants] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [joinError, setJoinError] = useState("");
  const [submitError, setSubmitError] = useState("");

  const paintModeRef = useRef(null);

  useEffect(() => {
    if (!event?.code || !user?.id) return;

    getToken()
      .then((token) => fetchParticipants(event.code, token))
      .then((data) => {
        const parsed = data.participants.map((participant) => ({
          ...participant,
          inpersonArray: JSON.parse(participant.schedule_inperson).map(Number),
          virtualArray: JSON.parse(participant.schedule_virtual).map(Number),
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
          setParticipantId(mine.id);
          setParticipantName(mine.name);
          setScheduleInperson(mine.inpersonArray);
          setScheduleVirtual(mine.virtualArray);
          setSubmitted(!!mine.submitted);
          setJoined(true);
        }
      })
      .catch(() => {});
  }, [event?.code, user?.id, refreshKey, getToken]);

  const calculateAverage = (scheduleKey) => {
    if (!participants.length) return Array(numSlots).fill(0);

    const total = Array(numSlots).fill(0);
    let validCount = 0;

    participants.forEach((participant) => {
      const schedule = participant[scheduleKey];
      if (schedule.length !== numSlots) return;
      validCount++;
      schedule.forEach((value, index) => {
        total[index] += value;
      });
    });

    if (validCount === 0) return Array(numSlots).fill(0);
    return total.map((value) => parseFloat((value / validCount).toFixed(2)));
  };

  const avgInperson = calculateAverage("inpersonArray");
  const avgVirtual = calculateAverage("virtualArray");

  const handleJoin = async () => {
    setJoinError("");

    try {
      const token = await getToken();
      const { participant } = await joinEvent(event.code, token);
      setParticipantId(participant.id);
      setParticipantName(participant.name);
      setScheduleInperson(JSON.parse(participant.schedule_inperson).map(Number));
      setScheduleVirtual(JSON.parse(participant.schedule_virtual).map(Number));
      setSubmitted(!!participant.submitted);
      setJoined(true);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setJoinError(`Failed to join: ${err.message}`);
    }
  };

  const makeCellPaintHandler = (setter, schedule) => (idx, e) => {
    if (e.type === "mousedown") {
      paintModeRef.current = schedule[idx] > 0 ? "erase" : "paint";
    }

    setter((prev) => {
      const next = [...prev];
      next[idx] = paintModeRef.current === "erase" ? 0 : sliderValue;
      return next;
    });
  };

  const handleInpersonPaint = makeCellPaintHandler(setScheduleInperson, scheduleInperson);
  const handleVirtualPaint = makeCellPaintHandler(setScheduleVirtual, scheduleVirtual);

  const handleSubmit = async () => {
    if (!participantId) return;

    setIsSubmitting(true);
    setSubmitError("");

    try {
      const token = await getToken();
      await updateParticipant(
        event.code,
        participantId,
        {
          scheduleInperson: JSON.stringify(scheduleInperson),
          scheduleVirtual: JSON.stringify(scheduleVirtual),
          submitted: 1,
        },
        token
      );
      setSubmitted(true);
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
              Your Clerk account will be used as your participant identity.
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
                  color: "var(--md-sys-color-outline)",
                  marginLeft: "12px",
                }}
              >
                (submitted)
              </span>
            )}
          </h2>
          <p style={{ color: "var(--md-sys-color-on-surface-variant)", margin: 0 }}>
            Set your availability and see the group schedule.
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
        <div style={{ flex: "1 1 350px", display: "flex", flexDirection: "column", gap: "24px" }}>
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
            </div>

            {mode !== "virtual" && (
              <ScheduleGrid
                schedule={scheduleInperson}
                startHour={event.startHour}
                endHour={event.endHour}
                selectedDays={event.days}
                daySelectionType={event.daySelectionType}
                specificDates={event.specificDates}
                readOnly={false}
                showValues={false}
                onCellPaint={handleInpersonPaint}
                label={mode === "mixed" ? "In-Person" : undefined}
              />
            )}
            {mode !== "inperson" && (
              <ScheduleGrid
                schedule={scheduleVirtual}
                startHour={event.startHour}
                endHour={event.endHour}
                selectedDays={event.days}
                daySelectionType={event.daySelectionType}
                specificDates={event.specificDates}
                readOnly={false}
                showValues={false}
                onCellPaint={handleVirtualPaint}
                label={mode === "mixed" ? "Virtual" : undefined}
              />
            )}

            {submitError && (
              <p style={{ color: "var(--md-sys-color-error)", margin: 0, fontSize: "0.9rem" }}>
                {submitError}
              </p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <AppButton onClick={handleSubmit} disabled={isSubmitting} icon={<MdSend />}>
                {isSubmitting ? "Saving..." : submitted ? "Update Schedule" : "Submit Schedule"}
              </AppButton>
            </div>
          </div>
        </div>

        <div style={{ flex: "2 1 700px", display: "flex", flexDirection: "column", gap: "24px" }}>
          <div className="md-card" style={{ overflowX: "auto" }}>
            <h3 style={{ margin: "0 0 16px 0", color: "var(--md-sys-color-on-surface)" }}>
              Group Availability
            </h3>
            <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
              {mode !== "virtual" && (
                <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <ScheduleGrid
                    schedule={avgInperson}
                    startHour={event.startHour}
                    endHour={event.endHour}
                    selectedDays={event.days}
                    daySelectionType={event.daySelectionType}
                    specificDates={event.specificDates}
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
                    startHour={event.startHour}
                    endHour={event.endHour}
                    selectedDays={event.days}
                    daySelectionType={event.daySelectionType}
                    specificDates={event.specificDates}
                    readOnly={true}
                    showValues={true}
                    label={mode === "mixed" ? "Virtual Availability" : "Availability"}
                  />
                </div>
              )}
            </div>
          </div>

          {viewPermission !== "own_only" && participants.length > 0 && (
            <div>
              <h3 style={{ margin: "0 0 16px 0", color: "var(--md-sys-color-on-surface)" }}>
                Individual Schedules
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                {participants.map((participant) => (
                  <div className="md-card" key={participant.id} style={{ overflowX: "auto" }}>
                    <h4 style={{ margin: "0 0 16px 0", fontSize: "1.2rem" }}>{participant.name}</h4>
                    <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
                      {mode !== "virtual" && (
                        <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                          <ScheduleGrid
                            schedule={participant.inpersonArray}
                            startHour={event.startHour}
                            endHour={event.endHour}
                            selectedDays={event.days}
                            daySelectionType={event.daySelectionType}
                            specificDates={event.specificDates}
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
                            startHour={event.startHour}
                            endHour={event.endHour}
                            selectedDays={event.days}
                            daySelectionType={event.daySelectionType}
                            specificDates={event.specificDates}
                            readOnly={true}
                            showValues={true}
                            label={mode === "mixed" ? "Virtual" : "Availability"}
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
      </div>
    </div>
  );
}

export default ParticipantView;
