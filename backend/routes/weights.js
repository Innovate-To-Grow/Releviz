import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { schedulerStore } from "../lib/store/index.js";
import { toApiWeight } from "../lib/store/types.js";

export const weightsRouter = Router();
weightsRouter.use(requireAuth);

weightsRouter.get("/", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: "code is required" });

    const event = await schedulerStore.getEvent(code);
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (event.organizerUserId !== req.userId) {
      return res.status(403).json({ error: "Only the organizer can view weights" });
    }

    const weights = await schedulerStore.listWeights(code);
    return res.json({ weights: weights.map(toApiWeight) });
  } catch (err) {
    const status = err instanceof SyntaxError ? 400 : 500;
    const message = status === 500 ? "Internal server error" : err.message;
    return res.status(status).json({ error: message });
  }
});

weightsRouter.put("/", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: "code is required" });

    const event = await schedulerStore.getEvent(code);
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (event.organizerUserId !== req.userId) {
      return res.status(403).json({ error: "Only the organizer can update weights" });
    }

    const { weights } = req.body;
    if (!Array.isArray(weights)) {
      return res.status(400).json({ error: "weights must be an array" });
    }

    const participants = await schedulerStore.listParticipants(code);
    const participantMap = new Map(
      participants.map((participant) => [participant.participantId, participant])
    );

    const normalizedWeights = [];
    for (const item of weights) {
      const participantId = item.participantId ?? item.id;
      const w = Number(item.weight !== undefined ? item.weight : 1.0);
      if (!participantId || !Number.isFinite(w) || w < 0 || w > 1) {
        return res.status(400).json({ error: "Invalid weight entry" });
      }
      if (item.included !== undefined && item.included !== 0 && item.included !== 1) {
        return res.status(400).json({ error: "Invalid included value" });
      }
      const participant = participantMap.get(participantId);
      if (!participant) {
        return res.status(400).json({ error: `Participant '${participantId}' not found` });
      }
      normalizedWeights.push({
        participantId,
        participantName: participant.participantName,
        weight: item.weight !== undefined ? item.weight : 1.0,
        included: item.included !== undefined ? item.included : 1,
      });
    }

    await schedulerStore.upsertWeights(code, normalizedWeights);
    const updated = await schedulerStore.listWeights(code);
    return res.json({ weights: updated.map(toApiWeight) });
  } catch (err) {
    const status = err instanceof SyntaxError ? 400 : 500;
    const message = status === 500 ? "Internal server error" : err.message;
    return res.status(status).json({ error: message });
  }
});
