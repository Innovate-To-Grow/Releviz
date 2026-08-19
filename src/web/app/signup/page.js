"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useState } from "react";
import ContinueWithEmailPage from "@/components/auth/ContinueWithEmailPage";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { useAuth } from "@/components/auth/AuthContext";
import { startTemporaryUpgradeRegistration } from "@/lib/api/auth";
import { fetchTempAccessSession } from "@/lib/api/tempAccess";
import { navigateTo, safeNextPath } from "@/lib/navigation";

const MISSING_UPGRADE_CODE_MESSAGE =
  "This upgrade link is incomplete. Reopen the event from your temporary access link.";

function TemporaryUpgradeSignupContent({ searchParams, next }) {
  const emailInputId = useId();
  const emailDescriptionId = `${emailInputId}-description`;
  const upgradeMode = true;
  const upgradeEventCode = (searchParams.get("code") || "").trim();
  const upgradeSessionKey = upgradeMode
    ? `temporary:${upgradeEventCode}`
    : "regular";
  const { verifySignup, loading: authLoading } = useAuth();
  const [step, setStep] = useState("details");
  const [upgradeSession, setUpgradeSession] = useState({
    key: upgradeSessionKey,
    state: upgradeMode
      ? upgradeEventCode
        ? "loading"
        : "error"
      : "not-required",
    email: "",
    error: upgradeMode && !upgradeEventCode ? MISSING_UPGRADE_CODE_MESSAGE : "",
  });
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
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
          state: upgradeMode
            ? upgradeEventCode
              ? "loading"
              : "error"
            : "not-required",
          email: "",
          error:
            upgradeMode && !upgradeEventCode
              ? MISSING_UPGRADE_CODE_MESSAGE
              : "",
        };
  const upgradeSessionState = upgradeMode
    ? currentUpgradeSession.state
    : "not-required";
  const upgradeSessionError = upgradeMode ? currentUpgradeSession.error : "";
  const registrationEmail = upgradeMode
    ? currentUpgradeSession.email
    : form.email;
  const upgradeReady = !upgradeMode || upgradeSessionState === "ready";

  useEffect(() => {
    if (!upgradeMode || !upgradeEventCode) return;

    let active = true;

    async function loadTemporaryIdentity() {
      try {
        const payload = await fetchTempAccessSession(upgradeEventCode);
        const session =
          payload?.session && typeof payload.session === "object"
            ? payload.session
            : payload;
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

  const setField = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));

  const submitDetails = async (event) => {
    event.preventDefault();
    if (authLoading) return;
    setError("");
    if (!upgradeReady) {
      setError(
        "Temporary access must be verified before you can create a full account.",
      );
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
      };
      await startTemporaryUpgradeRegistration(upgradeEventCode, registration);
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
      if (
        data?.requires_profile_completion ||
        data?.next_step === "complete_profile"
      ) {
        navigateTo(
          `/settings?complete_profile=1&next=${encodeURIComponent(next)}`,
        );
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
    <main>
      <form onSubmit={step === "details" ? submitDetails : submitCode}>
        <div>
          <h1>Upgrade your account</h1>
          <p>
            {step === "details"
              ? "Set up your Releviz account."
              : "Enter the email verification code."}
          </p>
        </div>
        {upgradeMode && upgradeSessionState === "loading" && (
          <div role="status">Checking your temporary event access…</div>
        )}
        {upgradeSessionError && <div role="alert">{upgradeSessionError}</div>}
        {error && <div>{error}</div>}
        {step === "details" ? (
          <>
            <>
              <label>
                First name
                <input
                  value={form.firstName}
                  onChange={(event) =>
                    setField("firstName", event.target.value)
                  }
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
            </>
            <>
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
                <span id={emailDescriptionId}>
                  {upgradeSessionState === "ready"
                    ? "This email is fixed so your existing event responses stay connected."
                    : "Your email is loaded from this event's verified temporary session."}
                </span>
              )}
            </>
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
                onChange={(event) =>
                  setField("passwordConfirm", event.target.value)
                }
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
        <AppButton
          type="submit"
          disabled={loading || authLoading || !upgradeReady}
        >
          {upgradeSessionState === "loading"
            ? "Checking temporary access…"
            : loading
              ? "Working..."
              : step === "details"
                ? "Send verification code"
                : "Verify and continue"}
        </AppButton>
        <p>
          Prefer email verification?{" "}
          <Link href={`/login?next=${encodeURIComponent(next)}`}>
            Continue with email
          </Link>
        </p>
      </form>
    </main>
  );
}

function SignupContent() {
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));

  if (searchParams.get("upgrade") !== "temporary") {
    return <ContinueWithEmailPage next={next} />;
  }

  return (
    <>
      <AppHeader />
      <TemporaryUpgradeSignupContent searchParams={searchParams} next={next} />
    </>
  );
}

export default function Signup() {
  return (
    <Suspense
      fallback={
        <>
          <AppHeader />
          <main>Loading...</main>
        </>
      }
    >
      <SignupContent />
    </Suspense>
  );
}
