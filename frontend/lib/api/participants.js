import { API_BASE, apiFetch, extractError } from "./config";

export async function fetchParticipants(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}`, {}, token
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
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function fetchParticipantsIncludeHidden(code, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}&includeHidden=true`,
    {}, token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function unhideParticipant(code, participantId, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants/update/unhide?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
    { method: "PUT" }, token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function deleteParticipant(code, participantId, token) {
  const res = await apiFetch(
    `${API_BASE}/api/events/participants/update?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
    { method: "DELETE" }, token
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

// import { API_BASE, extractError } from "./config";

// export async function fetchParticipants(code) {
//   const res = await fetch(`${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}`, {
//     credentials: "include",
//   });
//   if (!res.ok) throw new Error(await extractError(res));
//   return res.json();
// }

// export async function joinEvent(code) {
//   const res = await fetch(`${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     credentials: "include",
//     body: JSON.stringify({}),
//   });
//   if (!res.ok) throw new Error(await extractError(res));
//   return res.json();
// }

// export async function updateParticipant(code, participantId, data) {
//   const res = await fetch(
//     `${API_BASE}/api/events/participants/update?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
//     {
//       method: "PUT",
//       headers: { "Content-Type": "application/json" },
//       credentials: "include",
//       body: JSON.stringify(data),
//     }
//   );
//   if (!res.ok) throw new Error(await extractError(res));
//   return res.json();
// }

// export async function fetchParticipantsIncludeHidden(code) {
//   const res = await fetch(
//     `${API_BASE}/api/events/participants?code=${encodeURIComponent(code)}&includeHidden=true`,
//     { credentials: "include" }
//   );
//   if (!res.ok) throw new Error(await extractError(res));
//   return res.json();
// }

// export async function unhideParticipant(code, participantId) {
//   const res = await fetch(
//     `${API_BASE}/api/events/participants/update/unhide?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
//     { method: "PUT", credentials: "include" }
//   );
//   if (!res.ok) throw new Error(await extractError(res));
//   return res.json();
// }

// export async function deleteParticipant(code, participantId) {
//   const res = await fetch(
//     `${API_BASE}/api/events/participants/update?code=${encodeURIComponent(code)}&participantId=${encodeURIComponent(participantId)}`,
//     { method: "DELETE", credentials: "include" }
//   );
//   if (!res.ok) throw new Error(await extractError(res));
//   return res.json();
// }
