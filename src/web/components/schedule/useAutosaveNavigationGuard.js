"use client";

import { useLayoutEffect, useRef } from "react";

const activeGuards = new Set();
const HISTORY_BARRIER_KEY = "__relevizAutosaveBarrier";
let historyBarrierSequence = 0;

function stateWithBarrier(state, barrier) {
  return {
    ...(state && typeof state === "object" ? state : {}),
    [HISTORY_BARRIER_KEY]: barrier,
  };
}

function barrierFromState(state) {
  return state?.[HISTORY_BARRIER_KEY] || null;
}

export async function flushPendingNavigationWork() {
  for (const guard of activeGuards) {
    if (!guard.hasPending()) continue;
    if (!(await guard.flush())) return false;
  }
  return true;
}

// A popstate handler cannot stop a Back traversal that crosses a document
// boundary: the editor is unloaded before that event can run. While work is
// pending, put a same-document barrier immediately behind the current entry.
// Back reaches that barrier first, giving us time to save before traversing to
// the caller's real destination. Normal link clicks are captured and replayed
// for the same reason.
export default function useAutosaveNavigationGuard({
  hasPending,
  flush,
  pending = false,
}) {
  const hasPendingRef = useRef(hasPending);
  const flushRef = useRef(flush);
  const pendingRef = useRef(pending);
  const armHistoryBarrierRef = useRef(null);
  const bypassNextClickRef = useRef(false);
  const bypassNextPopstateRef = useRef(false);
  const navigationPendingRef = useRef(false);

  useLayoutEffect(() => {
    hasPendingRef.current = hasPending;
    flushRef.current = flush;
    pendingRef.current = pending;
  }, [flush, hasPending, pending]);

  useLayoutEffect(() => {
    const activeGuard = {
      hasPending: () => Boolean(hasPendingRef.current?.()),
      flush: () => flushRef.current?.(),
    };
    activeGuards.add(activeGuard);

    let acceptedEntry = {
      state: window.history.state,
      url: window.location.href,
    };
    let barrierId = null;
    let barrierArmed = false;
    let normalizingForwardEntry = false;

    const currentBarrier = barrierFromState(window.history.state);
    if (
      currentBarrier?.url === window.location.href &&
      (currentBarrier.kind === "base" || currentBarrier.kind === "sentinel")
    ) {
      barrierId = currentBarrier.id;
      barrierArmed = true;
      normalizingForwardEntry = currentBarrier.kind === "base";
    }

    const armHistoryBarrier = () => {
      if (barrierArmed) return;
      const url = window.location.href;
      barrierId = `autosave-${++historyBarrierSequence}`;
      const baseBarrier = { id: barrierId, kind: "base", url };
      const sentinelBarrier = { id: barrierId, kind: "sentinel", url };
      window.history.replaceState(
        stateWithBarrier(window.history.state, baseBarrier),
        "",
        url,
      );
      window.history.pushState(
        stateWithBarrier(window.history.state, sentinelBarrier),
        "",
        url,
      );
      acceptedEntry = {
        state: window.history.state,
        url,
      };
      barrierArmed = true;
    };
    armHistoryBarrierRef.current = armHistoryBarrier;

    const acceptHistoryEntry = (event) => {
      acceptedEntry = {
        state: event.state,
        url: window.location.href,
      };
      const acceptedBarrier = barrierFromState(event.state);
      if (acceptedBarrier?.id !== barrierId) {
        barrierId = null;
        barrierArmed = false;
      }
    };

    const guardNavigation = (event) => {
      if (bypassNextClickRef.current) {
        bypassNextClickRef.current = false;
        return;
      }
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !hasPendingRef.current?.()
      ) {
        return;
      }

      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (navigationPendingRef.current) return;
      navigationPendingRef.current = true;

      void Promise.resolve(flushRef.current?.())
        .then((saved) => {
          if (!saved || !anchor.isConnected) return;
          bypassNextClickRef.current = true;
          anchor.click();
        })
        .catch(() => {})
        .finally(() => {
          navigationPendingRef.current = false;
        });
    };

    const guardHistoryTraversal = (event) => {
      const targetBarrier = barrierFromState(event.state);
      const isBarrierBase =
        barrierArmed &&
        targetBarrier?.id === barrierId &&
        targetBarrier.kind === "base";
      const isBarrierSentinel =
        barrierArmed &&
        targetBarrier?.id === barrierId &&
        targetBarrier.kind === "sentinel";

      if (normalizingForwardEntry && isBarrierSentinel) {
        event.preventDefault();
        event.stopImmediatePropagation();
        normalizingForwardEntry = false;
        acceptedEntry = {
          state: event.state,
          url: window.location.href,
        };
        return;
      }

      if (bypassNextPopstateRef.current) {
        bypassNextPopstateRef.current = false;
        acceptHistoryEntry(event);
        return;
      }

      if (!hasPendingRef.current?.()) {
        if (isBarrierBase) {
          event.preventDefault();
          event.stopImmediatePropagation();
          bypassNextPopstateRef.current = true;
          window.history.back();
          return;
        }
        acceptHistoryEntry(event);
        return;
      }

      // popstate is emitted after a same-document traversal. Restore the
      // accepted entry synchronously, save there, then skip both halves of our
      // barrier when the original action was Back through the base entry.
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        window.history.pushState(acceptedEntry.state, "", acceptedEntry.url);
      } catch {
        return;
      }

      if (navigationPendingRef.current) return;
      navigationPendingRef.current = true;

      void Promise.resolve(flushRef.current?.())
        .then((saved) => {
          if (!saved) return;
          bypassNextPopstateRef.current = true;
          window.history.go(isBarrierBase ? -2 : -1);
        })
        .catch(() => {})
        .finally(() => {
          navigationPendingRef.current = false;
        });
    };

    document.addEventListener("click", guardNavigation, true);
    window.addEventListener("popstate", guardHistoryTraversal, true);
    if (normalizingForwardEntry) window.history.forward();
    if (pendingRef.current) armHistoryBarrier();

    return () => {
      activeGuards.delete(activeGuard);
      document.removeEventListener("click", guardNavigation, true);
      window.removeEventListener("popstate", guardHistoryTraversal, true);
      armHistoryBarrierRef.current = null;
      if (hasPendingRef.current?.()) void flushRef.current?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (pending) armHistoryBarrierRef.current?.();
  }, [pending]);
}
