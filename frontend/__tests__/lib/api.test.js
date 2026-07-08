/**
 * @jest-environment jsdom
 */

import {
  AUTH_SESSION_KEY,
  apiFetch,
  clearAuthSession,
  extractError,
  readAuthSession,
  writeAuthSession,
} from "@/lib/api/config";
import {
  fetchProfile,
  loginWithPassword,
  logoutApi,
  startRegistration,
  updateProfileApi,
  verifyRegistration,
} from "@/lib/api/auth";
import { fetchDashboardEvents } from "@/lib/api/dashboard";
import { createEvent, fetchEvent } from "@/lib/api/events";
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

describe("api config session helpers", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    global.fetch = jest.fn();
  });

  test("reads, writes, clears, and tolerates malformed sessions", () => {
    const listener = jest.fn();
    window.addEventListener("releviz-auth", listener);
    expect(readAuthSession()).toBeNull();
    writeAuthSession({ access: "a", refresh: "r", user: { id: "1" } });
    expect(readAuthSession().access).toBe("a");
    clearAuthSession();
    expect(readAuthSession()).toBeNull();
    localStorage.setItem(AUTH_SESSION_KEY, "{bad");
    expect(readAuthSession()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
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
    writeAuthSession({ access: "old", refresh: "refresh", user: { id: "1" } });
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

  test("apiFetch skips refresh or clears session when refresh fails", async () => {
    writeAuthSession({ access: "old", refresh: "refresh" });
    global.fetch.mockResolvedValueOnce(textResponse("no", { status: 401 }));
    const skipped = await apiFetch("/api/things", { skipAuthRefresh: true });
    expect(skipped.status).toBe(401);

    global.fetch
      .mockResolvedValueOnce(textResponse("no", { status: 401 }))
      .mockResolvedValueOnce(textResponse("bad", { status: 401 }));
    const failed = await apiFetch("/api/things");
    expect(failed.status).toBe(401);
    expect(readAuthSession()).toBeNull();

    global.fetch.mockResolvedValueOnce(textResponse("no", { status: 401 }));
    const noRefresh = await apiFetch("/api/things");
    expect(noRefresh.status).toBe(401);

    writeAuthSession({ access: "old", refresh: "refresh" });
    global.fetch
      .mockResolvedValueOnce(textResponse("no", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access: "new", refresh: "new-refresh" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await apiFetch("/api/no-headers");
    expect(readAuthSession().refresh).toBe("new-refresh");
  });
});

describe("auth API helpers", () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = jest.fn();
  });

  test("login and verify write sessions; registration returns JSON", async () => {
    const authBody = { access: "a", refresh: "r", user: { id: "u" } };
    global.fetch
      .mockResolvedValueOnce(jsonResponse(authBody))
      .mockResolvedValueOnce(jsonResponse({ message: "started" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse(authBody));

    await expect(loginWithPassword({ email: "a@b.com", password: "pw" })).resolves.toEqual(
      authBody
    );
    expect(readAuthSession().access).toBe("a");
    await expect(startRegistration({ email: "a@b.com" })).resolves.toEqual({
      message: "started",
    });
    await expect(verifyRegistration({ email: "a@b.com", code: "123456" })).resolves.toEqual(
      authBody
    );

    global.fetch.mockResolvedValueOnce(jsonResponse({ message: "ok" }));
    await expect(loginWithPassword({ email: "a@b.com", password: "pw" })).resolves.toEqual({
      message: "ok",
    });
  });

  test("auth helpers throw extracted errors and update profile sessions", async () => {
    writeAuthSession({ access: "a", refresh: "r", user: { id: "old" } });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ detail: "bad" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ error: "no" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "new" } }))
      .mockResolvedValueOnce(jsonResponse({ detail: "profile bad" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "updated" } }))
      .mockResolvedValueOnce(jsonResponse({ detail: "update bad" }, { status: 400 }));

    await expect(loginWithPassword({ email: "x", password: "bad" })).rejects.toThrow("bad");
    await expect(startRegistration({})).rejects.toThrow("no");
    await expect(fetchProfile()).resolves.toEqual({ id: "new" });
    await expect(fetchProfile()).rejects.toThrow("profile bad");
    await expect(updateProfileApi({ first_name: "Ada" })).resolves.toEqual({ id: "updated" });
    expect(readAuthSession().user.id).toBe("updated");
    await expect(updateProfileApi({ first_name: "Ada" })).rejects.toThrow("update bad");
  });

  test("logout posts refresh when present and always clears", async () => {
    writeAuthSession({ access: "a", refresh: "r" });
    global.fetch.mockResolvedValueOnce(textResponse("", { status: 500 }));
    await logoutApi();
    expect(readAuthSession()).toBeNull();

    writeAuthSession({ access: "a", refresh: "r" });
    global.fetch.mockRejectedValueOnce(new Error("network"));
    await logoutApi();
    expect(readAuthSession()).toBeNull();

    await logoutApi();
    expect(global.fetch).toHaveBeenCalledTimes(2);
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
        startHour: 9,
        endHour: 10,
        days: [1],
        mode: "mixed",
        location: "Room",
        participantViewPermission: "all",
        daySelectionType: "specific_dates",
        specificDates: ["2026-07-08"],
      },
      "tok"
    );
    await fetchEvent("ABC 123", "tok");
    await fetchParticipants("ABC 123", "tok");
    await joinEvent("ABC 123", "tok");
    await updateParticipant("ABC 123", "user 1", { submitted: 1 }, "tok");
    await fetchParticipantsIncludeHidden("ABC 123", "tok");
    await unhideParticipant("ABC 123", "user 1", "tok");
    await deleteParticipant("ABC 123", "user 1", "tok");
    await fetchWeights("ABC 123", "tok");
    await updateWeights("ABC 123", [{ participantId: "user 1", weight: 1 }], "tok");

    const urls = global.fetch.mock.calls.map(([url]) => url);
    expect(urls).toContain("/api/dashboard/events");
    expect(urls).toContain("/api/events?code=ABC%20123");
    expect(urls).toContain("/api/events/participants?code=ABC%20123&includeHidden=true");
    expect(urls).toContain(
      "/api/events/participants/update/unhide?code=ABC%20123&participantId=user%201"
    );
  });

  test("business API helpers throw extracted errors", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ error: "nope" }, { status: 400 }));
    await expect(createEvent({ name: "Bad" })).rejects.toThrow("nope");
    await expect(fetchDashboardEvents()).rejects.toThrow("nope");
    await expect(fetchEvent("BAD")).rejects.toThrow("nope");
    await expect(fetchParticipants("BAD")).rejects.toThrow("nope");
    await expect(joinEvent("BAD")).rejects.toThrow("nope");
    await expect(updateParticipant("BAD", "p", {})).rejects.toThrow("nope");
    await expect(fetchParticipantsIncludeHidden("BAD")).rejects.toThrow("nope");
    await expect(unhideParticipant("BAD", "p")).rejects.toThrow("nope");
    await expect(deleteParticipant("BAD", "p")).rejects.toThrow("nope");
    await expect(fetchWeights("BAD")).rejects.toThrow("nope");
    await expect(updateWeights("BAD", [])).rejects.toThrow("nope");
  });
});
