// Pure model for the organizer's meeting-time calendar: turns an event's slot
// groups into dated columns, resolves clicked cells into tz-aware windows the
// finalization API accepts, and maps recommendations/selections onto cells.
//
// Everything here is deterministic: `now` is always passed in, never read.
import { DAY_LABELS } from "@/lib/constants";
import { formatDateTimeInTimezone } from "@/lib/format";
import {
  createLocalDateTimeResolver,
  formatIsoForDateTimeLocal,
} from "@/lib/time";

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const COLUMNS_PER_PAGE = 7;

// --- calendar-date helpers ("YYYY-MM-DD" strings, UTC arithmetic) ----------

export function parseDate(date) {
  const [year, month, day] = String(date).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function dateFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date, days) {
  return dateFromMs(parseDate(date) + days * DAY_MS);
}

export function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

/** Sunday = 0 … Saturday = 6, matching the API and DAY_LABELS. */
export function weekdayOf(date) {
  return new Date(parseDate(date)).getUTCDay();
}

export function weekStartOf(date) {
  return addDays(date, -weekdayOf(date));
}

export function localDateOf(iso, timeZone) {
  return formatIsoForDateTimeLocal(iso, timeZone).slice(0, 10);
}

export function formatDate(date, options = {}) {
  return new Date(parseDate(date)).toLocaleDateString([], {
    timeZone: "UTC",
    ...options,
  });
}

/** "Sep 13 – 19, 2026", "Sep 28 – Oct 4, 2026", "Dec 28, 2026 – Jan 3, 2027". */
export function formatWeekLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const start = new Date(parseDate(weekStart));
  const end = new Date(parseDate(weekEnd));
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
  if (sameMonth) {
    // Intl has no "day + year" pattern (modern ICU renders it as
    // "2026 (day: 19)"), so the trailing "19, 2026" is assembled by hand.
    return `${formatDate(weekStart, { month: "short", day: "numeric" })} – ${formatDate(
      weekEnd,
      { day: "numeric" },
    )}, ${end.getUTCFullYear()}`;
  }
  if (sameYear) {
    return `${formatDate(weekStart, { month: "short", day: "numeric" })} – ${formatDate(
      weekEnd,
      { month: "short", day: "numeric", year: "numeric" },
    )}`;
  }
  const full = { month: "short", day: "numeric", year: "numeric" };
  return `${formatDate(weekStart, full)} – ${formatDate(weekEnd, full)}`;
}

// --- slot groups -------------------------------------------------------------

/**
 * Normalizes `event.slotGroups` into `{ key, kind, label, weekday, date, slots }`.
 * Accepts the API shape (weekday:N / date:YYYY-MM-DD groups) and older
 * fixtures whose slots only carry `startsAt`/`endsAt` and whose key is a bare
 * date; groups without usable slots are dropped.
 */
