"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { MdAdd, MdHourglassEmpty, MdRefresh, MdSave } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import { createEvent, fetchEvent, updateEvent } from "@/lib/api/events";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import { DAY_LABELS } from "@/lib/constants";
import { formatIsoForDateTimeLocal, zonedLocalDateTimeToIso } from "@/lib/time";
const MODES = [
  { value: "inperson", label: "In-Person" },
  { value: "virtual", label: "Virtual" },
  { value: "mixed", label: "Mixed" },
];

function ToggleChip({ label, active, onClick }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        padding: "6px 16px",
        borderRadius: "20px",
        border: `2px solid ${active ? "var(--md-sys-color-primary)" : "var(--md-sys-color-outline)"}`,
        backgroundColor: active ? "var(--md-sys-color-primary)" : "transparent",
        color: active ? "var(--md-sys-color-on-primary)" : "var(--md-sys-color-on-surface-variant)",
        fontWeight: "500",
        fontSize: "0.9rem",
        cursor: "pointer",
        transition: "all 0.15s ease",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function LabelRow({ children }) {
  return (
    <span
      style={{
        fontSize: "0.85rem",
        fontWeight: "500",
        color: "var(--md-sys-color-on-surface-variant)",
        marginBottom: "10px",
        display: "block",
      }}
    >
      {children}
    </span>
  );
}

function CreateEvent({ operation = "create" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading, getToken } = useAuth();
  const editing = operation === "edit";
  const eventCode = searchParams.get("code") || "";
  const [name, setName] = useState("");
  const [mode, setMode] = useState("inperson"); // "inperson" | "virtual"
  const [location, setLocation] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [slotMinutes, setSlotMinutes] = useState(30);
  const [selectedDays, setSelectedDays] = useState([1, 2, 3, 4, 5]);
  const [daySelectionType, setDaySelectionType] = useState("days_of_week");
  const [specificDates, setSpecificDates] = useState([]);
  const [dateInput, setDateInput] = useState("");
  const [participantViewPermission, setParticipantViewPermission] = useState("own_only");
  const [eventTimezone, setEventTimezone] = useState("UTC");
  const [responseDeadline, setResponseDeadline] = useState("");
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  const [reminderHoursBefore, setReminderHoursBefore] = useState(24);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingEvent, setLoadingEvent] = useState(editing);
  const [eventVersion, setEventVersion] = useState(null);
  const [resetRequired, setResetRequired] = useState(false);
  const [resetParticipantCount, setResetParticipantCount] = useState(0);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [conflictEvent, setConflictEvent] = useState(null);

  useEffect(() => {
    if (!authLoading && !user) {
      const next = editing ? `/edit?code=${encodeURIComponent(eventCode)}` : "/create";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [authLoading, editing, eventCode, user, router]);

  useEffect(() => {
    if (!editing) {
      setEventTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    }
  }, [editing]);

  useEffect(() => {
    if (!editing || authLoading || !user) return;
    if (!eventCode) {
      setError("No event code was provided for editing.");
      setLoadingEvent(false);
      return;
    }
    let active = true;
    async function loadEvent() {
      try {
        const token = await getToken();
        const { event } = await fetchEvent(eventCode, token);
        if (!active) return;
        if (event.organizerUserId !== user.id) {
          throw new Error("Only the organizer can edit this event.");
        }
        setName(event.name || "");
        setMode(event.mode || "inperson");
        setLocation(event.location === "TBD" ? "" : event.location || "");
        setStartTime(event.startTime || "09:00");
        setEndTime(event.endTime || "17:00");
        setSlotMinutes(event.slotMinutes || 30);
        setSelectedDays(event.days || []);
        setDaySelectionType(event.daySelectionType || "days_of_week");
        setSpecificDates(event.specificDates || []);
        setParticipantViewPermission(event.participantViewPermission || "own_only");
        setEventTimezone(event.timezone || "UTC");
        setResponseDeadline(
          event.responseDeadline
            ? formatIsoForDateTimeLocal(event.responseDeadline, event.timezone || "UTC")
            : ""
        );
        setRemindersEnabled(event.remindersEnabled !== false);
        setReminderHoursBefore(event.reminderHoursBefore ?? 24);
        setEventVersion(event.version);
      } catch (err) {
        if (active) setError(err.message || "Failed to load the event.");
      } finally {
        if (active) setLoadingEvent(false);
      }
    }
    loadEvent();
    return () => {
      active = false;
    };
  }, [editing, authLoading, eventCode, user, getToken]);

  const toggleDay = (idx) => {
    setSelectedDays((prev) =>
      prev.includes(idx) ? prev.filter((d) => d !== idx) : [...prev, idx].sort()
    );
  };

  const handleSubmit = async (submitEvent) => {
    submitEvent?.preventDefault();
    setError("");
    setConflictEvent(null);
    const errors = [];
    if (!name.trim()) errors.push("Event name is required");
    // Location is optional — backend defaults to "TBD" for non-virtual events
    const toMinutes = (value) => {
      const [hour, minute] = value.split(":").map(Number);
      return hour * 60 + minute;
    };
    const startMinutes = toMinutes(startTime);
    const endMinutes = toMinutes(endTime);
    if (startMinutes === endMinutes) errors.push("Start and end times must be different");
    if (startMinutes % slotMinutes || endMinutes % slotMinutes) {
      errors.push(`Times must align to ${slotMinutes}-minute slots`);
    }
    if (daySelectionType === "days_of_week" && selectedDays.length === 0) {
      errors.push("Select at least one day");
    }
    if (daySelectionType === "specific_dates" && specificDates.length === 0) {
      errors.push("Select at least one date");
    }
    if (!eventTimezone.trim()) errors.push("Event timezone is required");
    if (errors.length > 0) {
      setError(errors.join(" · "));
      return;
    }

    setLoading(true);
    try {
      const payload = {
        name: name.trim(),
        startTime,
        endTime,
        slotMinutes,
        days: daySelectionType === "days_of_week" ? selectedDays : [],
        mode,
        location: location.trim(),
        participantViewPermission,
        daySelectionType,
        responseDeadline: responseDeadline
          ? zonedLocalDateTimeToIso(responseDeadline, eventTimezone.trim())
          : null,
        timezone: eventTimezone.trim(),
        remindersEnabled,
        reminderHoursBefore,
        ...(daySelectionType === "specific_dates"
          ? { specificDates: [...specificDates].sort() }
          : {}),
      };
      const token = await getToken();
      const { event } = editing
        ? await updateEvent(
            eventCode,
            {
              ...payload,
              expectedVersion: eventVersion,
              resetResponses: resetRequired && resetConfirmed,
            },
            token
          )
        : await createEvent(payload, token);

      router.replace(`/event?code=${event.code}`);
    } catch (err) {
      if (err.requiresResponseReset) {
        setResetRequired(true);
        setResetParticipantCount(err.participantCount || 0);
      }
      if (err.event) setConflictEvent(err.event);
      setError(err.message || (editing ? "Failed to save event" : "Failed to create event"));
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || !user || loadingEvent) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <p style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
          {editing ? "Loading event..." : "Loading..."}
        </p>
      </div>
    );
  }

  if (editing && eventVersion === null) {
    return (
      <div className="center-page page-pad">
        <div className="md-card" style={{ maxWidth: "480px", width: "100%" }}>
          <h1 style={{ color: "var(--md-sys-color-error)", marginBottom: "12px" }}>
            Unable to edit event
          </h1>
          <p role="alert" style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
            {error || "This event could not be loaded."}
          </p>
          <Link href="/dashboard" className="dashboard-action-link" style={{ marginTop: "20px" }}>
            Return to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="md-card"
        style={{
          maxWidth: "640px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <h1 style={{ color: "var(--md-sys-color-primary)", margin: 0, fontSize: "1.8rem" }}>
            {editing ? "Edit event" : "Create event"}
          </h1>
        </div>

        {/* Event name */}
        <md-outlined-text-field
          label="Event Name"
          value={name}
          onInput={(e) => setName(e.target.value)}
          maxLength="200"
          style={{ width: "100%" }}
        ></md-outlined-text-field>

        {/* Mode */}
        <div>
          <LabelRow>Meeting Type</LabelRow>
          <div className="chip-row" style={{ display: "flex", gap: "8px" }}>
            {MODES.map((m) => (
              <ToggleChip
                key={m.value}
                label={m.label}
                active={mode === m.value}
                onClick={() => setMode(m.value)}
              />
            ))}
          </div>
        </div>

        {/* Location (shown for inperson and mixed) */}
        {mode !== "virtual" && (
          <md-outlined-text-field
            label="Location / Address"
            value={location}
            onInput={(e) => setLocation(e.target.value)}
            placeholder="TBD"
            style={{ width: "100%" }}
          ></md-outlined-text-field>
        )}

        {/* Day selection type */}
        <div>
          <LabelRow>Day Selection</LabelRow>
          <div className="chip-row" style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <ToggleChip
              label="Days of Week"
              active={daySelectionType === "days_of_week"}
              onClick={() => setDaySelectionType("days_of_week")}
            />
            <ToggleChip
              label="Specific Dates"
              active={daySelectionType === "specific_dates"}
              onClick={() => setDaySelectionType("specific_dates")}
            />
          </div>
          {daySelectionType === "days_of_week" ? (
            <div className="chip-row" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {DAY_LABELS.map((label, idx) => (
                <ToggleChip
                  key={idx}
                  label={label}
                  active={selectedDays.includes(idx)}
                  onClick={() => toggleDay(idx)}
                />
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                <input
                  aria-label="Specific event date"
                  type="date"
                  value={dateInput}
                  onChange={(e) => setDateInput(e.target.value)}
                  style={{
                    flex: 1,
                    padding: "10px",
                    borderRadius: "8px",
                    border: "1px solid var(--md-sys-color-outline)",
                    fontSize: "0.9rem",
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (dateInput && !specificDates.includes(dateInput)) {
                      setSpecificDates((prev) => [...prev, dateInput].sort());
                      setDateInput("");
                    }
                  }}
                  style={{
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "1px solid var(--md-sys-color-primary)",
                    background: "var(--md-sys-color-primary)",
                    color: "var(--md-sys-color-on-primary)",
                    cursor: "pointer",
                    fontWeight: "500",
                  }}
                >
                  Add
                </button>
              </div>
              {specificDates.length > 0 && (
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {specificDates.map((d) => (
                    <span
                      key={d}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "4px 12px",
                        borderRadius: "16px",
                        border: "1px solid var(--md-sys-color-primary)",
                        background: "var(--md-sys-color-primary)",
                        color: "var(--md-sys-color-on-primary)",
                        fontSize: "0.85rem",
                      }}
                    >
                      {d}
                      <button
                        type="button"
                        aria-label={`Remove ${d}`}
                        onClick={() => setSpecificDates((prev) => prev.filter((x) => x !== d))}
                        style={{
                          background: "none",
                          border: "none",
                          color: "inherit",
                          cursor: "pointer",
                          fontSize: "1rem",
                          padding: "0 0 0 4px",
                          lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Time range */}
        <div>
          <LabelRow>Event Timezone</LabelRow>
          <input
            aria-label="Event timezone"
            value={eventTimezone}
            onChange={(e) => setEventTimezone(e.target.value)}
            placeholder="America/Los_Angeles"
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: "8px",
              border: "1px solid var(--md-sys-color-outline)",
              fontSize: "0.9rem",
              boxSizing: "border-box",
            }}
          />
          <p
            style={{
              margin: "6px 0 0",
              color: "var(--md-sys-color-on-surface-variant)",
              fontSize: "0.8rem",
            }}
          >
            Use an IANA timezone such as America/Los_Angeles or Europe/Paris.
          </p>
        </div>

        {/* Time range */}
        <div className="time-row" style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          <label style={{ flex: "1 1 150px" }}>
            <LabelRow>Start Time</LabelRow>
            <input
              aria-label="Start Time"
              type="time"
              step={slotMinutes * 60}
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: "8px",
                border: "1px solid var(--md-sys-color-outline)",
                boxSizing: "border-box",
              }}
            />
          </label>
          <label style={{ flex: "1 1 150px" }}>
            <LabelRow>End Time</LabelRow>
            <input
              aria-label="End Time"
              type="time"
              step={slotMinutes * 60}
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: "8px",
                border: "1px solid var(--md-sys-color-outline)",
                boxSizing: "border-box",
              }}
            />
          </label>
          <label style={{ flex: "1 1 150px" }}>
            <LabelRow>Slot Duration</LabelRow>
            <select
              aria-label="Slot Duration"
              value={slotMinutes}
              onChange={(event) => setSlotMinutes(Number(event.target.value))}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: "8px",
                border: "1px solid var(--md-sys-color-outline)",
                boxSizing: "border-box",
                background: "var(--md-sys-color-surface)",
              }}
            >
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
            </select>
          </label>
        </div>
        <p
          style={{
            margin: "-16px 0 0",
            color: "var(--md-sys-color-on-surface-variant)",
            fontSize: "0.8rem",
          }}
        >
          An end time earlier than the start time creates an overnight window. Events may contain up
          to 1,000 availability slots.
        </p>

        {/* Participant view permission */}
        <div>
          <LabelRow>Participant View</LabelRow>
          <md-outlined-select
            aria-label="Participant View"
            value={participantViewPermission}
            onInput={(e) => setParticipantViewPermission(e.target.value)}
            style={{ width: "100%" }}
          >
            <md-select-option value="own_only">
              <div slot="headline">Own schedule only</div>
            </md-select-option>
            <md-select-option value="all_after_submit">
              <div slot="headline">Submitted schedules after I submit</div>
            </md-select-option>
            <md-select-option value="realtime">
              <div slot="headline">Submitted schedules in real time</div>
            </md-select-option>
          </md-outlined-select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <LabelRow>Response Deadline</LabelRow>
          <input
            aria-label="Response Deadline"
            type="datetime-local"
            value={responseDeadline}
            onChange={(e) => setResponseDeadline(e.target.value)}
            style={{
              padding: "10px",
              borderRadius: "8px",
              border: "1px solid var(--md-sys-color-outline)",
              fontSize: "0.9rem",
            }}
          />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "var(--md-sys-color-on-surface-variant)",
              fontSize: "0.9rem",
            }}
          >
            <input
              type="checkbox"
              checked={remindersEnabled}
              onChange={(e) => setRemindersEnabled(e.target.checked)}
            />
            Send reminder emails before the deadline
          </label>
          <div>
            <LabelRow>Reminder Hours Before Deadline</LabelRow>
            <input
              aria-label="Reminder Hours Before Deadline"
              type="number"
              min="0"
              max="720"
              value={reminderHoursBefore}
              onChange={(e) => setReminderHoursBefore(Number(e.target.value))}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: "8px",
                border: "1px solid var(--md-sys-color-outline)",
                fontSize: "0.9rem",
                boxSizing: "border-box",
              }}
            />
          </div>
        </div>

        {error && (
          <p
            role="alert"
            style={{ color: "var(--md-sys-color-error)", margin: 0, fontSize: "0.9rem" }}
          >
            {error}
          </p>
        )}

        {conflictEvent && (
          <div className="event-form-warning">
            <p>
              The latest saved version is <strong>{conflictEvent.version}</strong>. Reload before
              deciding which edits to keep.
            </p>
            <AppButton
              variant="outlined"
              icon={<MdRefresh />}
              onClick={() => window.location.reload()}
            >
              Reload latest event
            </AppButton>
          </div>
        )}

        {resetRequired && (
          <div className="event-form-warning" role="alert">
            <strong>Schedule changes require a response reset</strong>
            <p>
              Saving will clear draft and submitted availability for {resetParticipantCount}{" "}
              {resetParticipantCount === 1 ? "participant" : "participants"}. Invitations and
              participant membership will remain.
            </p>
            <label>
              <input
                type="checkbox"
                checked={resetConfirmed}
                onChange={(event) => setResetConfirmed(event.target.checked)}
              />
              I understand that participant availability will be reset.
            </label>
          </div>
        )}

        <AppButton
          type="submit"
          disabled={loading || (resetRequired && !resetConfirmed)}
          fullWidth={true}
          icon={loading ? <MdHourglassEmpty /> : editing ? <MdSave /> : <MdAdd />}
        >
          {loading
            ? editing
              ? "Saving..."
              : "Creating..."
            : editing
              ? "Save changes"
              : "Create Event"}
        </AppButton>
        {editing && (
          <Link href={`/event?code=${encodeURIComponent(eventCode)}`} className="event-form-cancel">
            Cancel and return to event
          </Link>
        )}
      </form>
    </div>
  );
}

export default CreateEvent;
