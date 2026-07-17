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
  revokeAuthSessions,
  startRegistration,
  updateProfileApi,
  verifyLoginCode,
  verifyRegistration,
} from "@/lib/api/auth";
import { fetchDashboardEvents } from "@/lib/api/dashboard";
import { submitFeedback } from "@/lib/api/feedback";
import {
  confirmFinalMeeting,
  createEvent,
  deleteEvent,
  duplicateEvent,
  fetchEvent,
  fetchEventResults,
  fetchFinalization,
  fetchInvitations,
  markInvitationOpened,
  previewFinalMeeting,
  sendInvitations,
  sendReminders,
  updateEvent,
  updateEventLifecycle,
} from "@/lib/api/events";
import {
  deleteParticipant,
  fetchParticipants,
  fetchParticipantsIncludeHidden,
  joinEvent,
  unhideParticipant,
  updateParticipant,
} from "@/lib/api/participants";
import { fetchWeights, updateWeights } from "@/lib/api/weights";

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
      user: { id: "1" },
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
    });
    writeAuthSession(null);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  test("extractError handles common API error shapes and invalid JSON", async () => {
    await expect(extractError(jsonResponse({ error: "bad" }, { status: 400 }))).resolves.toBe(
      "bad"
    );
    await expect(extractError(jsonResponse({ detail: "nope" }, { status: 400 }))).resolves.toBe(
      "nope"
    );
    await expect(extractError(jsonResponse({ email: ["Required", "Invalid"] }))).resolves.toBe(
      "Required Invalid"
    );
    await expect(extractError(jsonResponse({ email: "Required" }))).resolves.toBe("Required");
    await expect(extractError(jsonResponse({}))).resolves.toBe("Request failed");
    await expect(extractError(textResponse("not json", { status: 418 }))).resolves.toBe("HTTP 418");
  });

  test("apiFetch sends bearer token and refreshes once after 401", async () => {
    writeAuthSession({ access: "old", user: { id: "1" } });
    global.fetch
      .mockResolvedValueOnce(textResponse("no", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access: "new" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const res = await apiFetch("/api/things", { headers: { "X-Test": "1" } });

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/things",
      expect.objectContaining({
        credentials: "include",
        headers: { "X-Test": "1", Authorization: "Bearer old" },
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "/api/things",
      expect.objectContaining({ headers: { "X-Test": "1", Authorization: "Bearer new" } })
    );
    expect(readAuthSession().access).toBe("new");
  });

  test("refresh is cookie-backed, single-flight, and clears failed sessions", async () => {
    writeAuthSession({ access: "old" });
    global.fetch.mockResolvedValueOnce(textResponse("no", { status: 401 }));
    const skipped = await apiFetch("/api/things", { skipAuthRefresh: true });
    expect(skipped.status).toBe(401);

    let resolveRefresh;
    global.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const firstRefresh = refreshAuthSession();
    const secondRefresh = refreshAuthSession();
    resolveRefresh(jsonResponse({ access: "shared", user: { id: "1" } }));
    await expect(firstRefresh).resolves.toEqual(expect.objectContaining({ access: "shared" }));
    await expect(secondRefresh).resolves.toEqual(expect.objectContaining({ access: "shared" }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/authn/refresh/",
      expect.objectContaining({
        body: "{}",
        credentials: "include",
      })
    );

    writeAuthSession({ access: "old" });
    global.fetch
      .mockResolvedValueOnce(textResponse("no", { status: 401 }))
      .mockResolvedValueOnce(textResponse("bad", { status: 401 }));
    const failed = await apiFetch("/api/things");
    expect(failed.status).toBe(401);
    expect(readAuthSession()).toBeNull();

    global.fetch
      .mockResolvedValueOnce(textResponse("no cookie", { status: 401 }))
      .mockResolvedValueOnce(textResponse("still unauthorized", { status: 401 }));
    const noRefresh = await apiFetch("/api/things");
    expect(noRefresh.status).toBe(401);

    writeAuthSession({
      access: "expired",
      accessExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ access: "fresh" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(getAccessToken()).resolves.toBe("fresh");
    const explicit = await apiFetch("/api/explicit", {}, "provided");
    expect(explicit.status).toBe(200);

    writeAuthSession({ access: "old-again" });
    global.fetch
      .mockResolvedValueOnce(textResponse("expired", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access: "new-again" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(apiFetch("/api/no-headers")).resolves.toEqual(
      expect.objectContaining({ status: 200 })
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
      .mockResolvedValueOnce(jsonResponse({ message: "code sent" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse(authBody))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "started" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse(authBody))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "ok" }));

    await expect(loginWithPassword({ email: "a@b.com", password: "pw" })).resolves.toEqual(
      authBody
    );
    expect(readAuthSession().access).toBe("a");
    await expect(requestLoginCode({ email: "a@b.com" })).resolves.toEqual({
      message: "code sent",
    });
    await expect(verifyLoginCode({ email: "a@b.com", code: "123456" })).resolves.toEqual(authBody);
    await expect(startRegistration({ email: "a@b.com" })).resolves.toEqual({
      message: "started",
    });
    await expect(verifyRegistration({ email: "a@b.com", code: "123456" })).resolves.toEqual(
      authBody
    );

    await expect(loginWithPassword({ email: "a@b.com", password: "pw" })).resolves.toEqual({
      message: "ok",
    });
  });

  test("auth helpers throw extracted errors and update profile sessions", async () => {
    writeAuthSession({ access: "a", user: { id: "old" } });
    global.fetch
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ detail: "bad" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ error: "code bad" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ detail: "verify bad" }, { status: 400 }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ error: "no" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "new" } }))
      .mockResolvedValueOnce(jsonResponse({ detail: "profile bad" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "updated" } }))
      .mockResolvedValueOnce(jsonResponse({ detail: "update bad" }, { status: 400 }));

    await expect(loginWithPassword({ email: "x", password: "bad" })).rejects.toThrow("bad");
    await expect(requestLoginCode({ email: "x" })).rejects.toThrow("code bad");
    await expect(verifyLoginCode({ email: "x", code: "000000" })).rejects.toThrow("verify bad");
    await expect(startRegistration({})).rejects.toThrow("no");
    await expect(fetchProfile()).resolves.toEqual({ id: "new" });
    await expect(fetchProfile()).rejects.toThrow("profile bad");
    await expect(updateProfileApi({ first_name: "Ada" })).resolves.toEqual({ id: "updated" });
    expect(readAuthSession().user.id).toBe("updated");
    await expect(updateProfileApi({ first_name: "Ada" })).rejects.toThrow("update bad");
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
      expect.objectContaining({ body: "{}", credentials: "include" })
    );
  });

  test("lists sessions and revokes one or every device", async () => {
    writeAuthSession({ access: "a", user: { id: "u" } });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ sessions: [{ id: "s1" }] }))
      .mockResolvedValueOnce(jsonResponse({ revoked: 1, currentRevoked: false }))
      .mockResolvedValueOnce(jsonResponse({ detail: "list failed" }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ detail: "revoke failed" }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ revoked: 2, currentRevoked: true }));

    await expect(fetchAuthSessions()).resolves.toEqual([{ id: "s1" }]);
    await expect(revokeAuthSessions({ sessionId: "s1" })).resolves.toEqual({
      revoked: 1,
      currentRevoked: false,
    });
    await expect(fetchAuthSessions()).rejects.toThrow("list failed");
    await expect(revokeAuthSessions({ sessionId: "bad" })).rejects.toThrow("revoke failed");
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
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      6,
      "/authn/sessions/",
      expect.objectContaining({
        body: JSON.stringify({ all: true }),
        method: "DELETE",
      })
    );
  });

  test("resets, changes, and deletes accounts while clearing local auth state", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ message: "code sent" }, { status: 202 }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "reset" }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "changed" }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ message: "deleted" }));

    await expect(requestPasswordResetCode({ email: "ada@example.com" })).resolves.toEqual({
      message: "code sent",
    });
    writeAuthSession({ access: "before-reset" });
    await expect(
      confirmPasswordReset({
        email: "ada@example.com",
        code: "123456",
        password: "password456",
        passwordConfirm: "password456",
      })
    ).resolves.toEqual({ message: "reset" });
    expect(readAuthSession()).toBeNull();

    writeAuthSession({ access: "before-change" });
    await expect(
      changePasswordApi({
        currentPassword: "password456",
        newPassword: "password789",
        newPasswordConfirm: "password789",
      })
    ).resolves.toEqual({ message: "changed" });
    expect(readAuthSession()).toBeNull();

    writeAuthSession({ access: "before-delete" });
    await expect(
      deleteAccountApi({ password: "password789", confirmation: "DELETE" })
    ).resolves.toEqual({ message: "deleted" });
    expect(readAuthSession()).toBeNull();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "/authn/password-reset/request-code/",
      expect.objectContaining({
        body: JSON.stringify({ email: "ada@example.com" }),
        credentials: "include",
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "/authn/public-key/",
      expect.objectContaining({ credentials: "include" })
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
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      "/authn/public-key/",
      expect.objectContaining({ credentials: "include" })
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
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      6,
      "/authn/public-key/",
      expect.objectContaining({ credentials: "include" })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      7,
      "/authn/delete-account/",
      expect.objectContaining({
        body: JSON.stringify({ password: "password789", confirmation: "DELETE" }),
      })
    );
  });

  test("account lifecycle helpers surface backend errors", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ detail: "request failed" }, { status: 400 }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ detail: "reset failed" }, { status: 400 }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ detail: "change failed" }, { status: 400 }))
      .mockResolvedValueOnce(passwordKeyResponse())
      .mockResolvedValueOnce(jsonResponse({ detail: "delete failed" }, { status: 400 }));

    await expect(requestPasswordResetCode({ email: "x" })).rejects.toThrow("request failed");
    await expect(
      confirmPasswordReset({
        email: "x",
        code: "0",
        password: "password456",
        passwordConfirm: "password456",
      })
    ).rejects.toThrow("reset failed");
    writeAuthSession({ access: "a" });
    await expect(
      changePasswordApi({
        currentPassword: "old",
        newPassword: "password456",
        newPasswordConfirm: "password456",
      })
    ).rejects.toThrow("change failed");
    await expect(deleteAccountApi({ password: "old", confirmation: "DELETE" })).rejects.toThrow(
      "delete failed"
    );
  });

  test("encrypts password fields when the backend requires it", async () => {
    const originalCrypto = globalThis.crypto;
    const originalTextEncoder = globalThis.TextEncoder;
    const importKey = jest.fn().mockResolvedValue("imported-key");
    const encrypt = jest.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer);
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

    await loginWithPassword({ email: "ada@example.com", password: "secret-password" });

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
      ["encrypt"]
    );
    expect(encrypt).toHaveBeenCalledWith({ name: "RSA-OAEP" }, "imported-key", expect.anything());
    expect(Array.from(encrypt.mock.calls[0][2])).toEqual(
      Array.from(new TextEncoder().encode("secret-password"))
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
      jsonResponse({ detail: "key unavailable" }, { status: 503 })
    );
    await expect(loginWithPassword({ email: "x", password: "password123" })).rejects.toThrow(
      "key unavailable"
    );

    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
    global.fetch.mockResolvedValueOnce(passwordKeyResponse(true));
    await expect(loginWithPassword({ email: "x", password: "password123" })).rejects.toThrow(
      "Unable to secure password for transmission."
    );
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
      "tok"
    );
    await fetchEvent("ABC 123", "tok");
    await updateEvent(
      "ABC 123",
      {
        name: "Updated",
        expectedVersion: 3,
        resetResponses: true,
      },
      "tok"
    );
    await duplicateEvent(
      "ABC 123",
      {
        expectedVersion: 3,
        idempotencyKey: "duplicate-key",
      },
      "tok"
    );
    await deleteEvent(
      "ABC 123",
      {
        expectedVersion: 3,
        idempotencyKey: "delete-key",
        confirmation: "ABC 123",
      },
      "tok"
    );
    await fetchEventResults("ABC 123", "tok");
    await previewFinalMeeting(
      "ABC 123",
      {
        startsAt: "2026-07-20T16:00:00.000Z",
        endsAt: "2026-07-20T17:00:00.000Z",
        channel: "inperson",
      },
      "tok"
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
      "tok"
    );
    await fetchFinalization("ABC 123", "tok");
    await updateEventLifecycle(
      "ABC 123",
      {
        status: "closed",
        expectedVersion: 2,
        responseDeadline: "2026-07-09T12:00:00.000Z",
      },
      "tok"
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
      "tok"
    );
    await sendReminders("ABC 123", { idempotencyKey: "reminder-key" }, "tok");
    await fetchParticipants("ABC 123", "tok");
    await joinEvent("ABC 123", "tok");
    await updateParticipant("ABC 123", "user 1", { submitted: 1 }, "tok");
    await fetchParticipantsIncludeHidden("ABC 123", "tok");
    await unhideParticipant("ABC 123", "user 1", "tok");
    await deleteParticipant("ABC 123", "user 1", "tok");
    await fetchWeights("ABC 123", "tok");
    await updateWeights("ABC 123", [{ participantId: "user 1", weight: 1 }], "tok");
    await submitFeedback({
      category: "problem",
      message: "Something failed",
      pagePath: "/event",
      consentToFollowUp: true,
    });

    const urls = global.fetch.mock.calls.map(([url]) => url);
    expect(urls).toContain("/api/dashboard/events");
    expect(urls).toContain("/api/events?code=ABC%20123");
    expect(urls).toContain("/api/events/duplicate?code=ABC%20123");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/events?code=ABC%20123",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          name: "Updated",
          expectedVersion: 3,
          resetResponses: true,
        }),
      })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/events/duplicate?code=ABC%20123",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expectedVersion: 3,
          idempotencyKey: "duplicate-key",
        }),
      })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/events?code=ABC%20123",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          expectedVersion: 3,
          idempotencyKey: "delete-key",
          confirmation: "ABC 123",
        }),
      })
    );
    expect(urls).toContain("/api/events/results?code=ABC%20123");
    expect(urls).toContain("/api/events/finalization/preview?code=ABC%20123");
    expect(urls).toContain("/api/events/finalization?code=ABC%20123");
    expect(urls).toContain("/api/events/lifecycle?code=ABC%20123");
    expect(urls).toContain("/api/events/invitations?code=ABC%20123");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/events/invitations/open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          code: "ABC 123",
          token: "invitation-token",
        }),
      })
    );
    expect(urls).toContain("/api/events/reminders?code=ABC%20123");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/events/invitations?code=ABC%20123",
      expect.objectContaining({
        body: JSON.stringify({
          emails: ["a@example.com"],
          message: "Join",
          idempotencyKey: "invite-key",
        }),
      })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/events/reminders?code=ABC%20123",
      expect.objectContaining({
        body: JSON.stringify({ idempotencyKey: "reminder-key" }),
      })
    );
    expect(urls).toContain("/api/events/participants?code=ABC%20123&includeHidden=true");
    expect(urls).toContain(
      "/api/events/participants/update/unhide?code=ABC%20123&participantId=user%201"
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          category: "problem",
          message: "Something failed",
          pagePath: "/event",
          consentToFollowUp: true,
        }),
      })
    );
  });

  test("business API helpers throw extracted errors", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ error: "nope" }, { status: 400 }));
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
      updateEventLifecycle("BAD", { status: "closed", expectedVersion: 1 })
    ).rejects.toThrow("nope");
    await expect(fetchInvitations("BAD")).rejects.toThrow("nope");
    await expect(markInvitationOpened("BAD", "token")).rejects.toThrow("nope");
    await expect(
      sendInvitations("BAD", { emails: [], idempotencyKey: "invite-key" })
    ).rejects.toThrow("nope");
    await expect(sendReminders("BAD", { idempotencyKey: "reminder-key" })).rejects.toThrow("nope");
    await expect(fetchParticipants("BAD")).rejects.toThrow("nope");
    await expect(joinEvent("BAD")).rejects.toThrow("nope");
    await expect(updateParticipant("BAD", "p", {})).rejects.toThrow("nope");
    await expect(fetchParticipantsIncludeHidden("BAD")).rejects.toThrow("nope");
    await expect(unhideParticipant("BAD", "p")).rejects.toThrow("nope");
    await expect(deleteParticipant("BAD", "p")).rejects.toThrow("nope");
    await expect(fetchWeights("BAD")).rejects.toThrow("nope");
    await expect(updateWeights("BAD", [])).rejects.toThrow("nope");
    await expect(
      submitFeedback({
        category: "problem",
        message: "Failed",
      })
    ).rejects.toThrow("nope");
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
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(jsonResponse({ detail: "Duplicate conflict" }, { status: 409 }))
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
    await expect(deleteEvent("ABC", {}, "tok")).rejects.toThrow("Request failed");
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
            participant: { id: "participant-1", version: 4 },
          },
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(jsonResponse({ detail: "Responses are locked" }, { status: 423 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 400 }))
      .mockResolvedValueOnce(textResponse("gateway", { status: 502 }));

    await expect(updateParticipant("ABC", "participant-1", {}, "tok")).rejects.toMatchObject({
      message: "Response version conflict",
      status: 409,
      participant: { id: "participant-1", version: 4 },
    });
    await expect(updateParticipant("ABC", "participant-1", {}, "tok")).rejects.toMatchObject({
      message: "Responses are locked",
      status: 423,
      participant: null,
    });
    await expect(updateParticipant("ABC", "participant-1", {}, "tok")).rejects.toMatchObject({
      message: "Request failed",
      status: 400,
      participant: null,
    });
    await expect(updateParticipant("ABC", "participant-1", {}, "tok")).rejects.toMatchObject({
      message: "HTTP 502",
      status: 502,
      participant: null,
    });
  });
});
