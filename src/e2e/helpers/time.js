// Date arithmetic shared by the calendar and timezone specs. Everything is
// UTC-based unless a zone is named, matching the API's weekday numbering
// (Sunday = 0).

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Sunday-based weeks, matching the API's weekday numbering (Sun = 0).
function weekStartMs(now = Date.now()) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime() - day.getUTCDay() * DAY_MS;
}

function shortDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const MONTHS = [
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

// How the event pages print a list of specific dates (YYYY-MM-DD): in
// order, consecutive days as one run ("Oct 5–9, 12–16, 2026"), a month named
// once for the runs that follow in it, a run across months spelled out
// ("Oct 30 – Nov 2, 2026"), and each year once after its last date; a run
// across New Year names both years.
function dateListText(dates) {
  const days = [...new Set(dates)].sort().map((date) => {
    const [year, month, day] = date.split("-").map(Number);
    return { year, month, day, ms: Date.UTC(year, month - 1, day) };
  });
  const runs = [];
  for (const day of days) {
    const run = runs[runs.length - 1];
    if (run && day.ms === run.end.ms + DAY_MS) run.end = day;
    else runs.push({ start: day, end: day });
  }
  const monthDay = ({ month, day }) => `${MONTHS[month - 1]} ${day}`;
  const years = [];
  let parts = [];
  let previousMonth = null;
  const closeYear = (year) => {
    if (parts.length) years.push(`${parts.join(", ")}, ${year}`);
    parts = [];
    previousMonth = null;
  };
  runs.forEach(({ start, end }, index) => {
    const before = runs[index - 1];
    if (before && before.end.year !== start.year) closeYear(before.end.year);
    if (start.year !== end.year) {
      closeYear(start.year);
      years.push(
        `${monthDay(start)}, ${start.year} – ${monthDay(end)}, ${end.year}`,
      );
    } else if (start.month !== end.month) {
      parts.push(`${monthDay(start)} – ${monthDay(end)}`);
      previousMonth = null;
    } else {
      const span =
        start.day === end.day ? `${start.day}` : `${start.day}–${end.day}`;
      parts.push(
        start.month === previousMonth
          ? span
          : `${MONTHS[start.month - 1]} ${span}`,
      );
      previousMonth = start.month;
    }
  });
  if (runs.length) closeYear(runs[runs.length - 1].end.year);
  return years.join(", ");
}

// An instant as the UTC basic format ICS files use: YYYYMMDDTHHMMSSZ.
function icsUtc(value) {
  return new Date(value)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

function zonedParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

// The wall-clock time an instant shows in a zone, as YYYY-MM-DDTHH:MM.
function zonedWallClock(value, timeZone) {
  const parts = zonedParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// The zone-local date `daysAhead` days from now with the given time, in the
// form a datetime-local input takes.
function zonedLocalDateTime(daysAhead, time, timeZone) {
  const parts = zonedParts(Date.now() + daysAhead * DAY_MS, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${time}`;
}

function nthSunday(year, monthIndex, nth) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (7 - first.getUTCDay()) % 7;
  return Date.UTC(year, monthIndex, 1 + offset + (nth - 1) * 7);
}

// The next United States daylight-saving switches strictly after today:
// the second Sunday of March and the first Sunday of November.
function nextUsDstDates(now = Date.now()) {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const next = (monthIndex, nth) => {
    const year = today.getUTCFullYear();
    const thisYear = nthSunday(year, monthIndex, nth);
    return isoDate(
      thisYear > today.getTime()
        ? thisYear
        : nthSunday(year + 1, monthIndex, nth),
    );
  };
  return { springForward: next(2, 2), fallBack: next(10, 1) };
}

module.exports = {
  DAY_MS,
  dateListText,
  icsUtc,
  isoDate,
  nextUsDstDates,
  shortDate,
  weekStartMs,
  zonedLocalDateTime,
  zonedWallClock,
};
