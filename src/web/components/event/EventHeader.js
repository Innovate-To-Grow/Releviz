"use client";

import Link from "next/link";
import { useState } from "react";
import AppButton from "@/components/ui/AppButton";
import AccountMenu from "@/components/ui/AccountMenu";

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
    <header>
      <Link href="/">Releviz</Link>
      <h1>{eventName}</h1>
      {eventCode && <span>#{eventCode}</span>}
      {isOrganizer !== undefined && (
        <span>{isOrganizer ? "Organizer" : "Participant"}</span>
      )}
      <AppButton onClick={handleCopy}>
        {copied ? "Copied!" : "Copy Share Link"}
      </AppButton>
      <AccountMenu signedOutLabel="Log in" />
    </header>
  );
}

export default EventHeader;
