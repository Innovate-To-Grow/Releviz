"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import { ArrowRightIcon, EmailIcon } from "@/components/ui/icons";
import { navigateTo, safeNextPath } from "@/lib/navigation";

const AUTH_ENTRY_PATHS = new Set([
  "/email-auth-link",
  "/login",
  "/recover",
  "/sign-in",
  "/sign-up",
  "/signup",
]);

export function destinationAfterAuthentication(next, data = {}) {
  const safeDestination = safeNextPath(next);
  const destinationUrl = new URL(safeDestination, "https://releviz.invalid");
  let destination = AUTH_ENTRY_PATHS.has(destinationUrl.pathname)
    ? "/dashboard"
    : safeDestination;
  const profileIncomplete =
    data?.requires_profile_completion || data?.next_step === "complete_profile";
  const completionUrl = new URL(destination, "https://releviz.invalid");

  if (
    completionUrl.pathname === "/settings" &&
    completionUrl.searchParams.get("complete_profile") === "1"
  ) {
    const nestedDestination = safeNextPath(
      completionUrl.searchParams.get("next"),
    );
    const nestedUrl = new URL(nestedDestination, "https://releviz.invalid");
    destination = AUTH_ENTRY_PATHS.has(nestedUrl.pathname)
      ? "/dashboard"
      : nestedDestination;
    if (profileIncomplete) {
      return `/settings?complete_profile=1&next=${encodeURIComponent(destination)}`;
    }
    return destination;
  }

  if (profileIncomplete) {
    return `/settings?complete_profile=1&next=${encodeURIComponent(destination)}`;
  }

  return destination;
}

export default function ContinueWithEmailPage({
  next = "/dashboard",
  initialStatus = "",
}) {
  const {
    user,
    requestEmailAuthCode,
    verifyEmailAuthCode,
    loading: authLoading,
    nextStep,
    requiresProfileCompletion,
  } = useAuth();
  const redirectStarted = useRef(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (authLoading || !user || redirectStarted.current) return;
    redirectStarted.current = true;
    navigateTo(
      destinationAfterAuthentication(next, {
        next_step: nextStep,
        requires_profile_completion: requiresProfileCompletion,
      }),
    );
  }, [authLoading, next, nextStep, requiresProfileCompletion, user]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (authLoading || redirectStarted.current) return;
    setError("");
    setStatus("");
    setLoading(true);

    try {
      if (!codeSent) {
        const eventDestination = new URL(next, "https://releviz.invalid");
        const eventCode =
          eventDestination.pathname === "/event"
            ? eventDestination.searchParams.get("code")
            : "";
        await requestEmailAuthCode({
          email,
          next,
          ...(eventCode
            ? { source: "event_registration", event: eventCode }
            : { source: "login" }),
        });
        setCodeSent(true);
      } else {
        const data = await verifyEmailAuthCode({ email, code });
        redirectStarted.current = true;
        navigateTo(destinationAfterAuthentication(next, data));
      }
    } catch (err) {
      setError(
        err.message ||
          (codeSent
            ? "Unable to verify the code."
            : "Unable to send a verification code."),
      );
    } finally {
      setLoading(false);
    }
  };

  const useDifferentEmail = () => {
    setCodeSent(false);
    setCode("");
    setError("");
    setStatus("");
  };

  if (authLoading || user) {
    return (
      <>
        <AppHeader />
        <main className="auth-page auth-page-with-header">
          <section className="auth-panel">
            <LoadingState
              label={
                authLoading ? "Checking your session…" : "Opening your account…"
              }
              className="p-0"
            />
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader />
      <main className="auth-page auth-page-with-header">
        <form className="auth-panel" onSubmit={handleSubmit}>
          <div>
            <h1>{codeSent ? "Check your email" : "Continue with email"}</h1>
            <p>
              {codeSent
                ? `Enter the 6-digit code sent to ${email}.`
                : "We’ll send you a verification code. Existing accounts sign in and new accounts are created automatically."}
            </p>
          </div>

          {error && <Alert variant="danger">{error}</Alert>}
          {status && <Alert variant="success">{status}</Alert>}

          {!codeSent ? (
            <FormField label="Email">
              <input
                className="form-control"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                autoComplete="email"
                autoFocus
                required
              />
            </FormField>
          ) : (
            <>
              <FormField label="Verification code">
                <input
                  className="form-control"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  required
                />
              </FormField>
              <button
                type="button"
                className="btn btn-link p-0 align-self-start"
                onClick={useDifferentEmail}
              >
                Use a different email
              </button>
            </>
          )}

          <AppButton
            type="submit"
            fullWidth
            icon={codeSent ? <ArrowRightIcon /> : <EmailIcon />}
            busy={loading}
            disabled={loading || authLoading}
          >
            {loading
              ? codeSent
                ? "Verifying..."
                : "Sending code..."
              : codeSent
                ? "Verify and continue"
                : "Continue with email"}
          </AppButton>

          <p className="small text-secondary mb-0">
            No password required. By continuing, you agree to receive a one-time
            verification email.
          </p>
        </form>
      </main>
    </>
  );
}
