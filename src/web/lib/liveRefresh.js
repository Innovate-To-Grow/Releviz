// Live refresh pacing for the organizer workspace. The workspace always
// checks for new responses; there is no switch. What adapts is the pace:
// a check that loaded something, or any sign that the organizer is paying
// attention (the tab or network coming back, working in the page, pressing
// Refresh), puts the next check close behind, and each quiet check eases the
// pace off until it settles at the slowest. A busy event feels live while a
// quiet tab costs little.
export const LIVE_REFRESH_FASTEST_MS = 3000;
export const LIVE_REFRESH_SLOWEST_MS = 15000;
const LIVE_REFRESH_BACKOFF = 1.5;

// The wait before the check after one that ended with `outcome`: "changed"
// (something was loaded), "quiet" (nothing moved), "failed" (the check itself
// failed; ease off the same way so an unreachable server is not hammered), or
// "skipped" (a manual refresh or an earlier check was still running, so
// nothing was learned; keep the pace).
export function nextLiveRefreshDelay(current, outcome) {
  if (outcome === "changed") return LIVE_REFRESH_FASTEST_MS;
  if (outcome === "skipped") return current;
  return Math.min(
    Math.max(
      Math.round(current * LIVE_REFRESH_BACKOFF),
      LIVE_REFRESH_FASTEST_MS,
    ),
    LIVE_REFRESH_SLOWEST_MS,
  );
}

/**
 * Runs `check` (which resolves to an outcome above) on the adaptive pace.
 * The caller wires the triggers: `wake` checks now (the tab was shown again,
 * the network returned), `hurry` keeps the pace up without an extra check
 * (the organizer is active), and `stop` ends it. A check is never run while
 * the tab is hidden; the next `wake` catches up.
 */
export function createLiveRefreshScheduler({
  check,
  isVisible = () => document.visibilityState === "visible",
  now = () => Date.now(),
}) {
  let delay = LIVE_REFRESH_FASTEST_MS;
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
      delay = nextLiveRefreshDelay(delay, outcome);
    }
    schedule(chain);
  };
  const restart = ({ immediately }) => {
    generation += 1;
    window.clearTimeout(timer);
    delay = LIVE_REFRESH_FASTEST_MS;
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
      if (dueAt - now() > LIVE_REFRESH_FASTEST_MS)
        restart({ immediately: false });
      else delay = LIVE_REFRESH_FASTEST_MS;
    },
    stop() {
      generation += 1;
      window.clearTimeout(timer);
    },
  };
}
