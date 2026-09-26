/**
 * @jest-environment jsdom
 */

import {
  LIVE_REFRESH_ACTIVE_PACE,
  LIVE_REFRESH_BACKSTOP_PACE,
  LIVE_REFRESH_FASTEST_MS,
  LIVE_REFRESH_IDLE_PACE,
  LIVE_REFRESH_SLOWEST_MS,
  attachLiveRefreshTriggers,
  createLiveRefreshScheduler,
  nextLiveRefreshDelay,
} from "@/lib/liveRefresh";

describe("live refresh pace", () => {
  test("eases off while quiet, settles at the slowest, and snaps back on a change", () => {
    expect(LIVE_REFRESH_FASTEST_MS).toBe(3000);
    expect(LIVE_REFRESH_SLOWEST_MS).toBe(15000);

    const waits = [LIVE_REFRESH_FASTEST_MS];
    while (waits.at(-1) < LIVE_REFRESH_SLOWEST_MS) {
      waits.push(nextLiveRefreshDelay(waits.at(-1), "quiet"));
    }
    expect(waits).toEqual([3000, 4500, 6750, 10125, 15000]);
    expect(nextLiveRefreshDelay(15000, "quiet")).toBe(15000);

    // A failed check eases off the same way; a skipped one learns nothing.
    expect(nextLiveRefreshDelay(3000, "failed")).toBe(4500);
    expect(nextLiveRefreshDelay(15000, "failed")).toBe(15000);
    expect(nextLiveRefreshDelay(10125, "skipped")).toBe(10125);

    expect(nextLiveRefreshDelay(10125, "changed")).toBe(3000);
    // Never faster than the fastest pace, whatever it is handed.
    expect(nextLiveRefreshDelay(1000, "quiet")).toBe(3000);
  });

  test("the pace is a parameter: idle waits 15 s, eases off to a minute, and snaps back to 15 s", () => {
    expect(LIVE_REFRESH_ACTIVE_PACE).toEqual({
      fastestMs: LIVE_REFRESH_FASTEST_MS,
      slowestMs: LIVE_REFRESH_SLOWEST_MS,
    });
    expect(LIVE_REFRESH_IDLE_PACE).toEqual({
      fastestMs: 15000,
      slowestMs: 60000,
    });

    const idle = LIVE_REFRESH_IDLE_PACE;
    const waits = [idle.fastestMs];
    while (waits.at(-1) < idle.slowestMs) {
      waits.push(nextLiveRefreshDelay(waits.at(-1), "quiet", idle));
    }
    expect(waits).toEqual([15000, 22500, 33750, 50625, 60000]);
    expect(nextLiveRefreshDelay(60000, "failed", idle)).toBe(60000);
    expect(nextLiveRefreshDelay(33750, "skipped", idle)).toBe(33750);
    expect(nextLiveRefreshDelay(60000, "changed", idle)).toBe(15000);
    // Never faster than the pace's own fastest wait.
    expect(nextLiveRefreshDelay(3000, "quiet", idle)).toBe(15000);
  });

  test("the backstop pace waits a minute every time a check gets through", () => {
    expect(LIVE_REFRESH_BACKSTOP_PACE).toEqual({
      fastestMs: 60000,
      slowestMs: 60000,
      retry: LIVE_REFRESH_ACTIVE_PACE,
    });
    const backstop = LIVE_REFRESH_BACKSTOP_PACE;
    for (const outcome of ["changed", "quiet", "skipped"]) {
      expect(nextLiveRefreshDelay(60000, outcome, backstop)).toBe(60000);
    }
    // Whatever it is handed, the wait is the minute.
    expect(nextLiveRefreshDelay(3000, "quiet", backstop)).toBe(60000);
    expect(nextLiveRefreshDelay(3000, "changed", backstop)).toBe(60000);
  });

  test("the backstop pace retries a failed check along the live pace, then returns to the minute", () => {
    const backstop = LIVE_REFRESH_BACKSTOP_PACE;
    const waits = [];
    let wait = backstop.fastestMs;
    for (let failures = 0; failures < 5; failures += 1) {
      wait = nextLiveRefreshDelay(wait, "failed", backstop);
      waits.push(wait);
    }
    // The first failure waits the live pace's first backoff, and further
    // ones ease off along it to its slowest and stay there.
    expect(waits).toEqual([4500, 6750, 10125, 15000, 15000]);
    // The first check that gets through, whatever it found, returns to the
    // minute, and a skipped one keeps the retry's wait.
    expect(nextLiveRefreshDelay(15000, "quiet", backstop)).toBe(60000);
    expect(nextLiveRefreshDelay(6750, "quiet", backstop)).toBe(60000);
    expect(nextLiveRefreshDelay(6750, "changed", backstop)).toBe(60000);
    expect(nextLiveRefreshDelay(6750, "skipped", backstop)).toBe(6750);
    // A failure after that starts the retry curve over.
    expect(nextLiveRefreshDelay(60000, "failed", backstop)).toBe(4500);
  });
});

