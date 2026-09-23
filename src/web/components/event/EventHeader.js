"use client";

import Link from "next/link";
import React, { useState } from "react";
import AppButton from "@/components/ui/AppButton";
import AccountMenu from "@/components/ui/AccountMenu";
import BrandLogo from "@/components/ui/BrandLogo";
import { CheckIcon, LinkIcon } from "@/components/ui/icons";

/**
 * Event page top bar: logo, event name, share code, role badge, and actions.
 */
function EventHeader({ eventName, eventCode, isOrganizer }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const shareUrl = `${window.location.origin}/event?code=${eventCode}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const input = document.createElement("input");
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <header className="app-header event-header">
      <nav className="navbar navbar-expand" aria-label="Event">
        <div className="app-header-identity">
          <Link href="/" className="brand-home-link" aria-label="Releviz">
            <BrandLogo
              alt=""
              className="brand-logo brand-logo--event-header"
              priority
            />
          </Link>
          <span className="app-header-divider" aria-hidden="true" />
          <div className="d-flex align-items-center flex-wrap gap-2 min-w-0">
            <h1 className="h5 mb-0 text-truncate event-header-title">
              {eventName}
            </h1>
            {eventCode && (
              <span className="badge text-bg-light border font-monospace fw-semibold event-header-code">
                #{eventCode}
              </span>
            )}
            {isOrganizer !== undefined && (
              <span
                className={`badge rounded-pill ${isOrganizer ? "text-bg-primary" : "bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle"} event-role-badge`}
              >
                {isOrganizer ? "Organizer" : "Participant"}
              </span>
            )}
          </div>
        </div>
        <div className="d-flex align-items-center gap-2 event-header-actions">
          <AppButton
            onClick={handleCopy}
            variant="outlined"
            icon={copied ? <CheckIcon /> : <LinkIcon />}
          >
            {copied ? "Link copied" : "Copy share link"}
          </AppButton>
          <AccountMenu signedOutLabel="Log in" />
        </div>
      </nav>
    </header>
  );
}

export default EventHeader;
