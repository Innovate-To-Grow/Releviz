/**
 * @jest-environment jsdom
 */

import {
  LIVE_REFRESH_FASTEST_MS,
  LIVE_REFRESH_SLOWEST_MS,
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

  test("a wake during a running check leaves one chain behind, not two", async () => {
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
    await tick(0);
    expect(check).toHaveBeenCalledTimes(2);
    releases[1]("quiet");
    releases[0]("quiet");
    await tick(0);
    // Only the woken chain schedules: one check 4.5 s on, then one 6.75 s on.
    await tick(4500);
    expect(check).toHaveBeenCalledTimes(3);
    releases[2]("quiet");
    await tick(6750);
    expect(check).toHaveBeenCalledTimes(4);
  });
});
