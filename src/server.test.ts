import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SERVER_ERROR_BODY, buildServer } from "./server.js";
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

describe("error handler", () => {
  it("answers an unexpected error with a generic body and keeps the message in the log", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = buildServer({ logger: { level: "info", stream } });
    app.get("/boom", () => {
      throw new Error("database path /data/bridge.db is locked");
    });
    const response = await app.inject({ method: "GET", url: "/boom" });
    await app.close();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(SERVER_ERROR_BODY);
    expect(response.body).not.toContain("bridge.db");
    expect(lines.join("")).toContain("bridge.db is locked");
  });

  it("keeps the answer to a malformed request", async () => {
    const app = buildServer();
    app.post("/echo", (request) => request.body);
    const response = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    await app.close();
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400, error: "Bad Request" });
  });
});
