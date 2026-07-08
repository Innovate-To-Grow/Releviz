"use client";

import { useEffect, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";

export default function SettingsPage() {
  const { user, loading, updateProfile } = useAuth();
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && !user) {
      window.location.assign("/login?next=/settings");
    }
  }, [loading, user]);

  const current = draft || {
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
    organization: user?.organization || "",
    title: user?.title || "",
  };

  const setField = (field, value) => {
    setDraft((existing) => ({ ...(existing || current), [field]: value }));
  };

  const handleSave = async () => {
    setError("");
    try {
      await updateProfile({
        first_name: current.firstName,
        last_name: current.lastName,
        organization: current.organization,
        title: current.title,
      });
      setDraft(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message || "Unable to save profile.");
    }
  };

  if (loading || !user) {
    return (
      <div className="center-page">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div
      className="page-pad"
      style={{ minHeight: "100vh", display: "flex", justifyContent: "center", paddingTop: "32px" }}
    >
      <div
        className="md-card"
        style={{
          maxWidth: "560px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "18px",
        }}
      >
        <div>
          <h1 style={{ color: "var(--md-sys-color-primary)", margin: "0 0 6px 0" }}>
            Account Settings
          </h1>
          <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>{user.email}</p>
        </div>
        {error && <div className="auth-error">{error}</div>}
        <div className="auth-grid">
          <label className="field-label">
            First name
            <input
              value={current.firstName}
              onChange={(event) => setField("firstName", event.target.value)}
            />
          </label>
          <label className="field-label">
            Last name
            <input
              value={current.lastName}
              onChange={(event) => setField("lastName", event.target.value)}
            />
          </label>
        </div>
        <label className="field-label">
          Organization
          <input
            value={current.organization}
            onChange={(event) => setField("organization", event.target.value)}
          />
        </label>
        <label className="field-label">
          Title
          <input
            value={current.title}
            onChange={(event) => setField("title", event.target.value)}
          />
        </label>
        <p
          style={{
            margin: 0,
            fontSize: "0.85rem",
            color: "var(--md-sys-color-on-surface-variant)",
          }}
        >
          User ID: {user.id}
        </p>
        <div
          style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px" }}
        >
          {saved && (
            <span style={{ color: "var(--md-sys-color-primary)", fontSize: "0.9rem" }}>Saved</span>
          )}
          <AppButton onClick={handleSave}>Save</AppButton>
        </div>
      </div>
    </div>
  );
}
