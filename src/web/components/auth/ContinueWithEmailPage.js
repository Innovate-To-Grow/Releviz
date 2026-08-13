"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { navigateTo } from "@/lib/navigation";

export default function ContinueWithEmailPage({
  next = "/dashboard",
  initialStatus = "",
}) {
  const {
    requestEmailAuthCode,
    verifyEmailAuthCode,
    loading: authLoading,
  } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handlePostAuthRedirect = (data) => {
    if (
      data?.requires_profile_completion ||
      data?.next_step === "complete_profile"
    ) {
      navigateTo(
        `/settings?complete_profile=1&next=${encodeURIComponent(next)}`,
      );
      return;
    }
    navigateTo(next);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (authLoading) return;
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
        handlePostAuthRedirect(data);
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

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          {status && (
            <div className="auth-status" role="status" aria-live="polite">
              {status}
            </div>
          )}

          {!codeSent ? (
            <label>
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                autoComplete="email"
                autoFocus
                required
              />
            </label>
          ) : (
            <>
              <label>
                Verification code
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  required
                />
              </label>
              <button
                type="button"
                className="auth-inline-link"
                onClick={useDifferentEmail}
              >
                Use a different email
              </button>
            </>
          )}

          <AppButton type="submit" fullWidth disabled={loading || authLoading}>
            {loading
              ? codeSent
                ? "Verifying..."
                : "Sending code..."
              : codeSent
                ? "Verify and continue"
                : "Continue with email"}
          </AppButton>

          <p className="auth-privacy-note">
            No password required. By continuing, you agree to receive a one-time
            verification email.
          </p>
        </form>
      </main>
    </>
  );
}
