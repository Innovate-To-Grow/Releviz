"use client";

import { createContext, useContext, useMemo, useCallback } from "react";
import { useClerk, useUser } from "@clerk/nextjs";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const { isLoaded, user: clerkUser } = useUser();
  // const { signOut } = useClerk();
  const { signOut, session } = useClerk();

  const user = useMemo(() => {
    if (!clerkUser) return null;

    const email = clerkUser.primaryEmailAddress?.emailAddress || "";
    const displayName = clerkUser.fullName || clerkUser.username || email.split("@")[0] || "User";

    return {
      id: clerkUser.id,
      email,
      displayName,
      createdAt: clerkUser.createdAt ? new Date(clerkUser.createdAt).toISOString() : null,
      imageUrl: clerkUser.imageUrl || null,
    };
  }, [clerkUser]);

  const getToken = useCallback(async () => {
    if (!session) return null;
    return session.getToken();
  }, [session]);

  const logout = useCallback(async () => {
    await signOut({ redirectUrl: "/login" });
  }, [signOut]);

  const login = useCallback(async () => {
    window.location.assign("/login");
  }, []);

  const signup = useCallback(async () => {
    window.location.assign("/signup");
  }, []);

  const refreshUser = useCallback(async () => {
    return user;
  }, [user]);

  const value = useMemo(
    () => ({
      user,
      loading: !isLoaded,
      login,
      signup,
      logout,
      refreshUser,
      getToken,
    }),
    [user, isLoaded, login, signup, logout, refreshUser, getToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export default AuthContext;
