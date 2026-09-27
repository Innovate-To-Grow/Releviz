"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import PageHeader from "@/components/ui/PageHeader";
import {
  AddIcon,
  ChevronDownIcon,
  RefreshIcon,
  SaveIcon,
} from "@/components/ui/icons";
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
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`btn btn-sm chip-toggle ${active ? "btn-primary" : "btn-outline-secondary"}`}
    >
      {label}
    </button>
  );
}

function LabelRow({ children }) {
  return <span className="form-label d-block">{children}</span>;
}

function FieldError({ id, message }) {
  if (!message) return null;

  return (
    <div
      id={id}
      className="invalid-feedback d-block create-event-field-error"
      role="alert"
    >
      {message}
    </div>
  );
}

function controlClass(base, invalid) {
  return invalid ? `${base} is-invalid` : base;
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
  const [accessMode, setAccessMode] = useState(
    inlineInitialEvent?.accessMode || "invite_only",
  );
  const [startingAvailability, setStartingAvailability] = useState(
    inlineInitialEvent?.startingAvailability || "available",
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
    setAccessMode(event.accessMode || "invite_only");
    setStartingAvailability(event.startingAvailability || "available");
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
        accessMode,
        startingAvailability,
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
        <LoadingState
          label="Loading event..."
          className="create-event-inline-status"
        />
      );
    }
    return (
      <LoadingState page label={editing ? "Loading event..." : "Loading..."} />
    );
  }

  if (
    inline &&
    initialEvent?.organizerUserId &&
    initialEvent.organizerUserId !== user.id
  ) {
    return (
      <div className="create-event-inline-status">
        <Alert variant="danger">Only the organizer can edit this event.</Alert>
      </div>
    );
  }

  if (editing && eventVersion === null) {
    if (inline) {
      return (
        <div className="create-event-inline-status">
          <Alert variant="danger">
            {error || "This event could not be loaded."}
          </Alert>
        </div>
      );
    }
    return (
      <>
        <AppHeader pageTitle="Edit event" contextLabel="Organizer" />
        <main className="page-shell page-shell--narrow create-event-shell">
          <div className="card">
            <div className="card-body d-flex flex-column gap-3">
              <h1 className="h4 mb-0">Unable to edit event</h1>
              <Alert variant="danger">
                {error || "This event could not be loaded."}
              </Alert>
              <div>
                <Link
                  href="/dashboard"
                  className="btn btn-outline-secondary app-btn"
                >
                  <span className="app-btn-label">Return to dashboard</span>
                </Link>
              </div>
            </div>
          </div>
        </main>
      </>
    );
  }

  const hasFeedback = Boolean(error || conflictEvent || resetRequired);
  // The inline editor sits inside the organizer workspace column, which is
  // far narrower than a page; there the copy stacks above the fields instead
  // of using the two-column `.form-section` grid.
  const sectionClassName = inline
    ? "create-event-section d-flex flex-column gap-3 mb-4"
    : "form-section create-event-section";
  const advancedSectionClassName = inline
    ? "create-event-advanced-section d-flex flex-column gap-3"
    : "form-section create-event-advanced-section pb-0";

  const sections = (
    <>
      <section
        className={sectionClassName}
        aria-labelledby="schedule-fields-heading"
      >
        <div className="form-section__copy">
          <span className="section-index" aria-hidden="true">
            01
          </span>
          <div className="min-w-0">
            <SectionHeading id="schedule-fields-heading" className="h5">
              Schedule
            </SectionHeading>
            <p>
              Name the event, then choose the days and time range people can
              respond to.
            </p>
          </div>
        </div>

        <div className="form-section__fields">
          <FormField
            id="event-name"
            label="Event Name"
            required
            data-error-field="eventName"
          >
            {(fieldProps) => (
              <>
                <input
                  {...fieldProps}
                  type="text"
                  className={controlClass(
                    "form-control",
                    fieldErrors.eventName,
                  )}
                  value={name}
                  maxLength={200}
                  required
                  autoComplete="off"
                  onChange={(event) => {
                    setName(event.target.value);
                    clearFieldError("eventName");
                  }}
                  aria-invalid={fieldErrors.eventName ? "true" : undefined}
                  aria-describedby={
                    fieldErrors.eventName ? "event-name-error" : undefined
                  }
                />
                <FieldError
                  id="event-name-error"
                  message={fieldErrors.eventName}
                />
              </>
            )}
          </FormField>

          <div data-error-field="daySelection">
            <LabelRow>Day Selection</LabelRow>
            <div
              className="chip-group mb-2"
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
              <div
                className="chip-group"
                role="group"
                aria-label="Days of the week"
              >
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
              <div className="d-flex flex-column gap-2">
                <div className="d-flex flex-wrap align-items-center gap-2">
                  <input
                    className="form-control w-auto"
                    aria-label="Specific event date"
                    type="date"
                    value={dateInput}
                    onChange={(e) => setDateInput(e.target.value)}
                  />
                  <AppButton
                    variant="outlined"
                    icon={<AddIcon />}
                    onClick={() => {
                      if (dateInput && !specificDates.includes(dateInput)) {
                        setSpecificDates((prev) => [...prev, dateInput].sort());
                        setDateInput("");
                        clearFieldError("daySelection");
                      }
                    }}
                  >
                    Add date
                  </AppButton>
                </div>
                {specificDates.length > 0 && (
                  <ul
                    className="list-unstyled d-flex flex-wrap gap-2 mb-0"
                    aria-label="Selected dates"
                  >
                    {specificDates.map((d) => (
                      <li key={d}>
                        <span className="badge rounded-pill bg-body-secondary text-body border fw-normal fs-6 d-inline-flex align-items-center gap-2 py-1 ps-3 pe-2">
                          {d}
                          <button
                            type="button"
                            className="btn-close"
                            aria-label={`Remove ${d}`}
                            onClick={() =>
                              setSpecificDates((prev) =>
                                prev.filter((x) => x !== d),
                              )
                            }
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <FieldError
              id="day-selection-error"
              message={fieldErrors.daySelection}
            />
          </div>

          <div data-error-field="timeRange">
            <div className="form-row-2">
              {/* Render-function children keep the explicit aria-invalid /
                  aria-describedby below; FormField's element-child merge
                  would overwrite them with its own (empty) values. */}
              <FormField id="event-start-time" label="Start Time">
                {(fieldProps) => (
                  <input
                    {...fieldProps}
                    className={controlClass(
                      "form-control",
                      fieldErrors.timeRange,
                    )}
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
                )}
              </FormField>
              <FormField id="event-end-time" label="End Time">
                {(fieldProps) => (
                  <input
                    {...fieldProps}
                    className={controlClass(
                      "form-control",
                      fieldErrors.timeRange,
                    )}
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
                )}
              </FormField>
            </div>
            <FieldError id="time-range-error" message={fieldErrors.timeRange} />
            <div className="form-text">
              An end time earlier than the start time creates an overnight
              window.
            </div>
          </div>
        </div>
      </section>

      <section
        className={sectionClassName}
        aria-labelledby="meeting-access-heading"
      >
        <div className="form-section__copy">
          <span className="section-index" aria-hidden="true">
            02
          </span>
          <div className="min-w-0">
            <SectionHeading id="meeting-access-heading" className="h5">
              Meeting &amp; access
            </SectionHeading>
            <p>
              Choose how the group meets, the event timezone and length, and who
              can join.
            </p>
          </div>
        </div>

        <div className="form-section__fields">
          <div>
            <LabelRow>Meeting Type</LabelRow>
            <div className="chip-group" role="group" aria-label="Meeting type">
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
            <FormField id="event-location" label="Location / Address">
              <input
                type="text"
                className="form-control"
                value={location}
                placeholder="TBD"
                autoComplete="off"
                onChange={(event) => setLocation(event.target.value)}
              />
            </FormField>
          )}

          <div className="form-row-2">
            <FormField
              id="event-timezone"
              label="Event Timezone"
              data-error-field="eventTimezone"
            >
              {(fieldProps) => (
                <>
                  <select
                    {...fieldProps}
                    className={controlClass(
                      "form-select",
                      fieldErrors.eventTimezone,
                    )}
                    aria-label="Event timezone"
                    value={eventTimezone}
                    aria-invalid={
                      fieldErrors.eventTimezone ? "true" : undefined
                    }
                    aria-describedby={
                      fieldErrors.eventTimezone
                        ? "event-timezone-error"
                        : undefined
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
                </>
              )}
            </FormField>

            <FormField
              id="meeting-duration"
              label="Meeting Duration"
              data-error-field="meetingDuration"
            >
              {(fieldProps) => (
                <>
                  <input
                    {...fieldProps}
                    className={controlClass(
                      "form-control",
                      fieldErrors.meetingDuration,
                    )}
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
                </>
              )}
            </FormField>
          </div>
          <p className="form-text mb-0">
            Times are shown in this timezone. Meeting duration determines how
            much continuous availability a recommendation needs.
          </p>

          <FormField
            id="event-access"
            label="Event Access"
            help="Invite-only events restrict access to participants and the organizer."
          >
            <select
              className="form-select"
              aria-label="Event Access"
              value={accessMode}
              onChange={(event) => setAccessMode(event.target.value)}
            >
              <option value="invite_only">Invite only</option>
              <option value="open_link">Anyone with the event code</option>
            </select>
          </FormField>

          <FormField
            id="starting-availability"
            label="Participants start as"
            help={
              editing
                ? "Changing this updates people who have not started their schedule yet."
                : "Participants paint over the times to change. Starting Available means they mark the times that do not work."
            }
          >
            <select
              className="form-select"
              aria-label="Participants start as"
              value={startingAvailability}
              onChange={(event) => setStartingAvailability(event.target.value)}
            >
              <option value="available">
                Available (they mark the times that do not work)
              </option>
              <option value="busy">Busy (they mark the times that work)</option>
            </select>
          </FormField>
        </div>
      </section>

      <details
        className="disclosure create-event-disclosure"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <div className="disclosure__summary-copy d-flex align-items-start gap-3">
            <span className="section-index" aria-hidden="true">
              03
            </span>
            <div className="min-w-0">
              <SectionHeading className="h5 mb-1">
                Advanced options
              </SectionHeading>
              <p className="mb-0">
                Fine-tune slot granularity, participant visibility, deadlines,
                and reminders.
              </p>
            </div>
          </div>
          <span className="disclosure__chevron" aria-hidden="true">
            <ChevronDownIcon />
          </span>
        </summary>

        <div className="disclosure__content">
          <section
            className={advancedSectionClassName}
            aria-labelledby="advanced-settings-heading"
          >
            <div className="form-section__copy">
              <div className="min-w-0">
                <AdvancedHeading id="advanced-settings-heading" className="h6">
                  Fine tuning
                </AdvancedHeading>
                <p>
                  Adjust availability granularity, schedule visibility, and
                  reminder timing when the defaults are not enough.
                </p>
              </div>
            </div>
            <div className="form-section__fields">
              <div className="form-row-2">
                <FormField id="slot-minutes" label="Slot Duration">
                  <select
                    className="form-select"
                    aria-label="Slot Duration"
                    value={String(slotMinutes)}
                    onChange={(event) =>
                      setSlotMinutes(Number(event.target.value))
                    }
                  >
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                  </select>
                </FormField>
              </div>
              <p className="form-text mb-0">
                Slot duration controls the availability grid. Participants only
                ever see their own calendar.
              </p>

              <div className="form-row-2">
                <FormField id="response-deadline" label="Response Deadline">
                  <input
                    className="form-control"
                    aria-label="Response Deadline"
                    type="datetime-local"
                    value={responseDeadline}
                    onChange={(event) =>
                      setResponseDeadline(event.target.value)
                    }
                  />
                </FormField>
                <FormField
                  id="reminder-hours"
                  label="Reminder Hours Before Deadline"
                  data-error-field="reminderHours"
                >
                  {(fieldProps) => (
                    <>
                      <input
                        {...fieldProps}
                        className={controlClass(
                          "form-control",
                          fieldErrors.reminderHours,
                        )}
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
                    </>
                  )}
                </FormField>
              </div>
              <div className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="reminders-enabled"
                  checked={remindersEnabled}
                  onChange={(event) =>
                    setRemindersEnabled(event.target.checked)
                  }
                />
                <label className="form-check-label" htmlFor="reminders-enabled">
                  Send reminder emails before the deadline
                </label>
              </div>
            </div>
          </section>
        </div>
      </details>

      <div
        className={`create-event-feedback d-flex flex-column gap-3${hasFeedback ? " mt-4" : ""}`}
      >
        {error && (
          <Alert variant="danger" className="create-event-error">
            {error}
          </Alert>
        )}

        {conflictEvent && (
          <Alert
            variant="warning"
            className="event-form-warning"
            actions={
              <AppButton
                variant="outlined"
                icon={<RefreshIcon />}
                onClick={reloadLatestEvent}
              >
                Reload latest event
              </AppButton>
            }
          >
            <p className="mb-0">
              The latest saved version is{" "}
              <strong>{conflictEvent.version}</strong>. Reload before deciding
              which edits to keep.
            </p>
          </Alert>
        )}

        {resetRequired && (
          <Alert
            variant="warning"
            role="alert"
            className="event-form-warning"
            title="Schedule changes require a response reset"
          >
            <p>
              Saving will clear draft and submitted availability for{" "}
              {resetParticipantCount}{" "}
              {resetParticipantCount === 1 ? "participant" : "participants"}.
              Invitations and participant membership will remain.
            </p>
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="reset-confirmed"
                checked={resetConfirmed}
                onChange={(event) => setResetConfirmed(event.target.checked)}
              />
              <label className="form-check-label" htmlFor="reset-confirmed">
                I understand that participant availability will be reset.
              </label>
            </div>
          </Alert>
        )}
      </div>

      <footer className="create-event-actions d-flex flex-wrap justify-content-end align-items-center gap-2 mt-4 pt-3 border-top">
        {editing && inline ? (
          <AppButton
            variant="text"
            className="event-form-cancel"
            onClick={() => onCancel?.()}
            disabled={loading}
          >
            Cancel
          </AppButton>
        ) : editing ? (
          <Link
            href={`/event?code=${encodeURIComponent(eventCode)}`}
            className="btn btn-outline-secondary app-btn event-form-cancel"
          >
            <span className="app-btn-label">Cancel and return to event</span>
          </Link>
        ) : null}
        <AppButton
          className="create-event-submit"
          type="submit"
          busy={loading}
          disabled={loading || (resetRequired && !resetConfirmed)}
          icon={editing ? <SaveIcon /> : <AddIcon />}
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
    </>
  );

  const form = (
    <form
      onSubmit={handleSubmit}
      className={`create-event-form${inline ? " create-event-form--inline" : ""}`}
      noValidate
    >
      {!inline && (
        <PageHeader
          eyebrow="Event setup"
          title={editing ? "Edit event" : "Create event"}
          lede={
            editing
              ? "Review the schedule and response rules before saving your changes."
              : "Set the schedule and response rules, then share one link with everyone."
          }
        />
      )}
      {inline ? (
        sections
      ) : (
        <div className="card">
          <div className="card-body">{sections}</div>
        </div>
      )}
    </form>
  );

  if (inline) return form;

  return (
    <>
      <AppHeader
        pageTitle={editing ? "Edit event" : "Create event"}
        contextLabel={editing ? "Organizer" : undefined}
      />
      <main className="page-shell create-event-shell">{form}</main>
    </>
  );
}

export default CreateEvent;
