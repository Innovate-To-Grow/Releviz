"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ContinueWithEmailPage from "@/components/auth/ContinueWithEmailPage";
import AppHeader from "@/components/ui/AppHeader";
import { LoadingState } from "@/components/ui/Feedback";
import { safeNextPath } from "@/lib/navigation";

function LoginContent() {
  const searchParams = useSearchParams();
  const statusCode = searchParams.get("status");
  const initialStatus =
    {
      "password-reset": "Password reset complete. Continue with your email.",
      "password-changed":
        "Password changed. Continue with your email on this device.",
      "signed-out-all": "All devices have been signed out.",
      "account-deleted": "Your account has been deleted.",
    }[statusCode] || "";

  return (
    <ContinueWithEmailPage
      next={safeNextPath(searchParams.get("next"))}
      initialStatus={initialStatus}
    />
  );
}

export default function Login() {
  return (
    <Suspense
      fallback={
        <>
          <AppHeader />
          <main id="main" className="rv-page rv-page--form rv-page--centered">
            <LoadingState message="Loading…" />
          </main>
        </>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
