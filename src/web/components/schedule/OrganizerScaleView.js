"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/components/auth/AuthContext";
import EventContext from "@/components/event/EventContext";
import { OrganizerHeader } from "@/components/schedule/OrganizerPanels";
import {
  FinalizeScalePanel,
  OverviewPanel,
  ResultsSnapshotPanel,
} from "@/components/schedule/OrganizerScalePanels";
import RosterPanel from "@/components/schedule/RosterPanel";

const TABS = [
  ["overview", "Overview"],
  ["roster", "Roster"],
  ["results", "Results"],
  ["finalize", "Finalize"],
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

export default function OrganizerScaleView() {
  const { event, setEvent } = useContext(EventContext);
  const { user, loading, getToken } = useAuth();
  const [tab, setTab] = useState("overview");
  const tabGroupId = useId().replace(/:/g, "");
  const tabRefs = useRef([]);
  const [deliveryRequest, setDeliveryRequestState] = useState(null);
  const [launchParticipantIds, setLaunchParticipantIds] = useState([]);
  const [launchSelectionMode, setLaunchSelectionMode] = useState("all");
  const [selectedRecommendation, setSelectedRecommendation] = useState(null);
  const [resultsInvalidationKey, setResultsInvalidationKey] = useState(0);

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

  const activateTab = useCallback((index) => {
    const nextIndex = (index + TABS.length) % TABS.length;
    setTab(TABS[nextIndex][0]);
    tabRefs.current[nextIndex]?.focus();
  }, []);

  const handleTabKeyDown = useCallback(
    (keyboardEvent, index) => {
      switch (keyboardEvent.key) {
        case "ArrowRight":
        case "ArrowDown":
          keyboardEvent.preventDefault();
          activateTab(index + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          keyboardEvent.preventDefault();
          activateTab(index - 1);
          break;
        case "Home":
          keyboardEvent.preventDefault();
          activateTab(0);
          break;
        case "End":
          keyboardEvent.preventDefault();
          activateTab(TABS.length - 1);
          break;
        default:
          break;
      }
    },
    [activateTab],
  );

  if (loading || !user) {
    return (
      <div className="page-pad organizer-loading">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <main className="page-pad organizer-workspace">
      <OrganizerHeader
        event={event}
        onRefresh={() => setResultsInvalidationKey((current) => current + 1)}
      />
      <nav
        className="organizer-tabs"
        role="tablist"
        aria-label="Organizer sections"
      >
        {TABS.map(([value, label], index) => (
          <button
            key={value}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            id={`${tabGroupId}-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`${tabGroupId}-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(keyboardEvent) =>
              handleTabKeyDown(keyboardEvent, index)
            }
          >
            {label}
          </button>
        ))}
      </nav>

      <div
        className="organizer-tab-panel"
        id={`${tabGroupId}-panel-${tab}`}
        role="tabpanel"
        aria-label={TABS.find(([value]) => value === tab)?.[1]}
        aria-labelledby={`${tabGroupId}-tab-${tab}`}
        tabIndex={0}
      >
        {tab === "overview" && (
          <OverviewPanel
            event={event}
            setEvent={setEvent}
            getToken={getToken}
            deliveryRequest={deliveryRequest}
            setDeliveryRequest={setDeliveryRequest}
            launchParticipantIds={launchParticipantIds}
            launchSelectionMode={launchSelectionMode}
            setLaunchSelectionMode={setLaunchSelectionMode}
          />
        )}
        {tab === "roster" && (
          <RosterPanel
            event={event}
            setEvent={setEvent}
            getToken={getToken}
            onResultsInvalidated={() =>
              setResultsInvalidationKey((current) => current + 1)
            }
            initialSelectedParticipantIds={launchParticipantIds}
            onSelectionChange={setLaunchParticipantIds}
            onRosterRebuilt={() => setLaunchSelectionMode("all")}
            deliveryRequest={deliveryRequest}
            onDeliveryRequestChange={setDeliveryRequest}
          />
        )}
        {tab === "results" && (
          <ResultsSnapshotPanel
            event={event}
            getToken={getToken}
            invalidationKey={resultsInvalidationKey}
            onChoose={(recommendation) => {
              setSelectedRecommendation(recommendation);
              setTab("finalize");
            }}
          />
        )}
        {tab === "finalize" && (
          <FinalizeScalePanel
            key={
              selectedRecommendation?.id ||
              selectedRecommendation?.suggestedStartsAt ||
              selectedRecommendation?.startsAt ||
              "no-recommendation"
            }
            event={event}
            setEvent={setEvent}
            getToken={getToken}
            recommendation={selectedRecommendation}
            onBrowseResults={() => setTab("results")}
          />
        )}
      </div>
    </main>
  );
}
