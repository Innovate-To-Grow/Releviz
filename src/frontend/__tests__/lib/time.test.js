import { formatIsoForDateTimeLocal, zonedLocalDateTimeToIso } from "@/lib/time";

describe("event timezone conversion", () => {
  test("converts valid local wall times to explicit UTC instants", () => {
    expect(zonedLocalDateTimeToIso("2026-07-20T09:00", "UTC")).toBe("2026-07-20T09:00:00.000Z");
    expect(zonedLocalDateTimeToIso("2026-07-20T09:00", "America/Los_Angeles")).toBe(
      "2026-07-20T16:00:00.000Z"
    );
    expect(zonedLocalDateTimeToIso("2026-07-20T09:00", "Asia/Kathmandu")).toBe(
      "2026-07-20T03:15:00.000Z"
    );
  });

  test("rejects malformed, impossible, nonexistent, ambiguous, and invalid-zone input", () => {
    expect(() => zonedLocalDateTimeToIso("", "UTC")).toThrow("complete local");
    expect(() => zonedLocalDateTimeToIso("2026-02-30T09:00", "UTC")).toThrow("valid local");
    expect(() => zonedLocalDateTimeToIso("2026-03-08T02:30", "America/Los_Angeles")).toThrow(
      "does not exist"
    );
    expect(() => zonedLocalDateTimeToIso("2026-11-01T01:30", "America/Los_Angeles")).toThrow(
      "ambiguous"
    );
    expect(() => zonedLocalDateTimeToIso("2026-07-20T09:00", "Moon/Base")).toThrow("valid IANA");
  });

  test("formats UTC instants in the event timezone and validates input", () => {
    expect(formatIsoForDateTimeLocal("2026-07-20T16:00:00.000Z", "America/Los_Angeles")).toBe(
      "2026-07-20T09:00"
    );
    expect(() => formatIsoForDateTimeLocal("bad", "UTC")).toThrow("Invalid timestamp");
    expect(() => formatIsoForDateTimeLocal("2026-07-20T09:00:00Z", "Moon/Base")).toThrow(
      "valid IANA"
    );
  });
});
