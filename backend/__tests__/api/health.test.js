import { jest } from "@jest/globals";
import request from "supertest";

jest.unstable_mockModule("../../lib/store/index.js", () => ({
  schedulerStore: {},
}));

const { default: app } = await import("../../server.js");

describe("GET /api/health", () => {
  test("returns status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
