"use client";

import { DAY_LABELS } from "@/lib/constants";
import { formatMode, formatTime } from "@/lib/format";

function InfoCard({ label, value }) {
  return (
    <div className="event-info-item">
      <dt className="event-info-label">{label}</dt>
      <dd className="event-info-value">{value ?? "Not set"}</dd>
    </div>
  );
}

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
  const finalTimeOptions = event?.timezone
    ? { timeZone: event.timezone }
    : undefined;

  return (
    <dl
      className={`event-details-grid event-details-grid--${variant}`}
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
            ? new Date(event.responseDeadline).toLocaleString()
            : "No deadline"
        }
      />
      {finalMeeting && (
        <>
          <InfoCard
            label="Final Start"
            value={new Date(finalMeeting.startsAt).toLocaleString(
              [],
              finalTimeOptions,
            )}
          />
          <InfoCard
            label="Final End"
            value={new Date(finalMeeting.endsAt).toLocaleString(
              [],
              finalTimeOptions,
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
