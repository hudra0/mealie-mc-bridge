// Owns the Monsieur Cuisine session: where the cookie lives, whether it still works, and
// what happens when it stops working.
//
// The cookie is stored encrypted in the settings table. MC_COOKIE seeds it on the first
// start and whenever the variable changes; the admin page replaces it after validating it
// against the account. A periodic check calls the cheapest account endpoint; it does not
// extend the cookie's lifetime. When Monsieur Cuisine rejects the cookie, the manager records the state,
// pauses the queue and sends one notification per state change. A new valid cookie puts
// the waiting jobs back into the queue.

import { createHash } from "node:crypto";
import { errorMessage, type AppLogger } from "../app-logger.js";
import {
  McSessionError,
  normalizeCookieHeader,
  type McUser,
  type SessionErrorKind,
  type SessionProvider,
} from "../mc/index.js";
import type { Notifier } from "../notify/email.js";
import type { JobStore } from "../store/jobs.js";
import type { SettingsStore } from "../store/settings.js";

export type SessionState = "valid" | "invalid" | "expired" | "unknown";

export interface SessionStatus {
  state: SessionState;
  checkedAt: string | null;
  // When the bridge stored the cookie.
  cookieSetAt: string | null;
  // When the login behind the cookie ends, read from the wordpress_logged_in cookie.
  cookieExpiresAt: string | null;
  // When that login happened, if the expiry allows the conclusion (see cookieIssuedAt).
  cookieIssuedAt: string | null;
  // Hours since the login when it is known, else since the cookie was stored.
  cookieAgeHours: number | null;
  cookieAgeFrom: "login" | "stored" | null;
  lastError: string | null;
}

// WordPress gives a "remember me" login 14 days; the Monsieur Cuisine cookies seen so far
// all expire exactly that long after the login.
export const WORDPRESS_LOGIN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// The expiry of the wordpress_logged_in_<hash> cookie of a Cookie header. Its value is
// "user|expiry|token|hmac" (URL-encoded or not), expiry in Unix seconds. Null when the
// cookie is missing or does not have that shape.
export function wordpressLoginExpiry(cookieHeader: string | null): Date | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0 || !pair.slice(0, at).trim().startsWith("wordpress_logged_in")) continue;
    let value = pair.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value; the fields may still be readable.
    }
    const fields = value.split("|");
    const seconds =
      fields.length >= 4 && /^\d{9,11}$/.test(fields[1] ?? "") ? Number(fields[1]) : NaN;
    if (Number.isFinite(seconds)) return new Date(seconds * 1000);
  }
  return null;
}

// The login time behind a cookie: its expiry minus the WordPress login length. The cookie
// was stored after the login, so the expiry lies at most that length after the time it was
// stored. When it lies further out, the login was longer than assumed; when it lies more
// than a day closer, the login was shorter (WordPress gives 2 days without "remember me").
// Either way the login time stays unknown.
export function cookieIssuedAt(expiresAt: Date | null, storedAt: Date | null): Date | null {
  if (!expiresAt) return null;
  const issued = new Date(expiresAt.getTime() - WORDPRESS_LOGIN_DAYS * DAY_MS);
  if (storedAt) {
    const left = expiresAt.getTime() - storedAt.getTime();
    if (left > WORDPRESS_LOGIN_DAYS * DAY_MS + 60_000) return null;
    if (left < (WORDPRESS_LOGIN_DAYS - 1) * DAY_MS) return null;
  }
  return issued;
}

// The cookie is empty after normalizing.
export class InvalidCookieError extends Error {
  constructor(message = "The cookie is empty") {
    super(message);
    this.name = "InvalidCookieError";
  }
}

// Monsieur Cuisine rejected the cookie that was offered; it was not stored.
export class SessionRejectedError extends Error {
  readonly kind: SessionErrorKind;
  constructor(kind: SessionErrorKind) {
    super(
      kind === "expired"
        ? "Monsieur Cuisine says this session has expired"
        : "Monsieur Cuisine does not accept this cookie",
    );
    this.name = "SessionRejectedError";
    this.kind = kind;
  }
}

export const SESSION_KEYS = {
  cookie: "mc.cookie",
  cookieSetAt: "mc.cookie_set_at",
  seedHash: "mc.cookie_seed_hash",
  state: "mc.session_state",
  checkedAt: "mc.session_checked_at",
  lastError: "mc.session_last_error",
} as const;

