import { API_BASE, apiFetch, extractError } from "./config";

export async function fetchParticipants(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}`,
    {},
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function joinEvent(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function updateParticipant(code, participantId, data, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants/update?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) },
    token
  );
  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const error = new Error(
      payload?.error || payload?.detail || (payload ? "Request failed" : `HTTP ${res.status}`)
    );
    error.status = res.status;
    error.participant = payload?.participant || null;
    throw error;
  }
  return res.json();
}

export async function fetchParticipantsIncludeHidden(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}&includeHidden=true`,
    {},
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function unhideParticipant(code, participantId, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants/update/unhide?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
    { method: "PUT" },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function deleteParticipant(code, participantId, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants/update?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
    { method: "DELETE" },
    token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
