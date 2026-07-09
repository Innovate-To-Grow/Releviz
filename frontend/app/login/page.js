"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";

function LoginContent() {
  const searchParams = useSearchParams();
  const requestedNext = searchParams.get("next") || "/dashboard";
  const next =
    requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/dashboard";
  const { login, requestEmailLoginCode, verifyEmailLoginCode } = useAuth();
  const [mode, setMode] = useState("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [status, setStatus] = useState("");
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
    setError("");
    setStatus("");
    setLoading(true);
    try {
      if (mode === "password") {
        await login({ email, password });
        window.location.assign(next);
      } else if (!codeSent) {
        await requestEmailLoginCode({ email });
        setCodeSent(true);
        setStatus("Verification code sent. Check your email.");
      } else {
        await verifyEmailLoginCode({ email, code });
        window.location.assign(next);
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
            onClick={() => switchMode("password")}
          >
            Password
          </button>
          <button
            type="button"
            className={mode === "code" ? "auth-mode-active" : ""}
            onClick={() => switchMode("code")}
          >
            Email code
          </button>
        </div>
        {error && <div className="auth-error">{error}</div>}
        {status && <div className="auth-status">{status}</div>}
        <label>
          Email
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
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
        <AppButton type="submit" fullWidth disabled={loading}>
          {loading
            ? mode === "code" && !codeSent
              ? "Sending..."
              : "Logging in..."
            : mode === "code" && !codeSent
              ? "Send login code"
              : "Log in"}
        </AppButton>
        <p className="auth-switch">
          Need an account? <Link href="/signup">Sign up</Link>
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
