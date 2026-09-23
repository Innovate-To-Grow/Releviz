"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import EmptyState from "@/components/ui/EmptyState";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import PageHeader from "@/components/ui/PageHeader";
import Panel from "@/components/ui/Panel";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  DeleteIcon,
  LockIcon,
  SaveIcon,
  SecurityIcon,
  SendIcon,
  SignOutIcon,
  SuccessIcon,
} from "@/components/ui/icons";
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

// In-page sections listed in the sidebar navigation. The link whose target is
// the current URL fragment is highlighted (Profile by default), mirroring the
// previous `:target`-based CSS.
const SETTINGS_SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "sessions", label: "Active sessions" },
  { id: "password", label: "Password" },
  { id: "danger-zone", label: "Danger zone" },
];

function subscribeToHash(callback) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function locationHash() {
  return window.location.hash;
}

function serverLocationHash() {
  return "";
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

// Numbered heading block shared by every settings section. Inside a
// <summary> the copy is muted by `.disclosure__summary-copy p`, so the
// description only needs the secondary color when it stands alone.
function SectionIntro({
  index,
  title,
  titleId,
  titleClassName = "",
  inSummary = false,
  children,
}) {
  return (
    <div
      className={
        inSummary
          ? "disclosure__summary-copy d-flex align-items-start gap-3"
          : "d-flex align-items-start gap-3 mb-3"
      }
    >
      <span className="section-index" aria-hidden="true">
        {index}
      </span>
      <div className="min-w-0">
        <h2 id={titleId} className={`h4 mb-1 ${titleClassName}`.trim()}>
          {title}
        </h2>
        <p className={inSummary ? "mb-0" : "text-secondary mb-0"}>{children}</p>
      </div>
    </div>
  );
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
  const search = useSyncExternalStore(
    subscribeToLocation,
    locationSearch,
    serverLocationSearch,
  );
  const hash = useSyncExternalStore(
    subscribeToHash,
    locationHash,
    serverLocationHash,
  );
  const completionResolved = search !== null;
  const completionQuery = new URLSearchParams(search || "");
  const completionActive = completionQuery.get("complete_profile") === "1";
  const completionNext = safeNextPath(completionQuery.get("next"));
  const activeSection = SETTINGS_SECTIONS.some(
    (section) => `#${section.id}` === hash,
  )
    ? hash.slice(1)
    : SETTINGS_SECTIONS[0].id;
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
    return <LoadingState label="Loading..." page />;
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
            <header>
              <span className="eyebrow">One last step</span>
              <h1 id="profile-onboarding-heading">Complete your profile</h1>
              <p>
                Add your name so people can recognize your response in the
                schedule.
              </p>
            </header>

            <form className="d-flex flex-column gap-3" onSubmit={handleSave}>
              {error && <Alert variant="danger">{error}</Alert>}

              <FormField label="Email address">
                <input
                  className="form-control bg-body-tertiary"
                  value={user.email}
                  type="email"
                  autoComplete="email"
                  readOnly
                />
              </FormField>

              <div className="form-row-2">
                <FormField label="First name">
                  <input
                    className="form-control"
                    value={current.firstName}
                    onChange={(event) =>
                      setField("firstName", event.target.value)
                    }
                    autoComplete="given-name"
                    autoFocus
                    required
                  />
                </FormField>
                <FormField label="Last name">
                  <input
                    className="form-control"
                    value={current.lastName}
                    onChange={(event) =>
                      setField("lastName", event.target.value)
                    }
                    autoComplete="family-name"
                    required
                  />
                </FormField>
              </div>

              <AppButton type="submit" fullWidth icon={<ArrowRightIcon />}>
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
      <main className="page-shell settings-shell">
        <div className="row g-4">
          <aside className="col-lg-3">
            <div className="sticky-lg-top" style={{ top: "1.5rem", zIndex: 1 }}>
              <div className="card panel">
                <div className="card-body d-flex align-items-center gap-3">
                  <span
                    className="rounded-circle bg-primary-subtle text-primary-emphasis fw-semibold d-inline-flex align-items-center justify-content-center flex-shrink-0"
                    style={{ width: "3rem", height: "3rem" }}
                    aria-hidden="true"
                  >
                    {initials}
                  </span>
                  <div className="min-w-0">
                    <span className="eyebrow mb-0">Signed in as</span>
                    <strong className="d-block text-truncate">
                      {displayName}
                    </strong>
                    <span className="d-block small text-secondary text-truncate">
                      {user.email}
                    </span>
                  </div>
                </div>
                <div className="card-body border-top">
                  <nav
                    aria-label="Settings sections"
                    className="nav nav-pills flex-lg-column gap-1"
                  >
                    {SETTINGS_SECTIONS.map((section) => {
                      const isActive = section.id === activeSection;
                      return (
                        <a
                          key={section.id}
                          className={`nav-link${isActive ? " active" : ""}`}
                          aria-current={isActive ? "location" : undefined}
                          href={`#${section.id}`}
                        >
                          {section.label}
                        </a>
                      );
                    })}
                  </nav>
                </div>
                <div className="card-footer small text-secondary">
                  <span className="d-block">Account ID</span>
                  <code className="text-body wrap-anywhere">{user.id}</code>
                </div>
              </div>
            </div>
          </aside>

          <div className="col-lg-9">
            <PageHeader
              eyebrow="Your account"
              title="Account settings"
              lede="Manage your profile, signed-in devices, and account security."
            />

            <div className="d-flex flex-column gap-4">
              <Panel
                as="form"
                id="profile"
                className="settings-section"
                onSubmit={handleSave}
              >
                <SectionIntro index="01" title="Profile">
                  Update the name shown across your scheduling workspace.
                </SectionIntro>
                <div className="d-flex flex-column gap-3">
                  {error && <Alert variant="danger">{error}</Alert>}
                  <div className="form-row-2">
                    <FormField label="First name">
                      <input
                        className="form-control"
                        value={current.firstName}
                        onChange={(event) =>
                          setField("firstName", event.target.value)
                        }
                        autoComplete="given-name"
                        required
                      />
                    </FormField>
                    <FormField label="Last name">
                      <input
                        className="form-control"
                        value={current.lastName}
                        onChange={(event) =>
                          setField("lastName", event.target.value)
                        }
                        autoComplete="family-name"
                        required
                      />
                    </FormField>
                  </div>
                  <div className="d-flex flex-wrap align-items-center justify-content-end gap-3">
                    {saved && (
                      <span
                        className="d-inline-flex align-items-center gap-1 small text-success-emphasis"
                        role="status"
                        aria-live="polite"
                      >
                        <SuccessIcon aria-hidden="true" />
                        Saved
                      </span>
                    )}
                    <AppButton type="submit" icon={<SaveIcon />}>
                      Save profile
                    </AppButton>
                  </div>
                </div>
              </Panel>

              <Panel
                id="sessions"
                className="settings-section"
                aria-labelledby="active-sessions-heading"
              >
                <SectionIntro
                  index="02"
                  title="Active sessions"
                  titleId="active-sessions-heading"
                >
                  Revoke devices you no longer recognize. Access is invalidated
                  immediately.
                </SectionIntro>
                <div className="d-flex flex-column gap-3">
                  {sessionError && (
                    <Alert variant="danger">{sessionError}</Alert>
                  )}
                  {sessionsLoading ? (
                    <LoadingState label="Loading active sessions..." />
                  ) : sessions.length ? (
                    <ul className="list-group">
                      {sessions.map((session) => (
                        <li
                          key={session.id}
                          className="list-group-item d-flex flex-wrap align-items-center justify-content-between gap-3"
                        >
                          <div className="min-w-0">
                            <div className="d-flex flex-wrap align-items-center gap-2">
                              <strong>
                                {session.current
                                  ? "This device"
                                  : "Other device"}
                              </strong>
                              {session.current && (
                                <StatusBadge status="success">
                                  Current
                                </StatusBadge>
                              )}
                            </div>
                            <div>
                              {describeSessionDevice(session.userAgent)}
                            </div>
                            <small className="text-secondary">
                              Last active{" "}
                              {new Date(session.lastSeenAt).toLocaleString()}
                              {session.ipAddress
                                ? ` · ${session.ipAddress}`
                                : ""}
                            </small>
                          </div>
                          <AppButton
                            variant="outlined"
                            icon={<SignOutIcon />}
                            busy={sessionAction === session.id}
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
                    <EmptyState icon={<SecurityIcon />}>
                      No active sessions were found.
                    </EmptyState>
                  )}
                  <div className="d-flex flex-wrap gap-2">
                    <AppButton
                      variant="outlined"
                      icon={<SignOutIcon />}
                      busy={sessionAction === "all"}
                      disabled={Boolean(sessionAction)}
                      onClick={handleLogoutAll}
                    >
                      {sessionAction === "all"
                        ? "Signing out..."
                        : "Sign out all devices"}
                    </AppButton>
                  </div>
                </div>
              </Panel>

              <form
                id="password"
                className="settings-disclosure"
                onSubmit={handleChangePassword}
              >
                <details className="disclosure">
                  <summary>
                    <SectionIntro index="03" title="Change password" inSummary>
                      Changing your password signs out every device, including
                      this one.
                    </SectionIntro>
                    <span className="disclosure__chevron" aria-hidden="true">
                      <ChevronDownIcon />
                    </span>
                  </summary>
                  <div className="disclosure__content d-flex flex-column gap-3">
                    {passwordError && (
                      <Alert variant="danger">{passwordError}</Alert>
                    )}
                    <FormField label="Current password">
                      <input
                        className="form-control"
                        value={currentPassword}
                        onChange={(event) =>
                          setCurrentPassword(event.target.value)
                        }
                        type="password"
                        autoComplete="current-password"
                        required
                      />
                    </FormField>
                    <FormField
                      id="settings-password"
                      label="New password"
                      help="Use at least 8 characters."
                    >
                      <input
                        className="form-control"
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </FormField>
                    <FormField label="Confirm new password">
                      <input
                        className="form-control"
                        value={newPasswordConfirm}
                        onChange={(event) =>
                          setNewPasswordConfirm(event.target.value)
                        }
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </FormField>
                    <div className="d-flex flex-wrap justify-content-end gap-2">
                      <AppButton
                        type="submit"
                        icon={<LockIcon />}
                        busy={passwordAction}
                        disabled={passwordAction}
                      >
                        {passwordAction ? "Changing..." : "Change password"}
                      </AppButton>
                    </div>
                  </div>
                </details>
              </form>

              <form
                id="danger-zone"
                className="settings-disclosure settings-danger-zone"
                onSubmit={handleDeleteAccount}
              >
                <details className="disclosure border-danger-subtle">
                  <summary>
                    <SectionIntro
                      index="04"
                      title="Delete account"
                      titleClassName="text-danger-emphasis"
                      inSummary
                    >
                      Permanently remove your sign-in details and profile. This
                      cannot be undone.
                    </SectionIntro>
                    <span className="disclosure__chevron" aria-hidden="true">
                      <ChevronDownIcon />
                    </span>
                  </summary>
                  <div className="disclosure__content d-flex flex-column gap-3">
                    <Alert variant="warning" role="note">
                      Every session will be revoked and your identity will be
                      anonymized in retained scheduling records.
                    </Alert>
                    {deleteError && (
                      <Alert variant="danger">{deleteError}</Alert>
                    )}
                    {deleteStatus && (
                      <Alert variant="info">{deleteStatus}</Alert>
                    )}
                    {deleteCodeSent && (
                      <FormField label="Confirmation code">
                        <input
                          className="form-control"
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
                      </FormField>
                    )}
                    <FormField label="Type DELETE to confirm">
                      <input
                        className="form-control"
                        value={deleteConfirmation}
                        onChange={(event) =>
                          setDeleteConfirmation(event.target.value)
                        }
                        autoComplete="off"
                        spellCheck="false"
                        required
                      />
                    </FormField>
                    <div className="d-flex flex-wrap justify-content-end gap-2">
                      <AppButton
                        type="submit"
                        variant="danger"
                        className="app-btn-danger"
                        icon={deleteCodeSent ? <DeleteIcon /> : <SendIcon />}
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
                      </AppButton>
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
