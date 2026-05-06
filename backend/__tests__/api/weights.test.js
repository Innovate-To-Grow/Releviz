import { jest } from "@jest/globals";
import { invokeApp } from "./testUtils.js";

const verifyClerkSessionToken = jest.fn();
const fetchClerkUser = jest.fn();

jest.unstable_mockModule("../../lib/clerk.js", () => ({
  getRequestAuthToken: (req) => req.cookies?.__session || null,
  verifyClerkSessionToken,
  fetchClerkUser,
  normalizeClerkUser: (user) => user,
}));

jest.unstable_mockModule("../../lib/store/index.js", () => ({
  schedulerStore: {
    getUserById: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    getEvent: jest.fn(),
    listParticipants: jest.fn(),
    listWeights: jest.fn(),
    upsertWeights: jest.fn(),
  },
}));

const { schedulerStore } = await import("../../lib/store/index.js");
const { default: app } = await import("../../server.js");

function primeAuth(userId = "organizer-1", displayName = "Organizer") {
  verifyClerkSessionToken.mockResolvedValue({ sub: userId });
  fetchClerkUser.mockResolvedValue({
    userId,
    email: `${displayName.toLowerCase()}@example.com`,
    displayName,
    imageUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  schedulerStore.getUserById.mockResolvedValue({
    userId,
    email: `${displayName.toLowerCase()}@example.com`,
    displayName,
    imageUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("GET /api/events/weights", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
    schedulerStore.getEvent.mockResolvedValue({
      eventCode: "EVENT123",
      organizerUserId: "organizer-1",
    });
  });

  test("requires organizer authentication", async () => {
    const res = await invokeApp(app, { url: "/api/events/weights?code=EVENT123" });
    expect(res.status).toBe(401);
  });

  test("returns weights for organizers", async () => {
    schedulerStore.listWeights.mockResolvedValue([
      { participantId: "user-1", participantName: "Alice", weight: 0.8, included: 1 },
    ]);

    const res = await invokeApp(app, {
      url: "/api/events/weights?code=EVENT123",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(200);
    expect(res.body.weights[0]).toMatchObject({
      participant_id: "user-1",
      participant_name: "Alice",
      weight: 0.8,
    });
  });

  test("rejects non-organizers", async () => {
    primeAuth("user-1", "Alice");
    schedulerStore.getEvent.mockResolvedValue({
      eventCode: "EVENT123",
      organizerUserId: "organizer-1",
    });

    const res = await invokeApp(app, {
      url: "/api/events/weights?code=EVENT123",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(403);
  });
});

describe("PUT /api/events/weights", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
    schedulerStore.getEvent.mockResolvedValue({
      eventCode: "EVENT123",
      organizerUserId: "organizer-1",
    });
    schedulerStore.listParticipants.mockResolvedValue([
      { participantId: "user-1", participantName: "Alice" },
      { participantId: "user-2", participantName: "Bob" },
    ]);
    schedulerStore.listWeights.mockResolvedValue([
      { participantId: "user-1", participantName: "Alice", weight: 0.8, included: 1 },
    ]);
  });

  test("upserts weights by participantId", async () => {
    const res = await invokeApp(app, {
      method: "PUT",
      url: "/api/events/weights?code=EVENT123",
      headers: { cookie: "__session=test" },
      body: { weights: [{ participantId: "user-1", weight: 0.8, included: 1 }] },
    });

    expect(res.status).toBe(200);
    expect(schedulerStore.upsertWeights).toHaveBeenCalledWith("EVENT123", [
      { participantId: "user-1", participantName: "Alice", weight: 0.8, included: 1 },
    ]);
  });
});
