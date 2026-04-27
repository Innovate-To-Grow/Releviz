import { API_BASE, apiFetch, extractError } from "./config";

export async function fetchDashboardEvents(token) {
  const res = await apiFetch(`${API_BASE}/api/dashboard/events`, {}, token);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
  // const res = await fetch(`${API_BASE}/api/dashboard/events`, {
  //   credentials: "include",
  // });
  // if (!res.ok) throw new Error(await extractError(res));
  // return res.json();
}
