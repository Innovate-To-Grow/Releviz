"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import { BrandHomeLink } from "@/components/ui/BrandLogo";
import { useAuth } from "@/components/auth/AuthContext";
import { startTemporaryUpgradeRegistration } from "@/lib/api/auth";
import { fetchTempAccessSession } from "@/lib/api/tempAccess";
import { navigateTo, safeNextPath } from "@/lib/navigation";

const MISSING_UPGRADE_CODE_MESSAGE =
  "This upgrade link is incomplete. Reopen the event from your temporary access link.";

function SignupContent() {
  const emailInputId = useId();
  const emailDescriptionId = `${emailInputId}-description`;
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));
  const upgradeMode = searchParams.get("upgrade") === "temporary";
  const upgradeEventCode = (searchParams.get("code") || "").trim();
  const upgradeSessionKey = upgradeMode ? `temporary:${upgradeEventCode}` : "regular";
  const { signup, verifySignup, loading: authLoading } = useAuth();
  const [step, setStep] = useState("details");
  const [upgradeSession, setUpgradeSession] = useState({
    key: upgradeSessionKey,
    state: upgradeMode ? (upgradeEventCode ? "loading" : "error") : "not-required",
    email: "",
    error: upgradeMode && !upgradeEventCode ? MISSING_UPGRADE_CODE_MESSAGE : "",
  });
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    organization: "",
    title: "",
    email: "",
    password: "",
    passwordConfirm: "",
    code: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const currentUpgradeSession =
    upgradeSession.key === upgradeSessionKey
      ? upgradeSession
      : {
          key: upgradeSessionKey,
          state: upgradeMode ? (upgradeEventCode ? "loading" : "error") : "not-required",
          email: "",
          error: upgradeMode && !upgradeEventCode ? MISSING_UPGRADE_CODE_MESSAGE : "",
        };
  const upgradeSessionState = upgradeMode ? currentUpgradeSession.state : "not-required";
  const upgradeSessionError = upgradeMode ? currentUpgradeSession.error : "";
  const registrationEmail = upgradeMode ? currentUpgradeSession.email : form.email;
  const upgradeReady = !upgradeMode || upgradeSessionState === "ready";

  useEffect(() => {
    if (!upgradeMode || !upgradeEventCode) return;

    let active = true;

    async function loadTemporaryIdentity() {
      try {
        const payload = await fetchTempAccessSession(upgradeEventCode);
        const session =
          payload?.session && typeof payload.session === "object" ? payload.session : payload;
        const email = String(session?.email || "").trim();
        if (!email) throw new Error("Temporary access response is incomplete.");
        if (!active) return;
        setUpgradeSession({
          key: upgradeSessionKey,
          state: "ready",
          email,
          error: "",
        });
      } catch {
        if (!active) return;
        setUpgradeSession({
          key: upgradeSessionKey,
          state: "error",
          email: "",
          error:
            "We could not verify this temporary session. Reopen your event access link and try again.",
        });
      }
    }

    void loadTemporaryIdentity();
    return () => {
      active = false;
    };
  }, [upgradeEventCode, upgradeMode, upgradeSessionKey]);

  const setField = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const submitDetails = async (event) => {
    event.preventDefault();
    if (authLoading) return;
    setError("");
    if (!upgradeReady) {
      setError("Temporary access must be verified before you can create a full account.");
      return;
    }
    if (form.password !== form.passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const registration = {
        password: form.password,
        password_confirm: form.passwordConfirm,
        first_name: form.firstName,
        last_name: form.lastName,
        organization: form.organization,
        title: form.title,
      };
      if (upgradeMode) {
        await startTemporaryUpgradeRegistration(upgradeEventCode, registration);
      } else {
        await signup({ email: form.email, ...registration });
      }
      setStep("code");
    } catch (err) {
      setError(err.message || "Unable to start registration.");
    } finally {
      setLoading(false);
    }
  };

  const submitCode = async (event) => {
    event.preventDefault();
    if (authLoading) return;
    setError("");
    setLoading(true);
    try {
      const verification = {
        email: registrationEmail,
        code: form.code,
        temporaryUpgrade: upgradeMode,
      };
      const data = await verifySignup(verification);
      if (data?.requires_profile_completion || data?.next_step === "complete_profile") {
        navigateTo("/settings?complete_profile=1");
      } else {
        navigateTo(next);
      }
    } catch (err) {
      setError(err.message || "Unable to verify code.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={step === "details" ? submitDetails : submitCode}>
        <BrandHomeLink
          className="auth-brand-link"
          logoClassName="brand-logo brand-logo--auth"
          priority
        />
        <div>
          <h1>Create account</h1>
          <p>
            {step === "details"
              ? "Set up your Releviz account."
              : "Enter the email verification code."}
          </p>
        </div>
        {upgradeMode && upgradeSessionState === "loading" && (
          <div role="status">Checking your temporary event access…</div>
        )}
        {upgradeSessionError && (
          <div className="auth-error" role="alert">
            {upgradeSessionError}
          </div>
        )}
        {error && <div className="auth-error">{error}</div>}
        {step === "details" ? (
          <>
            <div className="auth-grid">
              <label>
                First name
                <input
                  value={form.firstName}
                  onChange={(event) => setField("firstName", event.target.value)}
                  required
                />
              </label>
              <label>
                Last name
                <input
                  value={form.lastName}
                  onChange={(event) => setField("lastName", event.target.value)}
                  required
                />
              </label>
            </div>
            <label>
              Organization <span className="auth-optional">(optional)</span>
              <input
                aria-label="Organization"
                value={form.organization}
                onChange={(event) => setField("organization", event.target.value)}
              />
            </label>
            <label>
              Title
              <input
                value={form.title}
                onChange={(event) => setField("title", event.target.value)}
              />
            </label>
            <div className="field-label">
              <label htmlFor={emailInputId}>Email</label>
              <input
                id={emailInputId}
                value={registrationEmail}
                onChange={(event) => setField("email", event.target.value)}
                type="email"
                readOnly={upgradeMode}
                aria-describedby={upgradeMode ? emailDescriptionId : undefined}
                required
              />
              {upgradeMode && (
                <span id={emailDescriptionId} className="auth-optional">
                  {upgradeSessionState === "ready"
                    ? "This email is fixed so your existing event responses stay connected."
                    : "Your email is loaded from this event's verified temporary session."}
                </span>
              )}
            </div>
            <label>
              Password
              <input
                value={form.password}
                onChange={(event) => setField("password", event.target.value)}
                type="password"
                minLength={8}
                required
              />
            </label>
            <label>
              Confirm password
              <input
                value={form.passwordConfirm}
                onChange={(event) => setField("passwordConfirm", event.target.value)}
                type="password"
                minLength={8}
                required
              />
            </label>
          </>
        ) : (
          <label>
            Verification code
            <input
              value={form.code}
              onChange={(event) => setField("code", event.target.value)}
              inputMode="numeric"
              required
            />
          </label>
        )}
        <AppButton type="submit" fullWidth disabled={loading || authLoading || !upgradeReady}>
          {upgradeSessionState === "loading"
            ? "Checking temporary access…"
            : loading
              ? "Working..."
              : step === "details"
                ? "Send verification code"
                : "Verify and continue"}
        </AppButton>
        <p className="auth-switch">
          Already have an account?{" "}
          <Link href={`/login?next=${encodeURIComponent(next)}`}>Log in</Link>
        </p>
      </form>
    </main>
  );
}

export default function Signup() {
  return (
    <Suspense
      fallback={
        <main className="auth-page">
          <div className="auth-panel">Loading...</div>
        </main>
      }
    >
      <SignupContent />
    </Suspense>
  );
}
