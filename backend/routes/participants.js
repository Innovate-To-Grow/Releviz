import { Router } from "express";
import { DAYS_PER_WEEK } from "../lib/constants.js";
import { requireAuth } from "../middleware/auth.js";
import { schedulerStore } from "../lib/store/index.js";
import { toApiParticipant } from "../lib/store/types.js";

export const participantsRouter = Router();
participantsRouter.use(requireAuth);

participantsRouter.get("/", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: "code is required" });

    const event = await schedulerStore.getEvent(code);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const allParticipants = await schedulerStore.listParticipants(code);
    const includeHidden = req.query.includeHidden === "true" && event.organizerUserId === req.userId;
    const participants = includeHidden ? allParticipants : allParticipants.filter((p) => !p.hidden);

    return res.json({ participants: participants.map(toApiParticipant) });
  } catch (err) {
    const status = err instanceof SyntaxError ? 400 : 500;
    const message = status === 500 ? "Internal server error" : err.message;
    return res.status(status).json({ error: message });
  }
});

participantsRouter.post("/", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: "code is required" });

    const event = await schedulerStore.getEvent(code);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const trimmedName = (req.user?.displayName || req.user?.email?.split("@")[0] || "").trim();
    if (!trimmedName) return res.status(400).json({ error: "Name is required" });
    if (trimmedName.length > 100) return res.status(400).json({ error: "Name too long (max 100)" });

    const numDays =
      event.daySelectionType === "specific_dates" && Array.isArray(event.specificDates)
        ? event.specificDates.length
        : DAYS_PER_WEEK;
    const numSlots = (event.endHour - event.startHour) * numDays;
    const defaultSchedule = JSON.stringify(Array(numSlots).fill(0));

    const { participant, created } = await schedulerStore.createParticipantIfAbsent({
      eventCode: code,
      eventId: event.eventId,
      participantId: req.userId,
      userId: req.userId,
      participantName: trimmedName,
      scheduleInperson: defaultSchedule,
      scheduleVirtual: defaultSchedule,
    });

    const participantWithCurrentName =
      participant.participantName === trimmedName
        ? participant
        : await schedulerStore.updateParticipant(code, participant.participantId, {
            participantName: trimmedName,
          });

    if (created && event.organizerUserId !== req.userId) {
      try {
        await schedulerStore.createUserEvent({
          userId: req.userId,
          eventCode: code,
          role: "participant",
        });
      } catch {
        // Non-critical — continue even if linking fails
      }
    }

    return res
      .status(created ? 201 : 200)
      .json({ participant: toApiParticipant(participantWithCurrentName) });
  } catch (err) {
    const status = err instanceof SyntaxError ? 400 : 500;
    const message = status === 500 ? "Internal server error" : err.message;
    return res.status(status).json({ error: message });
  }
});
