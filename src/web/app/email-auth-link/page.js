"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import AppHeader from "@/components/ui/AppHeader";
import { navigateTo, safeNextPath } from "@/lib/navigation";

const ALLOWED_FLOWS = new Set(["auth", "login", "register"]);
const ALLOWED_SOURCES = new Set([
  "login",
  "register",
  "subscribe",
  "event_registration",
]);
const EVENT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function parseEmailAuthHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const flow = params.get("flow") || "";
  const source = params.get("source") || "";
  const email = (params.get("email") || "").trim().toLowerCase();
  const code = (params.get("code") || "").trim();
  const event = (params.get("event") || "").trim();
  const next = params.get("next") || "";
  const flowMatchesSource =
    (flow === "auth" &&
      ["login", "subscribe", "event_registration"].includes(source)) ||
    (flow === "login" && source === "login") ||
    (flow === "register" && source === "register");

  if (
    !ALLOWED_FLOWS.has(flow) ||
    !ALLOWED_SOURCES.has(source) ||
    !flowMatchesSource ||
    !email ||
    email.length > 254 ||
    !email.includes("@") ||
    !/^\d{6}$/.test(code) ||
    (event && !EVENT_CODE_PATTERN.test(event))
  ) {
    throw new Error(
      "This verification link is incomplete or invalid. Request a new code to continue.",
    );
  }

  return { flow, source, email, code, event, next };
}

function destinationForLink({ source, event, next }) {
  if (next) return safeNextPath(next);
  if (source === "event_registration" && event) {
    return `/event?code=${encodeURIComponent(event)}`;
  }
  if (source === "subscribe") return "/";
  return "/dashboard";
}

export default function EmailAuthLinkPage() {
  const {
    loading: authLoading,
    verifyEmailAuthCode,
    verifyEmailLoginCode,
    verifySignup,
  } = useAuth();
  const started = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (authLoading || started.current) return;
    started.current = true;

    async function verifyLink() {
      try {
        const hash = window.location.hash;
        window.history.replaceState(
          {},
          "",
          `${window.location.pathname}${window.location.search}`,
        );
        const link = parseEmailAuthHash(hash);
        const verify =
          link.flow === "auth"
            ? verifyEmailAuthCode
            : link.flow === "login"
              ? verifyEmailLoginCode
              : verifySignup;
        const data = await verify({ email: link.email, code: link.code });
        const destination = destinationForLink(link);
        if (
          data?.requires_profile_completion ||
          data?.next_step === "complete_profile"
        ) {
          navigateTo(
            `/settings?complete_profile=1&next=${encodeURIComponent(destination)}`,
          );
          return;
        }
        navigateTo(destination);
      } catch (err) {
        setError(
          err.message ||
            "We could not verify this link. Request a new code to continue.",
        );
      }
    }

    void verifyLink();
  }, [authLoading, verifyEmailAuthCode, verifyEmailLoginCode, verifySignup]);

  return (
    <>
      <AppHeader />
      <main>
        <section aria-live="polite">
          <div>
            <h1>{error ? "Link verification failed" : "Signing you in"}</h1>
            <p>
              {error
                ? error
                : "Please wait while we securely verify your email."}
            </p>
          </div>
          {error && <Link href="/login">Request a new code</Link>}
        </section>
      </main>
    </>
  );
}

export { destinationForLink, parseEmailAuthHash };
