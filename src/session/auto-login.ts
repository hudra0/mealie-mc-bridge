// The automatic login: the Lidl account e-mail and password, stored encrypted like the
// session cookie, and a headless browser that logs in with them when the session has
// expired.
//
// A login is a real sign-in on a third-party site, so it runs rarely and stops early:
// - one at a time;
// - an automatic attempt at most once per hour, and at most three in 24 hours;
// - after a failure the next automatic attempt waits 1 hour, after two in a row 4 hours,
//   after three or more 24 hours;
// - a manual "Test login now" skips the waiting times, but never runs next to another
//   attempt and at most every 3 minutes; manual attempts count neither toward the daily
//   limit nor toward the backoff;
// - when the site throttles the login ("rate_limited": capacity exceeded, too many
//   attempts), every attempt waits at least RATE_LIMIT_BACKOFF_MS, a manual test included.
//   Each attempt in that time can make the throttle last longer. Such an attempt does not
//   count as a failure for the backoff: the account is fine, the site wants a break.
// A failed attempt keeps a screenshot of the page (the last five stay) and its reason, so
// the admin page can show what got in the way: a captcha, a second factor, a changed page.
// A screenshot can show the Lidl account page with the e-mail address; deleting the account
// removes them.
//
// Every attempt runs in a fresh browser profile under DATA_DIR/tmp that is removed when the
// attempt ends, so no Lidl or Monsieur Cuisine session stays on disk outside the encrypted
// settings. The reason of a failure is stored and shown only after scrubLoginDetail: never a
// call log of the browser, never the account's own e-mail address or password.

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, type AppLogger } from "../app-logger.js";
import type { SettingsStore } from "../store/settings.js";
import { scrubLoginDetail } from "./browser-errors.js";
import {
  browserLabel,
  browserLogin,
  type BrowserLoginFailure,
  type BrowserLoginOptions,
  type BrowserLoginResult,
  type LoginBrowser,
  type LoginNotes,
  type LoginProgress,
} from "./browser-login.js";

export const AUTO_LOGIN_KEYS = {
  email: "autologin.email",
  password: "autologin.password",
  last: "autologin.last_attempt",
  attempts: "autologin.attempts",
  failures: "autologin.failures",
  lastManual: "autologin.last_manual",
  rateLimitedUntil: "autologin.rate_limited_until",
} as const;

const HOUR_MS = 60 * 60_000;
export const MIN_INTERVAL_MS = HOUR_MS;
export const BACKOFF_MS = [HOUR_MS, 4 * HOUR_MS, 24 * HOUR_MS] as const;
export const MAX_ATTEMPTS_PER_DAY = 3;
export const KEEP_SCREENSHOTS = 5;
export const LOGIN_TIMEOUT_MS = 120_000;
export const MANUAL_COOLDOWN_MS = 3 * 60_000;
// How long every attempt waits after the site throttled the login.
export const RATE_LIMIT_BACKOFF_MS = HOUR_MS;

// Why an attempt failed: a browser login failure, or the cookie it produced was refused
// when the bridge checked it against the account.
export type AutoLoginFailure = BrowserLoginFailure | "verify_failed";

export interface LoginAttempt {
  at: string;
  ok: boolean;
  manual: boolean;
  code: AutoLoginFailure | null;
  // English, for the log and the admin page; never contains the password or the cookie.
  detail: string | null;
  // File name of the screenshot under the screenshot directory.
  screenshot: string | null;
  // The login declined or closed a consent dialog on the way. Absent in older records.
  consentDismissed?: boolean;
  // The login confirmed the terms of use of monsieur-cuisine.com on the person's behalf.
  termsAccepted?: boolean;
  // The login chose MC Smart in the device chooser of the first login.
  deviceChosen?: boolean;
  // How far the login got. Absent in older records.
  progress?: LoginProgress;
}

export type SkipReason =
  | "no_credentials"
  | "running"
  | "too_soon"
  | "backoff"
  | "daily_limit"
  | "rate_limited"
  | "cooldown";

export type AutoLoginRun =
  | { status: "ok"; attempt: LoginAttempt }
  | { status: "failed"; attempt: LoginAttempt }
  | { status: "skipped"; reason: SkipReason; until?: string };

export interface AutoLoginStatus {
  configured: boolean;
  email: string | null;
  running: boolean;
  last: LoginAttempt | null;
  // When the next automatic attempt may run; null when nothing holds it back.
  nextAttemptAt: string | null;
  // When the next manual test may run; null when it may run now.
  manualAvailableAt: string | null;
  failures: number;
}

