import { Suspense } from "react";
import TempAccessClient from "./TempAccessClient";

export const metadata = {
  title: "Temporary event access · Releviz",
  robots: { index: false, follow: false },
};

export default function TempAccessPage() {
  return (
    <Suspense fallback={<div aria-live="polite">Opening event access…</div>}>
      <TempAccessClient />
    </Suspense>
  );
}
