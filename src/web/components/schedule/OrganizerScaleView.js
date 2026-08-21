"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import EventContext from "@/components/event/EventContext";
import { OrganizerHeader } from "@/components/schedule/OrganizerPanels";
import {
  DeliveryRequestProgress,
  EventControls,
  FinalizeScalePanel,
  OverviewPanel,
  ResultsSnapshotPanel,
} from "@/components/schedule/OrganizerScalePanels";
import RosterPanel from "@/components/schedule/RosterPanel";
import { Callout, LoadingState } from "@/components/ui/Feedback";
import { fetchEvent } from "@/lib/api/events";

const SECTION_IDS = ["overview", "roster", "results", "finalize"];

const WORKSPACE_SECTIONS = [
  { id: "overview", label: "Overview", hint: "Event details" },
  { id: "roster", label: "Roster", hint: "People and groups" },
  { id: "results", label: "Results", hint: "Best times" },
  { id: "finalize", label: "Finalize", hint: "Confirm and invite" },
];

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

function selectedRecommendationKey(recommendation) {
  if (!recommendation) return null;
  return (
    recommendation.id ||
    [
      recommendation.suggestedStartsAt || recommendation.startsAt,
      recommendation.suggestedEndsAt || recommendation.endsAt,
      recommendation.channel,
    ].join("-")
  );
}

function focusSection(sectionId, headingRef) {
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(sectionId)?.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start",
  });
  headingRef.current?.focus({ preventScroll: true });
}

export default function OrganizerScaleView() {
  const { event, setEvent } = useContext(EventContext);
  const { user, loading, getToken } = useAuth();
  const [deliveryRequest, setDeliveryRequestState] = useState(null);
  const [selectedRecommendation, setSelectedRecommendation] = useState(null);
  const [resultsInvalidationKey, setResultsInvalidationKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const refreshInFlight = useRef(false);
  const rosterRef = useRef(null);
  const resultsRef = useRef(null);
  const resultsHeadingRef = useRef(null);
  const finalizeHeadingRef = useRef(null);

  const setDeliveryRequest = useCallback(
    (value) => {
      setDeliveryRequestState((current) => {
        const next = typeof value === "function" ? value(current) : value;
        if (typeof window !== "undefined") {
          const key = deliveryStorageKey(event.code);
          if (next) window.sessionStorage.setItem(key, JSON.stringify(next));
          else window.sessionStorage.removeItem(key);
        }
        return next;
      });
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

  useEffect(() => {
    if (!selectedRecommendation) return;
    focusSection("organizer-finalize", finalizeHeadingRef);
  }, [selectedRecommendation]);

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

  const refreshWorkspace = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setRefreshStatus("");
    setRefreshError("");
    setSelectedRecommendation(null);

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

  const invalidateResults = useCallback(() => {
    setSelectedRecommendation(null);
    setResultsInvalidationKey((current) => current + 1);
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
      <main id="main" className="rv-page rv-page--centered">
        <LoadingState message="Loading…" />
      </main>
    );
  }

  return (
    <main id="main" className="rv-page rv-page--wide">
      <OrganizerHeader
        event={event}
        onRefresh={refreshWorkspace}
        refreshing={refreshing}
        controls={
          <EventControls
            event={event}
            setEvent={setEvent}
            getToken={getToken}
            setDeliveryRequest={setDeliveryRequest}
          />
        }
      />

      <nav aria-label="Organizer sections" className="rv-worknav">
        <ul className="rv-worknav__list">
          {WORKSPACE_SECTIONS.map((section, index) => (
            <li key={section.id}>
              <a className="rv-worknav__link" href={`#organizer-${section.id}`}>
                <span className="rv-worknav__step" aria-hidden="true">
                  {index + 1}
                </span>
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {(refreshStatus || refreshError) && (
        <Callout
          tone={refreshError ? "danger" : "success"}
          role={refreshError ? "alert" : "status"}
          className="rv-section-gap"
        >
          {refreshError || refreshStatus}
        </Callout>
      )}

      {deliveryRequest && (
        <DeliveryRequestProgress
          key={deliveryRequest.id || "event-delivery"}
          initialRequest={deliveryRequest}
          getToken={getToken}
          onChange={setDeliveryRequest}
          ariaLabel="Event delivery progress"
        />
      )}

      <section
        id="organizer-overview"
        aria-labelledby="organizer-overview-heading"
        className="rv-worksection"
      >
        <OverviewPanel event={event} onEventSaved={handleEventSaved} />
      </section>

      <section
        id="organizer-roster"
        aria-labelledby="organizer-roster-heading"
        className="rv-worksection"
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

      <section
        id="organizer-results"
        aria-labelledby="organizer-results-heading"
        className="rv-worksection"
      >
        <ResultsSnapshotPanel
          ref={resultsRef}
          event={event}
          getToken={getToken}
          invalidationKey={resultsInvalidationKey}
          selectedRecommendationKey={selectedRecommendationKey(
            selectedRecommendation,
          )}
          headingRef={resultsHeadingRef}
          onChoose={(recommendation) => {
            setSelectedRecommendation(recommendation);
          }}
        />
      </section>

      <section
        id="organizer-finalize"
        aria-labelledby="organizer-finalize-heading"
        className="rv-worksection"
      >
        <FinalizeScalePanel
          event={event}
          setEvent={setEvent}
          getToken={getToken}
          recommendation={selectedRecommendation}
          headingRef={finalizeHeadingRef}
          onBrowseResults={() =>
            focusSection("organizer-results", resultsHeadingRef)
          }
        />
      </section>
    </main>
  );
}
