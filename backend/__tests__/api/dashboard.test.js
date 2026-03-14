import { jest } from "@jest/globals";
import request from "supertest";

jest.unstable_mockModule("../../lib/store/index.js", () => ({
  schedulerStore: {
    getEvent: jest.fn(),
    createEvent: jest.fn(),
    createUser: jest.fn(),
    getUserByEmail: jest.fn(),
    getUserById: jest.fn(),
    updateUser: jest.fn(),
    listUserEvents: jest.fn(),
    createUserEvent: jest.fn(),
  },
}));

const { schedulerStore } = await import("../../lib/store/index.js");
const { default: app } = await import("../../server.js");
const { signToken } = await import("../../lib/auth.js");

describe("GET /api/dashboard/events", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns 401 without token", async () => {
    const res = await request(app).get("/api/dashboard/events");
    expect(res.status).toBe(401);
  });

  test("returns organized and participating events", async () => {
    const token = signToken("user-1");
    schedulerStore.listUserEvents.mockResolvedValue([
      { userId: "user-1", eventCode: "EVT1", role: "organizer" },
      { userId: "user-1", eventCode: "EVT2", role: "participant" },
    ]);
    schedulerStore.getEvent
      .mockResolvedValueOnce({
        eventCode: "EVT1",
        name: "My Event",
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
        startHour: 10,
        endHour: 16,
        days: [1, 3, 5],
        mode: "virtual",
        location: "",
        createdAt: "2026-01-02T00:00:00.000Z",
      });

    const res = await request(app).get("/api/dashboard/events").set("Cookie", `token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.organized).toHaveLength(1);
    expect(res.body.organized[0].name).toBe("My Event");
    expect(res.body.participating).toHaveLength(1);
    expect(res.body.participating[0].name).toBe("Other Event");
  });

  test("handles missing events gracefully", async () => {
    const token = signToken("user-1");
    schedulerStore.listUserEvents.mockResolvedValue([
      { userId: "user-1", eventCode: "GONE", role: "organizer" },
    ]);
    schedulerStore.getEvent.mockResolvedValue(null);

    const res = await request(app).get("/api/dashboard/events").set("Cookie", `token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.organized).toHaveLength(0);
    expect(res.body.participating).toHaveLength(0);
  });
});
