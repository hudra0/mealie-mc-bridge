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

  it("survives circular references", () => {
    const { logger, output } = capture();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    logger.info({ loop }, "event");
    expect(output()).toContain("[circular]");
  });
});
