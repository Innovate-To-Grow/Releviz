"use client";

import { useEffect, useState } from "react";

// How often a deadline that passes while the page is open is noticed.
const DEADLINE_CHECK_MS = 60000;

/**
 * Whether an active event's response deadline is behind us. Only an active
 * event can be past its deadline; closed and archived ones are already shut.
 */
export default function useDeadlinePassed(event) {
  const active = event.status === "active";
  const deadlineAt = event.responseDeadline
    ? Date.parse(event.responseDeadline)
    : NaN;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !Number.isFinite(deadlineAt)) return undefined;
    const timer = setInterval(() => setNow(Date.now()), DEADLINE_CHECK_MS);
    return () => clearInterval(timer);
  }, [active, deadlineAt]);

  return active && Number.isFinite(deadlineAt) && deadlineAt <= now;
}
