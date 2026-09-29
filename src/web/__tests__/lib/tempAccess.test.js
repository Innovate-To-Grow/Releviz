/**
 * @jest-environment jsdom
 */

import {
  fetchTempAccessSession,
  logoutTempAccess,
  openTempAccess,
  updateTempAccessParticipant,
} from "@/lib/api/tempAccess";

function jsonResponse(payload, init = {}) {
  const status = init.status ?? 200;
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => init.headers?.[name] ?? null },
    json: jest.fn().mockResolvedValue(payload),
  };
  response.clone = jest.fn(() => jsonResponse(payload, init));
  return response;
}

describe("temporary access API", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  test("opens the private invitation link with the restricted cookie session", async () => {
    const payload = { event: { code: "ABC123" }, participant: { version: 1 } };
    fetch.mockResolvedValueOnce(jsonResponse(payload));

    await expect(
      openTempAccess({ code: "ABC123", invitationToken: "invite-token" }),
    ).resolves.toEqual(payload);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/events/temp-access/open",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "ABC123",
          invitationToken: "invite-token",
        }),
      }),
    );
  });

  test("maps an inactive invitation to a 404 with its error code", async () => {
    fetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "This invitation link is not active.",
          errorCode: "temp_invitation_inactive",
        },
        { status: 404 },
      ),
    );

    await expect(
      openTempAccess({ code: "ABC123", invitationToken: "stale" }),
    ).rejects.toMatchObject({
      status: 404,
      errorCode: "temp_invitation_inactive",
      message: "This invitation link is not active.",
    });
  });

  test("reports a non-JSON gateway failure with its status only", async () => {
    const response = jsonResponse(null, { status: 502 });
    response.json.mockRejectedValue(new SyntaxError("Unexpected token <"));
    response.clone = jest.fn(() => response);
    fetch.mockResolvedValueOnce(response);

    await expect(
      openTempAccess({ code: "ABC123", invitationToken: "tok" }),
    ).rejects.toMatchObject({
      status: 502,
      message: "HTTP 502",
      errorCode: null,
    });
  });

  test("loads, updates, and logs out without a bearer token", async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse({ participant: { version: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ participant: { version: 2 } }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 204 }));

    await fetchTempAccessSession("A B");
    await updateTempAccessParticipant("A B", {
      submitted: 1,
      expectedVersion: 1,
    });
    await logoutTempAccess("A B");

    expect(fetch.mock.calls[0][0]).toBe(
      "/events/temp-access/session?code=A%20B",
    );
    expect(fetch.mock.calls[1][0]).toBe(
      "/events/temp-access/participant?code=A%20B",
    );
    expect(fetch.mock.calls[1][1]).toEqual(
      expect.objectContaining({ credentials: "include", method: "PUT" }),
    );
    expect(fetch.mock.calls[2][0]).toBe("/events/temp-access/logout");
  });

  test("preserves the latest participant on an optimistic concurrency error", async () => {
    const latest = { id: "person-1", version: 7 };
    fetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "Version conflict",
          errorCode: "participant_version_conflict",
          participant: latest,
        },
        { status: 409 },
      ),
    );

    await expect(
      updateTempAccessParticipant("ABC123", {
        submitted: 0,
        expectedVersion: 6,
      }),
    ).rejects.toMatchObject({
      status: 409,
      errorCode: "participant_version_conflict",
      participant: latest,
      message: "Version conflict",
    });
  });

  test("keeps retry timing from a throttled request", async () => {
    fetch.mockResolvedValueOnce(
      jsonResponse(
        { detail: "Please wait.", retry_after: 60 },
        { status: 429, headers: { "Retry-After": "120" } },
      ),
    );
    await expect(
      openTempAccess({ code: "ABC123", invitationToken: "tok" }),
    ).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 120,
      message: "Please wait.",
    });
  });
});
