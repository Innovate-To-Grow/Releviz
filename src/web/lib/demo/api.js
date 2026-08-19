import {
  DEMO_DELIVERY_REQUEST,
  DEMO_EVENT,
  DEMO_EVENT_CODE,
  DEMO_PARTICIPANTS,
  DEMO_RESULTS,
} from "@/lib/demo/eventData";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

let demoParticipants = clone(DEMO_PARTICIPANTS);
let demoResultsRevision = DEMO_EVENT.resultsRevision;
let demoBulkReceipts = new Map();

export function resetDemoData() {
  demoParticipants = clone(DEMO_PARTICIPANTS);
  demoResultsRevision = DEMO_EVENT.resultsRevision;
  demoBulkReceipts = new Map();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(clone(payload)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rosterStats(participants) {
  const groups = new Map();
  participants.forEach((participant) => {
    const name = String(participant.group || "").trim();
    const key = name.toLocaleLowerCase();
    const current = groups.get(key) || { name, count: 0 };
    current.count += 1;
    groups.set(key, current);
  });
  const submitted = participants.filter(
    (participant) => participant.submitted,
  ).length;
  const included = participants.filter(
    (participant) => participant.included,
  ).length;
  return {
    total: participants.length,
    submitted,
    notSubmitted: participants.length - submitted,
    included,
    excluded: participants.length - included,
    groups: [...groups.values()],
  };
}

function rosterResponse(searchParams) {
  const search = (searchParams.get("search") || "").trim().toLowerCase();
  const group = searchParams.get("group") || "";
  const submitted = searchParams.get("submitted");
  const invitationStatus = searchParams.get("invitationStatus") || "";
  const accountAccess = searchParams.get("accountAccess") || "";
  const included = searchParams.get("included");
  const filtered = demoParticipants.filter((participant) => {
    const matchesSearch =
      !search ||
      [participant.name, participant.email, participant.group].some((value) =>
        value.toLowerCase().includes(search),
      );
    const participantGroup = String(participant.group || "").trim();
    const matchesGroup =
      !group ||
      (group === "__ungrouped__"
        ? participantGroup === ""
        : participantGroup.toLocaleLowerCase() === group.toLocaleLowerCase());
    const matchesSubmitted =
      submitted === null ||
      submitted === "" ||
      participant.submitted === (submitted === "true");
    const matchesInvitation =
      !invitationStatus || participant.invitationStatus === invitationStatus;
    const matchesAccount =
      !accountAccess || participant.accountAccess === accountAccess;
    const matchesIncluded =
      included === null ||
      included === "" ||
      participant.included === (included === "true");
    return (
      matchesSearch &&
      matchesGroup &&
      matchesSubmitted &&
      matchesInvitation &&
      matchesAccount &&
      matchesIncluded
    );
  });
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const pageSize = Math.max(1, Number(searchParams.get("pageSize")) || 50);
  const start = (page - 1) * pageSize;
  return {
    participants: filtered.slice(start, start + pageSize),
    pagination: {
      page,
      pageSize,
      total: filtered.length,
      pages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    },
    stats: rosterStats(filtered),
    latestDeliveryRequest: DEMO_DELIVERY_REQUEST,
  };
}

function groupBulkResponse(options) {
  let payload;
  try {
    payload = JSON.parse(String(options.body || "{}"));
  } catch {
    return jsonResponse({ error: "The demo update could not be read." }, 400);
  }

  if (!Object.hasOwn(payload || {}, "group")) {
    return jsonResponse(
      { error: "The demo bulk update requires a group." },
      400,
    );
  }
  const updates = payload?.updates;
  const updateKeys =
    updates && typeof updates === "object" ? Object.keys(updates) : [];
  if (
    updateKeys.length === 0 ||
    updateKeys.some((key) => !["weight", "included"].includes(key))
  ) {
    return jsonResponse(
      { error: "The demo supports group Weight and inclusion updates." },
      400,
    );
  }

  const hasWeight = Object.hasOwn(updates, "weight");
  const rawWeight = updates.weight;
  const weight = Number(rawWeight);
  if (
    hasWeight &&
    (rawWeight === "" ||
      rawWeight === null ||
      !Number.isFinite(weight) ||
      weight < 0 ||
      weight > 1)
  ) {
    return jsonResponse(
      { error: "The demo group Weight must be between 0 and 1." },
      400,
    );
  }
  const hasIncluded = Object.hasOwn(updates, "included");
  if (hasIncluded && typeof updates.included !== "boolean") {
    return jsonResponse(
      { error: "The demo group inclusion value must be true or false." },
      400,
    );
  }

  const idempotencyKey = String(payload.idempotencyKey || "");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      idempotencyKey,
    )
  ) {
    return jsonResponse(
      { error: "The demo idempotency key must be a UUID." },
      400,
    );
  }

  const fingerprint = JSON.stringify({
    group: payload.group,
    updates,
  });
  const previous = demoBulkReceipts.get(idempotencyKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      return jsonResponse(
        {
          error:
            "This idempotency key was used for a different demo bulk update.",
        },
        409,
      );
    }
    return jsonResponse({ ...previous.response, idempotent: true });
  }

  const requestedGroup = String(payload.group || "")
    .trim()
    .toLocaleLowerCase();
  let matchedCount = 0;
  let updatedCount = 0;
  demoParticipants = demoParticipants.map((participant) => {
    const participantGroup = String(participant.group || "")
      .trim()
      .toLocaleLowerCase();
    if (participantGroup !== requestedGroup) return participant;
    matchedCount += 1;
    const weightChanged = hasWeight && Number(participant.weight) !== weight;
    const includedChanged =
      hasIncluded && Boolean(participant.included) !== updates.included;
    if (!weightChanged && !includedChanged) return participant;
    updatedCount += 1;
    return {
      ...participant,
      ...(hasWeight ? { weight } : {}),
      ...(hasIncluded ? { included: updates.included } : {}),
      version: Number(participant.version || 0) + 1,
    };
  });

  if (updatedCount > 0) demoResultsRevision += 1;
  const response = {
    updatedCount,
    matchedCount,
    resultsRevision: demoResultsRevision,
    idempotent: false,
  };
  demoBulkReceipts.set(idempotencyKey, { fingerprint, response });
  return jsonResponse(response);
}

