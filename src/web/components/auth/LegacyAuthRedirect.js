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
    <main>
      <p>Redirecting...</p>
      <p>
        <Link href={destination}>Continue to {label}</Link>
      </p>
    </main>
  );
}
