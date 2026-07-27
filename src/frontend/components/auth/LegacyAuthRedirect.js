"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LegacyAuthRedirect({ destination, label }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(destination);
  }, [destination, router]);

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <p>Redirecting...</p>
        <p className="auth-switch">
          <Link href={destination}>Continue to {label}</Link>
        </p>
      </div>
    </main>
  );
}
