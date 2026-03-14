"use client";

import dynamic from "next/dynamic";

const SettingsPage = dynamic(() => import("@/components/auth/SettingsPage"), { ssr: false });

export default function SettingsPageClient() {
  return <SettingsPage />;
}
