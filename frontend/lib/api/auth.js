import { API_BASE, extractError } from "./config";

export async function signup({ email, password, displayName }) {
  const res = await fetch(`${API_BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function login({ email, password }) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function logout() {
  const res = await fetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchMe() {
  const res = await fetch(`${API_BASE}/api/auth/me`, {
    credentials: "include",
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.user;
}

export async function updateSettings({ displayName, currentPassword, newPassword }) {
  const res = await fetch(`${API_BASE}/api/auth/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ displayName, currentPassword, newPassword }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
