/**
 * @jest-environment jsdom
 */

import {
  LEGACY_AUTH_SESSION_KEY,
  apiFetch,
  clearAuthSession,
  extractError,
  getAccessToken,
  readAuthSession,
  refreshAuthSession,
  writeAuthSession,
} from "@/lib/api/config";
import {
  changePasswordApi,
  confirmPasswordReset,
  deleteAccountApi,
  fetchAuthSessions,
  fetchProfile,
  loginWithPassword,
  logoutApi,
  requestPasswordResetCode,
  requestLoginCode,
  requestUnifiedEmailAuthCode,
  revokeAuthSessions,
  startRegistration,
  startTemporaryUpgradeRegistration,
  updateProfileApi,
  verifyLoginCode,
  verifyRegistration,
  verifyUnifiedEmailAuthCode,
} from "@/lib/api/auth";
import { fetchDashboardEvents } from "@/lib/api/dashboard";
import { submitFeedback } from "@/lib/api/feedback";
import {
  confirmFinalMeeting,
  createEvent,
  deleteEvent,
  downloadFinalCalendar,
  duplicateEvent,
  fetchDeliveryRequest,
  fetchEvent,
  fetchEventResults,
  fetchFinalization,
  fetchInvitations,
  markInvitationOpened,
  previewFinalMeeting,
  sendInvitations,
  sendReminders,
  retryDeliveryRequest,
  updateEvent,
  updateEventLifecycle,
} from "@/lib/api/events";
import {
  cancelRosterImport,
  commitRosterImport,
  configureRosterImport,
  createRosterImport,
  fetchRoster,
  fetchRosterImportRows,
  fetchRosterSchedule,
  patchRosterBulk,
  patchRosterParticipant,
} from "@/lib/api/roster";
import {
  createManagedParticipant,
  deleteParticipant,
  fetchCurrentParticipant,
  fetchParticipants,
  fetchParticipantsIncludeHidden,
  joinEvent,
  unhideParticipant,
  updateParticipant,
} from "@/lib/api/participants";

function jsonResponse(body, init = {}) {
  const status = init.status || 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

function textResponse(text, init = {}) {
  const status = init.status || 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockRejectedValue(new Error(text)),
  };
}

function passwordKeyResponse(required = false) {
  return jsonResponse({
    key_id: "password-key",
    public_key: "-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----",
    password_encryption_required: required,
  });
}

