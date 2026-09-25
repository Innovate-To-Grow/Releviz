// Live refresh pacing for the organizer workspace. Nothing there is refreshed
// by hand: the workspace always checks for new information on its own, and
// what adapts is the pace. A check that loaded something, or any sign that
// the organizer is paying attention (the tab or network coming back, working
// in the page), puts the next check close behind, and each quiet check eases
// the pace off until it settles at the slowest. A busy event feels live while
// a quiet tab costs little.
//
// A pace is the pair of bounds the wait moves between. The active pace is for
// an event collecting responses; the idle pace is for one that is closed,
// finalized, or archived, where the only thing left to notice is a lifecycle
// change made in another session.
export const LIVE_REFRESH_ACTIVE_PACE = { fastestMs: 3000, slowestMs: 15000 };
export const LIVE_REFRESH_IDLE_PACE = { fastestMs: 15000, slowestMs: 60000 };
export const LIVE_REFRESH_FASTEST_MS = LIVE_REFRESH_ACTIVE_PACE.fastestMs;
export const LIVE_REFRESH_SLOWEST_MS = LIVE_REFRESH_ACTIVE_PACE.slowestMs;
const LIVE_REFRESH_BACKOFF = 1.5;

// The wait before the check after one that ended with `outcome`: "changed"
// (something was loaded), "quiet" (nothing moved), "failed" (the check itself
// failed; ease off the same way so an unreachable server is not hammered), or
// "skipped" (an earlier check was still running, so nothing was learned; keep
// the pace).
export function nextLiveRefreshDelay(
  current,
  outcome,
  pace = LIVE_REFRESH_ACTIVE_PACE,
) {
  if (outcome === "changed") return pace.fastestMs;
  if (outcome === "skipped") return current;
  return Math.min(
    Math.max(Math.round(current * LIVE_REFRESH_BACKOFF), pace.fastestMs),
    pace.slowestMs,
  );
}

/**
 * Runs `check` (which resolves to an outcome above) on the adaptive `pace`.
 * The caller wires the triggers (see `attachLiveRefreshTriggers`): `wake`
 * checks now (the tab was shown again, the network returned), `hurry` keeps
 * the pace up without an extra check (the organizer is active), and `stop`
 * ends it. A check is never run while the tab is hidden; the next `wake`
 * catches up.
 */
export function createLiveRefreshScheduler({
  check,
  pace = LIVE_REFRESH_ACTIVE_PACE,
  isVisible = () => document.visibilityState === "visible",
  now = () => Date.now(),
}) {
  let delay = pace.fastestMs;
  let timer = null;
  let dueAt = 0;
  // Bumped by every restart and by stop (which also clear the pending timer),
  // so a check that was already running when they happened cannot schedule a
  // second chain when it finishes.
  let generation = 0;

  const schedule = (chain) => {
    dueAt = now() + delay;
    timer = window.setTimeout(() => void run(chain), delay);
  };
  const run = async (chain) => {
    if (isVisible()) {
      const outcome = await check();
      if (chain !== generation) return;
      delay = nextLiveRefreshDelay(delay, outcome, pace);
    }
    schedule(chain);
  };
  const restart = ({ immediately }) => {
    generation += 1;
    window.clearTimeout(timer);
    delay = pace.fastestMs;
    if (immediately) void run(generation);
    else schedule(generation);
  };

  return {
    start() {
      schedule(generation);
    },
    wake() {
      restart({ immediately: true });
    },
    hurry() {
      // Pull a far-off check in; a near one keeps its slot. Either way the
      // pace after it starts from the fastest again.
      if (dueAt - now() > pace.fastestMs) restart({ immediately: false });
      else delay = pace.fastestMs;
    },
    stop() {
      generation += 1;
      window.clearTimeout(timer);
    },
  };
}

/**
 * Wires the page events that move a scheduler along: the tab being shown
 * again, the window regaining focus, or the network returning check at once
 * (`wake`), and, unless `activity` is off, the organizer working in the page
 * (a pointer press or a key anywhere) keeps the pace up (`hurry`). Returns
 * the function that removes the listeners. Call it in the same cleanup that
 * stops the scheduler: a wake reaching a stopped scheduler starts it over.
 */
export function attachLiveRefreshTriggers(scheduler, { activity = true } = {}) {
  const wake = () => scheduler.wake();
  const hurry = () => scheduler.hurry();
  const handleVisibility = () => {
    if (document.visibilityState === "visible") wake();
  };
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  if (activity) {
    document.addEventListener("pointerdown", hurry, { passive: true });
    document.addEventListener("keydown", hurry, { passive: true });
  }
  return () => {
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
    if (activity) {
      document.removeEventListener("pointerdown", hurry);
      document.removeEventListener("keydown", hurry);
    }
  };
}
