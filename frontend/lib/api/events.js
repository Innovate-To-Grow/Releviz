import { API_BASE, extractError } from "./config";

export async function createEvent({
  name,
  password,
  startHour,
  endHour,
  days,
  mode,
  location,
  participantVerification,
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
      password,
      startHour,
      endHour,
      days,
      mode,
      location,
      participantVerification,
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

export async function verifyEvent(code, password) {
  const res = await fetch(`${API_BASE}/api/events/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ code, password }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
