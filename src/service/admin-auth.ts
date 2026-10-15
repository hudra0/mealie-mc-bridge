// The admin login: a signed session cookie instead of HTTP Basic Auth.
//
// After a successful login the bridge sets mcb_admin=v1.<expiry>.<nonce>.<signature>, an
// HMAC-SHA256 over version, expiry and nonce. The key is derived from SETTINGS_KEY and the
// admin credentials, so a new ADMIN_PASSWORD or a new SETTINGS_KEY ends every session. The
// cookie is HttpOnly (no script reads it), SameSite=Lax (other sites cannot send it with a
// POST) and lives 12 hours; the bridge keeps no session table.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Credentials } from "./security.js";

export const ADMIN_COOKIE = "mcb_admin";
export const ADMIN_SESSION_HOURS = 12;
export const ADMIN_COOKIE_PATH = "/admin";

const VERSION = "v1";
const NONCE_BYTES = 16;

export interface AdminSessions {
  // A new cookie value that is valid until now + ADMIN_SESSION_HOURS.
  issue(now?: Date): string;
  // Whether a cookie value carries a valid signature and has not expired.
  verify(value: string | undefined, now?: Date): boolean;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function adminSessions(settingsKey: Buffer, credentials: Credentials): AdminSessions {
  const who = createHash("sha256")
    .update(`${credentials.user}\0${credentials.password}`, "utf8")
    .digest();
  const key = createHmac("sha256", settingsKey)
    .update("mc-bridge admin session\0")
    .update(who)
    .digest();
  const sign = (payload: string) => createHmac("sha256", key).update(payload, "utf8").digest();
  return {
    issue(now = new Date()) {
      const expiry = Math.floor(now.getTime() / 1000) + ADMIN_SESSION_HOURS * 3600;
      const payload = `${VERSION}.${expiry}.${base64url(randomBytes(NONCE_BYTES))}`;
      return `${payload}.${base64url(sign(payload))}`;
    },
    verify(value, now = new Date()) {
      if (!value) return false;
      const parts = value.split(".");
      if (parts.length !== 4 || parts[0] !== VERSION) return false;
      const [version, expiryText, nonce, signature] = parts as [string, string, string, string];
      if (!/^\d{1,12}$/.test(expiryText) || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return false;
      const expected = sign(`${version}.${expiryText}.${nonce}`);
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
      return Number(expiryText) * 1000 > now.getTime();
    },
  };
}

// The cookies of a Cookie request header. Values stay as sent (the session value needs no
// decoding); a malformed pair is skipped.
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

// HTTPS directly, or behind a reverse proxy that says so. The header can be forged, but
// a forged one only adds the Secure flag, which helps no attacker.
export function isHttps(request: FastifyRequest): boolean {
  if (request.protocol === "https") return true;
  const forwarded = request.headers["x-forwarded-proto"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first?.toLowerCase() === "https";
}

export function sessionCookie(value: string, secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=${value}`,
    `Path=${ADMIN_COOKIE_PATH}`,
    `Max-Age=${ADMIN_SESSION_HOURS * 3600}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=`,
    `Path=${ADMIN_COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

// Where to go after the login: a path of the admin pages, never another site.
export function safeNext(value: unknown): string {
  if (typeof value !== "string") return "/admin";
  if (!value.startsWith("/admin") || value.startsWith("//") || /[\\\r\n]/.test(value)) {
    return "/admin";
  }
  if (value.startsWith("/admin/login") || value.startsWith("/admin/logout")) return "/admin";
  return value;
}
