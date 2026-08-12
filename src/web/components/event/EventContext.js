"use client";

import { createContext } from "react";

const EventContext = createContext({
  event: null, // { code, name, startTime, endTime, slotMinutes, slotGroups }
  isOrganizer: false,
  numSlots: 0,
  respondIntent: false,
  consumeRespondIntent: () => {},
});

export default EventContext;