export interface SessionManagerOptions {
  settings: SettingsStore;
  jobs: Pick<JobStore, "pauseQueued" | "resumePaused">;
  // Calls the account with the given cookie and resolves with the user, or throws
  // McSessionError when the cookie is rejected.
  validate: (cookie: string) => Promise<McUser>;
  notifier: Notifier;
  logger: AppLogger;
  // MC_COOKIE.
  seedCookie?: string | undefined;
  checkIntervalMs?: number;
  now?: () => Date;
}

const STATES: readonly SessionState[] = ["valid", "invalid", "expired", "unknown"];

export class SessionManager implements SessionProvider {
  readonly #settings: SettingsStore;
  readonly #jobs: Pick<JobStore, "pauseQueued" | "resumePaused">;
  readonly #validate: (cookie: string) => Promise<McUser>;
  readonly #notifier: Notifier;
  readonly #logger: AppLogger;
  readonly #checkIntervalMs: number;
  readonly #now: () => Date;
  #cookie: string | null | undefined;
  #timer: NodeJS.Timeout | null = null;
  #checking: Promise<SessionStatus> | null = null;
  #healthFailing = false;

  constructor(options: SessionManagerOptions) {
    this.#settings = options.settings;
    this.#jobs = options.jobs;
    this.#validate = options.validate;
    this.#notifier = options.notifier;
    this.#logger = options.logger;
    this.#checkIntervalMs = options.checkIntervalMs ?? 60 * 60_000;
    this.#now = options.now ?? (() => new Date());
    this.#seed(options.seedCookie);
  }

