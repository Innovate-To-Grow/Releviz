"use client";

import dynamic from "next/dynamic";

const EventPage = dynamic(() => import("@/components/event/EventPage"), { ssr: false });

export default function EventPageClient() {
  return <EventPage />;
}
