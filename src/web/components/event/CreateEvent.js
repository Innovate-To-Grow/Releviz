"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { useAuth } from "@/components/auth/AuthContext";
import { createEvent, fetchEvent, updateEvent } from "@/lib/api/events";
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

const ADVANCED_ERROR_FIELDS = new Set(["reminderHours"]);

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
    <button type="button" aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}

function LabelRow({ children }) {
  return <span>{children}</span>;
}

function FieldError({ id, message }) {
  if (!message) return null;

  return (
    <p id={id} role="alert">
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

    field.querySelector("input, select, button")?.focus();
  }, 0);
}

function CreateEvent({
  operation = "create",
  presentation = "page",
  initialEvent = null,
  onSaved,
  onCancel,
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading, getToken } = useAuth();
  const editing = operation === "edit";
  const inline = presentation === "inline";
  const SectionHeading = inline ? "h5" : "h2";
  const AdvancedHeading = inline ? "h6" : "h3";
  const eventCode = inline
    ? initialEvent?.code || ""
    : searchParams.get("code") || "";
  const inlineInitialEvent = inline ? initialEvent : null;
  const [name, setName] = useState(inlineInitialEvent?.name || "");
  const [mode, setMode] = useState(inlineInitialEvent?.mode || "inperson");
  const [location, setLocation] = useState(
    inlineInitialEvent?.location === "TBD"
      ? ""
      : inlineInitialEvent?.location || "",
  );
  const [startTime, setStartTime] = useState(
    inlineInitialEvent?.startTime || "09:00",
  );
  const [endTime, setEndTime] = useState(
    inlineInitialEvent?.endTime || "17:00",
  );
  const [slotMinutes, setSlotMinutes] = useState(
    inlineInitialEvent?.slotMinutes || 30,
  );
  const [meetingDurationMinutes, setMeetingDurationMinutes] = useState(
    inlineInitialEvent?.meetingDurationMinutes ||
      inlineInitialEvent?.slotMinutes ||
      30,
  );
  const [selectedDays, setSelectedDays] = useState(
    inlineInitialEvent?.days || [1, 2, 3, 4, 5],
  );
  const [daySelectionType, setDaySelectionType] = useState(
    inlineInitialEvent?.daySelectionType || "days_of_week",
  );
  const [specificDates, setSpecificDates] = useState(
    inlineInitialEvent?.specificDates || [],
  );
  const [dateInput, setDateInput] = useState("");
  const [participantViewPermission, setParticipantViewPermission] = useState(
    inlineInitialEvent?.participantViewPermission || "own_only",
  );
  const [accessMode, setAccessMode] = useState(
    inlineInitialEvent?.accessMode || "invite_only",
  );
  const [eventTimezone, setEventTimezone] = useState(
    () =>
      inlineInitialEvent?.timezone || (editing ? "UTC" : getBrowserTimezone()),
  );
  const [responseDeadline, setResponseDeadline] = useState(() =>
    inlineInitialEvent?.responseDeadline
      ? formatIsoForDateTimeLocal(
          inlineInitialEvent.responseDeadline,
          inlineInitialEvent.timezone || "UTC",
        )
      : "",
  );
  const [remindersEnabled, setRemindersEnabled] = useState(
    inlineInitialEvent?.remindersEnabled !== false,
  );
  const [reminderHoursBefore, setReminderHoursBefore] = useState(
    inlineInitialEvent?.reminderHoursBefore ?? 24,
  );
  const [error, setError] = useState(
    inline && !initialEvent ? "No event was provided for editing." : "",
  );
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadingEvent, setLoadingEvent] = useState(editing && !inline);
  const [eventVersion, setEventVersion] = useState(
    inlineInitialEvent?.version ?? null,
  );
  const [resetRequired, setResetRequired] = useState(false);
  const [resetParticipantCount, setResetParticipantCount] = useState(0);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [conflictEvent, setConflictEvent] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(editing && !inline);
  const nameFieldRef = useRef(null);
  const timezoneOptions = useMemo(
    () => getTimezoneOptions(eventTimezone),
    [eventTimezone],
  );

  const hydrateFromEvent = useCallback((event) => {
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
    setParticipantViewPermission(event.participantViewPermission || "own_only");
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
  }, []);

  useEffect(() => {
    if (!authLoading && !user) {
      const next = editing
        ? `/edit?code=${encodeURIComponent(eventCode)}`
        : "/create";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [authLoading, editing, eventCode, user, router]);

  useEffect(() => {
    if (!editing || authLoading || !user) return;
    if (inline) return;
    if (!eventCode) {
      let active = true;
      Promise.resolve().then(() => {
        if (!active) return;
        setError("No event code was provided for editing.");
        setLoadingEvent(false);
      });
      return () => {
        active = false;
      };
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
        hydrateFromEvent(event);
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
  }, [
    editing,
    authLoading,
    eventCode,
    user,
    getToken,
    hydrateFromEvent,
    initialEvent,
    inline,
  ]);

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
        ...(!editing ? { status: "active" } : {}),
        ...(daySelectionType === "specific_dates"
          ? { specificDates: [...specificDates].sort() }
          : {}),
      };
      const token = await getToken();
      const result = editing
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

      if (inline) {
        await onSaved?.(result);
      } else {
        router.replace(`/event?code=${result.event.code}`);
      }
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

  const reloadLatestEvent = () => {
    if (!inline || !conflictEvent) {
      reloadPage();
      return;
    }

    hydrateFromEvent(conflictEvent);
    setConflictEvent(null);
    setResetRequired(false);
    setResetParticipantCount(0);
    setResetConfirmed(false);
    setError("");
  };

  if (authLoading || !user || loadingEvent) {
    if (inline) {
      return (
        <div aria-busy="true">
          <p role="status">Loading event...</p>
        </div>
      );
    }
    return <p>{editing ? "Loading event..." : "Loading..."}</p>;
  }

  if (
    inline &&
    initialEvent?.organizerUserId &&
    initialEvent.organizerUserId !== user.id
  ) {
    return (
      <div>
        <p role="alert">Only the organizer can edit this event.</p>
      </div>
    );
  }

  if (editing && eventVersion === null) {
    if (inline) {
      return (
        <div>
          <p role="alert">{error || "This event could not be loaded."}</p>
        </div>
      );
    }
    return (
      <div>
        <div>
          <h1>Unable to edit event</h1>
          <p role="alert">{error || "This event could not be loaded."}</p>
          <Link href="/dashboard">Return to dashboard</Link>
        </div>
      </div>
    );
  }

  const form = (
    <form onSubmit={handleSubmit} noValidate>
      {!inline && (
        <header>
          <span>Event setup</span>
          <h1>{editing ? "Edit event" : "Create event"}</h1>
          <p>
            {editing
              ? "Review the schedule and response rules before saving your changes."
              : "Set the schedule and response rules, then share one link with everyone."}
          </p>
        </header>
      )}

      <section aria-labelledby="schedule-fields-heading">
        <div>
          <span>01</span>
          <div>
            <SectionHeading id="schedule-fields-heading">
              Schedule
            </SectionHeading>
            <p>
              Name the event, then choose the days and time range people can
              respond to.
            </p>
          </div>
        </div>

        <div>
          <div data-error-field="eventName">
            <label>
              Event Name
              <input
                ref={nameFieldRef}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clearFieldError("eventName");
                }}
                maxLength={200}
                aria-invalid={fieldErrors.eventName ? "true" : undefined}
                aria-describedby={
                  fieldErrors.eventName ? "event-name-error" : undefined
                }
              />
            </label>
            <FieldError id="event-name-error" message={fieldErrors.eventName} />
          </div>

          <div data-error-field="daySelection">
            <LabelRow>Day Selection</LabelRow>
            <div
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
              <div>
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
              <div>
                <div>
                  <input
                    aria-label="Specific event date"
                    type="date"
                    value={dateInput}
                    onChange={(e) => setDateInput(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (dateInput && !specificDates.includes(dateInput)) {
                        setSpecificDates((prev) => [...prev, dateInput].sort());
                        setDateInput("");
                        clearFieldError("daySelection");
                      }
                    }}
                  >
                    Add date
                  </button>
                </div>
                {specificDates.length > 0 && (
                  <div>
                    {specificDates.map((d) => (
                      <span key={d}>
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

          <div data-error-field="timeRange">
            <div>
              <label>
                <LabelRow>Start Time</LabelRow>
                <input
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
            <FieldError id="time-range-error" message={fieldErrors.timeRange} />
            <p>
              An end time earlier than the start time creates an overnight
              window.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="meeting-access-heading">
        <div>
          <span>02</span>
          <div>
            <SectionHeading id="meeting-access-heading">
              Meeting &amp; access
            </SectionHeading>
            <p>
              Choose how the group meets, the event timezone and length, and who
              can join.
            </p>
          </div>
        </div>

        <div>
          <div>
            <LabelRow>Meeting Type</LabelRow>
            <div>
              {MODES.map((meetingMode) => (
                <ToggleChip
                  key={meetingMode.value}
                  label={meetingMode.label}
                  active={mode === meetingMode.value}
                  onClick={() => setMode(meetingMode.value)}
                />
              ))}
            </div>
          </div>

          {mode !== "virtual" && (
            <label>
              Location / Address
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="TBD"
              />
            </label>
          )}

          <div>
            <div data-error-field="eventTimezone">
              <LabelRow>Event Timezone</LabelRow>
              <select
                aria-label="Event timezone"
                value={eventTimezone}
                aria-invalid={fieldErrors.eventTimezone ? "true" : undefined}
                aria-describedby={
                  fieldErrors.eventTimezone ? "event-timezone-error" : undefined
                }
                onChange={(event) => {
                  setEventTimezone(event.target.value);
                  clearFieldError("eventTimezone");
                }}
              >
                {timezoneOptions.map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
              <FieldError
                id="event-timezone-error"
                message={fieldErrors.eventTimezone}
              />
            </div>

            <div data-error-field="meetingDuration">
              <LabelRow>Meeting Duration</LabelRow>
              <input
                aria-label="Meeting Duration"
                type="number"
                min="15"
                max="480"
                step="15"
                value={meetingDurationMinutes}
                aria-invalid={fieldErrors.meetingDuration ? "true" : undefined}
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
          <p>
            Times are shown in this timezone. Meeting duration determines how
            much continuous availability a recommendation needs.
          </p>

          <div>
            <LabelRow>Event Access</LabelRow>
            <select
              aria-label="Event Access"
              value={accessMode}
              onChange={(event) => setAccessMode(event.target.value)}
            >
              <option value="invite_only">Invite only</option>
              <option value="open_link">Anyone with the event code</option>
            </select>
          </div>
          <p>
            Invite-only events restrict access to roster members and the
            organizer.
          </p>
        </div>
      </section>

      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <div>
            <span>03</span>
            <div>
              <SectionHeading>Advanced options</SectionHeading>
              <p>
                Fine-tune slot granularity, participant visibility, deadlines,
                and reminders.
              </p>
            </div>
          </div>
          Show
        </summary>

        <div>
          <section aria-labelledby="advanced-settings-heading">
            <div>
              <AdvancedHeading id="advanced-settings-heading">
                Fine tuning
              </AdvancedHeading>
              <p>
                Adjust availability granularity, schedule visibility, and
                reminder timing when the defaults are not enough.
              </p>
            </div>
            <div>
              <div>
                <div>
                  <LabelRow>Slot Duration</LabelRow>
                  <select
                    aria-label="Slot Duration"
                    value={String(slotMinutes)}
                    onChange={(event) =>
                      setSlotMinutes(Number(event.target.value))
                    }
                  >
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                  </select>
                </div>
                <div>
                  <LabelRow>Participant View</LabelRow>
                  <select
                    aria-label="Participant View"
                    value={participantViewPermission}
                    onChange={(event) =>
                      setParticipantViewPermission(event.target.value)
                    }
                  >
                    <option value="own_only">Own schedule only</option>
                    <option value="all_after_submit">
                      Submitted schedules after I submit
                    </option>
                    <option value="realtime">
                      Submitted schedules in real time
                    </option>
                  </select>
                </div>
              </div>
              <p>
                Slot duration controls the availability grid. Participant View
                controls when people can see submitted schedules.
              </p>

              <div>
                <label>
                  <LabelRow>Response Deadline</LabelRow>
                  <input
                    aria-label="Response Deadline"
                    type="datetime-local"
                    value={responseDeadline}
                    onChange={(event) =>
                      setResponseDeadline(event.target.value)
                    }
                  />
                </label>
                <div data-error-field="reminderHours">
                  <LabelRow>Reminder Hours Before Deadline</LabelRow>
                  <input
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
              <label>
                <input
                  type="checkbox"
                  checked={remindersEnabled}
                  onChange={(event) =>
                    setRemindersEnabled(event.target.checked)
                  }
                />
                Send reminder emails before the deadline
              </label>
            </div>
          </section>
        </div>
      </details>

      <div>
        {error && <p role="alert">{error}</p>}

        {conflictEvent && (
          <div>
            <p>
              The latest saved version is{" "}
              <strong>{conflictEvent.version}</strong>. Reload before deciding
              which edits to keep.
            </p>
            <AppButton onClick={reloadLatestEvent}>
              Reload latest event
            </AppButton>
          </div>
        )}

        {resetRequired && (
          <div role="alert">
            <strong>Schedule changes require a response reset</strong>
            <p>
              Saving will clear draft and submitted availability for{" "}
              {resetParticipantCount}{" "}
              {resetParticipantCount === 1 ? "participant" : "participants"}.
              Invitations and participant membership will remain.
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
      </div>

      <footer>
        {editing && inline ? (
          <AppButton onClick={() => onCancel?.()} disabled={loading}>
            Cancel
          </AppButton>
        ) : editing ? (
          <Link href={`/event?code=${encodeURIComponent(eventCode)}`}>
            Cancel and return to event
          </Link>
        ) : null}
        <AppButton
          type="submit"
          disabled={loading || (resetRequired && !resetConfirmed)}
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
  );

  if (inline) return form;

  return (
    <>
      <AppHeader
        pageTitle={editing ? "Edit event" : "Create event"}
        contextLabel={editing ? "Organizer" : undefined}
      />
      <main>{form}</main>
    </>
  );
}

export default CreateEvent;
