"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { MdPerson, MdLogout, MdSettings, MdLogin, MdDashboard } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";

function UserMenu() {
  const { user, loading, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  /* istanbul ignore next */
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
            onClick={/* istanbul ignore next */ () => setOpen(false)}
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

export function AppHeader({ pageTitle, contextLabel }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 24px",
        borderBottom: "1px solid var(--md-sys-color-surface-variant)",
        background: "var(--md-sys-color-surface)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Link
          href="/"
          style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: "8px" }}
        >
          <Image src="/img/i2glogo.png" alt="i2G Logo" width={36} height={36} />
          <span
            style={{ fontWeight: "700", fontSize: "1.1rem", color: "var(--md-sys-color-primary)" }}
          >
            Releviz
          </span>
        </Link>
        {pageTitle && (
          <span style={{ color: "var(--md-sys-color-on-surface-variant)", fontSize: "0.95rem" }}>
            / {pageTitle}
          </span>
        )}
        {contextLabel && (
          <span
            style={{
              fontSize: "0.75rem",
              fontWeight: "600",
              padding: "2px 8px",
              borderRadius: "999px",
              background: "var(--md-sys-color-tertiary-container)",
              color: "var(--md-sys-color-on-tertiary-container)",
            }}
          >
            {contextLabel}
          </span>
        )}
      </div>
      <UserMenu />
    </div>
  );
}

export default AppHeader;
