import { generateEventCode, hashPassword, verifyPassword } from "../../lib/crypto.js";

describe("generateEventCode", () => {
  test("returns string of default length 8", () => {
    expect(generateEventCode()).toHaveLength(8);
  });

  test("contains only alphanumeric characters", () => {
    expect(generateEventCode()).toMatch(/^[A-Za-z0-9]+$/);
  });

  test("respects custom length", () => {
    expect(generateEventCode(4)).toHaveLength(4);
    expect(generateEventCode(16)).toHaveLength(16);
  });

  test("generates unique codes across many calls", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateEventCode()));
    expect(codes.size).toBeGreaterThan(190);
  });
});

describe("hashPassword", () => {
  test("returns salt:hash format (32-char hex salt + 128-char hex hash)", async () => {
    const result = await hashPassword("test");
    expect(result).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
  });

  test("same input produces different outputs (random salt)", async () => {
    const h1 = await hashPassword("password");
    const h2 = await hashPassword("password");
    expect(h1).not.toBe(h2);
  });

  test("different inputs produce different hashes", async () => {
    expect(await hashPassword("foo")).not.toBe(await hashPassword("bar"));
  });

  test("is case-sensitive", async () => {
    const hash = await hashPassword("Secret");
    expect(await verifyPassword("secret", hash)).toBe(false);
  });
});

describe("verifyPassword", () => {
  test("returns true for correct password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", hash)).toBe(true);
  });

  test("returns false for wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("wrongpass", hash)).toBe(false);
  });

  test("is case-sensitive", async () => {
    const hash = await hashPassword("Password");
    expect(await verifyPassword("password", hash)).toBe(false);
  });

  test("returns false for empty string against a real hash", async () => {
    const hash = await hashPassword("nonempty");
    expect(await verifyPassword("", hash)).toBe(false);
  });

  test("returns false for empty stored hash", async () => {
    expect(await verifyPassword("anything", "")).toBe(false);
  });

  test("returns false for null stored hash", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  });

  test("returns false for undefined stored hash", async () => {
    expect(await verifyPassword("anything", undefined)).toBe(false);
  });

  test("returns false for legacy unsalted hash format", async () => {
    const legacyHash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    expect(await verifyPassword("test", legacyHash)).toBe(false);
  });
});
