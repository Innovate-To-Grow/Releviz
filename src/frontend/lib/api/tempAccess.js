import { API_BASE, extractError } from "@/lib/api/config";

async function tempAccessFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.clone().json();
    } catch {
      payload = null;
    }
    const error = new Error(
      payload?.error || payload?.detail || (await extractError(response)) || "Request failed"
    );
    error.status = response.status;
    error.participant = payload?.participant || null;
    throw error;
  }

  if (response.status === 204) return {};
  return response.json();
}

export function requestTempAccessCode({ code, invitationToken }) {
  return tempAccessFetch("/events/temp-access/request-code", {
    method: "POST",
    body: JSON.stringify({ code, invitationToken }),
  });
}

export function verifyTempAccess({ code, invitationToken, verificationCode }) {
  return tempAccessFetch("/events/temp-access/verify", {
    method: "POST",
    body: JSON.stringify({ code, invitationToken, verificationCode }),
  });
}

export function fetchTempAccessSession(code) {
  return tempAccessFetch(`/events/temp-access/session?code=${encodeURIComponent(code)}`);
}

export function updateTempAccessParticipant(code, data) {
  return tempAccessFetch(`/events/temp-access/participant?code=${encodeURIComponent(code)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function logoutTempAccess(code) {
  return tempAccessFetch("/events/temp-access/logout", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}
