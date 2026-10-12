import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { version } from "./version.js";

describe("GET /health", () => {
  it("returns status ok and the package version", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version });
    await app.close();
  });
});
