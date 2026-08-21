"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import AppHeader from "@/components/ui/AppHeader";
import Button from "@/components/ui/Button";
import { Callout, LoadingState } from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/Form";
import { Eyebrow } from "@/components/ui/Surface";
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
        <main id="main" className="rv-page rv-page--form rv-page--centered">
          <LoadingState
            message={
              authLoading ? "Checking your session…" : "Opening your account…"
            }
          />
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader />
      <main id="main" className="rv-page rv-page--form rv-page--centered">
        <form onSubmit={handleSubmit} className="rv-auth">
          <div className="rv-stack rv-stack--sm">
            <Eyebrow icon={codeSent ? "mail" : "shield"}>
              {codeSent ? "Verification" : "Sign in or sign up"}
            </Eyebrow>
            <h1 className="rv-auth__title">
              {codeSent ? "Check your email" : "Continue with email"}
            </h1>
            <p className="rv-auth__lede">
              {codeSent
                ? `Enter the 6-digit code sent to ${email}.`
                : "We’ll send you a verification code. Existing accounts sign in and new accounts are created automatically."}
            </p>
          </div>

          {error && (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          )}
          {status && (
            <Callout tone="info" role="status" aria-live="polite">
              {status}
            </Callout>
          )}

          {!codeSent ? (
            <Field label="Email">
              <TextInput
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                autoComplete="email"
                autoFocus
                required
              />
            </Field>
          ) : (
            <div className="rv-stack rv-stack--sm">
              <Field label="Verification code">
                <TextInput
                  className="rv-input--code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  required
                />
              </Field>
              <div>
                <Button variant="link" onClick={useDifferentEmail}>
                  Use a different email
                </Button>
              </div>
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
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
          </Button>

          <p className="rv-auth__footnote">
            No password required. By continuing, you agree to receive a one-time
            verification email.
          </p>
        </form>
      </main>
    </>
  );
}
