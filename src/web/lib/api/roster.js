import { API_BASE, apiFetch } from "./config";

function queryString(values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  return params.toString();
}

async function jsonOrError(res) {
  if (res.ok) return res.json();
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
  error.code = payload?.errorCode || payload?.code || null;
  error.participant = payload?.participant || null;
  error.import = payload?.import || null;
  throw error;
}

export async function createRosterImport(code, source, token) {
  const isFile = source?.file instanceof Blob;
  const body = isFile
    ? (() => {
        const form = new FormData();
        form.append("file", source.file);
        return form;
      })()
    : JSON.stringify({ sourceType: "paste", pastedText: source?.pastedText || "" });
  const res = await apiFetch(
    `${API_BASE}/events/roster-imports?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      ...(isFile ? {} : { headers: { "Content-Type": "application/json" } }),
      body,
    },
    token
  );
  return jsonOrError(res);
}

export async function configureRosterImport(code, importId, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events/roster-imports/${encodeURIComponent(importId)}?code=${encodeURIComponent(code)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  return jsonOrError(res);
}

export async function fetchRosterImportRows(
  code,
  importId,
  { page = 1, pageSize = 50 } = {},
  token
) {
  const query = queryString({ code, page, pageSize });
  const res = await apiFetch(
    `${API_BASE}/events/roster-imports/${encodeURIComponent(importId)}/rows?${query}`,
    {},
    token
  );
  return jsonOrError(res);
}

export async function commitRosterImport(code, importId, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events/roster-imports/${encodeURIComponent(importId)}/commit?code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  return jsonOrError(res);
}

export async function cancelRosterImport(code, importId, token) {
  const res = await apiFetch(
    `${API_BASE}/events/roster-imports/${encodeURIComponent(importId)}?code=${encodeURIComponent(code)}`,
    { method: "DELETE" },
    token
  );
  return jsonOrError(res);
}

export async function fetchRoster(
  code,
  {
    page = 1,
    pageSize = 50,
    search,
    group,
    submitted,
    invitationStatus,
    accountAccess,
    included,
  } = {},
  token
) {
  const query = queryString({
    code,
    page,
    pageSize,
    search,
    group,
    submitted,
    invitationStatus,
    accountAccess,
    included,
  });
  const res = await apiFetch(`${API_BASE}/events/roster?${query}`, {}, token);
  return jsonOrError(res);
}

export async function fetchRosterSchedule(code, participantId, token) {
  const res = await apiFetch(
    `${API_BASE}/events/roster/${encodeURIComponent(participantId)}/schedule?code=${encodeURIComponent(code)}`,
    {},
    token
  );
  return jsonOrError(res);
}

export async function patchRosterParticipant(code, participantId, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events/roster/${encodeURIComponent(participantId)}?code=${encodeURIComponent(code)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  return jsonOrError(res);
}

export async function patchRosterBulk(code, payload, token) {
  const res = await apiFetch(
    `${API_BASE}/events/roster/bulk?code=${encodeURIComponent(code)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
  return jsonOrError(res);
}
