import {
  API_BASE,
  apiFetch,
  clearAuthSession,
  extractError,
  readAuthSession,
  writeAuthSession,
} from "@/lib/api/config";
import { normalizeAuthUser } from "@/lib/authUser";
import { retryAfterSeconds } from "@/lib/api/retryAfter";

async function codeRequestResponse(res) {
  let data;
  try {
    data = await res.json();
  } catch {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    error.retryAfterSeconds = retryAfterSeconds(res);
    throw error;
  }
  if (!res.ok) {
    const error = new Error(
      await extractError({ json: async () => data, status: res.status }),
    );
    error.status = res.status;
    error.retryAfterSeconds = retryAfterSeconds(res, data);
    throw error;
  }
  return data;
}

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

export async function impersonateLogin({ token }) {
  const res = await fetch(`${API_BASE}/authn/impersonate-login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
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
  return codeRequestResponse(res);
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
  return codeRequestResponse(res);
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

// A temporary member's upgrade sends its password and names here, together
// with the emailed code, so only the mailbox holder can choose them.
export async function verifyRegistration({ email, code, registration }) {
  const payload = registration
    ? await securePasswordPayload({ email, code, ...registration }, [
        "password",
        "password_confirm",
      ])
    : { email, code };
  const res = await fetch(`${API_BASE}/authn/register/verify-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

// Resetting takes two calls: the code is exchanged for a short-lived
// verification token, which then authorizes the new password. The exchange
// spends the code, while a refused password leaves the token unused, so the
// caller keeps the token for another try.
export async function verifyPasswordResetCode({ email, code }) {
  const res = await fetch(`${API_BASE}/authn/password-reset/verify-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  const { verification_token: verificationToken } = await res.json();
  return verificationToken;
}

export async function resetPasswordWithToken({
  email,
  verificationToken,
  password,
  passwordConfirm,
}) {
  const payload = await securePasswordPayload(
    {
      email,
      verification_token: verificationToken,
      new_password: password,
      new_password_confirm: passwordConfirm,
    },
    ["new_password", "new_password_confirm"],
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

// Liveness check for the current session. It deliberately never writes the
// session store: writing would change the user object identity and re-run
// every effect keyed on `user` (for example the dashboard fetch).
export async function fetchAuthSession() {
  const res = await apiFetch(`${API_BASE}/authn/session/`);
  if (!res.ok) {
    const error = new Error(await extractError(res));
    error.status = res.status;
    throw error;
  }
  return res.json();
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

export async function requestAccountDeletionCode() {
  const res = await apiFetch(`${API_BASE}/authn/delete-account/request-code/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

// Deleting is code-confirmed: the emailed code is exchanged for a short-lived
// verification token, which then authorizes the irreversible delete.
export async function deleteAccountApi({ code }) {
  const verifyRes = await apiFetch(
    `${API_BASE}/authn/delete-account/verify-code/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
  );
  if (!verifyRes.ok) throw new Error(await extractError(verifyRes));
  const { verification_token: verificationToken } = await verifyRes.json();

  const res = await apiFetch(`${API_BASE}/authn/delete-account/confirm/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verification_token: verificationToken }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  const data = await res.json();
  clearAuthSession();
  return data;
}

export async function logoutApi() {
  const res = await fetch(`${API_BASE}/authn/logout/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  clearAuthSession();
}
