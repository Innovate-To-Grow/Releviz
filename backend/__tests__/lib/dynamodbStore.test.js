import { jest } from "@jest/globals";
import { DynamoSchedulerStore } from "../../lib/store/dynamodb.js";

describe("DynamoSchedulerStore", () => {
  test("createEvent returns false on conditional check failure", async () => {
    const doc = {
      send: jest.fn().mockRejectedValue({ name: "ConditionalCheckFailedException" }),
    };
    const store = new DynamoSchedulerStore({ docClient: doc, tables: mockTables() });

    const created = await store.createEvent({
      eventCode: "ABCD1234",
      name: "Event",
      passwordHash: "hash",
      startHour: 9,
      endHour: 17,
      days: [1, 2, 3, 4, 5],
      mode: "inperson",
      location: "HQ",
    });

    expect(created).toBe(false);
  });

  test("createParticipantIfAbsent returns existing participant on duplicate", async () => {
    const existing = {
      eventCode: "EVENT123",
      eventId: "evt-1",
      participantName: "Alice",
      participantId: "p-1",
      scheduleInperson: "[0,0]",
      scheduleVirtual: "[0,0]",
      submitted: 0,
      createdAt: "2026-03-03T00:00:00.000Z",
    };

    const doc = {
      send: jest
        .fn()
        .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" })
        .mockResolvedValueOnce({ Item: existing }),
    };
    const store = new DynamoSchedulerStore({ docClient: doc, tables: mockTables() });

    const result = await store.createParticipantIfAbsent({
      eventCode: "EVENT123",
      eventId: "evt-1",
      participantName: "Alice",
      scheduleInperson: "[0,0]",
      scheduleVirtual: "[0,0]",
    });

    expect(result.created).toBe(false);
    expect(result.participant.participantName).toBe("Alice");
  });

  test("listWeights normalizes numeric values", async () => {
    const doc = {
      send: jest.fn().mockResolvedValue({
        Items: [{ eventCode: "EVENT123", participantName: "Alice", weight: "0.8", included: "1" }],
      }),
    };
    const store = new DynamoSchedulerStore({ docClient: doc, tables: mockTables() });

    const weights = await store.listWeights("EVENT123");
    expect(weights).toEqual([
      {
        eventCode: "EVENT123",
        participantName: "Alice",
        weight: 0.8,
        included: 1,
      },
    ]);
  });
});

function mockTables() {
  return {
    events: "events",
    participants: "participants",
    weights: "weights",
    users: "users",
    userEvents: "user-events",
  };
}
