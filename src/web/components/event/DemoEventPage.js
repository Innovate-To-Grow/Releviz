"use client";

import { useState } from "react";
import AuthContext from "@/components/auth/AuthContext";
import EventContext from "@/components/event/EventContext";
import EventHeader from "@/components/event/EventHeader";
import OrganizerScaleView from "@/components/schedule/OrganizerScaleView";
import { DEMO_EVENT, DEMO_ORGANIZER } from "@/lib/demo/eventData";

const demoAuth = {
  user: DEMO_ORGANIZER,
  loading: false,
  requiresProfileCompletion: false,
  getToken: async () => "demo-preview-token",
  logout: async () => {},
};

export default function DemoEventPage() {
  const [event, setEvent] = useState(() => DEMO_EVENT);

  return (
    <AuthContext.Provider value={demoAuth}>
      <EventContext.Provider
        value={{
          event,
          setEvent,
          isOrganizer: true,
          numSlots: event.slotCount || 0,
          respondIntent: false,
          consumeRespondIntent: () => {},
        }}
      >
        <EventHeader
          eventName={event.name}
          eventCode={event.code}
          isOrganizer
        />
        <aside aria-label="Design preview notice">
          <p role="note">
            Local design preview · All people, responses, and delivery details
            below are sample data.
          </p>
        </aside>
        <OrganizerScaleView />
      </EventContext.Provider>
    </AuthContext.Provider>
  );
}
