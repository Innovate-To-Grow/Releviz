import { maybeHandleDemoRequest, resetDemoData } from "@/lib/demo/api";
import {
  DEMO_DELIVERY_REQUEST,
  DEMO_EVENT,
  DEMO_EVENT_CODE,
  DEMO_PARTICIPANTS,
  DEMO_RESULTS,
} from "@/lib/demo/eventData";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const FIRST_BULK_KEY = "11111111-1111-4111-8111-111111111111";
const SECOND_BULK_KEY = "22222222-2222-4222-8222-222222222222";

function setNodeEnvironment(value) {
  process.env.NODE_ENV = value;
}

async function responseJson(response) {
  expect(response).toBeInstanceOf(Response);
  return response.json();
}

describe("local design-preview API", () => {
  beforeEach(() => {
    setNodeEnvironment("development");
    resetDemoData();
  });

  afterAll(() => {
    setNodeEnvironment(ORIGINAL_NODE_ENV);
  });

  test("returns a cloned event payload for the demo event", async () => {
    const response = maybeHandleDemoRequest(`/events?code=${DEMO_EVENT_CODE}`);
    const payload = await responseJson(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({ event: DEMO_EVENT });
    expect(payload.event).not.toBe(DEMO_EVENT);
  });

  test("filters and paginates the demo roster with matching statistics", async () => {
    const response = maybeHandleDemoRequest(
      `/events/roster?code=${DEMO_EVENT_CODE}&group=Design&page=2&pageSize=2`,
    );
    const payload = await responseJson(response);

    expect(payload.participants.map(({ name }) => name)).toEqual(["Mia Davis"]);
    expect(payload.pagination).toEqual({
      page: 2,
      pageSize: 2,
      total: 3,
      pages: 2,
    });
    expect(payload.stats).toEqual(
      expect.objectContaining({
        total: 3,
        submitted: 2,
        notSubmitted: 1,
        included: 2,
        excluded: 1,
      }),
    );
    expect(payload.stats.groups).toEqual([{ name: "Design", count: 3 }]);
    expect(payload.latestDeliveryRequest).toEqual(DEMO_DELIVERY_REQUEST);
  });

  test("combines search, response, and invitation filters", async () => {
    const response = maybeHandleDemoRequest(
      `/events/roster?code=${DEMO_EVENT_CODE}&search=engineering&submitted=false&invitationStatus=invited`,
    );
    const payload = await responseJson(response);

    expect(payload.participants).toHaveLength(1);
    expect(payload.participants[0]).toEqual(
      expect.objectContaining({
        name: "Lucas Garcia",
        group: "Engineering",
        submitted: false,
        invitationStatus: "invited",
      }),
    );
    expect(payload.pagination.total).toBe(1);
  });

  test("returns results, delivery progress, and an editable temporary schedule", async () => {
    const resultsResponse = maybeHandleDemoRequest(
      `/events/results?code=${DEMO_EVENT_CODE}`,
    );
    const deliveryResponse = maybeHandleDemoRequest(
      `/events/delivery-requests/${DEMO_DELIVERY_REQUEST.id}`,
    );
    const temporaryParticipant = DEMO_PARTICIPANTS.find(
      ({ accountAccess }) => accountAccess === "temporary",
    );
    const scheduleResponse = maybeHandleDemoRequest(
      `/events/roster/${temporaryParticipant.id}/schedule?code=${DEMO_EVENT_CODE}`,
    );

    await expect(resultsResponse.json()).resolves.toEqual(DEMO_RESULTS);
    await expect(deliveryResponse.json()).resolves.toEqual({
      deliveryRequest: DEMO_DELIVERY_REQUEST,
    });
    const schedule = await scheduleResponse.json();
    expect(schedule.participant).toEqual(
      expect.objectContaining({
        id: temporaryParticipant.id,
        accountAccess: "temporary",
      }),
    );
    expect(schedule.schedule.availabilityInperson).toHaveLength(
      DEMO_EVENT.slotCount,
    );
    expect(schedule.schedule.availabilityVirtual).toHaveLength(
      DEMO_EVENT.slotCount,
    );
  });

  test("is disabled outside development and ignores non-demo requests", () => {
    setNodeEnvironment("test");
    expect(
      maybeHandleDemoRequest(`/events?code=${DEMO_EVENT_CODE}`),
    ).toBeNull();

    setNodeEnvironment("production");
    expect(
      maybeHandleDemoRequest(`/events?code=${DEMO_EVENT_CODE}`),
    ).toBeNull();

    setNodeEnvironment("development");
    expect(maybeHandleDemoRequest("/events?code=LIVE2026")).toBeNull();
    expect(
      maybeHandleDemoRequest(`/authn/refresh/?code=${DEMO_EVENT_CODE}`),
    ).toBeNull();
  });

  test("updates a full demo group Weight and returns the changed roster", async () => {
    const response = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          group: "design",
          updates: { weight: 0.35 },
          idempotencyKey: FIRST_BULK_KEY,
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updatedCount: 3,
      matchedCount: 3,
      resultsRevision: DEMO_EVENT.resultsRevision + 1,
      idempotent: false,
    });

    const rosterResponse = maybeHandleDemoRequest(
      `/events/roster?code=${DEMO_EVENT_CODE}&group=Design`,
    );
    const roster = await rosterResponse.json();
    expect(roster.participants).toHaveLength(3);
    expect(roster.participants.every(({ weight }) => weight === 0.35)).toBe(
      true,
    );
    expect(roster.participants.every(({ version }) => version > 1)).toBe(true);

    const repeatedResponse = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          group: "design",
          updates: { weight: 0.35 },
          idempotencyKey: FIRST_BULK_KEY,
        }),
      },
    );
    await expect(repeatedResponse.json()).resolves.toEqual({
      updatedCount: 3,
      matchedCount: 3,
      resultsRevision: DEMO_EVENT.resultsRevision + 1,
      idempotent: true,
    });

    const conflictingResponse = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          group: "design",
          updates: { weight: 0.6 },
          idempotencyKey: FIRST_BULK_KEY,
        }),
      },
    );
    expect(conflictingResponse.status).toBe(409);

    const resultsResponse = maybeHandleDemoRequest(
      `/events/results?code=${DEMO_EVENT_CODE}`,
    );
    await expect(resultsResponse.json()).resolves.toEqual(
      expect.objectContaining({
        status: "fresh",
        requestedRevision: DEMO_EVENT.resultsRevision + 1,
        computedRevision: DEMO_EVENT.resultsRevision + 1,
      }),
    );
  });

  test("applies supported inclusion-only group updates in the demo", async () => {
    const response = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          group: "Design",
          updates: { included: false },
          idempotencyKey: SECOND_BULK_KEY,
        }),
      },
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ updatedCount: 2, matchedCount: 3 }),
    );

    const rosterResponse = maybeHandleDemoRequest(
      `/events/roster?code=${DEMO_EVENT_CODE}&group=Design&included=false`,
    );
    const roster = await rosterResponse.json();
    expect(roster.participants).toHaveLength(3);
    expect(roster.stats).toEqual(
      expect.objectContaining({ included: 0, excluded: 3 }),
    );
  });

  test("validates demo group Weight updates", async () => {
    const malformed = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      { method: "PATCH", body: "{" },
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: "The demo update could not be read.",
    });

    const missingGroup = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          updates: { weight: 0.5 },
          idempotencyKey: FIRST_BULK_KEY,
        }),
      },
    );
    await expect(missingGroup.json()).resolves.toEqual({
      error: "The demo bulk update requires a group.",
    });

    for (const payload of [
      { group: "Design", updates: { weight: 2 } },
      { group: "Design", updates: { weight: "" } },
      { group: "Design", updates: { weight: null } },
    ]) {
      payload.idempotencyKey = FIRST_BULK_KEY;
      const invalid = maybeHandleDemoRequest(
        `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
        { method: "PATCH", body: JSON.stringify(payload) },
      );
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({
        error: "The demo group Weight must be between 0 and 1.",
      });
    }

    const invalidInclusion = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          group: "Design",
          updates: { included: "yes" },
          idempotencyKey: FIRST_BULK_KEY,
        }),
      },
    );
    await expect(invalidInclusion.json()).resolves.toEqual({
      error: "The demo group inclusion value must be true or false.",
    });

    const unsupported = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          group: "Design",
          updates: { group: "Research" },
          idempotencyKey: FIRST_BULK_KEY,
        }),
      },
    );
    await expect(unsupported.json()).resolves.toEqual({
      error: "The demo supports group Weight and inclusion updates.",
    });

    const invalidKey = maybeHandleDemoRequest(
      `/events/roster/bulk?code=${DEMO_EVENT_CODE}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          group: "Design",
          updates: { weight: 0.5 },
          idempotencyKey: "not-a-uuid",
        }),
      },
    );
    await expect(invalidKey.json()).resolves.toEqual({
      error: "The demo idempotency key must be a UUID.",
    });
  });

  test("keeps unrelated recognized demo mutations read-only", async () => {
    const response = maybeHandleDemoRequest(
      `/events/roster?code=${DEMO_EVENT_CODE}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This local design preview is read-only.",
    });
  });
});
