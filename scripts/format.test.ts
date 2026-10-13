import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitFiles, parseMode } from "./format.js";

describe("parseMode", () => {
  it("accepts exactly one of --check and --write", () => {
    expect(parseMode(["--check"])).toBe("--check");
    expect(parseMode(["--write"])).toBe("--write");
    expect(() => parseMode([])).toThrow("usage");
    expect(() => parseMode(["--check", "--write"])).toThrow("usage");
  });
});

describe("gitFiles", () => {
  it("lists repository files and skips ignored ones", () => {
    const files = gitFiles(path.join(import.meta.dirname, ".."));
    expect(files).toContain("package.json");
    expect(files.some((f) => f.startsWith("node_modules/") || f.startsWith("local/"))).toBe(false);
  });
});
