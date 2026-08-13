"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import EventContext from "@/components/event/EventContext";
import EventHeader from "@/components/event/EventHeader";
import ParticipantView from "@/components/schedule/ParticipantView";
import OrganizerView from "@/components/schedule/OrganizerView";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchEvent, markInvitationOpened } from "@/lib/api/events";
import { navigateTo, replaceUrl } from "@/lib/navigation";

function EventPage() {
  const searchParams = useSearchParams();
  const eventCode = searchParams.get("code");
  const invitationToken = searchParams.get("invitation");
  const {
    user,
    loading: authLoading,
    getToken,
    requiresProfileCompletion,
  } = useAuth();

  const [event, setEvent] = useState(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [invitationReady, setInvitationReady] = useState(!invitationToken);
  const [respondIntent, setRespondIntent] = useState(
    () => searchParams.get("respond") === "1",
  );

  const consumeRespondIntent = useCallback(() => {
    setRespondIntent(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("respond");
    replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    if (!invitationToken || !eventCode) {
      setInvitationReady(true);
      return;
    }
    let active = true;
    setInvitationReady(false);
    markInvitationOpened(eventCode, invitationToken)
      .catch(() => {})
      .finally(() => {
        if (!active) return;
        const url = new URL(window.location.href);
        url.searchParams.delete("invitation");
        replaceUrl(`${url.pathname}${url.search}${url.hash}`);
        setInvitationReady(true);
      });
    return () => {
      active = false;
    };
  }, [eventCode, invitationToken]);

  useEffect(() => {
    if (authLoading || !invitationReady) return;
    if (!user) {
      const next = eventCode
        ? `/event?code=${encodeURIComponent(eventCode)}`
        : "/event";
      navigateTo(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (requiresProfileCompletion) {
      const next = eventCode
        ? `/event?code=${encodeURIComponent(eventCode)}`
        : "/event";
      navigateTo(
        `/settings?complete_profile=1&next=${encodeURIComponent(next)}`,
      );
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

        const organizer = Boolean(
          user && ev.organizerUserId && ev.organizerUserId === user.id,
        );
        setIsOrganizer(organizer);
        if (organizer && respondIntent) consumeRespondIntent();
      } catch (err) {
        setError(err.message || "Event not found");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [
    eventCode,
    user,
    authLoading,
    getToken,
    invitationReady,
    requiresProfileCompletion,
    respondIntent,
    consumeRespondIntent,
  ]);

  if (authLoading || !invitationReady || loading) {
    return (
      <main className="status-page" aria-busy="true">
        <p role="status">Loading event...</p>
      </main>
    );
  }

  if (!event) {
    return (
      <main className="status-page">
        <span className="status-page-code">Event unavailable</span>
        <h1>Event Not Found</h1>
        <p>{error || "This event does not exist."}</p>
        <Link className="app-btn app-btn-filled" href="/create">
          Create New Event
        </Link>
      </main>
    );
  }

  const numSlots = event.slotCount || 0;

  return (
    <EventContext.Provider
      value={{
        event,
        setEvent,
        isOrganizer,
        numSlots,
        respondIntent: respondIntent && !isOrganizer,
        consumeRespondIntent,
      }}
    >
      <EventHeader
        eventName={event.name}
        eventCode={event.code}
        isOrganizer={isOrganizer}
      />
      {isOrganizer ? <OrganizerView /> : <ParticipantView />}
    </EventContext.Provider>
  );
}

export default EventPage;
