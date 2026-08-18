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

function payloadMessage(payload, status) {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!payload || typeof payload !== "object") return `HTTP ${status}`;
  if (typeof payload.error === "string" && payload.error) return payload.error;
  if (typeof payload.detail === "string" && payload.detail)
    return payload.detail;
  const firstKey = Object.keys(payload)[0];
  const firstValue = firstKey ? payload[firstKey] : null;
  if (Array.isArray(firstValue)) return firstValue.join(" ");
  if (typeof firstValue === "string" && firstValue) return firstValue;
  return "Request failed";
}

async function invitationRequestError(res) {
  let payload = null;
  if (typeof res.text === "function") {
    try {
      const text = await res.text();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
    } catch {
      payload = null;
    }
  } else {
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
  }

  const metadata = payload && typeof payload === "object" ? payload : null;
  const error = new Error(payloadMessage(payload, res.status));
  error.status = res.status;
  error.errorCode = metadata?.errorCode ?? metadata?.code ?? null;
  error.event = metadata?.event ?? null;
  error.participant = metadata?.participant ?? null;
  error.payload = payload;
  return error;
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
    accessMode = "invite_only",
    meetingDurationMinutes = 30,
    status = "active",
  },
  token,
) {
  const res = await apiFetch(
    `${API_BASE}/events`,
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
        accessMode,
        meetingDurationMinutes,
        status,
      }),
    },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchEvent(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events?code=${encodeURIComponent(code)}`,
    {},
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function updateEvent(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events?code=${encodeURIComponent(code)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token,
  );
  if (!res.ok) throw await eventMutationError(res);
  return res.json();
}

export async function duplicateEvent(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events/duplicate?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token,
  );
  if (!res.ok) throw await eventMutationError(res);
  return res.json();
}

export async function deleteEvent(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events?code=${encodeURIComponent(code)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token,
  );
  if (!res.ok) throw await eventMutationError(res);
  return res.json();
}

export async function fetchEventResults(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events/results?code=${encodeURIComponent(code)}`,
    {},
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function previewFinalMeeting(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events/finalization/preview?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function confirmFinalMeeting(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events/finalization?code=${encodeURIComponent(code)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchFinalization(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events/finalization?code=${encodeURIComponent(code)}`,
    {},
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function updateEventLifecycle(
  code,
  { status, expectedVersion, responseDeadline },
  token,
) {
  const res = await apiFetch(
    `${API_BASE}/events/lifecycle?code=${encodeURIComponent(code)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, expectedVersion, responseDeadline }),
    },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchInvitations(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events/invitations?code=${encodeURIComponent(code)}`,
    {},
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function markInvitationOpened(code, invitationToken) {
  const res = await apiFetch(`${API_BASE}/events/invitations/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, token: invitationToken }),
    // This endpoint is intentionally public. Avoid delaying it behind a
    // refresh request, and let the small telemetry write finish if the link
    // immediately redirects an unauthenticated visitor to sign in.
    skipAuthRefresh: true,
    keepalive: true,
  });
  if (!res.ok) throw new Error(await extractError(res));
  return true;
}

export async function sendInvitations(
  code,
  { emails, message = "", idempotencyKey },
  token,
) {
  const res = await apiFetch(
    `${API_BASE}/events/invitations?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails, message, idempotencyKey }),
    },
    token,
  );
  if (!res.ok) throw await invitationRequestError(res);
  return res.json();
}

export async function sendReminders(code, { idempotencyKey }, token) {
  const res = await apiFetch(
    `${API_BASE}/events/reminders?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey }),
    },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchDeliveryRequest(requestId, token) {
  const res = await apiFetch(
    `${API_BASE}/events/delivery-requests/${encodeURIComponent(requestId)}`,
    {},
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function retryDeliveryRequest(requestId, token) {
  const res = await apiFetch(
    `${API_BASE}/events/delivery-requests/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function downloadFinalCalendar(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events/finalization/calendar?code=${encodeURIComponent(code)}`,
    {},
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  const disposition = res.headers?.get?.("content-disposition") || "";
  const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
  return {
    blob: await res.blob(),
    filename: filenameMatch?.[1] || `${code}.ics`,
  };
}
