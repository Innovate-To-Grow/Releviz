"use client";

import Link from "next/link";
import { useState } from "react";
import AccountMenu from "@/components/ui/AccountMenu";
import Button from "@/components/ui/Button";
import { Badge } from "@/components/ui/Feedback";
import { BrandMark } from "@/components/ui/Icon";

/**
 * Event application bar. It answers "which event am I in, what is my role, and
 * how do I share it" before any workflow content is reached, and wraps instead
 * of truncating so nothing is lost at 320px.
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
    <header className="rv-shell-header">
      <div className="rv-shell-header__inner rv-event-bar">
        <Link href="/" className="rv-brand rv-brand--sm">
          <BrandMark className="rv-brand__mark" />
          <span className="rv-brand__word">Releviz</span>
        </Link>
        <h1 className="rv-event-bar__title rv-truncate">{eventName}</h1>
        <div className="rv-event-bar__tags">
          {eventCode && (
            <Badge mono tone="outline">
              #{eventCode}
            </Badge>
          )}
          {isOrganizer !== undefined && (
            <Badge tone={isOrganizer ? "accent" : "neutral"}>
              {isOrganizer ? "Organizer" : "Participant"}
            </Badge>
          )}
        </div>
        <div className="rv-event-bar__actions">
          <Button
            size="sm"
            icon={copied ? "check" : "link"}
            onClick={handleCopy}
          >
            {copied ? "Copied!" : "Copy Share Link"}
          </Button>
          <AccountMenu signedOutLabel="Log in" />
        </div>
      </div>
    </header>
  );
}

export default EventHeader;
