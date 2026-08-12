"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { useAuth } from "@/components/auth/AuthContext";
import { navigateTo, safeNextPath } from "@/lib/navigation";

function completionDestination(value) {
  const destination = safeNextPath(value);
  const url = new URL(destination, "https://releviz.invalid");
  if (url.pathname === "/event" && url.searchParams.get("code")?.trim()) {
    url.searchParams.set("respond", "1");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function isEventDestination(value) {
  const destination = safeNextPath(value);
  const url = new URL(destination, "https://releviz.invalid");
  return (
    url.pathname === "/event" && Boolean(url.searchParams.get("code")?.trim())
  );
}

function subscribeToLocation(callback) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function locationSearch() {
  return window.location.search;
}

function serverLocationSearch() {
  return null;
}

function describeSessionDevice(userAgent) {
  const value = (userAgent || "").trim();
  if (!value) return "Unknown browser";

  const browser = value.match(/Edg\//)
    ? "Edge"
    : value.match(/(?:Chrome|CriOS)\//)
      ? "Chrome"
      : value.match(/Firefox\//)
        ? "Firefox"
        : value.match(/Safari\//)
          ? "Safari"
          : "";
  const platform = value.match(/iPhone|iPad/)
    ? "iOS"
    : value.match(/Android/)
      ? "Android"
      : value.match(/Mac OS X/)
        ? "macOS"
        : value.match(/Windows/)
          ? "Windows"
          : value.match(/Linux/)
            ? "Linux"
            : "";

  if (browser && platform) return `${browser} on ${platform}`;
  return value.length > 80 ? "Browser session" : value;
}

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
  const search = useSyncExternalStore(
    subscribeToLocation,
    locationSearch,
    serverLocationSearch,
  );
  const completionResolved = search !== null;
  const completionQuery = new URLSearchParams(search || "");
  const completionActive = completionQuery.get("complete_profile") === "1";
  const completionNext = safeNextPath(completionQuery.get("next"));
  const securityActionInProgress =
    Boolean(sessionAction) || passwordAction || deleteAction;

  useEffect(() => {
    if (completionResolved && !loading && !user && !securityActionInProgress) {
      const settingsDestination = completionActive
        ? `/settings?complete_profile=1&next=${encodeURIComponent(completionNext)}`
        : "/settings";
      navigateTo(
        completionActive
          ? `/login?next=${encodeURIComponent(settingsDestination)}`
          : "/login?next=/settings",
      );
    }
  }, [
    completionActive,
    completionNext,
    completionResolved,
    loading,
    securityActionInProgress,
    user,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!completionResolved || completionActive || loading || !user) {
      return () => {};
    }
    listSessions()
      .then((items) => {
        if (!cancelled) setSessions(items);
      })
      .catch((err) => {
        if (!cancelled)
          setSessionError(err.message || "Unable to load active sessions.");
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [completionActive, completionResolved, listSessions, loading, user]);

  const current = draft || {
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
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
      });
      setDraft(null);
      setSaved(true);
      if (completionActive) {
        navigateTo(completionDestination(completionNext));
        return;
      }
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

  if (!completionResolved || loading || !user) {
    return (
      <div className="center-page">
        <p>Loading...</p>
      </div>
    );
  }

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
  const initials =
    [user.firstName, user.lastName]
      .filter(Boolean)
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase() || user.email.charAt(0).toUpperCase();

  if (completionActive) {
    const continueToEvent = isEventDestination(completionNext);
    return (
      <>
        <AppHeader pageTitle="Complete your profile" />
        <main className="auth-page auth-page-with-header profile-onboarding-page">
          <section
            className="auth-panel profile-onboarding-panel"
            aria-labelledby="profile-onboarding-heading"
          >
            <header className="profile-onboarding-heading">
              <span className="settings-eyebrow">One last step</span>
              <h1 id="profile-onboarding-heading">Complete your profile</h1>
              <p>
                Add your name so people can recognize your response in the
                schedule.
              </p>
            </header>

            <form className="profile-onboarding-form" onSubmit={handleSave}>
              {error && (
                <div className="auth-error" role="alert">
                  {error}
                </div>
              )}

              <label className="field-label profile-onboarding-email">
                Email address
                <input value={user.email} type="email" readOnly />
              </label>

              <div className="auth-grid">
                <label className="field-label">
                  First name
                  <input
                    value={current.firstName}
                    onChange={(event) =>
                      setField("firstName", event.target.value)
                    }
                    autoComplete="given-name"
                    autoFocus
                    required
                  />
                </label>
                <label className="field-label">
                  Last name
                  <input
                    value={current.lastName}
                    onChange={(event) =>
                      setField("lastName", event.target.value)
                    }
                    autoComplete="family-name"
                    required
                  />
                </label>
              </div>

              <AppButton type="submit" fullWidth>
                {continueToEvent ? "Continue to event" : "Continue"}
              </AppButton>
            </form>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader pageTitle="Account settings" />
      <main className="page-pad settings-shell">
        <div className="settings-panel">
          <aside className="settings-sidebar">
            <div className="settings-account-summary">
              <span className="settings-avatar" aria-hidden="true">
                {initials}
              </span>
              <div>
                <span className="settings-eyebrow">Signed in as</span>
                <strong>{displayName}</strong>
                <span className="settings-sidebar-email">{user.email}</span>
              </div>
            </div>
            <nav className="settings-nav" aria-label="Settings sections">
              <a href="#profile">Profile</a>
              <a href="#sessions">Active sessions</a>
              <a href="#password">Password</a>
              <a href="#danger-zone">Danger zone</a>
            </nav>
            <div className="settings-account-id">
              <span>Account ID</span>
              <code>{user.id}</code>
            </div>
          </aside>

          <div className="settings-content">
            <header className="settings-heading">
              <div>
                <span className="settings-eyebrow">Your account</span>
                <h1>Account settings</h1>
              </div>
              <p>
                Manage your profile, signed-in devices, and account security.
              </p>
            </header>

            <form
              id="profile"
              className="settings-section"
              onSubmit={handleSave}
            >
              <div className="settings-section-copy">
                <span className="settings-section-index">01</span>
                <h2>Profile</h2>
                <p className="settings-muted">
                  Update the name shown across your scheduling workspace.
                </p>
              </div>
              <div className="settings-section-body">
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
                      onChange={(event) =>
                        setField("firstName", event.target.value)
                      }
                      autoComplete="given-name"
                      required
                    />
                  </label>
                  <label className="field-label">
                    Last name
                    <input
                      value={current.lastName}
                      onChange={(event) =>
                        setField("lastName", event.target.value)
                      }
                      autoComplete="family-name"
                      required
                    />
                  </label>
                </div>
                <div className="settings-actions">
                  {saved && (
                    <span
                      className="settings-saved"
                      role="status"
                      aria-live="polite"
                    >
                      Saved
                    </span>
                  )}
                  <AppButton type="submit">Save profile</AppButton>
                </div>
              </div>
            </form>

            <section
              id="sessions"
              className="settings-section"
              aria-labelledby="active-sessions-heading"
            >
              <div className="settings-section-copy">
                <span className="settings-section-index">02</span>
                <h2 id="active-sessions-heading">Active sessions</h2>
                <p className="settings-muted">
                  Revoke devices you no longer recognize. Access is invalidated
                  immediately.
                </p>
              </div>
              <div className="settings-section-body">
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
                      <li
                        key={session.id}
                        className={`session-card${session.current ? " session-card-current" : ""}`}
                      >
                        <div className="session-description">
                          <div className="session-title">
                            <strong>
                              {session.current ? "This device" : "Other device"}
                            </strong>
                            {session.current && (
                              <span className="session-current-badge">
                                Current
                              </span>
                            )}
                          </div>
                          <div>{describeSessionDevice(session.userAgent)}</div>
                          <small>
                            Last active{" "}
                            {new Date(session.lastSeenAt).toLocaleString()}
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
                    {sessionAction === "all"
                      ? "Signing out..."
                      : "Sign out all devices"}
                  </AppButton>
                </div>
              </div>
            </section>

            <form
              id="password"
              className="settings-disclosure"
              onSubmit={handleChangePassword}
            >
              <details>
                <summary className="settings-disclosure-summary">
                  <div className="settings-section-copy">
                    <span className="settings-section-index">03</span>
                    <h2>Change password</h2>
                    <p className="settings-muted">
                      Changing your password signs out every device, including
                      this one.
                    </p>
                  </div>
                  <span className="settings-disclosure-toggle">
                    <span className="settings-disclosure-label-closed">
                      Show
                    </span>
                    <span className="settings-disclosure-label-open">Hide</span>
                    <span
                      className="settings-disclosure-chevron"
                      aria-hidden="true"
                    />
                  </span>
                </summary>
                <div className="settings-disclosure-content">
                  <div className="settings-section-body">
                    {passwordError && (
                      <div className="auth-error" role="alert">
                        {passwordError}
                      </div>
                    )}
                    <div className="settings-fields-grid settings-password-fields">
                      <label className="field-label">
                        Current password
                        <input
                          value={currentPassword}
                          onChange={(event) =>
                            setCurrentPassword(event.target.value)
                          }
                          type="password"
                          autoComplete="current-password"
                          required
                        />
                      </label>
                      <label className="field-label">
                        New password
                        <input
                          value={newPassword}
                          onChange={(event) =>
                            setNewPassword(event.target.value)
                          }
                          type="password"
                          autoComplete="new-password"
                          minLength={8}
                          aria-describedby="settings-password-help"
                          required
                        />
                      </label>
                      <label className="field-label">
                        Confirm new password
                        <input
                          value={newPasswordConfirm}
                          onChange={(event) =>
                            setNewPasswordConfirm(event.target.value)
                          }
                          type="password"
                          autoComplete="new-password"
                          minLength={8}
                          required
                        />
                      </label>
                    </div>
                    <p id="settings-password-help" className="field-help">
                      Use at least 8 characters.
                    </p>
                    <div className="settings-actions">
                      <AppButton type="submit" disabled={passwordAction}>
                        {passwordAction ? "Changing..." : "Change password"}
                      </AppButton>
                    </div>
                  </div>
                </div>
              </details>
            </form>

            <form
              id="danger-zone"
              className="settings-disclosure settings-danger-zone"
              onSubmit={handleDeleteAccount}
            >
              <details>
                <summary className="settings-disclosure-summary">
                  <div className="settings-section-copy">
                    <span className="settings-section-index">04</span>
                    <h2>Delete account</h2>
                    <p>
                      Permanently remove your sign-in details and profile. This
                      cannot be undone.
                    </p>
                  </div>
                  <span className="settings-disclosure-toggle">
                    <span className="settings-disclosure-label-closed">
                      Show
                    </span>
                    <span className="settings-disclosure-label-open">Hide</span>
                    <span
                      className="settings-disclosure-chevron"
                      aria-hidden="true"
                    />
                  </span>
                </summary>
                <div className="settings-disclosure-content">
                  <div className="settings-section-body">
                    <p className="settings-danger-note">
                      Every session will be revoked and your identity will be
                      anonymized in retained scheduling records.
                    </p>
                    {deleteError && (
                      <div className="auth-error" role="alert">
                        {deleteError}
                      </div>
                    )}
                    <div className="settings-fields-grid">
                      <label className="field-label">
                        Current password
                        <input
                          value={deletePassword}
                          onChange={(event) =>
                            setDeletePassword(event.target.value)
                          }
                          type="password"
                          autoComplete="current-password"
                          required
                        />
                      </label>
                      <label className="field-label">
                        Type DELETE to confirm
                        <input
                          value={deleteConfirmation}
                          onChange={(event) =>
                            setDeleteConfirmation(event.target.value)
                          }
                          autoComplete="off"
                          spellCheck="false"
                          required
                        />
                      </label>
                    </div>
                    <div className="settings-actions">
                      <AppButton
                        type="submit"
                        variant="outlined"
                        className="app-btn-danger"
                        disabled={
                          deleteAction ||
                          !deletePassword ||
                          deleteConfirmation !== "DELETE"
                        }
                      >
                        {deleteAction
                          ? "Deleting..."
                          : "Delete account permanently"}
                      </AppButton>
                    </div>
                  </div>
                </div>
              </details>
            </form>
          </div>
        </div>
      </main>
    </>
  );
}

export { completionDestination, isEventDestination };
