"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { MdSave } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import { updateSettings } from "@/lib/api/auth";
import "@material/web/textfield/outlined-text-field.js";

function SettingsPage() {
  const router = useRouter();
  const { user, loading: authLoading, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    if (!initialized) {
      setDisplayName(user.displayName || "");
      setInitialized(true);
    }
  }, [user, authLoading, initialized, router]);

  if (authLoading || !user || !initialized) {
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

  const handleSave = async () => {
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const payload = {};
      if (displayName.trim() !== user.displayName) {
        payload.displayName = displayName.trim();
      }
      if (newPassword) {
        payload.currentPassword = currentPassword;
        payload.newPassword = newPassword;
      }
      if (Object.keys(payload).length === 0) {
        setSuccess("No changes to save");
        setSaving(false);
        return;
      }
      await updateSettings(payload);
      await refreshUser();
      setCurrentPassword("");
      setNewPassword("");
      setSuccess("Settings saved");
    } catch (err) {
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <div
        className="md-card"
        style={{
          maxWidth: "420px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <h1 style={{ color: "var(--md-sys-color-primary)", margin: 0, fontSize: "1.8rem" }}>
          Settings
        </h1>

        <md-outlined-text-field
          label="Display Name"
          value={displayName}
          onInput={(e) => setDisplayName(e.target.value)}
          maxLength="100"
          style={{ width: "100%" }}
        ></md-outlined-text-field>

        <hr
          style={{ border: "none", borderTop: "1px solid var(--md-sys-color-outline)", margin: 0 }}
        />

        <p
          style={{
            margin: 0,
            fontSize: "0.9rem",
            color: "var(--md-sys-color-on-surface-variant)",
          }}
        >
          Change password (optional)
        </p>

        <md-outlined-text-field
          label="Current Password"
          type="password"
          value={currentPassword}
          onInput={(e) => setCurrentPassword(e.target.value)}
          style={{ width: "100%" }}
        ></md-outlined-text-field>

        <md-outlined-text-field
          label="New Password"
          type="password"
          value={newPassword}
          onInput={(e) => setNewPassword(e.target.value)}
          style={{ width: "100%" }}
        ></md-outlined-text-field>

        {error && (
          <p style={{ color: "var(--md-sys-color-error)", margin: 0, fontSize: "0.9rem" }}>
            {error}
          </p>
        )}
        {success && (
          <p style={{ color: "var(--md-sys-color-primary)", margin: 0, fontSize: "0.9rem" }}>
            {success}
          </p>
        )}

        <AppButton onClick={handleSave} disabled={saving} fullWidth icon={<MdSave />}>
          {saving ? "Saving..." : "Save Changes"}
        </AppButton>
      </div>
    </div>
  );
}

export default SettingsPage;