export function normalizeSlotGroups(event) {
  const timeZone = event?.timezone || "UTC";
  const groups = Array.isArray(event?.slotGroups) ? event.slotGroups : [];
  const normalized = [];
  groups.forEach((group) => {
    if (!group || typeof group !== "object") return;
    const key = String(group.key ?? "");
    let kind = "date";
    let weekday = null;
    let date = null;
    if (group.weekday != null || key.startsWith("weekday:")) {
      kind = "weekday";
      weekday = Number(group.weekday ?? key.slice("weekday:".length));
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return;
    } else if (typeof group.date === "string" && DATE_ONLY.test(group.date)) {
      date = group.date;
    } else if (key.startsWith("date:") && DATE_ONLY.test(key.slice(5))) {
      date = key.slice(5);
    } else if (DATE_ONLY.test(key)) {
      date = key;
    }

    const slots = [];
    (Array.isArray(group.slots) ? group.slots : []).forEach((slot) => {
      if (!slot || !Number.isInteger(slot.index)) return;
      let { localStart, localEnd } = slot;
      let startDayOffset = Number(slot.startDayOffset) || 0;
      let endDayOffset = Number(slot.endDayOffset) || 0;
      if ((!localStart || !localEnd) && slot.startsAt && slot.endsAt) {
        try {
          const start = formatIsoForDateTimeLocal(slot.startsAt, timeZone);
          const end = formatIsoForDateTimeLocal(slot.endsAt, timeZone);
          if (kind === "date" && !date) date = start.slice(0, 10);
          localStart = localStart || start.slice(11);
          localEnd = localEnd || end.slice(11);
          if (kind === "date") {
            startDayOffset = daysBetween(date, start.slice(0, 10));
            endDayOffset = daysBetween(date, end.slice(0, 10));
          }
        } catch {
          return;
        }
      }
      if (!localStart || !localEnd) return;
      slots.push({
        index: slot.index,
        localStart,
        localEnd,
        startDayOffset,
        endDayOffset,
        startsAt: slot.startsAt ?? null,
        endsAt: slot.endsAt ?? null,
        startOffset: slot.startOffset ?? null,
        endOffset: slot.endOffset ?? null,
      });
    });
    if (!slots.length) return;
    if (kind === "date" && !date) return;
    normalized.push({
      key,
      kind,
      label:
        group.label || (kind === "weekday" ? DAY_LABELS[weekday] : date) || key,
      weekday,
      date,
      slots,
    });
  });
  return normalized;
}

export function groupKind(groups) {
  return groups[0]?.kind === "weekday" ? "weekday" : "date";
}

/** Slots per meeting window, or 0 when the duration does not divide evenly. */
export function windowSlotCount(event) {
  const duration = Number(event?.meetingDurationMinutes);
  const slotMinutes = Number(event?.slotMinutes);
  if (!(duration > 0) || !(slotMinutes > 0) || duration % slotMinutes !== 0)
    return 0;
  return duration / slotMinutes;
}

export function slotByIndex(groups, index) {
  for (const group of groups) {
    const slot = group.slots.find((candidate) => candidate.index === index);
    if (slot) return { group, slot };
  }
  return null;
}

// --- columns (one per visible day) ------------------------------------------

