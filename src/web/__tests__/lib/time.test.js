import {
  createLocalDateTimeResolver,
  formatIsoForDateTimeLocal,
  zonedLocalDateTimeToIso,
} from "@/lib/time";

describe("event timezone conversion", () => {
  test("converts valid local wall times to explicit UTC instants", () => {
    expect(zonedLocalDateTimeToIso("2026-07-20T09:00", "UTC")).toBe(
      "2026-07-20T09:00:00.000Z",
    );
    expect(
      zonedLocalDateTimeToIso("2026-07-20T09:00", "America/Los_Angeles"),
    ).toBe("2026-07-20T16:00:00.000Z");
    expect(zonedLocalDateTimeToIso("2026-07-20T09:00", "Asia/Kathmandu")).toBe(
      "2026-07-20T03:15:00.000Z",
    );
  });

  test("rejects malformed, impossible, nonexistent, ambiguous, and invalid-zone input", () => {
    expect(() => zonedLocalDateTimeToIso("", "UTC")).toThrow("complete local");
    expect(() => zonedLocalDateTimeToIso("2026-02-30T09:00", "UTC")).toThrow(
      "valid local",
    );
    expect(() =>
      zonedLocalDateTimeToIso("2026-03-08T02:30", "America/Los_Angeles"),
    ).toThrow("does not exist");
    expect(() =>
      zonedLocalDateTimeToIso("2026-11-01T01:30", "America/Los_Angeles"),
    ).toThrow("ambiguous");
    expect(() =>
      zonedLocalDateTimeToIso("2026-07-20T09:00", "Moon/Base"),
    ).toThrow("valid IANA");
  });

  test("formats UTC instants in the event timezone and validates input", () => {
    expect(
      formatIsoForDateTimeLocal(
        "2026-07-20T16:00:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("2026-07-20T09:00");
    expect(() => formatIsoForDateTimeLocal("bad", "UTC")).toThrow(
      "Invalid timestamp",
    );
    expect(() =>
      formatIsoForDateTimeLocal("2026-07-20T09:00:00Z", "Moon/Base"),
    ).toThrow("valid IANA");
  });
});

describe("createLocalDateTimeResolver", () => {
  test("matches the exhaustive conversion on ordinary days", () => {
    const resolve = createLocalDateTimeResolver("America/Los_Angeles");
    for (const value of [
      "2026-09-14T09:00",
      "2026-09-14T23:45",
      "2026-09-20T00:00",
      "2026-01-05T12:30",
    ]) {
      expect(resolve(value)).toBe(
        zonedLocalDateTimeToIso(value, "America/Los_Angeles"),
      );
    }
    expect(createLocalDateTimeResolver("UTC")("2026-07-20T09:00")).toBe(
      "2026-07-20T09:00:00.000Z",
    );
    expect(
      createLocalDateTimeResolver("Asia/Kathmandu")("2026-07-20T09:00"),
    ).toBe("2026-07-20T03:15:00.000Z");
  });

  test("surfaces daylight-saving errors on transition days", () => {
    const resolve = createLocalDateTimeResolver("America/Los_Angeles");
    expect(() => resolve("2026-03-08T02:30")).toThrow("does not exist");
    expect(() => resolve("2026-11-01T01:30")).toThrow("ambiguous");
    expect(resolve("2026-03-08T03:30")).toBe(
      zonedLocalDateTimeToIso("2026-03-08T03:30", "America/Los_Angeles"),
    );
    expect(resolve("2026-11-01T03:00")).toBe(
      zonedLocalDateTimeToIso("2026-11-01T03:00", "America/Los_Angeles"),
    );
  });

  test("rejects malformed values and invalid zones like the base helper", () => {
    expect(() => createLocalDateTimeResolver("UTC")("nope")).toThrow(
      "complete local",
    );
    expect(() => createLocalDateTimeResolver("Moon/Base")).toThrow(
      "valid IANA",
    );
  });
});
