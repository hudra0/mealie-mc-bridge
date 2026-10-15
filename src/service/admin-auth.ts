// The admin login: a signed session cookie instead of HTTP Basic Auth.
//
// After a successful login the bridge sets mcb_admin=v2.<issued>.<nonce>.<signature>, an
// HMAC-SHA256 over version, issue time (ms) and a random nonce. The key is derived from
// SETTINGS_KEY and the admin credentials, so a new ADMIN_PASSWORD or a new SETTINGS_KEY ends
// every session. The cookie is HttpOnly (no script reads it), SameSite=Lax (other sites
// cannot send it with a POST) and lives 12 hours. Logging out stores the time in the
// settings table; cookies issued before it are refused, so a copied cookie dies with the
// logout. Forms carry a token derived from the session's nonce; the login form, which has no
// session yet, carries its own token.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Credentials } from "./security.js";

export const ADMIN_COOKIE = "mcb_admin";
export const ADMIN_SESSION_HOURS = 12;
export const ADMIN_COOKIE_PATH = "/admin";
// The settings entry with the time (ms) of the last logout.
export const SESSIONS_VALID_AFTER_KEY = "admin.sessions_valid_after";

const VERSION = "v2";
const NONCE_BYTES = 16;
const SESSION_MS = ADMIN_SESSION_HOURS * 3_600_000;
// Clocks of the processes that issue and check agree; a minute of slack is plenty.
const FUTURE_SLACK_MS = 60_000;

export interface AdminSessions {
  // A new cookie value that is valid until now + ADMIN_SESSION_HOURS.
  issue(now?: Date, nonce?: string): string;
  // The nonce of a cookie value with a valid signature that has not expired and was issued
  // after the last logout; null otherwise.
  verify(value: string | undefined, now?: Date): string | null;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function adminSessions(
  settingsKey: Buffer,
  credentials: Credentials,
  options: { validAfter?: () => number } = {},
): AdminSessions {
  const who = createHash("sha256")
    .update(`${credentials.user}\0${credentials.password}`, "utf8")
    .digest();
  const key = createHmac("sha256", settingsKey)
    .update("mc-bridge admin session\0")
    .update(who)
    .digest();
  const sign = (payload: string) => createHmac("sha256", key).update(payload, "utf8").digest();
  return {
    issue(now = new Date(), nonce = base64url(randomBytes(NONCE_BYTES))) {
      const payload = `${VERSION}.${now.getTime()}.${nonce}`;
      return `${payload}.${base64url(sign(payload))}`;
    },
    verify(value, now = new Date()) {
      if (!value) return null;
      const parts = value.split(".");
      if (parts.length !== 4 || parts[0] !== VERSION) return null;
      const [version, issuedText, nonce, signature] = parts as [string, string, string, string];
      if (!/^\d{1,15}$/.test(issuedText) || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return null;
      const expected = sign(`${version}.${issuedText}.${nonce}`);
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      const issued = Number(issuedText);
      if (issued + SESSION_MS <= now.getTime()) return null;
      if (issued > now.getTime() + FUTURE_SLACK_MS) return null;
      if (issued <= (options.validAfter?.() ?? 0)) return null;
      return nonce;
    },
  };
}

// The form token of a login session: an HMAC of its nonce under the process's secret, so a
// token is worth nothing without the cookie it belongs to.
export function formTokenFor(secret: string, nonce: string): string {
  return createHmac("sha256", secret).update(`form\0${nonce}`, "utf8").digest("hex");
}

// The token of the login form, which no session protects yet.
export function loginTokenFor(secret: string): string {
  return createHmac("sha256", secret).update("login", "utf8").digest("hex");
}

// Counts failed logins per client address. After `max` failures within `windowMs` the
// address is refused until the oldest of them is older than the window.
export class LoginThrottle {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #failures = new Map<string, number[]>();

  constructor(options: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.#max = options.max ?? 5;
    this.#windowMs = options.windowMs ?? 15 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  #recent(address: string): number[] {
    const since = this.#now() - this.#windowMs;
    const list = (this.#failures.get(address) ?? []).filter((time) => time > since);
    if (list.length === 0) this.#failures.delete(address);
    else this.#failures.set(address, list);
    return list;
  }

  // Milliseconds until the address may try again, or 0.
  blockedFor(address: string): number {
    const list = this.#recent(address);
    if (list.length < this.#max) return 0;
    const oldest = list[list.length - this.#max] ?? this.#now();
    return Math.max(0, oldest + this.#windowMs - this.#now());
  }

  fail(address: string): void {
    this.#failures.set(address, [...this.#recent(address), this.#now()]);
  }

  succeed(address: string): void {
    this.#failures.delete(address);
  }
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

// HTTPS directly, or behind a reverse proxy listed in TRUST_PROXY: Fastify takes the
// protocol from X-Forwarded-Proto only when the request comes from a trusted proxy.
export function isHttps(request: FastifyRequest): boolean {
  return request.protocol === "https";
}

// Strict-Transport-Security for a request that arrived over HTTPS: browsers then refuse
// plain HTTP to this host for a year.
export const HSTS_VALUE = "max-age=31536000";

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
