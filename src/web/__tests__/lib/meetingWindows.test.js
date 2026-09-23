import {
  COLUMNS_PER_PAGE,
  addDays,
  buildColumns,
  cellMetrics,
  cellState,
  confirmedBlock,
  daysBetween,
  defaultView,
  formatDate,
  formatDateLabel,
  formatRangeLabel,
  formatWeekLabel,
  formatWindowLabel,
  groupKind,
  localDateOf,
  normalizeSlotGroups,
  pageCount,
  recommendationBlocks,
  selectionBlock,
  selectionFromRecommendation,
  selectionFromWindow,
  selectionKey,
  selectionMatchesRecommendation,
  slotByIndex,
  weekStartOf,
  weekdayOf,
  windowAt,
  windowMetrics,
  windowSlotCount,
} from "@/lib/meetingWindows";
import { createLocalDateTimeResolver } from "@/lib/time";

const LA = "America/Los_Angeles";
const utcResolver = createLocalDateTimeResolver("UTC");
const laResolver = createLocalDateTimeResolver(LA);

// Locale-stable expectations: build the same Intl output the model builds.
const utcDate = (date) => new Date(`${date}T00:00:00Z`);
const localeDate = (date, options) =>
  utcDate(date).toLocaleDateString([], { timeZone: "UTC", ...options });
const localeDateTime = (iso, timeZone, options) =>
  new Date(iso).toLocaleString([], { timeZone, ...options });
const DATE_LABEL_OPTIONS = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
};

// --- fixtures ---------------------------------------------------------------

function slot(
  index,
  localStart,
  localEnd,
  startDayOffset = 0,
  endDayOffset = 0,
) {
  return { index, localStart, localEnd, startDayOffset, endDayOffset };
}

/** Four half-hour slots 09:00–11:00 starting at `firstIndex`. */
function morningSlots(firstIndex) {
  return [
    slot(firstIndex, "09:00", "09:30"),
    slot(firstIndex + 1, "09:30", "10:00"),
    slot(firstIndex + 2, "10:00", "10:30"),
    slot(firstIndex + 3, "10:30", "11:00"),
  ];
}

// API shape for a weekly event: Mon and Wed mornings plus a Saturday window
// that crosses midnight (the last two slots start on the following day).
const weeklyEvent = {
  timezone: "UTC",
  slotMinutes: 30,
  meetingDurationMinutes: 60,
  slotGroups: [
    { key: "weekday:1", label: "Mon", weekday: 1, slots: morningSlots(0) },
    { key: "weekday:3", label: "Wed", weekday: 3, slots: morningSlots(4) },
    {
      key: "weekday:6",
      label: "Sat",
      weekday: 6,
      slots: [
        slot(8, "23:00", "23:30"),
        slot(9, "23:30", "00:00", 0, 1),
        slot(10, "00:00", "00:30", 1, 1),
        slot(11, "00:30", "01:00", 1, 1),
      ],
    },
  ],
};

/** `weeklyEvent` with the API's per-slot `blocked` flag set on the given rows. */
function blockedWeeklyEvent(blockedRows) {
  return {
    ...weeklyEvent,
    slotGroups: weeklyEvent.slotGroups.map((group) => ({
      ...group,
      slots: group.slots.map((candidate, row) => ({
        ...candidate,
        blocked: (blockedRows[group.key] || []).includes(row),
      })),
    })),
  };
}

/** API shape for one specific date in UTC: four half-hour slots 09:00–11:00. */
function apiDateGroup(date, firstIndex) {
  const times = ["09:00", "09:30", "10:00", "10:30", "11:00"];
  return {
    key: `date:${date}`,
    label: date,
    date,
    slots: times.slice(0, 4).map((localStart, position) => ({
      index: firstIndex + position,
      localStart,
      localEnd: times[position + 1],
      startDayOffset: 0,
      endDayOffset: 0,
      startsAt: `${date}T${localStart}:00+00:00`,
      endsAt: `${date}T${times[position + 1]}:00+00:00`,
      startOffset: "+00:00",
      endOffset: "+00:00",
      fold: 0,
    })),
  };
}

const dateEvent = {
  timezone: "UTC",
  slotMinutes: 30,
  meetingDurationMinutes: 60,
  slotGroups: [apiDateGroup("2026-08-20", 0)],
};

// Nine consecutive dates 2026-08-20 … 2026-08-28 (two pages of columns).
const NINE_DATES = Array.from({ length: 9 }, (_, offset) =>
  addDays("2026-08-20", offset),
);
const nineDateEvent = {
  ...dateEvent,
  slotGroups: NINE_DATES.map((date, position) =>
    apiDateGroup(date, position * 4),
  ),
};

// The fixture shape organizer-scale.test.js still uses: bare date key and
// slots that only carry instants.
const legacyEvent = {
  timezone: "UTC",
  slotMinutes: 30,
  meetingDurationMinutes: 60,
  slotGroups: [
    {
      key: "2026-08-20",
      slots: [
        {
          index: 0,
          startsAt: "2026-08-20T09:00:00Z",
          endsAt: "2026-08-20T09:30:00Z",
        },
        {
          index: 1,
          startsAt: "2026-08-20T09:30:00Z",
          endsAt: "2026-08-20T10:00:00Z",
        },
      ],
    },
  ],
};

const apiDateRecommendation = {
  rank: 1,
  channel: "inperson",
  slotIndex: 0,
  endSlotIndex: 1,
  slotIndices: [0, 1],
  durationMinutes: 60,
  groupKey: "date:2026-08-20",
  groupLabel: "2026-08-20",
  weekday: null,
  date: "2026-08-20",
  localStart: "09:00",
  localEnd: "10:00",
  startDayOffset: 0,
  endDayOffset: 0,
  suggestedStartsAt: "2026-08-20T09:00:00Z",
  suggestedEndsAt: "2026-08-20T10:00:00Z",
  label: "2026-08-20 09:00–10:00",
  weightedAvailability: 0.9,
  unweightedAvailability: 0.8,
  fullyAvailableParticipantTotal: 700,
  partiallyAvailableParticipantTotal: 4,
  unavailableParticipantTotal: 2,
};

const staleWeeklyRecommendation = {
  rank: 2,
  channel: "inperson",
  slotIndices: [0, 1],
  groupKey: "weekday:1",
  weekday: 1,
  date: null,
  localStart: "09:00",
  localEnd: "10:00",
  startDayOffset: 0,
  endDayOffset: 0,
  suggestedStartsAt: "2026-09-07T09:00:00Z",
  suggestedEndsAt: "2026-09-07T10:00:00Z",
  label: "Mon 09:00–10:00",
  weightedAvailability: 0.75,
  unweightedAvailability: 0.7,
  fullyAvailableParticipantTotal: 12,
  partiallyAvailableParticipantTotal: 3,
  unavailableParticipantTotal: 1,
};

const perSlotResults = {
  countedResponseTotal: 12,
  channels: {
    inperson: {
      weighted: [0.9, 0.8, 0.7, "0.5"],
      unweighted: [0.5, 0.6, 0.4],
    },
  },
};

function weeklyColumns(weekStart, resolver = utcResolver, event = weeklyEvent) {
  return buildColumns({
    groups: normalizeSlotGroups(event),
    view: { weekStart },
    resolver,
  });
}

function dateColumns(event, page = 0) {
  return buildColumns({ groups: normalizeSlotGroups(event), view: { page } });
}

/**
 * A Los Angeles Sunday with hourly slots between consecutive `boundaries`
 * (n + 1 times give n slots), used for the daylight-saving weeks.
 */
function laSundayEvent(boundaries) {
  return {
    timezone: LA,
    slotMinutes: 60,
    meetingDurationMinutes: 120,
    slotGroups: [
      {
        key: "weekday:0",
        label: "Sun",
        weekday: 0,
        slots: boundaries
          .slice(0, -1)
          .map((localStart, position) =>
            slot(position, localStart, boundaries[position + 1]),
          ),
      },
    ],
  };
}

// --- normalizeSlotGroups ----------------------------------------------------

