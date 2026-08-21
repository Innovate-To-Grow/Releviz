"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import AppHeader from "@/components/ui/AppHeader";
import Button from "@/components/ui/Button";
import { Badge, Callout, LoadingState } from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/Form";
import Icon from "@/components/ui/Icon";
import { Card, PageHeader } from "@/components/ui/Surface";
import { useAuth } from "@/components/auth/AuthContext";
import { requestAccountDeletionCode } from "@/lib/api/auth";
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
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteCode, setDeleteCode] = useState("");
  const [deleteCodeSent, setDeleteCodeSent] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteAction, setDeleteAction] = useState(false);
  // Disclosure state is owned by React so a background re-render (session list,
  // profile save) can never drop an open panel the user is typing into.
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
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
    setDeleteStatus("");
    setDeleteAction(true);
    try {
      if (!deleteCodeSent) {
        await requestAccountDeletionCode();
        setDeleteCodeSent(true);
        setDeleteStatus(
          "We emailed a confirmation code. Enter it to delete your account.",
        );
        setDeleteAction(false);
        return;
      }
      await deleteAccount({ code: deleteCode });
    } catch (err) {
      setDeleteError(err.message || "Unable to delete your account.");
      setDeleteAction(false);
    }
  };

  if (!completionResolved || loading || !user) {
    return (
      <>
        <AppHeader pageTitle="Account settings" />
        <main id="main" className="rv-page rv-page--form rv-page--centered">
          <LoadingState message="Loading..." />
        </main>
      </>
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
        <main id="main" className="rv-page rv-page--form rv-page--centered">
          <section
            aria-labelledby="profile-onboarding-heading"
            className="rv-auth"
          >
            <div className="rv-stack rv-stack--sm">
              <p className="rv-eyebrow">One last step</p>
              <h1 className="rv-auth__title" id="profile-onboarding-heading">
                Complete your profile
              </h1>
              <p className="rv-auth__lede">
                Add your name so people can recognize your response in the
                schedule.
              </p>
            </div>

            <form onSubmit={handleSave} className="rv-stack rv-stack--md">
              {error && (
                <Callout tone="danger" role="alert">
                  {error}
                </Callout>
              )}

              <Field label="Email address">
                <TextInput value={user.email} type="email" readOnly />
              </Field>

              <div className="rv-grid rv-grid--pair">
                <Field label="First name">
                  <TextInput
                    value={current.firstName}
                    onChange={(event) =>
                      setField("firstName", event.target.value)
                    }
                    autoComplete="given-name"
                    autoFocus
                    required
                  />
                </Field>
                <Field label="Last name">
                  <TextInput
                    value={current.lastName}
                    onChange={(event) =>
                      setField("lastName", event.target.value)
                    }
                    autoComplete="family-name"
                    required
                  />
                </Field>
              </div>

              <Button type="submit" variant="primary" size="lg" block>
                {continueToEvent ? "Continue to event" : "Continue"}
              </Button>
            </form>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader pageTitle="Account settings" />
      <main id="main" className="rv-page">
        <div className="rv-stack rv-stack--lg">
          <PageHeader
            eyebrow="Your account"
            eyebrowIcon="settings"
            title="Account settings"
            description="Manage your profile, signed-in devices, and account security."
          />

          <div className="rv-columns rv-columns--rail-first">
            <aside className="rv-stack rv-stack--md rv-sticky-rail">
              <Card compact className="rv-card--muted">
                <div className="rv-cluster">
                  <span className="rv-avatar rv-avatar--lg" aria-hidden="true">
                    {initials}
                  </span>
                  <div className="rv-stack rv-stack--xs rv-fill">
                    <span className="rv-eyebrow">Signed in as</span>
                    <strong className="rv-break-anywhere">{displayName}</strong>
                    <span className="rv-field__hint rv-break-anywhere">
                      {user.email}
                    </span>
                  </div>
                </div>
                <div className="rv-stack rv-stack--xs">
                  <span className="rv-deflist__label">Account ID</span>
                  <code className="rv-break-anywhere">{user.id}</code>
                </div>
              </Card>

              <nav aria-label="Settings sections">
                <ul className="rv-sidenav">
                  {[
                    ["#profile", "Profile", "users"],
                    ["#sessions", "Active sessions", "shield"],
                    ["#password", "Password", "lock"],
                    ["#danger-zone", "Danger zone", "alertTriangle"],
                  ].map(([href, label, icon]) => (
                    <li key={href}>
                      <a className="rv-sidenav__link" href={href}>
                        <Icon name={icon} className="rv-menu__icon" />
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </aside>

            <div className="rv-stack rv-stack--lg">
              <Card as="form" id="profile" onSubmit={handleSave}>
                <div className="rv-cluster rv-cluster--top">
                  <span className="rv-step-chip" aria-hidden="true">
                    01
                  </span>
                  <div className="rv-stack rv-stack--xs rv-fill">
                    <h2 className="rv-section-header__title">Profile</h2>
                    <p className="rv-section-header__description">
                      Update the name shown across your scheduling workspace.
                    </p>
                  </div>
                </div>

                {error && (
                  <Callout tone="danger" role="alert">
                    {error}
                  </Callout>
                )}
                <div className="rv-grid rv-grid--pair">
                  <Field label="First name">
                    <TextInput
                      value={current.firstName}
                      onChange={(event) =>
                        setField("firstName", event.target.value)
                      }
                      autoComplete="given-name"
                      required
                    />
                  </Field>
                  <Field label="Last name">
                    <TextInput
                      value={current.lastName}
                      onChange={(event) =>
                        setField("lastName", event.target.value)
                      }
                      autoComplete="family-name"
                      required
                    />
                  </Field>
                </div>
                <div className="rv-btn-row rv-btn-row--end">
                  {saved && (
                    <Badge tone="success" icon="checkCircle" role="status">
                      Saved
                    </Badge>
                  )}
                  <Button type="submit" variant="primary">
                    Save profile
                  </Button>
                </div>
              </Card>

              <Card
                as="section"
                id="sessions"
                aria-labelledby="active-sessions-heading"
              >
                <div className="rv-cluster rv-cluster--top">
                  <span className="rv-step-chip" aria-hidden="true">
                    02
                  </span>
                  <div className="rv-stack rv-stack--xs rv-fill">
                    <h2
                      className="rv-section-header__title"
                      id="active-sessions-heading"
                    >
                      Active sessions
                    </h2>
                    <p className="rv-section-header__description">
                      Revoke devices you no longer recognize. Access is
                      invalidated immediately.
                    </p>
                  </div>
                </div>

                {sessionError && (
                  <Callout tone="danger" role="alert">
                    {sessionError}
                  </Callout>
                )}
                {sessionsLoading ? (
                  <LoadingState inline message="Loading active sessions..." />
                ) : sessions.length ? (
                  <ul className="rv-session-list">
                    {sessions.map((session) => (
                      <li key={session.id} className="rv-session">
                        <div className="rv-stack rv-stack--xs rv-fill">
                          <div className="rv-cluster rv-cluster--sm">
                            <strong>
                              {session.current ? "This device" : "Other device"}
                            </strong>
                            {session.current && (
                              <Badge tone="accent">Current</Badge>
                            )}
                          </div>
                          <span>
                            {describeSessionDevice(session.userAgent)}
                          </span>
                          <small className="rv-field__hint">
                            Last active{" "}
                            {new Date(session.lastSeenAt).toLocaleString()}
                            {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                          </small>
                        </div>
                        <Button
                          size="sm"
                          variant="dangerOutline"
                          disabled={Boolean(sessionAction)}
                          busy={sessionAction === session.id}
                          onClick={() => handleRevokeSession(session)}
                        >
                          {sessionAction === session.id
                            ? "Revoking..."
                            : session.current
                              ? "Sign out this device"
                              : "Revoke"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rv-field__hint">
                    No active sessions were found.
                  </p>
                )}
                <div className="rv-btn-row rv-btn-row--end">
                  <Button
                    variant="secondary"
                    icon="logOut"
                    disabled={Boolean(sessionAction)}
                    busy={sessionAction === "all"}
                    onClick={handleLogoutAll}
                  >
                    {sessionAction === "all"
                      ? "Signing out..."
                      : "Sign out all devices"}
                  </Button>
                </div>
              </Card>

              <form id="password" onSubmit={handleChangePassword}>
                <details
                  className="rv-disclosure"
                  open={passwordOpen}
                  onToggle={(event) =>
                    setPasswordOpen(event.currentTarget.open)
                  }
                >
                  <summary className="rv-disclosure__summary">
                    <span className="rv-step-chip" aria-hidden="true">
                      03
                    </span>
                    <span className="rv-disclosure__summary-text">
                      <h2 className="rv-disclosure__title">Change password</h2>
                      <span className="rv-disclosure__hint">
                        Changing your password signs out every device, including
                        this one.
                      </span>
                    </span>
                    <Icon
                      name="chevronDown"
                      className="rv-disclosure__chevron"
                    />
                  </summary>
                  <div className="rv-disclosure__content rv-stack rv-stack--md">
                    {passwordError && (
                      <Callout tone="danger" role="alert">
                        {passwordError}
                      </Callout>
                    )}
                    <div className="rv-grid rv-grid--pair">
                      <Field label="Current password">
                        <TextInput
                          value={currentPassword}
                          onChange={(event) =>
                            setCurrentPassword(event.target.value)
                          }
                          type="password"
                          autoComplete="current-password"
                          required
                        />
                      </Field>
                      <Field
                        label="New password"
                        hint="Use at least 8 characters."
                      >
                        <TextInput
                          value={newPassword}
                          onChange={(event) =>
                            setNewPassword(event.target.value)
                          }
                          type="password"
                          autoComplete="new-password"
                          minLength={8}
                          required
                        />
                      </Field>
                      <Field label="Confirm new password">
                        <TextInput
                          value={newPasswordConfirm}
                          onChange={(event) =>
                            setNewPasswordConfirm(event.target.value)
                          }
                          type="password"
                          autoComplete="new-password"
                          minLength={8}
                          required
                        />
                      </Field>
                    </div>
                    <div className="rv-btn-row rv-btn-row--end">
                      <Button
                        type="submit"
                        variant="primary"
                        busy={passwordAction}
                        disabled={passwordAction}
                      >
                        {passwordAction ? "Changing..." : "Change password"}
                      </Button>
                    </div>
                  </div>
                </details>
              </form>

              <form id="danger-zone" onSubmit={handleDeleteAccount}>
                <details
                  className="rv-disclosure rv-disclosure--danger"
                  open={dangerOpen}
                  onToggle={(event) => setDangerOpen(event.currentTarget.open)}
                >
                  <summary className="rv-disclosure__summary">
                    <span className="rv-step-chip" aria-hidden="true">
                      04
                    </span>
                    <span className="rv-disclosure__summary-text">
                      <h2 className="rv-disclosure__title">Delete account</h2>
                      <span className="rv-disclosure__hint">
                        Permanently remove your sign-in details and profile.
                        This cannot be undone.
                      </span>
                    </span>
                    <Icon
                      name="chevronDown"
                      className="rv-disclosure__chevron"
                    />
                  </summary>
                  <div className="rv-disclosure__content rv-stack rv-stack--md">
                    <Callout tone="danger">
                      Every session will be revoked and your identity will be
                      anonymized in retained scheduling records.
                    </Callout>
                    {deleteError && (
                      <Callout tone="danger" role="alert">
                        {deleteError}
                      </Callout>
                    )}
                    {deleteStatus && (
                      <Callout tone="info" role="status" aria-live="polite">
                        {deleteStatus}
                      </Callout>
                    )}
                    <div className="rv-grid rv-grid--pair">
                      {deleteCodeSent && (
                        <Field label="Confirmation code">
                          <TextInput
                            className="rv-input--code"
                            value={deleteCode}
                            onChange={(event) =>
                              setDeleteCode(event.target.value)
                            }
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            required
                          />
                        </Field>
                      )}
                      <Field label="Type DELETE to confirm">
                        <TextInput
                          value={deleteConfirmation}
                          onChange={(event) =>
                            setDeleteConfirmation(event.target.value)
                          }
                          autoComplete="off"
                          spellCheck="false"
                          required
                        />
                      </Field>
                    </div>
                    <div className="rv-btn-row rv-btn-row--end">
                      <Button
                        type="submit"
                        variant="danger"
                        busy={deleteAction}
                        disabled={
                          deleteAction ||
                          deleteConfirmation !== "DELETE" ||
                          (deleteCodeSent && deleteCode.length !== 6)
                        }
                      >
                        {deleteAction
                          ? deleteCodeSent
                            ? "Deleting..."
                            : "Sending code..."
                          : deleteCodeSent
                            ? "Delete account permanently"
                            : "Email a confirmation code"}
                      </Button>
                    </div>
                  </div>
                </details>
              </form>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

export { completionDestination, isEventDestination };
