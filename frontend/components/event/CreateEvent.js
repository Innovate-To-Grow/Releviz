"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MdAdd, MdHourglassEmpty } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import { createEvent } from "@/lib/api/events";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import { DAY_LABELS } from "@/lib/constants";
const MODES = [
  { value: "inperson", label: "In-Person" },
  { value: "virtual", label: "Virtual" },
  { value: "mixed", label: "Mixed" },
];

function ToggleChip({ label, active, onClick }) {
  return (
    <button
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
    <label
      style={{
        fontSize: "0.85rem",
        fontWeight: "500",
        color: "var(--md-sys-color-on-surface-variant)",
        marginBottom: "10px",
        display: "block",
      }}
    >
      {children}
    </label>
  );
}

function CreateEvent() {
  const router = useRouter();
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [mode, setMode] = useState("inperson"); // "inperson" | "virtual"
  const [location, setLocation] = useState("");
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(17);
  const [selectedDays, setSelectedDays] = useState([1, 2, 3, 4, 5]);
  const [daySelectionType, setDaySelectionType] = useState("days_of_week");
  const [specificDates, setSpecificDates] = useState([]);
  const [dateInput, setDateInput] = useState("");
  const [password, setPassword] = useState("");
  const [participantVerification, setParticipantVerification] = useState("none");
  const [participantViewPermission, setParticipantViewPermission] = useState("own_only");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const hours = [];
  for (let i = 0; i <= 23; i++) {
    const label =
      i === 0 ? "12:00 AM" : i < 12 ? `${i}:00 AM` : i === 12 ? "12:00 PM" : `${i - 12}:00 PM`;
    hours.push({ value: i, label });
  }

  const toggleDay = (idx) => {
    setSelectedDays((prev) =>
      prev.includes(idx) ? prev.filter((d) => d !== idx) : [...prev, idx].sort()
    );
  };

  const handleSubmit = async () => {
    setError("");
    const errors = [];
    if (!name.trim()) errors.push("Event name is required");
    if (!user && !password) errors.push("Password is required");
    // Location is optional — backend defaults to "TBD" for non-virtual events
    if (startHour >= endHour) errors.push("End time must be after start time");
    if (daySelectionType === "days_of_week" && selectedDays.length === 0) {
      errors.push("Select at least one day");
    }
    if (daySelectionType === "specific_dates" && specificDates.length === 0) {
      errors.push("Select at least one date");
    }
    if (errors.length > 0) {
      setError(errors.join(" · "));
      return;
    }

    setLoading(true);
    try {
      const payload = {
        name: name.trim(),
        startHour,
        endHour,
        days: daySelectionType === "days_of_week" ? selectedDays : [0, 1, 2, 3, 4, 5, 6],
        mode,
        location: location.trim(),
        participantVerification,
        participantViewPermission,
        daySelectionType,
        ...(daySelectionType === "specific_dates"
          ? { specificDates: [...specificDates].sort() }
          : {}),
      };
      if (!user) payload.password = password;
      const { event, password: pw } = await createEvent(payload);
      if (pw) {
        router.replace(`/event?code=${event.code}&manage=${encodeURIComponent(pw)}`);
      } else {
        router.replace(`/event?code=${event.code}`);
      }
    } catch (err) {
      setError(err.message || "Failed to create event");
    } finally {
      setLoading(false);
    }
  };

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
      <div
        className="md-card"
        style={{
          maxWidth: "640px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <h1 style={{ color: "var(--md-sys-color-primary)", margin: 0, fontSize: "1.8rem" }}>
            Relevis
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

        {/* Organizer password (only for anonymous users) */}
        {!user && (
          <md-outlined-text-field
            label="Organizer Password"
            type="password"
            value={password}
            onInput={(e) => setPassword(e.target.value)}
            maxLength="200"
            style={{ width: "100%" }}
          ></md-outlined-text-field>
        )}

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
        <div className="time-row" style={{ display: "flex", gap: "16px" }}>
          <div style={{ flex: 1 }}>
            <LabelRow>Start Time</LabelRow>
            <md-outlined-select
              value={String(startHour)}
              onInput={(e) => setStartHour(Number(e.target.value))}
              style={{ width: "100%" }}
            >
              {hours.map((h) => (
                <md-select-option key={h.value} value={String(h.value)}>
                  <div slot="headline">{h.label}</div>
                </md-select-option>
              ))}
            </md-outlined-select>
          </div>
          <div style={{ flex: 1 }}>
            <LabelRow>End Time</LabelRow>
            <md-outlined-select
              value={String(endHour)}
              onInput={(e) => setEndHour(Number(e.target.value))}
              style={{ width: "100%" }}
            >
              {hours.map((h) => (
                <md-select-option key={h.value} value={String(h.value)}>
                  <div slot="headline">{h.label}</div>
                </md-select-option>
              ))}
            </md-outlined-select>
          </div>
        </div>

        {/* Participant verification */}
        <div>
          <LabelRow>Participant Verification</LabelRow>
          <md-outlined-select
            value={participantVerification}
            onInput={(e) => setParticipantVerification(e.target.value)}
            style={{ width: "100%" }}
          >
            <md-select-option value="none">
              <div slot="headline">None (enter name only)</div>
            </md-select-option>
            <md-select-option value="login">
              <div slot="headline">Require login</div>
            </md-select-option>
            <md-select-option value="email_link">
              <div slot="headline">Email link (coming soon)</div>
            </md-select-option>
            <md-select-option value="phone">
              <div slot="headline">Phone (coming soon)</div>
            </md-select-option>
          </md-outlined-select>
        </div>

        {/* Participant view permission */}
        <div>
          <LabelRow>Participant View</LabelRow>
          <md-outlined-select
            value={participantViewPermission}
            onInput={(e) => setParticipantViewPermission(e.target.value)}
            style={{ width: "100%" }}
          >
            <md-select-option value="own_only">
              <div slot="headline">Own schedule only</div>
            </md-select-option>
            <md-select-option value="all">
              <div slot="headline">All individual schedules</div>
            </md-select-option>
          </md-outlined-select>
        </div>

        {error && (
          <p style={{ color: "var(--md-sys-color-error)", margin: 0, fontSize: "0.9rem" }}>
            {error}
          </p>
        )}

        <AppButton
          onClick={handleSubmit}
          disabled={loading}
          fullWidth={true}
          icon={loading ? <MdHourglassEmpty /> : <MdAdd />}
        >
          {loading ? "Creating..." : "Create Event"}
        </AppButton>
      </div>
    </div>
  );
}

export default CreateEvent;