describe("normalizeSlotGroups", () => {
  test("keeps API weekly groups with their local slot times and day offsets", () => {
    const groups = normalizeSlotGroups(weeklyEvent);

    expect(groups.map((group) => group.key)).toEqual([
      "weekday:1",
      "weekday:3",
      "weekday:6",
    ]);
    expect(groups[0]).toMatchObject({
      key: "weekday:1",
      kind: "weekday",
      label: "Mon",
      weekday: 1,
      date: null,
    });
    expect(groups[0].slots[0]).toEqual({
      index: 0,
      localStart: "09:00",
      localEnd: "09:30",
      startDayOffset: 0,
      endDayOffset: 0,
      startsAt: null,
      endsAt: null,
      startOffset: null,
      endOffset: null,
      blocked: false,
    });
    expect(groups[2].slots[1]).toMatchObject({
      index: 9,
      localStart: "23:30",
      localEnd: "00:00",
      startDayOffset: 0,
      endDayOffset: 1,
    });
    expect(groups[2].slots[2]).toMatchObject({
      index: 10,
      startDayOffset: 1,
      endDayOffset: 1,
    });
    expect(groupKind(groups)).toBe("weekday");

    // Weekday and label can be derived from the key alone.
    const [derived] = normalizeSlotGroups({
      slotGroups: [{ key: "weekday:2", slots: morningSlots(0) }],
    });
    expect(derived).toMatchObject({
      kind: "weekday",
      weekday: 2,
      label: "Tue",
    });
  });

  test("keeps API date groups with their instants verbatim", () => {
    const [group] = normalizeSlotGroups(dateEvent);

    expect(group).toMatchObject({
      key: "date:2026-08-20",
      kind: "date",
      label: "2026-08-20",
      weekday: null,
      date: "2026-08-20",
    });
    expect(group.slots).toHaveLength(4);
    expect(group.slots[1]).toEqual({
      index: 1,
      localStart: "09:30",
      localEnd: "10:00",
      startDayOffset: 0,
      endDayOffset: 0,
      startsAt: "2026-08-20T09:30:00+00:00",
      endsAt: "2026-08-20T10:00:00+00:00",
      startOffset: "+00:00",
      endOffset: "+00:00",
      blocked: false,
    });
    expect(groupKind(normalizeSlotGroups(dateEvent))).toBe("date");

    // The date can also come from a "date:" key when the field is missing.
    const [keyed] = normalizeSlotGroups({
      slotGroups: [{ key: "date:2026-08-21", slots: morningSlots(0) }],
    });
    expect(keyed).toMatchObject({
      kind: "date",
      date: "2026-08-21",
      label: "2026-08-21",
    });
  });

  test("derives local times and the date for the legacy instant-only fixture", () => {
    const [group] = normalizeSlotGroups(legacyEvent);

    expect(group).toMatchObject({
      key: "2026-08-20",
      kind: "date",
      date: "2026-08-20",
      label: "2026-08-20",
    });
    expect(group.slots[0]).toEqual({
      index: 0,
      localStart: "09:00",
      localEnd: "09:30",
      startDayOffset: 0,
      endDayOffset: 0,
      startsAt: "2026-08-20T09:00:00Z",
      endsAt: "2026-08-20T09:30:00Z",
      startOffset: null,
      endOffset: null,
      blocked: false,
    });
    expect(group.slots[1]).toMatchObject({
      localStart: "09:30",
      localEnd: "10:00",
    });

    // Local times follow the event timezone, including a midnight crossing.
    const [pacific] = normalizeSlotGroups({
      timezone: LA,
      slotGroups: [
        {
          key: "2026-08-20",
          slots: [
            {
              index: 0,
              startsAt: "2026-08-21T06:30:00Z",
              endsAt: "2026-08-21T07:00:00Z",
            },
          ],
        },
      ],
    });
    expect(pacific.date).toBe("2026-08-20");
    expect(pacific.slots[0]).toMatchObject({
      localStart: "23:30",
      localEnd: "00:00",
      startDayOffset: 0,
      endDayOffset: 1,
    });
  });

  test("carries the organizer's blocked flag on every slot", () => {
    const [monday, wednesday] = normalizeSlotGroups(
      blockedWeeklyEvent({ "weekday:1": [1, 2] }),
    );

    expect(monday.slots.map((candidate) => candidate.blocked)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(wednesday.slots.every((candidate) => !candidate.blocked)).toBe(true);

    // Truthy API values are coerced, and the flag survives the legacy
    // instant-only fixture too.
    const [coerced] = normalizeSlotGroups({
      slotGroups: [
        {
          key: "weekday:1",
          slots: [
            { ...slot(0, "09:00", "09:30"), blocked: 1 },
            { ...slot(1, "09:30", "10:00"), blocked: null },
          ],
        },
      ],
    });
    expect(coerced.slots.map((candidate) => candidate.blocked)).toEqual([
      true,
      false,
    ]);
    const [legacy] = normalizeSlotGroups({
      ...legacyEvent,
      slotGroups: [
        {
          ...legacyEvent.slotGroups[0],
          slots: legacyEvent.slotGroups[0].slots.map((candidate, position) => ({
            ...candidate,
            blocked: position === 1,
          })),
        },
      ],
    });
    expect(legacy.slots.map((candidate) => candidate.blocked)).toEqual([
      false,
      true,
    ]);
  });

  test("returns nothing for missing groups and drops unusable ones", () => {
    expect(normalizeSlotGroups(undefined)).toEqual([]);
    expect(normalizeSlotGroups({})).toEqual([]);
    expect(normalizeSlotGroups({ slotGroups: "weekday:1" })).toEqual([]);

    const groups = normalizeSlotGroups({
      slotGroups: [
        null,
        "weekday:1",
        { key: "weekday:1" },
        { key: "weekday:1", slots: [] },
        { key: "weekday:1", slots: [{ index: "0" }, { index: 0 }] },
        { key: "weekday:7", slots: morningSlots(0) },
        { key: "weekday:x", weekday: -1, slots: morningSlots(0) },
        { key: "misc", slots: morningSlots(0) },
        {
          key: "2026-08-20",
          slots: [{ index: 0, startsAt: "not-a-date", endsAt: "nope" }],
        },
        { key: "weekday:4", slots: morningSlots(0) },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "weekday:4", weekday: 4 });
    expect(groupKind([])).toBe("date");
  });
});

// --- windowSlotCount / slotByIndex ------------------------------------------

describe("windowSlotCount", () => {
  test("divides the meeting duration into whole slots or reports 0", () => {
    expect(
      windowSlotCount({ meetingDurationMinutes: 60, slotMinutes: 30 }),
    ).toBe(2);
    expect(
      windowSlotCount({ meetingDurationMinutes: 45, slotMinutes: 30 }),
    ).toBe(0);
    expect(
      windowSlotCount({ meetingDurationMinutes: 90, slotMinutes: 15 }),
    ).toBe(6);
    expect(
      windowSlotCount({ meetingDurationMinutes: 30, slotMinutes: 30 }),
    ).toBe(1);
    expect(windowSlotCount({ meetingDurationMinutes: 60 })).toBe(0);
    expect(
      windowSlotCount({ meetingDurationMinutes: 60, slotMinutes: 0 }),
    ).toBe(0);
    expect(windowSlotCount({})).toBe(0);
    expect(windowSlotCount(undefined)).toBe(0);
  });

  test("slotByIndex finds the owning group", () => {
    const groups = normalizeSlotGroups(weeklyEvent);
    const found = slotByIndex(groups, 10);
    expect(found.group.key).toBe("weekday:6");
    expect(found.slot).toMatchObject({ index: 10, startDayOffset: 1 });
    expect(slotByIndex(groups, 99)).toBeNull();
  });
});

// --- date helpers -----------------------------------------------------------

describe("date helpers", () => {
  test("use Sunday-first weekdays and stay on calendar dates across boundaries", () => {
    expect(weekdayOf("2026-09-13")).toBe(0);
    expect(weekdayOf("2026-09-14")).toBe(1);
    expect(weekdayOf("2026-09-19")).toBe(6);

    expect(weekStartOf("2026-09-13")).toBe("2026-09-13");
    expect(weekStartOf("2026-09-16")).toBe("2026-09-13");
    expect(weekStartOf("2026-09-19")).toBe("2026-09-13");
    expect(weekStartOf("2026-01-01")).toBe("2025-12-28");

    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-09-13", 0)).toBe("2026-09-13");

    expect(daysBetween("2026-08-20", "2026-08-21")).toBe(1);
    expect(daysBetween("2026-08-21", "2026-08-20")).toBe(-1);

    expect(localDateOf("2026-08-21T06:30:00Z", LA)).toBe("2026-08-20");
    expect(localDateOf("2026-08-21T06:30:00Z", "UTC")).toBe("2026-08-21");
  });

  test("formats dates and week ranges for same-month, cross-month and cross-year weeks", () => {
    expect(formatDate("2026-09-14", { month: "short", day: "numeric" })).toBe(
      localeDate("2026-09-14", { month: "short", day: "numeric" }),
    );
    expect(formatDate("2026-09-14", { weekday: "short" })).toBe("Mon");

    const sameMonth = formatWeekLabel("2026-09-13");
    expect(sameMonth).toBe(
      `${localeDate("2026-09-13", { month: "short", day: "numeric" })} – ${localeDate(
        "2026-09-19",
        { day: "numeric" },
      )}, 2026`,
    );
    expect(sameMonth).toMatch(/^Sep 13 – 19, 2026$/);

    const crossMonth = formatWeekLabel("2026-09-27");
    expect(crossMonth).toBe(
      `${localeDate("2026-09-27", { month: "short", day: "numeric" })} – ${localeDate(
        "2026-10-03",
        { month: "short", day: "numeric", year: "numeric" },
      )}`,
    );
    expect(crossMonth).toMatch(/^Sep 27 – Oct 3, 2026$/);

    const crossYear = formatWeekLabel("2026-12-27");
    const full = { month: "short", day: "numeric", year: "numeric" };
    expect(crossYear).toBe(
      `${localeDate("2026-12-27", full)} – ${localeDate("2027-01-02", full)}`,
    );
    expect(crossYear).toMatch(/^Dec 27, 2026 – Jan 2, 2027$/);
  });
});

// --- buildColumns -----------------------------------------------------------

describe("buildColumns", () => {
  test("dates weekly groups on the requested week and resolves boundaries in UTC", () => {
    const columns = weeklyColumns("2026-09-13");

    expect(columns.map((column) => column.date)).toEqual([
      "2026-09-14",
      "2026-09-16",
      "2026-09-19",
    ]);
    expect(columns.map((column) => column.headerLabel)).toEqual([
      "Mon",
      "Wed",
      "Sat",
    ]);
    expect(columns[0]).toMatchObject({
      key: "weekday:1:2026-09-14",
      groupKey: "weekday:1",
      groupLabel: "Mon",
      kind: "weekday",
      weekday: 1,
      subLabel: localeDate("2026-09-14", { month: "short", day: "numeric" }),
    });
    expect(columns[0].slots).toHaveLength(4);
    expect(columns[0].boundaries[0]).toEqual({
      startsAt: "2026-09-14T09:00:00.000Z",
      endsAt: "2026-09-14T09:30:00.000Z",
      error: null,
    });
    expect(columns[0].boundaries[3]).toEqual({
      startsAt: "2026-09-14T10:30:00.000Z",
      endsAt: "2026-09-14T11:00:00.000Z",
      error: null,
    });

    // The next week shifts every date by seven days.
    expect(weeklyColumns("2026-09-20").map((column) => column.date)).toEqual([
      "2026-09-21",
      "2026-09-23",
      "2026-09-26",
    ]);
    expect(
      buildColumns({
        groups: normalizeSlotGroups(weeklyEvent),
        view: null,
        resolver: utcResolver,
      }),
    ).toEqual([]);
  });

  test("resolves weekly boundaries through the event timezone and keeps overnight slots in their column", () => {
    const [monday, , saturday] = weeklyColumns("2026-09-13", laResolver, {
      ...weeklyEvent,
      timezone: LA,
    });
    expect(monday.boundaries[0]).toEqual({
      startsAt: "2026-09-14T16:00:00.000Z",
      endsAt: "2026-09-14T16:30:00.000Z",
      error: null,
    });

    // Slots with startDayOffset 1 resolve on the following date but the
    // column itself stays on Saturday.
    expect(saturday.date).toBe("2026-09-19");
    expect(saturday.boundaries[1]).toEqual({
      startsAt: "2026-09-20T06:30:00.000Z",
      endsAt: "2026-09-20T07:00:00.000Z",
      error: null,
    });
    expect(saturday.boundaries[2].startsAt).toBe("2026-09-20T07:00:00.000Z");

    const [utcSaturday] = weeklyColumns("2026-09-13").slice(2);
    expect(utcSaturday.boundaries[2]).toEqual({
      startsAt: "2026-09-20T00:00:00.000Z",
      endsAt: "2026-09-20T00:30:00.000Z",
      error: null,
    });
  });

  test("captures daylight-saving errors per boundary instead of throwing", () => {
    const event = laSundayEvent(["01:00", "02:00", "03:00", "04:00"]);
    const [springForward] = weeklyColumns("2026-03-08", laResolver, event);

    expect(springForward.date).toBe("2026-03-08");
    // 01:00–02:00: the 02:00 end does not exist on the spring-forward day.
    expect(springForward.boundaries[0]).toEqual({
      startsAt: "2026-03-08T09:00:00.000Z",
      endsAt: null,
      error: expect.stringMatching(/does not exist/),
    });
    // 02:00–03:00: the 02:00 start is the missing hour.
    expect(springForward.boundaries[1]).toEqual({
      startsAt: null,
      endsAt: "2026-03-08T10:00:00.000Z",
      error: expect.stringMatching(/does not exist/),
    });
    // 03:00–04:00 is already on daylight time and resolves fully.
    expect(springForward.boundaries[2]).toEqual({
      startsAt: "2026-03-08T10:00:00.000Z",
      endsAt: "2026-03-08T11:00:00.000Z",
      error: null,
    });

    // The same group one week later has no gap.
    const [ordinary] = weeklyColumns("2026-03-15", laResolver, event);
    expect(ordinary.boundaries.map((boundary) => boundary.error)).toEqual([
      null,
      null,
      null,
    ]);
    expect(ordinary.boundaries[0].startsAt).toBe("2026-03-15T08:00:00.000Z");

    // Fall back: 01:30 happens twice on 2026-11-01.
    const [fallBack] = weeklyColumns("2026-11-01", laResolver, {
      ...event,
      slotMinutes: 30,
      meetingDurationMinutes: 60,
      slotGroups: [
        {
          key: "weekday:0",
          label: "Sun",
          weekday: 0,
          slots: [
            slot(0, "01:00", "01:30"),
            slot(1, "01:30", "02:00"),
            slot(2, "02:00", "02:30"),
          ],
        },
      ],
    });
    expect(fallBack.boundaries[1]).toEqual({
      startsAt: null,
      endsAt: "2026-11-01T10:00:00.000Z",
      error: expect.stringMatching(/ambiguous/),
    });
    expect(fallBack.boundaries[2]).toEqual({
      startsAt: "2026-11-01T10:00:00.000Z",
      endsAt: "2026-11-01T10:30:00.000Z",
      error: null,
    });
  });

  test("pages specific dates seven at a time with verbatim instants", () => {
    const groups = normalizeSlotGroups(nineDateEvent);
    expect(pageCount(groups)).toBe(2);
    expect(pageCount(normalizeSlotGroups(weeklyEvent))).toBe(1);
    expect(pageCount([])).toBe(1);

    const firstPage = buildColumns({ groups, view: { page: 0 } });
    expect(firstPage).toHaveLength(COLUMNS_PER_PAGE);
    expect(firstPage.map((column) => column.date)).toEqual(
      NINE_DATES.slice(0, 7),
    );
    expect(firstPage[0]).toMatchObject({
      key: "date:2026-08-20",
      groupKey: "date:2026-08-20",
      groupLabel: "2026-08-20",
      kind: "date",
      weekday: 4,
      headerLabel: localeDate("2026-08-20", { weekday: "short" }),
      subLabel: localeDate("2026-08-20", { month: "short", day: "numeric" }),
    });
    expect(firstPage[0].headerLabel).toBe("Thu");
    expect(firstPage[0].boundaries[1]).toEqual({
      startsAt: "2026-08-20T09:30:00+00:00",
      endsAt: "2026-08-20T10:00:00+00:00",
      error: null,
    });

    const secondPage = buildColumns({ groups, view: { page: 1 } });
    expect(secondPage.map((column) => column.date)).toEqual([
      "2026-08-27",
      "2026-08-28",
    ]);
    expect(secondPage[1].slots.map((entry) => entry.index)).toEqual([
      32, 33, 34, 35,
    ]);
    expect(buildColumns({ groups, view: { page: 2 } })).toEqual([]);
    expect(buildColumns({ groups, view: undefined })).toHaveLength(7);

    // A date slot without instants cannot be picked.
    const [unresolved] = buildColumns({
      groups: normalizeSlotGroups({
        slotGroups: [{ key: "date:2026-08-20", slots: morningSlots(0) }],
      }),
      view: { page: 0 },
    });
    expect(unresolved.boundaries[0]).toEqual({
      startsAt: null,
      endsAt: null,
      error: "This slot has no resolved start or end time.",
    });
  });

  test("labels the visible range for weeks and date pages", () => {
    const weekly = normalizeSlotGroups(weeklyEvent);
    expect(
      formatRangeLabel({
        kind: "weekday",
        view: { weekStart: "2026-09-13" },
        groups: weekly,
        columns: [],
      }),
    ).toBe(formatWeekLabel("2026-09-13"));
    expect(
      formatRangeLabel({
        kind: "weekday",
        view: null,
        groups: weekly,
        columns: [],
      }),
    ).toBe("");

    const dates = normalizeSlotGroups(nineDateEvent);
    const firstPage = buildColumns({ groups: dates, view: { page: 0 } });
    expect(
      formatRangeLabel({
        kind: "date",
        view: { page: 0 },
        groups: dates,
        columns: firstPage,
      }),
    ).toBe(
      `Dates 1–7 of 9 · ${localeDate("2026-08-20", { month: "short", day: "numeric" })} – ${localeDate(
        "2026-08-26",
        { month: "short", day: "numeric", year: "numeric" },
      )}`,
    );
    expect(
      formatRangeLabel({
        kind: "date",
        view: { page: 1 },
        groups: dates,
        columns: buildColumns({ groups: dates, view: { page: 1 } }),
      }),
    ).toMatch(/^Dates 8–9 of 9 · /);
    expect(
      formatRangeLabel({
        kind: "date",
        view: { page: 0 },
        groups: [],
        columns: [],
      }),
    ).toBe("");
  });
});

// --- windowAt / cellState ---------------------------------------------------

describe("windowAt and cellState", () => {
  const [monday, , saturday] = weeklyColumns("2026-09-13");
  const k = windowSlotCount(weeklyEvent);
  const before = Date.parse("2026-09-14T08:59:59Z");

  test("returns the slot indices and instants of a startable window", () => {
    expect(k).toBe(2);
    expect(windowAt(monday, 0, k)).toEqual({
      slotIndices: [0, 1],
      startsAt: "2026-09-14T09:00:00.000Z",
      endsAt: "2026-09-14T10:00:00.000Z",
      error: null,
    });
    expect(windowAt(monday, 2, k)).toEqual({
      slotIndices: [2, 3],
      startsAt: "2026-09-14T10:00:00.000Z",
      endsAt: "2026-09-14T11:00:00.000Z",
      error: null,
    });
    // An overnight window ends on the next calendar day.
    expect(windowAt(saturday, 1, k)).toEqual({
      slotIndices: [9, 10],
      startsAt: "2026-09-19T23:30:00.000Z",
      endsAt: "2026-09-20T00:30:00.000Z",
      error: null,
    });
    expect(cellState({ column: monday, row: 0, k, now: before })).toBe(
      "startable",
    );
    expect(cellState({ column: monday, row: 2, k, now: null })).toBe(
      "startable",
    );
  });

  test("marks the tail rows, past starts and invalid durations", () => {
    expect(windowAt(monday, 3, k)).toEqual({
      slotIndices: null,
      startsAt: null,
      endsAt: null,
      error: "tail",
    });
    expect(windowAt(monday, -1, k).error).toBe("tail");
    expect(cellState({ column: monday, row: 3, k, now: before })).toBe("tail");

    expect(
      cellState({
        column: monday,
        row: 0,
        k,
        now: Date.parse("2026-09-14T09:00:01Z"),
      }),
    ).toBe("past");
    // A window starting exactly now is still pickable.
    expect(
      cellState({
        column: monday,
        row: 0,
        k,
        now: Date.parse("2026-09-14T09:00:00Z"),
      }),
    ).toBe("startable");
    expect(
      cellState({
        column: monday,
        row: 1,
        k,
        now: Date.parse("2026-09-14T09:15:00Z"),
      }),
    ).toBe("startable");

    expect(windowAt(monday, 0, 0).error).toBe("invalid-duration");
    expect(cellState({ column: monday, row: 0, k: 0, now: before })).toBe(
      "invalid-duration",
    );
    expect(cellState({ column: monday, row: 3, k: NaN, now: before })).toBe(
      "invalid-duration",
    );
    expect(windowAt({ slots: monday.slots, boundaries: [] }, 0, k).error).toBe(
      "This slot cannot be resolved.",
    );
  });

  test("propagates a daylight-saving gap to every window that touches it", () => {
    const event = laSundayEvent([
      "00:00",
      "01:00",
      "02:00",
      "03:00",
      "04:00",
      "05:00",
    ]);
    const [gapColumn] = weeklyColumns("2026-03-08", laResolver, event);
    const two = windowSlotCount(event);
    expect(two).toBe(2);
    const now = Date.parse("2026-03-01T00:00:00Z");

    // Row 0 starts fine at 00:00 but its window would end at the missing 02:00.
    expect(
      [0, 1, 2, 3, 4].map((row) =>
        cellState({ column: gapColumn, row, k: two, now }),
      ),
    ).toEqual(["dst", "dst", "dst", "startable", "tail"]);
    expect(windowAt(gapColumn, 0, two).error).toMatch(/does not exist/);
    expect(windowAt(gapColumn, 3, two)).toEqual({
      slotIndices: [3, 4],
      startsAt: "2026-03-08T10:00:00.000Z",
      endsAt: "2026-03-08T12:00:00.000Z",
      error: null,
    });

    const [ordinary] = weeklyColumns("2026-03-15", laResolver, event);
    expect(
      [0, 1, 2, 3].map((row) =>
        cellState({ column: ordinary, row, k: two, now }),
      ),
    ).toEqual(["startable", "startable", "startable", "startable"]);
  });

  test("refuses every window that touches an organizer-blocked slot", () => {
    // Monday 10:00–10:30 (row 2) is blocked: the 09:30 window starts open but
    // runs into the block, and the 10:00 window starts on it.
    const [blockedMonday] = weeklyColumns(
      "2026-09-13",
      utcResolver,
      blockedWeeklyEvent({ "weekday:1": [2] }),
    );
    expect(blockedMonday.slots.map((candidate) => candidate.blocked)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(windowAt(blockedMonday, 0, k)).toEqual({
      slotIndices: [0, 1],
      startsAt: "2026-09-14T09:00:00.000Z",
      endsAt: "2026-09-14T10:00:00.000Z",
      error: null,
    });
    expect(windowAt(blockedMonday, 1, k)).toEqual({
      slotIndices: null,
      startsAt: null,
      endsAt: null,
      error: "blocked",
    });
    expect(windowAt(blockedMonday, 2, k).error).toBe("blocked");
    expect(windowAt(blockedMonday, 3, k).error).toBe("tail");
    expect(
      [0, 1, 2, 3].map((row) =>
        cellState({ column: blockedMonday, row, k, now: before }),
      ),
    ).toEqual(["startable", "blocked", "blocked", "tail"]);

    // A block on the last row wins over "tail", and a block anywhere in the
    // window wins over "past".
    const [tailBlocked] = weeklyColumns(
      "2026-09-13",
      utcResolver,
      blockedWeeklyEvent({ "weekday:1": [3] }),
    );
    expect(windowAt(tailBlocked, 3, k).error).toBe("blocked");
    expect(windowAt(tailBlocked, 2, k).error).toBe("blocked");
    expect(
      [0, 1, 2, 3].map((row) =>
        cellState({
          column: tailBlocked,
          row,
          k,
          now: Date.parse("2026-09-14T12:00:00Z"),
        }),
      ),
    ).toEqual(["past", "past", "blocked", "blocked"]);
    expect(windowAt(tailBlocked, -1, k).error).toBe("tail");

    // ...and over a daylight-saving gap inside the same window (Los Angeles
    // has no 02:00 on 2026-03-08; the 01:00 slot is blocked).
    const gapEvent = laSundayEvent([
      "00:00",
      "01:00",
      "02:00",
      "03:00",
      "04:00",
    ]);
    gapEvent.slotGroups[0].slots[1].blocked = true;
    const [gapColumn] = weeklyColumns("2026-03-08", laResolver, gapEvent);
    expect(
      [0, 1, 2, 3].map((row) =>
        cellState({
          column: gapColumn,
          row,
          k: 2,
          now: Date.parse("2026-03-01T00:00:00Z"),
        }),
      ),
    ).toEqual(["blocked", "blocked", "dst", "tail"]);

    // An unusable duration is still reported first.
    expect(windowAt(blockedMonday, 2, 0).error).toBe("invalid-duration");
    expect(
      cellState({ column: blockedMonday, row: 2, k: 0, now: before }),
    ).toBe("invalid-duration");
  });
});

// --- metrics ----------------------------------------------------------------

describe("cellMetrics and windowMetrics", () => {
  test("reads per-slot shares and takes the window minimum", () => {
    expect(cellMetrics(perSlotResults, "inperson", 1)).toEqual({
      weighted: 0.8,
      unweighted: 0.6,
    });
    expect(cellMetrics(perSlotResults, "inperson", 3)).toEqual({
      weighted: 0.5,
      unweighted: null,
    });
    expect(windowMetrics(perSlotResults, "inperson", [0, 1, 2])).toEqual({
      weighted: 0.7,
      unweighted: 0.4,
    });
    expect(windowMetrics(perSlotResults, "inperson", [2, 3])).toEqual({
      weighted: 0.5,
      unweighted: 0.4,
    });
  });

  test("returns nulls when results, the channel or the slot are missing", () => {
    expect(cellMetrics(null, "inperson", 0)).toEqual({
      weighted: null,
      unweighted: null,
    });
    expect(cellMetrics(perSlotResults, "virtual", 0)).toEqual({
      weighted: null,
      unweighted: null,
    });
    expect(cellMetrics(perSlotResults, "inperson", 9)).toEqual({
      weighted: null,
      unweighted: null,
    });
    expect(
      cellMetrics(
        { channels: { inperson: { weighted: ["n/a"] } } },
        "inperson",
        0,
      ),
    ).toEqual({ weighted: null, unweighted: null });
    expect(windowMetrics(undefined, "inperson", [0, 1])).toEqual({
      weighted: null,
      unweighted: null,
    });
    expect(windowMetrics(perSlotResults, "inperson", [])).toEqual({
      weighted: null,
      unweighted: null,
    });
    expect(windowMetrics(perSlotResults, "inperson", null)).toEqual({
      weighted: null,
      unweighted: null,
    });
  });
});

// --- labels -----------------------------------------------------------------

describe("formatWindowLabel and formatDateLabel", () => {
  test("produces API-style window labels with +1d suffixes", () => {
    const [monday, , saturday] = weeklyColumns("2026-09-13");
    expect(formatWindowLabel(monday, monday.slots.slice(0, 2))).toBe(
      "Mon 09:00–10:00",
    );
    expect(formatWindowLabel(monday, monday.slots.slice(3, 4))).toBe(
      "Mon 10:30–11:00",
    );
    expect(formatWindowLabel(saturday, saturday.slots.slice(1, 3))).toBe(
      "Sat 23:30–00:30 +1d",
    );
    expect(formatWindowLabel(saturday, saturday.slots.slice(2, 4))).toBe(
      "Sat 00:00 +1d–01:00 +1d",
    );
    expect(formatWindowLabel(saturday, [])).toBe("Sat");
    expect(formatWindowLabel(saturday, undefined)).toBe("Sat");

    const [thursday] = dateColumns(dateEvent);
    expect(formatWindowLabel(thursday, thursday.slots.slice(1, 3))).toBe(
      "2026-08-20 09:30–10:30",
    );
  });

  test("formats the date of an instant in the event timezone", () => {
    expect(formatDateLabel("2026-08-20T09:00:00Z", "UTC")).toBe(
      localeDateTime("2026-08-20T09:00:00Z", "UTC", DATE_LABEL_OPTIONS),
    );
    expect(formatDateLabel("2026-08-20T09:00:00Z", "UTC")).toMatch(
      /^Thu, Aug 20, 2026$/,
    );
    // 06:30Z on the 21st is still the evening of the 20th in Los Angeles.
    expect(formatDateLabel("2026-08-21T06:30:00Z", LA)).toMatch(
      /^Thu, Aug 20, 2026$/,
    );
    expect(formatDateLabel("garbage", "UTC")).toBe("Not set");
  });
});

// --- selectionFromRecommendation --------------------------------------------

describe("selectionFromRecommendation", () => {
  test("keeps an API recommendation's instants verbatim with exact metrics", () => {
    const selection = selectionFromRecommendation(
      apiDateRecommendation,
      dateEvent,
      { now: Date.parse("2026-08-01T00:00:00Z") },
    );

    expect(selection).toEqual({
      channel: "inperson",
      startsAt: "2026-08-20T09:00:00Z",
      endsAt: "2026-08-20T10:00:00Z",
      slotIndices: [0, 1],
      groupKey: "date:2026-08-20",
      label: "2026-08-20 09:00–10:00",
      dateLabel: localeDateTime(
        "2026-08-20T09:00:00Z",
        "UTC",
        DATE_LABEL_OPTIONS,
      ),
      source: "recommendation",
      recommendation: apiDateRecommendation,
      rescheduled: false,
      metrics: {
        exact: true,
        weighted: 0.9,
        unweighted: 0.8,
        rank: 1,
        fullyAvailableParticipantTotal: 700,
        partiallyAvailableParticipantTotal: 4,
        unavailableParticipantTotal: 2,
      },
    });
    expect(selection.slotIndices).not.toBe(apiDateRecommendation.slotIndices);
    expect(selectionFromRecommendation(null, dateEvent)).toBeNull();
  });

  test("accepts legacy recommendations that only carry instants", () => {
    const legacy = {
      channel: "virtual",
      startsAt: "2026-08-20T09:00:00Z",
      endsAt: "2026-08-20T10:00:00Z",
      label: "Thursday 9:00 AM",
      weightedScore: 0.65,
    };
    const selection = selectionFromRecommendation(legacy, legacyEvent, {
      now: Date.parse("2026-09-14T12:00:00Z"),
    });

    expect(selection).toMatchObject({
      channel: "virtual",
      startsAt: "2026-08-20T09:00:00Z",
      endsAt: "2026-08-20T10:00:00Z",
      slotIndices: null,
      groupKey: null,
      label: "Thursday 9:00 AM",
      source: "recommendation",
      recommendation: legacy,
      rescheduled: false,
      metrics: {
        exact: true,
        weighted: 0.65,
        unweighted: null,
        rank: null,
        fullyAvailableParticipantTotal: null,
        partiallyAvailableParticipantTotal: null,
        unavailableParticipantTotal: null,
      },
    });

    // Without a label the start instant is described in the event timezone.
    const unlabeled = selectionFromRecommendation(
      { channel: "inperson", startsAt: "2026-08-21T06:30:00Z" },
      { timezone: LA },
    );
    expect(unlabeled.label).toBe(
      localeDateTime("2026-08-21T06:30:00Z", LA, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    expect(unlabeled.label).toMatch(/^Thu,? 11:30 PM$/);
  });

  test("re-anchors a stale weekly suggestion to the next occurrence when a resolver is given", () => {
    const now = Date.parse("2026-09-14T12:00:00Z"); // Monday, after 09:00
    const selection = selectionFromRecommendation(
      staleWeeklyRecommendation,
      weeklyEvent,
      { now, resolver: utcResolver },
    );

    expect(selection).toMatchObject({
      channel: "inperson",
      startsAt: "2026-09-21T09:00:00.000Z",
      endsAt: "2026-09-21T10:00:00.000Z",
      slotIndices: [0, 1],
      groupKey: "weekday:1",
      label: "Mon 09:00–10:00",
      dateLabel: localeDateTime(
        "2026-09-21T09:00:00Z",
        "UTC",
        DATE_LABEL_OPTIONS,
      ),
      rescheduled: true,
      recommendation: staleWeeklyRecommendation,
      metrics: { exact: true, weighted: 0.75, unweighted: 0.7, rank: 2 },
    });
    expect(staleWeeklyRecommendation.suggestedStartsAt).toBe(
      "2026-09-07T09:00:00Z",
    );

    // Earlier the same day the occurrence is today.
    expect(
      selectionFromRecommendation(staleWeeklyRecommendation, weeklyEvent, {
        now: Date.parse("2026-09-14T08:00:00Z"),
        resolver: utcResolver,
      }),
    ).toMatchObject({
      startsAt: "2026-09-14T09:00:00.000Z",
      rescheduled: true,
    });

    // A suggestion still in the future is left alone.
    expect(
      selectionFromRecommendation(staleWeeklyRecommendation, weeklyEvent, {
        now: Date.parse("2026-09-01T00:00:00Z"),
        resolver: utcResolver,
      }),
    ).toMatchObject({ startsAt: "2026-09-07T09:00:00Z", rescheduled: false });

    // Date recommendations never move, even when they are in the past.
    expect(
      selectionFromRecommendation(apiDateRecommendation, dateEvent, {
        now,
        resolver: utcResolver,
      }),
    ).toMatchObject({ startsAt: "2026-08-20T09:00:00Z", rescheduled: false });
  });

  test("skips daylight-saving days while re-anchoring, with or without an injected resolver", () => {
    const recommendation = {
      ...staleWeeklyRecommendation,
      groupKey: "weekday:0",
      weekday: 0,
      localStart: "02:30",
      localEnd: "03:30",
      suggestedStartsAt: "2026-03-01T10:30:00Z",
      suggestedEndsAt: "2026-03-01T11:30:00Z",
    };
    const laEvent = { ...weeklyEvent, timezone: LA };
    const now = Date.parse("2026-03-02T00:00:00Z");
    const expected = {
      startsAt: "2026-03-15T09:30:00.000Z",
      endsAt: "2026-03-15T10:30:00.000Z",
      rescheduled: true,
    };

    // 2026-03-08 02:30 does not exist in Los Angeles, so the next Sunday wins.
    expect(
      selectionFromRecommendation(recommendation, laEvent, {
        now,
        resolver: laResolver,
      }),
    ).toMatchObject(expected);
    // The resolver is built from the event timezone when a caller omits it:
    // a stale suggestion must never reach the API verbatim.
    expect(
      selectionFromRecommendation(recommendation, laEvent, { now }),
    ).toMatchObject(expected);
    expect(
      selectionFromRecommendation(staleWeeklyRecommendation, weeklyEvent, {
        now: Date.parse("2026-09-14T12:00:00Z"),
      }),
    ).toMatchObject({
      startsAt: "2026-09-21T09:00:00.000Z",
      endsAt: "2026-09-21T10:00:00.000Z",
      rescheduled: true,
    });

    // An unusable timezone cannot re-anchor; the instants stay verbatim.
    expect(
      selectionFromRecommendation(
        recommendation,
        { ...laEvent, timezone: "Moon/Base" },
        { now },
      ),
    ).toMatchObject({
      startsAt: "2026-03-01T10:30:00Z",
      endsAt: "2026-03-01T11:30:00Z",
      rescheduled: false,
    });
  });

  test("validates every boundary of the window while re-anchoring, like the API's weekly search", () => {
    // Sunday 00:00–05:00 in hourly slots; the ranked window 00:00–03:00 has
    // valid ends on 2026-03-08 (00:00 PST, 03:00 PDT) but its 02:00 boundary
    // is the missing hour, so the API skips that Sunday.
    const event = laSundayEvent([
      "00:00",
      "01:00",
      "02:00",
      "03:00",
      "04:00",
      "05:00",
    ]);
    const recommendation = {
      ...staleWeeklyRecommendation,
      groupKey: "weekday:0",
      weekday: 0,
      slotIndices: [0, 1, 2],
      localStart: "00:00",
      localEnd: "03:00",
      suggestedStartsAt: "2026-03-01T08:00:00Z",
      suggestedEndsAt: "2026-03-01T11:00:00Z",
    };
    const now = Date.parse("2026-03-02T00:00:00Z");
    expect(
      selectionFromRecommendation(recommendation, event, { now }),
    ).toMatchObject({
      startsAt: "2026-03-15T07:00:00.000Z",
      endsAt: "2026-03-15T10:00:00.000Z",
      rescheduled: true,
    });

    // Fall back: 01:00 happens twice on 2026-11-01, so the window that ends
    // at 03:00 moves to the following Sunday even though 00:00 and 03:00 are
    // both unambiguous.
    expect(
      selectionFromRecommendation(
        {
          ...recommendation,
          suggestedStartsAt: "2026-10-25T07:00:00Z",
          suggestedEndsAt: "2026-10-25T10:00:00Z",
        },
        event,
        { now: Date.parse("2026-10-26T00:00:00Z") },
      ),
    ).toMatchObject({
      startsAt: "2026-11-08T08:00:00.000Z",
      endsAt: "2026-11-08T11:00:00.000Z",
      rescheduled: true,
    });

    // Slots the event no longer has fall back to the recommendation's own
    // start and end.
    expect(
      selectionFromRecommendation(
        { ...recommendation, slotIndices: [40, 41, 42] },
        event,
        { now },
      ),
    ).toMatchObject({
      startsAt: "2026-03-08T08:00:00.000Z",
      endsAt: "2026-03-08T10:00:00.000Z",
      rescheduled: true,
    });
  });
});

// --- selectionFromWindow ----------------------------------------------------

describe("selectionFromWindow", () => {
  const [thursday] = dateColumns(dateEvent);
  const k = windowSlotCount(dateEvent);

  test("attaches the ranked recommendation that covers the clicked window", () => {
    const selection = selectionFromWindow({
      column: thursday,
      row: 0,
      k,
      channel: "inperson",
      results: perSlotResults,
      event: dateEvent,
      recommendations: [apiDateRecommendation],
    });

    expect(selection).toMatchObject({
      channel: "inperson",
      startsAt: "2026-08-20T09:00:00+00:00",
      endsAt: "2026-08-20T10:00:00+00:00",
      slotIndices: [0, 1],
      groupKey: "date:2026-08-20",
      label: "2026-08-20 09:00–10:00",
      source: "calendar",
      recommendation: apiDateRecommendation,
      rescheduled: false,
      metrics: {
        exact: true,
        weighted: 0.9,
        unweighted: 0.8,
        rank: 1,
        fullyAvailableParticipantTotal: 700,
      },
    });
    expect(
      selectionMatchesRecommendation(selection, apiDateRecommendation),
    ).toBe(true);
  });

  test("builds a custom window with the lowest per-slot shares", () => {
    const selection = selectionFromWindow({
      column: thursday,
      row: 1,
      k,
      channel: "inperson",
      results: perSlotResults,
      event: dateEvent,
      recommendations: [apiDateRecommendation],
    });

    expect(selection).toEqual({
      channel: "inperson",
      startsAt: "2026-08-20T09:30:00+00:00",
      endsAt: "2026-08-20T10:30:00+00:00",
      slotIndices: [1, 2],
      groupKey: "date:2026-08-20",
      label: "2026-08-20 09:30–10:30",
      dateLabel: localeDateTime(
        "2026-08-20T09:30:00Z",
        "UTC",
        DATE_LABEL_OPTIONS,
      ),
      source: "calendar",
      recommendation: null,
      rescheduled: false,
      metrics: { exact: false, weighted: 0.7, unweighted: 0.4 },
    });
    expect(
      selectionMatchesRecommendation(selection, apiDateRecommendation),
    ).toBe(false);
  });

  test("ignores recommendations on another channel or another instant", () => {
    const virtual = { ...apiDateRecommendation, channel: "virtual" };
    const otherChannel = selectionFromWindow({
      column: thursday,
      row: 0,
      k,
      channel: "inperson",
      results: null,
      event: dateEvent,
      recommendations: [virtual],
    });
    expect(otherChannel).toMatchObject({
      recommendation: null,
      metrics: { exact: false, weighted: null, unweighted: null },
      label: "2026-08-20 09:00–10:00",
    });

    // Weekly recommendation for another week: same indices, different instant.
    const [monday] = weeklyColumns("2026-09-13");
    const otherWeek = selectionFromWindow({
      column: monday,
      row: 0,
      k,
      channel: "inperson",
      results: perSlotResults,
      event: weeklyEvent,
      recommendations: [staleWeeklyRecommendation],
    });
    expect(otherWeek).toMatchObject({
      startsAt: "2026-09-14T09:00:00.000Z",
      endsAt: "2026-09-14T10:00:00.000Z",
      groupKey: "weekday:1",
      label: "Mon 09:00–10:00",
      recommendation: null,
      metrics: { exact: false, weighted: 0.8, unweighted: 0.5 },
    });

    const sameWeek = selectionFromWindow({
      column: weeklyColumns("2026-09-06")[0],
      row: 0,
      k,
      channel: "inperson",
      results: perSlotResults,
      event: weeklyEvent,
      recommendations: [staleWeeklyRecommendation],
    });
    expect(sameWeek).toMatchObject({
      startsAt: "2026-09-07T09:00:00.000Z",
      recommendation: staleWeeklyRecommendation,
      metrics: { exact: true, weighted: 0.75 },
    });
  });

  test("returns null for tail rows, blocked windows and daylight-saving gaps", () => {
    expect(
      selectionFromWindow({
        column: thursday,
        row: 3,
        k,
        channel: "inperson",
        results: perSlotResults,
        event: dateEvent,
      }),
    ).toBeNull();

    // Monday 09:30 is blocked: the ranked 09:00 window runs into it, while
    // the 10:00 window after it is still a plain calendar pick.
    const [blockedMonday] = weeklyColumns(
      "2026-09-06",
      utcResolver,
      blockedWeeklyEvent({ "weekday:1": [1] }),
    );
    expect(
      selectionFromWindow({
        column: blockedMonday,
        row: 0,
        k,
        channel: "inperson",
        results: perSlotResults,
        event: weeklyEvent,
        recommendations: [staleWeeklyRecommendation],
      }),
    ).toBeNull();
    expect(
      selectionFromWindow({
        column: blockedMonday,
        row: 2,
        k,
        channel: "inperson",
        results: perSlotResults,
        event: weeklyEvent,
        recommendations: [staleWeeklyRecommendation],
      }),
    ).toMatchObject({
      slotIndices: [2, 3],
      startsAt: "2026-09-07T10:00:00.000Z",
      recommendation: null,
      source: "calendar",
    });

    const [gapColumn] = weeklyColumns(
      "2026-03-08",
      laResolver,
      laSundayEvent(["01:00", "02:00", "03:00", "04:00"]),
    );
    expect(
      selectionFromWindow({
        column: gapColumn,
        row: 0,
        k: 2,
        channel: "inperson",
        results: null,
        event: { timezone: LA },
      }),
    ).toBeNull();
    expect(
      selectionFromWindow({
        column: gapColumn,
        row: 0,
        k: 0,
        channel: "inperson",
        results: null,
        event: { timezone: LA },
      }),
    ).toBeNull();
  });
});

// --- blocks -----------------------------------------------------------------

describe("recommendationBlocks", () => {
  const best = {
    rank: 1,
    channel: "inperson",
    groupKey: "weekday:1",
    weekday: 1,
    slotIndices: [0, 1],
    suggestedStartsAt: "2026-09-07T09:00:00Z",
    suggestedEndsAt: "2026-09-07T10:00:00Z",
  };
  const saturdayNight = {
    rank: 2,
    channel: "inperson",
    groupKey: "weekday:6",
    weekday: 6,
    slotIndices: [9, 10],
    suggestedStartsAt: "2026-09-12T23:30:00Z",
    suggestedEndsAt: "2026-09-13T00:30:00Z",
  };
  const virtual = {
    rank: 3,
    channel: "virtual",
    groupKey: "weekday:1",
    weekday: 1,
    slotIndices: [2, 3],
  };
  const legacy = {
    rank: 4,
    channel: "inperson",
    startsAt: "2026-09-14T09:00:00Z",
    endsAt: "2026-09-14T10:00:00Z",
  };
  const otherGroup = {
    rank: 5,
    channel: "inperson",
    groupKey: "weekday:2",
    weekday: 2,
    slotIndices: [0, 1],
  };
  const keyless = { rank: 6, channel: "inperson", slotIndices: [4, 5] };
  const recommendations = [
    best,
    saturdayNight,
    virtual,
    legacy,
    otherGroup,
    keyless,
  ];

  test("draws every ranked window of the channel on the visible columns, week after week", () => {
    const thisWeek = recommendationBlocks(
      recommendations,
      weeklyColumns("2026-09-13"),
      "inperson",
    );

    expect(thisWeek).toEqual([
      {
        key: "1:weekday:1:2026-09-14",
        rank: 1,
        best: true,
        columnIndex: 0,
        row: 0,
        span: 2,
        recommendation: best,
      },
      {
        key: "2:weekday:6:2026-09-19",
        rank: 2,
        best: false,
        columnIndex: 2,
        row: 1,
        span: 2,
        recommendation: saturdayNight,
      },
      {
        key: "6:weekday:3:2026-09-16",
        rank: 6,
        best: false,
        columnIndex: 1,
        row: 0,
        span: 2,
        recommendation: keyless,
      },
    ]);

    const nextWeek = recommendationBlocks(
      recommendations,
      weeklyColumns("2026-09-20"),
      "inperson",
    );
    expect(nextWeek.map((block) => block.key)).toEqual([
      "1:weekday:1:2026-09-21",
      "2:weekday:6:2026-09-26",
      "6:weekday:3:2026-09-23",
    ]);
  });

  test("filters by channel and copes with missing input", () => {
    const columns = weeklyColumns("2026-09-13");
    expect(recommendationBlocks(recommendations, columns, "virtual")).toEqual([
      {
        key: "3:weekday:1:2026-09-14",
        rank: 3,
        best: false,
        columnIndex: 0,
        row: 2,
        span: 2,
        recommendation: virtual,
      },
    ]);
    expect(recommendationBlocks(null, columns, "inperson")).toEqual([]);
    expect(recommendationBlocks(recommendations, [], "inperson")).toEqual([]);
    expect(
      recommendationBlocks(
        [{ rank: 9, channel: "inperson", slotIndices: [] }],
        columns,
        "inperson",
      ),
    ).toEqual([]);

    // Date columns: blocks land on the column that owns the slot index.
    const dateBlocks = recommendationBlocks(
      [
        {
          ...apiDateRecommendation,
          groupKey: "date:2026-08-23",
          slotIndices: [13, 14],
        },
      ],
      dateColumns(nineDateEvent),
      "inperson",
    );
    expect(dateBlocks).toEqual([
      expect.objectContaining({ columnIndex: 3, row: 1, span: 2, best: true }),
    ]);
  });
});

describe("selectionBlock", () => {
  test("locates a weekly selection only on the week whose instants match", () => {
    const selection = {
      channel: "inperson",
      startsAt: "2026-09-21T09:00:00Z",
      endsAt: "2026-09-21T10:00:00Z",
      slotIndices: [0, 1],
      groupKey: "weekday:1",
    };
    expect(selectionBlock(selection, weeklyColumns("2026-09-20"))).toEqual({
      columnIndex: 0,
      row: 0,
      span: 2,
    });
    expect(selectionBlock(selection, weeklyColumns("2026-09-13"))).toBeNull();

    const overnight = {
      ...selection,
      startsAt: "2026-09-19T23:30:00.000Z",
      endsAt: "2026-09-20T00:30:00.000Z",
      slotIndices: [9, 10],
      groupKey: "weekday:6",
    };
    expect(selectionBlock(overnight, weeklyColumns("2026-09-13"))).toEqual({
      columnIndex: 2,
      row: 1,
      span: 2,
    });

    // A mismatched group key hides the block even when the index exists.
    expect(
      selectionBlock(
        { ...selection, groupKey: "weekday:3" },
        weeklyColumns("2026-09-20"),
      ),
    ).toBeNull();
    expect(selectionBlock(null, weeklyColumns("2026-09-20"))).toBeNull();
    expect(
      selectionBlock(
        { ...selection, slotIndices: null },
        weeklyColumns("2026-09-20"),
      ),
    ).toBeNull();
  });

  test("locates a date selection by slot index on its page", () => {
    const selection = {
      channel: "inperson",
      startsAt: "2026-08-27T10:00:00Z",
      endsAt: "2026-08-27T11:00:00Z",
      slotIndices: [30, 31],
      groupKey: "date:2026-08-27",
    };
    expect(selectionBlock(selection, dateColumns(nineDateEvent, 1))).toEqual({
      columnIndex: 0,
      row: 2,
      span: 2,
    });
    expect(selectionBlock(selection, dateColumns(nineDateEvent, 0))).toBeNull();
    expect(
      selectionBlock(
        { ...selection, groupKey: null },
        dateColumns(nineDateEvent, 1),
      ),
    ).toEqual({ columnIndex: 0, row: 2, span: 2 });
  });
});

describe("confirmedBlock", () => {
  test("spans from the confirmed start to the boundary that ends the meeting", () => {
    const columns = weeklyColumns("2026-09-13");
    expect(
      confirmedBlock(
        {
          startsAt: "2026-09-14T09:30:00Z",
          endsAt: "2026-09-14T11:00:00Z",
          channel: "inperson",
        },
        columns,
      ),
    ).toEqual({ columnIndex: 0, row: 1, span: 3, channel: "inperson" });
    expect(
      confirmedBlock(
        { startsAt: "2026-09-19T23:30:00Z", endsAt: "2026-09-20T00:30:00Z" },
        columns,
      ),
    ).toEqual({ columnIndex: 2, row: 1, span: 2, channel: null });
    expect(
      confirmedBlock(
        {
          startsAt: "2026-08-20T09:00:00Z",
          endsAt: "2026-08-20T10:00:00Z",
          channel: "inperson",
        },
        dateColumns(dateEvent),
      ),
    ).toEqual({ columnIndex: 0, row: 0, span: 2, channel: "inperson" });
  });

  test("returns null when the meeting is absent, elsewhere or not slot-aligned", () => {
    const columns = weeklyColumns("2026-09-13");
    expect(confirmedBlock(null, columns)).toBeNull();
    expect(
      confirmedBlock({ startsAt: "2026-09-14T09:30:00Z" }, columns),
    ).toBeNull();
    expect(
      confirmedBlock(
        { startsAt: "2026-09-21T09:30:00Z", endsAt: "2026-09-21T11:00:00Z" },
        columns,
      ),
    ).toBeNull();
    expect(
      confirmedBlock(
        { startsAt: "2026-09-14T09:30:00Z", endsAt: "2026-09-14T11:15:00Z" },
        columns,
      ),
    ).toBeNull();
  });
});

// --- defaultView ------------------------------------------------------------

describe("defaultView", () => {
  const weekly = normalizeSlotGroups(weeklyEvent);
  const now = Date.parse("2026-09-14T12:00:00Z");

  test("anchors weekly events on the selection, else the current week while a day remains, else the best recommendation, else today", () => {
    // A selection always wins, even when this week still has enabled days.
    expect(
      defaultView({
        groups: weekly,
        selection: {
          startsAt: "2026-09-21T09:00:00Z",
          slotIndices: [0, 1],
          groupKey: "weekday:1",
        },
        recommendations: [
          { channel: "inperson", suggestedStartsAt: "2026-10-05T09:00:00Z" },
        ],
        channel: "inperson",
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-20" });
    expect(
      defaultView({
        groups: weekly,
        selection: { startsAt: "2026-09-07T09:00:00Z", slotIndices: [0, 1] },
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-06" });

    const recommendations = [
      {
        rank: 1,
        channel: "inperson",
        suggestedStartsAt: "2026-09-23T09:00:00Z",
        slotIndices: [4, 5],
      },
      {
        rank: 2,
        channel: "virtual",
        suggestedStartsAt: "2026-09-30T09:00:00Z",
        slotIndices: [4, 5],
      },
    ];
    // Monday: Wednesday and Saturday are still ahead, so this week is shown
    // regardless of where the ranked windows were suggested.
    expect(
      defaultView({
        groups: weekly,
        recommendations,
        channel: "inperson",
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-13" });
    expect(defaultView({ groups: weekly, now, timeZone: "UTC" })).toEqual({
      weekStart: "2026-09-13",
    });

    // Thursday on a Mon/Wed-only event: nothing remains this week, so the
    // best recommendation of the channel decides, else today's week.
    const midweek = normalizeSlotGroups({
      ...weeklyEvent,
      slotGroups: weeklyEvent.slotGroups.slice(0, 2),
    });
    const thursday = Date.parse("2026-09-17T12:00:00Z");
    expect(
      defaultView({
        groups: midweek,
        recommendations,
        channel: "inperson",
        now: thursday,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-20" });
    expect(
      defaultView({
        groups: midweek,
        recommendations,
        channel: "virtual",
        now: thursday,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-27" });
    expect(
      defaultView({
        groups: midweek,
        recommendations,
        channel: null,
        now: thursday,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-20" });
    expect(
      defaultView({
        groups: midweek,
        recommendations: [
          { channel: "virtual", startsAt: "2026-10-05T09:00:00Z" },
        ],
        channel: "inperson",
        now: thursday,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-13" });
    expect(
      defaultView({ groups: midweek, now: thursday, timeZone: "UTC" }),
    ).toEqual({ weekStart: "2026-09-13" });

    // Today only counts while its window is still open: Wednesday 11:30 is
    // past the 11:00 end on a Mon/Wed event, so the best recommendation's
    // week is shown; at 10:59 this week still stands.
    expect(
      defaultView({
        groups: midweek,
        recommendations,
        channel: "inperson",
        now: Date.parse("2026-09-16T11:30:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-20" });
    expect(
      defaultView({
        groups: midweek,
        recommendations,
        channel: "inperson",
        now: Date.parse("2026-09-16T10:59:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-13" });
    // An overnight window that ends tomorrow is still open all day.
    expect(
      defaultView({
        groups: weekly,
        recommendations,
        channel: "inperson",
        now: Date.parse("2026-09-19T23:59:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-13" });

    // "Today" follows the event timezone: 13:00Z on Saturday is already
    // Sunday in Auckland, whose week still has every enabled day ahead.
    expect(
      defaultView({
        groups: weekly,
        now: Date.parse("2026-09-19T13:00:00Z"),
        timeZone: "Pacific/Auckland",
      }),
    ).toEqual({ weekStart: "2026-09-20" });
    expect(defaultView({ groups: weekly, now, timeZone: "Moon/Base" })).toEqual(
      { weekStart: "2026-09-13" },
    );
  });

  test("opens on the confirmed meeting when nothing is selected", () => {
    // A finalized weekly event opens on the week of its meeting even when
    // this week still has enabled days and a ranked window elsewhere.
    expect(
      defaultView({
        groups: weekly,
        finalMeeting: {
          startsAt: "2026-10-05T09:30:00Z",
          endsAt: "2026-10-05T10:30:00Z",
          channel: "inperson",
        },
        recommendations: [
          {
            channel: "inperson",
            suggestedStartsAt: "2026-09-23T09:00:00Z",
            slotIndices: [4, 5],
          },
        ],
        channel: "inperson",
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-10-04" });
    // A Saturday-overnight meeting starting after midnight stays in the week
    // of its Saturday column.
    expect(
      defaultView({
        groups: weekly,
        finalMeeting: {
          startsAt: "2026-10-04T00:00:00Z",
          endsAt: "2026-10-04T01:00:00Z",
        },
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-27" });
    // A selection still wins over the confirmed meeting.
    expect(
      defaultView({
        groups: weekly,
        selection: { startsAt: "2026-09-21T09:00:00Z", slotIndices: [0, 1] },
        finalMeeting: {
          startsAt: "2026-10-05T09:30:00Z",
          endsAt: "2026-10-05T10:30:00Z",
        },
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-20" });
    // Specific dates: the page holding the confirmed date.
    expect(
      defaultView({
        groups: normalizeSlotGroups(nineDateEvent),
        finalMeeting: {
          startsAt: "2026-08-28T09:00:00+00:00",
          endsAt: "2026-08-28T10:00:00+00:00",
        },
        now: Date.parse("2026-08-01T00:00:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ page: 1 });
    // A meeting no slot matches falls back to its own date.
    expect(
      defaultView({
        groups: weekly,
        finalMeeting: {
          startsAt: "2026-10-06T15:00:00Z",
          endsAt: "2026-10-06T16:00:00Z",
        },
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-10-04" });
    expect(
      defaultView({
        groups: weekly,
        finalMeeting: { startsAt: "not a date", endsAt: "" },
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-13" });
  });

  test("keeps Saturday-overnight windows in the week they start", () => {
    // 00:00Z Sunday is slot 10 of the Saturday column (startDayOffset 1).
    expect(
      defaultView({
        groups: weekly,
        selection: {
          startsAt: "2026-09-20T00:00:00Z",
          slotIndices: [10, 11],
          groupKey: "weekday:6",
        },
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-13" });
    // The recommendation's own offset is used when the slot is not in the
    // groups (Thursday the 24th on a Mon/Wed event: nothing remains this week).
    expect(
      defaultView({
        groups: normalizeSlotGroups({
          ...weeklyEvent,
          slotGroups: weeklyEvent.slotGroups.slice(0, 2),
        }),
        recommendations: [
          {
            channel: "inperson",
            suggestedStartsAt: "2026-09-27T00:00:00Z",
            slotIndices: [99],
            startDayOffset: 1,
          },
        ],
        now: Date.parse("2026-09-24T12:00:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-20" });
    // A window that starts on Saturday evening has no correction to make.
    expect(
      defaultView({
        groups: weekly,
        selection: {
          startsAt: "2026-09-19T23:30:00Z",
          slotIndices: [9, 10],
          groupKey: "weekday:6",
        },
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ weekStart: "2026-09-13" });
  });

  test("picks the page holding the anchor, else the first upcoming date, else the last page", () => {
    const groups = normalizeSlotGroups(nineDateEvent);
    const onLastDate = {
      startsAt: "2026-08-28T09:00:00Z",
      slotIndices: [32, 33],
      groupKey: "date:2026-08-28",
    };
    expect(
      defaultView({ groups, selection: onLastDate, now, timeZone: "UTC" }),
    ).toEqual({ page: 1 });
    expect(
      defaultView({
        groups,
        selection: { ...onLastDate, groupKey: null },
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ page: 1 });
    expect(
      defaultView({
        groups,
        recommendations: [
          {
            channel: "inperson",
            suggestedStartsAt: "2026-08-21T09:00:00Z",
            slotIndices: [4, 5],
            groupKey: "date:2026-08-21",
          },
        ],
        channel: "inperson",
        now,
        timeZone: "UTC",
      }),
    ).toEqual({ page: 0 });
    // An anchor that is not one of the configured dates falls back to today.
    expect(
      defaultView({
        groups,
        selection: {
          startsAt: "2026-08-28T09:00:00Z",
          slotIndices: [80],
          groupKey: "date:2026-09-01",
        },
        now: Date.parse("2026-08-27T12:00:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ page: 1 });

    expect(
      defaultView({
        groups,
        now: Date.parse("2026-08-25T12:00:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ page: 0 });
    expect(
      defaultView({
        groups,
        now: Date.parse("2026-08-27T00:00:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ page: 1 });
    expect(
      defaultView({
        groups,
        now: Date.parse("2026-01-01T00:00:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ page: 0 });
    expect(
      defaultView({
        groups,
        now: Date.parse("2026-09-01T00:00:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual({ page: 1 });
    // Today in Los Angeles is still the 26th when it is 03:00Z on the 27th.
    expect(
      defaultView({
        groups,
        now: Date.parse("2026-08-27T03:00:00Z"),
        timeZone: LA,
      }),
    ).toEqual({ page: 0 });
  });
});

// --- keys -------------------------------------------------------------------

describe("selectionKey and selectionMatchesRecommendation", () => {
  test("keys a selection by channel and parsed instants", () => {
    expect(
      selectionKey({
        channel: "inperson",
        startsAt: "2026-09-14T09:00:00Z",
        endsAt: "2026-09-14T10:00:00Z",
      }),
    ).toBe("inperson|1789376400000|1789380000000");
    expect(
      selectionKey({
        channel: "inperson",
        startsAt: "2026-09-14T09:00:00.000+00:00",
        endsAt: "2026-09-14T10:00:00.000Z",
      }),
    ).toBe("inperson|1789376400000|1789380000000");
    expect(selectionKey(null)).toBeNull();
    expect(selectionKey({ channel: "inperson" })).toBeNull();
  });

  test("matches recommendations by channel and instants regardless of formatting", () => {
    const selection = {
      channel: "inperson",
      startsAt: "2026-08-20T09:00:00.000Z",
      endsAt: "2026-08-20T10:00:00.000Z",
    };
    expect(
      selectionMatchesRecommendation(selection, apiDateRecommendation),
    ).toBe(true);
    expect(
      selectionMatchesRecommendation(selection, {
        channel: "inperson",
        startsAt: "2026-08-20T09:00:00+00:00",
        endsAt: "2026-08-20T10:00:00+00:00",
      }),
    ).toBe(true);
    expect(
      selectionMatchesRecommendation(
        { ...selection, channel: "virtual" },
        apiDateRecommendation,
      ),
    ).toBe(false);
    expect(
      selectionMatchesRecommendation(
        { ...selection, endsAt: "2026-08-20T10:30:00Z" },
        apiDateRecommendation,
      ),
    ).toBe(false);
    expect(selectionMatchesRecommendation(null, apiDateRecommendation)).toBe(
      false,
    );
    expect(selectionMatchesRecommendation(selection, null)).toBe(false);
  });

  test("keeps a rescheduled ranked choice matched but not a calendar pick in a later week", () => {
    const now = Date.parse("2026-09-14T12:00:00Z"); // Monday, after 09:00
    const chosen = selectionFromRecommendation(
      staleWeeklyRecommendation,
      weeklyEvent,
      { now },
    );
    expect(chosen).toMatchObject({
      startsAt: "2026-09-21T09:00:00.000Z",
      rescheduled: true,
    });
    // The organizer chose this ranked window; moving it to the next
    // occurrence does not make it a different window.
    expect(
      selectionMatchesRecommendation(chosen, staleWeeklyRecommendation),
    ).toBe(true);
    expect(
      selectionMatchesRecommendation(chosen, {
        ...staleWeeklyRecommendation,
        slotIndices: [1, 2],
      }),
    ).toBe(false);
    expect(
      selectionMatchesRecommendation(chosen, {
        ...staleWeeklyRecommendation,
        channel: "virtual",
      }),
    ).toBe(false);
    expect(
      selectionMatchesRecommendation(chosen, {
        ...staleWeeklyRecommendation,
        groupKey: "weekday:3",
      }),
    ).toBe(false);

    // Clicking the same weekday and time on the calendar a week later is a
    // custom window with a concrete date, even when its instants coincide
    // with the rescheduled occurrence.
    const laterWeek = selectionFromWindow({
      column: weeklyColumns("2026-09-20")[0],
      row: 0,
      k: 2,
      channel: "inperson",
      results: perSlotResults,
      event: weeklyEvent,
      recommendations: [staleWeeklyRecommendation],
    });
    expect(laterWeek).toMatchObject({
      startsAt: "2026-09-21T09:00:00.000Z",
      endsAt: "2026-09-21T10:00:00.000Z",
      recommendation: null,
      rescheduled: false,
      dateLabel: localeDateTime(
        "2026-09-21T09:00:00Z",
        "UTC",
        DATE_LABEL_OPTIONS,
      ),
      metrics: { exact: false },
    });
    expect(selectionKey(laterWeek)).toBe(selectionKey(chosen));
    expect(
      selectionMatchesRecommendation(laterWeek, staleWeeklyRecommendation),
    ).toBe(false);
  });
});

describe("invalid time zones", () => {
  const brokenEvent = { ...weeklyEvent, timezone: "Mars/Olympus_Mons" };
  const staleRecommendation = {
    channel: "inperson",
    rank: 1,
    weekday: 1,
    groupKey: "weekday:1",
    slotIndices: [0, 1],
    localStart: "09:00",
    localEnd: "10:00",
    startDayOffset: 0,
    endDayOffset: 0,
    label: "Mon 09:00–10:00",
    suggestedStartsAt: "2026-09-07T09:00:00Z",
    suggestedEndsAt: "2026-09-07T10:00:00Z",
    weightedAvailability: 0.5,
    unweightedAvailability: 0.5,
  };

  test("leave a stale weekly suggestion where it is", () => {
    const selection = selectionFromRecommendation(
      staleRecommendation,
      brokenEvent,
      { now: Date.parse("2026-09-14T12:00:00Z") },
    );
    expect(selection).toMatchObject({
      startsAt: "2026-09-07T09:00:00Z",
      rescheduled: false,
    });
    // The date label degrades to the browser locale instead of failing.
    expect(selection.dateLabel).toEqual(expect.any(String));
    // Nothing can be re-anchored without a working resolver, even a good one
    // cannot place "today" in an unknown zone.
    expect(
      selectionFromRecommendation(staleRecommendation, brokenEvent, {
        now: Date.parse("2026-09-14T12:00:00Z"),
        resolver: utcResolver,
      }),
    ).toMatchObject({ startsAt: "2026-09-07T09:00:00Z", rescheduled: false });
  });

  test("fall back to today's week and the last page when anchors cannot be placed", () => {
    const now = Date.parse("2026-09-15T12:00:00Z");
    const groups = normalizeSlotGroups(brokenEvent);
    expect(
      defaultView({
        groups,
        selection: {
          channel: "inperson",
          startsAt: "2026-10-05T09:00:00Z",
          endsAt: "2026-10-05T10:00:00Z",
          slotIndices: [0, 1],
          groupKey: "weekday:1",
        },
        now,
        timeZone: brokenEvent.timezone,
      }),
    ).toEqual({ weekStart: "2026-09-13" });
    expect(
      defaultView({
        groups,
        finalMeeting: {
          startsAt: "2026-10-05T09:00:00Z",
          endsAt: "2026-10-05T10:00:00Z",
          active: true,
        },
        now,
        timeZone: brokenEvent.timezone,
      }),
    ).toEqual({ weekStart: "2026-09-13" });
    const dateGroups = normalizeSlotGroups(nineDateEvent);
    expect(
      defaultView({
        groups: dateGroups,
        now,
        timeZone: brokenEvent.timezone,
      }),
    ).toEqual({ page: 1 });
  });
});
