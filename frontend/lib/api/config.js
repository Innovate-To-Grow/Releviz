export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";
export const AUTH_SESSION_KEY = "releviz.auth";

export function readAuthSession() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeAuthSession(session) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event("releviz-auth"));
}

export function clearAuthSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_SESSION_KEY);
  window.dispatchEvent(new Event("releviz-auth"));
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

async function refreshSession() {
  const session = readAuthSession();
  if (!session?.refresh) return null;

  const res = await fetch(`${API_BASE}/authn/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: session.refresh }),
  });

  if (!res.ok) {
    clearAuthSession();
    return null;
  }

  const data = await res.json();
  const next = {
    ...session,
    access: data.access,
    refresh: data.refresh || session.refresh,
  };
  writeAuthSession(next);
  return next;
}

export async function apiFetch(url, options = {}, token = null) {
  const session = readAuthSession();
  const access = token || session?.access || null;
  const headers = {
    ...(options.headers || {}),
    ...(access ? { Authorization: `Bearer ${access}` } : {}),
  };

  let res = await fetch(url, { ...options, headers, credentials: "include" });
  if (res.status !== 401 || options.skipAuthRefresh) return res;

  const refreshed = await refreshSession();
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
