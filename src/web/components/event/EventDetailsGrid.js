"use client";

import { useId, useState } from "react";
import {
  CalendarCheckIcon,
  ChevronDownIcon,
  ClockIcon,
  GroupIcon,
  LockIcon,
} from "@/components/ui/icons";
import { DAY_LABELS } from "@/lib/constants";
import { formatDateTimeInTimezone, formatMode, formatTime } from "@/lib/format";

function InfoCard({ label, value }) {
  return (
    <div className="detail-list__item event-info-item">
      <dt className="event-info-label">{label}</dt>
      <dd className="event-info-value">{value ?? "Not set"}</dd>
    </div>
  );
}

function SummaryItem({ icon: Icon, label, primary, secondary, confirmed }) {
  return (
    <div
      className={`summary-tile event-overview-summary__item${confirmed ? " summary-tile--confirmed event-overview-summary__item--confirmed" : ""}`}
    >
      <dt className="event-overview-summary__label">
        <span className="summary-tile__icon" aria-hidden="true">
          <Icon />
        </span>
        <span>{label}</span>
      </dt>
      <dd className="event-overview-summary__value">
        <strong>{primary || "Not set"}</strong>
        {secondary && <span>{secondary}</span>}
      </dd>
    </div>
  );
}

function DetailItem({ label, value }) {
  return (
    <div className="detail-list__item event-overview-details__item">
      <dt>{label}</dt>
      <dd>{value ?? "Not set"}</dd>
    </div>
  );
}

