const defaultApiBase =
  process.env.NODE_ENV === "production"
    ? "https://api.releviz.com"
    : process.env.NODE_ENV === "test"
      ? ""
      : "http://localhost:4000";

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || defaultApiBase).replace(
  /\/+$/,
  ""
);
export const LEGACY_AUTH_SESSION_KEY = "releviz.auth";

let authSession = null;
let refreshPromise = null;

function notifyAuthChanged() {
  /* istanbul ignore next -- server-side render guard */
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("releviz-auth"));
}

function removeLegacyStoredCredentials() {
  /* istanbul ignore next -- server-side render guard */
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LEGACY_AUTH_SESSION_KEY);
  window.sessionStorage.removeItem(LEGACY_AUTH_SESSION_KEY);
}

export function readAuthSession() {
  removeLegacyStoredCredentials();
  return authSession;
}

export function writeAuthSession(session) {
  removeLegacyStoredCredentials();
  authSession = session
    ? {
        access: session.access || null,
        accessExpiresAt: session.accessExpiresAt || null,
        session: session.session || null,
        user: session.user || null,
      }
    : null;
  notifyAuthChanged();
}

export function clearAuthSession() {
  removeLegacyStoredCredentials();
  authSession = null;
  notifyAuthChanged();
}

export async function extractError(res) {
  try {
    const body = await res.json();
    if (body.error) return body.error;
    if (body.detail) return body.detail;
    const firstKey = Object.keys(body)[0];
    const firstValue = firstKey ? body[firstKey] : null;
    if (Array.isArray(firstValue)) return firstValue.join(" ");
    if (typeof firstValue === "string") return firstValue;
    return "Request failed";
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function refreshAuthSession() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const res = await fetch(`${API_BASE}/authn/refresh/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "include",
    });

    if (!res.ok) {
      clearAuthSession();
      return null;
    }

    const data = await res.json();
    writeAuthSession(data);
    return readAuthSession();
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function accessIsUsable(session) {
  if (!session?.access) return false;
  if (!session.accessExpiresAt) return true;
  const expiresAt = Date.parse(session.accessExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 15_000;
}

export async function getAccessToken() {
  const current = readAuthSession();
  if (accessIsUsable(current)) return current.access;
  const refreshed = await refreshAuthSession();
  return refreshed?.access || null;
}

export async function apiFetch(url, options = {}, token = null) {
  const access =
    token || (options.skipAuthRefresh ? readAuthSession()?.access : await getAccessToken());
  const headers = {
    ...(options.headers || {}),
    ...(access ? { Authorization: `Bearer ${access}` } : {}),
  };

  let res = await fetch(url, { ...options, headers, credentials: "include" });
  if (res.status !== 401 || options.skipAuthRefresh || !access) return res;

  const refreshed = await refreshAuthSession();
  if (!refreshed?.access) return res;

  res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${refreshed.access}`,
    },
    credentials: "include",
  });
  return res;
}
