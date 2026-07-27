"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import { navigateTo, safeNextPath } from "@/lib/navigation";

function SignupContent() {
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));
  const { signup, verifySignup, loading: authLoading } = useAuth();
  const [step, setStep] = useState("details");
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    organization: "",
    title: "",
    email: "",
    password: "",
    passwordConfirm: "",
    code: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const setField = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const submitDetails = async (event) => {
    event.preventDefault();
    if (authLoading) return;
    setError("");
    if (form.password !== form.passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await signup({
        email: form.email,
        password: form.password,
        password_confirm: form.passwordConfirm,
        first_name: form.firstName,
        last_name: form.lastName,
        organization: form.organization,
        title: form.title,
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
      await verifySignup({ email: form.email, code: form.code });
      navigateTo(next);
    } catch (err) {
      setError(err.message || "Unable to verify code.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={step === "details" ? submitDetails : submitCode}>
        <div>
          <h1>Create account</h1>
          <p>
            {step === "details"
              ? "Set up your Releviz account."
              : "Enter the email verification code."}
          </p>
        </div>
        {error && <div className="auth-error">{error}</div>}
        {step === "details" ? (
          <>
            <div className="auth-grid">
              <label>
                First name
                <input
                  value={form.firstName}
                  onChange={(event) => setField("firstName", event.target.value)}
                  required
                />
              </label>
              <label>
                Last name
                <input
                  value={form.lastName}
                  onChange={(event) => setField("lastName", event.target.value)}
                  required
                />
              </label>
            </div>
            <label>
              Organization <span className="auth-optional">(optional)</span>
              <input
                aria-label="Organization"
                value={form.organization}
                onChange={(event) => setField("organization", event.target.value)}
              />
            </label>
            <label>
              Title
              <input
                value={form.title}
                onChange={(event) => setField("title", event.target.value)}
              />
            </label>
            <label>
              Email
              <input
                value={form.email}
                onChange={(event) => setField("email", event.target.value)}
                type="email"
                required
              />
            </label>
            <label>
              Password
              <input
                value={form.password}
                onChange={(event) => setField("password", event.target.value)}
                type="password"
                minLength={8}
                required
              />
            </label>
            <label>
              Confirm password
              <input
                value={form.passwordConfirm}
                onChange={(event) => setField("passwordConfirm", event.target.value)}
                type="password"
                minLength={8}
                required
              />
            </label>
          </>
        ) : (
          <label>
            Verification code
            <input
              value={form.code}
              onChange={(event) => setField("code", event.target.value)}
              inputMode="numeric"
              required
            />
          </label>
        )}
        <AppButton type="submit" fullWidth disabled={loading || authLoading}>
          {loading
            ? "Working..."
            : step === "details"
              ? "Send verification code"
              : "Verify and continue"}
        </AppButton>
        <p className="auth-switch">
          Already have an account?{" "}
          <Link href={`/login?next=${encodeURIComponent(next)}`}>Log in</Link>
        </p>
      </form>
    </main>
  );
}

export default function Signup() {
  return (
    <Suspense
      fallback={
        <main className="auth-page">
          <div className="auth-panel">Loading...</div>
        </main>
      }
    >
      <SignupContent />
    </Suspense>
  );
}
