"use client";

import dynamic from "next/dynamic";

const LoginPage = dynamic(() => import("@/components/auth/LoginPage"), { ssr: false });

export default function LoginPageClient() {
  return <LoginPage />;
}
