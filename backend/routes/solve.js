import { Router } from "express";
import solver from "javascript-lp-solver";
import { requireAuth } from "../middleware/auth.js";
import { schedulerStore } from "../lib/store/index.js";

export const solveRouter = Router();

solveRouter.post("/", requireAuth, async (req, res) => {
  try {
    const { eventCode, quorum, mandatoryParticipantIds } = req.body;

    if (!eventCode) {
      return res.status(400).json({ error: "eventCode is required" });
    }

    const event = await schedulerStore.getEvent(eventCode);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const [participants, weights] = await Promise.all([
      schedulerStore.listParticipants(eventCode),
      schedulerStore.listWeights(eventCode),
    ]);

    const activeParticipants = participants.filter((p) => !p.hidden);
    if (activeParticipants.length === 0) {
      return res.status(400).json({ error: "No active participants" });
    }

    // Build weights map
    const weightMap = {};
    weights.forEach((w) => {
      weightMap[w.participantId] = { weight: w.weight, included: w.included };
    });

    const numSlots = (event.endHour - event.startHour) * (event.days?.length || 7);
    const minQuorum = quorum ?? Math.ceil(activeParticipants.length * 0.5);
    const mandatory = new Set(mandatoryParticipantIds || []);

    // Build ILP model
    const model = {
      optimize: "score",
      opType: "max",
      constraints: {
        select_one: { equal: 1 },
      },
      variables: {},
      binaries: {},
    };

    for (let t = 0; t < numSlots; t++) {
      let score = 0;
      let quorumCount = 0;
      let mandatoryBlocked = false;

      activeParticipants.forEach((p) => {
        const w = weightMap[p.participantId] ?? { weight: 1.0, included: 1 };
        if (!w.included) return;

        const schedule = JSON.parse(p.scheduleInperson || "[]");
        const availability = schedule[t] ?? 0;

        // Check mandatory constraint
        if (mandatory.has(p.participantId) && availability === 0) {
          mandatoryBlocked = true;
        }

        if (availability > 0) quorumCount++;
        score += availability * w.weight;
      });

      // Skip slots that violate constraints
      if (mandatoryBlocked || quorumCount < minQuorum) {
        continue;
      }

      const slotKey = `slot_${t}`;
      model.variables[slotKey] = { score, select_one: 1 };
      model.binaries[slotKey] = 1;
    }

    if (Object.keys(model.variables).length === 0) {
      return res.status(200).json({
        optimal: null,
        ranked: [],
        message: "No slots satisfy the constraints",
      });
    }

    solver.Solve(model);

    // Get top-N ranked slots by score
    const ranked = Object.entries(model.variables)
      .map(([key, val]) => ({
        slotIndex: parseInt(key.replace("slot_", "")),
        score: parseFloat(val.score.toFixed(3)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Convert slot index to human-readable time
    const days = event.days || [0, 1, 2, 3, 4, 5, 6];
    const rankedWithTime = ranked.map(({ slotIndex, score }) => {
      const hoursPerDay = event.endHour - event.startHour;
      const dayIndex = Math.floor(slotIndex / hoursPerDay);
      const hourOffset = slotIndex % hoursPerDay;
      const hour = event.startHour + hourOffset;
      const day = days[dayIndex];
      const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const ampm = hour >= 12 ? "PM" : "AM";
      const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
      return {
        slotIndex,
        day: dayLabels[day] ?? `Day ${day}`,
        time: `${displayHour}:00 ${ampm}`,
        score,
      };
    });

    return res.json({
      optimal: rankedWithTime[0] ?? null,
      ranked: rankedWithTime,
    });
  } catch (err) {
    console.error("[solve] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
