"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import EventContext from "@/components/event/EventContext";
import { OrganizerHeader } from "@/components/schedule/OrganizerPanels";
import {
  DeliveryRequestProgress,
  EventControls,
  OverviewPanel,
  ResultsSnapshotPanel,
} from "@/components/schedule/OrganizerScalePanels";
import RosterPanel from "@/components/schedule/RosterPanel";
import Alert from "@/components/ui/Alert";
import LoadingState from "@/components/ui/LoadingState";
import { CalendarIcon, ResultsIcon, RosterIcon } from "@/components/ui/icons";
import { fetchEvent, fetchEventActivity } from "@/lib/api/events";
import { createLiveRefreshScheduler } from "@/lib/liveRefresh";
import { selectionFromRecommendation } from "@/lib/meetingWindows";

// Workspace order: event facts, then the meeting-time calendar with its
// ranked windows and confirmation step, then the roster that feeds them.
const SECTION_LINKS = [
  { id: "overview", label: "Overview", Icon: CalendarIcon },
  { id: "results", label: "Results", Icon: ResultsIcon },
  { id: "roster", label: "Roster", Icon: RosterIcon },
];
const SECTION_IDS = SECTION_LINKS.map((section) => section.id);
// The section navigation is sticky, so anchored sections must scroll into
// view below it rather than underneath it.
const SECTION_SCROLL_STYLE = { scrollMarginTop: "4rem" };

// Live sync: while the event is active and this tab is visible, the
// workspace polls a small activity digest and silently re-reads only the
// sections whose digest moved, so new responses, invitation opens, and edits
// from another session appear without pressing Refresh and without touching
// what the organizer is doing (a pick, a row draft, an open drawer). It is
// always on; only its pace adapts (see lib/liveRefresh): quick while things
// change or the organizer is active, easing off while the workspace is quiet.
const EVENT_DIGEST_KEYS = ["version", "status"];
const RESULTS_DIGEST_KEYS = [
  "status",
  "requestedRevision",
  "computedRevision",
  "generatedAt",
];
const ROSTER_DIGEST_KEYS = ["total", "submitted", "changedAt"];

function digestMoved(next, shown, keys) {
  return keys.some((key) => (next?.[key] ?? null) !== (shown?.[key] ?? null));
}

function deliveryStorageKey(eventCode) {
  return `releviz.delivery-request.${eventCode}`;
}

function readStoredDeliveryRequest(eventCode) {
  if (typeof window === "undefined" || !eventCode) return null;
  try {
    return (
      JSON.parse(
        window.sessionStorage.getItem(deliveryStorageKey(eventCode)),
      ) || null
    );
  } catch {
    window.sessionStorage.removeItem(deliveryStorageKey(eventCode));
    return null;
  }
}

// Brings the Finalize step into view (only as far as needed: it sits beside
// the calendar, so a pick usually leaves it already visible) and focuses it.
function focusFinalizeStep(headingRef) {
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  document.getElementById("organizer-finalize")?.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "nearest",
  });
  headingRef.current?.focus({ preventScroll: true });
}

