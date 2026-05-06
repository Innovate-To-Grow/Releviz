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
    createParticipantIfAbsent: jest.fn(),
    createUserEvent: jest.fn(),
    getParticipant: jest.fn(),
    updateParticipant: jest.fn(),
  },
}));

const { schedulerStore } = await import("../../lib/store/index.js");
const { default: app } = await import("../../server.js");

function primeAuth(userId = "user-1", displayName = "Alice") {
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

const EVENT = {
  eventCode: "EVENT123",
  eventId: "evt-1",
  organizerUserId: "organizer-1",
  startHour: 9,
  endHour: 17,
};

describe("GET /api/events/participants", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
    schedulerStore.getEvent.mockResolvedValue(EVENT);
  });

  test("requires authentication", async () => {
    const res = await invokeApp(app, { url: "/api/events/participants?code=EVENT123" });
    expect(res.status).toBe(401);
  });

  test("returns participant data for authenticated users", async () => {
    schedulerStore.listParticipants.mockResolvedValue([
      {
        participantId: "user-1",
        userId: "user-1",
        eventId: "evt-1",
        participantName: "Alice",
        scheduleInperson: "[0,1]",
        scheduleVirtual: "[1,1]",
        submitted: 1,
        hidden: 0,
        createdAt: "2026-03-03T00:00:00.000Z",
      },
    ]);

    const res = await invokeApp(app, {
      url: "/api/events/participants?code=EVENT123",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(200);
    expect(res.body.participants[0]).toMatchObject({
      id: "user-1",
      user_id: "user-1",
      name: "Alice",
    });
  });
});

describe("POST /api/events/participants", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
    schedulerStore.getEvent.mockResolvedValue(EVENT);
    schedulerStore.createUserEvent.mockResolvedValue(undefined);
  });

  test("creates a participant for the authenticated Clerk user", async () => {
    schedulerStore.createParticipantIfAbsent.mockImplementation(async (payload) => ({
      created: true,
      participant: {
        participantId: payload.participantId,
        userId: payload.userId,
        eventId: EVENT.eventId,
        participantName: payload.participantName,
        scheduleInperson: payload.scheduleInperson,
        scheduleVirtual: payload.scheduleVirtual,
        submitted: 0,
        hidden: 0,
        createdAt: "2026-03-03T00:00:00.000Z",
      },
    }));

    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/events/participants?code=EVENT123",
      headers: { cookie: "__session=test" },
      body: {},
    });

    expect(res.status).toBe(201);
    expect(res.body.participant.id).toBe("user-1");
    expect(res.body.participant.name).toBe("Alice");
    expect(schedulerStore.createUserEvent).toHaveBeenCalledWith({
      userId: "user-1",
      eventCode: "EVENT123",
      role: "participant",
    });
  });

  test("does not overwrite organizer role when organizer joins their own event", async () => {
    primeAuth("organizer-1", "Organizer");
    schedulerStore.getEvent.mockResolvedValue({ ...EVENT, organizerUserId: "organizer-1" });
    schedulerStore.createParticipantIfAbsent.mockResolvedValue({
      created: true,
      participant: {
        participantId: "organizer-1",
        userId: "organizer-1",
        eventId: EVENT.eventId,
        participantName: "Organizer",
        scheduleInperson: JSON.stringify(Array(56).fill(0)),
        scheduleVirtual: JSON.stringify(Array(56).fill(0)),
        submitted: 0,
        hidden: 0,
        createdAt: "2026-03-03T00:00:00.000Z",
      },
    });

    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/events/participants?code=EVENT123",
      headers: { cookie: "__session=test" },
      body: {},
    });

    expect(res.status).toBe(201);
    expect(schedulerStore.createUserEvent).not.toHaveBeenCalled();
  });

  test("links participant to dashboard even when participant already existed (retry scenario)", async () => {
    schedulerStore.createParticipantIfAbsent.mockResolvedValue({
      created: false, // participant already exists — simulates a retry
      participant: {
        participantId: "user-1",
        userId: "user-1",
        eventId: EVENT.eventId,
        participantName: "Alice",
        scheduleInperson: JSON.stringify(Array(56).fill(0)),
        scheduleVirtual: JSON.stringify(Array(56).fill(0)),
        submitted: 0,
        hidden: 0,
        createdAt: "2026-03-03T00:00:00.000Z",
      },
    });

    const res = await invokeApp(app, {
      method: "POST",
      url: "/api/events/participants?code=EVENT123",
      headers: { cookie: "__session=test" },
      body: {},
    });

    expect(res.status).toBe(200);
    // createUserEvent must still be called even when created === false
    expect(schedulerStore.createUserEvent).toHaveBeenCalledWith({
      userId: "user-1",
      eventCode: "EVENT123",
      role: "participant",
    });
  });
});

describe("PUT /api/events/participants/update", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth();
    schedulerStore.getEvent.mockResolvedValue(EVENT);
    schedulerStore.getParticipant.mockResolvedValue({
      participantId: "user-1",
      userId: "user-1",
      eventId: EVENT.eventId,
      participantName: "Alice",
      scheduleInperson: JSON.stringify(Array(56).fill(0)),
      scheduleVirtual: JSON.stringify(Array(56).fill(0)),
      submitted: 0,
      createdAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("allows a participant to update their own schedule", async () => {
    schedulerStore.updateParticipant.mockResolvedValue({
      participantId: "user-1",
      userId: "user-1",
      eventId: EVENT.eventId,
      participantName: "Alice",
      scheduleInperson: JSON.stringify(Array(56).fill(0.5)),
      scheduleVirtual: JSON.stringify(Array(56).fill(0)),
      submitted: 1,
      createdAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await invokeApp(app, {
      method: "PUT",
      url: "/api/events/participants/update?code=EVENT123&participantId=user-1",
      headers: { cookie: "__session=test" },
      body: {
        scheduleInperson: Array(56).fill(0.5),
        submitted: 1,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.participant.submitted).toBe(1);
  });

  test("prevents participants from updating someone else", async () => {
    schedulerStore.getParticipant.mockResolvedValue({
      participantId: "user-2",
      userId: "user-2",
      eventId: EVENT.eventId,
      participantName: "Bob",
      scheduleInperson: JSON.stringify(Array(56).fill(0)),
      scheduleVirtual: JSON.stringify(Array(56).fill(0)),
      submitted: 0,
      createdAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await invokeApp(app, {
      method: "PUT",
      url: "/api/events/participants/update?code=EVENT123&participantId=user-2",
      headers: { cookie: "__session=test" },
      body: { submitted: 1 },
    });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/events/participants/update", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeAuth("organizer-1", "Organizer");
    schedulerStore.getEvent.mockResolvedValue({ ...EVENT, organizerUserId: "organizer-1" });
    schedulerStore.getParticipant.mockResolvedValue({
      participantId: "user-2",
      userId: "user-2",
      participantName: "Bob",
    });
    schedulerStore.updateParticipant.mockResolvedValue({
      participantId: "user-2",
      userId: "user-2",
      participantName: "Bob",
      hidden: 1,
    });
  });

  test("allows organizers to hide participants by participantId", async () => {
    const res = await invokeApp(app, {
      method: "DELETE",
      url: "/api/events/participants/update?code=EVENT123&participantId=user-2",
      headers: { cookie: "__session=test" },
    });

    expect(res.status).toBe(200);
    expect(schedulerStore.updateParticipant).toHaveBeenCalledWith("EVENT123", "user-2", {
      hidden: 1,
    });
  });
});
