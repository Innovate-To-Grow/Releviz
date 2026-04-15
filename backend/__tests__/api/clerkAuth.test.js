import { jest } from "@jest/globals";
import request from "supertest";

jest.unstable_mockModule("../../lib/clerk.js", () => ({
  getRequestAuthToken: jest.fn(),
  verifyClerkSessionToken: jest.fn(),
  fetchClerkUser: jest.fn(),
  normalizeClerkUser: jest.fn(),
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

const { getRequestAuthToken, verifyClerkSessionToken, fetchClerkUser, normalizeClerkUser } =
  await import("../../lib/clerk.js");
const { schedulerStore } = await import("../../lib/store/index.js");
const { default: app } = await import("../../server.js");

const MOCK_USER = {
  userId: "clerk-user-1",
  email: "test@example.com",
  displayName: "Test User",
  imageUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Clerk requireAuth middleware", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns 401 when no token", async () => {
    getRequestAuthToken.mockReturnValue(null);
    const res = await request(app).get("/api/dashboard/events");
    expect(res.status).toBe(401);
  });

  test("returns 401 when token verification fails", async () => {
    getRequestAuthToken.mockReturnValue("bad-token");
    verifyClerkSessionToken.mockRejectedValue(new Error("Invalid token"));
    const res = await request(app)
      .get("/api/dashboard/events")
      .set("Authorization", "Bearer bad-token");
    expect(res.status).toBe(401);
  });

  test("syncs new user from Clerk on first request", async () => {
    getRequestAuthToken.mockReturnValue("valid-token");
    verifyClerkSessionToken.mockResolvedValue({ sub: "clerk-user-1" });
    schedulerStore.getUserById.mockResolvedValueOnce(null);
    fetchClerkUser.mockResolvedValue({ id: "clerk-user-1" });
    normalizeClerkUser.mockReturnValue(MOCK_USER);
    schedulerStore.createUser.mockResolvedValue(undefined);
    schedulerStore.listUserEvents.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/dashboard/events")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(schedulerStore.createUser).toHaveBeenCalledWith(MOCK_USER);
  });

  test("uses existing user without creating", async () => {
    getRequestAuthToken.mockReturnValue("valid-token");
    verifyClerkSessionToken.mockResolvedValue({ sub: "clerk-user-1" });
    schedulerStore.getUserById.mockResolvedValue(MOCK_USER);
    fetchClerkUser.mockResolvedValue(MOCK_USER);
    normalizeClerkUser.mockReturnValue(MOCK_USER);
    schedulerStore.listUserEvents.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/dashboard/events")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(schedulerStore.createUser).not.toHaveBeenCalled();
  });

  test("handles concurrent user creation race condition", async () => {
    getRequestAuthToken.mockReturnValue("valid-token");
    verifyClerkSessionToken.mockResolvedValue({ sub: "clerk-user-1" });
    schedulerStore.getUserById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(MOCK_USER);
    fetchClerkUser.mockResolvedValue({ id: "clerk-user-1" });
    normalizeClerkUser.mockReturnValue(MOCK_USER);
    const raceError = new Error("Conditional check failed");
    raceError.name = "ConditionalCheckFailedException";
    schedulerStore.createUser.mockRejectedValue(raceError);
    schedulerStore.listUserEvents.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/dashboard/events")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
  });
});

describe("Clerk optionalAuth middleware", () => {
  beforeEach(() => jest.clearAllMocks());

  test("proceeds without token on health check", async () => {
    getRequestAuthToken.mockReturnValue(null);
    const res = await request(app).get("/api/health");
    expect(res.status).not.toBe(401);
  });

  test("attaches user when valid token provided", async () => {
    getRequestAuthToken.mockReturnValue("valid-token");
    verifyClerkSessionToken.mockResolvedValue({ sub: "clerk-user-1" });
    schedulerStore.getUserById.mockResolvedValue(MOCK_USER);
    fetchClerkUser.mockResolvedValue(MOCK_USER);
    normalizeClerkUser.mockReturnValue(MOCK_USER);
    schedulerStore.getEvent.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/events?code=SOMECODE")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).not.toBe(401);
  });
});


// import { jest } from "@jest/globals";
// import request from "supertest";

// // Create a single shared mock clerk instance
// const mockClerk = {
//   verifyToken: jest.fn(),
//   users: { getUser: jest.fn() },
// };

// // Mock Clerk backend — always return the SAME instance
// jest.unstable_mockModule("@clerk/backend", () => ({
//   createClerkClient: jest.fn(() => mockClerk),
// }));

// jest.unstable_mockModule("../../lib/store/index.js", () => ({
//   schedulerStore: {
//     getUserById: jest.fn(),
//     createUser: jest.fn(),
//     listUserEvents: jest.fn(),
//     getEvent: jest.fn(),
//   },
// }));

// // Import AFTER mocks are set up
// const { schedulerStore } = await import("../../lib/store/index.js");
// const { default: app } = await import("../../server.js");

// const MOCK_USER = {
//   userId: "clerk-user-1",
//   email: "test@example.com",
//   displayName: "Test User",
//   createdAt: "2026-01-01T00:00:00.000Z",
// };

// describe("Clerk requireAuth middleware", () => {
//   beforeEach(() => jest.clearAllMocks());

//   test("returns 401 when no Authorization header", async () => {
//     const res = await request(app).get("/api/dashboard/events");
//     expect(res.status).toBe(401);
//   });

//   test("returns 401 when Authorization header is not Bearer", async () => {
//     const res = await request(app)
//       .get("/api/dashboard/events")
//       .set("Authorization", "Basic sometoken");
//     expect(res.status).toBe(401);
//   });

//   test("returns 401 when Clerk token verification fails", async () => {
//     mockClerk.verifyToken.mockRejectedValue(new Error("Invalid token"));

//     const res = await request(app)
//       .get("/api/dashboard/events")
//       .set("Authorization", "Bearer invalid-token");
//     expect(res.status).toBe(401);
//   });

//   test("syncs new user from Clerk on first request", async () => {
//     mockClerk.verifyToken.mockResolvedValue({ sub: "clerk-user-1" });
//     schedulerStore.getUserById.mockResolvedValueOnce(null);
//     mockClerk.users.getUser.mockResolvedValue({
//       id: "clerk-user-1",
//       firstName: "Test",
//       lastName: "User",
//       emailAddresses: [{ emailAddress: "test@example.com" }],
//     });
//     schedulerStore.createUser.mockResolvedValue(undefined);
//     schedulerStore.listUserEvents.mockResolvedValue([]);

//     const res = await request(app)
//       .get("/api/dashboard/events")
//       .set("Authorization", "Bearer valid-token");

//     expect(res.status).toBe(200);
//     expect(schedulerStore.createUser).toHaveBeenCalledTimes(1);
//     expect(schedulerStore.createUser).toHaveBeenCalledWith(
//       expect.objectContaining({
//         userId: "clerk-user-1",
//         email: "test@example.com",
//         displayName: "Test User",
//       })
//     );
//   });

//   test("uses existing user without calling Clerk profile API", async () => {
//     mockClerk.verifyToken.mockResolvedValue({ sub: "clerk-user-1" });
//     schedulerStore.getUserById.mockResolvedValue(MOCK_USER);
//     schedulerStore.listUserEvents.mockResolvedValue([]);

//     const res = await request(app)
//       .get("/api/dashboard/events")
//       .set("Authorization", "Bearer valid-token");

//     expect(res.status).toBe(200);
//     expect(mockClerk.users.getUser).not.toHaveBeenCalled();
//     expect(schedulerStore.createUser).not.toHaveBeenCalled();
//   });

//   test("handles concurrent user creation race condition gracefully", async () => {
//     mockClerk.verifyToken.mockResolvedValue({ sub: "clerk-user-1" });
//     schedulerStore.getUserById
//       .mockResolvedValueOnce(null)
//       .mockResolvedValueOnce(MOCK_USER);
//     mockClerk.users.getUser.mockResolvedValue({
//       id: "clerk-user-1",
//       firstName: "Test",
//       lastName: "User",
//       emailAddresses: [{ emailAddress: "test@example.com" }],
//     });
//     const raceError = new Error("Conditional check failed");
//     raceError.name = "ConditionalCheckFailedException";
//     schedulerStore.createUser.mockRejectedValue(raceError);
//     schedulerStore.listUserEvents.mockResolvedValue([]);

//     const res = await request(app)
//       .get("/api/dashboard/events")
//       .set("Authorization", "Bearer valid-token");

//     expect(res.status).toBe(200);
//   });
// });

// describe("Clerk optionalAuth middleware", () => {
//   beforeEach(() => jest.clearAllMocks());

//   test("proceeds without token on public routes", async () => {
//     const res = await request(app).get("/api/events?code=SOMECODE");
//     expect(res.status).not.toBe(401);
//   });

//   test("attaches user when valid token provided", async () => {
//     mockClerk.verifyToken.mockResolvedValue({ sub: "clerk-user-1" });
//     schedulerStore.getUserById.mockResolvedValue(MOCK_USER);
//     schedulerStore.getEvent.mockResolvedValue(null);

//     const res = await request(app)
//       .get("/api/events?code=SOMECODE")
//       .set("Authorization", "Bearer valid-token");

//     expect(res.status).not.toBe(401);
//   });
// });