"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import EventContext from "@/components/event/EventContext";
import EventHeader from "@/components/event/EventHeader";
import ParticipantView from "@/components/schedule/ParticipantView";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchEvent, markInvitationOpened } from "@/lib/api/events";
import { navigateTo, replaceUrl } from "@/lib/navigation";

const OrganizerView = dynamic(
  () => import("@/components/schedule/OrganizerView"),
  {
    ssr: false,
    loading: () => (
      <main aria-busy="true">
        <p role="status">Loading organizer tools…</p>
      </main>
    ),
  },
);

const DemoEventPage =
  process.env.NODE_ENV === "development"
    ? dynamic(
        /* istanbul ignore next -- this development-only chunk loads in the browser. */
        () => import("@/components/event/DemoEventPage"),
        {
          ssr: false,
          /* istanbul ignore next -- Next renders this only while the development chunk loads. */
          loading: () => (
            <main aria-busy="true">
              <p role="status">Loading design preview...</p>
            </main>
          ),
        },
      )
    : null;

export function isDemoEventPreview(
  searchParams,
  nodeEnv = process.env.NODE_ENV,
) {
  return (
    nodeEnv === "development" &&
    searchParams.get("demo") === "1" &&
    searchParams.get("code") === "DEMO2026"
  );
}

function LiveEventPage({ searchParams }) {
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
  const [settledEventCode, setSettledEventCode] = useState("");
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
    if (!invitationToken || !eventCode) return;

    // Invitation telemetry is best-effort and must never gate event access.
    void markInvitationOpened(eventCode, invitationToken).catch(() => {});
    const url = new URL(window.location.href);
    url.searchParams.delete("invitation");
    replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  }, [eventCode, invitationToken]);

  useEffect(() => {
    if (authLoading) return undefined;
    if (!user) {
      const next = eventCode
        ? `/event?code=${encodeURIComponent(eventCode)}`
        : "/event";
      navigateTo(`/login?next=${encodeURIComponent(next)}`);
      return undefined;
    }
    if (requiresProfileCompletion) {
      const next = eventCode
        ? `/event?code=${encodeURIComponent(eventCode)}`
        : "/event";
      navigateTo(
        `/settings?complete_profile=1&next=${encodeURIComponent(next)}`,
      );
      return undefined;
    }
    if (!eventCode) {
      const timer = window.setTimeout(() => {
        setEvent(null);
        setIsOrganizer(false);
        setError("No event code in URL");
        setSettledEventCode("");
        setLoading(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    let active = true;

    async function load() {
      await Promise.resolve();
      if (!active) return;
      setEvent(null);
      setIsOrganizer(false);
      setError("");
      setLoading(true);
      try {
        const token = await getToken();
        const { event: ev } = await fetchEvent(eventCode, token);
        if (!active) return;
        setEvent(ev);

        const organizer = Boolean(
          user && ev.organizerUserId && ev.organizerUserId === user.id,
        );
        setIsOrganizer(organizer);
      } catch (err) {
        if (!active) return;
        setError(err.message || "Event not found");
      } finally {
        if (!active) return;
        setSettledEventCode(eventCode);
        setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [eventCode, user, authLoading, getToken, requiresProfileCompletion]);

  useEffect(() => {
    if (!event || !isOrganizer || !respondIntent) return undefined;
    const timer = window.setTimeout(consumeRespondIntent, 0);
    return () => window.clearTimeout(timer);
  }, [consumeRespondIntent, event, isOrganizer, respondIntent]);

  if (
    authLoading ||
    loading ||
    (Boolean(eventCode) && settledEventCode !== eventCode)
  ) {
    return (
      <main aria-busy="true">
        <p role="status">Loading event...</p>
      </main>
    );
  }

  if (!event) {
    return (
      <main>
        <h1>Event Not Found</h1>
        <p>{error || "This event does not exist."}</p>
        <Link href="/create">Create New Event</Link>
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

function EventPage() {
  const searchParams = useSearchParams();
  const demoPreview = isDemoEventPreview(searchParams);

  /* istanbul ignore next -- NODE_ENV=test cannot mount the dev-only chunk; browser smoke covers it. */
  if (demoPreview && DemoEventPage) return <DemoEventPage />;

  return <LiveEventPage searchParams={searchParams} />;
}

export default EventPage;
