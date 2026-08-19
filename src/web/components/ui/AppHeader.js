"use client";

import Link from "next/link";
import AccountMenu from "@/components/ui/AccountMenu";

export default function AppHeader({ pageTitle, contextLabel }) {
  return (
    <header>
      <Link href="/">Releviz</Link>
      {pageTitle && <span> / {pageTitle}</span>}
      {contextLabel && <span> {contextLabel}</span>}
      <AccountMenu />
    </header>
  );
}
