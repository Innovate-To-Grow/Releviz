"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import { ButtonLink } from "@/components/ui/Button";
import Menu, {
  MenuItem,
  MenuLabel,
  MenuLink,
  MenuSeparator,
} from "@/components/ui/Menu";
import { flushPendingNavigationWork } from "@/components/schedule/useAutosaveNavigationGuard";

export default function AccountMenu({
  signedOutLabel = "Continue with email",
}) {
  const { user, loading, logout } = useAuth();
  const [logoutError, setLogoutError] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);

  if (loading) return null;

  if (!user) {
    return (
      <nav aria-label="Account">
        <ButtonLink href="/login" variant="primary" size="sm">
          {signedOutLabel}
        </ButtonLink>
      </nav>
    );
  }

  const runLogout = async (close) => {
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
      close();
    } catch (error) {
      setLogoutError(
        error?.message || "Log out could not be confirmed. Please try again.",
      );
      close();
      setLogoutPending(false);
    }
  };

  return (
    <>
      <Menu
        label={user.displayName}
        triggerVariant="secondary"
        triggerSize="sm"
      >
        {({ close }) => (
          <>
            <MenuLabel>{user.email || user.displayName}</MenuLabel>
            <MenuLink href="/dashboard" icon="calendar" onClick={close}>
              My Dashboard
            </MenuLink>
            <MenuLink href="/settings" icon="settings" onClick={close}>
              Settings
            </MenuLink>
            <MenuSeparator />
            <MenuItem
              icon="logOut"
              danger
              disabled={logoutPending}
              onClick={() => runLogout(close)}
            >
              {logoutPending ? "Logging out…" : "Log out"}
            </MenuItem>
          </>
        )}
      </Menu>
      {logoutError && (
        <p className="rv-field__error" role="alert">
          {logoutError}
        </p>
      )}
    </>
  );
}
