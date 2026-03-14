"use client";

import { useState, useEffect, useContext, useCallback, useRef } from "react";
import { GoVerified, GoUnverified } from "react-icons/go";
import {
  MdDeleteOutline,
  MdLogin,
  MdRefresh,
  MdSave,
  MdArrowUpward,
  MdArrowDownward,
} from "react-icons/md";
import EventContext from "@/components/event/EventContext";
import AppButton from "@/components/ui/AppButton";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import {
  deleteParticipant,
  fetchParticipantsIncludeHidden,
  joinEvent,
  unhideParticipant,
  updateParticipant,
} from "@/lib/api/participants";
import { fetchWeights, updateWeights } from "@/lib/api/weights";
import "@material/web/checkbox/checkbox.js";
import "@material/web/slider/slider.js";
import "@material/web/dialog/dialog.js";
import "@material/web/textfield/outlined-text-field.js";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";

function OrganizerView() {
  const { event, numSlots } = useContext(EventContext);
  const mode = event?.mode || "inperson";

  const [participants, setParticipants] = useState([]);
  const [weights, setWeights] = useState({}); // { name: { weight, included } }
  const [refreshKey, setRefreshKey] = useState(0);

  // Ref tracks latest weights synchronously to avoid stale closures in debounce
  const weightsRef = useRef({});
  useEffect(() => {
    weightsRef.current = weights;
  }, [weights]);
  const saveTimer = useRef(null);
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Organizer self-schedule state
  const [myName, setMyName] = useState("");
  const [myJoined, setMyJoined] = useState(false);
  const [myInperson, setMyInperson] = useState([]);
  const [myVirtual, setMyVirtual] = useState([]);
  const [mySaving, setMySaving] = useState(false);
  const [hidingName, setHidingName] = useState("");
  const [hideError, setHideError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  // Load participants and weights in parallel
  useEffect(() => {
    async function load() {
      try {
        const [participantsRes, weightsRes] = await Promise.all([
          fetchParticipantsIncludeHidden(event.code),
          fetchWeights(event.code),
        ]);

        const parsed = participantsRes.participants.map((p) => ({
          ...p,
          inpersonArray: JSON.parse(p.schedule_inperson).map(Number),
          virtualArray: JSON.parse(p.schedule_virtual).map(Number),
        }));
        setParticipants(parsed);

        const map = {};
        weightsRes.weights.forEach((w) => {
          map[w.participant_name] = { weight: w.weight, included: w.included };
        });
        setWeights(map);
      } catch (err) {
        console.error("Failed to load data", err);
      }
    }
    load();
  }, [event.code, refreshKey]);

  const saveWeights = useCallback(
    async (newWeights) => {
      try {
        const arr = Object.entries(newWeights).map(([name, w]) => ({
          name,
          weight: w.weight,
          included: w.included,
        }));
        await updateWeights(event.code, arr);
      } catch (err) {
        console.error("Failed to save weights", err);
      }
    },
    [event.code]
  );

  const handleWeightChange = (name, val) => {
    const current = weightsRef.current[name] ?? { weight: 1.0, included: 1 };
    const next = { ...weightsRef.current, [name]: { ...current, weight: val } };
    weightsRef.current = next;
    setWeights(next);
    // Debounce: only send API call 500ms after user stops dragging
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveWeights(weightsRef.current), 500);
  };

  const handleIncludedChange = (name, val) => {
    const current = weightsRef.current[name] ?? { weight: 1.0, included: 1 };
    const next = { ...weightsRef.current, [name]: { ...current, included: val ? 1 : 0 } };
    weightsRef.current = next;
    setWeights(next);
    saveWeights(next); // checkbox fires once, save immediately
  };

  const handleMyJoin = async () => {
    if (!myName.trim()) return;
    try {
      const { participant } = await joinEvent(event.code, myName.trim());
      setMyInperson(JSON.parse(participant.schedule_inperson).map(Number));
      setMyVirtual(JSON.parse(participant.schedule_virtual).map(Number));
      setMyJoined(true);
    } catch (err) {
      console.error("Failed to join:", err);
    }
  };

  const handleMyInpersonPaint = (idx) => {
    setMyInperson((prev) => {
      const n = [...prev];
      n[idx] = n[idx] === 1 ? 0 : 1;
      return n;
    });
  };

  const handleMyVirtualPaint = (idx) => {
    setMyVirtual((prev) => {
      const n = [...prev];
      n[idx] = n[idx] === 1 ? 0 : 1;
      return n;
    });
  };

  const handleMySave = async () => {
    setMySaving(true);
    try {
      await updateParticipant(event.code, myName, {
        scheduleInperson: JSON.stringify(myInperson),
        scheduleVirtual: JSON.stringify(myVirtual),
        submitted: 1,
      });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error("Failed to save:", err);
    } finally {
      setMySaving(false);
    }
  };

  const handleHideParticipant = async (participantName) => {
    if (!participantName) return;
    setHideError("");
    setHidingName(participantName);
    try {
      await deleteParticipant(event.code, participantName);
      setParticipants((prev) =>
        prev.map((p) => (p.name === participantName ? { ...p, hidden: 1 } : p))
      );
    } catch (err) {
      setHideError(`Failed to hide participant: ${err.message}`);
    } finally {
      setHidingName("");
    }
  };

  const handleUnhideParticipant = async (participantName) => {
    if (!participantName) return;
    setHideError("");
    setHidingName(participantName);
    try {
      await unhideParticipant(event.code, participantName);
      setParticipants((prev) =>
        prev.map((p) => (p.name === participantName ? { ...p, hidden: 0 } : p))
      );
    } catch (err) {
      setHideError(`Failed to unhide participant: ${err.message}`);
    } finally {
      setHidingName("");
    }
  };

  const handleGroupChange = async (participantName, groupName) => {
    try {
      await updateParticipant(event.code, participantName, { groupName });
      setParticipants((prev) =>
        prev.map((p) => (p.name === participantName ? { ...p, group_name: groupName } : p))
      );
    } catch (err) {
      console.error("Failed to update group:", err);
    }
  };

  const handleMoveParticipant = async (participantName, direction) => {
    const sorted = [...activeParticipants].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    );
    const idx = sorted.findIndex((p) => p.name === participantName);
    if ((direction === "up" && idx <= 0) || (direction === "down" && idx >= sorted.length - 1))
      return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    const myOrder = sorted[idx].sort_order ?? idx;
    const theirOrder = sorted[swapIdx].sort_order ?? swapIdx;
    try {
      await Promise.all([
        updateParticipant(event.code, sorted[idx].name, { sortOrder: theirOrder }),
        updateParticipant(event.code, sorted[swapIdx].name, { sortOrder: myOrder }),
      ]);
      setParticipants((prev) =>
        prev.map((p) => {
          if (p.name === sorted[idx].name) return { ...p, sort_order: theirOrder };
          if (p.name === sorted[swapIdx].name) return { ...p, sort_order: myOrder };
          return p;
        })
      );
    } catch (err) {
      console.error("Failed to reorder:", err);
    }
  };

  const handleCheckAll = (included) => {
    const next = { ...weightsRef.current };
    activeParticipants.forEach((p) => {
      const current = next[p.name] ?? { weight: 1.0, included: 1 };
      next[p.name] = { ...current, included: included ? 1 : 0 };
    });
    weightsRef.current = next;
    setWeights(next);
    saveWeights(next);
  };

  const activeParticipants = participants
    .filter((p) => !p.hidden)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const hiddenParticipants = participants.filter((p) => p.hidden);
  const filteredParticipants = searchQuery
    ? activeParticipants.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : activeParticipants;

  // Group participants by group_name
  const groups = {};
  filteredParticipants.forEach((p) => {
    const gn = p.group_name || "";
    if (!groups[gn]) groups[gn] = [];
    groups[gn].push(p);
  });
  const groupNames = Object.keys(groups).sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  // Calculate weighted average for a given schedule type (excludes hidden)
  const calculateWeightedAverage = (scheduleKey) => {
    if (!activeParticipants.length) return Array(numSlots).fill(0);
    const total = Array(numSlots).fill(0);
    let totalWeight = 0;

    activeParticipants.forEach((p) => {
      // Use defaults for participants not yet in the weights map
      const w = weights[p.name] ?? { weight: 1.0, included: 1 };
      if (!w.included) return;
      const weight = w.weight;
      if (weight <= 0) return;
      const schedule = p[scheduleKey];
      if (schedule.length !== numSlots) return;
      totalWeight += weight;
      schedule.forEach((val, idx) => {
        total[idx] += val * weight;
      });
    });

    if (totalWeight === 0) return Array(numSlots).fill(0);
    return total.map((v) => parseFloat((v / totalWeight).toFixed(2)));
  };

  const weightedInperson = calculateWeightedAverage("inpersonArray");
  const weightedVirtual = calculateWeightedAverage("virtualArray");
  const submittedCount = activeParticipants.filter((p) => p.submitted).length;

  const inpersonDetails = activeParticipants
    .filter((p) => {
      const w = weights[p.name] ?? { weight: 1.0, included: 1 };
      return w.included && p.inpersonArray.length === numSlots;
    })
    .map((p) => ({ name: p.name, schedule: p.inpersonArray }));

  const virtualDetails = activeParticipants
    .filter((p) => {
      const w = weights[p.name] ?? { weight: 1.0, included: 1 };
      return w.included && p.virtualArray.length === numSlots;
    })
    .map((p) => ({ name: p.name, schedule: p.virtualArray }));

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
            className="organizer-title"
            style={{
              color: "var(--md-sys-color-primary)",
              margin: "0 0 4px 0",
              fontSize: "1.8rem",
            }}
          >
            Organizer Dashboard
          </h2>
          <p style={{ color: "var(--md-sys-color-on-surface-variant)", margin: 0 }}>
            Manage participants and find the best meeting time.
          </p>
        </div>
        <AppButton
          onClick={() => setRefreshKey((k) => k + 1)}
          variant="outlined"
          icon={<MdRefresh />}
        >
          Refresh
        </AppButton>
      </div>

      <div
        className="md-card"
        style={{ marginBottom: "24px", display: "flex", flexDirection: "column", gap: "12px" }}
      >
        <h3 style={{ margin: 0, color: "var(--md-sys-color-on-surface)" }}>Event Details</h3>
        <EventDetailsGrid
          event={event}
          extraCards={[
            { label: "Participants", value: activeParticipants.length },
            { label: "Submitted", value: `${submittedCount} / ${activeParticipants.length}` },
          ]}
        />
      </div>

      <div className="two-pane">
        {/* Left pane: Participants + My Schedule */}
        <div style={{ flex: "1 1 350px", display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* My Schedule */}
          <div className="md-card">
            <h3 style={{ margin: "0 0 16px 0", color: "var(--md-sys-color-on-surface)" }}>
              My Schedule
            </h3>
            {!myJoined ? (
              <div
                style={{ display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" }}
              >
                <md-outlined-text-field
                  label="Your Name"
                  value={myName}
                  onInput={(e) => setMyName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleMyJoin()}
                  style={{ flex: 1 }}
                ></md-outlined-text-field>
                <AppButton onClick={handleMyJoin} icon={<MdLogin />}>
                  Join
                </AppButton>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
                  Editing as <strong>{myName}</strong>. Click cells to toggle availability.
                </p>
                {mode !== "virtual" && (
                  <ScheduleGrid
                    schedule={myInperson}
                    startHour={event.startHour}
                    endHour={event.endHour}
                    selectedDays={event.days}
                    daySelectionType={event.daySelectionType}
                    specificDates={event.specificDates}
                    readOnly={false}
                    showValues={false}
                    onCellPaint={handleMyInpersonPaint}
                    label={mode === "mixed" ? "In-Person" : undefined}
                  />
                )}
                {mode !== "inperson" && (
                  <ScheduleGrid
                    schedule={myVirtual}
                    startHour={event.startHour}
                    endHour={event.endHour}
                    selectedDays={event.days}
                    daySelectionType={event.daySelectionType}
                    specificDates={event.specificDates}
                    readOnly={false}
                    showValues={false}
                    onCellPaint={handleMyVirtualPaint}
                    label={mode === "mixed" ? "Virtual" : undefined}
                  />
                )}
                <AppButton onClick={handleMySave} disabled={mySaving} icon={<MdSave />}>
                  {mySaving ? "Saving..." : "Save My Schedule"}
                </AppButton>
              </div>
            )}
          </div>

          <div className="md-card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "12px",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              <h3 style={{ margin: 0, color: "var(--md-sys-color-on-surface)" }}>Participants</h3>
              <div style={{ display: "flex", gap: "8px" }}>
                <AppButton
                  variant="outlined"
                  onClick={() => handleCheckAll(true)}
                  style={{ fontSize: "0.8rem" }}
                >
                  Check All
                </AppButton>
                <AppButton
                  variant="outlined"
                  onClick={() => handleCheckAll(false)}
                  style={{ fontSize: "0.8rem" }}
                >
                  Uncheck All
                </AppButton>
              </div>
            </div>

            <md-outlined-text-field
              label="Search participants"
              value={searchQuery}
              onInput={(e) => setSearchQuery(e.target.value)}
              style={{ width: "100%", marginBottom: "16px" }}
            ></md-outlined-text-field>

            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {groupNames.map((gn) => (
                <div key={gn || "__ungrouped"}>
                  {gn && (
                    <h4
                      style={{
                        margin: "8px 0",
                        color: "var(--md-sys-color-secondary)",
                        fontSize: "0.95rem",
                      }}
                    >
                      {gn}
                    </h4>
                  )}
                  {groups[gn].map((p) => {
                    const w = weights[p.name] || { weight: 1, included: 1 };
                    return (
                      <div
                        key={p.name}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "12px",
                          padding: "16px",
                          border: "1px solid var(--md-sys-color-surface-variant)",
                          borderRadius: "12px",
                          backgroundColor: w.included
                            ? "var(--md-sys-color-surface-container-low)"
                            : "var(--md-sys-color-surface)",
                          opacity: w.included ? 1 : 0.5,
                          marginBottom: "8px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                            <md-checkbox
                              checked={w.included ? true : undefined}
                              onInput={(e) => handleIncludedChange(p.name, e.target.checked)}
                            ></md-checkbox>
                            <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>{p.name}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                            <span
                              style={{
                                color: p.submitted
                                  ? "var(--md-sys-color-primary)"
                                  : "var(--md-sys-color-outline)",
                              }}
                              title={p.submitted ? "Submitted" : "Not submitted"}
                            >
                              {p.submitted ? <GoVerified size={20} /> : <GoUnverified size={20} />}
                            </span>
                            <button
                              onClick={() => handleMoveParticipant(p.name, "up")}
                              title="Move up"
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                color: "var(--md-sys-color-on-surface-variant)",
                                padding: "4px",
                              }}
                            >
                              <MdArrowUpward size={18} />
                            </button>
                            <button
                              onClick={() => handleMoveParticipant(p.name, "down")}
                              title="Move down"
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                color: "var(--md-sys-color-on-surface-variant)",
                                padding: "4px",
                              }}
                            >
                              <MdArrowDownward size={18} />
                            </button>
                            <AppButton
                              variant="outlined"
                              icon={<MdDeleteOutline />}
                              onClick={() => handleHideParticipant(p.name)}
                              disabled={hidingName === p.name}
                              className="app-btn-danger"
                            >
                              {hidingName === p.name ? "Hiding..." : "Hide"}
                            </AppButton>
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "16px",
                            paddingLeft: "40px",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "0.9rem",
                              color: "var(--md-sys-color-on-surface-variant)",
                            }}
                          >
                            Weight
                          </span>
                          <md-slider
                            min="0"
                            max="1"
                            step="0.01"
                            value={w.weight}
                            onInput={(e) => handleWeightChange(p.name, Number(e.target.value))}
                            style={{ flex: 1 }}
                          ></md-slider>
                          <span
                            style={{
                              minWidth: "36px",
                              textAlign: "right",
                              fontWeight: "500",
                              color: "var(--md-sys-color-primary)",
                            }}
                          >
                            {w.weight.toFixed(2)}
                          </span>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            paddingLeft: "40px",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "0.85rem",
                              color: "var(--md-sys-color-on-surface-variant)",
                            }}
                          >
                            Group
                          </span>
                          <input
                            type="text"
                            value={p.group_name || ""}
                            onChange={(e) => handleGroupChange(p.name, e.target.value)}
                            placeholder="(none)"
                            style={{
                              flex: 1,
                              padding: "4px 8px",
                              borderRadius: "6px",
                              border: "1px solid var(--md-sys-color-outline)",
                              fontSize: "0.85rem",
                              background: "var(--md-sys-color-surface)",
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
              {activeParticipants.length === 0 && (
                <p
                  style={{
                    color: "var(--md-sys-color-outline)",
                    fontStyle: "italic",
                    textAlign: "center",
                  }}
                >
                  No participants yet. Share the event link!
                </p>
              )}
            </div>

            {/* Hidden participants section */}
            {hiddenParticipants.length > 0 && (
              <div style={{ marginTop: "24px" }}>
                <button
                  onClick={() => setShowHidden((v) => !v)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--md-sys-color-on-surface-variant)",
                    fontSize: "0.9rem",
                    fontWeight: "500",
                    padding: 0,
                  }}
                >
                  {showHidden ? "▼" : "▶"} Hidden Participants ({hiddenParticipants.length})
                </button>
                {showHidden && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      marginTop: "12px",
                    }}
                  >
                    {hiddenParticipants.map((p) => (
                      <div
                        key={p.name}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 16px",
                          border: "1px solid var(--md-sys-color-surface-variant)",
                          borderRadius: "8px",
                          opacity: 0.6,
                        }}
                      >
                        <span>{p.name}</span>
                        <AppButton
                          variant="outlined"
                          onClick={() => handleUnhideParticipant(p.name)}
                          disabled={hidingName === p.name}
                        >
                          {hidingName === p.name ? "..." : "Unhide"}
                        </AppButton>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right pane: Aggregate grids side by side */}
        <div style={{ flex: "2 1 700px", display: "flex", flexDirection: "column", gap: "24px" }}>
          <div className="md-card" style={{ overflowX: "auto" }}>
            <h3 style={{ margin: "0 0 4px 0", color: "var(--md-sys-color-on-surface)" }}>
              Group Availability
            </h3>
            {event.location && (
              <p
                style={{
                  margin: "0 0 16px 0",
                  fontSize: "0.9rem",
                  color: "var(--md-sys-color-on-surface-variant)",
                }}
              >
                {event.location}
              </p>
            )}
            <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
              {mode !== "virtual" && (
                <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <ScheduleGrid
                    schedule={weightedInperson}
                    startHour={event.startHour}
                    endHour={event.endHour}
                    selectedDays={event.days}
                    daySelectionType={event.daySelectionType}
                    specificDates={event.specificDates}
                    readOnly={true}
                    showValues={true}
                    label={mode === "mixed" ? "In-Person Availability" : "Availability"}
                    participantDetails={inpersonDetails}
                  />
                </div>
              )}
              {mode !== "inperson" && (
                <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <ScheduleGrid
                    schedule={weightedVirtual}
                    startHour={event.startHour}
                    endHour={event.endHour}
                    selectedDays={event.days}
                    daySelectionType={event.daySelectionType}
                    specificDates={event.specificDates}
                    readOnly={true}
                    showValues={true}
                    label={mode === "mixed" ? "Virtual Availability" : "Availability"}
                    participantDetails={virtualDetails}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Individual schedules */}
          {activeParticipants.length > 0 && (
            <div>
              <h3 style={{ margin: "0 0 16px 0", color: "var(--md-sys-color-on-surface)" }}>
                Individual Schedules
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                {activeParticipants.map((p) => {
                  const w = weights[p.name] || { weight: 1, included: 1 };
                  return (
                    <div className="md-card" key={p.name} style={{ overflowX: "auto" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "16px",
                        }}
                      >
                        <h4 style={{ margin: 0, fontSize: "1.2rem" }}>{p.name}</h4>
                        <div
                          style={{
                            fontSize: "0.9rem",
                            color: "var(--md-sys-color-on-surface-variant)",
                            backgroundColor: "var(--md-sys-color-surface-variant)",
                            padding: "4px 8px",
                            borderRadius: "16px",
                          }}
                        >
                          Weight: <span style={{ fontWeight: "bold" }}>{w.weight.toFixed(2)}</span>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
                        {mode !== "virtual" && (
                          <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                            <ScheduleGrid
                              schedule={p.inpersonArray}
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
                              schedule={p.virtualArray}
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
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {hideError && (
        <p
          style={{
            color: "var(--md-sys-color-error)",
            margin: "16px 0 0 0",
            fontSize: "0.9rem",
          }}
        >
          {hideError}
        </p>
      )}
    </div>
  );
}

export default OrganizerView;
