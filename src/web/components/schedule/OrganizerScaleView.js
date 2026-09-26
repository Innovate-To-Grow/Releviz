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
import {
  fetchEvent,
  fetchEventActivity,
  openEventStream,
} from "@/lib/api/events";
import {
  LIVE_REFRESH_ACTIVE_PACE,
  LIVE_REFRESH_BACKSTOP_PACE,
  LIVE_REFRESH_IDLE_PACE,
  attachLiveRefreshTriggers,
  createLiveRefreshScheduler,
} from "@/lib/liveRefresh";
import { connectLiveStream } from "@/lib/liveStream";
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

// Live sync: while this tab is visible, the workspace holds one event stream
// open and the server pushes a note whenever something about the event was
// written (see lib/liveStream). Each note runs a pass that reads a small
// activity digest and silently re-reads only the sections whose digest
// moved, so new responses, invitation opens, and edits from another session
// appear on their own, without touching what the organizer is doing (a pick,
// a row draft, an open drawer). There is nothing to press and nothing to
// switch off. The same pass also runs on a timer as the fallback: once a
// minute as a backstop while the stream is up, and on an adaptive pace (see
// lib/liveRefresh) while it is down or the server does not offer it: quick
// while things change or the organizer is active, easing off while the
// workspace is quiet, and slower still while the event is not collecting
// responses, when the only thing left to notice is a lifecycle change made
// in another session.
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
  const [workspaceError, setWorkspaceError] = useState("");
  const [liveSync, setLiveSync] = useState({ error: "", updatedAt: null });
  // Whether this tab is visible, read once and then followed through the
  // visibilitychange event; the event stream is only held while it is.
  const [documentVisible, setDocumentVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState === "visible",
  );
  // Whether the server is pushing changes right now, and how many times it
  // has told the workspace to look again (each change, and each time the
  // stream opens, since something may have changed while it was down),
  // which the delivery card reads on rather than polling.
  const [streamConnected, setStreamConnected] = useState(false);
  const [liveVersion, setLiveVersion] = useState(0);
  const syncInFlight = useRef(false);
  // Whether a pass was asked for while one was already running, so that
  // what it was asked for is read once the running one is done.
  const syncRerun = useRef(false);
  // The live-sync scheduler, so the organizer's own actions can keep its
  // pace up.
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

  useEffect(() => {
    eventRef.current = event;
  }, [event]);

  // One live-sync pass: compare the server's digest with what each section
  // shows and re-read only what moved. A pass still running is never
  // doubled; it is followed by one more instead, so a change pushed while it
  // ran is not lost. Resolves to the pass's outcome, which sets the pace of
  // the next one.
  const syncWorkspace = useCallback(async () => {
    if (syncInFlight.current) {
      syncRerun.current = true;
      return "skipped";
    }
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
      // A pass asked for while this one ran (by a pushed frame, or by a newer
      // scheduler while this pass of the one it replaced was still going) is
      // run by whichever scheduler is current now, since the one that ran
      // this pass may have been stopped meanwhile.
      if (syncRerun.current) {
        syncRerun.current = false;
        paceRef.current?.wake();
      }
    }
  }, [event.code, getToken, setEvent]);

  const syncRef = useRef(syncWorkspace);
  useEffect(() => {
    syncRef.current = syncWorkspace;
  }, [syncWorkspace]);

  // Asks for a pass on the server's behalf. While a pass is in flight the
  // request waits for its end, which wakes whichever scheduler is current
  // by then. Waking the scheduler at once would only mark it to follow up,
  // and the stream opening or dropping swaps it for one at the other pace,
  // which wipes that mark and would lose the pass.
  const requestPass = useCallback(() => {
    if (syncInFlight.current) syncRerun.current = true;
    else paceRef.current?.wake();
  }, []);

  useEffect(() => {
    const updateVisibility = () =>
      setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", updateVisibility);
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  // The push side: one event stream while the tab is visible. The server's
  // ready frame runs a catch-up pass for whatever changed between mount (or
  // a drop) and now, and each changed frame runs a pass; both count up for
  // the delivery card, so a mounted card reads once when the stream opens
  // too. A drop, or a server that declines the stream, hands the pace back
  // to polling until the stream is up again. A hidden tab holds no stream
  // (the poll scheduler skips its turns too); showing it opens a fresh one.
  // The catch-up pass runs on the scheduler in place before the pace flips,
  // or right after the pass in flight when there is one, and the backstop
  // scheduler that replaces it only starts its timer, so the pass is never
  // doubled.
  useEffect(() => {
    if (!documentVisible) return undefined;
    const stream = connectLiveStream({
      open: (signal) => openEventStream(event.code, { signal }),
      onOpen: () => {
        setStreamConnected(true);
        setLiveVersion((version) => version + 1);
        requestPass();
      },
      onChange: () => {
        setLiveVersion((version) => version + 1);
        requestPass();
      },
      onDown: () => setStreamConnected(false),
      onUnavailable: () => setStreamConnected(false),
    });
    return () => {
      stream.close();
      setStreamConnected(false);
    };
  }, [event.code, documentVisible, requestPass]);

  // The poll side, in every lifecycle state. While the stream is up it is
  // only a backstop, a check a minute. Otherwise, while the event is active
  // the digest is polled at the live pace, since a response can arrive at
  // any moment, and at the idle pace when it is not, since only a lifecycle
  // change made in another session (a reactivation, say) is left to notice.
  // A hidden tab skips its turns and catches up the moment it is shown
  // again; the window regaining focus and the network returning check at
  // once too (cheap catch-ups while a stream is still backing off), and
  // working in the page keeps the pace up (so does an edit of the
  // organizer's own, through ``paceRef``). A paused notice left by a failed
  // pass at one pace clears with the first clean pass at the other.
  const active = event.status === "active";
  useEffect(() => {
    const scheduler = createLiveRefreshScheduler({
      check: () => syncRef.current(),
      pace: streamConnected
        ? LIVE_REFRESH_BACKSTOP_PACE
        : active
          ? LIVE_REFRESH_ACTIVE_PACE
          : LIVE_REFRESH_IDLE_PACE,
    });
    paceRef.current = scheduler;
    const detach = attachLiveRefreshTriggers(scheduler);
    scheduler.start();
    return () => {
      detach();
      scheduler.stop();
      paceRef.current = null;
    };
  }, [event.code, active, streamConnected]);

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
          setWorkspaceError(
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
        live={active ? liveSync : null}
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

      {workspaceError && (
        <Alert
          variant="danger"
          role={null}
          className="organizer-workspace__feedback mb-4"
        >
          {/* The live-region role stays on the message element itself. */}
          <p className="mb-0" role="alert">
            {workspaceError}
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
            pushed={streamConnected}
            liveVersion={liveVersion}
            ariaLabel="Event delivery progress"
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
            pushed={streamConnected}
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
