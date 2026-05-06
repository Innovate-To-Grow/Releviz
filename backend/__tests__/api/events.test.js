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
    createEvent: jest.fn(),
    createUserEvent: jest.fn(),
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

describe("POST /api/events", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
    schedulerStore.createEvent.mockResolvedValue(true);
    schedulerStore.createUserEvent.mockResolvedValue(undefined);
  });

  test("requires authentication", async () => {
    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/events",
      body: { name: "Team Sync" },
    });
    expect(res.status).toBe(401);
  });

  test("creates an event without anonymous password fields", async () => {
    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/events",
      headers: { cookie: "__session=test" },
      body: {
        name: "Team Sync",
        startHour: 9,
        endHour: 17,
        location: "Room A",
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.event.name).toBe("Team Sync");
    expect(res.body.event.code).toHaveLength(8);
    const payload = schedulerStore.createEvent.mock.calls[0][0];
    expect(payload.organizerUserId).toBe("user-1");
    expect(payload.passwordHash).toBeUndefined();
    expect(payload.participantVerification).toBeUndefined();
    expect(res.body.password).toBeUndefined();
  });

  test("uses default time range when omitted", async () => {
    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/events",
      headers: { cookie: "__session=test" },
      body: { name: "Defaults", location: "HQ" },
    });

    expect(res.status).toBe(201);
    expect(res.body.event.startHour).toBe(9);
    expect(res.body.event.endHour).toBe(17);
  });
});

describe("GET /api/events", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
  });

  test("requires authentication", async () => {
    const res = await invokeApp(app, { url: "/api/events?code=ABC12345" });
    expect(res.status).toBe(401);
  });

  test("returns event metadata for authenticated users", async () => {
    schedulerStore.getEvent.mockResolvedValue({
      eventCode: "ABC12345",
      name: "Existing Event",
      organizerUserId: "user-1",
      startHour: 10,
      endHour: 18,
      days: [1, 2, 3],
      mode: "inperson",
      location: "Office",
      createdAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await invokeApp(app, {
      url: "/api/events?code=ABC12345",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(200);
    expect(res.body.event.code).toBe("ABC12345");
    expect(res.body.event.organizerUserId).toBe("user-1");
    expect(JSON.stringify(res.body)).not.toContain("password");
  });
});
