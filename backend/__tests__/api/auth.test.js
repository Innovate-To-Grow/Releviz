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

function clerkUser(overrides = {}) {
  return {
    userId: "user-1",
    email: "test@example.com",
    displayName: "Test User",
    imageUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Clerk-backed auth middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyClerkSessionToken.mockResolvedValue({ sub: "user-1" });
    fetchClerkUser.mockResolvedValue(clerkUser());
    schedulerStore.getUserById.mockResolvedValue(clerkUser());
    schedulerStore.listUserEvents.mockResolvedValue([]);
  });

  test("returns 401 without a session token", async () => {
    const res = await invokeApp(app, { url: "/api/dashboard/events" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication required/i);
  });

  test("creates a local cached user on first authenticated request", async () => {
    schedulerStore.getUserById.mockResolvedValue(null);
    schedulerStore.createUser.mockResolvedValue(undefined);

    const res = await invokeApp(app, {
      url: "/api/dashboard/events",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(200);
    expect(verifyClerkSessionToken).toHaveBeenCalledWith("test");
    expect(fetchClerkUser).toHaveBeenCalledWith("user-1");
    expect(schedulerStore.createUser).toHaveBeenCalledWith(clerkUser());
  });

  test("updates the local cached user when Clerk profile data changes", async () => {
    schedulerStore.getUserById.mockResolvedValue(clerkUser({ displayName: "Old Name" }));
    schedulerStore.updateUser.mockResolvedValue(clerkUser({ displayName: "Test User" }));

    const res = await invokeApp(app, {
      url: "/api/dashboard/events",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(200);
    expect(schedulerStore.updateUser).toHaveBeenCalledWith("user-1", {
      displayName: "Test User",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
