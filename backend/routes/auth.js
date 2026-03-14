import { Router } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { signToken } from "../lib/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { schedulerStore } from "../lib/store/index.js";
import { toApiUser } from "../lib/store/types.js";

export const authRouter = Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: "/",
};

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

authRouter.post("/signup", authLimiter, async (req, res) => {
  try {
    const { email, password, displayName } = req.body;

    if (!email || typeof email !== "string" || !emailRegex.test(email.trim())) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    if (password.length > 1024) {
      return res.status(400).json({ error: "Password too long (max 1024 characters)" });
    }
    const trimmedName = (displayName || "").trim();
    if (!trimmedName) {
      return res.status(400).json({ error: "Display name is required" });
    }
    if (trimmedName.length > 100) {
      return res.status(400).json({ error: "Display name too long (max 100)" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await schedulerStore.getUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    await schedulerStore.createUser({
      userId,
      email: normalizedEmail,
      passwordHash,
      displayName: trimmedName,
      createdAt: now,
      updatedAt: now,
    });

    const token = signToken(userId);
    res.cookie("token", token, COOKIE_OPTIONS);

    return res.status(201).json({
      user: toApiUser({ userId, email: normalizedEmail, displayName: trimmedName, createdAt: now }),
    });
  } catch (err) {
    console.error("[auth/signup] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

authRouter.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await schedulerStore.getUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user.userId);
    res.cookie("token", token, COOKIE_OPTIONS);

    return res.json({ user: toApiUser(user) });
  } catch (err) {
    console.error("[auth/login] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie("token", { path: "/" });
  return res.json({ success: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await schedulerStore.getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ user: toApiUser(user) });
  } catch (err) {
    console.error("[auth/me] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

authRouter.put("/settings", requireAuth, async (req, res) => {
  try {
    const { displayName, currentPassword, newPassword } = req.body;
    const user = await schedulerStore.getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const updates = {};

    if (displayName !== undefined) {
      const trimmed = (displayName || "").trim();
      if (!trimmed) return res.status(400).json({ error: "Display name cannot be empty" });
      if (trimmed.length > 100) return res.status(400).json({ error: "Display name too long" });
      updates.displayName = trimmed;
    }

    if (newPassword) {
      if (newPassword.length > 1024) {
        return res.status(400).json({ error: "Password too long (max 1024 characters)" });
      }
      if (!(await verifyPassword(currentPassword, user.passwordHash))) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: "New password must be at least 6 characters" });
      }
      updates.passwordHash = await hashPassword(newPassword);
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ user: toApiUser(user) });
    }

    updates.updatedAt = new Date().toISOString();
    const updated = await schedulerStore.updateUser(req.userId, updates);
    return res.json({ user: toApiUser(updated) });
  } catch (err) {
    console.error("[auth/settings] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
