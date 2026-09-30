import { formatDateList } from "@/lib/format";

describe("formatDateList", () => {
  test("collapses consecutive days into ranges and names the month once", () => {
    expect(
      formatDateList([
        "2026-10-05",
        "2026-10-06",
        "2026-10-07",
        "2026-10-08",
        "2026-10-09",
        "2026-10-12",
        "2026-10-13",
        "2026-10-14",
        "2026-10-15",
        "2026-10-16",
      ]),
    ).toBe("Oct 5–9, 12–16, 2026");
    expect(formatDateList(["2026-10-05", "2026-10-06"])).toBe("Oct 5–6, 2026");
  });

  test("writes single days, alone or between ranges", () => {
    expect(formatDateList(["2026-10-07"])).toBe("Oct 7, 2026");
    expect(formatDateList(["2026-10-05", "2026-10-07", "2026-10-20"])).toBe(
      "Oct 5, 7, 20, 2026",
    );
    expect(
      formatDateList(["2026-10-05", "2026-10-06", "2026-10-08", "2026-10-20"]),
    ).toBe("Oct 5–6, 8, 20, 2026");
  });

  test("counts weekends as consecutive days", () => {
    // Fri Oct 9 and Sat Oct 10 2026 are adjacent calendar days.
    expect(formatDateList(["2026-10-09", "2026-10-10", "2026-10-11"])).toBe(
      "Oct 9–11, 2026",
    );
  });

  test("names each month and spells out ranges that change month", () => {
    expect(formatDateList(["2026-10-05", "2026-11-02", "2026-11-03"])).toBe(
      "Oct 5, Nov 2–3, 2026",
    );
    expect(
      formatDateList(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]),
    ).toBe("Oct 30 – Nov 2, 2026");
    expect(
      formatDateList(["2026-10-30", "2026-11-01", "2026-11-04", "2026-11-05"]),
    ).toBe("Oct 30, Nov 1, 4–5, 2026");
    expect(
      formatDateList([
        "2026-10-31",
        "2026-11-01",
        "2026-11-03",
        "2026-11-04",
        "2026-12-01",
      ]),
    ).toBe("Oct 31 – Nov 1, Nov 3–4, Dec 1, 2026");
  });

  test("handles leap days", () => {
    expect(formatDateList(["2028-02-28", "2028-02-29", "2028-03-01"])).toBe(
      "Feb 28 – Mar 1, 2028",
    );
    expect(formatDateList(["2027-02-28", "2027-03-01"])).toBe(
      "Feb 28 – Mar 1, 2027",
    );
    expect(formatDateList(["2027-02-29"])).toBe("2027-02-29");
  });

  test("writes the year after the last date of each year", () => {
    expect(formatDateList(["2026-12-30", "2026-12-31", "2027-01-04"])).toBe(
      "Dec 30–31, 2026, Jan 4, 2027",
    );
    expect(formatDateList(["2026-03-02", "2026-12-04", "2027-01-04"])).toBe(
      "Mar 2, Dec 4, 2026, Jan 4, 2027",
    );
  });

  test("keeps a range across New Year whole, with both years", () => {
    expect(
      formatDateList(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]),
    ).toBe("Dec 30, 2026 – Jan 2, 2027");
    expect(
      formatDateList([
        "2026-12-08",
        "2026-12-31",
        "2027-01-01",
        "2027-01-05",
        "2027-01-06",
        "2028-06-01",
      ]),
    ).toBe(
      "Dec 8, 2026, Dec 31, 2026 – Jan 1, 2027, Jan 5–6, 2027, Jun 1, 2028",
    );
  });

  test("sorts and de-duplicates before grouping", () => {
    expect(
      formatDateList([
        "2026-10-16",
        "2026-10-06",
        "2026-10-05",
        "2026-10-06",
        "2026-10-15",
        "2026-10-05",
      ]),
    ).toBe("Oct 5–6, 15–16, 2026");
    expect(formatDateList(["2026-10-07", "2026-10-07"])).toBe("Oct 7, 2026");
  });

  test("keeps entries that are not calendar dates, as given, at the end", () => {
    expect(
      formatDateList(["soon", "2026-10-06", "2026-02-30", "2026-10-05"]),
    ).toBe("Oct 5–6, 2026, soon, 2026-02-30");
    expect(formatDateList(["2026-13-01", "2026-00-10", "2026-10-00"])).toBe(
      "2026-13-01, 2026-00-10, 2026-10-00",
    );
    expect(
      formatDateList(["2026-1-5", " 2026-10-05", "2026-10-05T00:00"]),
    ).toBe("2026-1-5,  2026-10-05, 2026-10-05T00:00");
    expect(formatDateList([null, undefined, 20261005, {}, "2026-10-05"])).toBe(
      "Oct 5, 2026, null, undefined, 20261005, [object Object]",
    );
  });

  test("never throws on entries that cannot be turned into text", () => {
    const throwing = {
      toString() {
        throw new Error("no text");
      },
    };
    expect(formatDateList([Object.create(null)])).toBe("[unprintable]");
    expect(formatDateList(["2026-10-05", throwing, Symbol("s")])).toBe(
      "Oct 5, 2026, [unprintable], Symbol(s)",
    );
  });

  test("returns an empty string when there is nothing to list", () => {
    expect(formatDateList([])).toBe("");
    expect(formatDateList()).toBe("");
    expect(formatDateList(null)).toBe("");
    expect(formatDateList("2026-10-05")).toBe("");
    expect(formatDateList({ 0: "2026-10-05", length: 1 })).toBe("");
  });

  test("does not depend on the process timezone", () => {
    const dates = [
      "2026-03-08",
      "2026-03-09",
      "2026-03-29",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ];
    const expected = "Mar 8–9, 29, Oct 31 – Nov 2, 2026";
    const original = process.env.TZ;
    try {
      for (const zone of [
        "UTC",
        "Pacific/Honolulu",
        "America/Los_Angeles",
        "Europe/London",
        "Asia/Kathmandu",
        "Pacific/Kiritimati",
      ]) {
        process.env.TZ = zone;
        expect(formatDateList(dates)).toBe(expected);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
