/**
 * @jest-environment jsdom
 */

import {
  DEFAULT_LIVE_REFRESH_MS,
  LIVE_REFRESH_OPTIONS,
  readLiveRefreshInterval,
  storeLiveRefreshInterval,
} from "@/lib/liveRefresh";

const KEY = "releviz.organizer.live-refresh-ms";

describe("live refresh interval", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  test("defaults to every five seconds and offers an off switch", () => {
    expect(DEFAULT_LIVE_REFRESH_MS).toBe(5000);
    expect(readLiveRefreshInterval()).toBe(5000);
    expect(LIVE_REFRESH_OPTIONS.map((option) => option.value)).toEqual([
      5000, 15000, 30000, 60000, 0,
    ]);
  });

  test("remembers a chosen interval, including off", () => {
    storeLiveRefreshInterval(30000);
    expect(window.localStorage.getItem(KEY)).toBe("30000");
    expect(readLiveRefreshInterval()).toBe(30000);
    storeLiveRefreshInterval(0);
    expect(readLiveRefreshInterval()).toBe(0);
  });

  test("ignores stored values that are not an offered interval", () => {
    for (const stored of ["7", "fast", "-5000"]) {
      window.localStorage.setItem(KEY, stored);
      expect(readLiveRefreshInterval()).toBe(5000);
    }
  });

  test("falls back quietly when storage is unavailable", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readLiveRefreshInterval()).toBe(5000);
    expect(() => storeLiveRefreshInterval(15000)).not.toThrow();
  });
});
