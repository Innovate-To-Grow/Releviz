"use client";

import { DAY_LABELS } from "@/lib/constants";
import { formatMode, formatTime } from "@/lib/format";

function InfoCard({ label, value }) {
  return (
    <div
      style={{
        padding: "12px",
        border: "1px solid var(--md-sys-color-surface-variant)",
        borderRadius: "12px",
        background: "var(--md-sys-color-surface)",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "0.8rem",
          color: "var(--md-sys-color-on-surface-variant)",
        }}
      >
        {label}
      </p>
      <p style={{ margin: "4px 0 0 0", fontWeight: 600 }}>{value}</p>
    </div>
  );
}

function EventDetailsGrid({ event, extraCards = [] }) {
  const mode = event?.mode || "inperson";
  const dayText =
    event?.daySelectionType === "specific_dates" && Array.isArray(event?.specificDates)
      ? event.specificDates.join(", ")
      : Array.isArray(event?.days)
        ? event.days
            .map((d) => DAY_LABELS[d])
            .filter(Boolean)
            .join(", ")
        : "";
  const finalMeeting = event?.finalMeeting;
  const finalTimeOptions = event?.timezone ? { timeZone: event.timezone } : undefined;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "12px",
      }}
    >
      <InfoCard label="Event" value={event?.name} />
      <InfoCard label="Type" value={formatMode(mode)} />
      <InfoCard
        label="Time"
        value={`${formatTime(event?.startTime)} - ${formatTime(event?.endTime)}${
          event?.crossesMidnight ? " (next day)" : ""
        }`}
      />
      <InfoCard label="Slot Duration" value={`${event?.slotMinutes || 30} minutes`} />
      <InfoCard label="Days" value={dayText || "Not set"} />
      <InfoCard label="Timezone" value={event?.timezone || "UTC"} />
      <InfoCard label="Location" value={event?.location || "N/A"} />
      <InfoCard label="Event Code" value={event?.code} />
      <InfoCard
        label="Status"
        value={
          event?.status ? event.status.charAt(0).toUpperCase() + event.status.slice(1) : "Unknown"
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
            value={new Date(finalMeeting.startsAt).toLocaleString([], finalTimeOptions)}
          />
          <InfoCard
            label="Final End"
            value={new Date(finalMeeting.endsAt).toLocaleString([], finalTimeOptions)}
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
    </div>
  );
}

export default EventDetailsGrid;
