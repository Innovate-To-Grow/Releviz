"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import {
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  signup as apiSignup,
} from "@/lib/api/auth";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMe()
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async ({ email, password }) => {
    const { user: u } = await apiLogin({ email, password });
    setUser(u);
    return u;
  }, []);

  const signup = useCallback(async ({ email, password, displayName }) => {
    const { user: u } = await apiSignup({ email, password, displayName });
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const u = await fetchMe();
      setUser(u);
    } catch {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export default AuthContext;
