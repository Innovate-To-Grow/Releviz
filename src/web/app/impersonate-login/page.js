import { Suspense } from "react";
import LoadingState from "@/components/ui/LoadingState";
import ImpersonateLoginClient from "./ImpersonateLoginClient";

export const metadata = {
  title: "Signing you in · Releviz",
  robots: { index: false, follow: false },
};

export default function ImpersonateLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="status-page">
          <LoadingState label="Signing you in..." />
        </div>
      }
    >
      <ImpersonateLoginClient />
    </Suspense>
  );
}
