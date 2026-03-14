import { API_BASE, extractError } from "./config";

export async function fetchWeights(code) {
  const res = await fetch(`${API_BASE}/api/events/weights?code=${encodeURIComponent(code)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function updateWeights(code, weights) {
  const res = await fetch(`${API_BASE}/api/events/weights?code=${encodeURIComponent(code)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ weights }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
