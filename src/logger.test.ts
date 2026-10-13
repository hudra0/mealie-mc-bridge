import { Writable } from "node:stream";
import { pino, type Logger } from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "./logger.js";

function capture(): { logger: Logger; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { logger: pino(loggerOptions("info"), stream), output: () => chunks.join("") };
}

describe("log redaction", () => {
  const cases: Record<string, unknown> = {
    "top-level api key": { apiKey: "SECRET-1" },
    "top-level password": { password: "SECRET-2" },
    "capitalised cookie header": { headers: { Cookie: "SECRET-3" } },
    "capitalised authorization header": { headers: { Authorization: "Bearer SECRET-4" } },
    "set-cookie header": { res: { headers: { "set-cookie": ["SECRET-5"] } } },
    "deeply nested cookies": { mc: { session: { cookies: "SECRET-6" } } },
    "deeply nested authorization": { config: { headers: { authorization: "Bearer SECRET-7" } } },
    "wordpress login cookie": { wordpress_logged_in_0123abcd: "SECRET-8" },
    "lidl sso token": { lidl_sso_id_token: "SECRET-9" },
    "wordpress cookie inside an array": { jar: [{ wordpress_logged_in_ff00: "SECRET-10" }] },
    "access token": { auth: { accessToken: "SECRET-11" } },
    "error with request config": {
      err: Object.assign(new Error("request failed"), {
        config: { headers: { Authorization: "Bearer SECRET-12" } },
      }),
    },
    "error under another key": {
      failure: Object.assign(new Error("request failed"), { cookie: "SECRET-13" }),
    },
  };

  it.each(Object.entries(cases))("hides the value for %s", (_name, payload) => {
    const { logger, output } = capture();
    logger.info(payload as object, "event");
    const line = output();
    expect(line).not.toMatch(/SECRET-\d+/);
    expect(line).toContain("[redacted]");
  });

  it("keeps harmless fields", () => {
    const { logger, output } = capture();
    logger.info({ recipeId: "abc", nested: { count: 2 } }, "event");
    const entry = JSON.parse(output()) as Record<string, unknown>;
    expect(entry).toMatchObject({ recipeId: "abc", nested: { count: 2 }, msg: "event" });
  });

  it("drops subtrees past the depth limit instead of logging them", () => {
    const { logger, output } = capture();
    logger.info(
      {
        a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { password: "SECRET-14" } } } } } } } } } },
      },
      "event",
    );
    const line = output();
    expect(line).not.toContain("SECRET-14");
    expect(line).toContain("[depth limit]");
  });

  it("keeps the message and stack of a logged error", () => {
    const { logger, output } = capture();
    logger.info({ err: new Error("boom") }, "event");
    const entry = JSON.parse(output()) as { err: { type: string; message: string; stack: string } };
    expect(entry.err).toMatchObject({ type: "Error", message: "boom" });
    expect(entry.err.stack).toContain("boom");
  });

  it("survives circular references", () => {
    const { logger, output } = capture();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    logger.info({ loop }, "event");
    expect(output()).toContain("[circular]");
  });
});
