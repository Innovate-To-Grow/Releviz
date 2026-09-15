"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import LoadingState from "@/components/ui/LoadingState";

export default function LegacyAuthRedirect({ destination, label }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(destination);
  }, [destination, router]);

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <LoadingState label="Redirecting..." className="p-0" />
        <p className="text-center mb-0">
          <Link href={destination}>Continue to {label}</Link>
        </p>
      </section>
    </main>
  );
}
