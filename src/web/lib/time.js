const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function zonedFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("Enter a valid IANA event timezone.");
  }
}

function zonedParts(instant, formatter) {
  return Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function sameLocalTime(parts, expected) {
  return (
    parts.year === expected.year &&
    parts.month === expected.month &&
    parts.day === expected.day &&
    parts.hour === expected.hour &&
    parts.minute === expected.minute
  );
}

export function zonedLocalDateTimeToIso(value, timeZone) {
  const match = LOCAL_DATE_TIME.exec(String(value || ""));
  if (!match) throw new Error("Enter a complete local date and time.");
  const expected = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const wallClockUtc = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
  );
  const normalized = new Date(wallClockUtc);
  if (
    normalized.getUTCFullYear() !== expected.year ||
    normalized.getUTCMonth() + 1 !== expected.month ||
    normalized.getUTCDate() !== expected.day ||
    normalized.getUTCHours() !== expected.hour ||
    normalized.getUTCMinutes() !== expected.minute
  ) {
    throw new Error("Enter a valid local date and time.");
  }

  const candidates = new Set();
  const formatter = zonedFormatter(timeZone);
  for (
    let offsetMinutes = -14 * 60;
    offsetMinutes <= 14 * 60;
    offsetMinutes += 15
  ) {
    const candidate = new Date(wallClockUtc - offsetMinutes * 60_000);
    if (sameLocalTime(zonedParts(candidate, formatter), expected)) {
      candidates.add(candidate.getTime());
    }
  }
  if (candidates.size === 0) {
    throw new Error(
      "That local time does not exist because of a daylight-saving change.",
    );
  }
  if (candidates.size > 1) {
    throw new Error(
      "That local time is ambiguous because of a daylight-saving change.",
    );
  }
  return new Date([...candidates][0]).toISOString();
}

export function formatIsoForDateTimeLocal(value, timeZone) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error("Invalid timestamp.");
  const parts = zonedParts(instant, zonedFormatter(timeZone));
  const pad = (number) => String(number).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(
    parts.minute,
  )}`;
}

// Offset (minutes east of UTC) of `timeZone` at a given instant.
function zoneOffsetMinutes(instant, formatter) {
  const parts = zonedParts(instant, formatter);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * Returns `resolve("YYYY-MM-DDTHH:MM") → ISO` for one timezone.
 *
 * `zonedLocalDateTimeToIso` brute-forces ±14h of candidates for every call,
 * which is far too slow for a calendar that resolves hundreds of slot
 * boundaries per week. The resolver caches the zone offset per calendar day:
 * when the offset is identical one day before and two days after, the day
 * contains no DST transition and the instant is a single subtraction
 * (verified once). Days with a transition fall back to the exhaustive search
 * so its exact "does not exist" / "ambiguous" errors still surface.
 */
export function createLocalDateTimeResolver(timeZone) {
  const formatter = zonedFormatter(timeZone);
  const offsetsByDate = new Map();

  const stableOffsetFor = (year, month, day) => {
    const key = `${year}-${month}-${day}`;
    if (offsetsByDate.has(key)) return offsetsByDate.get(key);
    const before = new Date(Date.UTC(year, month - 1, day - 1));
    const after = new Date(Date.UTC(year, month - 1, day + 2));
    const offsetBefore = zoneOffsetMinutes(before, formatter);
    const offsetAfter = zoneOffsetMinutes(after, formatter);
    const stable = offsetBefore === offsetAfter ? offsetBefore : null;
    offsetsByDate.set(key, stable);
    return stable;
  };

  return function resolve(value) {
    const match = LOCAL_DATE_TIME.exec(String(value || ""));
    if (!match) return zonedLocalDateTimeToIso(value, timeZone);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const offset = stableOffsetFor(year, month, day);
    if (offset === null) return zonedLocalDateTimeToIso(value, timeZone);
    const instant = new Date(
      Date.UTC(year, month - 1, day, hour, minute) - offset * 60_000,
    );
    if (
      !sameLocalTime(zonedParts(instant, formatter), {
        year,
        month,
        day,
        hour,
        minute,
      })
    ) {
      return zonedLocalDateTimeToIso(value, timeZone);
    }
    return instant.toISOString();
  };
}
