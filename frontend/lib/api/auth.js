import {
  API_BASE,
  apiFetch,
  clearAuthSession,
  extractError,
  readAuthSession,
  writeAuthSession,
} from "@/lib/api/config";

async function parseAuthResponse(res) {
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  if (data.access && data.refresh) {
    writeAuthSession({
      access: data.access,
      refresh: data.refresh,
      user: data.user,
    });
  }
  return data;
}

export async function loginWithPassword({ email, password }) {
  const res = await fetch(`${API_BASE}/authn/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseAuthResponse(res);
}

export async function requestLoginCode({ email }) {
  const res = await fetch(`${API_BASE}/authn/login/request-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function verifyLoginCode({ email, code }) {
  const res = await fetch(`${API_BASE}/authn/login/verify-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  return parseAuthResponse(res);
}

export async function startRegistration(payload) {
  const res = await fetch(`${API_BASE}/authn/register/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function verifyRegistration({ email, code }) {
  const res = await fetch(`${API_BASE}/authn/register/verify-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  return parseAuthResponse(res);
}

export async function fetchProfile() {
  const res = await apiFetch(`${API_BASE}/authn/profile/`);
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  const session = readAuthSession();
  if (session) writeAuthSession({ ...session, user: data.user });
  return data.user;
}

export async function updateProfileApi(payload) {
  const res = await apiFetch(`${API_BASE}/authn/profile/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  const session = readAuthSession();
  if (session) writeAuthSession({ ...session, user: data.user });
  return data.user;
}

export async function logoutApi() {
  const session = readAuthSession();
  if (session?.access) {
    await apiFetch(
      `${API_BASE}/authn/logout/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: session.refresh }),
        skipAuthRefresh: true,
      },
      session.access
    ).catch(() => {});
  }
  clearAuthSession();
}
