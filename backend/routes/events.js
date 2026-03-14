import { Router } from "express";
import { generateEventCode, hashPassword } from "../lib/crypto.js";
import { optionalAuth } from "../middleware/auth.js";
import { schedulerStore } from "../lib/store/index.js";
import { toApiEvent } from "../lib/store/types.js";

export const eventsRouter = Router();

eventsRouter.get("/", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: "code is required" });

    const event = await schedulerStore.getEvent(code);
    if (!event) return res.status(404).json({ error: "Event not found" });

    return res.json({ event: toApiEvent(event) });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

eventsRouter.post("/", optionalAuth, async (req, res) => {
  try {
    const {
      name,
      password,
      startHour,
      endHour,
      days,
      mode,
      location,
      participantVerification,
      participantViewPermission,
      daySelectionType,
      specificDates,
    } = req.body;

    const trimmedName = (name || "").trim();
    if (!trimmedName) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (trimmedName.length > 200) {
      return res.status(400).json({ error: "Event name too long (max 200)" });
    }

    // Password required only for anonymous event creation
    if (!req.userId) {
      if (!password || typeof password !== "string" || password.length === 0) {
        return res.status(400).json({ error: "Password is required" });
      }
    }
    if (password && password.length > 200) {
      return res.status(400).json({ error: "Password too long (max 200)" });
    }

    if (mode && !["virtual", "inperson", "mixed"].includes(mode)) {
      return res
        .status(400)
        .json({ error: "Invalid mode. Must be 'inperson', 'virtual', or 'mixed'" });
    }

    const start = startHour !== undefined ? startHour : 9;
    const end = endHour !== undefined ? endHour : 17;

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return res.status(400).json({ error: "Hours must be integers" });
    }

    const selectedDays = Array.isArray(days) && days.length > 0 ? days : [1, 2, 3, 4, 5];
    if (!selectedDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return res.status(400).json({ error: "Days must be integers 0-6" });
    }
    const eventMode = mode || "inperson";
    const eventLocation = eventMode !== "virtual" ? (location || "").trim() || "TBD" : "";

    if (start >= end || start < 0 || end > 24) {
      return res.status(400).json({ error: "Invalid time range" });
    }
    if (eventLocation.length > 500) {
      return res.status(400).json({ error: "Location too long (max 500)" });
    }

    // Day selection type validation
    const selectionType = daySelectionType || "days_of_week";
    if (!["days_of_week", "specific_dates"].includes(selectionType)) {
      return res.status(400).json({ error: "Invalid daySelectionType" });
    }
    if (selectionType === "specific_dates") {
      if (!Array.isArray(specificDates) || specificDates.length === 0) {
        return res.status(400).json({ error: "specificDates must be a non-empty array" });
      }
      if (!specificDates.every((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))) {
        return res
          .status(400)
          .json({ error: "specificDates must be ISO date strings (YYYY-MM-DD)" });
      }
    }

    const validVerificationModes = ["none", "login", "email_link", "phone"];
    if (participantVerification && !validVerificationModes.includes(participantVerification)) {
      return res.status(400).json({ error: "Invalid participantVerification value" });
    }
    const validViewPermissions = ["own_only", "all", "realtime"];
    if (participantViewPermission && !validViewPermissions.includes(participantViewPermission)) {
      return res.status(400).json({ error: "Invalid participantViewPermission value" });
    }

    const passwordHash = password ? await hashPassword(password) : null;

    let created = false;
    let code = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      code = generateEventCode();
      created = await schedulerStore.createEvent({
        eventCode: code,
        name: trimmedName,
        passwordHash,
        startHour: start,
        endHour: end,
        days: selectedDays,
        mode: eventMode,
        location: eventLocation,
        organizerUserId: req.userId || null,
        participantVerification: participantVerification || "none",
        participantViewPermission: participantViewPermission || "own_only",
        daySelectionType: selectionType,
        specificDates: selectionType === "specific_dates" ? specificDates : undefined,
      });
      if (created) break;
    }

    if (!created) {
      return res.status(500).json({ error: "Failed to generate unique code" });
    }

    // Link event to authenticated user
    if (req.userId) {
      await schedulerStore.createUserEvent({
        userId: req.userId,
        eventCode: code,
        role: "organizer",
      });
    }

    return res.status(201).json({
      event: {
        code,
        name: trimmedName,
        startHour: start,
        endHour: end,
        days: selectedDays,
        mode: eventMode,
        location: eventLocation,
      },
      password,
    });
  } catch (err) {
    const status = err instanceof SyntaxError ? 400 : 500;
    const message = status === 500 ? "Internal server error" : err.message;
    return res.status(status).json({ error: message });
  }
});
