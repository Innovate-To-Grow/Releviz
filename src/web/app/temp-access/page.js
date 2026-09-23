import { Suspense } from "react";
import LoadingState from "@/components/ui/LoadingState";
import TempAccessClient from "./TempAccessClient";

export const metadata = {
  title: "Temporary event access · Releviz",
  robots: { index: false, follow: false },
};

export default function TempAccessPage() {
  return (
    <Suspense
      fallback={
        <div className="status-page">
          <LoadingState label="Opening event access…" />
        </div>
      }
    >
      <TempAccessClient />
    </Suspense>
  );
}
