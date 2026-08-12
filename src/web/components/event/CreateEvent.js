"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { MdAdd, MdHourglassEmpty, MdRefresh, MdSave } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { useAuth } from "@/components/auth/AuthContext";
import { createEvent, fetchEvent, updateEvent } from "@/lib/api/events";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import { DAY_LABELS } from "@/lib/constants";
import { reloadPage } from "@/lib/navigation";
import { formatIsoForDateTimeLocal, zonedLocalDateTimeToIso } from "@/lib/time";
const MODES = [
  { value: "inperson", label: "In-Person" },
  { value: "virtual", label: "Virtual" },
  { value: "mixed", label: "Mixed" },
];

const ERROR_FIELD_ORDER = [
  "eventName",
  "daySelection",
  "timeRange",
  "eventTimezone",
  "meetingDuration",
  "reminderHours",
];

const ADVANCED_ERROR_FIELDS = new Set([
  "eventTimezone",
  "meetingDuration",
  "reminderHours",
]);

const FALLBACK_TIMEZONES = [
  "UTC",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Amsterdam",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Paris",
  "Pacific/Auckland",
];

function getTimezoneOptions(currentTimezone) {
  let supportedTimezones = FALLBACK_TIMEZONES;

  try {
    if (typeof Intl.supportedValuesOf === "function") {
      supportedTimezones = Intl.supportedValuesOf("timeZone");
    }
  } catch {
    // Older browsers use the curated fallback list above.
  }

  return Array.from(
    new Set(["UTC", currentTimezone, ...supportedTimezones].filter(Boolean)),
  ).sort((left, right) => {
    if (left === "UTC") return -1;
    if (right === "UTC") return 1;
    return left.localeCompare(right);
  });
}

function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function ToggleChip({ label, active, onClick }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`event-toggle-chip${active ? " event-toggle-chip-active" : ""}`}
    >
      {label}
    </button>
  );
}

function LabelRow({ children }) {
  return <span className="event-field-label">{children}</span>;
}

function FieldError({ id, message }) {
  if (!message) return null;

  return (
    <p id={id} className="create-event-field-error" role="alert">
      {message}
    </p>
  );
}

