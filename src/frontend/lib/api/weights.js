import { API_BASE, apiFetch, extractError } from "./config";

export async function fetchWeights(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events/weights?code=${encodeURIComponent(code)}`,
    {},
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function updateWeights(code, weights, token) {
  const res = await apiFetch(
    `${API_BASE}/events/weights?code=${encodeURIComponent(code)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weights }),
    },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
