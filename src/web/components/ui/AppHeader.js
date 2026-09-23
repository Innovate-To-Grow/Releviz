"use client";

import AccountMenu from "@/components/ui/AccountMenu";
import { BrandHomeLink } from "@/components/ui/BrandLogo";

/**
 * Global top bar: Releviz logo, optional page title and context badge, and
 * the account menu. Pass `children` to add page-specific actions (they render
 * between the identity block and the account menu).
 */
export default function AppHeader({ pageTitle, contextLabel, children }) {
  return (
    <header className="app-header">
      <nav className="navbar navbar-expand" aria-label="Site">
        <div className="app-header-identity">
          <BrandHomeLink
            logoClassName="brand-logo brand-logo--header"
            priority
          />
          {pageTitle && (
            <>
              <span className="app-header-divider" aria-hidden="true" />
              <span className="app-header-page-title">{pageTitle}</span>
            </>
          )}
          {contextLabel && (
            <span className="badge rounded-pill text-bg-primary">
              {contextLabel}
            </span>
          )}
        </div>
        {children && (
          <div className="d-flex align-items-center gap-2 flex-shrink-0">
            {children}
          </div>
        )}
        <AccountMenu />
      </nav>
    </header>
  );
}