// `blockedSlots` is the API's `{ [groupKey]: [row, ...] }` map; anything else
// (missing, malformed, non-array groups) counts as no blocked slots.
function blockedSlotCount(blockedSlots) {
  if (!blockedSlots || typeof blockedSlots !== "object") return 0;
  return Object.values(blockedSlots).reduce(
    (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
}

function OrganizerEventDetails({ event, extraCards }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const mode = event?.mode || "inperson";
  const dayText =
    event?.daySelectionType === "specific_dates" &&
    Array.isArray(event?.specificDates)
      ? event.specificDates.join(", ")
      : Array.isArray(event?.days)
        ? event.days
            .map((day) => DAY_LABELS[day])
            .filter(Boolean)
            .join(", ")
        : "";
  const timeWindow = `${formatTime(event?.startTime)} - ${formatTime(
    event?.endTime,
  )}${event?.crossesMidnight ? " (next day)" : ""}`;
  const blockedCount = blockedSlotCount(event?.blockedSlots);
  const scheduleSecondary = `${timeWindow} · ${event?.timezone || "UTC"}${
    blockedCount > 0 ? ` · ${blockedCount} slots blocked` : ""
  }`;
  const responseDeadline = event?.responseDeadline
    ? formatDateTimeInTimezone(event.responseDeadline, event?.timezone, {
        timeZoneName: "short",
      })
    : "No deadline";
  const extraValue = (label, fallback) =>
    extraCards.find((card) => card.label === label)?.value ?? fallback;
  const access = extraValue(
    "Access",
    event?.accessMode === "open_link" ? "Anyone with code" : "Invite only",
  );
  const meetingDuration = extraValue(
    "Meeting duration",
    `${event?.meetingDurationMinutes || event?.slotMinutes || 30} minutes`,
  );
  const resultRevision = extraValue(
    "Result revision",
    event?.resultsRevision ?? 1,
  );
  const status = event?.status
    ? event.status.charAt(0).toUpperCase() + event.status.slice(1)
    : "Unknown";
  const finalMeeting = event?.finalMeeting;
  const finalWindow = finalMeeting
    ? `${formatDateTimeInTimezone(
        finalMeeting.startsAt,
        event?.timezone,
      )} - ${formatDateTimeInTimezone(finalMeeting.endsAt, event?.timezone)}`
    : null;

  return (
    <div className="event-overview" aria-label="Event overview">
      <dl
        className="summary-tiles event-overview-summary"
        aria-label="Key event information"
      >
        <SummaryItem
          icon={ClockIcon}
          label="Schedule"
          primary={dayText || "Days not set"}
          secondary={scheduleSecondary}
        />
        <SummaryItem
          icon={GroupIcon}
          label="Meeting"
          primary={`${formatMode(mode)} · ${meetingDuration}`}
          secondary={event?.location || "Location not set"}
        />
        <SummaryItem
          icon={LockIcon}
          label="Responses"
          primary={access}
          secondary={responseDeadline}
        />
        {finalMeeting && (
          <SummaryItem
            icon={CalendarCheckIcon}
            label="Confirmed meeting"
            primary={finalWindow}
            secondary={`${formatMode(finalMeeting.channel)} · ${finalMeeting.location || "Location not set"}`}
            confirmed
          />
        )}
      </dl>

      <div className="event-overview-disclosure mt-3">
        <button
          type="button"
          className="btn btn-link btn-sm px-0 app-btn event-overview-disclosure__toggle"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span>{detailsOpen ? "Hide details" : "Show all details"}</span>
          <span
            className="app-btn-icon"
            aria-hidden="true"
            style={{
              transform: detailsOpen ? "rotate(180deg)" : undefined,
              transition: "transform 150ms ease",
            }}
          >
            <ChevronDownIcon />
          </span>
        </button>
        {detailsOpen && (
          <dl
            id={detailsId}
            className="detail-list detail-list--compact event-overview-details mt-2 p-3 rounded border bg-body-tertiary"
            aria-label="Additional event details"
          >
            <DetailItem
              label="Availability interval"
              value={`${event?.slotMinutes || 30} minutes`}
            />
            <DetailItem label="Event code" value={event?.code} />
            <DetailItem label="Status" value={status} />
            <DetailItem label="Result revision" value={resultRevision} />
          </dl>
        )}
      </div>
    </div>
  );
}

/**
 * Event facts as a definition list. The `organizer` variant shows summary
 * tiles with a collapsible detail list; every other variant renders a compact
 * responsive grid of label/value pairs.
 */
function EventDetailsGrid({ event, extraCards = [], variant = "default" }) {
  const mode = event?.mode || "inperson";
  const dayText =
    event?.daySelectionType === "specific_dates" &&
    Array.isArray(event?.specificDates)
      ? event.specificDates.join(", ")
      : Array.isArray(event?.days)
        ? event.days
            .map((d) => DAY_LABELS[d])
            .filter(Boolean)
            .join(", ")
        : "";
  const finalMeeting = event?.finalMeeting;
  if (variant === "organizer") {
    return <OrganizerEventDetails event={event} extraCards={extraCards} />;
  }

  return (
    <dl
      className={`detail-list event-details-grid event-details-grid--${variant}`}
      aria-label="Event details"
    >
      {variant !== "organizer" && (
        <InfoCard label="Event" value={event?.name} />
      )}
      <InfoCard label="Meeting type" value={formatMode(mode)} />
      <InfoCard
        label="Availability window"
        value={`${formatTime(event?.startTime)} - ${formatTime(event?.endTime)}${
          event?.crossesMidnight ? " (next day)" : ""
        }`}
      />
      <InfoCard
        label="Availability interval"
        value={`${event?.slotMinutes || 30} minutes`}
      />
      <InfoCard label="Response days" value={dayText || "Not set"} />
      <InfoCard label="Timezone" value={event?.timezone || "UTC"} />
      <InfoCard label="Location" value={event?.location || "N/A"} />
      <InfoCard label="Event code" value={event?.code} />
      <InfoCard
        label="Status"
        value={
          event?.status
            ? event.status.charAt(0).toUpperCase() + event.status.slice(1)
            : "Unknown"
        }
      />
      <InfoCard
        label="Response Deadline"
        value={
          event?.responseDeadline
            ? formatDateTimeInTimezone(
                event.responseDeadline,
                event?.timezone,
                { timeZoneName: "short" },
              )
            : "No deadline"
        }
      />
      {finalMeeting && (
        <>
          <InfoCard
            label="Final Start"
            value={formatDateTimeInTimezone(
              finalMeeting.startsAt,
              event?.timezone,
            )}
          />
          <InfoCard
            label="Final End"
            value={formatDateTimeInTimezone(
              finalMeeting.endsAt,
              event?.timezone,
            )}
          />
          <InfoCard
            label="Final Method"
            value={`${formatMode(finalMeeting.channel)} · ${finalMeeting.location}`}
          />
        </>
      )}
      {extraCards.map((card) => (
        <InfoCard key={card.label} label={card.label} value={card.value} />
      ))}
    </dl>
  );
}

export default EventDetailsGrid;