export interface AutoLoginOptions {
  settings: SettingsStore;
  browser: LoginBrowser;
  // DATA_DIR/tmp: each attempt gets a fresh profile directory below it.
  tempDir: string;
  // DATA_DIR/browser-profile, the persistent profile of 0.2.0; removed by cleanUp().
  legacyProfileDir?: string;
  // DATA_DIR/login-screenshots.
  screenshotDir: string;
  // LIDL_LOGIN_HOSTS: where the browser may fill in the account.
  loginHosts?: readonly string[];
  editorPath: string;
  logger: AppLogger;
  now?: () => Date;
  timeoutMs?: number;
  // The browser flow; tests replace it.
  login?: (options: BrowserLoginOptions) => Promise<BrowserLoginResult>;
}

export class InvalidCredentialsError extends Error {
  readonly field: "email" | "password";
  constructor(field: "email" | "password") {
    super(field === "email" ? "the e-mail address is not valid" : "the password is empty");
    this.name = "InvalidCredentialsError";
    this.field = field;
  }
}

const SCREENSHOT_NAME = /^[0-9TZ-]+\.png$/;

// Only the notes of a result, never its cookie.
function loginNotes(result: BrowserLoginResult): LoginNotes {
  return {
    ...(result.consentDismissed ? { consentDismissed: true } : {}),
    ...(result.termsAccepted ? { termsAccepted: true } : {}),
    ...(result.deviceChosen ? { deviceChosen: true } : {}),
    ...(result.progress ? { progress: result.progress } : {}),
  };
}

export class AutoLogin {
  readonly #options: AutoLoginOptions;
  readonly #now: () => Date;
  #running: Promise<AutoLoginRun> | null = null;

  constructor(options: AutoLoginOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get #settings(): SettingsStore {
    return this.#options.settings;
  }

  hasCredentials(): boolean {
    return (
      this.#settings.get(AUTO_LOGIN_KEYS.email) !== null &&
      this.#settings.get(AUTO_LOGIN_KEYS.password) !== null
    );
  }

  email(): string | null {
    try {
      return this.#settings.getSecret(AUTO_LOGIN_KEYS.email);
    } catch {
      return null;
    }
  }