function focusInvalidField(fieldName) {
  window.setTimeout(() => {
    const field = document.querySelector(`[data-error-field="${fieldName}"]`);
    if (!field) return;

    if (typeof field.scrollIntoView === "function") {
      field.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    field
      .querySelector(
        "md-outlined-text-field, md-outlined-select, input, button",
      )
      ?.focus();
  }, 0);
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
  const [meetingDurationMinutes, setMeetingDurationMinutes] = useState(30);
  const [selectedDays, setSelectedDays] = useState([1, 2, 3, 4, 5]);
  const [daySelectionType, setDaySelectionType] = useState("days_of_week");
  const [specificDates, setSpecificDates] = useState([]);
  const [dateInput, setDateInput] = useState("");
  const [participantViewPermission, setParticipantViewPermission] =
    useState("own_only");
  const [accessMode, setAccessMode] = useState("invite_only");
  const [eventTimezone, setEventTimezone] = useState(() =>
    editing ? "UTC" : getBrowserTimezone(),
  );
  const [responseDeadline, setResponseDeadline] = useState("");
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  const [reminderHoursBefore, setReminderHoursBefore] = useState(24);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadingEvent, setLoadingEvent] = useState(editing);
  const [eventVersion, setEventVersion] = useState(null);
  const [resetRequired, setResetRequired] = useState(false);
  const [resetParticipantCount, setResetParticipantCount] = useState(0);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [conflictEvent, setConflictEvent] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(editing);
  const nameFieldRef = useRef(null);
  const timezoneOptions = useMemo(
    () => getTimezoneOptions(eventTimezone),
    [eventTimezone],
  );

  useEffect(() => {
    if (!authLoading && !user) {
      const next = editing
        ? `/edit?code=${encodeURIComponent(eventCode)}`
        : "/create";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [authLoading, editing, eventCode, user, router]);

  useEffect(() => {
    const field = nameFieldRef.current;
    if (!field) return;
    let input = null;
    let cancelled = false;

    const syncName = (event) => {
      setName(event.currentTarget.value || "");
      setFieldErrors((current) => {
        if (!current.eventName) return current;
        const next = { ...current };
        delete next.eventName;
        return next;
      });
    };

    const bindInput = async () => {
      await field.updateComplete;
      if (cancelled) return;
      input = field.shadowRoot?.querySelector("input") || null;
      input?.addEventListener("input", syncName);
      input?.addEventListener("change", syncName);
    };

    bindInput();
    return () => {
      cancelled = true;
      input?.removeEventListener("input", syncName);
      input?.removeEventListener("change", syncName);
    };
  }, []);

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
        setMeetingDurationMinutes(
          event.meetingDurationMinutes || event.slotMinutes || 30,
        );
        setSelectedDays(event.days || []);
        setDaySelectionType(event.daySelectionType || "days_of_week");
        setSpecificDates(event.specificDates || []);
        setParticipantViewPermission(
          event.participantViewPermission || "own_only",
        );
        setAccessMode(event.accessMode || "invite_only");
        setEventTimezone(event.timezone || "UTC");
        setResponseDeadline(
          event.responseDeadline
            ? formatIsoForDateTimeLocal(
                event.responseDeadline,
                event.timezone || "UTC",
              )
            : "",
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

  const clearFieldError = (fieldName) => {
    setFieldErrors((current) => {
      if (!current[fieldName]) return current;
      const next = { ...current };
      delete next[fieldName];
      return next;
    });
  };

  const toggleDay = (idx) => {
    clearFieldError("daySelection");
    setSelectedDays((prev) =>
      prev.includes(idx)
        ? prev.filter((d) => d !== idx)
        : [...prev, idx].sort(),
    );
  };

  const handleSubmit = async (submitEvent) => {
    submitEvent?.preventDefault();
    setError("");
    setConflictEvent(null);
    const nextFieldErrors = {};
    const addFieldError = (fieldName, message) => {
      if (!nextFieldErrors[fieldName]) nextFieldErrors[fieldName] = message;
    };

    if (!name.trim()) addFieldError("eventName", "Event name is required");
    // Location is optional — backend defaults to "TBD" for non-virtual events
    const toMinutes = (value) => {
      const [hour, minute] = value.split(":").map(Number);
      return hour * 60 + minute;
    };
    let windowMinutes = null;

    if (!startTime || !endTime) {
      addFieldError("timeRange", "Choose both a start time and an end time");
    } else {
      const startMinutes = toMinutes(startTime);
      const endMinutes = toMinutes(endTime);
      windowMinutes =
        endMinutes > startMinutes
          ? endMinutes - startMinutes
          : 24 * 60 - startMinutes + endMinutes;

      if (startMinutes === endMinutes) {
        addFieldError("timeRange", "Start and end times must be different");
      }
      if (startMinutes % slotMinutes || endMinutes % slotMinutes) {
        addFieldError(
          "timeRange",
          `Times must align to ${slotMinutes}-minute slots`,
        );
      }
    }

    if (
      !Number.isFinite(meetingDurationMinutes) ||
      meetingDurationMinutes < 15 ||
      meetingDurationMinutes > 480 ||
      meetingDurationMinutes % slotMinutes !== 0
    ) {
      addFieldError(
        "meetingDuration",
        `Meeting duration must be 15–480 minutes and align to ${slotMinutes}-minute slots`,
      );
    }
    if (
      windowMinutes !== null &&
      Number.isFinite(meetingDurationMinutes) &&
      meetingDurationMinutes > windowMinutes
    ) {
      addFieldError(
        "meetingDuration",
        "Meeting duration must fit within the configured daily time window",
      );
    }
    if (daySelectionType === "days_of_week" && selectedDays.length === 0) {
      addFieldError("daySelection", "Select at least one day");
    }
    if (daySelectionType === "specific_dates" && specificDates.length === 0) {
      addFieldError("daySelection", "Select at least one date");
    }
    if (!eventTimezone.trim()) {
      addFieldError("eventTimezone", "Event timezone is required");
    }
    if (
      !Number.isFinite(reminderHoursBefore) ||
      reminderHoursBefore < 0 ||
      reminderHoursBefore > 720
    ) {
      addFieldError(
        "reminderHours",
        "Reminder timing must be between 0 and 720 hours",
      );
    }

    setFieldErrors(nextFieldErrors);
    const firstInvalidField = ERROR_FIELD_ORDER.find(
      (fieldName) => nextFieldErrors[fieldName],
    );
    if (firstInvalidField) {
      if (ADVANCED_ERROR_FIELDS.has(firstInvalidField)) {
        setAdvancedOpen(true);
      }
      focusInvalidField(firstInvalidField);
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
        accessMode,
        meetingDurationMinutes,
        daySelectionType,
        responseDeadline: responseDeadline
          ? zonedLocalDateTimeToIso(responseDeadline, eventTimezone.trim())
          : null,
        timezone: eventTimezone.trim(),
        remindersEnabled,
        reminderHoursBefore,
        ...(!editing ? { status: "draft" } : {}),
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
            token,
          )
        : await createEvent(payload, token);

      router.replace(`/event?code=${event.code}`);
    } catch (err) {
      if (err.requiresResponseReset) {
        setResetRequired(true);
        setResetParticipantCount(err.participantCount || 0);
      }
      if (err.event) setConflictEvent(err.event);
      setError(
        err.message ||
          (editing ? "Failed to save event" : "Failed to create event"),
      );
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
          <h1
            style={{ color: "var(--md-sys-color-error)", marginBottom: "12px" }}
          >
            Unable to edit event
          </h1>
          <p
            role="alert"
            style={{ color: "var(--md-sys-color-on-surface-variant)" }}
          >
            {error || "This event could not be loaded."}
          </p>
          <Link
            href="/dashboard"
            className="dashboard-action-link"
            style={{ marginTop: "20px" }}
          >
            Return to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <AppHeader
        pageTitle={editing ? "Edit event" : "Create event"}
        contextLabel={editing ? "Organizer" : undefined}
      />
      <main className="create-event-shell">
        <form onSubmit={handleSubmit} className="create-event-form" noValidate>
          <header className="create-event-heading">
            <span className="create-event-eyebrow">Event setup</span>
            <h1>{editing ? "Edit event" : "Create event"}</h1>
            <p>
              {editing
                ? "Review the schedule and response rules before saving your changes."
                : "Set the schedule and response rules, then share one link with everyone."}
            </p>
          </header>

          <section
            className="create-event-section"
            aria-labelledby="schedule-fields-heading"
          >
            <div className="create-event-section-copy">
              <span className="create-event-section-index">01</span>
              <div>
                <h2 id="schedule-fields-heading">Schedule</h2>
                <p>
                  Name the event, then choose the days and time range people can
                  respond to.
                </p>
              </div>
            </div>

            <div className="create-event-section-fields">
              <div
                className="create-event-field-group"
                data-error-field="eventName"
              >
                <md-outlined-text-field
                  ref={nameFieldRef}
                  className="create-event-wide-field"
                  label="Event Name"
                  value={name}
                  onInput={(event) => {
                    setName(event.target.value);
                    clearFieldError("eventName");
                  }}
                  onChange={(event) => {
                    setName(event.currentTarget.value);
                    clearFieldError("eventName");
                  }}
                  maxLength="200"
                  error={Boolean(fieldErrors.eventName)}
                  aria-invalid={fieldErrors.eventName ? "true" : undefined}
                  aria-describedby={
                    fieldErrors.eventName ? "event-name-error" : undefined
                  }
                ></md-outlined-text-field>
                <FieldError
                  id="event-name-error"
                  message={fieldErrors.eventName}
                />
              </div>

              <div
                className="create-event-field-group"
                data-error-field="daySelection"
              >
                <LabelRow>Day Selection</LabelRow>
                <div
                  className="create-event-chip-row create-event-day-modes"
                  role="group"
                  aria-label="Day selection type"
                  aria-describedby={
                    fieldErrors.daySelection ? "day-selection-error" : undefined
                  }
                >
                  <ToggleChip
                    label="Days of Week"
                    active={daySelectionType === "days_of_week"}
                    onClick={() => {
                      setDaySelectionType("days_of_week");
                      clearFieldError("daySelection");
                    }}
                  />
                  <ToggleChip
                    label="Specific Dates"
                    active={daySelectionType === "specific_dates"}
                    onClick={() => {
                      setDaySelectionType("specific_dates");
                      clearFieldError("daySelection");
                    }}
                  />
                </div>
                {daySelectionType === "days_of_week" ? (
                  <div className="create-event-chip-row">
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
                  <div className="create-event-date-picker">
                    <div className="create-event-date-entry">
                      <input
                        className="create-event-control"
                        aria-label="Specific event date"
                        type="date"
                        value={dateInput}
                        onChange={(e) => setDateInput(e.target.value)}
                      />
                      <button
                        className="create-event-add-date"
                        type="button"
                        onClick={() => {
                          if (dateInput && !specificDates.includes(dateInput)) {
                            setSpecificDates((prev) =>
                              [...prev, dateInput].sort(),
                            );
                            setDateInput("");
                            clearFieldError("daySelection");
                          }
                        }}
                      >
                        Add date
                      </button>
                    </div>
                    {specificDates.length > 0 && (
                      <div className="create-event-date-tags">
                        {specificDates.map((d) => (
                          <span className="create-event-date-tag" key={d}>
                            {d}
                            <button
                              type="button"
                              aria-label={`Remove ${d}`}
                              onClick={() =>
                                setSpecificDates((prev) =>
                                  prev.filter((x) => x !== d),
                                )
                              }
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <FieldError
                  id="day-selection-error"
                  message={fieldErrors.daySelection}
                />
              </div>

              <div
                className="create-event-field-group"
                data-error-field="timeRange"
              >
                <div className="create-event-two-column">
                  <label>
                    <LabelRow>Start Time</LabelRow>
                    <input
                      className="create-event-control"
                      aria-label="Start Time"
                      type="time"
                      step={slotMinutes * 60}
                      value={startTime}
                      aria-invalid={fieldErrors.timeRange ? "true" : undefined}
                      aria-describedby={
                        fieldErrors.timeRange ? "time-range-error" : undefined
                      }
                      onChange={(event) => {
                        setStartTime(event.target.value);
                        clearFieldError("timeRange");
                      }}
                    />
                  </label>
                  <label>
                    <LabelRow>End Time</LabelRow>
                    <input
                      className="create-event-control"
                      aria-label="End Time"
                      type="time"
                      step={slotMinutes * 60}
                      value={endTime}
                      aria-invalid={fieldErrors.timeRange ? "true" : undefined}
                      aria-describedby={
                        fieldErrors.timeRange ? "time-range-error" : undefined
                      }
                      onChange={(event) => {
                        setEndTime(event.target.value);
                        clearFieldError("timeRange");
                      }}
                    />
                  </label>
                </div>
                <FieldError
                  id="time-range-error"
                  message={fieldErrors.timeRange}
                />
                <p className="create-event-help">
                  An end time earlier than the start time creates an overnight
                  window.
                </p>
              </div>
            </div>
          </section>

          <details
            className="create-event-disclosure"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="create-event-disclosure-summary">
              <div className="create-event-section-copy">
                <span className="create-event-section-index">02</span>
                <div>
                  <h2>Advanced options</h2>
                  <p>
                    Meeting details, visibility, reminders, timezone, and slot
                    length.
                  </p>
                </div>
              </div>
              <span
                className="create-event-disclosure-toggle"
                aria-hidden="true"
              >
                <span className="create-event-disclosure-label-closed">
                  Show
                </span>
                <span className="create-event-disclosure-label-open">Hide</span>
                <span className="create-event-disclosure-chevron" />
              </span>
            </summary>

            <div className="create-event-disclosure-content">
              <section
                className="create-event-advanced-section"
                aria-labelledby="meeting-details-heading"
              >
                <div className="create-event-advanced-copy">
                  <h3 id="meeting-details-heading">Meeting details</h3>
                  <p>
                    Choose how the group will meet and add a location when
                    needed.
                  </p>
                </div>
                <div className="create-event-advanced-fields">
                  <div className="create-event-field-group">
                    <LabelRow>Meeting Type</LabelRow>
                    <div className="create-event-chip-row">
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

                  {mode !== "virtual" && (
                    <md-outlined-text-field
                      className="create-event-wide-field"
                      label="Location / Address"
                      value={location}
                      onInput={(e) => setLocation(e.target.value)}
                      onChange={(event) =>
                        setLocation(event.currentTarget.value)
                      }
                      placeholder="TBD"
                    ></md-outlined-text-field>
                  )}
                </div>
              </section>

              <section
                className="create-event-advanced-section"
                aria-labelledby="time-settings-heading"
              >
                <div className="create-event-advanced-copy">
                  <h3 id="time-settings-heading">Time settings</h3>
                  <p>
                    Control timezone, availability granularity, and meeting
                    length.
                  </p>
                </div>
                <div className="create-event-advanced-fields">
                  <div
                    className="create-event-field-group"
                    data-error-field="eventTimezone"
                  >
                    <LabelRow>Event Timezone</LabelRow>
                    <md-outlined-select
                      className="create-event-wide-field create-event-select create-event-timezone-select"
                      aria-label="Event timezone"
                      value={eventTimezone}
                      clamp-menu-width
                      typeahead-delay="600"
                      error={Boolean(fieldErrors.eventTimezone)}
                      aria-invalid={
                        fieldErrors.eventTimezone ? "true" : undefined
                      }
                      aria-describedby={
                        fieldErrors.eventTimezone
                          ? "event-timezone-error"
                          : undefined
                      }
                      onInput={(event) => {
                        setEventTimezone(event.target.value);
                        clearFieldError("eventTimezone");
                      }}
                      onChange={(event) => {
                        setEventTimezone(event.target.value);
                        clearFieldError("eventTimezone");
                      }}
                    >
                      {timezoneOptions.map((timezone) => (
                        <md-select-option key={timezone} value={timezone}>
                          <div slot="headline">{timezone}</div>
                        </md-select-option>
                      ))}
                    </md-outlined-select>
                    <FieldError
                      id="event-timezone-error"
                      message={fieldErrors.eventTimezone}
                    />
                    <p className="create-event-help">
                      Choose the IANA timezone used for schedules and reminders.
                      Type while the menu is open to jump to a timezone.
                    </p>
                  </div>

                  <div className="create-event-two-column">
                    <div className="create-event-field-group">
                      <LabelRow>Slot Duration</LabelRow>
                      <md-outlined-select
                        className="create-event-wide-field create-event-select"
                        aria-label="Slot Duration"
                        value={String(slotMinutes)}
                        onInput={(event) =>
                          setSlotMinutes(Number(event.target.value))
                        }
                        onChange={(event) =>
                          setSlotMinutes(Number(event.target.value))
                        }
                      >
                        <md-select-option value="15">
                          <div slot="headline">15 minutes</div>
                        </md-select-option>
                        <md-select-option value="30">
                          <div slot="headline">30 minutes</div>
                        </md-select-option>
                      </md-outlined-select>
                    </div>
                    <div
                      className="create-event-field-group"
                      data-error-field="meetingDuration"
                    >
                      <LabelRow>Meeting Duration</LabelRow>
                      <input
                        className="create-event-control"
                        aria-label="Meeting Duration"
                        type="number"
                        min="15"
                        max="480"
                        step="15"
                        value={meetingDurationMinutes}
                        aria-invalid={
                          fieldErrors.meetingDuration ? "true" : undefined
                        }
                        aria-describedby={
                          fieldErrors.meetingDuration
                            ? "meeting-duration-error"
                            : undefined
                        }
                        onChange={(event) => {
                          setMeetingDurationMinutes(Number(event.target.value));
                          clearFieldError("meetingDuration");
                        }}
                      />
                      <FieldError
                        id="meeting-duration-error"
                        message={fieldErrors.meetingDuration}
                      />
                    </div>
                  </div>
                  <p className="create-event-help">
                    Recommendations cover the full meeting duration. Events may
                    contain up to 1,000 availability slots.
                  </p>
                </div>
              </section>

              <section
                className="create-event-advanced-section"
                aria-labelledby="response-settings-heading"
              >
                <div className="create-event-advanced-copy">
                  <h3 id="response-settings-heading">Response settings</h3>
                  <p>
                    Decide who can join, what participants can see, and when to
                    remind them.
                  </p>
                </div>
                <div className="create-event-advanced-fields">
                  <div className="create-event-two-column">
                    <div className="create-event-field-group">
                      <LabelRow>Event Access</LabelRow>
                      <md-outlined-select
                        className="create-event-wide-field create-event-select"
                        aria-label="Event Access"
                        value={accessMode}
                        onInput={(event) => setAccessMode(event.target.value)}
                        onChange={(event) => setAccessMode(event.target.value)}
                      >
                        <md-select-option value="invite_only">
                          <div slot="headline">Invite only</div>
                        </md-select-option>
                        <md-select-option value="open_link">
                          <div slot="headline">Anyone with the event code</div>
                        </md-select-option>
                      </md-outlined-select>
                    </div>
                    <div className="create-event-field-group">
                      <LabelRow>Participant View</LabelRow>
                      <md-outlined-select
                        className="create-event-wide-field create-event-select"
                        aria-label="Participant View"
                        value={participantViewPermission}
                        onInput={(e) =>
                          setParticipantViewPermission(e.target.value)
                        }
                      >
                        <md-select-option value="own_only">
                          <div slot="headline">Own schedule only</div>
                        </md-select-option>
                        <md-select-option value="all_after_submit">
                          <div slot="headline">
                            Submitted schedules after I submit
                          </div>
                        </md-select-option>
                        <md-select-option value="realtime">
                          <div slot="headline">
                            Submitted schedules in real time
                          </div>
                        </md-select-option>
                      </md-outlined-select>
                    </div>
                  </div>
                  <p className="create-event-help">
                    Invite-only events restrict access to roster members and the
                    organizer.
                  </p>

                  <div className="create-event-two-column">
                    <label>
                      <LabelRow>Response Deadline</LabelRow>
                      <input
                        className="create-event-control"
                        aria-label="Response Deadline"
                        type="datetime-local"
                        value={responseDeadline}
                        onChange={(e) => setResponseDeadline(e.target.value)}
                      />
                    </label>
                    <div
                      className="create-event-field-group"
                      data-error-field="reminderHours"
                    >
                      <LabelRow>Reminder Hours Before Deadline</LabelRow>
                      <input
                        className="create-event-control"
                        aria-label="Reminder Hours Before Deadline"
                        type="number"
                        min="0"
                        max="720"
                        value={reminderHoursBefore}
                        aria-invalid={
                          fieldErrors.reminderHours ? "true" : undefined
                        }
                        aria-describedby={
                          fieldErrors.reminderHours
                            ? "reminder-hours-error"
                            : undefined
                        }
                        onChange={(event) => {
                          setReminderHoursBefore(Number(event.target.value));
                          clearFieldError("reminderHours");
                        }}
                      />
                      <FieldError
                        id="reminder-hours-error"
                        message={fieldErrors.reminderHours}
                      />
                    </div>
                  </div>
                  <label className="create-event-checkbox-row">
                    <input
                      type="checkbox"
                      checked={remindersEnabled}
                      onChange={(e) => setRemindersEnabled(e.target.checked)}
                    />
                    Send reminder emails before the deadline
                  </label>
                </div>
              </section>
            </div>
          </details>

          <div className="create-event-feedback">
            {error && (
              <p className="create-event-error" role="alert">
                {error}
              </p>
            )}

            {conflictEvent && (
              <div className="event-form-warning">
                <p>
                  The latest saved version is{" "}
                  <strong>{conflictEvent.version}</strong>. Reload before
                  deciding which edits to keep.
                </p>
                <AppButton
                  variant="outlined"
                  icon={<MdRefresh />}
                  onClick={reloadPage}
                >
                  Reload latest event
                </AppButton>
              </div>
            )}

            {resetRequired && (
              <div className="event-form-warning" role="alert">
                <strong>Schedule changes require a response reset</strong>
                <p>
                  Saving will clear draft and submitted availability for{" "}
                  {resetParticipantCount}{" "}
                  {resetParticipantCount === 1 ? "participant" : "participants"}
                  . Invitations and participant membership will remain.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={resetConfirmed}
                    onChange={(event) =>
                      setResetConfirmed(event.target.checked)
                    }
                  />
                  I understand that participant availability will be reset.
                </label>
              </div>
            )}
          </div>

          <footer className="create-event-actions">
            {editing && (
              <Link
                href={`/event?code=${encodeURIComponent(eventCode)}`}
                className="event-form-cancel"
              >
                Cancel and return to event
              </Link>
            )}
            <AppButton
              className="create-event-submit"
              type="submit"
              disabled={loading || (resetRequired && !resetConfirmed)}
              icon={
                loading ? (
                  <MdHourglassEmpty />
                ) : editing ? (
                  <MdSave />
                ) : (
                  <MdAdd />
                )
              }
            >
              {loading
                ? editing
                  ? "Saving..."
                  : "Creating..."
                : editing
                  ? "Save changes"
                  : "Create Event"}
            </AppButton>
          </footer>
        </form>
      </main>
    </>
  );
}

export default CreateEvent;
