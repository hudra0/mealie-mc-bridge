import { Writable } from "node:stream";
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

  it("does not write request logs", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = buildServer({ logger: { level: "info", stream } });
    await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(lines.join("")).not.toContain("/health");
  });
});
