"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import { destinationAfterAuthentication } from "@/components/auth/ContinueWithEmailPage";
import Alert from "@/components/ui/Alert";
import AppHeader from "@/components/ui/AppHeader";
import LoadingState from "@/components/ui/LoadingState";
import { impersonateLogin } from "@/lib/api/auth";
import { navigateTo } from "@/lib/navigation";

export default function ImpersonateLoginClient() {
  const { loading: authLoading } = useAuth();
  const started = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (authLoading || started.current) return;
    started.current = true;

    async function signIn() {
      const params = new URLSearchParams(
        window.location.hash.replace(/^#/, ""),
      );
      const token = (params.get("token") || "").trim();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      if (!token) {
        setError("No impersonation token provided.");
        return;
      }
      try {
        const data = await impersonateLogin({ token });
        navigateTo(destinationAfterAuthentication("/dashboard", data));
      } catch {
        setError("This impersonation link is invalid or has expired.");
      }
    }

    void signIn();
  }, [authLoading]);

  return (
    <>
      <AppHeader />
      <main className="status-page">
        {error ? (
          <>
            <Alert variant="danger">{error}</Alert>
            <div className="status-page__actions">
              <Link className="btn btn-primary app-btn" href="/login">
                <span className="app-btn-label">Go to Login</span>
              </Link>
            </div>
          </>
        ) : (
          <LoadingState label="Signing you in..." />
        )}
      </main>
    </>
  );
}
