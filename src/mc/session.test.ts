import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSessionProvider, StaticSessionProvider, normalizeCookieHeader } from "./session.js";

describe("normalizeCookieHeader", () => {
  it.each([
    ["a=1; b=2", "a=1; b=2"],
    ["Cookie: a=1; b=2", "a=1; b=2"],
    ["cookie:a=1;b=2;", "a=1; b=2"],
    ["  a=1 ;; b=2  \n", "a=1; b=2"],
    ["# session for testing\na=1\r\nb=2\n", "a=1; b=2"],
    ["", null],
    ["# only a comment\n\n", null],
  ])("%j -> %j", (raw, expected) => {
    expect(normalizeCookieHeader(raw)).toBe(expected);
  });
});

describe("StaticSessionProvider", () => {
  it("returns the normalized cookie", async () => {
    await expect(new StaticSessionProvider("Cookie: a=1;b=2").getCookie()).resolves.toBe(
      "a=1; b=2",
    );
  });

  it("returns null for an empty or missing value", async () => {
    await expect(new StaticSessionProvider("").getCookie()).resolves.toBeNull();
    await expect(new StaticSessionProvider(undefined).getCookie()).resolves.toBeNull();
    await expect(new StaticSessionProvider(null).getCookie()).resolves.toBeNull();
  });

  it("records session errors and tells the listener", async () => {
    const listener = vi.fn();
    const provider = new StaticSessionProvider("a=1", listener);
    expect(provider.lastError).toBeNull();
    await provider.onSessionError("expired");
    expect(provider.lastError).toBe("expired");
    expect(listener).toHaveBeenCalledWith("expired");
  });

  it("swallows a failing listener", async () => {
    const provider = new StaticSessionProvider("a=1", () => Promise.reject(new Error("mail down")));
    await expect(provider.onSessionError("invalid")).resolves.toBeUndefined();
    expect(provider.lastError).toBe("invalid");
  });

  it("does not show the cookie when inspected or serialized", () => {
    const provider = new StaticSessionProvider("secret=value-123");
    expect(inspect(provider)).not.toContain("value-123");
    expect(JSON.stringify(provider)).not.toContain("value-123");
  });
});

describe("FileSessionProvider", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-session-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the cookie from the file on every call", async () => {
    const file = join(dir, "session.cookie.txt");
    await writeFile(file, "Cookie: a=1; b=2\n");
    const provider = new FileSessionProvider(file);
    await expect(provider.getCookie()).resolves.toBe("a=1; b=2");
    await writeFile(file, "a=3\n");
    await expect(provider.getCookie()).resolves.toBe("a=3");
  });

  it("returns null when the file is missing or empty", async () => {
    await expect(new FileSessionProvider(join(dir, "missing.txt")).getCookie()).resolves.toBeNull();
    const empty = join(dir, "empty.txt");
    await writeFile(empty, "\n");
    await expect(new FileSessionProvider(empty).getCookie()).resolves.toBeNull();
  });

  it("reports other read errors without the path", async () => {
    await expect(new FileSessionProvider(dir).getCookie()).rejects.toThrow(
      /^Cannot read the session cookie file: E[A-Z]+$/,
    );
  });

  it("records session errors and tells the listener", async () => {
    const listener = vi.fn();
    const provider = new FileSessionProvider(join(dir, "x"), listener);
    await provider.onSessionError("unauthorized");
    expect(provider.lastError).toBe("unauthorized");
    expect(listener).toHaveBeenCalledWith("unauthorized");
    expect(new FileSessionProvider(join(dir, "y")).lastError).toBeNull();
  });
});
