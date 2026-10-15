import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_HOURS,
  adminSessions,
  clearedSessionCookie,
  parseCookieHeader,
  safeNext,
  sessionCookie,
} from "./admin-auth.js";

const key = Buffer.alloc(32, 3);
const credentials = { user: "admin", password: "correct horse" };

describe("adminSessions", () => {
  it("verifies its own cookies until they expire", () => {
    const sessions = adminSessions(key, credentials);
    const now = new Date("2026-10-15T10:00:00.000Z");
    const value = sessions.issue(now);
    expect(sessions.verify(value, now)).toBe(true);
    const almost = new Date(now.getTime() + ADMIN_SESSION_HOURS * 3_600_000 - 1000);
    expect(sessions.verify(value, almost)).toBe(true);
    const after = new Date(now.getTime() + ADMIN_SESSION_HOURS * 3_600_000 + 1000);
    expect(sessions.verify(value, after)).toBe(false);
  });

  it("refuses cookies signed with another key or for other credentials", () => {
    const value = adminSessions(key, credentials).issue();
    expect(adminSessions(Buffer.alloc(32, 4), credentials).verify(value)).toBe(false);
    expect(adminSessions(key, { ...credentials, password: "new" }).verify(value)).toBe(false);
    expect(adminSessions(key, { ...credentials, user: "root" }).verify(value)).toBe(false);
  });

  it("refuses malformed values", () => {
    const sessions = adminSessions(key, credentials);
    const value = sessions.issue();
    expect(sessions.verify(undefined)).toBe(false);
    expect(sessions.verify("")).toBe(false);
    expect(sessions.verify(value.replace(/^v1/, "v2"))).toBe(false);
    expect(sessions.verify(`${value}.extra`)).toBe(false);
    expect(sessions.verify(value.slice(0, -2))).toBe(false);
  });
});

describe("cookies", () => {
  it("parses a Cookie header and keeps the first of two equal names", () => {
    expect(parseCookieHeader("a=1; mcb_admin=v1.2.x.y; broken; a=2")).toEqual({
      a: "1",
      mcb_admin: "v1.2.x.y",
    });
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it("builds the session cookie and its removal", () => {
    expect(sessionCookie("v", false)).toBe(
      "mcb_admin=v; Path=/admin; Max-Age=43200; HttpOnly; SameSite=Lax",
    );
    expect(sessionCookie("v", true)).toMatch(/; Secure$/);
    expect(clearedSessionCookie(false)).toBe(
      "mcb_admin=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax",
    );
  });
});

describe("safeNext", () => {
  it("allows admin paths only", () => {
    expect(safeNext("/admin/jobs?status=running")).toBe("/admin/jobs?status=running");
    expect(safeNext("https://evil.example.com/admin")).toBe("/admin");
    expect(safeNext("//evil.example.com")).toBe("/admin");
    expect(safeNext("/admin\\@evil")).toBe("/admin");
    expect(safeNext("/admin/logout")).toBe("/admin");
    expect(safeNext(undefined)).toBe("/admin");
  });
});
