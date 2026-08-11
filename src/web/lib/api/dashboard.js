import { API_BASE, apiFetch, extractError } from "./config";

export async function fetchDashboardEvents(token) {
  const res = await apiFetch(`${API_BASE}/dashboard/events`, {}, token);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