function WorkspaceSectionNav() {
  return (
    <nav className="section-nav" aria-label="Workspace sections">
      <ul className="nav nav-pills">
        {SECTION_LINKS.map(({ id, label, Icon }) => (
          <li className="nav-item" key={id}>
            <a
              className="nav-link d-inline-flex align-items-center gap-2 py-2"
              href={`#organizer-${id}`}
            >
              <span className="icon-inline" aria-hidden="true">
                <Icon />
              </span>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function OrganizerScaleView() {
  const { event, setEvent } = useContext(EventContext);
  const { user, loading, getToken } = useAuth();
  const [deliveryRequest, setDeliveryRequestState] = useState(null);
  const [selection, setSelection] = useState(null);
  const [resultsInvalidationKey, setResultsInvalidationKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [liveSync, setLiveSync] = useState({ error: "", updatedAt: null });
  const refreshInFlight = useRef(false);
  const syncInFlight = useRef(false);
  // The live-sync scheduler while the event is active, so the organizer's
  // own actions can keep its pace up.
  const paceRef = useRef(null);
  const eventRef = useRef(event);
  const rosterRef = useRef(null);
  const resultsRef = useRef(null);
  const resultsHeadingRef = useRef(null);
  const finalizeHeadingRef = useRef(null);

  // The latest email run (invitations, reminders, finalization, cancellation)
  // is remembered per event so its progress survives a reload.
  const setDeliveryRequest = useCallback(
    (next) => {
      const key = deliveryStorageKey(event.code);
      if (next) window.sessionStorage.setItem(key, JSON.stringify(next));
      else window.sessionStorage.removeItem(key);
      setDeliveryRequestState(next);
    },
    [event.code],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      const stored = readStoredDeliveryRequest(event.code);
      if (stored) setDeliveryRequestState(stored);
    }, 0);
    return () => clearTimeout(timer);
  }, [event.code]);

  // Picking a window (from the calendar or the ranked list) hands the
  // organizer straight to the confirmation step.
  useEffect(() => {
    if (!selection) return;
    focusFinalizeStep(finalizeHeadingRef);
  }, [selection]);

  useEffect(() => {
    const syncSectionFromHash = () => {
      const section = window.location.hash.replace("#organizer-", "");
      if (!SECTION_IDS.includes(section)) return;
      document.getElementById(`organizer-${section}`)?.scrollIntoView({
        behavior: "auto",
        block: "start",
      });
    };

    syncSectionFromHash();
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, []);

  // The header's Refresh is the only manual refresh control on the page: it
  // re-reads the event, roster, results, and any delivery progress that is
  // showing, and clears the current pick.
  const refreshWorkspace = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setRefreshStatus("");
    setRefreshError("");
    setSelection(null);
    setRefreshCount((current) => current + 1);
    paceRef.current?.hurry();

    try {
      const token = await getToken();
      const tasks = [
        fetchEvent(event.code, token),
        rosterRef.current?.refresh(token) || Promise.resolve(null),
        resultsRef.current?.refresh(token) || Promise.resolve(null),
      ];
      const [eventResult, rosterResult, resultsResult] =
        await Promise.allSettled(tasks);
      if (eventResult.status === "fulfilled" && eventResult.value?.event) {
        setEvent(eventResult.value.event);
      }

      const failed = [
        ["event", eventResult],
        ["roster", rosterResult],
        ["results", resultsResult],
      ].filter(([, result]) => result.status === "rejected");
      if (failed.length) {
        setRefreshError(
          `Unable to refresh ${failed.map(([name]) => name).join(", ")}. Other workspace sections were updated.`,
        );
      } else {
        setRefreshStatus("Workspace updated.");
      }
    } catch (requestError) {
      setRefreshError(
        requestError.message || "Unable to refresh this workspace.",
      );
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [event.code, getToken, setEvent]);

  useEffect(() => {
    eventRef.current = event;
  }, [event]);

  // One live-sync pass: compare the server's digest with what each section
  // shows and re-read only what moved. The manual Refresh wins over it.
  // Resolves to the pass's outcome, which sets the pace of the next one.
  const syncWorkspace = useCallback(async () => {
    if (refreshInFlight.current || syncInFlight.current) return "skipped";
    syncInFlight.current = true;
    try {
      const token = await getToken();
      const activity = await fetchEventActivity(event.code, token);
      const shownEvent = eventRef.current;
      const tasks = [];
      let changed = false;
      if (digestMoved(activity.event, shownEvent, EVENT_DIGEST_KEYS)) {
        tasks.push(
          fetchEvent(event.code, token).then((data) => {
            if (data?.event) setEvent(data.event);
          }),
        );
      } else if (
        activity.event?.resultsRevision != null &&
        activity.event.resultsRevision !== shownEvent.resultsRevision
      ) {
        // Only the result revision advanced (a response arrived); every
        // other event field is unchanged, so no full re-read is needed.
        setEvent({
          ...shownEvent,
          resultsRevision: activity.event.resultsRevision,
        });
        changed = true;
      }
      const shownRoster = rosterRef.current?.activity();
      if (
        shownRoster &&
        digestMoved(activity.roster, shownRoster, ROSTER_DIGEST_KEYS)
      ) {
        tasks.push(rosterRef.current.refresh(token, { silent: true }));
      }
      const shownResults = resultsRef.current?.activity();
      if (
        shownResults &&
        digestMoved(activity.results, shownResults, RESULTS_DIGEST_KEYS)
      ) {
        tasks.push(resultsRef.current.refresh(token, { silent: true }));
      }
      if (tasks.length) {
        const settled = await Promise.allSettled(tasks);
        const failure = settled.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        changed = true;
      }
      setLiveSync((current) =>
        changed
          ? { error: "", updatedAt: Date.now() }
          : current.error
            ? { ...current, error: "" }
            : current,
      );
      return changed ? "changed" : "quiet";
    } catch (requestError) {
      const detail = requestError?.message ? ` (${requestError.message})` : "";
      setLiveSync((current) => ({
        ...current,
        error: `New responses could not be loaded automatically${detail}.`,
      }));
      return "failed";
    } finally {
      syncInFlight.current = false;
    }
  }, [event.code, getToken, setEvent]);

  const syncRef = useRef(syncWorkspace);
  useEffect(() => {
    syncRef.current = syncWorkspace;
  }, [syncWorkspace]);

  // Responses are only collected while the event is active, so that is the
  // only time the digest is polled. A hidden tab skips its turns and catches
  // up the moment it is shown again; the window regaining focus and the
  // network returning check at once too, and working in the page keeps the
  // pace up (so does an edit of the organizer's own, through ``paceRef``).
  const live = event.status === "active";
  useEffect(() => {
    if (!live) return undefined;
    const scheduler = createLiveRefreshScheduler({
      check: () => syncRef.current(),
    });
    paceRef.current = scheduler;
    const wake = () => scheduler.wake();
    const hurry = () => scheduler.hurry();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("pointerdown", hurry, { passive: true });
    document.addEventListener("keydown", hurry, { passive: true });
    scheduler.start();
    return () => {
      scheduler.stop();
      paceRef.current = null;
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("pointerdown", hurry);
      document.removeEventListener("keydown", hurry);
    };
  }, [event.code, live]);

  const handleChoose = useCallback(
    (recommendation) => {
      setSelection(
        selectionFromRecommendation(recommendation, event, {
          now: Date.now(),
        }),
      );
    },
    [event],
  );

  const invalidateResults = useCallback(() => {
    setSelection(null);
    setResultsInvalidationKey((current) => current + 1);
    // The organizer is editing: keep new responses coming in quickly.
    paceRef.current?.hurry();
  }, []);

  const handleEventSaved = useCallback(
    async (result) => {
      if (result?.event) setEvent(result.event);
      invalidateResults();

      if (result?.responsesReset) {
        try {
          const token = await getToken();
          await rosterRef.current?.refresh(token);
        } catch (requestError) {
          setRefreshError(
            requestError.message ||
              "The event was saved, but the roster could not be refreshed.",
          );
        }
      }
    },
    [getToken, invalidateResults, setEvent],
  );

  if (loading || !user) {
    return (
      <div className="page-shell organizer-loading">
        <LoadingState label="Loading…" />
      </div>
    );
  }

  return (
    <main className="page-shell page-shell--wide organizer-workspace">
      <OrganizerHeader
        event={event}
        onRefresh={refreshWorkspace}
        refreshing={refreshing}
        live={live ? liveSync : null}
        controls={
          <EventControls
            event={event}
            setEvent={setEvent}
            getToken={getToken}
            setDeliveryRequest={setDeliveryRequest}
            onReactivated={() => setSelection(null)}
          />
        }
      />

      {(refreshStatus || refreshError) && (
        <Alert
          variant={refreshError ? "danger" : "success"}
          role={null}
          className="organizer-workspace__refresh-feedback mb-4"
        >
          {/* The live-region role stays on the message element itself. */}
          <p className="mb-0" role={refreshError ? "alert" : "status"}>
            {refreshError || refreshStatus}
          </p>
        </Alert>
      )}

      {deliveryRequest && (
        <div className="organizer-workspace__delivery mb-4">
          <DeliveryRequestProgress
            key={deliveryRequest.id || "event-delivery"}
            initialRequest={deliveryRequest}
            getToken={getToken}
            onChange={setDeliveryRequest}
            ariaLabel="Event delivery progress"
            refreshKey={refreshCount}
          />
        </div>
      )}

      <WorkspaceSectionNav />

      <div className="organizer-workspace-sections d-flex flex-column gap-4">
        <section
          id="organizer-overview"
          className="organizer-workspace-section"
          style={SECTION_SCROLL_STYLE}
          aria-labelledby="organizer-overview-heading"
        >
          <OverviewPanel event={event} onEventSaved={handleEventSaved} />
        </section>

        <section
          id="organizer-results"
          className="organizer-workspace-section"
          style={SECTION_SCROLL_STYLE}
          aria-labelledby="organizer-results-heading"
        >
          <ResultsSnapshotPanel
            ref={resultsRef}
            event={event}
            setEvent={setEvent}
            getToken={getToken}
            invalidationKey={resultsInvalidationKey}
            selection={selection}
            headingRef={resultsHeadingRef}
            finalizeHeadingRef={finalizeHeadingRef}
            onDeliveryRequest={setDeliveryRequest}
            onChoose={handleChoose}
            onSelect={setSelection}
          />
        </section>

        <section
          id="organizer-roster"
          className="organizer-workspace-section"
          style={SECTION_SCROLL_STYLE}
          aria-labelledby="organizer-roster-heading"
        >
          <RosterPanel
            ref={rosterRef}
            event={event}
            setEvent={setEvent}
            getToken={getToken}
            onResultsInvalidated={invalidateResults}
            onDeliveryRequestChange={setDeliveryRequest}
          />
        </section>
      </div>
    </main>
  );
}
