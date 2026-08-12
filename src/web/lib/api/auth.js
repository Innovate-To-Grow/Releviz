import {
  API_BASE,
  apiFetch,
  clearAuthSession,
  extractError,
  readAuthSession,
  writeAuthSession,
} from "@/lib/api/config";
import { normalizeAuthUser } from "@/lib/authUser";

function writeProfileSession(session, user) {
  if (!session) return;
  const profileComplete = Boolean(
    user?.firstName?.trim() && user?.lastName?.trim(),
  );
  writeAuthSession({
    ...session,
    user,
    next_step: profileComplete ? "account" : "complete_profile",
    requires_profile_completion: !profileComplete,
  });
}

async function parseAuthResponse(res) {
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  if (data.access) {
    writeAuthSession({
      ...data,
      user: normalizeAuthUser(data.user),
    });
  }
  return data;
}

function decodePublicKey(pem) {
  const encoded = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const binary = globalThis.atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeCiphertext(ciphertext) {
  const bytes = new Uint8Array(ciphertext);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

async function securePasswordPayload(payload, fields) {
  const res = await fetch(`${API_BASE}/authn/public-key/`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  const config = await res.json();
  if (!config.password_encryption_required) return payload;

  try {
    const key = await globalThis.crypto.subtle.importKey(
      "spki",
      decodePublicKey(config.public_key),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const secured = { ...payload, key_id: config.key_id };
    for (const field of fields) {
      const ciphertext = await globalThis.crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        key,
        new TextEncoder().encode(String(secured[field])),
      );
      secured[field] = encodeCiphertext(ciphertext);
    }
    return secured;
  } catch {
    throw new Error("Unable to secure password for transmission.");
  }
}

export async function loginWithPassword({ email, password }) {
  const payload = await securePasswordPayload({ email, password }, [
    "password",
  ]);
  const res = await fetch(`${API_BASE}/authn/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "include",
  });
  return parseAuthResponse(res);
}

export async function requestLoginCode({ email }) {
  const res = await fetch(`${API_BASE}/authn/login/request-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function verifyLoginCode({ email, code }) {
  const res = await fetch(`${API_BASE}/authn/login/verify-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
    credentials: "include",
  });
  return parseAuthResponse(res);
}

export async function requestUnifiedEmailAuthCode({
  email,
  source,
  event,
  next,
}) {
  const res = await fetch(`${API_BASE}/authn/email-auth/request-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      ...(source ? { source } : {}),
      ...(event ? { event } : {}),
      ...(next ? { next } : {}),
    }),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function verifyUnifiedEmailAuthCode({ email, code }) {
  const res = await fetch(`${API_BASE}/authn/email-auth/verify-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
    credentials: "include",
  });
  return parseAuthResponse(res);
}

async function postRegistration(path, payload) {
  const securedPayload = await securePasswordPayload(payload, [
    "password",
    "password_confirm",
  ]);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(securedPayload),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export function startRegistration(payload) {
  return postRegistration("/authn/register/", payload);
}

export function startTemporaryUpgradeRegistration(code, payload) {
  return postRegistration(
    `/events/temp-access/upgrade-registration?code=${encodeURIComponent(code)}`,
    payload,
  );
}

export async function verifyRegistration({ email, code }) {
  const res = await fetch(`${API_BASE}/authn/register/verify-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
    credentials: "include",
  });
  return parseAuthResponse(res);
}

export async function requestPasswordResetCode({ email }) {
  const res = await fetch(`${API_BASE}/authn/password-reset/request-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function confirmPasswordReset({
  email,
  code,
  password,
  passwordConfirm,
}) {
  const payload = await securePasswordPayload(
    {
      email,
      code,
      password,
      password_confirm: passwordConfirm,
    },
    ["password", "password_confirm"],
  );
  const res = await fetch(`${API_BASE}/authn/password-reset/confirm/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  clearAuthSession();
  return data;
}

export async function fetchProfile() {
  const res = await apiFetch(`${API_BASE}/authn/profile/`);
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  const user = normalizeAuthUser(data.user || data);
  const session = readAuthSession();
  writeProfileSession(session, user);
  return user;
}

export async function updateProfileApi(payload) {
  const res = await apiFetch(`${API_BASE}/authn/profile/`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  const user = normalizeAuthUser(data.user || data);
  const session = readAuthSession();
  writeProfileSession(session, user);
  return user;
}

export async function fetchAuthSessions() {
  const res = await apiFetch(`${API_BASE}/authn/sessions/`);
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  return data.sessions || [];
}

export async function revokeAuthSessions({ sessionId = "", all = false }) {
  const res = await apiFetch(`${API_BASE}/authn/sessions/`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(all ? { all: true } : { sessionId }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  if (data.currentRevoked) clearAuthSession();
  return data;
}

export async function changePasswordApi({
  currentPassword,
  newPassword,
  newPasswordConfirm,
}) {
  const payload = await securePasswordPayload(
    {
      current_password: currentPassword,
      new_password: newPassword,
      new_password_confirm: newPasswordConfirm,
    },
    ["current_password", "new_password", "new_password_confirm"],
  );
  const res = await apiFetch(`${API_BASE}/authn/change-password/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  clearAuthSession();
  return data;
}

export async function deleteAccountApi({ password, confirmation }) {
  const payload = await securePasswordPayload({ password, confirmation }, [
    "password",
  ]);
  const res = await apiFetch(`${API_BASE}/authn/delete-account/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  clearAuthSession();
  return data;
}

export async function logoutApi() {
  await fetch(`${API_BASE}/authn/logout/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    credentials: "include",
  }).catch(() => {});
  clearAuthSession();
}
