"use client";

import Image from "next/image";
import Link from "next/link";
import React, { useState, useRef, useEffect } from "react";
import { MdCheck, MdLink, MdPerson, MdLogout, MdSettings, MdLogin } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";

function UserMenu() {
  const { user, loading, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (loading) return null;

  if (!user) {
    return (
      <Link href="/login">
        <AppButton variant="outlined" icon={<MdLogin />}>
          Login
        </AppButton>
      </Link>
    );
  }

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <AppButton variant="outlined" icon={<MdPerson />} onClick={() => setOpen((o) => !o)}>
        {user.displayName}
      </AppButton>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: "4px",
            background: "var(--md-sys-color-surface-container)",
            borderRadius: "12px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
            minWidth: "160px",
            zIndex: 100,
            overflow: "hidden",
          }}
        >
          <Link
            href="/settings"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "12px 16px",
              textDecoration: "none",
              color: "var(--md-sys-color-on-surface)",
              fontSize: "0.9rem",
            }}
            onClick={() => setOpen(false)}
          >
            <MdSettings /> Settings
          </Link>
          <button
            onClick={async () => {
              setOpen(false);
              await logout();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "12px 16px",
              width: "100%",
              border: "none",
              background: "none",
              cursor: "pointer",
              color: "var(--md-sys-color-error)",
              fontSize: "0.9rem",
              textAlign: "left",
            }}
          >
            <MdLogout /> Logout
          </button>
        </div>
      )}
    </div>
  );
}

function EventHeader({ eventName, eventCode }) {
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
    <div className="event-header">
      <Link
        href="/"
        style={{
          textDecoration: "none",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          minWidth: 0,
        }}
      >
        <Image
          src="/img/i2glogo.png"
          alt="i2G Logo"
          width={36}
          height={36}
          style={{ flexShrink: 0 }}
        />
        <span
          style={{
            fontWeight: "700",
            fontSize: "1.1rem",
            color: "var(--md-sys-color-primary)",
            marginRight: "4px",
          }}
        >
          Relevis
        </span>
        <h1
          style={{
            margin: 0,
            fontSize: "1.2rem",
            color: "var(--md-sys-color-primary)",
            fontWeight: "600",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {eventName}
        </h1>
      </Link>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <AppButton onClick={handleCopy} variant="outlined" icon={copied ? <MdCheck /> : <MdLink />}>
          {copied ? "Copied!" : "Copy Share Link"}
        </AppButton>
        <UserMenu />
      </div>
    </div>
  );
}

export default EventHeader;
