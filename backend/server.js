import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { eventsRouter } from "./routes/events.js";
import { verifyRouter } from "./routes/verify.js";
import { participantsRouter } from "./routes/participants.js";
import { participantsUpdateRouter } from "./routes/participantsUpdate.js";
import { weightsRouter } from "./routes/weights.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";

const app = express();
const port = process.env.PORT || 4000;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"];
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Route registration — more specific paths first
app.use("/api/auth", authRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/events/verify", verifyRouter);
app.use("/api/events/participants/update", participantsUpdateRouter);
app.use("/api/events/participants", participantsRouter);
app.use("/api/events/weights", weightsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/health", healthRouter);

// JSON parse error handler
app.use((err, _req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// Catch-all error handler
app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.error(`Backend listening on port ${port}`);
  });
}

export default app;