describe("live refresh scheduler", () => {
  let visible;

  beforeEach(() => {
    jest.useFakeTimers();
    visible = true;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function start(outcome = "quiet", options = {}) {
    const check = jest.fn(async () =>
      typeof outcome === "function" ? outcome() : outcome,
    );
    const scheduler = createLiveRefreshScheduler({
      check,
      isVisible: () => visible,
      ...options,
    });
    scheduler.start();
    return { check, scheduler };
  }

  async function tick(ms) {
    await jest.advanceTimersByTimeAsync(ms);
  }

  test("checks at the fastest pace first and eases off while nothing changes", async () => {
    const { check } = start("quiet");
    await tick(2999);
    expect(check).toHaveBeenCalledTimes(0);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(4499);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(6750);
    expect(check).toHaveBeenCalledTimes(3);
  });

  test("returns to the fastest pace after a check that loaded something", async () => {
    const outcomes = ["quiet", "quiet", "changed", "quiet"];
    const { check } = start(() => outcomes.shift());
    await tick(3000 + 4500 + 6750);
    expect(check).toHaveBeenCalledTimes(3);
    await tick(2999);
    expect(check).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(4);
    // The quiet check after that eases off from the fastest again.
    await tick(4500);
    expect(check).toHaveBeenCalledTimes(5);
  });

  test("keeps its pace after a skipped check and eases off after a failed one", async () => {
    const outcomes = ["quiet", "skipped", "failed"];
    const { check } = start(() => outcomes.shift() || "quiet");
    await tick(3000 + 4500);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(4500);
    expect(check).toHaveBeenCalledTimes(3);
    await tick(6750);
    expect(check).toHaveBeenCalledTimes(4);
  });

  test("never checks a hidden tab; wake checks at once and restarts the pace", async () => {
    visible = false;
    const { check, scheduler } = start("quiet");
    await tick(3000 * 4);
    expect(check).not.toHaveBeenCalled();

    visible = true;
    scheduler.wake();
    await tick(0);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(4499);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(2);
  });

  test("uses the document's visibility by default", async () => {
    const { check } = start("quiet", { isVisible: undefined });
    await tick(3000);
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("runs on the idle pace when asked: 15 s first, easing off to a minute", async () => {
    const { check, scheduler } = start("quiet", {
      pace: LIVE_REFRESH_IDLE_PACE,
    });
    await tick(14999);
    expect(check).toHaveBeenCalledTimes(0);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(22499);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(2);
    // Hurry and wake restart from the pace's own fastest wait.
    scheduler.hurry();
    await tick(15000);
    expect(check).toHaveBeenCalledTimes(3);
    scheduler.wake();
    await tick(0);
    expect(check).toHaveBeenCalledTimes(4);
    await tick(22500);
    expect(check).toHaveBeenCalledTimes(5);
  });

  test("hurry pulls a far-off check in and restarts the pace, but leaves a near one its slot", async () => {
    const { check, scheduler } = start("quiet");
    // Two quiet checks: the third would wait 6.75 s.
    await tick(3000 + 4500);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(1000);
    scheduler.hurry();
    await tick(2999);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(3);

    // The next check is 4.5 s out; 2 s later it is within the fastest pace,
    // so it keeps its slot, but the pace after it starts from the fastest.
    await tick(2000);
    scheduler.hurry();
    await tick(2499);
    expect(check).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(4);
    await tick(4499);
    expect(check).toHaveBeenCalledTimes(4);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(5);
  });

  test("stop cancels the pending check and a check still running cannot revive the chain", async () => {
    let release;
    const { check, scheduler } = start(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await tick(3000);
    expect(check).toHaveBeenCalledTimes(1);
    scheduler.stop();
    release("changed");
    await tick(60000);
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("a wake during a running check runs one more check after it, not a concurrent one", async () => {
    const releases = [];
    const { check, scheduler } = start(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    await tick(3000);
    expect(check).toHaveBeenCalledTimes(1);
    // Two wakes while the check runs are one follow-up, and nothing starts
    // until the running check is done.
    scheduler.wake();
    scheduler.wake();
    await tick(1000);
    expect(check).toHaveBeenCalledTimes(1);
    releases[0]("quiet");
    await tick(0);
    expect(check).toHaveBeenCalledTimes(2);
    // The follow-up starts the pace over from the fastest wait, so a quiet
    // outcome puts the next check 4.5 s on, then 6.75 s on.
    releases[1]("quiet");
    await tick(4499);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(3);
    releases[2]("quiet");
    await tick(6749);
    expect(check).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(4);
  });

  test("stop drops a coalesced rerun", async () => {
    const releases = [];
    const { check, scheduler } = start(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    await tick(3000);
    expect(check).toHaveBeenCalledTimes(1);
    scheduler.wake();
    scheduler.stop();
    releases[0]("changed");
    await tick(60000);
    expect(check).toHaveBeenCalledTimes(1);
    // Started again, the scheduler owes no follow-up from before the stop:
    // the next check keeps to the pace instead of running twice.
    scheduler.start();
    await tick(3000);
    expect(check).toHaveBeenCalledTimes(2);
    releases[1]("quiet");
    await tick(0);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(4500);
    expect(check).toHaveBeenCalledTimes(3);
  });

  test("the backstop pace checks every minute, and hurry never pulls a check in under it", async () => {
    const outcomes = ["changed", "quiet", "quiet"];
    const { check, scheduler } = start(() => outcomes.shift() || "changed", {
      pace: LIVE_REFRESH_BACKSTOP_PACE,
    });
    await tick(59999);
    expect(check).toHaveBeenCalledTimes(0);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(60000);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(1000);
    scheduler.hurry();
    await tick(58999);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(3);
    // A wake still checks at once, and the minute starts over after it.
    scheduler.wake();
    await tick(0);
    expect(check).toHaveBeenCalledTimes(4);
    await tick(59999);
    expect(check).toHaveBeenCalledTimes(4);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(5);
  });

  test("on the backstop pace a failed check is tried again 4.5 s later, not a minute later", async () => {
    const outcomes = ["failed", "failed", "quiet"];
    const { check } = start(() => outcomes.shift() || "quiet", {
      pace: LIVE_REFRESH_BACKSTOP_PACE,
    });
    await tick(60000);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(4499);
    expect(check).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(2);
    // Still failing, it eases off along the live pace ...
    await tick(6749);
    expect(check).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(3);
    // ... and once a check gets through, the backstop waits its minute again.
    await tick(59999);
    expect(check).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(check).toHaveBeenCalledTimes(4);
  });
});

describe("live refresh triggers", () => {
  let detach = null;

  afterEach(() => {
    detach?.();
    detach = null;
    delete document.visibilityState;
  });

  function setTabVisibility(state) {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
  }

  test("wakes on a shown tab, focus, and the network returning, and hurries on activity", () => {
    const scheduler = { wake: jest.fn(), hurry: jest.fn() };
    detach = attachLiveRefreshTriggers(scheduler);

    setTabVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scheduler.wake).not.toHaveBeenCalled();
    setTabVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scheduler.wake).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(scheduler.wake).toHaveBeenCalledTimes(3);

    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("keydown"));
    expect(scheduler.hurry).toHaveBeenCalledTimes(2);
    expect(scheduler.wake).toHaveBeenCalledTimes(3);

    // Detached, nothing reaches the scheduler any more.
    detach();
    detach = null;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("keydown"));
    expect(scheduler.wake).toHaveBeenCalledTimes(3);
    expect(scheduler.hurry).toHaveBeenCalledTimes(2);
  });

  test("ignores activity when asked, and still detaches cleanly", () => {
    const scheduler = { wake: jest.fn(), hurry: jest.fn() };
    detach = attachLiveRefreshTriggers(scheduler, { activity: false });

    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("keydown"));
    expect(scheduler.hurry).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    expect(scheduler.wake).toHaveBeenCalledTimes(1);

    detach();
    detach = null;
    window.dispatchEvent(new Event("online"));
    expect(scheduler.wake).toHaveBeenCalledTimes(1);
  });
});
