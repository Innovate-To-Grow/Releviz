"use client";

import { useCallback, useContext, useEffect, useState } from "react";
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
    return JSON.parse(window.sessionStorage.getItem(deliveryStorageKey(eventCode))) || null;
  } catch {
    window.sessionStorage.removeItem(deliveryStorageKey(eventCode));
    return null;
  }
}

export default function OrganizerScaleView() {
  const { event, setEvent } = useContext(EventContext);
  const { user, loading, getToken } = useAuth();
  const [tab, setTab] = useState("overview");
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
    [event.code]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      const stored = readStoredDeliveryRequest(event.code);
      if (stored) setDeliveryRequestState(stored);
    }, 0);
    return () => clearTimeout(timer);
  }, [event.code]);

  if (loading || !user) {
    return (
      <div
        className="page-pad"
        style={{ minHeight: "calc(100vh - 76px)", display: "grid", placeItems: "center" }}
      >
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <main className="page-pad" style={{ maxWidth: "1400px", margin: "0 auto" }}>
      <OrganizerHeader onRefresh={() => setResultsInvalidationKey((current) => current + 1)} />
      <nav
        role="tablist"
        aria-label="Organizer sections"
        style={{
          borderBottom: "1px solid var(--md-sys-color-surface-variant)",
          display: "flex",
          gap: "4px",
          marginBottom: "24px",
          overflowX: "auto",
        }}
      >
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            style={{
              background: tab === value ? "var(--md-sys-color-secondary-container)" : "transparent",
              border: 0,
              borderBottom:
                tab === value ? "3px solid var(--md-sys-color-primary)" : "3px solid transparent",
              color: "var(--md-sys-color-on-surface)",
              cursor: "pointer",
              font: "inherit",
              fontWeight: tab === value ? 700 : 500,
              padding: "12px 20px",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <div role="tabpanel" aria-label={TABS.find(([value]) => value === tab)?.[1]}>
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
            onResultsInvalidated={() => setResultsInvalidationKey((current) => current + 1)}
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
