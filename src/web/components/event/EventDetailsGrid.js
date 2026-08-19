"use client";

import { useId, useState } from "react";
import { DAY_LABELS } from "@/lib/constants";
import { formatDateTimeInTimezone, formatMode, formatTime } from "@/lib/format";

function InfoCard({ label, value }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? "Not set"}</dd>
    </>
  );
}

function SummaryItem({ label, primary, secondary }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <strong>{primary || "Not set"}</strong>
        {secondary && <span> {secondary}</span>}
      </dd>
    </>
  );
}

function DetailItem({ label, value }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? "Not set"}</dd>
    </>
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
    <section aria-label="Event overview">
      <dl aria-label="Key event information">
        <SummaryItem
          label="Schedule"
          primary={dayText || "Days not set"}
          secondary={`${timeWindow} · ${event?.timezone || "UTC"}`}
        />
        <SummaryItem
          label="Meeting"
          primary={`${formatMode(mode)} · ${meetingDuration}`}
          secondary={event?.location || "Location not set"}
        />
        <SummaryItem
          label="Responses"
          primary={access}
          secondary={responseDeadline}
        />
        {finalMeeting && (
          <SummaryItem
            label="Confirmed meeting"
            primary={finalWindow}
            secondary={`${formatMode(finalMeeting.channel)} · ${finalMeeting.location || "Location not set"}`}
          />
        )}
      </dl>

      <div>
        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? "Hide details" : "Show all details"}
        </button>
        {detailsOpen && (
          <dl id={detailsId} aria-label="Additional event details">
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
    </section>
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
  if (variant === "organizer") {
    return <OrganizerEventDetails event={event} extraCards={extraCards} />;
  }

  return (
    <dl aria-label="Event details">
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
                {
                  timeZoneName: "short",
                },
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
