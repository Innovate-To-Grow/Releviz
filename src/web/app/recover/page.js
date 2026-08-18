"use client";

import Link from "next/link";
import { useState } from "react";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { confirmPasswordReset, requestPasswordResetCode } from "@/lib/api/auth";
import { navigateTo } from "@/lib/navigation";

export default function RecoverAccountPage() {
  const [step, setStep] = useState("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const requestCode = async (event) => {
    event.preventDefault();
    setError("");
    setStatus("");
    setLoading(true);
    try {
      await requestPasswordResetCode({ email });
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
      await confirmPasswordReset({ email, code, password, passwordConfirm });
      navigateTo("/login?status=password-reset");
    } catch (err) {
      setError(err.message || "Unable to reset your password.");
    } finally {
      setLoading(false);
    }
  };

  const useDifferentEmail = () => {
    setStep("request");
    setCode("");
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
          <label>
            Email
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              autoComplete="email"
              disabled={step === "reset"}
              required
            />
          </label>
          {step === "reset" && (
            <>
              <button
                type="button"
                className="auth-inline-link"
                onClick={useDifferentEmail}
              >
                Use a different email
              </button>
              <label>
                Reset code
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
              </label>
              <label>
                New password
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  aria-describedby="recover-password-help"
                  required
                />
              </label>
              <p id="recover-password-help" className="field-help">
                Use at least 8 characters.
              </p>
              <label>
                Confirm new password
                <input
                  value={passwordConfirm}
                  onChange={(event) => setPasswordConfirm(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
            </>
          )}
          <AppButton type="submit" fullWidth disabled={loading}>
            {loading
              ? step === "request"
                ? "Sending..."
                : "Resetting..."
              : step === "request"
                ? "Send reset code"
                : "Reset password"}
          </AppButton>
          <p className="auth-switch">
            <Link href="/login">Back to login</Link>
          </p>
        </form>
      </main>
    </>
  );
}
