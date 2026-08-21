"use client";

import Link from "next/link";
import { useState } from "react";
import AppHeader from "@/components/ui/AppHeader";
import Button from "@/components/ui/Button";
import { Callout } from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/Form";
import { Eyebrow } from "@/components/ui/Surface";
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
      <AppHeader pageTitle="Account recovery" />
      <main id="main" className="rv-page rv-page--form rv-page--centered">
        <form
          onSubmit={step === "request" ? requestCode : resetPassword}
          className="rv-auth"
        >
          <div className="rv-stack rv-stack--sm">
            <Eyebrow icon="shield">Account recovery</Eyebrow>
            <h1 className="rv-auth__title">Recover your account</h1>
            <p className="rv-auth__lede">
              Request a one-time code, then choose a new password. Resetting
              your password signs out every device.
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

          <Field label="Email">
            <TextInput
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              autoComplete="email"
              disabled={step === "reset"}
              required
            />
          </Field>

          {step === "reset" && (
            <>
              <div>
                <Button variant="link" onClick={useDifferentEmail}>
                  Use a different email
                </Button>
              </div>
              <Field label="Reset code">
                <TextInput
                  className="rv-input--code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
              </Field>
              <Field label="New password" hint="Use at least 8 characters.">
                <TextInput
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </Field>
              <Field label="Confirm new password">
                <TextInput
                  value={passwordConfirm}
                  onChange={(event) => setPasswordConfirm(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </Field>
            </>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            busy={loading}
            disabled={loading}
          >
            {loading
              ? step === "request"
                ? "Sending..."
                : "Resetting..."
              : step === "request"
                ? "Send reset code"
                : "Reset password"}
          </Button>

          <p className="rv-auth__footnote">
            <Link href="/login">Back to login</Link>
          </p>
        </form>
      </main>
    </>
  );
}
