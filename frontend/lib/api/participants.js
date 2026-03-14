import { API_BASE, extractError } from "./config";

export async function fetchParticipants(code) {
  const res = await fetch(`${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function joinEvent(code, name) {
  const res = await fetch(`${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function updateParticipant(code, name, data) {
  const res = await fetch(
    `${API_BASE}/api/events/participants/update?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchParticipantsIncludeHidden(code) {
  const res = await fetch(
    `${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}&includeHidden=true`,
    { credentials: "include" }
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function unhideParticipant(code, name) {
  const res = await fetch(
    `${API_BASE}/api/events/participants/update/unhide?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`,
    { method: "PUT", credentials: "include" }
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function deleteParticipant(code, name) {
  const res = await fetch(
    `${API_BASE}/api/events/participants/update?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`,
    { method: "DELETE", credentials: "include" }
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
