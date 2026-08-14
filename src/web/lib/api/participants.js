import { API_BASE, apiFetch, extractError } from "./config";

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

async function participantMutationError(res) {
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

export async function fetchParticipants(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events/participants?code=${encodeURIComponent(code)}`,
    {},
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchCurrentParticipant(code, token) {
  const data = await fetchParticipants(code, token);
  return {
    participant: data.participants?.[0] || null,
    scheduleDataIncluded: Boolean(data.scheduleDataIncluded),
  };
}

export async function joinEvent(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events/participants?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function createManagedParticipant(
  code,
  { name, email, idempotencyKey },
  token,
) {
  const res = await apiFetch(
    `${API_BASE}/events/participants/managed?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, idempotencyKey }),
    },
    token,
  );
  if (!res.ok) throw await participantMutationError(res);
  return res.json();
}

export async function updateParticipant(code, participantId, data, token) {
  const res = await apiFetch(
    `${API_BASE}/events/participants/update?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
    token,
  );
  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const error = new Error(
      payload?.error ||
        payload?.detail ||
        (payload ? "Request failed" : `HTTP ${res.status}`),
    );
    error.status = res.status;
    error.participant = payload?.participant || null;
    error.errorCode = payload?.errorCode ?? payload?.code ?? null;
    throw error;
  }
  return res.json();
}

export async function fetchParticipantsIncludeHidden(code, token) {
  const res = await apiFetch(
    `${API_BASE}/events/participants?code=${encodeURIComponent(code)}&includeHidden=true`,
    {},
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function unhideParticipant(code, participantId, token) {
  const res = await apiFetch(
    `${API_BASE}/events/participants/update/unhide?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
    { method: "PUT" },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function deleteParticipant(code, participantId, token) {
  const res = await apiFetch(
    `${API_BASE}/events/participants/update?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
    { method: "DELETE" },
    token,
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
