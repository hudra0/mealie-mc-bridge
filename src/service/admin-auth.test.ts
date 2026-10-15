import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_HOURS,
  LoginThrottle,
  adminSessions,
  clearedSessionCookie,
  formTokenFor,
  loginTokenFor,
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
    expect(sessions.verify(value, now)).not.toBeNull();
    const almost = new Date(now.getTime() + ADMIN_SESSION_HOURS * 3_600_000 - 1000);
    expect(sessions.verify(value, almost)).not.toBeNull();
    const after = new Date(now.getTime() + ADMIN_SESSION_HOURS * 3_600_000 + 1000);
    expect(sessions.verify(value, after)).toBeNull();
  });

  it("refuses cookies signed with another key or for other credentials", () => {
    const value = adminSessions(key, credentials).issue();
    expect(adminSessions(Buffer.alloc(32, 4), credentials).verify(value)).toBeNull();
    expect(adminSessions(key, { ...credentials, password: "new" }).verify(value)).toBeNull();
    expect(adminSessions(key, { ...credentials, user: "root" }).verify(value)).toBeNull();
  });

  it("refuses malformed values", () => {
    const sessions = adminSessions(key, credentials);
    const value = sessions.issue();
    expect(sessions.verify(undefined)).toBeNull();
    expect(sessions.verify("")).toBeNull();
    expect(sessions.verify(value.replace(/^v2/, "v1"))).toBeNull();
    expect(sessions.verify(`${value}.extra`)).toBeNull();
    expect(sessions.verify(value.slice(0, -2))).toBeNull();
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

describe("logout and form tokens", () => {
  it("refuses cookies issued before the last logout", () => {
    let validAfter = 0;
    const sessions = adminSessions(key, credentials, { validAfter: () => validAfter });
    const now = new Date("2026-10-15T10:00:00.000Z");
    const before = sessions.issue(now);
    validAfter = now.getTime() + 1000;
    expect(sessions.verify(before, new Date(now.getTime() + 2000))).toBeNull();
    const after = sessions.issue(new Date(now.getTime() + 2000));
    expect(sessions.verify(after, new Date(now.getTime() + 3000))).not.toBeNull();
  });

  it("refuses a cookie issued in the future", () => {
    const sessions = adminSessions(key, credentials);
    const now = new Date("2026-10-15T10:00:00.000Z");
    const future = sessions.issue(new Date(now.getTime() + 10 * 60_000));
    expect(sessions.verify(future, now)).toBeNull();
  });

  it("derives one form token per session and a separate login token", () => {
    const secret = "s".repeat(64);
    expect(formTokenFor(secret, "a")).toMatch(/^[0-9a-f]{64}$/);
    expect(formTokenFor(secret, "a")).not.toBe(formTokenFor(secret, "b"));
    expect(formTokenFor(secret, "a")).not.toBe(formTokenFor("t".repeat(64), "a"));
    expect(loginTokenFor(secret)).not.toBe(formTokenFor(secret, "login"));
    expect(
      adminSessions(key, credentials).verify(
        adminSessions(key, credentials).issue(new Date(), "fixed"),
      ),
    ).toBe("fixed");
  });
});

describe("LoginThrottle", () => {
  it("locks an address after the limit until the oldest failure leaves the window", () => {
    let now = 0;
    const throttle = new LoginThrottle({ max: 3, windowMs: 1000, now: () => now });
    throttle.fail("a");
    now = 100;
    throttle.fail("a");
    now = 200;
    expect(throttle.blockedFor("a")).toBe(0);
    throttle.fail("a");
    expect(throttle.blockedFor("a")).toBe(800);
    expect(throttle.blockedFor("b")).toBe(0);
    now = 1001;
    expect(throttle.blockedFor("a")).toBe(0);
    throttle.fail("a");
    throttle.succeed("a");
    expect(throttle.blockedFor("a")).toBe(0);
  });
});
