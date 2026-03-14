"use client";

import dynamic from "next/dynamic";

const SignupPage = dynamic(() => import("@/components/auth/SignupPage"), { ssr: false });

export default function SignupPageClient() {
  return <SignupPage />;
}