function resolveBoundary(resolver, date, dayOffset, localTime) {
  try {
    return {
      value: resolver(`${addDays(date, dayOffset)}T${localTime}`),
      error: null,
    };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

/**
 * Builds the visible columns.
 * - weekly groups + `view.weekStart`: one column per enabled weekday on that
 *   week, boundaries resolved through `resolver(localDateTime)`;
 * - date groups + `view.page`: up to seven configured dates, boundaries taken
 *   verbatim from the slots.
 * Each boundary is `{ startsAt, endsAt, error }`; errors are captured so a
 * daylight-saving gap only disables the affected cells.
 */
export function buildColumns({ groups, view, resolver }) {
  const kind = groupKind(groups);
  if (kind === "weekday") {
    const weekStart = view?.weekStart;
    if (!weekStart) return [];
    return groups
      .filter((group) => group.kind === "weekday")
      .map((group) => {
        const date = addDays(weekStart, group.weekday);
        const boundaries = group.slots.map((slot) => {
          const start = resolveBoundary(
            resolver,
            date,
            slot.startDayOffset,
            slot.localStart,
          );
          const end = resolveBoundary(
            resolver,
            date,
            slot.endDayOffset,
            slot.localEnd,
          );
          return {
            startsAt: start.value,
            endsAt: end.value,
            error: start.error || end.error,
          };
        });
        return {
          key: `${group.key}:${date}`,
          groupKey: group.key,
          groupLabel: group.label,
          kind,
          date,
          weekday: group.weekday,
          headerLabel: DAY_LABELS[group.weekday],
          subLabel: formatDate(date, { month: "short", day: "numeric" }),
          slots: group.slots,
          boundaries,
        };
      });
  }

  const page = Math.max(0, Number(view?.page) || 0);
  return groups
    .filter((group) => group.kind === "date")
    .slice(page * COLUMNS_PER_PAGE, (page + 1) * COLUMNS_PER_PAGE)
    .map((group) => ({
      key: group.key,
      groupKey: group.key,
      groupLabel: group.label,
      kind,
      date: group.date,
      weekday: weekdayOf(group.date),
      headerLabel: formatDate(group.date, { weekday: "short" }),
      subLabel: formatDate(group.date, { month: "short", day: "numeric" }),
      slots: group.slots,
      boundaries: group.slots.map((slot) => ({
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        error:
          slot.startsAt && slot.endsAt
            ? null
            : "This slot has no resolved start or end time.",
      })),
    }));
}

export function pageCount(groups) {
  const dates = groups.filter((group) => group.kind === "date").length;
  return Math.max(1, Math.ceil(dates / COLUMNS_PER_PAGE));
}

export function formatRangeLabel({ kind, view, groups, columns }) {
  if (kind === "weekday")
    return view?.weekStart ? formatWeekLabel(view.weekStart) : "";
  const total = groups.filter((group) => group.kind === "date").length;
  if (!total) return "";
  const page = Math.max(0, Number(view?.page) || 0);
  const first = page * COLUMNS_PER_PAGE + 1;
  const last = Math.min(total, (page + 1) * COLUMNS_PER_PAGE);
  const range =
    columns.length > 0
      ? ` · ${formatDate(columns[0].date, { month: "short", day: "numeric" })} – ${formatDate(
          columns[columns.length - 1].date,
          { month: "short", day: "numeric", year: "numeric" },
        )}`
      : "";
  return `Dates ${first}–${last} of ${total}${range}`;
}

// --- windows ----------------------------------------------------------------

/** The window of `k` slots starting at `row`, or an `error` when it cannot start there. */
export function windowAt(column, row, k) {
  if (!(k >= 1)) {
    return {
      slotIndices: null,
      startsAt: null,
      endsAt: null,
      error: "invalid-duration",
    };
  }
  if (row < 0 || row + k > column.slots.length) {
    return { slotIndices: null, startsAt: null, endsAt: null, error: "tail" };
  }
  for (let offset = 0; offset < k; offset += 1) {
    const boundary = column.boundaries[row + offset];
    if (!boundary || boundary.error) {
      return {
        slotIndices: null,
        startsAt: null,
        endsAt: null,
        error: boundary?.error || "This slot cannot be resolved.",
      };
    }
  }
  return {
    slotIndices: column.slots.slice(row, row + k).map((slot) => slot.index),
    startsAt: column.boundaries[row].startsAt,
    endsAt: column.boundaries[row + k - 1].endsAt,
    error: null,
  };
}

export function cellState({ column, row, k, now }) {
  if (!(k >= 1)) return "invalid-duration";
  if (row + k > column.slots.length) return "tail";
  const window = windowAt(column, row, k);
  if (window.error) return "dst";
  if (now != null && Date.parse(window.startsAt) < now) return "past";
  return "startable";
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function cellMetrics(results, channel, index) {
  const channelResults = results?.channels?.[channel];
  return {
    weighted: finiteOrNull(channelResults?.weighted?.[index]),
    unweighted: finiteOrNull(channelResults?.unweighted?.[index]),
  };
}

/** Lowest per-slot share across the window (an upper bound on true attendance). */
export function windowMetrics(results, channel, slotIndices) {
  let weighted = null;
  let unweighted = null;
  (slotIndices || []).forEach((index) => {
    const metrics = cellMetrics(results, channel, index);
    if (metrics.weighted !== null)
      weighted =
        weighted === null
          ? metrics.weighted
          : Math.min(weighted, metrics.weighted);
    if (metrics.unweighted !== null)
      unweighted =
        unweighted === null
          ? metrics.unweighted
          : Math.min(unweighted, metrics.unweighted);
  });
  return { weighted, unweighted };
}

function dayOffsetSuffix(offset) {
  return offset ? ` +${offset}d` : "";
}

/** API-style label: "Mon 09:00–10:00", "Sat 23:30–00:30 +1d". */
export function formatWindowLabel(column, slots) {
  if (!slots?.length) return column.groupLabel;
  const first = slots[0];
  const last = slots[slots.length - 1];
  return `${column.groupLabel} ${first.localStart}${dayOffsetSuffix(first.startDayOffset)}–${last.localEnd}${dayOffsetSuffix(last.endDayOffset)}`;
}

export function formatDateLabel(iso, timeZone) {
  return formatDateTimeInTimezone(iso, timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// --- selections -------------------------------------------------------------

function recommendationMetrics(recommendation) {
  return {
    exact: true,
    weighted: finiteOrNull(
      recommendation.weightedAvailability ?? recommendation.weightedScore,
    ),
    unweighted: finiteOrNull(
      recommendation.unweightedAvailability ?? recommendation.unweightedScore,
    ),
    rank: recommendation.rank ?? null,
    fullyAvailableParticipantTotal:
      recommendation.fullyAvailableParticipantTotal ?? null,
    partiallyAvailableParticipantTotal:
      recommendation.partiallyAvailableParticipantTotal ?? null,
    unavailableParticipantTotal:
      recommendation.unavailableParticipantTotal ?? null,
  };
}

function safeResolver(timeZone) {
  try {
    return createLocalDateTimeResolver(timeZone);
  } catch {
    return null;
  }
}

/**
 * The wall-clock boundaries of a recommended window in the order the API
 * validates them: the first slot's start, then every slot's end. The slots
 * come from the recommendation's own group and must agree with its start and
 * end (a snapshot can outlive an event edit that renumbered the slots);
 * otherwise only the recommendation's start and end are used.
 */
function windowBoundaries(recommendation, groups) {
  const startOffset = Number(recommendation.startDayOffset) || 0;
  const endOffset = Number(recommendation.endDayOffset) || 0;
  const group =
    groups.find((candidate) => candidate.key === recommendation.groupKey) ||
    groups.find(
      (candidate) =>
        candidate.kind === "weekday" &&
        candidate.weekday === Number(recommendation.weekday),
    );
  const slots = group
    ? recommendation.slotIndices.map((index) =>
        group.slots.find((slot) => slot.index === index),
      )
    : [];
  const first = slots[0];
  const last = slots[slots.length - 1];
  if (
    first &&
    slots.every(Boolean) &&
    first.localStart === recommendation.localStart &&
    first.startDayOffset === startOffset &&
    last.localEnd === recommendation.localEnd &&
    last.endDayOffset === endOffset
  ) {
    return [
      { dayOffset: first.startDayOffset, time: first.localStart },
      ...slots.map((slot) => ({
        dayOffset: slot.endDayOffset,
        time: slot.localEnd,
      })),
    ];
  }
  return [
    { dayOffset: startOffset, time: recommendation.localStart },
    { dayOffset: endOffset, time: recommendation.localEnd },
  ];
}

// Weekly suggestions are frozen when the snapshot is computed; move a stale
// one forward to the next occurrence of its weekday. Mirrors the API's
// `_weekly_suggestion`: a 15-day search from today in the event timezone in
// which every boundary of the window (not just its ends) must resolve to a
// single instant, so daylight-saving days are skipped exactly as the API does.
function nextOccurrence(recommendation, groups, timeZone, now, resolver) {
  if (!resolver) return null;
  let today;
  try {
    today = localDateOf(new Date(now).toISOString(), timeZone);
  } catch {
    return null;
  }
  const boundaries = windowBoundaries(recommendation, groups);
  for (let offset = 0; offset < 15; offset += 1) {
    const base = addDays(today, offset);
    if (weekdayOf(base) !== Number(recommendation.weekday)) continue;
    const resolved = [];
    for (const boundary of boundaries) {
      const result = resolveBoundary(
        resolver,
        base,
        boundary.dayOffset,
        boundary.time,
      );
      if (result.error) break;
      resolved.push(result.value);
    }
    if (resolved.length !== boundaries.length) continue;
    const startsAt = resolved[0];
    const endsAt = resolved[resolved.length - 1];
    if (
      Date.parse(startsAt) >= now &&
      Date.parse(endsAt) > Date.parse(startsAt)
    )
      return { startsAt, endsAt };
  }
  return null;
}

/**
 * Builds a selection from a ranked recommendation. Instants are kept verbatim
 * except for a stale weekly suggestion (`suggestedStartsAt` before `now`),
 * which moves to the next valid occurrence of its weekday; `resolver` may be
 * injected but is built from the event timezone when omitted.
 */
export function selectionFromRecommendation(
  recommendation,
  event,
  { now = null, resolver = null } = {},
) {
  if (!recommendation) return null;
  const timeZone = event?.timezone || "UTC";
  let startsAt = recommendation.suggestedStartsAt || recommendation.startsAt;
  let endsAt = recommendation.suggestedEndsAt || recommendation.endsAt;
  let rescheduled = false;
  if (
    recommendation.weekday != null &&
    Array.isArray(recommendation.slotIndices) &&
    recommendation.localStart &&
    recommendation.localEnd &&
    now != null &&
    Number.isFinite(Date.parse(startsAt)) &&
    Date.parse(startsAt) < now
  ) {
    const next = nextOccurrence(
      recommendation,
      normalizeSlotGroups(event),
      timeZone,
      now,
      resolver || safeResolver(timeZone),
    );
    if (next) {
      startsAt = next.startsAt;
      endsAt = next.endsAt;
      rescheduled = true;
    }
  }
  let dateLabel = "";
  try {
    dateLabel = formatDateLabel(startsAt, timeZone);
  } catch {
    dateLabel = "";
  }
  return {
    channel: recommendation.channel,
    startsAt,
    endsAt,
    slotIndices: Array.isArray(recommendation.slotIndices)
      ? [...recommendation.slotIndices]
      : null,
    groupKey: recommendation.groupKey || null,
    label:
      recommendation.label ||
      formatDateTimeInTimezone(startsAt, timeZone, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }),
    dateLabel,
    source: "recommendation",
    recommendation,
    rescheduled,
    metrics: recommendationMetrics(recommendation),
  };
}

function sameIndices(first, second) {
  return (
    Array.isArray(first) &&
    Array.isArray(second) &&
    first.length === second.length &&
    first.every((value, position) => value === second[position])
  );
}

export function selectionFromWindow({
  column,
  row,
  k,
  channel,
  results,
  event,
  recommendations = [],
}) {
  const window = windowAt(column, row, k);
  if (window.error) return null;
  const timeZone = event?.timezone || "UTC";
  const slots = column.slots.slice(row, row + k);
  const match = (recommendations || []).find(
    (candidate) =>
      candidate.channel === channel &&
      sameIndices(candidate.slotIndices, window.slotIndices) &&
      Date.parse(candidate.suggestedStartsAt || candidate.startsAt) ===
        Date.parse(window.startsAt),
  );
  if (match) {
    return {
      ...selectionFromRecommendation(match, event),
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      source: "calendar",
    };
  }
  return {
    channel,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    slotIndices: window.slotIndices,
    groupKey: column.groupKey,
    label: formatWindowLabel(column, slots),
    dateLabel: formatDateLabel(window.startsAt, timeZone),
    source: "calendar",
    recommendation: null,
    rescheduled: false,
    metrics: {
      exact: false,
      ...windowMetrics(results, channel, window.slotIndices),
    },
  };
}

export function selectionKey(selection) {
  if (!selection?.startsAt) return null;
  return `${selection.channel}|${Date.parse(selection.startsAt)}|${Date.parse(
    selection.endsAt,
  )}`;
}

/**
 * Whether `selection` is the ranked window `recommendation`: same channel and
 * the same instants, or a stale weekly suggestion that was chosen from the
 * ranked list and moved to its next occurrence. A calendar pick of the same
 * weekday and time in another week is deliberately not a match (its instants
 * differ and only `selectionFromRecommendation` sets `rescheduled`).
 */
export function selectionMatchesRecommendation(selection, recommendation) {
  if (!selection || !recommendation) return false;
  if (selection.channel !== recommendation.channel) return false;
  if (
    Date.parse(selection.startsAt) ===
      Date.parse(recommendation.suggestedStartsAt || recommendation.startsAt) &&
    Date.parse(selection.endsAt) ===
      Date.parse(recommendation.suggestedEndsAt || recommendation.endsAt)
  )
    return true;
  return Boolean(
    selection.rescheduled &&
    recommendation.groupKey &&
    selection.groupKey === recommendation.groupKey &&
    sameIndices(selection.slotIndices, recommendation.slotIndices),
  );
}

// --- blocks (overlays drawn on the visible columns) ---------------------------

function rowOfIndex(column, index) {
  return column.slots.findIndex((slot) => slot.index === index);
}

/** Ranked windows that fall on the visible columns (weekly blocks repeat every week). */
export function recommendationBlocks(recommendations, columns, channel) {
  const blocks = [];
  (recommendations || []).forEach((recommendation) => {
    if (recommendation.channel !== channel) return;
    if (
      !Array.isArray(recommendation.slotIndices) ||
      !recommendation.slotIndices.length
    )
      return;
    const first = recommendation.slotIndices[0];
    columns.forEach((column, columnIndex) => {
      if (
        recommendation.groupKey &&
        column.groupKey !== recommendation.groupKey
      )
        return;
      const row = rowOfIndex(column, first);
      if (row < 0) return;
      blocks.push({
        key: `${recommendation.rank ?? first}:${column.key}`,
        rank: recommendation.rank ?? null,
        best: recommendation.rank === 1,
        columnIndex,
        row,
        span: recommendation.slotIndices.length,
        recommendation,
      });
    });
  });
  return blocks;
}

/** Where the selection sits on the visible columns, or null when it is elsewhere. */
export function selectionBlock(selection, columns) {
  if (!selection?.slotIndices?.length) return null;
  const first = selection.slotIndices[0];
  const startMs = Date.parse(selection.startsAt);
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const column = columns[columnIndex];
    if (selection.groupKey && column.groupKey !== selection.groupKey) continue;
    const row = rowOfIndex(column, first);
    if (row < 0) continue;
    const boundary = column.boundaries[row];
    if (!boundary?.startsAt || Date.parse(boundary.startsAt) !== startMs)
      continue;
    return { columnIndex, row, span: selection.slotIndices.length };
  }
  return null;
}

/** The confirmed meeting's block on the visible columns (for finalized events). */
export function confirmedBlock(finalMeeting, columns) {
  if (!finalMeeting?.startsAt || !finalMeeting?.endsAt) return null;
  const startMs = Date.parse(finalMeeting.startsAt);
  const endMs = Date.parse(finalMeeting.endsAt);
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const column = columns[columnIndex];
    const row = column.boundaries.findIndex(
      (boundary) =>
        boundary.startsAt && Date.parse(boundary.startsAt) === startMs,
    );
    if (row < 0) continue;
    let span = 0;
    for (let offset = row; offset < column.boundaries.length; offset += 1) {
      span += 1;
      const boundary = column.boundaries[offset];
      if (boundary.endsAt && Date.parse(boundary.endsAt) === endMs) {
        return {
          columnIndex,
          row,
          span,
          channel: finalMeeting.channel || null,
        };
      }
    }
  }
  return null;
}

// --- default view -----------------------------------------------------------

function anchorDate(anchor, groups, timeZone) {
  if (!anchor?.startsAt) return null;
  let localDate;
  try {
    localDate = localDateOf(anchor.startsAt, timeZone);
  } catch {
    return null;
  }
  // Overnight windows start on the previous calendar day's column.
  const first = Array.isArray(anchor.slotIndices)
    ? anchor.slotIndices[0]
    : null;
  const found = first != null ? slotByIndex(groups, first) : null;
  const offset =
    found?.slot.startDayOffset || Number(anchor.startDayOffset) || 0;
  return addDays(localDate, -offset);
}

// A confirmed meeting as a view anchor: its instant plus the slot it starts
// on, so an overnight meeting lands in the column (and week) it belongs to.
function finalMeetingAnchor(finalMeeting, groups, timeZone) {
  if (!finalMeeting?.startsAt) return null;
  const startMs = Date.parse(finalMeeting.startsAt);
  if (!Number.isFinite(startMs)) return null;
  let localDate;
  let localTime;
  try {
    const local = formatIsoForDateTimeLocal(finalMeeting.startsAt, timeZone);
    localDate = local.slice(0, 10);
    localTime = local.slice(11);
  } catch {
    return null;
  }
  for (const group of groups) {
    for (const slot of group.slots) {
      const matches =
        group.kind === "date"
          ? slot.startsAt && Date.parse(slot.startsAt) === startMs
          : slot.localStart === localTime &&
            weekdayOf(addDays(localDate, -slot.startDayOffset)) ===
              group.weekday;
      if (matches) {
        return {
          startsAt: finalMeeting.startsAt,
          slotIndices: [slot.index],
          startDayOffset: slot.startDayOffset,
          groupKey: group.key,
        };
      }
    }
  }
  return { startsAt: finalMeeting.startsAt, slotIndices: null };
}

/**
 * Which week (weekly events) or page (specific dates) to show first: the
 * selection; else the confirmed meeting; else, for weekly events, the current
 * week while it still has an enabled day ahead; else the best recommendation;
 * else today.
 */
export function defaultView({
  groups,
  selection = null,
  finalMeeting = null,
  recommendations = [],
  channel = null,
  now,
  timeZone,
}) {
  const kind = groupKind(groups);
  const confirmed = finalMeetingAnchor(finalMeeting, groups, timeZone);
  const candidates = [
    selection,
    confirmed,
    ...(recommendations || []).filter(
      (candidate) => !channel || candidate.channel === channel,
    ),
  ].map((candidate) =>
    candidate
      ? {
          startsAt: candidate.suggestedStartsAt || candidate.startsAt,
          slotIndices: candidate.slotIndices,
          startDayOffset: candidate.startDayOffset,
          groupKey: candidate.groupKey,
        }
      : null,
  );
  const anchor = candidates.find(Boolean) || null;
  // Local wall clock of `now` in the event timezone ("YYYY-MM-DDTHH:MM").
  const localNow = (() => {
    try {
      return formatIsoForDateTimeLocal(
        new Date(now ?? 0).toISOString(),
        timeZone,
      );
    } catch {
      return `${dateFromMs(now ?? 0)}T00:00`;
    }
  })();
  const today = localNow.slice(0, 10);

  if (kind === "weekday") {
    if (selection || confirmed) {
      const date = anchorDate(anchor, groups, timeZone) || today;
      return { weekStart: weekStartOf(date) };
    }
    // Stay on the current week while it still has an enabled day ahead (today
    // counts until its window has ended); the ranked windows repeat weekly,
    // so the nearest week is the useful one.
    const thisWeek = weekStartOf(today);
    const upcomingThisWeek = groups.some((group) => {
      if (group.kind !== "weekday") return false;
      const date = addDays(thisWeek, group.weekday);
      if (date !== today) return date > today;
      const last = group.slots[group.slots.length - 1];
      return last.endDayOffset > 0 || last.localEnd > localNow.slice(11);
    });
    if (upcomingThisWeek) return { weekStart: thisWeek };
    const date = anchorDate(anchor, groups, timeZone) || today;
    return { weekStart: weekStartOf(date) };
  }

  const dateGroups = groups.filter((group) => group.kind === "date");
  if (anchor) {
    const groupIndex = dateGroups.findIndex((group) =>
      anchor.groupKey
        ? group.key === anchor.groupKey
        : group.slots.some((slot) => slot.index === anchor.slotIndices?.[0]),
    );
    if (groupIndex >= 0)
      return { page: Math.floor(groupIndex / COLUMNS_PER_PAGE) };
  }
  const upcoming = dateGroups.findIndex((group) => group.date >= today);
  if (upcoming >= 0) return { page: Math.floor(upcoming / COLUMNS_PER_PAGE) };
  return { page: Math.max(0, pageCount(groups) - 1) };
}
