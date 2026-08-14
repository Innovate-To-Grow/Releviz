/**
 * @jest-environment jsdom
 */

import {
  fetchTempAccessSession,
  logoutTempAccess,
  requestTempAccessCode,
  updateTempAccessParticipant,
  verifyTempAccess,
} from "@/lib/api/tempAccess";

function jsonResponse(payload, init = {}) {
  const status = init.status ?? 200;
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  };
  response.clone = jest.fn(() => jsonResponse(payload, init));
  return response;
}

describe("temporary access API", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  test("uses the restricted cookie session for code request and verification", async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse({ accepted: true }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ event: { code: "ABC123" } }));

    await requestTempAccessCode({
      code: "ABC123",
      invitationToken: "invite-token",
    });
    await verifyTempAccess({
      code: "ABC123",
      invitationToken: "invite-token",
      verificationCode: "123456",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/events/temp-access/request-code",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          code: "ABC123",
          invitationToken: "invite-token",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/events/temp-access/verify",
      expect.objectContaining({
        credentials: "include",
        body: JSON.stringify({
          code: "ABC123",
          invitationToken: "invite-token",
          verificationCode: "123456",
        }),
      }),
    );
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
});
