import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { schedulerStore } from "../lib/store/index.js";
import { toApiEvent } from "../lib/store/types.js";

export const dashboardRouter = Router();

dashboardRouter.get("/events", requireAuth, async (req, res) => {
  try {
    const userEvents = await schedulerStore.listUserEvents(req.userId);

    const organized = [];
    const participating = [];

    const events = await Promise.all(userEvents.map((ue) => schedulerStore.getEvent(ue.eventCode)));

    events.forEach((event, i) => {
      if (!event) return;
      const apiEvent = toApiEvent(event);
      if (userEvents[i].role === "organizer") {
        organized.push(apiEvent);
      } else {
        participating.push(apiEvent);
      }
    });

    return res.json({ organized, participating });
  } catch (err) {
    console.error("[dashboard/events] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