  // Stores the account. An empty password keeps the stored one, so the e-mail can change
  // without typing the password again.
  saveCredentials(email: string, password: string): void {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      throw new InvalidCredentialsError("email");
    }
    if (password === "" && this.#settings.get(AUTO_LOGIN_KEYS.password) === null) {
      throw new InvalidCredentialsError("password");
    }
    this.#settings.setSecret(AUTO_LOGIN_KEYS.email, address);
    if (password !== "") this.#settings.setSecret(AUTO_LOGIN_KEYS.password, password);
    // New credentials deserve a fresh start.
    this.#settings.set(AUTO_LOGIN_KEYS.failures, "0");
    this.#options.logger.info({}, "Lidl account for the automatic login saved");
  }

  // Removes the account and what it left behind: the screenshots, a browser profile of an
  // earlier release and the temporary profiles (unless a login is using one right now).
  deleteCredentials(): void {
    for (const key of Object.values(AUTO_LOGIN_KEYS)) this.#settings.delete(key);
    removeDir(this.#options.screenshotDir);
    if (this.#running === null) this.cleanUp();
    this.#options.logger.info({}, "Lidl account for the automatic login deleted");
  }

  // Removes browser profiles left behind: the persistent profile of 0.2.0 and temporary
  // profiles of attempts a crash or a stop interrupted. Call it at start, before any login.
  cleanUp(): void {
    if (this.#options.legacyProfileDir) removeDir(this.#options.legacyProfileDir);
    removeDir(this.#options.tempDir);
  }

  status(): AutoLoginStatus {
    const configured = this.hasCredentials();
    const gate = this.#gate(this.#now());
    return {
      configured,
      email: configured ? this.email() : null,
      running: this.#running !== null,
      last: this.#settings.getJson<LoginAttempt>(AUTO_LOGIN_KEYS.last),
      nextAttemptAt: configured && gate !== null ? gate.until : null,
      manualAvailableAt: this.#manualCooldown(this.#now()),
      failures: this.#failures(),
    };
  }

  // Runs one login unless something holds it back. `accept` checks and stores the cookie
  // (SessionManager.setCookie) and throws when the account refuses it.
  run(options: {
    manual: boolean;
    accept: (cookie: string) => Promise<void>;
  }): Promise<AutoLoginRun> {
    if (this.#running) return Promise.resolve({ status: "skipped", reason: "running" });
    if (!this.hasCredentials())
      return Promise.resolve({ status: "skipped", reason: "no_credentials" });
    if (options.manual) {
      const until = this.#manualCooldown(this.#now());
      if (until) return Promise.resolve({ status: "skipped", reason: "cooldown", until });
    } else {
      const gate = this.#gate(this.#now());
      if (gate) return Promise.resolve({ status: "skipped", ...gate });
    }
    this.#running = this.#attempt(options).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  // Null when the browser can start, otherwise why not.
  browserUnavailable(): Promise<string | null> {
    return this.#options.browser.unavailable();
  }

  // The path of a stored screenshot by its file name, or null for anything else.
  screenshotFile(name: string): string | null {
    if (!SCREENSHOT_NAME.test(name)) return null;
    return this.#screenshots().includes(name) ? join(this.#options.screenshotDir, name) : null;
  }

  // When the next manual test may run: 3 minutes after the last one, or when the throttle
  // of the site ends, whichever is later. Null when it may run now.
  #manualCooldown(now: Date): string | null {
    const last = Date.parse(this.#settings.get(AUTO_LOGIN_KEYS.lastManual) ?? "");
    const until = Math.max(
      Number.isFinite(last) ? last + MANUAL_COOLDOWN_MS : 0,
      this.#rateLimitedUntil(),
    );
    return now.getTime() < until ? new Date(until).toISOString() : null;
  }

  // When the throttle of the site ends, in ms; 0 when there is none.
  #rateLimitedUntil(): number {
    const until = Date.parse(this.#settings.get(AUTO_LOGIN_KEYS.rateLimitedUntil) ?? "");
    return Number.isFinite(until) ? until : 0;
  }

  // Why an automatic attempt may not run now, and until when.
  #gate(now: Date): { reason: SkipReason; until: string } | null {
    // Every limit that holds; the one that ends last decides.
    const holds: { reason: SkipReason; until: number }[] = [
      { reason: "rate_limited", until: this.#rateLimitedUntil() },
    ];
    const attempts = this.#recentAttempts(now);
    const last = attempts[attempts.length - 1];
    if (last !== undefined) holds.push(...this.#attemptHolds(attempts, last));
    const latest = holds
      .filter((hold) => hold.until > now.getTime())
      .sort((x, y) => y.until - x.until)[0];
    return latest ? { reason: latest.reason, until: new Date(latest.until).toISOString() } : null;
  }

  // The limits that follow from the recent automatic attempts.
  #attemptHolds(attempts: number[], last: number): { reason: SkipReason; until: number }[] {
    const holds: { reason: SkipReason; until: number }[] = [];
    if (attempts.length >= MAX_ATTEMPTS_PER_DAY) {
      const oldest = attempts[attempts.length - MAX_ATTEMPTS_PER_DAY] ?? last;
      holds.push({ reason: "daily_limit", until: oldest + 24 * HOUR_MS });
    }
    const failures = this.#failures();
    if (failures > 0) {
      const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? HOUR_MS;
      holds.push({ reason: "backoff", until: last + wait });
    }
    holds.push({ reason: "too_soon", until: last + MIN_INTERVAL_MS });
    return holds;
  }

  async #attempt(options: {
    manual: boolean;
    accept: (cookie: string) => Promise<void>;
  }): Promise<AutoLoginRun> {
    const started = this.#now();
    if (options.manual) this.#settings.set(AUTO_LOGIN_KEYS.lastManual, started.toISOString());
    else this.#recordStart(started);
    const logger = this.#options.logger;
    logger.info({ manual: options.manual }, "automatic Monsieur Cuisine login started");
    let result: BrowserLoginResult;
    let password: string | null;
    let email: string | null;
    try {
      email = this.#settings.getSecret(AUTO_LOGIN_KEYS.email);
      password = this.#settings.getSecret(AUTO_LOGIN_KEYS.password);
    } catch (error) {
      return this.#finish(started, options.manual, {
        code: "error",
        detail: `the stored account cannot be decrypted: ${errorMessage(error)}`,
        screenshot: null,
      });
    }
    if (email === null || password === null) {
      return this.#finish(started, options.manual, {
        code: "error",
        detail: "no account stored",
        screenshot: null,
      });
    }
    let screenshot: string | null = null;
    let profile: string | null = null;
    try {
      // A fresh profile per attempt, readable by the bridge user only (mkdtemp: 0700).
      mkdirSync(this.#options.tempDir, { recursive: true, mode: 0o700 });
      profile = mkdtempSync(join(this.#options.tempDir, "login-"));
      result = await (this.#options.login ?? browserLogin)({
        browser: this.#options.browser,
        profileDir: profile,
        headless: true,
        editorPath: this.#options.editorPath,
        credentials: { email, password },
        ...(this.#options.loginHosts ? { loginHosts: this.#options.loginHosts } : {}),
        timeoutMs: this.#options.timeoutMs ?? LOGIN_TIMEOUT_MS,
        screenshotPath: () => {
          mkdirSync(this.#options.screenshotDir, { recursive: true, mode: 0o700 });
          screenshot = `${started.toISOString().replace(/[:.]/g, "-")}.png`;
          return join(this.#options.screenshotDir, screenshot);
        },
      });
    } catch (error) {
      result = { ok: false, code: "error", detail: errorMessage(error), screenshot: null };
    } finally {
      // The profile holds the Lidl and Monsieur Cuisine session of this attempt.
      if (profile !== null) removeDir(profile);
    }
    const notes = loginNotes(result);
    if (!result.ok) {
      this.#pruneScreenshots();
      return this.#finish(
        started,
        options.manual,
        {
          code: result.code,
          detail: scrubLoginDetail(result.detail, [email, password]),
          screenshot: result.screenshot === null ? null : screenshot,
        },
        notes,
      );
    }
    try {
      await options.accept(result.cookie);
    } catch (error) {
      return this.#finish(
        started,
        options.manual,
        {
          code: "verify_failed",
          detail: `the new session was not accepted: ${errorMessage(error)}`,
          screenshot: null,
        },
        notes,
      );
    }
    return this.#finish(started, options.manual, null, notes);
  }

  #finish(
    started: Date,
    manual: boolean,
    failure: { code: AutoLoginFailure; detail: string; screenshot: string | null } | null,
    notes: LoginNotes = {},
  ): AutoLoginRun {
    const attempt: LoginAttempt = {
      at: started.toISOString(),
      ok: failure === null,
      manual,
      code: failure?.code ?? null,
      detail: failure ? scrubLoginDetail(failure.detail) : null,
      screenshot: failure?.screenshot ?? null,
      ...notes,
    };
    this.#settings.setJson(AUTO_LOGIN_KEYS.last, attempt);
    const logger = this.#options.logger;
    const browser = notes.progress?.browser ? browserLabel(notes.progress.browser) : undefined;
    // Manual tests leave the backoff alone.
    if (failure === null) {
      if (!manual) this.#settings.set(AUTO_LOGIN_KEYS.failures, "0");
      this.#settings.delete(AUTO_LOGIN_KEYS.rateLimitedUntil);
      logger.info({ manual, browser }, "automatic Monsieur Cuisine login succeeded");
      return { status: "ok", attempt };
    }
    // A throttled login holds every attempt for a while, but is no failure of the account.
    const throttled = failure.code === "rate_limited";
    if (throttled) {
      const until = new Date(this.#now().getTime() + RATE_LIMIT_BACKOFF_MS).toISOString();
      this.#settings.set(AUTO_LOGIN_KEYS.rateLimitedUntil, until);
    }
    const failures = this.#failures() + (manual || throttled ? 0 : 1);
    this.#settings.set(AUTO_LOGIN_KEYS.failures, String(failures));
    logger.warn(
      {
        manual,
        code: failure.code,
        detail: attempt.detail,
        failures,
        ...notes,
        ...(notes.progress ? { progress: notes.progress.reached } : {}),
        ...(browser ? { browser } : {}),
      },
      "automatic Monsieur Cuisine login failed",
    );
    return { status: "failed", attempt };
  }

  #failures(): number {
    const value = Number(this.#settings.get(AUTO_LOGIN_KEYS.failures) ?? "0");
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  // Start times (ms) of the attempts in the last 24 hours, oldest first.
  #recentAttempts(now: Date): number[] {
    const stored = this.#settings.getJson<unknown>(AUTO_LOGIN_KEYS.attempts);
    const list = Array.isArray(stored) ? stored : [];
    const since = now.getTime() - 24 * HOUR_MS;
    return list
      .map((value) => (typeof value === "string" ? Date.parse(value) : NaN))
      .filter((time) => Number.isFinite(time) && time > since)
      .sort((a, b) => a - b);
  }

  #recordStart(started: Date): void {
    const recent = this.#recentAttempts(started).map((time) => new Date(time).toISOString());
    this.#settings.setJson(AUTO_LOGIN_KEYS.attempts, [...recent, started.toISOString()]);
  }

  #screenshots(): string[] {
    try {
      return readdirSync(this.#options.screenshotDir)
        .filter((name) => SCREENSHOT_NAME.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  #pruneScreenshots(): void {
    const names = this.#screenshots();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_SCREENSHOTS))) {
      rmSync(join(this.#options.screenshotDir, name), { force: true });
    }
  }
}

// Removes a directory and everything in it. A browser that was killed a moment ago can
// still hold a file, so it tries a few times and gives up quietly.
function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Removed at the next start (cleanUp).
  }
}
