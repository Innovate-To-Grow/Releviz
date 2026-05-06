export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

export async function extractError(res) {
  try {
    return (await res.json()).error ?? "Request failed";
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function apiFetch(url, options = {}, token = null) {
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, { ...options, headers, credentials: "include" });
  return res;
}
