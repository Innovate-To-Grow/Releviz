import { API_BASE, extractError } from "./config";

export async function fetchDashboardEvents() {
  const res = await fetch(`${API_BASE}/api/dashboard/events`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
