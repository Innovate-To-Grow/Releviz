"use client";

import Link from "next/link";
import React, { useState } from "react";
import { MdCheck, MdLink } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import AccountMenu from "@/components/ui/AccountMenu";
import BrandLogo from "@/components/ui/BrandLogo";

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
    <header className="event-header">
      <Link href="/" className="event-header-identity">
        <BrandLogo
          alt="Releviz"
          className="brand-logo brand-logo--event-header"
          priority
        />
        <h1>{eventName}</h1>
        {eventCode && <span className="event-header-code">#{eventCode}</span>}
        {isOrganizer !== undefined && (
          <span
            className={`event-role-badge${isOrganizer ? " event-role-badge-organizer" : ""}`}
          >
            {isOrganizer ? "Organizer" : "Participant"}
          </span>
        )}
      </Link>
      <div className="event-header-actions">
        <AppButton
          onClick={handleCopy}
          variant="outlined"
          icon={copied ? <MdCheck /> : <MdLink />}
        >
          {copied ? "Copied!" : "Copy Share Link"}
        </AppButton>
        <AccountMenu signedOutLabel="Log in" />
      </div>
    </header>
  );
}

export default EventHeader;
