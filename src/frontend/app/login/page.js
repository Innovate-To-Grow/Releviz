"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import { navigateTo, safeNextPath } from "@/lib/navigation";

function LoginContent() {
  const searchParams = useSearchParams();
  const statusCode = searchParams.get("status");
  const initialStatus =
    {
      "password-reset": "Password reset complete. Log in with your new password.",
      "password-changed": "Password changed. Log in again on this device.",
      "signed-out-all": "All devices have been signed out.",
      "account-deleted": "Your account has been deleted.",
    }[statusCode] || "";
  const next = safeNextPath(searchParams.get("next"));
  const { login, requestEmailLoginCode, verifyEmailLoginCode, loading: authLoading } = useAuth();
  const [mode, setMode] = useState("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError("");
    setStatus("");
    setCode("");
    setCodeSent(false);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (authLoading) return;
    setError("");
    setStatus("");
    setLoading(true);
    try {
      if (mode === "password") {
        await login({ email, password });
        navigateTo(next);
      } else if (!codeSent) {
        await requestEmailLoginCode({ email });
        setCodeSent(true);
        setStatus("Verification code sent. Check your email.");
      } else {
        await verifyEmailLoginCode({ email, code });
        navigateTo(next);
      }
    } catch (err) {
      setError(err.message || (mode === "code" ? "Unable to verify code." : "Unable to log in."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={handleSubmit}>
        <div>
          <h1>Log in</h1>
          <p>Use your Releviz account to manage schedules and dashboards.</p>
        </div>
        <div className="auth-mode-row" role="group" aria-label="Login method">
          <button
            type="button"
            className={mode === "password" ? "auth-mode-active" : ""}
            aria-pressed={mode === "password"}
            onClick={() => switchMode("password")}
          >
            Password
          </button>
          <button
            type="button"
            className={mode === "code" ? "auth-mode-active" : ""}
            aria-pressed={mode === "code"}
            onClick={() => switchMode("code")}
          >
            Email code
          </button>
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
            required
          />
        </label>
        {mode === "password" ? (
          <label>
            Password
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
        ) : (
          codeSent && (
            <label>
              Verification code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </label>
          )
        )}
        <AppButton type="submit" fullWidth disabled={loading || authLoading}>
          {loading
            ? mode === "code" && !codeSent
              ? "Sending..."
              : "Logging in..."
            : mode === "code" && !codeSent
              ? "Send login code"
              : "Log in"}
        </AppButton>
        {mode === "password" && (
          <p className="auth-switch">
            <Link href="/recover">Forgot your password?</Link>
          </p>
        )}
        <p className="auth-switch">
          Need an account? <Link href={`/signup?next=${encodeURIComponent(next)}`}>Sign up</Link>
        </p>
      </form>
    </main>
  );
}

export default function Login() {
  return (
    <Suspense
      fallback={
        <main className="auth-page">
          <div className="auth-panel">Loading...</div>
        </main>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
