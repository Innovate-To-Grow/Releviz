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
// While the server pushes changes to the workspace (see liveStream.js), a
// check a minute is only a safety net, so the backstop pace has a single
// wait: a change does not pull the next check closer, and `hurry` can never
// pull one in under it.
//
// A failed check is the exception. A pace may name a `retry` curve, a pace of
// its own whose waits are all shorter than the pace's, and failures ease off
// along it instead. The backstop's is the active pace, so a pass that fell
// over (a 502 while a deploy drains a task, a pool timeout, a network blip) is
// tried again seconds later, as it would be without the stream, rather than
// leaving the workspace showing its updates as paused for a whole minute.
export const LIVE_REFRESH_BACKSTOP_PACE = {
  fastestMs: 60000,
  slowestMs: 60000,
  retry: LIVE_REFRESH_ACTIVE_PACE,
};
export const LIVE_REFRESH_FASTEST_MS = LIVE_REFRESH_ACTIVE_PACE.fastestMs;
export const LIVE_REFRESH_SLOWEST_MS = LIVE_REFRESH_ACTIVE_PACE.slowestMs;
const LIVE_REFRESH_BACKOFF = 1.5;

// The wait before the check after one that ended with `outcome`: "changed"
// (something was loaded), "quiet" (nothing moved), "failed" (the check itself
// failed; ease off the same way so an unreachable server is not hammered), or
// "skipped" (an earlier check was still running, so nothing was learned; keep
// the pace).
//
// On a pace with a `retry` curve a failure eases off along the curve instead.
// The first failure after one of the pace's own waits waits the curve's first
// step up from its fastest, and each further failure grows that by the usual
// factor up to the curve's slowest. A wait shorter than the pace's fastest can
// only be a retry, which is how the two are told apart. The first check that
// gets through, quiet or changed, returns to the pace's own wait, since
// neither outcome can land under the pace's fastest.
export function nextLiveRefreshDelay(
  current,
  outcome,
  pace = LIVE_REFRESH_ACTIVE_PACE,
) {
  if (outcome === "changed") return pace.fastestMs;
  if (outcome === "skipped") return current;
  if (outcome === "failed" && pace.retry) {
    const retrying = current < pace.fastestMs;
    return nextLiveRefreshDelay(
      retrying ? current : pace.retry.fastestMs,
      outcome,
      pace.retry,
    );
  }
  return Math.min(
    Math.max(Math.round(current * LIVE_REFRESH_BACKOFF), pace.fastestMs),
    pace.slowestMs,
  );
}

/**
 * Runs `check` (which resolves to an outcome above) on the adaptive `pace`.
 * The caller wires the triggers (see `attachLiveRefreshTriggers`): `wake`
 * checks now (the tab was shown again, the network returned, the server
 * pushed a change), `hurry` keeps the pace up without an extra check (the
 * organizer is active), and `stop` ends it. A check is never run while the
 * tab is hidden; the next `wake` catches up. A `wake` while a check is
 * running asks for one more check right after it rather than a concurrent
 * one.
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
  // Whether a check is in flight, and whether a wake arrived while it was.
  // Starting a concurrent check instead would be reported as "skipped" by the
  // workspace and lose a change that arrived in the middle of the pass, so
  // the wake is kept and honoured as one more check right after this one.
  let running = false;
  let rerun = false;

  const schedule = (chain) => {
    dueAt = now() + delay;
    timer = window.setTimeout(() => void run(chain), delay);
  };
  const run = async (chain) => {
    if (isVisible()) {
      running = true;
      let outcome;
      try {
        outcome = await check();
      } finally {
        running = false;
      }
      if (chain !== generation) return;
      if (rerun) {
        rerun = false;
        delay = pace.fastestMs;
        void run(chain);
        return;
      }
      delay = nextLiveRefreshDelay(delay, outcome, pace);
    }
    schedule(chain);
  };
  const restart = ({ immediately }) => {
    generation += 1;
    rerun = false;
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
      if (running) rerun = true;
      else restart({ immediately: true });
    },
    hurry() {
      // Pull a far-off check in; a near one keeps its slot. Either way the
      // pace after it starts from the fastest again.
      if (dueAt - now() > pace.fastestMs) restart({ immediately: false });
      else delay = pace.fastestMs;
    },
    stop() {
      generation += 1;
      rerun = false;
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
