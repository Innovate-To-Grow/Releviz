"use client";

import Link from "next/link";
import React, { useState, useRef, useEffect } from "react";
import {
  MdCheck,
  MdDashboard,
  MdLink,
  MdLogin,
  MdLogout,
  MdPerson,
  MdSettings,
} from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import BrandLogo from "@/components/ui/BrandLogo";

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
            href="/dashboard"
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
            <MdDashboard /> My Dashboard
          </Link>
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
            <MdLogout /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

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
        <BrandLogo alt="Releviz" className="brand-logo brand-logo--event-header" priority />
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
        {eventCode && (
          <span
            style={{
              fontSize: "0.85rem",
              color: "var(--md-sys-color-on-surface-variant)",
              fontWeight: "400",
              whiteSpace: "nowrap",
            }}
          >
            #{eventCode}
          </span>
        )}
        {isOrganizer !== undefined && (
          <span
            style={{
              fontSize: "0.75rem",
              fontWeight: "600",
              padding: "2px 8px",
              borderRadius: "999px",
              background: isOrganizer
                ? "var(--md-sys-color-primary-container)"
                : "var(--md-sys-color-secondary-container)",
              color: isOrganizer
                ? "var(--md-sys-color-on-primary-container)"
                : "var(--md-sys-color-on-secondary-container)",
              whiteSpace: "nowrap",
            }}
          >
            {isOrganizer ? "Organizer" : "Participant"}
          </span>
        )}
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
