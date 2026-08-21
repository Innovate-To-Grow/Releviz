"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import ContinueWithEmailPage from "@/components/auth/ContinueWithEmailPage";
import AppHeader from "@/components/ui/AppHeader";
import Button from "@/components/ui/Button";
import { Callout, LoadingState } from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/Form";
import { Eyebrow } from "@/components/ui/Surface";
import { useAuth } from "@/components/auth/AuthContext";
import { startTemporaryUpgradeRegistration } from "@/lib/api/auth";
import { fetchTempAccessSession } from "@/lib/api/tempAccess";
import { navigateTo, safeNextPath } from "@/lib/navigation";

const MISSING_UPGRADE_CODE_MESSAGE =
  "This upgrade link is incomplete. Reopen the event from your temporary access link.";

const LOCKED_EMAIL_READY =
  "This email is fixed so your existing event responses stay connected.";
const LOCKED_EMAIL_PENDING =
  "Your email is loaded from this event's verified temporary session.";

function initialUpgradeSession(sessionKey, eventCode) {
  return {
    key: sessionKey,
    state: eventCode ? "loading" : "error",
    email: "",
    error: eventCode ? "" : MISSING_UPGRADE_CODE_MESSAGE,
  };
}

function TemporaryUpgradeSignupContent({ searchParams, next }) {
  const upgradeEventCode = (searchParams.get("code") || "").trim();
  const upgradeSessionKey = `temporary:${upgradeEventCode}`;
  const { verifySignup, loading: authLoading } = useAuth();
  const [step, setStep] = useState("details");
  const [upgradeSession, setUpgradeSession] = useState(() =>
    initialUpgradeSession(upgradeSessionKey, upgradeEventCode),
  );
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    password: "",
    passwordConfirm: "",
    code: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const currentUpgradeSession =
    upgradeSession.key === upgradeSessionKey
      ? upgradeSession
      : initialUpgradeSession(upgradeSessionKey, upgradeEventCode);
  const upgradeSessionState = currentUpgradeSession.state;
  const upgradeSessionError = currentUpgradeSession.error;
  const registrationEmail = currentUpgradeSession.email;
  const upgradeReady = upgradeSessionState === "ready";

  useEffect(() => {
    if (!upgradeEventCode) return undefined;

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
  }, [upgradeEventCode, upgradeSessionKey]);

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
      await startTemporaryUpgradeRegistration(upgradeEventCode, {
        password: form.password,
        password_confirm: form.passwordConfirm,
        first_name: form.firstName,
        last_name: form.lastName,
      });
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
      const data = await verifySignup({
        email: registrationEmail,
        code: form.code,
        temporaryUpgrade: true,
      });
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
    <main id="main" className="rv-page rv-page--form rv-page--centered">
      <form
        onSubmit={step === "details" ? submitDetails : submitCode}
        className="rv-auth"
      >
        <div className="rv-stack rv-stack--sm">
          <Eyebrow icon="shield">Temporary access</Eyebrow>
          <h1 className="rv-auth__title">Upgrade your account</h1>
          <p className="rv-auth__lede">
            {step === "details"
              ? "Set up your Releviz account. Your existing event responses stay connected."
              : "Enter the email verification code."}
          </p>
        </div>

        {upgradeSessionState === "loading" && (
          <Callout tone="info" role="status">
            Checking your temporary event access…
          </Callout>
        )}
        {upgradeSessionError && (
          <Callout tone="danger" role="alert">
            {upgradeSessionError}
          </Callout>
        )}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        {step === "details" ? (
          <>
            <div className="rv-grid rv-grid--pair">
              <Field label="First name">
                <TextInput
                  value={form.firstName}
                  onChange={(event) =>
                    setField("firstName", event.target.value)
                  }
                  autoComplete="given-name"
                  required
                />
              </Field>
              <Field label="Last name">
                <TextInput
                  value={form.lastName}
                  onChange={(event) => setField("lastName", event.target.value)}
                  autoComplete="family-name"
                  required
                />
              </Field>
            </div>
            <Field
              label="Email"
              hint={
                upgradeSessionState === "ready"
                  ? LOCKED_EMAIL_READY
                  : LOCKED_EMAIL_PENDING
              }
            >
              <TextInput value={registrationEmail} type="email" readOnly />
            </Field>
            <Field label="Password" hint="Use at least 8 characters.">
              <TextInput
                value={form.password}
                onChange={(event) => setField("password", event.target.value)}
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Field>
            <Field label="Confirm password">
              <TextInput
                value={form.passwordConfirm}
                onChange={(event) =>
                  setField("passwordConfirm", event.target.value)
                }
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Field>
          </>
        ) : (
          <Field label="Verification code">
            <TextInput
              className="rv-input--code"
              value={form.code}
              onChange={(event) => setField("code", event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
            />
          </Field>
        )}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
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
        </Button>

        <p className="rv-auth__footnote">
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
      <AppHeader pageTitle="Upgrade account" />
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
          <main id="main" className="rv-page rv-page--form rv-page--centered">
            <LoadingState message="Loading…" />
          </main>
        </>
      }
    >
      <SignupContent />
    </Suspense>
  );
}