describe("api config session helpers", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
    global.fetch = jest.fn();
  });

  test("keeps credentials in memory and removes legacy Web Storage values", () => {
    const listener = jest.fn();
    window.addEventListener("releviz-auth", listener);
    localStorage.setItem(LEGACY_AUTH_SESSION_KEY, "legacy-local-token");
    sessionStorage.setItem(LEGACY_AUTH_SESSION_KEY, "legacy-session-token");
    expect(readAuthSession()).toBeNull();
    writeAuthSession({ access: "a", refresh: "r", user: { id: "1" } });
    expect(readAuthSession()).toEqual({
      access: "a",
      accessExpiresAt: null,
      session: null,
      user: expect.objectContaining({ id: "1", memberUuid: "1" }),
      nextStep: null,
      requiresProfileCompletion: false,
    });
    expect(readAuthSession().refresh).toBeUndefined();
    expect(localStorage.getItem(LEGACY_AUTH_SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_SESSION_KEY)).toBeNull();
    clearAuthSession();
    expect(readAuthSession()).toBeNull();
    writeAuthSession({});
    expect(readAuthSession()).toEqual({
      access: null,
      accessExpiresAt: null,
      session: null,
      user: null,
      nextStep: null,
      requiresProfileCompletion: false,
    });
    writeAuthSession(null);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  test("writeAuthSession stores nextStep and requiresProfileCompletion", () => {
    writeAuthSession({
      access: "a",
      user: { id: "u" },
      next_step: "complete_profile",
      requires_profile_completion: true,
    });
    const session = readAuthSession();
    expect(session.nextStep).toBe("complete_profile");
    expect(session.requiresProfileCompletion).toBe(true);
  });

  test("extractError handles common API error shapes and invalid JSON", async () => {
    await expect(
      extractError(jsonResponse({ error: "bad" }, { status: 400 })),
    ).resolves.toBe("bad");
    await expect(
      extractError(jsonResponse({ detail: "nope" }, { status: 400 })),
    ).resolves.toBe("nope");
    await expect(
      extractError(jsonResponse({ email: ["Required", "Invalid"] })),
    ).resolves.toBe("Required Invalid");
    await expect(
      extractError(jsonResponse({ email: "Required" })),
    ).resolves.toBe("Required");
    await expect(extractError(jsonResponse({}))).resolves.toBe(
      "Request failed",
    );
    await expect(
      extractError(textResponse("not json", { status: 418 })),
    ).resolves.toBe("HTTP 418");
  });

  test("apiFetch sends bearer token and refreshes once after 401", async () => {
    writeAuthSession({ access: "old", user: { id: "1" } });
    global.fetch
      .mockResolvedValueOnce(textResponse("no", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access: "new" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const res = await apiFetch("/things", { headers: { "X-Test": "1" } });

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "/things",
      expect.objectContaining({
        credentials: "include",
        headers: { "X-Test": "1", Authorization: "Bearer old" },
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "/things",
      expect.objectContaining({
        headers: { "X-Test": "1", Authorization: "Bearer new" },
      }),
    );
    expect(readAuthSession().access).toBe("new");
  });

  test("refresh is cookie-backed, single-flight, and clears failed sessions", async () => {
    writeAuthSession({ access: "old" });
    global.fetch.mockResolvedValueOnce(textResponse("no", { status: 401 }));
    const skipped = await apiFetch("/things", { skipAuthRefresh: true });
    expect(skipped.status).toBe(401);

    let resolveRefresh;
    global.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const firstRefresh = refreshAuthSession();
    const secondRefresh = refreshAuthSession();
    resolveRefresh(jsonResponse({ access: "shared", user: { id: "1" } }));
    await expect(firstRefresh).resolves.toEqual(
      expect.objectContaining({ access: "shared" }),
    );
    await expect(secondRefresh).resolves.toEqual(
      expect.objectContaining({ access: "shared" }),
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/authn/refresh/",
      expect.objectContaining({
        body: "{}",
        credentials: "include",
      }),
    );

    writeAuthSession({ access: "old" });
    global.fetch
      .mockResolvedValueOnce(textResponse("no", { status: 401 }))
      .mockResolvedValueOnce(textResponse("bad", { status: 401 }));
    const failed = await apiFetch("/things");
    expect(failed.status).toBe(401);
    expect(readAuthSession()).toBeNull();

    global.fetch
      .mockResolvedValueOnce(textResponse("no cookie", { status: 401 }))
      .mockResolvedValueOnce(
        textResponse("still unauthorized", { status: 401 }),
      );
    const noRefresh = await apiFetch("/things");
    expect(noRefresh.status).toBe(401);

    writeAuthSession({
      access: "expired",
      accessExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ access: "fresh" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(getAccessToken()).resolves.toBe("fresh");
    const explicit = await apiFetch("/explicit", {}, "provided");
    expect(explicit.status).toBe(200);

    writeAuthSession({ access: "old-again" });
    global.fetch
      .mockResolvedValueOnce(textResponse("expired", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access: "new-again" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(apiFetch("/no-headers")).resolves.toEqual(
      expect.objectContaining({ status: 200 }),
    );
  });
});

describe("auth API helpers", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
    global.fetch = jest.fn();
  });

  test("login and verify write sessions; registration returns JSON", async () => {
    const authBody = { access: "a", user: { id: "u" } };
    global.fetch
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse(authBody))
      .mockResolvedValueOnce(
        jsonResponse({ message: "code sent" }, { status: 202 }),
      )
      .mockResolvedValueOnce(jsonResponse(authBody))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(
        jsonResponse({ message: "started" }, { status: 202 }),
      )
      .mockResolvedValueOnce(jsonResponse(authBody))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "ok" }));

    await expect(
      loginWithPassword({ email: "a@b.com", password: "pw" }),
    ).resolves.toEqual(authBody);
    expect(readAuthSession().access).toBe("a");
    await expect(requestLoginCode({ email: "a@b.com" })).resolves.toEqual({
      message: "code sent",
    });
    await expect(
      verifyLoginCode({ email: "a@b.com", code: "123456" }),
    ).resolves.toEqual(authBody);
    await expect(startRegistration({ email: "a@b.com" })).resolves.toEqual({
      message: "started",
    });
    await expect(
      verifyRegistration({ email: "a@b.com", code: "123456" }),
    ).resolves.toEqual(authBody);

    await expect(
      loginWithPassword({ email: "a@b.com", password: "pw" }),
    ).resolves.toEqual({
      message: "ok",
    });
  });

  test("starts a temporary upgrade registration without a client email", async () => {
    global.fetch
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(
        jsonResponse({ message: "started" }, { status: 202 }),
      );

    await expect(
      startTemporaryUpgradeRegistration("A B", {
        first_name: "Taylor",
        password: "password123",
        password_confirm: "password123",
      }),
    ).resolves.toEqual({ message: "started" });

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "/events/temp-access/upgrade-registration?code=A%20B",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          first_name: "Taylor",
          password: "password123",
          password_confirm: "password123",
        }),
      }),
    );
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).not.toHaveProperty(
      "email",
    );
  });

  test("verify registration sends only email and code", async () => {
    global.fetch.mockResolvedValueOnce(
      jsonResponse({ access: "verified", user: { id: "member" } }),
    );

    await verifyRegistration({
      email: "temporary@example.com",
      code: "123456",
      password: "password123",
      password_confirm: "password123",
      first_name: "Taylor",
      last_name: "Temp",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/authn/register/verify-code/",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "temporary@example.com",
          code: "123456",
        }),
      }),
    );
  });

  test("unified email auth request and verify dispatch correctly", async () => {
    global.fetch
      .mockResolvedValueOnce(
        jsonResponse({ message: "Check your email" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access: "a",
          user: { id: "u" },
          next_step: "account",
          requires_profile_completion: false,
        }),
      );

    await expect(
      requestUnifiedEmailAuthCode({ email: "a@b.com" }),
    ).resolves.toEqual({ message: "Check your email" });
    await expect(
      verifyUnifiedEmailAuthCode({ email: "a@b.com", code: "123456" }),
    ).resolves.toEqual({
      access: "a",
      user: { id: "u" },
      next_step: "account",
      requires_profile_completion: false,
    });
    expect(readAuthSession().access).toBe("a");

    // Verify source and event fields are forwarded
    global.fetch.mockResolvedValueOnce(
      jsonResponse({ message: "Check your email" }, { status: 202 }),
    );
    await requestUnifiedEmailAuthCode({
      email: "a@b.com",
      source: "event_registration",
      event: "my-event",
      next: "/event?code=my-event",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/authn/email-auth/request-code/",
      expect.objectContaining({
        body: JSON.stringify({
          email: "a@b.com",
          source: "event_registration",
          event: "my-event",
          next: "/event?code=my-event",
        }),
      }),
    );
  });

  test("auth helpers throw extracted errors and update profile sessions", async () => {
    writeAuthSession({ access: "a", user: { id: "old" } });
    global.fetch
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ detail: "bad" }, { status: 400 }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "code bad" }, { status: 400 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ detail: "verify bad" }, { status: 400 }),
      )
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ error: "no" }, { status: 400 }))
      .mockResolvedValueOnce(
        jsonResponse({
          member_uuid: "new",
          email: "new@example.com",
          first_name: "New",
          last_name: "Member",
          email_verified: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ detail: "profile bad" }, { status: 400 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          member_uuid: "updated",
          email: "new@example.com",
          first_name: "Ada",
          last_name: "Member",
          email_verified: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ detail: "update bad" }, { status: 400 }),
      );

    await expect(
      loginWithPassword({ email: "x", password: "bad" }),
    ).rejects.toThrow("bad");
    await expect(requestLoginCode({ email: "x" })).rejects.toThrow("code bad");
    await expect(
      verifyLoginCode({ email: "x", code: "000000" }),
    ).rejects.toThrow("verify bad");
    await expect(startRegistration({})).rejects.toThrow("no");
    await expect(fetchProfile()).resolves.toEqual(
      expect.objectContaining({
        id: "new",
        firstName: "New",
        lastName: "Member",
        displayName: "New Member",
        emailVerified: true,
      }),
    );
    expect(readAuthSession()).toEqual(
      expect.objectContaining({
        nextStep: "account",
        requiresProfileCompletion: false,
      }),
    );
    await expect(fetchProfile()).rejects.toThrow("profile bad");
    await expect(updateProfileApi({ first_name: "Ada" })).resolves.toEqual(
      expect.objectContaining({ id: "updated", firstName: "Ada" }),
    );
    expect(readAuthSession().user.id).toBe("updated");
    expect(global.fetch).toHaveBeenNthCalledWith(
      9,
      "/authn/profile/",
      expect.objectContaining({ method: "PATCH" }),
    );
    await expect(updateProfileApi({ first_name: "Ada" })).rejects.toThrow(
      "update bad",
    );
  });

  test("logout always posts the cookie endpoint and clears memory", async () => {
    writeAuthSession({ access: "a" });
    global.fetch.mockResolvedValueOnce(textResponse("", { status: 500 }));
    await logoutApi();
    expect(readAuthSession()).toBeNull();

    writeAuthSession({ access: "a" });
    global.fetch.mockRejectedValueOnce(new Error("network"));
    await logoutApi();
    expect(readAuthSession()).toBeNull();

    global.fetch.mockResolvedValueOnce(jsonResponse({ message: "ok" }));
    await logoutApi();
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/authn/logout/",
      expect.objectContaining({ body: "{}", credentials: "include" }),
    );
  });

  test("lists sessions and revokes one or every device", async () => {
    writeAuthSession({ access: "a", user: { id: "u" } });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ sessions: [{ id: "s1" }] }))
      .mockResolvedValueOnce(
        jsonResponse({ revoked: 1, currentRevoked: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ detail: "list failed" }, { status: 500 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ detail: "revoke failed" }, { status: 500 }),
      )
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({ revoked: 2, currentRevoked: true }),
      );

    await expect(fetchAuthSessions()).resolves.toEqual([{ id: "s1" }]);
    await expect(revokeAuthSessions({ sessionId: "s1" })).resolves.toEqual({
      revoked: 1,
      currentRevoked: false,
    });
    await expect(fetchAuthSessions()).rejects.toThrow("list failed");
    await expect(revokeAuthSessions({ sessionId: "bad" })).rejects.toThrow(
      "revoke failed",
    );
    await expect(fetchAuthSessions()).resolves.toEqual([]);
    await expect(revokeAuthSessions({ all: true })).resolves.toEqual({
      revoked: 2,
      currentRevoked: true,
    });
    expect(readAuthSession()).toBeNull();
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "/authn/sessions/",
      expect.objectContaining({
        body: JSON.stringify({ sessionId: "s1" }),
        method: "DELETE",
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      6,
      "/authn/sessions/",
      expect.objectContaining({
        body: JSON.stringify({ all: true }),
        method: "DELETE",
      }),
    );
  });

  test("resets, changes, and deletes accounts while clearing local auth state", async () => {
    global.fetch
      .mockResolvedValueOnce(
        jsonResponse({ message: "code sent" }, { status: 202 }),
      )
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "reset" }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "changed" }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "deleted" }));

    await expect(
      requestPasswordResetCode({ email: "ada@example.com" }),
    ).resolves.toEqual({
      message: "code sent",
    });
    writeAuthSession({ access: "before-reset" });
    await expect(
      confirmPasswordReset({
        email: "ada@example.com",
        code: "123456",
        password: "password456",
        passwordConfirm: "password456",
      }),
    ).resolves.toEqual({ message: "reset" });
    expect(readAuthSession()).toBeNull();

    writeAuthSession({ access: "before-change" });
    await expect(
      changePasswordApi({
        currentPassword: "password456",
        newPassword: "password789",
        newPasswordConfirm: "password789",
      }),
    ).resolves.toEqual({ message: "changed" });
    expect(readAuthSession()).toBeNull();

    writeAuthSession({ access: "before-delete" });
    await expect(
      deleteAccountApi({ password: "password789", confirmation: "DELETE" }),
    ).resolves.toEqual({ message: "deleted" });
    expect(readAuthSession()).toBeNull();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "/authn/password-reset/request-code/",
      expect.objectContaining({
        body: JSON.stringify({ email: "ada@example.com" }),
        credentials: "include",
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "/authn/public-key/",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "/authn/password-reset/confirm/",
      expect.objectContaining({
        body: JSON.stringify({
          email: "ada@example.com",
          code: "123456",
          password: "password456",
          password_confirm: "password456",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      "/authn/public-key/",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      5,
      "/authn/change-password/",
      expect.objectContaining({
        body: JSON.stringify({
          current_password: "password456",
          new_password: "password789",
          new_password_confirm: "password789",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      6,
      "/authn/public-key/",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      7,
      "/authn/delete-account/",
      expect.objectContaining({
        body: JSON.stringify({
          password: "password789",
          confirmation: "DELETE",
        }),
      }),
    );
  });

  test("account lifecycle helpers surface backend errors", async () => {
    global.fetch
      .mockResolvedValueOnce(
        jsonResponse({ detail: "request failed" }, { status: 400 }),
      )
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(
        jsonResponse({ detail: "reset failed" }, { status: 400 }),
      )
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(
        jsonResponse({ detail: "change failed" }, { status: 400 }),
      )
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(
        jsonResponse({ detail: "delete failed" }, { status: 400 }),
      );

    await expect(requestPasswordResetCode({ email: "x" })).rejects.toThrow(
      "request failed",
    );
    await expect(
      confirmPasswordReset({
        email: "x",
        code: "0",
        password: "password456",
        passwordConfirm: "password456",
      }),
    ).rejects.toThrow("reset failed");
    writeAuthSession({ access: "a" });
    await expect(
      changePasswordApi({
        currentPassword: "old",
        newPassword: "password456",
        newPasswordConfirm: "password456",
      }),
    ).rejects.toThrow("change failed");
    await expect(
      deleteAccountApi({ password: "old", confirmation: "DELETE" }),
    ).rejects.toThrow("delete failed");
  });

  test("encrypts password fields when the backend requires it", async () => {
    const originalCrypto = globalThis.crypto;
    const originalTextEncoder = globalThis.TextEncoder;
    const importKey = jest.fn().mockResolvedValue("imported-key");
    const encrypt = jest
      .fn()
      .mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle: { importKey, encrypt } },
    });
    if (!globalThis.TextEncoder) {
      Object.defineProperty(globalThis, "TextEncoder", {
        configurable: true,
        value: require("node:util").TextEncoder,
      });
    }
    global.fetch
      .mockResolvedValueOnce(passwordKeyResponse(true))
      .mockResolvedValueOnce(jsonResponse({ message: "ok" }));

    await loginWithPassword({
      email: "ada@example.com",
      password: "secret-password",
    });

    const payload = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(payload).toEqual({
      email: "ada@example.com",
      password: "AQID",
      key_id: "password-key",
    });
    expect(importKey).toHaveBeenCalledWith(
      "spki",
      Uint8Array.from([1, 2, 3]),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    expect(encrypt).toHaveBeenCalledWith(
      { name: "RSA-OAEP" },
      "imported-key",
      expect.anything(),
    );
    expect(Array.from(encrypt.mock.calls[0][2])).toEqual(
      Array.from(new TextEncoder().encode("secret-password")),
    );

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: originalTextEncoder,
    });
  });

  test("rejects unavailable key negotiation and browser encryption", async () => {
    global.fetch.mockResolvedValueOnce(
      jsonResponse({ detail: "key unavailable" }, { status: 503 }),
    );
    await expect(
      loginWithPassword({ email: "x", password: "password123" }),
    ).rejects.toThrow("key unavailable");

    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
    global.fetch.mockResolvedValueOnce(passwordKeyResponse(true));
    await expect(
      loginWithPassword({ email: "x", password: "password123" }),
    ).rejects.toThrow("Unable to secure password for transmission.");
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  });
});

describe("business API helpers", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  test("dashboard, events, participants, and weights build expected requests", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ ok: true }));

    await fetchDashboardEvents("tok");
    await createEvent({ name: "Minimal" }, "tok");
    await createEvent(
      {
        name: "Plan",
        startTime: "09:15",
        endTime: "10:15",
        slotMinutes: 15,
        days: [1],
        mode: "mixed",
        location: "Room",
        participantViewPermission: "all_after_submit",
        daySelectionType: "specific_dates",
        specificDates: ["2026-07-08"],
        responseDeadline: "2026-07-08T12:00:00.000Z",
        timezone: "America/Los_Angeles",
        remindersEnabled: false,
        reminderHoursBefore: 12,
      },
      "tok",
    );
    await fetchEvent("ABC 123", "tok");
    await updateEvent(
      "ABC 123",
      {
        name: "Updated",
        expectedVersion: 3,
        resetResponses: true,
      },
      "tok",
    );
    await duplicateEvent(
      "ABC 123",
      {
        expectedVersion: 3,
        idempotencyKey: "duplicate-key",
      },
      "tok",
    );
    await deleteEvent(
      "ABC 123",
      {
        expectedVersion: 3,
        idempotencyKey: "delete-key",
        confirmation: "ABC 123",
      },
      "tok",
    );
    await fetchEventResults("ABC 123", "tok");
    await previewFinalMeeting(
      "ABC 123",
      {
        startsAt: "2026-07-20T16:00:00.000Z",
        endsAt: "2026-07-20T17:00:00.000Z",
        channel: "inperson",
      },
      "tok",
    );
    await confirmFinalMeeting(
      "ABC 123",
      {
        startsAt: "2026-07-20T16:00:00.000Z",
        endsAt: "2026-07-20T17:00:00.000Z",
        channel: "inperson",
        expectedVersion: 2,
        idempotencyKey: "key",
      },
      "tok",
    );
    await fetchFinalization("ABC 123", "tok");
    await updateEventLifecycle(
      "ABC 123",
      {
        status: "closed",
        expectedVersion: 2,
        responseDeadline: "2026-07-09T12:00:00.000Z",
      },
      "tok",
    );
    await fetchInvitations("ABC 123", "tok");
    await markInvitationOpened("ABC 123", "invitation-token");
    await sendInvitations(
      "ABC 123",
      {
        emails: ["a@example.com"],
        message: "Join",
        idempotencyKey: "invite-key",
      },
      "tok",
    );
    await sendReminders("ABC 123", { idempotencyKey: "reminder-key" }, "tok");
    await fetchDeliveryRequest("delivery 1", "tok");
    await retryDeliveryRequest("delivery 1", "tok");
    await createRosterImport(
      "ABC 123",
      { pastedText: "name\temail\nAda\tada@example.com" },
      "tok",
    );
    await configureRosterImport(
      "ABC 123",
      "import 1",
      { worksheet: "Sheet 1", columnMapping: { name: "name", email: "email" } },
      "tok",
    );
    await fetchRosterImportRows(
      "ABC 123",
      "import 1",
      { page: 2, pageSize: 25 },
      "tok",
    );
    await commitRosterImport(
      "ABC 123",
      "import 1",
      { mode: "merge", idempotencyKey: "import-key" },
      "tok",
    );
    await cancelRosterImport("ABC 123", "import 1", "tok");
    await fetchRoster(
      "ABC 123",
      {
        page: 2,
        pageSize: 100,
        search: "Ada",
        group: "Faculty",
        submitted: true,
      },
      "tok",
    );
    await fetchRosterSchedule("ABC 123", "participant 1", "tok");
    await patchRosterParticipant(
      "ABC 123",
      "participant 1",
      { weight: 0.5, expectedVersion: 2 },
      "tok",
    );
    await patchRosterBulk(
      "ABC 123",
      {
        group: "Faculty",
        updates: { included: false },
        idempotencyKey: "bulk-key",
      },
      "tok",
    );
    await fetchParticipants("ABC 123", "tok");
    await expect(fetchCurrentParticipant("ABC 123", "tok")).resolves.toEqual({
      participant: null,
      scheduleDataIncluded: false,
    });
    await joinEvent("ABC 123", "tok");
    await createManagedParticipant(
      "ABC 123",
      {
        name: "Temporary Person",
        email: "temp@example.com",
        idempotencyKey: "managed-key",
      },
      "tok",
    );
    await updateParticipant("ABC 123", "user 1", { submitted: 1 }, "tok");
    await fetchParticipantsIncludeHidden("ABC 123", "tok");
    await unhideParticipant("ABC 123", "user 1", "tok");
    await deleteParticipant("ABC 123", "user 1", "tok");
    await submitFeedback({
      category: "problem",
      message: "Something failed",
      pagePath: "/event",
      consentToFollowUp: true,
    });

    const urls = global.fetch.mock.calls.map(([url]) => url);
    expect(urls).toContain("/dashboard/events");
    expect(urls).toContain("/events?code=ABC%20123");
    expect(urls).toContain("/events/duplicate?code=ABC%20123");
    expect(global.fetch).toHaveBeenCalledWith(
      "/events",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Minimal",
          accessMode: "invite_only",
          meetingDurationMinutes: 30,
          status: "active",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/events/participants/managed?code=ABC%20123",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Temporary Person",
          email: "temp@example.com",
          idempotencyKey: "managed-key",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/events?code=ABC%20123",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          name: "Updated",
          expectedVersion: 3,
          resetResponses: true,
        }),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/events/duplicate?code=ABC%20123",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expectedVersion: 3,
          idempotencyKey: "duplicate-key",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/events?code=ABC%20123",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          expectedVersion: 3,
          idempotencyKey: "delete-key",
          confirmation: "ABC 123",
        }),
      }),
    );
    expect(urls).toContain("/events/results?code=ABC%20123");
    expect(urls).toContain("/events/finalization/preview?code=ABC%20123");
    expect(urls).toContain("/events/finalization?code=ABC%20123");
    expect(urls).toContain("/events/lifecycle?code=ABC%20123");
    expect(urls).toContain("/events/invitations?code=ABC%20123");
    expect(global.fetch).toHaveBeenCalledWith(
      "/events/invitations/open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          code: "ABC 123",
          token: "invitation-token",
        }),
      }),
    );
    expect(urls).toContain("/events/reminders?code=ABC%20123");
    expect(urls).toContain("/events/delivery-requests/delivery%201");
    expect(urls).toContain("/events/roster-imports?code=ABC%20123");
    expect(urls).toContain("/events/roster-imports/import%201?code=ABC%20123");
    expect(urls).toContain(
      "/events/roster-imports/import%201/rows?code=ABC+123&page=2&pageSize=25",
    );
    expect(urls).toContain(
      "/events/roster-imports/import%201/commit?code=ABC%20123",
    );
    expect(urls).toContain(
      "/events/roster?code=ABC+123&page=2&pageSize=100&search=Ada&group=Faculty&submitted=true",
    );
    expect(urls).toContain(
      "/events/roster/participant%201/schedule?code=ABC%20123",
    );
    expect(urls).toContain("/events/roster/participant%201?code=ABC%20123");
    expect(urls).toContain("/events/roster/bulk?code=ABC%20123");
    expect(global.fetch).toHaveBeenCalledWith(
      "/events/invitations?code=ABC%20123",
      expect.objectContaining({
        body: JSON.stringify({
          emails: ["a@example.com"],
          message: "Join",
          idempotencyKey: "invite-key",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/events/reminders?code=ABC%20123",
      expect.objectContaining({
        body: JSON.stringify({ idempotencyKey: "reminder-key" }),
      }),
    );
    expect(urls).toContain(
      "/events/participants?code=ABC%20123&includeHidden=true",
    );
    expect(urls).toContain(
      "/events/participants/update/unhide?code=ABC%20123&participantId=user%201",
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          category: "problem",
          message: "Something failed",
          pagePath: "/event",
          consentToFollowUp: true,
        }),
      }),
    );
  });

  test("business API helpers throw extracted errors", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ error: "nope" }, { status: 400 }),
    );
    await expect(createEvent({ name: "Bad" })).rejects.toThrow("nope");
    await expect(fetchDashboardEvents()).rejects.toThrow("nope");
    await expect(fetchEvent("BAD")).rejects.toThrow("nope");
    await expect(updateEvent("BAD", {})).rejects.toThrow("nope");
    await expect(duplicateEvent("BAD", {})).rejects.toThrow("nope");
    await expect(deleteEvent("BAD", {})).rejects.toThrow("nope");
    await expect(fetchEventResults("BAD")).rejects.toThrow("nope");
    await expect(previewFinalMeeting("BAD", {})).rejects.toThrow("nope");
    await expect(confirmFinalMeeting("BAD", {})).rejects.toThrow("nope");
    await expect(fetchFinalization("BAD")).rejects.toThrow("nope");
    await expect(
      updateEventLifecycle("BAD", { status: "closed", expectedVersion: 1 }),
    ).rejects.toThrow("nope");
    await expect(fetchInvitations("BAD")).rejects.toThrow("nope");
    await expect(markInvitationOpened("BAD", "token")).rejects.toThrow("nope");
    await expect(
      sendInvitations("BAD", { emails: [], idempotencyKey: "invite-key" }),
    ).rejects.toThrow("nope");
    await expect(
      sendReminders("BAD", { idempotencyKey: "reminder-key" }),
    ).rejects.toThrow("nope");
    await expect(fetchDeliveryRequest("bad-request")).rejects.toThrow("nope");
    await expect(retryDeliveryRequest("bad-request")).rejects.toThrow("nope");
    await expect(
      createRosterImport("BAD", { pastedText: "bad" }),
    ).rejects.toThrow("nope");
    await expect(configureRosterImport("BAD", "import", {})).rejects.toThrow(
      "nope",
    );
    await expect(fetchRosterImportRows("BAD", "import")).rejects.toThrow(
      "nope",
    );
    await expect(commitRosterImport("BAD", "import", {})).rejects.toThrow(
      "nope",
    );
    await expect(cancelRosterImport("BAD", "import")).rejects.toThrow("nope");
    await expect(fetchRoster("BAD")).rejects.toThrow("nope");
    await expect(fetchRosterSchedule("BAD", "participant")).rejects.toThrow(
      "nope",
    );
    await expect(
      patchRosterParticipant("BAD", "participant", {}),
    ).rejects.toThrow("nope");
    await expect(patchRosterBulk("BAD", {})).rejects.toThrow("nope");
    await expect(fetchParticipants("BAD")).rejects.toThrow("nope");
    await expect(fetchCurrentParticipant("BAD")).rejects.toThrow("nope");
    await expect(joinEvent("BAD")).rejects.toThrow("nope");
    await expect(updateParticipant("BAD", "p", {})).rejects.toThrow("nope");
    await expect(fetchParticipantsIncludeHidden("BAD")).rejects.toThrow("nope");
    await expect(unhideParticipant("BAD", "p")).rejects.toThrow("nope");
    await expect(deleteParticipant("BAD", "p")).rejects.toThrow("nope");
    await expect(
      submitFeedback({
        category: "problem",
        message: "Failed",
      }),
    ).rejects.toThrow("nope");
  });

  test("downloads the authenticated final calendar with the server filename", async () => {
    const blob = new Blob(["BEGIN:VCALENDAR"]);
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn().mockReturnValue('attachment; filename="planning.ics"'),
      },
      blob: jest.fn().mockResolvedValue(blob),
    });

    await expect(downloadFinalCalendar("ABC 123", "tok")).resolves.toEqual({
      blob,
      filename: "planning.ics",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/events/finalization/calendar?code=ABC%20123",
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
  });

  test("event mutations expose structured conflicts and HTTP fallbacks", async () => {
    global.fetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Responses would be reset",
            event: { code: "ABC", version: 4 },
            requiresResponseReset: true,
            participantCount: 3,
            retryable: true,
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ detail: "Duplicate conflict" }, { status: 409 }),
      )
      .mockResolvedValueOnce(jsonResponse({}, { status: 400 }))
      .mockResolvedValueOnce(textResponse("gateway", { status: 502 }));

    await expect(updateEvent("ABC", {}, "tok")).rejects.toMatchObject({
      message: "Responses would be reset",
      status: 409,
      event: { code: "ABC", version: 4 },
      requiresResponseReset: true,
      participantCount: 3,
      retryable: true,
    });
    await expect(duplicateEvent("ABC", {}, "tok")).rejects.toMatchObject({
      message: "Duplicate conflict",
      status: 409,
      event: null,
      requiresResponseReset: false,
      participantCount: 0,
      retryable: false,
    });
    await expect(deleteEvent("ABC", {}, "tok")).rejects.toThrow(
      "Request failed",
    );
    await expect(deleteEvent("ABC", {}, "tok")).rejects.toMatchObject({
      message: "HTTP 502",
      status: 502,
    });
  });

  test("participant updates expose conflicts and safe error fallbacks", async () => {
    global.fetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Response version conflict",
            errorCode: "organizer_edit_full_account",
            participant: { id: "participant-1", version: 4 },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ detail: "Responses are locked" }, { status: 423 }),
      )
      .mockResolvedValueOnce(jsonResponse({}, { status: 400 }))
      .mockResolvedValueOnce(textResponse("gateway", { status: 502 }));

    await expect(
      updateParticipant("ABC", "participant-1", {}, "tok"),
    ).rejects.toMatchObject({
      message: "Response version conflict",
      status: 409,
      errorCode: "organizer_edit_full_account",
      participant: { id: "participant-1", version: 4 },
    });
    await expect(
      updateParticipant("ABC", "participant-1", {}, "tok"),
    ).rejects.toMatchObject({
      message: "Responses are locked",
      status: 423,
      errorCode: null,
      participant: null,
    });
    await expect(
      updateParticipant("ABC", "participant-1", {}, "tok"),
    ).rejects.toMatchObject({
      message: "Request failed",
      status: 400,
      errorCode: null,
      participant: null,
    });
    await expect(
      updateParticipant("ABC", "participant-1", {}, "tok"),
    ).rejects.toMatchObject({
      message: "HTTP 502",
      status: 502,
      errorCode: null,
      participant: null,
    });
  });

  test("managed participant mutations preserve structured error details", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          detail: "Participant already exists",
          code: "participant_exists",
          event: { code: "ABC", version: 4 },
          participant: { id: "participant-1", version: 2 },
        }),
      ),
    });

    await expect(
      createManagedParticipant(
        "ABC",
        {
          name: "Existing Person",
          email: "existing@example.com",
          idempotencyKey: "managed-key",
        },
        "tok",
      ),
    ).rejects.toMatchObject({
      message: "Participant already exists",
      status: 409,
      errorCode: "participant_exists",
      event: { code: "ABC", version: 4 },
      participant: { id: "participant-1", version: 2 },
      payload: expect.objectContaining({ code: "participant_exists" }),
    });
  });
});
