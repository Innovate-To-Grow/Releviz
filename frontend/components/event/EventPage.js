"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import EventContext from "@/components/event/EventContext";
import EventHeader from "@/components/event/EventHeader";
import ParticipantView from "@/components/schedule/ParticipantView";
import OrganizerView from "@/components/schedule/OrganizerView";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchEvent } from "@/lib/api/events";
import { DAYS_PER_WEEK } from "@/lib/constants";

function EventPage() {
  const searchParams = useSearchParams();
  const eventCode = searchParams.get("code");
  const { user, loading: authLoading, getToken } = useAuth();

  const [event, setEvent] = useState(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      const next = eventCode ? `/event?code=${encodeURIComponent(eventCode)}` : "/event";
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (!eventCode) {
      setError("No event code in URL");
      setLoading(false);
      return;
    }
    async function load() {
      try {
        const token = await getToken();
        const { event: ev } = await fetchEvent(eventCode, token);
        setEvent(ev);

        setIsOrganizer(Boolean(user && ev.organizerUserId && ev.organizerUserId === user.id));
      } catch (err) {
        setError(err.message || "Event not found");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [eventCode, user, authLoading, getToken]);

  if (authLoading || loading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh",
        }}
      >
        <p style={{ color: "var(--md-sys-color-on-surface-variant)", fontSize: "1.1rem" }}>
          Loading event...
        </p>
      </div>
    );
  }

  if (!event) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh",
        }}
      >
        <div className="md-card" style={{ maxWidth: "400px", textAlign: "center" }}>
          <h2 style={{ color: "var(--md-sys-color-error)" }}>Event Not Found</h2>
          <p style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
            {error || "This event does not exist."}
          </p>
          <Link href="/">
            <AppButton>Create New Event</AppButton>
          </Link>
        </div>
      </div>
    );
  }

  const numDays =
    event.daySelectionType === "specific_dates" && Array.isArray(event.specificDates)
      ? event.specificDates.length
      : DAYS_PER_WEEK;
  const numSlots = (event.endHour - event.startHour) * numDays;

  return (
    <EventContext.Provider value={{ event, isOrganizer, numSlots }}>
      <EventHeader eventName={event.name} eventCode={event.code} isOrganizer={isOrganizer} />
      {isOrganizer ? <OrganizerView /> : <ParticipantView />}
    </EventContext.Provider>
  );
}

export default EventPage;
