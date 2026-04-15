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
    listUserEvents: jest.fn(),
    getEvent: jest.fn(),
  },
}));

const { schedulerStore } = await import("../../lib/store/index.js");
const { default: app } = await import("../../server.js");

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
    imageUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("GET /api/dashboard/events", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
  });

  test("returns 401 without auth", async () => {
    const res = await invokeApp(app, { url: "/api/dashboard/events" });
    expect(res.status).toBe(401);
  });

  test("returns organized and participating events", async () => {
    schedulerStore.listUserEvents.mockResolvedValue([
      { userId: "user-1", eventCode: "EVT1", role: "organizer" },
      { userId: "user-1", eventCode: "EVT2", role: "participant" },
    ]);
    schedulerStore.getEvent
      .mockResolvedValueOnce({
        eventCode: "EVT1",
        name: "My Event",
        organizerUserId: "user-1",
        startHour: 9,
        endHour: 17,
        days: [1, 2, 3, 4, 5],
        mode: "inperson",
        location: "Room A",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        eventCode: "EVT2",
        name: "Other Event",
        organizerUserId: "user-2",
        startHour: 10,
        endHour: 16,
        days: [1, 3, 5],
        mode: "virtual",
        location: "",
        createdAt: "2026-01-02T00:00:00.000Z",
      });

    const res = await invokeApp(app, {
      url: "/api/dashboard/events",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(200);
    expect(res.body.organized).toHaveLength(1);
    expect(res.body.participating).toHaveLength(1);
  });

  test("handles missing events gracefully", async () => {
    schedulerStore.listUserEvents.mockResolvedValue([
      { userId: "user-1", eventCode: "GONE", role: "organizer" },
    ]);
    schedulerStore.getEvent.mockResolvedValue(null);

    const res = await invokeApp(app, {
      url: "/api/dashboard/events",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(200);
    expect(res.body.organized).toHaveLength(0);
    expect(res.body.participating).toHaveLength(0);
  });
});