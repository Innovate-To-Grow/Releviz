import {
  fetchClerkUser,
  getRequestAuthToken,
  normalizeClerkUser,
  verifyClerkSessionToken,
} from "../lib/clerk.js";
import { schedulerStore } from "../lib/store/index.js";

async function syncUser(userId) {
  // Check local cache first; avoids Clerk dependency on every request
  const existing = await schedulerStore.getUserById(userId);
  if (existing) return existing;

  // Only call Clerk if user doesn't exist locally yet
  const clerkUser = await fetchClerkUser(userId);
  const normalized = normalizeClerkUser(clerkUser);

  try {
    await schedulerStore.createUser(normalized);
    return normalized;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return schedulerStore.getUserById(userId);
    }
    throw err;
  }

  const updates = {};
  if (existing.email !== normalized.email) updates.email = normalized.email;
  if (existing.displayName !== normalized.displayName) updates.displayName = normalized.displayName;
  if ((existing.imageUrl || null) !== normalized.imageUrl) updates.imageUrl = normalized.imageUrl;

  if (Object.keys(updates).length === 0) return existing;

  updates.updatedAt = normalized.updatedAt;
  return schedulerStore.updateUser(userId, updates);
}

async function authenticate(req) {
  const token = getRequestAuthToken(req);
  if (!token) {
    return { status: 401, error: "Authentication required" };
  }

  try {
    const payload = await verifyClerkSessionToken(token);
    req.userId = payload.sub;
    req.user = await syncUser(payload.sub);
    return null;
  } catch (err) {
    if (err?.message?.includes("Clerk")) {
      console.error("[requireAuth] configuration error:", err);
      return { status: 500, error: "Authentication is not configured" };
    }
    return { status: 401, error: "Invalid or expired token" };
  }
}

export async function requireAuth(req, res, next) {
  const failure = await authenticate(req);
  if (failure) {
    return res.status(failure.status).json({ error: failure.error });
  }
  return next();
}

export async function optionalAuth(req, _res, next) {
  const token = getRequestAuthToken(req);
  if (token) {
    try {
      const payload = await verifyClerkSessionToken(token);
      req.userId = payload.sub;
      req.user = await syncUser(payload.sub);
    } catch {
      // non-critical, continue
    }
  }
  next();
}