  // Runs a check now and then on the interval. The first check does not block the caller.
  start(): void {
    if (this.#timer) return;
    void this.check();
    this.#timer = setInterval(() => void this.check(), this.#checkIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  status(): SessionStatus {
    const stored = this.#settings.get(SESSION_KEYS.state);
    const state = STATES.includes(stored as SessionState) ? (stored as SessionState) : "unknown";
    const cookieSetAt = this.#settings.get(SESSION_KEYS.cookieSetAt);
    if (this.#cookie === undefined) this.#cookie = this.#readCookie();
    const expires = wordpressLoginExpiry(this.#cookie);
    const issued = cookieIssuedAt(expires, cookieSetAt === null ? null : new Date(cookieSetAt));
    const since = issued?.toISOString() ?? cookieSetAt;
    const age =
      since === null
        ? null
        : Math.max(0, (this.#now().getTime() - new Date(since).getTime()) / 3_600_000);
    return {
      state,
      checkedAt: this.#settings.get(SESSION_KEYS.checkedAt),
      cookieSetAt,
      cookieExpiresAt: expires?.toISOString() ?? null,
      cookieIssuedAt: issued?.toISOString() ?? null,
      cookieAgeHours: age === null ? null : Math.round(age * 10) / 10,
      cookieAgeFrom: age === null ? null : issued ? "login" : "stored",
      lastError: this.#settings.get(SESSION_KEYS.lastError),
    };
  }

  // The worker waits while Monsieur Cuisine rejects the session. "unknown" lets it run:
  // the first account call settles the question.
  isPaused(): boolean {
    const { state } = this.status();
    return state === "invalid" || state === "expired";
  }

  getCookie(): Promise<string | null> {
    if (this.#cookie === undefined) this.#cookie = this.#readCookie();
    return Promise.resolve(this.#cookie);
  }

  // Validates the cookie against the account and stores it only when Monsieur Cuisine
  // accepts it. Throws InvalidCookieError, SessionRejectedError, or the network error.
  async setCookie(raw: string): Promise<SessionStatus> {
    const cookie = normalizeCookieHeader(raw);
    if (cookie === null) throw new InvalidCookieError();
    try {
      await this.#validate(cookie);
    } catch (error) {
      if (error instanceof McSessionError) throw new SessionRejectedError(error.kind);
      throw error;
    }
    this.#storeCookie(cookie);
    this.#logger.info({}, "Monsieur Cuisine session replaced");
    this.#markValid();
    return this.status();
  }

  // Checks the stored cookie now. Concurrent calls share one check.
  check(): Promise<SessionStatus> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  // Called by McClient after Monsieur Cuisine rejected the cookie. `used` is the cookie the
  // rejected request sent; an error for a cookie that has since been replaced is ignored, so
  // a request still in flight with the old cookie cannot mark a freshly pasted one as dead.
  // Never throws.
  async onSessionError(kind: SessionErrorKind, used?: string | null): Promise<void> {
    try {
      if (used !== undefined && used !== (await this.getCookie())) {
        this.#logger.info({ kind }, "ignored a session error for a cookie that was replaced");
        return;
      }
      const message =
        kind === "expired"
          ? "Monsieur Cuisine reported the session as expired"
          : `Monsieur Cuisine rejected the session (${kind})`;
      await this.#markRejected(kind === "expired" ? "expired" : "invalid", message);
    } catch (error) {
      this.#logger.error({ err: errorMessage(error) }, "could not record the session error");
    }
  }

  async #check(): Promise<SessionStatus> {
    const cookie = await this.getCookie();
    if (cookie === null) {
      const reason =
        this.#settings.get(SESSION_KEYS.cookie) === null
          ? "No Monsieur Cuisine session cookie is configured"
          : "The stored cookie cannot be decrypted; SETTINGS_KEY may have changed. Paste the cookie again.";
      await this.#markRejected("invalid", reason);
      return this.status();
    }
    try {
      await this.#validate(cookie);
      this.#healthFailing = false;
      this.#markValid();
    } catch (error) {
      if (error instanceof McSessionError) {
        await this.onSessionError(error.kind, cookie);
      } else {
        // The account did not answer; the session itself may still be fine.
        const message = errorMessage(error);
        this.#settings.set(SESSION_KEYS.checkedAt, this.#now().toISOString());
        this.#settings.set(SESSION_KEYS.lastError, message);
        this.#logger.warn({ err: message }, "session check failed");
        if (!this.#healthFailing) {
          this.#healthFailing = true;
          await this.#safely(() => this.#notifier.healthFailed(message));
        }
      }
    }
    return this.status();
  }

  #markValid(): void {
    const previous = this.status().state;
    this.#settings.set(SESSION_KEYS.state, "valid");
    this.#settings.set(SESSION_KEYS.checkedAt, this.#now().toISOString());
    this.#settings.delete(SESSION_KEYS.lastError);
    const resumed = this.#jobs.resumePaused();
    if (previous !== "valid") {
      this.#logger.info({ previous, resumed }, "Monsieur Cuisine session is valid");
    }
  }

  async #markRejected(state: "invalid" | "expired", message: string): Promise<void> {
    const previous = this.status().state;
    this.#settings.set(SESSION_KEYS.state, state);
    this.#settings.set(SESSION_KEYS.checkedAt, this.#now().toISOString());
    this.#settings.set(SESSION_KEYS.lastError, message);
    const paused = this.#jobs.pauseQueued();
    if (previous === state) return;
    this.#logger.warn({ previous, state, paused }, "Monsieur Cuisine session is not usable");
    await this.#safely(() => this.#notifier.sessionExpired(this.status()));
  }

  // MC_COOKIE is stored when it is new or different from the value seeded last time, so a
  // cookie pasted in the admin page survives restarts with an unchanged environment.
  #seed(seed: string | undefined): void {
    const cookie = seed ? normalizeCookieHeader(seed) : null;
    if (cookie === null) return;
    const hash = createHash("sha256").update(cookie).digest("hex");
    if (this.#settings.get(SESSION_KEYS.seedHash) === hash) return;
    this.#storeCookie(cookie);
    this.#settings.set(SESSION_KEYS.seedHash, hash);
    this.#settings.set(SESSION_KEYS.state, "unknown");
    this.#settings.delete(SESSION_KEYS.lastError);
    this.#logger.info({}, "Monsieur Cuisine session taken from MC_COOKIE");
  }

  #storeCookie(cookie: string): void {
    this.#settings.setSecret(SESSION_KEYS.cookie, cookie);
    this.#settings.set(SESSION_KEYS.cookieSetAt, this.#now().toISOString());
    this.#cookie = cookie;
  }

  #readCookie(): string | null {
    try {
      return this.#settings.getSecret(SESSION_KEYS.cookie);
    } catch (error) {
      this.#logger.error({ err: errorMessage(error) }, "cannot read the stored session cookie");
      return null;
    }
  }

  async #safely(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.#logger.warn({ err: errorMessage(error) }, "session notification failed");
    }
  }
}
