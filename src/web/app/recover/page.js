"use client";

import Link from "next/link";
import { useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import FormField from "@/components/ui/FormField";
import { LockIcon, SendIcon } from "@/components/ui/icons";
import {
  requestPasswordResetCode,
  resetPasswordWithToken,
  verifyPasswordResetCode,
} from "@/lib/api/auth";
import { EMAIL_PATTERN } from "@/lib/email";
import { navigateTo, safeNextPath } from "@/lib/navigation";

// Carries the sign-in panel's destination through the reset. Read at submit
// time rather than via useSearchParams, which would need a Suspense boundary in
// the static export.
function loginAfterReset() {
  const next = safeNextPath(
    new URLSearchParams(window.location.search).get("next"),
  );
  return next !== "/dashboard"
    ? `/login?status=password-reset&next=${encodeURIComponent(next)}`
    : "/login?status=password-reset";
}

export default function RecoverAccountPage() {
  const [step, setStep] = useState("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  // Exchanging the code spends it, and a refused password leaves the token it
  // was exchanged for unused, so a retry with the same code reuses the token.
  const [verified, setVerified] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const trimmedEmail = email.trim();

  const requestCode = async (event) => {
    event.preventDefault();
    setError("");
    setStatus("");
    setLoading(true);
    try {
      await requestPasswordResetCode({ email: trimmedEmail });
      setStep("reset");
      setStatus(
        "If an account exists for that email, a reset code has been sent. Check your inbox.",
      );
    } catch (err) {
      setError(err.message || "Unable to request a reset code.");
    } finally {
      setLoading(false);
    }
  };

  const resetPassword = async (event) => {
    event.preventDefault();
    setError("");
    setStatus("");
    if (password !== passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      let verificationToken = verified?.code === code ? verified.token : null;
      if (!verificationToken) {
        verificationToken = await verifyPasswordResetCode({
          email: trimmedEmail,
          code,
        });
        setVerified({ code, token: verificationToken });
      }
      await resetPasswordWithToken({
        email: trimmedEmail,
        verificationToken,
        password,
        passwordConfirm,
      });
      navigateTo(loginAfterReset());
    } catch (err) {
      setError(err.message || "Unable to reset your password.");
    } finally {
      setLoading(false);
    }
  };

  const useDifferentEmail = () => {
    setStep("request");
    setCode("");
    setVerified(null);
    setPassword("");
    setPasswordConfirm("");
    setStatus("");
    setError("");
  };

  return (
    <>
      <AppHeader />
      <main className="auth-page auth-page-with-header">
        <form
          className="auth-panel"
          onSubmit={step === "request" ? requestCode : resetPassword}
        >
          <div>
            <h1>Recover your account</h1>
            <p>
              Request a one-time code, then choose a new password. Resetting
              your password signs out every device.
            </p>
          </div>
          {error && <Alert variant="danger">{error}</Alert>}
          {status && <Alert variant="info">{status}</Alert>}
          <FormField label="Email">
            <input
              className="form-control"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              autoComplete="email"
              disabled={step === "reset"}
              required
            />
          </FormField>
          {step === "reset" && (
            <>
              <button
                type="button"
                className="btn btn-link p-0 align-self-start"
                onClick={useDifferentEmail}
              >
                Use a different email
              </button>
              <FormField label="Reset code">
                <input
                  className="form-control"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
              </FormField>
              <FormField
                id="recover-password"
                label="New password"
                help="Use at least 8 characters."
              >
                <input
                  className="form-control"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </FormField>
              <FormField label="Confirm new password">
                <input
                  className="form-control"
                  value={passwordConfirm}
                  onChange={(event) => setPasswordConfirm(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </FormField>
            </>
          )}
          <AppButton
            type="submit"
            fullWidth
            icon={step === "request" ? <SendIcon /> : <LockIcon />}
            busy={loading}
            disabled={
              loading ||
              (step === "request" && !EMAIL_PATTERN.test(trimmedEmail))
            }
          >
            {loading
              ? step === "request"
                ? "Sending..."
                : "Resetting..."
              : step === "request"
                ? "Send reset code"
                : "Reset password"}
          </AppButton>
          <p className="text-center mb-0">
            <Link href="/login">Back to login</Link>
          </p>
        </form>
      </main>
    </>
  );
}
