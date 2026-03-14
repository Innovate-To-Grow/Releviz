"use client";

import { createContext } from "react";

const EventContext = createContext({
  event: null, // { code, name, startHour, endHour }
  isOrganizer: false,
  password: null,
  numSlots: 0, // (endHour - startHour) * 7
});

export default EventContext;
