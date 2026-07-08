"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  fetchProfile,
  loginWithPassword,
  logoutApi,
  requestLoginCode,
  startRegistration,
  updateProfileApi,
  verifyLoginCode,
  verifyRegistration,
} from "@/lib/api/auth";
import { clearAuthSession, readAuthSession, writeAuthSession } from "@/lib/api/config";

const AuthContext = createContext(null);

function subscribeAuth(callback) {
  /* istanbul ignore next -- server-side render guard */
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  window.addEventListener("releviz-auth", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("releviz-auth", callback);
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadSession = useCallback(() => {
    setSession(readAuthSession());
  }, []);

  useEffect(() => {
    loadSession();
    return subscribeAuth(loadSession);
  }, [loadSession]);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      const current = readAuthSession();
      if (!current?.access) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        await fetchProfile();
      } catch {
        clearAuthSession();
      } finally {
        if (!cancelled) {
          setSession(readAuthSession());
          setLoading(false);
        }
      }
    }
    hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const getToken = useCallback(async () => {
    return readAuthSession()?.access || null;
  }, []);

  const login = useCallback(async (credentials) => {
    const data = await loginWithPassword(credentials);
    setSession(readAuthSession());
    return data;
  }, []);

  const requestEmailLoginCode = useCallback(async (payload) => {
    return requestLoginCode(payload);
  }, []);

  const verifyEmailLoginCode = useCallback(async (payload) => {
    const data = await verifyLoginCode(payload);
    setSession(readAuthSession());
    return data;
  }, []);

  const signup = useCallback(async (payload) => {
    return startRegistration(payload);
  }, []);

  const verifySignup = useCallback(async (payload) => {
    const data = await verifyRegistration(payload);
    setSession(readAuthSession());
    return data;
  }, []);

  const logout = useCallback(async () => {
    await logoutApi();
    setSession(null);
    window.location.assign("/");
  }, []);

  const updateProfile = useCallback(async (updates) => {
    const user = await updateProfileApi(updates);
    const current = readAuthSession();
    if (current) writeAuthSession({ ...current, user });
    setSession(readAuthSession());
    return user;
  }, []);

  const refreshUser = useCallback(async () => {
    const user = await fetchProfile();
    setSession(readAuthSession());
    return user;
  }, []);

  const value = useMemo(
    () => ({
      user: session?.user || null,
      loading,
      login,
      requestEmailLoginCode,
      verifyEmailLoginCode,
      signup,
      verifySignup,
      logout,
      updateProfile,
      refreshUser,
      getToken,
    }),
    [
      session,
      loading,
      login,
      requestEmailLoginCode,
      verifyEmailLoginCode,
      signup,
      verifySignup,
      logout,
      updateProfile,
      refreshUser,
      getToken,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export default AuthContext;
