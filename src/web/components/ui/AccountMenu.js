"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  MdDashboard,
  MdLogin,
  MdLogout,
  MdPerson,
  MdSettings,
} from "react-icons/md";
import { useAuth } from "@/components/auth/AuthContext";
import AppButton from "@/components/ui/AppButton";
import { flushPendingNavigationWork } from "@/components/schedule/useAutosaveNavigationGuard";

export default function AccountMenu({
  signedOutLabel = "Continue with email",
}) {
  const { user, loading, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const menuRef = useRef(null);
  const keyboardOpeningRef = useRef(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const closeOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target))
        setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuRef.current?.querySelector(".account-menu-trigger")?.focus();
      }
    };

    if (keyboardOpeningRef.current) {
      keyboardOpeningRef.current = false;
      menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    }

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const handleMenuKeyDown = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const items = [
      ...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? []),
    ];
    if (!items.length) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex;

    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "ArrowDown")
      nextIndex = (currentIndex + 1) % items.length;
    else nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;

    items[nextIndex]?.focus();
  };

  if (loading) return null;

  if (!user) {
    return (
      <nav className="app-header-auth" aria-label="Account">
        <Link className="app-header-signup" href="/login">
          <MdLogin aria-hidden="true" /> {signedOutLabel}
        </Link>
      </nav>
    );
  }

  return (
    <div className="account-menu" ref={menuRef}>
      <AppButton
        className="account-menu-trigger"
        variant="outlined"
        icon={<MdPerson />}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          keyboardOpeningRef.current = true;
          setOpen(true);
        }}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={open}
      >
        {user.displayName}
      </AppButton>
      {open && (
        <div
          className="account-menu-popover"
          id={menuId}
          role="menu"
          onKeyDown={handleMenuKeyDown}
        >
          <Link
            className="account-menu-item"
            href="/dashboard"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <MdDashboard aria-hidden="true" /> My Dashboard
          </Link>
          <Link
            className="account-menu-item"
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <MdSettings aria-hidden="true" /> Settings
          </Link>
          <button
            className="account-menu-item account-menu-item-danger"
            type="button"
            role="menuitem"
            disabled={logoutPending}
            onClick={async () => {
              setLogoutPending(true);
              setLogoutError("");
              try {
                const saved = await flushPendingNavigationWork();
                if (!saved) {
                  throw new Error(
                    "Your latest schedule changes could not be saved. Resolve the save error before logging out.",
                  );
                }
                await logout();
                setLogoutPending(false);
                setOpen(false);
              } catch (error) {
                setLogoutError(
                  error?.message ||
                    "Log out could not be confirmed. Please try again.",
                );
                setOpen(false);
                setLogoutPending(false);
              }
            }}
          >
            <MdLogout aria-hidden="true" />
            {logoutPending ? "Logging out…" : "Log out"}
          </button>
        </div>
      )}
      {logoutError && (
        <p className="account-menu-error" role="alert">
          {logoutError}
        </p>
      )}
    </div>
  );
}
