"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Keep deadlines per recipient: changing accounts must not inherit another
// person's wait, and returning to the same account must not bypass its wait.
export default function useCodeResendCooldown(identity) {
  const [deadlines, setDeadlines] = useState({});
  const deadlinesRef = useRef({});
  const [now, setNow] = useState(() => Date.now());
  const deadline = deadlines[identity] || 0;
  const secondsRemaining = Math.max(0, Math.ceil((deadline - now) / 1000));

  const startCooldown = useCallback((key, seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const currentTime = Date.now();
    setNow(currentTime);
    const next = {
      ...deadlinesRef.current,
      [key]: currentTime + Math.ceil(seconds) * 1000,
    };
    deadlinesRef.current = next;
    setDeadlines(next);
  }, []);

  const getRemaining = useCallback((key) => {
    return Math.max(
      0,
      Math.ceil(((deadlinesRef.current[key] || 0) - Date.now()) / 1000),
    );
  }, []);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= deadline) window.clearInterval(timer);
    };
    // Refresh after an identity change, including time spent on another step.
    const initialTick = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(initialTick);
      window.clearInterval(timer);
    };
  }, [deadline, identity]);

  return { secondsRemaining, startCooldown, getRemaining };
}
