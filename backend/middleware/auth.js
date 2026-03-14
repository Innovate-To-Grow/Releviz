import { verifyToken } from "../lib/auth.js";
import { schedulerStore } from "../lib/store/index.js";

export function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const payload = verifyToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export async function optionalAuth(req, _res, next) {
  const token = req.cookies?.token;
  if (token) {
    try {
      const payload = verifyToken(token);
      req.userId = payload.sub;
      const user = await schedulerStore.getUserById(payload.sub);
      if (user) {
        req.user = user;
      }
    } catch (err) {
      if (err?.name !== "JsonWebTokenError" && err?.name !== "TokenExpiredError") {
        console.error("[optionalAuth] unexpected error:", err);
      }
    }
  }
  next();
}
