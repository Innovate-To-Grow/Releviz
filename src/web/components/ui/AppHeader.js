"use client";

import Link from "next/link";
import AccountMenu from "@/components/ui/AccountMenu";
import Icon, { BrandMark } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Feedback";

/**
 * Global application bar. It carries identity, a shallow breadcrumb for the
 * current page, an optional role chip, and the account menu. It stays sticky so
 * the primary escape hatches are always one tap away on mobile.
 */
export default function AppHeader({ pageTitle, contextLabel, actions }) {
  return (
    <header className="rv-shell-header">
      <div className="rv-shell-header__inner">
        <div className="rv-shell-header__identity">
          <Link href="/" className="rv-brand">
            <BrandMark className="rv-brand__mark" />
            <span className="rv-brand__word">Releviz</span>
          </Link>
          {pageTitle && (
            <span className="rv-shell-header__crumb">
              <Icon
                name="chevronRight"
                className="rv-shell-header__crumb-sep"
              />
              <span className="rv-shell-header__title rv-truncate">
                {pageTitle}
              </span>
            </span>
          )}
          {contextLabel && (
            <Badge tone="outline" className="rv-shell-header__role">
              {contextLabel}
            </Badge>
          )}
        </div>
        <div className="rv-shell-header__actions">
          {actions}
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
