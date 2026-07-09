import { API_BASE, apiFetch, extractError } from "./config";

export async function createEvent(
  {
    name,
    startHour,
    endHour,
    days,
    mode,
    location,
    participantViewPermission,
    daySelectionType,
    specificDates,
    responseDeadline,
    remindersEnabled,
    reminderHoursBefore,
  },
  token
) {
  const res = await apiFetch(
    `${API_BASE}/api/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
        responseDeadline,
        remindersEnabled,
        reminderHoursBefore,
      }),
    },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchEvent(code, token) {
  const res = await apiFetch(`${API_BASE}/api/events?code=${encodeURIComponent(code)}`, {}, token);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchInvitations(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/invitations?code=${encodeURIComponent(code)}`,
    {},
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function sendInvitations(code, { emails, message = "" }, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/invitations?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails, message }),
    },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function sendReminders(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/reminders?code=${encodeURIComponent(code)}`,
    { method: "POST" },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
