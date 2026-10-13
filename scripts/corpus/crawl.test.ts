import path from "node:path";
import { describe, expect, it } from "vitest";
import { detailUrl, indexUrl, parseOptions, unwrap } from "./crawl.js";

describe("parseOptions", () => {
  it("crawls MC3.0 in de-DE at one request per second by default", () => {
    expect(parseOptions({})).toEqual({
      corpusDir: path.join("local", "corpus"),
      device: "MC3.0",
      locale: "de-DE",
      delayMs: 1000,
    });
  });

  it("takes CORPUS_DIR, DEVICE, LOCALE and a slower DELAY_MS", () => {
    expect(
      parseOptions({ CORPUS_DIR: "c", DEVICE: "MC2.0", LOCALE: "fr-FR", DELAY_MS: "2500" }),
    ).toEqual({ corpusDir: "c", device: "MC2.0", locale: "fr-FR", delayMs: 2500 });
  });

  it("refuses to crawl faster than one request per second", () => {
    expect(() => parseOptions({ DELAY_MS: "200" })).toThrow("at least 1000");
    expect(() => parseOptions({ DELAY_MS: "fast" })).toThrow("not a number");
  });
});

describe("API helpers", () => {
  it("builds the index and detail URLs", () => {
    expect(indexUrl(3, "MC3.0")).toBe(
      "https://mc-api.tecpal.com/api/v2/recipes/page/3?filters[deviceTypes][]=MC3.0",
    );
    expect(detailUrl(42)).toBe("https://mc-api.tecpal.com/api/v2/recipes/42");
  });

  it("returns data on code 0 and throws otherwise", () => {
    expect(unwrap(200, { code: 0, message: "ok", data: { id: 1 } }, "u")).toEqual({ id: 1 });
    expect(() => unwrap(200, { code: 40004, message: "bad", data: null }, "u")).toThrow(
      "HTTP 200 code 40004 bad: u",
    );
    expect(() => unwrap(404, { code: 0, data: null }, "u")).toThrow("HTTP 404");
    expect(() => unwrap(200, "<html>", "u")).toThrow();
  });
});
