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
  },
}));

const { schedulerStore } = await import("../../lib/store/index.js");
const { default: app } = await import("../../server.js");

const EVENT = {
  eventCode: "EVT123",
  startHour: 9,
  endHour: 11,
  days: [1, 2, 3, 4, 5],
};

function primeAuth() {
  verifyClerkSessionToken.mockResolvedValue({ sub: "user-1" });
  fetchClerkUser.mockResolvedValue({
    userId: "user-1",
    email: "test@example.com",
    displayName: "Test User",
    imageUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  schedulerStore.getUserById.mockResolvedValue({
    userId: "user-1",
    email: "test@example.com",
    displayName: "Test User",
  });
}

describe("POST /api/solve", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
    schedulerStore.getEvent.mockResolvedValue(EVENT);
  });

  test("returns 401 without auth", async () => {
    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/solve",
      body: { eventCode: "EVT123" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 when eventCode is missing", async () => {
    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/solve",
      headers: { cookie: "__session=test" },
      body: {},
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown event", async () => {
    schedulerStore.getEvent.mockResolvedValue(null);
    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/solve",
      headers: { cookie: "__session=test" },
      body: { eventCode: "UNKNOWN" },
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 when no active participants", async () => {
    schedulerStore.listParticipants.mockResolvedValue([]);
    schedulerStore.listWeights.mockResolvedValue([]);
    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/solve",
      headers: { cookie: "__session=test" },
      body: { eventCode: "EVT123" },
    });
    expect(res.status).toBe(400);
  });

  test("returns optimal slot with ranked results", async () => {
    // 2 hours * 5 days = 10 slots
    const fullSchedule = JSON.stringify(Array(10).fill(0));
    const highAvailSchedule = JSON.stringify([1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);

    schedulerStore.listParticipants.mockResolvedValue([
      {
        participantId: "p-1",
        participantName: "Alice",
        scheduleInperson: highAvailSchedule,
        scheduleVirtual: fullSchedule,
        hidden: 0,
      },
      {
        participantId: "p-2",
        participantName: "Bob",
        scheduleInperson: highAvailSchedule,
        scheduleVirtual: fullSchedule,
        hidden: 0,
      },
    ]);
    schedulerStore.listWeights.mockResolvedValue([
      { participantId: "p-1", weight: 1.0, included: 1 },
      { participantId: "p-2", weight: 0.8, included: 1 },
    ]);

    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/solve",
      headers: { cookie: "__session=test" },
      body: { eventCode: "EVT123" },
    });

    expect(res.status).toBe(200);
    expect(res.body.optimal).toBeTruthy();
    expect(res.body.optimal.score).toBeGreaterThan(0);
    expect(res.body.ranked).toBeInstanceOf(Array);
    expect(res.body.ranked.length).toBeGreaterThan(0);
    expect(res.body.optimal).toHaveProperty("day");
    expect(res.body.optimal).toHaveProperty("time");
  });

  test("returns empty ranked when no slots satisfy constraints", async () => {
    const zeroSchedule = JSON.stringify(Array(10).fill(0));
    schedulerStore.listParticipants.mockResolvedValue([
      {
        participantId: "p-1",
        participantName: "Alice",
        scheduleInperson: zeroSchedule,
        scheduleVirtual: zeroSchedule,
        hidden: 0,
      },
    ]);
    schedulerStore.listWeights.mockResolvedValue([
      { participantId: "p-1", weight: 1.0, included: 1 },
    ]);

    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/solve",
      headers: { cookie: "__session=test" },
      body: { eventCode: "EVT123", quorum: 1 },
    });

    expect(res.status).toBe(200);
    expect(res.body.optimal).toBeNull();
    expect(res.body.ranked).toHaveLength(0);
  });

  test("excludes hidden participants from calculation", async () => {
    const schedule = JSON.stringify(Array(10).fill(1));
    schedulerStore.listParticipants.mockResolvedValue([
      {
        participantId: "p-1",
        participantName: "Alice",
        scheduleInperson: schedule,
        scheduleVirtual: schedule,
        hidden: 0,
      },
      {
        participantId: "p-2",
        participantName: "Hidden Bob",
        scheduleInperson: schedule,
        scheduleVirtual: schedule,
        hidden: 1,
      },
    ]);
    schedulerStore.listWeights.mockResolvedValue([
      { participantId: "p-1", weight: 1.0, included: 1 },
    ]);

    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/solve",
      headers: { cookie: "__session=test" },
      body: { eventCode: "EVT123" },
    });

    expect(res.status).toBe(200);
    expect(res.body.optimal).toBeTruthy();
  });
});
