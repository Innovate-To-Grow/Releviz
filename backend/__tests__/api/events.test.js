import { jest } from "@jest/globals";
import request from "supertest";

jest.unstable_mockModule("../../lib/store/index.js", () => ({
  schedulerStore: {
    getEvent: jest.fn(),
    createEvent: jest.fn(),
  },
}));

const { schedulerStore } = await import("../../lib/store/index.js");
const { default: app } = await import("../../server.js");

describe("POST /api/events", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    schedulerStore.createEvent.mockResolvedValue(true);
  });

  test("creates an event and returns 201 with event data", async () => {
    const res = await request(app).post("/api/events").send({
      name: "Team Sync",
      password: "secret123",
      startHour: 9,
      endHour: 17,
      location: "Room A",
    });

    expect(res.status).toBe(201);
    expect(res.body.event.name).toBe("Team Sync");
    expect(res.body.event.startHour).toBe(9);
    expect(res.body.event.endHour).toBe(17);
    expect(res.body.event.code).toHaveLength(8);
    expect(res.body.event.code).toMatch(/^[A-Za-z0-9]+$/);
  });

  test("hashes password before storing", async () => {
    await request(app).post("/api/events").send({
      name: "Persisted",
      password: "mypass",
      startHour: 8,
      endHour: 20,
      location: "HQ",
    });

    expect(schedulerStore.createEvent).toHaveBeenCalledTimes(1);
    const payload = schedulerStore.createEvent.mock.calls[0][0];
    expect(payload.passwordHash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
    expect(payload.passwordHash).not.toContain("mypass");
  });

  test("returns password in response for redirect", async () => {
    const res = await request(app).post("/api/events").send({
      name: "WithPass",
      password: "secret123",
      startHour: 9,
      endHour: 17,
      location: "Office",
    });
    expect(res.status).toBe(201);
    expect(res.body.password).toBe("secret123");
    expect(res.body.event.password).toBeUndefined();
  });

  test("uses default time range (9-17) when not provided", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ name: "Defaults", password: "pw", location: "HQ" });
    expect(res.body.event.startHour).toBe(9);
    expect(res.body.event.endHour).toBe(17);
  });

  test("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ password: "pw", startHour: 9, endHour: 17 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test("returns 400 when password is missing", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ name: "NoPass", startHour: 9, endHour: 17, location: "HQ" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  test("defaults location to TBD when not provided for in-person events", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ name: "Meeting", password: "pw", startHour: 9, endHour: 17, mode: "inperson" });
    expect(res.status).toBe(201);
    expect(res.body.event.location).toBe("TBD");
  });

  test("rejects mode 'both'", async () => {
    const res = await request(app).post("/api/events").send({
      name: "Hybrid",
      password: "pw",
      startHour: 9,
      endHour: 17,
      mode: "both",
      location: "HQ",
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when startHour >= endHour", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ name: "Bad Time", password: "pw", startHour: 17, endHour: 9, location: "HQ" });
    expect(res.status).toBe(400);
  });

  test("returns 400 when endHour exceeds 24", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ name: "Late", password: "pw", startHour: 0, endHour: 25, location: "HQ" });
    expect(res.status).toBe(400);
  });

  test("returns 500 when code collisions exceed retry limit", async () => {
    schedulerStore.createEvent.mockResolvedValue(false);
    const res = await request(app)
      .post("/api/events")
      .send({ name: "Collision", password: "pw", startHour: 9, endHour: 10, location: "HQ" });
    expect(res.status).toBe(500);
    expect(schedulerStore.createEvent).toHaveBeenCalledTimes(3);
  });
});

describe("GET /api/events?code=", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns 200 with event metadata", async () => {
    schedulerStore.getEvent.mockResolvedValue({
      eventCode: "ABC12345",
      name: "Existing Event",
      startHour: 10,
      endHour: 18,
      days: [1, 2, 3],
      mode: "inperson",
      location: "Office",
      createdAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await request(app).get("/api/events?code=ABC12345");
    expect(res.status).toBe(200);
    expect(res.body.event.code).toBe("ABC12345");
    expect(res.body.event.name).toBe("Existing Event");
    expect(res.body.event.startHour).toBe(10);
    expect(res.body.event.endHour).toBe(18);
    expect(res.body.event.days).toEqual([1, 2, 3]);
    expect(res.body.event.mode).toBe("inperson");
    expect(res.body.event.createdAt).toBeTruthy();
  });

  test("does not expose password hash", async () => {
    schedulerStore.getEvent.mockResolvedValue({
      eventCode: "ABC12345",
      name: "Existing Event",
      passwordHash: "secret-hash",
      startHour: 10,
      endHour: 18,
      days: [1, 2, 3],
      mode: "inperson",
      location: "Office",
      createdAt: "2026-03-03T00:00:00.000Z",
    });
    const res = await request(app).get("/api/events?code=ABC12345");
    expect(JSON.stringify(res.body)).not.toContain("password");
  });

  test("returns 404 for unknown code", async () => {
    schedulerStore.getEvent.mockResolvedValue(null);
    const res = await request(app).get("/api/events?code=XXXXXXXX");
    expect(res.status).toBe(404);
  });
});
