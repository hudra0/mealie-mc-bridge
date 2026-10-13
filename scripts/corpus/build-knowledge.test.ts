import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, missingInputs, parseArgs } from "./build-knowledge.js";

describe("parseArgs", () => {
  it("defaults to de-DE, CORPUS_DIR or local/corpus and writes to knowledge", () => {
    expect(parseArgs([], {})).toEqual({
      locale: "de-DE",
      corpusDir: path.join("local", "corpus"),
      outDir: "knowledge",
      check: false,
    });
    expect(parseArgs([], { CORPUS_DIR: "corpus" }).corpusDir).toBe("corpus");
    expect(parseArgs([], { CORPUS_DIR: "" }).corpusDir).toBe(path.join("local", "corpus"));
  });

  it("reads --locale, --corpus-dir, --out and --check", () => {
    expect(parseArgs(["--corpus-dir", "c", "--out", "o", "--check"], {})).toEqual({
      locale: "de-DE",
      corpusDir: "c",
      outDir: "o",
      check: true,
    });
    expect(parseArgs(["--locale", "en-US"], {})).toMatchObject({
      locale: "en-US",
      corpusDir: path.join("local", "corpus", "en-US"),
    });
    expect(() => parseArgs(["--locale", "english"], {})).toThrow("--locale must look like de-DE");
  });

  it("rejects unknown flags and flags without a value", () => {
    expect(() => parseArgs(["--force"], {})).toThrow("unknown argument");
    expect(() => parseArgs(["--out"], {})).toThrow("--out needs a value");
    expect(() => parseArgs(["--out", "--check"], {})).toThrow("--out needs a value");
  });
});

describe("main", () => {
  // Paths that do not exist; the test creates nothing.
  const corpusDir = path.join(import.meta.dirname, "no-such-corpus");
  const outDir = path.join(import.meta.dirname, "no-such-knowledge");

  it("names every missing input, exits 1 and writes nothing", async () => {
    expect(missingInputs(corpusDir)).toHaveLength(5);
    const errors: string[] = [];
    const code = await main(["--corpus-dir", corpusDir, "--out", outDir], {
      log: () => undefined,
      error: (msg) => errors.push(msg),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(path.join(corpusDir, "derived", "steps.jsonl"));
    expect(errors.join("\n")).toContain("timing.json");
    expect(errors.join("\n")).toContain(path.join(corpusDir, "derived", "recipes.jsonl"));
    expect(existsSync(outDir)).toBe(false);
  });

  it("needs only the pack inputs for another locale", () => {
    expect(missingInputs(corpusDir, "en-US")).toEqual([
      path.join(corpusDir, "derived", "steps.jsonl"),
      path.join(corpusDir, "derived", "ingredients.json"),
      `${path.join(corpusDir, "derived", "recipes.jsonl")} (or ${path.join(corpusDir, "details")})`,
    ]);
  });

  it("exits 2 on a bad argument", async () => {
    const code = await main(["--nope"], { log: () => undefined, error: () => undefined });
    expect(code).toBe(2);
  });
});
