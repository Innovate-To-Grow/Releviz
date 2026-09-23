"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import BrandLogo from "@/components/ui/BrandLogo";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import { ArrowRightIcon, EmailIcon } from "@/components/ui/icons";
import { navigateTo, safeNextPath } from "@/lib/navigation";

const AUTH_ENTRY_PATHS = new Set([
  "/email-auth-link",
  "/impersonate-login",
  "/login",
  "/recover",
  "/sign-in",
  "/sign-up",
  "/signup",
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function PanelHeader({ title, subtitle }) {
  return (
    <>
      <BrandLogo
        alt="Releviz"
        className="brand-logo brand-logo--auth mx-auto"
        priority
      />
      <div className="text-center">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </>
  );
}

export default function ContinueWithEmailPage({
  next = "/dashboard",
  initialStatus = "",
}) {
  const {
    user,
    login,
    requestEmailAuthCode,
    verifyEmailAuthCode,
    loading: authLoading,
    nextStep,
    requiresProfileCompletion,
  } = useAuth();
  const redirectStarted = useRef(false);
  const [mode, setMode] = useState("code");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sentEmail, setSentEmail] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState({});
  const [status, setStatus] = useState(initialStatus);
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

  const clearFeedback = () => {
    setError("");
    setFieldError({});
    setInfoMessage("");
  };

  const sendCode = async (address) => {
    const eventDestination = new URL(next, "https://releviz.invalid");
    const eventCode =
      eventDestination.pathname === "/event"
        ? eventDestination.searchParams.get("code")
        : "";
    setLoading(true);
    try {
      const response = await requestEmailAuthCode({
        email: address,
        next,
        ...(eventCode
          ? { source: "event_registration", event: eventCode }
          : { source: "login" }),
      });
      setInfoMessage(
        typeof response?.message === "string" ? response.message : "",
      );
      setSentEmail(address);
    } catch (err) {
      setError(err.message || "Unable to send a verification code.");
    } finally {
      setLoading(false);
    }
  };

  const handleCodeRequest = (event) => {
    event.preventDefault();
    if (authLoading || redirectStarted.current) return;
    clearFeedback();
    setStatus("");
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setFieldError({ email: "Please enter a valid email address." });
      return;
    }
    sendCode(address);
  };

  const resendCode = () => {
    if (authLoading || redirectStarted.current) return;
    clearFeedback();
    sendCode(sentEmail);
  };

  const handleVerify = async (event) => {
    event.preventDefault();
    if (authLoading || redirectStarted.current) return;
    clearFeedback();
    setStatus("");
    setLoading(true);
    try {
      const data = await verifyEmailAuthCode({ email: sentEmail, code });
      redirectStarted.current = true;
      navigateTo(destinationAfterAuthentication(next, data));
    } catch (err) {
      setError(err.message || "Unable to verify the code.");
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (event) => {
    event.preventDefault();
    if (authLoading || redirectStarted.current) return;
    clearFeedback();
    setStatus("");
    if (!email.trim()) {
      setFieldError({ email: "Please enter your email." });
      return;
    }
    if (!password) {
      setFieldError({ password: "Please enter your password." });
      return;
    }
    setLoading(true);
    try {
      const data = await login({ email: email.trim(), password });
      redirectStarted.current = true;
      navigateTo(destinationAfterAuthentication(next, data));
    } catch (err) {
      setError(err.message || "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setPassword("");
    setCode("");
    setSentEmail("");
    clearFeedback();
  };

  const backToEmail = () => {
    setSentEmail("");
    setCode("");
    clearFeedback();
  };

  const updateCode = (event) => {
    setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
    setError("");
  };

  const updateEmail = (event) => {
    setEmail(event.target.value);
    clearFeedback();
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

  const alerts = (
    <>
      {error && <Alert variant="danger">{error}</Alert>}
      {status && <Alert variant="success">{status}</Alert>}
      {infoMessage && <Alert variant="info">{infoMessage}</Alert>}
    </>
  );
  const legalNotice = (
    <p className="small text-secondary mb-0">
      By continuing, you agree to receive a one-time verification email.
    </p>
  );
  const recoverHref =
    next !== "/dashboard"
      ? `/recover?next=${encodeURIComponent(next)}`
      : "/recover";

  // Each step gets its own form key so React remounts it and autoFocus lands in
  // the new step's field; otherwise the reused email <input> keeps the DOM node
  // and focus is lost on the button that just unmounted.
  if (mode === "password") {
    return (
      <>
        <AppHeader />
        <main className="auth-page auth-page-with-header">
          <form
            key="password"
            className="auth-panel"
            onSubmit={handlePasswordSubmit}
            noValidate
          >
            <PanelHeader
              title="Welcome to Releviz"
              subtitle="Enter your email to sign in or create your account"
            />
            {alerts}
            <FormField id="login-email" label="Email" error={fieldError.email}>
              <input
                className="form-control"
                value={email}
                onChange={updateEmail}
                type="email"
                autoComplete="username"
                placeholder="you@email.com"
                autoFocus={!email}
                required
              />
            </FormField>
            <FormField
              id="login-password"
              label="Password"
              error={fieldError.password}
            >
              <input
                className="form-control"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  clearFeedback();
                }}
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                autoFocus={Boolean(email)}
                required
              />
            </FormField>
            <AppButton
              type="submit"
              fullWidth
              icon={<ArrowRightIcon />}
              busy={loading}
              disabled={loading || authLoading || !email || !password}
            >
              {loading ? "Signing in..." : "Sign In"}
            </AppButton>
            <div className="d-flex justify-content-between gap-3">
              <button
                type="button"
                className="btn btn-link p-0"
                onClick={() => switchMode("code")}
                disabled={loading}
              >
                Sign in with a verification code
              </button>
              <Link href={recoverHref}>Forgot password?</Link>
            </div>
            {legalNotice}
          </form>
        </main>
      </>
    );
  }

  if (sentEmail) {
    return (
      <>
        <AppHeader />
        <main className="auth-page auth-page-with-header">
          <form
            key="verify"
            className="auth-panel"
            onSubmit={handleVerify}
            noValidate
          >
            <PanelHeader
              title="Verify Your Identity"
              subtitle="Enter the 6-digit code we sent to continue signing in or setting up your account."
            />
            {alerts}
            <p className="mb-0">
              <span className="text-secondary">Sending to</span>{" "}
              <strong>{sentEmail}</strong>
            </p>
            <FormField label="Verification Code">
              <input
                className="form-control"
                value={code}
                onChange={updateCode}
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="000000"
                autoFocus
                required
              />
            </FormField>
            <AppButton
              type="submit"
              fullWidth
              icon={<ArrowRightIcon />}
              busy={loading}
              disabled={loading || authLoading || code.length !== 6}
            >
              {loading ? "Verifying..." : "Continue"}
            </AppButton>
            <div className="d-flex justify-content-between gap-3">
              <button
                type="button"
                className="btn btn-link p-0"
                onClick={resendCode}
                disabled={loading}
              >
                Resend code
              </button>
              <button
                type="button"
                className="btn btn-link p-0"
                onClick={backToEmail}
                disabled={loading}
              >
                Back
              </button>
            </div>
          </form>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader />
      <main className="auth-page auth-page-with-header">
        <form
          key="code"
          className="auth-panel"
          onSubmit={handleCodeRequest}
          noValidate
        >
          <PanelHeader
            title="Welcome to Releviz"
            subtitle="Enter your email to sign in or create your account"
          />
          {alerts}
          <FormField
            id="login-identifier"
            label="Email"
            help="We'll email you a 6-digit sign-in code. New here? This creates your account."
            error={fieldError.email}
          >
            <input
              className="form-control"
              value={email}
              onChange={updateEmail}
              type="email"
              autoComplete="username"
              placeholder="you@email.com"
              autoFocus
              required
            />
          </FormField>
          <AppButton
            type="submit"
            fullWidth
            icon={<EmailIcon />}
            busy={loading}
            disabled={
              loading || authLoading || !EMAIL_PATTERN.test(email.trim())
            }
          >
            {loading ? "Sending code..." : "Continue"}
          </AppButton>
          <button
            type="button"
            className="btn btn-link p-0 align-self-center"
            onClick={() => switchMode("password")}
            disabled={loading}
          >
            Sign in with password instead
          </button>
          {legalNotice}
        </form>
      </main>
    </>
  );
}
