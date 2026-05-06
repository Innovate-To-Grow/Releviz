import { jest } from "@jest/globals";
import { invokeApp } from "./testUtils.js";

jest.unstable_mockModule("../../lib/store/index.js", () => ({
  schedulerStore: {},
}));

const { default: app } = await import("../../server.js");

describe("GET /api/health", () => {
  test("returns status ok", async () => {
    const res = await invokeApp(app, { url: "/api/health" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
