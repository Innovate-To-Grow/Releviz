/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import useDeadlinePassed from "@/lib/useDeadlinePassed";

const NOW = Date.parse("2026-09-01T12:00:00Z");

describe("useDeadlinePassed", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("is false for an active event with no deadline", () => {
    const { result } = renderHook(() =>
      useDeadlinePassed({ status: "active", responseDeadline: null }),
    );
    expect(result.current).toBe(false);
  });

  test("is true for an active event whose deadline is behind it", () => {
    const { result } = renderHook(() =>
      useDeadlinePassed({
        status: "active",
        responseDeadline: "2026-09-01T11:59:00Z",
      }),
    );
    expect(result.current).toBe(true);
  });

  test("is false once the event is no longer active, whatever the deadline", () => {
    for (const status of ["closed", "finalized", "archived"]) {
      const { result } = renderHook(() =>
        useDeadlinePassed({
          status,
          responseDeadline: "2026-09-01T11:59:00Z",
        }),
      );
      expect(result.current).toBe(false);
    }
  });

  test("notices a deadline that arrives while the page is open", () => {
    const { result } = renderHook(() =>
      useDeadlinePassed({
        status: "active",
        responseDeadline: "2026-09-01T12:00:30Z",
      }),
    );
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(30000);
    });
    // Checked once a minute, so the half-minute has not been looked at yet.
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(30000);
    });
    expect(result.current).toBe(true);
  });

  test("stops checking once the event is closed, and when it unmounts", () => {
    const { rerender, unmount } = renderHook(
      ({ status }) =>
        useDeadlinePassed({
          status,
          responseDeadline: "2026-09-01T12:30:00Z",
        }),
      { initialProps: { status: "active" } },
    );
    expect(jest.getTimerCount()).toBe(1);

    rerender({ status: "closed" });
    expect(jest.getTimerCount()).toBe(0);

    rerender({ status: "active" });
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("ignores a deadline that is not a date", () => {
    const { result } = renderHook(() =>
      useDeadlinePassed({ status: "active", responseDeadline: "not a date" }),
    );
    expect(result.current).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
