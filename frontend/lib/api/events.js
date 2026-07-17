import { API_BASE, apiFetch, extractError } from "./config";

async function eventMutationError(res) {
  try {
    const body = await res.json();
    const error = new Error(body.error || body.detail || "Request failed");
    error.status = res.status;
    error.event = body.event || null;
    error.requiresResponseReset = Boolean(body.requiresResponseReset);
    error.participantCount = body.participantCount || 0;
    error.retryable = Boolean(body.retryable);
    return error;
  } catch {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    return error;
  }
}

export async function createEvent(
  {
    name,
    startTime,
    endTime,
    slotMinutes,
    days,
    mode,
    location,
    participantViewPermission,
    daySelectionType,
    specificDates,
    responseDeadline,
    timezone,
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
        startTime,
        endTime,
        slotMinutes,
        days,
        mode,
        location,
        participantViewPermission,
        daySelectionType,
        specificDates,
        responseDeadline,
        timezone,
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

export async function updateEvent(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events?code=${encodeURIComponent(code)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  if (!res.ok) throw await eventMutationError(res);
  return res.json();
}

export async function duplicateEvent(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/duplicate?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  if (!res.ok) throw await eventMutationError(res);
  return res.json();
}

export async function deleteEvent(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events?code=${encodeURIComponent(code)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  if (!res.ok) throw await eventMutationError(res);
  return res.json();
}

export async function fetchEventResults(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/results?code=${encodeURIComponent(code)}`,
    {},
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function previewFinalMeeting(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/finalization/preview?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function confirmFinalMeeting(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/finalization?code=${encodeURIComponent(code)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchFinalization(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/finalization?code=${encodeURIComponent(code)}`,
    {},
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function updateEventLifecycle(
  code,
  { status, expectedVersion, responseDeadline },
  token
) {
  const res = await apiFetch(
    `${API_BASE}/api/events/lifecycle?code=${encodeURIComponent(code)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, expectedVersion, responseDeadline }),
    },
    token
  );
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

export async function markInvitationOpened(code, invitationToken) {
  const res = await apiFetch(`${API_BASE}/api/events/invitations/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, token: invitationToken }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return true;
}

export async function sendInvitations(code, { emails, message = "", idempotencyKey }, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/invitations?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails, message, idempotencyKey }),
    },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function sendReminders(code, { idempotencyKey }, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/reminders?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey }),
    },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
