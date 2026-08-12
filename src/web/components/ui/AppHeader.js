"use client";

import AccountMenu from "@/components/ui/AccountMenu";
import { BrandHomeLink } from "@/components/ui/BrandLogo";

export default function AppHeader({ pageTitle, contextLabel }) {
  return (
    <header className="app-header">
      <div className="app-header-identity">
        <BrandHomeLink logoClassName="brand-logo brand-logo--header" priority />
        {pageTitle && (
          <span className="app-header-page-title">/ {pageTitle}</span>
        )}
        {contextLabel && (
          <span className="app-context-badge">{contextLabel}</span>
        )}
      </div>
      <AccountMenu />
    </header>
  );
}
