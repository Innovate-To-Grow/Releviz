"use client";

import { useEffect, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { useAuth } from "@/components/auth/AuthContext";
import { navigateTo } from "@/lib/navigation";

export default function SettingsPage() {
  const {
    user,
    loading,
    updateProfile,
    listSessions,
    revokeSession,
    logoutAll,
    changePassword,
    deleteAccount,
  } = useAuth();
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [sessionAction, setSessionAction] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordAction, setPasswordAction] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteAction, setDeleteAction] = useState(false);
  const securityActionInProgress = Boolean(sessionAction) || passwordAction || deleteAction;

  useEffect(() => {
    if (!loading && !user && !securityActionInProgress) {
      navigateTo("/login?next=/settings");
    }
  }, [loading, securityActionInProgress, user]);

  useEffect(() => {
    let cancelled = false;
    if (loading || !user) return () => {};
    listSessions()
      .then((items) => {
        if (!cancelled) setSessions(items);
      })
      .catch((err) => {
        if (!cancelled) setSessionError(err.message || "Unable to load active sessions.");
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listSessions, loading, user]);

  const current = draft || {
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
    organization: user?.organization || "",
    title: user?.title || "",
  };

  const setField = (field, value) => {
    setDraft((existing) => ({ ...(existing || current), [field]: value }));
  };

  const handleSave = async (event) => {
    event.preventDefault();
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

  const handleRevokeSession = async (session) => {
    setSessionError("");
    setSessionAction(session.id);
    try {
      const result = await revokeSession(session.id);
      if (result.currentRevoked) {
        navigateTo("/login?next=/settings");
        return;
      }
      setSessions((items) => items.filter((item) => item.id !== session.id));
    } catch (err) {
      setSessionError(err.message || "Unable to revoke this session.");
    } finally {
      setSessionAction("");
    }
  };

  const handleLogoutAll = async () => {
    setSessionError("");
    setSessionAction("all");
    try {
      await logoutAll();
    } catch (err) {
      setSessionError(err.message || "Unable to sign out all devices.");
      setSessionAction("");
    }
  };

  const handleChangePassword = async (event) => {
    event.preventDefault();
    setPasswordError("");
    if (newPassword !== newPasswordConfirm) {
      setPasswordError("New passwords do not match.");
      return;
    }
    setPasswordAction(true);
    try {
      await changePassword({
        currentPassword,
        newPassword,
        newPasswordConfirm,
      });
    } catch (err) {
      setPasswordError(err.message || "Unable to change your password.");
      setPasswordAction(false);
    }
  };

  const handleDeleteAccount = async (event) => {
    event.preventDefault();
    setDeleteError("");
    setDeleteAction(true);
    try {
      await deleteAccount({
        password: deletePassword,
        confirmation: deleteConfirmation,
      });
    } catch (err) {
      setDeleteError(err.message || "Unable to delete your account.");
      setDeleteAction(false);
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
    <>
      <AppHeader pageTitle="Account settings" />
      <main className="page-pad settings-shell">
        <div className="md-card settings-panel">
          <div>
            <h1>Account settings</h1>
            <p className="settings-muted">{user.email}</p>
          </div>
          <form className="settings-section" onSubmit={handleSave}>
            <h2>Profile</h2>
            {error && (
              <div className="auth-error" role="alert">
                {error}
              </div>
            )}
            <div className="auth-grid">
              <label className="field-label">
                First name
                <input
                  value={current.firstName}
                  onChange={(event) => setField("firstName", event.target.value)}
                  autoComplete="given-name"
                />
              </label>
              <label className="field-label">
                Last name
                <input
                  value={current.lastName}
                  onChange={(event) => setField("lastName", event.target.value)}
                  autoComplete="family-name"
                />
              </label>
            </div>
            <label className="field-label">
              Organization
              <input
                value={current.organization}
                onChange={(event) => setField("organization", event.target.value)}
                autoComplete="organization"
              />
            </label>
            <label className="field-label">
              Title
              <input
                value={current.title}
                onChange={(event) => setField("title", event.target.value)}
                autoComplete="organization-title"
              />
            </label>
            <p className="field-help">User ID: {user.id}</p>
            <div className="settings-actions">
              {saved && (
                <span className="settings-saved" role="status" aria-live="polite">
                  Saved
                </span>
              )}
              <AppButton type="submit">Save profile</AppButton>
            </div>
          </form>

          <section className="settings-section" aria-labelledby="active-sessions-heading">
            <h2 id="active-sessions-heading">Active sessions</h2>
            <p className="settings-muted">
              Revoke devices you no longer recognize. Access is invalidated immediately.
            </p>
            {sessionError && (
              <div className="auth-error" role="alert">
                {sessionError}
              </div>
            )}
            {sessionsLoading ? (
              <p>Loading active sessions...</p>
            ) : sessions.length ? (
              <ul className="session-list">
                {sessions.map((session) => (
                  <li key={session.id} className="session-card">
                    <div className="session-description">
                      <strong>{session.current ? "This device" : "Other device"}</strong>
                      <div>{session.userAgent || "Unknown browser"}</div>
                      <small>
                        Last active {new Date(session.lastSeenAt).toLocaleString()}
                        {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                      </small>
                    </div>
                    <AppButton
                      variant="outlined"
                      disabled={Boolean(sessionAction)}
                      onClick={() => handleRevokeSession(session)}
                    >
                      {sessionAction === session.id
                        ? "Revoking..."
                        : session.current
                          ? "Sign out this device"
                          : "Revoke"}
                    </AppButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No active sessions were found.</p>
            )}
            <div className="settings-actions">
              <AppButton
                variant="outlined"
                disabled={Boolean(sessionAction)}
                onClick={handleLogoutAll}
              >
                {sessionAction === "all" ? "Signing out..." : "Sign out all devices"}
              </AppButton>
            </div>
          </section>

          <form className="settings-section" onSubmit={handleChangePassword}>
            <h2>Change password</h2>
            <p className="settings-muted">
              Changing your password signs out every device, including this one.
            </p>
            {passwordError && (
              <div className="auth-error" role="alert">
                {passwordError}
              </div>
            )}
            <label className="field-label">
              Current password
              <input
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label className="field-label">
              New password
              <input
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                minLength={8}
                aria-describedby="settings-password-help"
                required
              />
            </label>
            <p id="settings-password-help" className="field-help">
              Use at least 8 characters.
            </p>
            <label className="field-label">
              Confirm new password
              <input
                value={newPasswordConfirm}
                onChange={(event) => setNewPasswordConfirm(event.target.value)}
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <div className="settings-actions">
              <AppButton type="submit" disabled={passwordAction}>
                {passwordAction ? "Changing..." : "Change password"}
              </AppButton>
            </div>
          </form>

          <form className="settings-section settings-danger-zone" onSubmit={handleDeleteAccount}>
            <h2>Delete account</h2>
            <p>
              This permanently removes your sign-in details and profile, revokes every session, and
              anonymizes your identity in retained scheduling records. This cannot be undone.
            </p>
            {deleteError && (
              <div className="auth-error" role="alert">
                {deleteError}
              </div>
            )}
            <label className="field-label">
              Current password
              <input
                value={deletePassword}
                onChange={(event) => setDeletePassword(event.target.value)}
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label className="field-label">
              Type DELETE to confirm
              <input
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck="false"
                required
              />
            </label>
            <div className="settings-actions">
              <AppButton
                type="submit"
                variant="outlined"
                className="app-btn-danger"
                disabled={deleteAction || !deletePassword || deleteConfirmation !== "DELETE"}
              >
                {deleteAction ? "Deleting..." : "Delete account permanently"}
              </AppButton>
            </div>
          </form>
        </div>
      </main>
    </>
  );
}
