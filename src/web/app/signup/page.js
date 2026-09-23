"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import ContinueWithEmailPage from "@/components/auth/ContinueWithEmailPage";
import { useAuth } from "@/components/auth/AuthContext";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import { ArrowRightIcon, SendIcon } from "@/components/ui/icons";
import { startTemporaryUpgradeRegistration } from "@/lib/api/auth";
import { fetchTempAccessSession } from "@/lib/api/tempAccess";
import { navigateTo, safeNextPath } from "@/lib/navigation";

const MISSING_UPGRADE_CODE_MESSAGE =
  "This upgrade link is incomplete. Reopen the event from your temporary access link.";

function TemporaryUpgradeSignupContent({ searchParams, next }) {
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
    <main className="auth-page auth-page-with-header">
      <form
        className="auth-panel"
        onSubmit={step === "details" ? submitDetails : submitCode}
      >
        <div>
          <h1>Upgrade your account</h1>
          <p>
            {step === "details"
              ? "Set up your Releviz account."
              : "Enter the email verification code."}
          </p>
        </div>
        {upgradeMode && upgradeSessionState === "loading" && (
          <LoadingState
            label="Checking your temporary event access…"
            className="p-0"
          />
        )}
        {upgradeSessionError && (
          <Alert variant="danger">{upgradeSessionError}</Alert>
        )}
        {error && <Alert variant="danger">{error}</Alert>}
        {step === "details" ? (
          <>
            <div className="form-row-2">
              <FormField label="First name">
                <input
                  className="form-control"
                  value={form.firstName}
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
                  value={form.lastName}
                  onChange={(event) => setField("lastName", event.target.value)}
                  autoComplete="family-name"
                  required
                />
              </FormField>
            </div>
            <FormField
              label="Email"
              help={
                upgradeMode
                  ? upgradeSessionState === "ready"
                    ? "This email is fixed so your existing event responses stay connected."
                    : "Your email is loaded from this event's verified temporary session."
                  : null
              }
            >
              <input
                className={`form-control${upgradeMode ? " bg-body-tertiary" : ""}`}
                value={registrationEmail}
                onChange={(event) => setField("email", event.target.value)}
                type="email"
                autoComplete="email"
                readOnly={upgradeMode}
                required
              />
            </FormField>
            <FormField label="Password">
              <input
                className="form-control"
                value={form.password}
                onChange={(event) => setField("password", event.target.value)}
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </FormField>
            <FormField label="Confirm password">
              <input
                className="form-control"
                value={form.passwordConfirm}
                onChange={(event) =>
                  setField("passwordConfirm", event.target.value)
                }
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </FormField>
          </>
        ) : (
          <FormField label="Verification code">
            <input
              className="form-control"
              value={form.code}
              onChange={(event) => setField("code", event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </FormField>
        )}
        <AppButton
          type="submit"
          fullWidth
          icon={step === "details" ? <SendIcon /> : <ArrowRightIcon />}
          busy={loading}
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
        <p className="text-secondary text-center mb-0">
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
          <main className="auth-page auth-page-with-header">
            <section className="auth-panel">
              <LoadingState label="Loading..." className="p-0" />
            </section>
          </main>
        </>
      }
    >
      <SignupContent />
    </Suspense>
  );
}
