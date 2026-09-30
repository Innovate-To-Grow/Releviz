function formatHour(hour) {
  const h = Number(hour);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:00 ${period}`;
}

function formatTime(time) {
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return "Not set";
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute > 59) return "Not set";
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatMode(mode) {
  if (mode === "virtual") return "Virtual";
  if (mode === "mixed") return "Mixed";
  return "In-Person";
}

function formatDateTimeInTimezone(value, timezone, options = {}) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not set";
  const localeOptions = {
    ...(timezone ? { timeZone: timezone } : {}),
    ...options,
  };
  try {
    return date.toLocaleString([], localeOptions);
  } catch {
    return date.toLocaleString();
  }
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// Numeric parts only: bare ISO strings go through Date as UTC midnight, which
// shifts the day in negative-offset timezones.
function parseCalendarDate(value) {
  const match =
    typeof value === "string" ? ISO_CALENDAR_DATE.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return { year, month, day, index: utc.getTime() / DAY_MS };
}

function displayText(value) {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

function monthDay({ month, day }) {
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

// One group per year, so the year is written once after its last date; a run
// that crosses New Year is its own group and spells out both years.
function groupRunsByYear(runs) {
  const groups = [];
  for (const run of runs) {
    const last = groups[groups.length - 1];
    const crossesYear = run.start.year !== run.end.year;
    if (
      last &&
      !crossesYear &&
      !last.crossesYear &&
      last.year === run.start.year
    ) {
      last.runs.push(run);
    } else {
      groups.push({ year: run.start.year, crossesYear, runs: [run] });
    }
  }
  return groups;
}

function formatYearGroup({ year, crossesYear, runs }) {
  if (crossesYear) {
    const { start, end } = runs[0];
    return `${monthDay(start)}, ${start.year} – ${monthDay(end)}, ${end.year}`;
  }
  let previousMonth = null;
  const parts = runs.map(({ start, end }) => {
    if (start.month !== end.month) {
      previousMonth = null;
      return `${monthDay(start)} – ${monthDay(end)}`;
    }
    const days =
      start.day === end.day ? `${start.day}` : `${start.day}–${end.day}`;
    const text =
      start.month === previousMonth
        ? days
        : `${MONTH_NAMES[start.month - 1]} ${days}`;
    previousMonth = start.month;
    return text;
  });
  return `${parts.join(", ")}, ${year}`;
}

/**
 * Compact text for a list of "YYYY-MM-DD" calendar dates: sorted, de-duplicated,
 * consecutive days collapsed ("Oct 5–9, 12–16, 2026", "Oct 30 – Nov 2, 2026").
 * Entries that are not real calendar dates are kept as given, after the dates.
 */
function formatDateList(dates) {
  if (!Array.isArray(dates)) return "";
  const valid = [];
  const invalid = [];
  for (const entry of dates) {
    const parsed = parseCalendarDate(entry);
    if (parsed) valid.push(parsed);
    else invalid.push(displayText(entry));
  }
  valid.sort((a, b) => a.index - b.index);
  const runs = [];
  for (const date of valid) {
    const run = runs[runs.length - 1];
    if (run && date.index === run.end.index) continue;
    if (run && date.index === run.end.index + 1) run.end = date;
    else runs.push({ start: date, end: date });
  }
  return [...groupRunsByYear(runs).map(formatYearGroup), ...invalid].join(", ");
}

module.exports = {
  formatDateList,
  formatDateTimeInTimezone,
  formatHour,
  formatMode,
  formatTime,
};
