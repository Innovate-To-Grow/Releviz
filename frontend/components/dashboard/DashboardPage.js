"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MdAdd, MdSearch } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchDashboardEvents } from "@/lib/api/dashboard";
import { formatMode } from "@/lib/format";
import "@material/web/textfield/outlined-text-field.js";

function EventCard({ event }) {
  return (
    <Link href={`/event?code=${event.code}`} style={{ textDecoration: "none", color: "inherit" }}>
      <div
        style={{
          padding: "16px",
          border: "1px solid var(--md-sys-color-surface-variant)",
          borderRadius: "12px",
          background: "var(--md-sys-color-surface-container-low)",
          cursor: "pointer",
          transition: "box-shadow 0.15s",
        }}
      >
        <h4 style={{ margin: "0 0 8px 0", color: "var(--md-sys-color-on-surface)" }}>
          {event.name}
        </h4>
        <div
          style={{
            display: "flex",
            gap: "12px",
            fontSize: "0.85rem",
            color: "var(--md-sys-color-on-surface-variant)",
            flexWrap: "wrap",
          }}
        >
          <span>{formatMode(event.mode)}</span>
          <span>Code: {event.code}</span>
          {event.location && event.location !== "TBD" && <span>{event.location}</span>}
        </div>
      </div>
    </Link>
  );
}

function DashboardPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [organized, setOrganized] = useState([]);
  const [participating, setParticipating] = useState([]);
  const [loading, setLoading] = useState(true);
  const [eventCode, setEventCode] = useState("");

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    fetchDashboardEvents()
      .then((data) => {
        setOrganized(data.organized || []);
        setParticipating(data.participating || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user, authLoading, router]);

  if (authLoading || loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <p style={{ color: "var(--md-sys-color-on-surface-variant)" }}>Loading...</p>
      </div>
    );
  }

  const handleGoToEvent = () => {
    const code = eventCode.trim();
    if (code) router.push(`/event?code=${code}`);
  };

  return (
    <div className="page-pad" style={{ maxWidth: "800px", margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "32px",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <h1 style={{ color: "var(--md-sys-color-primary)", margin: 0, fontSize: "1.8rem" }}>
          My Dashboard
        </h1>
        <Link href="/">
          <AppButton icon={<MdAdd />}>Create New Event</AppButton>
        </Link>
      </div>

      <div
        className="md-card"
        style={{ marginBottom: "24px", display: "flex", gap: "12px", alignItems: "flex-end" }}
      >
        <md-outlined-text-field
          label="Enter Event Code"
          value={eventCode}
          onInput={(e) => setEventCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleGoToEvent()}
          style={{ flex: 1 }}
        ></md-outlined-text-field>
        <AppButton onClick={handleGoToEvent} variant="outlined" icon={<MdSearch />}>
          Go
        </AppButton>
      </div>

      <div className="md-card" style={{ marginBottom: "24px" }}>
        <h3 style={{ margin: "0 0 16px 0", color: "var(--md-sys-color-on-surface)" }}>
          My Events ({organized.length})
        </h3>
        {organized.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {organized.map((e) => (
              <EventCard key={e.code} event={e} />
            ))}
          </div>
        ) : (
          <p style={{ color: "var(--md-sys-color-outline)", margin: 0, fontStyle: "italic" }}>
            No events organized yet.
          </p>
        )}
      </div>

      <div className="md-card">
        <h3 style={{ margin: "0 0 16px 0", color: "var(--md-sys-color-on-surface)" }}>
          Events I Participate In ({participating.length})
        </h3>
        {participating.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {participating.map((e) => (
              <EventCard key={e.code} event={e} />
            ))}
          </div>
        ) : (
          <p style={{ color: "var(--md-sys-color-outline)", margin: 0, fontStyle: "italic" }}>
            Not participating in any events yet.
          </p>
        )}
      </div>
    </div>
  );
}

export default DashboardPage;
