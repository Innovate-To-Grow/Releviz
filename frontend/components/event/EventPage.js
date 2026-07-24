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
import { fetchEvent, markInvitationOpened } from "@/lib/api/events";
import { navigateTo, replaceUrl } from "@/lib/navigation";

function EventPage() {
  const searchParams = useSearchParams();
  const eventCode = searchParams.get("code");
  const invitationToken = searchParams.get("invitation");
  const { user, loading: authLoading, getToken } = useAuth();

  const [event, setEvent] = useState(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [invitationReady, setInvitationReady] = useState(!invitationToken);

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
      const next = eventCode ? `/event?code=${encodeURIComponent(eventCode)}` : "/event";
      navigateTo(`/login?next=${encodeURIComponent(next)}`);
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
  }, [eventCode, user, authLoading, getToken, invitationReady]);

  if (authLoading || !invitationReady || loading) {
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

  const numSlots = event.slotCount || 0;

  return (
    <EventContext.Provider value={{ event, setEvent, isOrganizer, numSlots }}>
      <EventHeader eventName={event.name} eventCode={event.code} isOrganizer={isOrganizer} />
      {isOrganizer ? <OrganizerView /> : <ParticipantView />}
    </EventContext.Provider>
  );
}

export default EventPage;
