"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import {
  AccountIcon,
  ChevronDownIcon,
  DashboardIcon,
  SettingsIcon,
  SignInIcon,
  SignOutIcon,
} from "@/components/ui/icons";
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
        <Link className="btn btn-outline-primary app-btn" href="/login">
          <span className="app-btn-icon" aria-hidden="true">
            <SignInIcon />
          </span>
          <span className="app-btn-label">{signedOutLabel}</span>
        </Link>
      </nav>
    );
  }

  return (
    <div
      className={`account-menu dropdown${open ? " show" : ""}`}
      ref={menuRef}
    >
      <AppButton
        className="account-menu-trigger"
        variant="outlined"
        icon={<AccountIcon />}
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
        <span className="account-menu-trigger__name">{user.displayName}</span>
        <span className="app-btn-icon ms-1" aria-hidden="true">
          <ChevronDownIcon size="0.8em" />
        </span>
      </AppButton>
      {open && (
        <div
          className="dropdown-menu dropdown-menu-end show"
          id={menuId}
          role="menu"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="dropdown-header">
            <span className="d-block text-truncate fw-semibold text-body">
              {user.displayName}
            </span>
            {user.email && (
              <span className="d-block text-truncate small">{user.email}</span>
            )}
          </div>
          <div className="dropdown-divider" />
          <Link
            className="dropdown-item d-flex align-items-center gap-2"
            href="/dashboard"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <DashboardIcon aria-hidden="true" /> My Dashboard
          </Link>
          <Link
            className="dropdown-item d-flex align-items-center gap-2"
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <SettingsIcon aria-hidden="true" /> Settings
          </Link>
          <div className="dropdown-divider" />
          <button
            className="dropdown-item d-flex align-items-center gap-2 text-danger"
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
            <SignOutIcon aria-hidden="true" />
            {logoutPending ? "Logging out…" : "Log out"}
          </button>
        </div>
      )}
      {logoutError && (
        <Alert
          variant="danger"
          className="account-menu-error shadow-sm"
          actions={
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={() => setLogoutError("")}
            >
              Dismiss
            </button>
          }
        >
          {logoutError}
        </Alert>
      )}
    </div>
  );
}
