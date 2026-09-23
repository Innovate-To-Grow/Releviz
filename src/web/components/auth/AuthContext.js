"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import {
  changePasswordApi,
  deleteAccountApi,
  fetchAuthSession,
  fetchAuthSessions,
  fetchProfile,
  loginWithPassword,
  logoutApi,
  requestLoginCode,
  requestUnifiedEmailAuthCode,
  revokeAuthSessions,
  startRegistration,
  updateProfileApi,
  verifyLoginCode,
  verifyRegistration,
  verifyUnifiedEmailAuthCode,
} from "@/lib/api/auth";
import {
  clearAuthSession,
  getAccessToken,
  readAuthSession,
  refreshAuthSession,
  writeAuthSession,
} from "@/lib/api/config";
import { navigateTo } from "@/lib/navigation";

const AuthContext = createContext(null);

function subscribeAuth(callback) {
  /* istanbul ignore next -- server-side render guard */
  if (typeof window === "undefined") return () => {};
  window.addEventListener("releviz-auth", callback);
  return () => {
    window.removeEventListener("releviz-auth", callback);
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => readAuthSession());
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();
  const previousPathname = useRef(pathname);
  const lastValidatedAt = useRef(0);
  const validation = useRef(null);

  const loadSession = useCallback(() => {
    setSession(readAuthSession());
  }, []);

  useEffect(() => {
    return subscribeAuth(loadSession);
  }, [loadSession]);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      try {
        await refreshAuthSession();
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

  // A session revoked from another browser is only discovered by asking the
  // API: the cached access token still looks usable locally, and cached pages
  // make no authenticated request until the next mutation.
  const revalidateSession = useCallback(async ({ minInterval = 0 } = {}) => {
    if (!readAuthSession()) return;
    if (validation.current) return validation.current;
    if (Date.now() - lastValidatedAt.current < minInterval) return;
    validation.current = (async () => {
      try {
        await fetchAuthSession();
      } catch (error) {
        // Only a definitive 401 signs the browser out; a network blip or a
        // server error must not.
        if (error.status === 401) clearAuthSession();
      } finally {
        lastValidatedAt.current = Date.now();
        validation.current = null;
        setSession(readAuthSession());
      }
    })();
    return validation.current;
  }, []);

  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    revalidateSession();
  }, [pathname, revalidateSession]);

  useEffect(() => {
    /* istanbul ignore next -- server-side render guard */
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }
    const onFocus = () => {
      revalidateSession({ minInterval: 30_000 });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [revalidateSession]);

  const getToken = useCallback(async () => {
    return getAccessToken();
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

  const requestEmailAuthCode = useCallback(async (payload) => {
    return requestUnifiedEmailAuthCode(payload);
  }, []);

  const verifyEmailAuthCode = useCallback(async (payload) => {
    const data = await verifyUnifiedEmailAuthCode(payload);
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
    navigateTo("/");
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

  const listSessions = useCallback(async () => {
    return fetchAuthSessions();
  }, []);

  const revokeSession = useCallback(async (sessionId) => {
    const result = await revokeAuthSessions({ sessionId });
    if (result.currentRevoked) setSession(null);
    return result;
  }, []);

  const logoutAll = useCallback(async () => {
    await revokeAuthSessions({ all: true });
    setSession(null);
    navigateTo("/login?status=signed-out-all");
  }, []);

  const changePassword = useCallback(async (payload) => {
    const result = await changePasswordApi(payload);
    setSession(null);
    navigateTo("/login?status=password-changed");
    return result;
  }, []);

  const deleteAccount = useCallback(async (payload) => {
    const result = await deleteAccountApi(payload);
    setSession(null);
    navigateTo("/login?status=account-deleted");
    return result;
  }, []);

  const value = useMemo(
    () => ({
      user: session?.user || null,
      loading,
      nextStep: session?.nextStep || null,
      requiresProfileCompletion: session?.requiresProfileCompletion || false,
      login,
      requestEmailLoginCode,
      verifyEmailLoginCode,
      requestEmailAuthCode,
      verifyEmailAuthCode,
      signup,
      verifySignup,
      logout,
      updateProfile,
      refreshUser,
      listSessions,
      revokeSession,
      logoutAll,
      changePassword,
      deleteAccount,
      getToken,
    }),
    [
      session,
      loading,
      login,
      requestEmailLoginCode,
      verifyEmailLoginCode,
      requestEmailAuthCode,
      verifyEmailAuthCode,
      signup,
      verifySignup,
      logout,
      updateProfile,
      refreshUser,
      listSessions,
      revokeSession,
      logoutAll,
      changePassword,
      deleteAccount,
      getToken,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export default AuthContext;