function demoResultsResponse() {
  return {
    ...DEMO_RESULTS,
    requestedRevision: demoResultsRevision,
    computedRevision: demoResultsRevision,
    generatedAt:
      demoResultsRevision === DEMO_EVENT.resultsRevision
        ? DEMO_RESULTS.generatedAt
        : "2026-08-19T09:14:00Z",
  };
}

function participantSchedule(participant) {
  const seed = Number(participant.id.slice(-2)) || 1;
  const availabilityInperson = Array.from(
    { length: DEMO_EVENT.slotCount },
    (_, index) => [0, 0.5, 1][(index + seed) % 3],
  );
  return {
    participant: {
      id: participant.id,
      memberId: participant.memberId,
      name: participant.name,
      accountAccess: participant.accountAccess,
      version: participant.version,
    },
    schedule: {
      availabilityInperson,
      availabilityVirtual: [...availabilityInperson].reverse(),
      submitted: participant.submitted,
      version: participant.version,
    },
  };
}

export function maybeHandleDemoRequest(url, options = {}) {
  if (process.env.NODE_ENV !== "development") return null;

  const requestUrl = new URL(String(url), "http://demo.local");
  const method = String(options.method || "GET").toUpperCase();
  const isDemoCode = requestUrl.searchParams.get("code") === DEMO_EVENT_CODE;
  const isEventRequest =
    requestUrl.pathname === "/events" ||
    requestUrl.pathname.startsWith("/events/");
  const isDemoDelivery = requestUrl.pathname.endsWith(
    `/events/delivery-requests/${DEMO_DELIVERY_REQUEST.id}`,
  );
  if (!isEventRequest) return null;
  if (!isDemoCode && !isDemoDelivery) return null;

  if (method === "GET" && requestUrl.pathname.endsWith("/events")) {
    return jsonResponse({
      event: { ...DEMO_EVENT, resultsRevision: demoResultsRevision },
    });
  }
  if (method === "GET" && requestUrl.pathname.endsWith("/events/roster")) {
    return jsonResponse(rosterResponse(requestUrl.searchParams));
  }
  if (method === "GET" && requestUrl.pathname.endsWith("/events/results")) {
    return jsonResponse(demoResultsResponse());
  }
  if (
    method === "PATCH" &&
    requestUrl.pathname.endsWith("/events/roster/bulk")
  ) {
    return groupBulkResponse(options);
  }
  if (method === "GET" && isDemoDelivery) {
    return jsonResponse({ deliveryRequest: DEMO_DELIVERY_REQUEST });
  }
  if (method === "GET" && requestUrl.pathname.includes("/events/roster/")) {
    const participantId = requestUrl.pathname.split("/").at(-2);
    const participant = demoParticipants.find(
      (candidate) => candidate.id === participantId,
    );
    if (participant) return jsonResponse(participantSchedule(participant));
  }

  return jsonResponse(
    { error: "This local design preview is read-only." },
    409,
  );
}
