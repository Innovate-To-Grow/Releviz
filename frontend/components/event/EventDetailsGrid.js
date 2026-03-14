"use client";

import { DAY_LABELS } from "@/lib/constants";
import { formatHour, formatMode } from "@/lib/format";

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
      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--md-sys-color-outline)" }}>{label}</p>
      <p style={{ margin: "4px 0 0 0", fontWeight: 600 }}>{value}</p>
    </div>
  );
}

function EventDetailsGrid({ event, extraCards = [] }) {
  const mode = event?.mode || "inperson";
  const dayText = Array.isArray(event?.days)
    ? event.days
        .map((d) => DAY_LABELS[d])
        .filter(Boolean)
        .join(", ")
    : "";

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
        value={`${formatHour(event?.startHour)} - ${formatHour(event?.endHour)}`}
      />
      <InfoCard label="Days" value={dayText || "Not set"} />
      <InfoCard label="Location" value={event?.location || "N/A"} />
      <InfoCard label="Event Code" value={event?.code} />
      {extraCards.map((card) => (
        <InfoCard key={card.label} label={card.label} value={card.value} />
      ))}
    </div>
  );
}

export default EventDetailsGrid;
