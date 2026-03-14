import { Router } from "express";
import { verifyPassword } from "../lib/crypto.js";
import { schedulerStore } from "../lib/store/index.js";

export const verifyRouter = Router();

verifyRouter.post("/", async (req, res) => {
  try {
    const { code, password } = req.body;

    if (!code || !password) {
      return res.status(400).json({ error: "code and password are required" });
    }

    const event = await schedulerStore.getEvent(code);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const valid = await verifyPassword(password, event.passwordHash);
    return res.json({ valid });
  } catch (err) {
    const status = err instanceof SyntaxError ? 400 : 500;
    const message = status === 500 ? "Internal server error" : err.message;
    return res.status(status).json({ error: message });
  }
});
