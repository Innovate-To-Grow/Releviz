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
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login({ email, password });
      window.location.assign(next);
    } catch (err) {
      setError(err.message || "Unable to log in.");
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
        {error && <div className="auth-error">{error}</div>}
        <label>
          Email
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            required
          />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            required
          />
        </label>
        <AppButton type="submit" fullWidth disabled={loading}>
          {loading ? "Logging in..." : "Log in"}
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
