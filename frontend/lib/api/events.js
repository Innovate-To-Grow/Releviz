import { API_BASE, extractError } from "./config";

export async function createEvent({
  name,
  startHour,
  endHour,
  days,
  mode,
  location,
  participantViewPermission,
  daySelectionType,
  specificDates,
}) {
  const res = await fetch(`${API_BASE}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      name,
      startHour,
      endHour,
      days,
      mode,
      location,
      participantViewPermission,
      daySelectionType,
      specificDates,
    }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchEvent(code) {
  const res = await fetch(`${API_BASE}/api/events?code=${encodeURIComponent(code)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
