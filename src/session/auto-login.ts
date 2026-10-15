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
//   limit nor toward the backoff.
// A failed attempt keeps a screenshot of the page (the last five stay) and its reason, so
// the admin page can show what got in the way: a captcha, a second factor, a changed page.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, type AppLogger } from "../app-logger.js";
import type { SettingsStore } from "../store/settings.js";
import {
  browserLogin,
  type BrowserLoginFailure,
  type BrowserLoginOptions,
  type BrowserLoginResult,
  type LoginBrowser,
} from "./browser-login.js";

export const AUTO_LOGIN_KEYS = {
  email: "autologin.email",
  password: "autologin.password",
  last: "autologin.last_attempt",
  attempts: "autologin.attempts",
  failures: "autologin.failures",
  lastManual: "autologin.last_manual",
} as const;

const HOUR_MS = 60 * 60_000;
export const MIN_INTERVAL_MS = HOUR_MS;
export const BACKOFF_MS = [HOUR_MS, 4 * HOUR_MS, 24 * HOUR_MS] as const;
export const MAX_ATTEMPTS_PER_DAY = 3;
export const KEEP_SCREENSHOTS = 5;
export const LOGIN_TIMEOUT_MS = 120_000;
export const MANUAL_COOLDOWN_MS = 3 * 60_000;

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
}

export type SkipReason =
  "no_credentials" | "running" | "too_soon" | "backoff" | "daily_limit" | "cooldown";

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
  // DATA_DIR/browser-profile.
  profileDir: string;
  // DATA_DIR/login-screenshots.
  screenshotDir: string;
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

  // Removes the account and what it left behind: the browser profile with the Lidl
  // session (unless a login is using it right now) and the screenshots.
  deleteCredentials(): void {
    for (const key of Object.values(AUTO_LOGIN_KEYS)) this.#settings.delete(key);
    rmSync(this.#options.screenshotDir, { recursive: true, force: true });
    if (this.#running === null) {
      rmSync(this.#options.profileDir, { recursive: true, force: true });
    }
    this.#options.logger.info({}, "Lidl account for the automatic login deleted");
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

  #manualCooldown(now: Date): string | null {
    const last = Date.parse(this.#settings.get(AUTO_LOGIN_KEYS.lastManual) ?? "");
    if (!Number.isFinite(last) || now.getTime() >= last + MANUAL_COOLDOWN_MS) return null;
    return new Date(last + MANUAL_COOLDOWN_MS).toISOString();
  }

  // Why an automatic attempt may not run now, and until when.
  #gate(now: Date): { reason: SkipReason; until: string } | null {
    const attempts = this.#recentAttempts(now);
    const last = attempts[attempts.length - 1];
    if (last === undefined) return null;
    // Every limit that holds; the one that ends last decides.
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
    const latest = holds
      .filter((hold) => hold.until > now.getTime())
      .sort((x, y) => y.until - x.until)[0];
    return latest ? { reason: latest.reason, until: new Date(latest.until).toISOString() } : null;
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
    try {
      // The profile holds the Lidl session: only the bridge user may read it.
      mkdirSync(this.#options.profileDir, { recursive: true, mode: 0o700 });
      result = await (this.#options.login ?? browserLogin)({
        browser: this.#options.browser,
        profileDir: this.#options.profileDir,
        headless: true,
        editorPath: this.#options.editorPath,
        credentials: { email, password },
        timeoutMs: this.#options.timeoutMs ?? LOGIN_TIMEOUT_MS,
        screenshotPath: () => {
          mkdirSync(this.#options.screenshotDir, { recursive: true });
          screenshot = `${started.toISOString().replace(/[:.]/g, "-")}.png`;
          return join(this.#options.screenshotDir, screenshot);
        },
      });
    } catch (error) {
      result = { ok: false, code: "error", detail: errorMessage(error), screenshot: null };
    }
    if (!result.ok) {
      this.#pruneScreenshots();
      return this.#finish(started, options.manual, {
        code: result.code,
        detail: result.detail,
        screenshot: result.screenshot === null ? null : screenshot,
      });
    }
    try {
      await options.accept(result.cookie);
    } catch (error) {
      return this.#finish(started, options.manual, {
        code: "verify_failed",
        detail: `the new session was not accepted: ${errorMessage(error)}`,
        screenshot: null,
      });
    }
    return this.#finish(started, options.manual, null);
  }

  #finish(
    started: Date,
    manual: boolean,
    failure: { code: AutoLoginFailure; detail: string; screenshot: string | null } | null,
  ): AutoLoginRun {
    const attempt: LoginAttempt = {
      at: started.toISOString(),
      ok: failure === null,
      manual,
      code: failure?.code ?? null,
      detail: failure?.detail ?? null,
      screenshot: failure?.screenshot ?? null,
    };
    this.#settings.setJson(AUTO_LOGIN_KEYS.last, attempt);
    const logger = this.#options.logger;
    // Manual tests leave the backoff alone.
    if (failure === null) {
      if (!manual) this.#settings.set(AUTO_LOGIN_KEYS.failures, "0");
      logger.info({ manual }, "automatic Monsieur Cuisine login succeeded");
      return { status: "ok", attempt };
    }
    const failures = this.#failures() + (manual ? 0 : 1);
    this.#settings.set(AUTO_LOGIN_KEYS.failures, String(failures));
    logger.warn(
      { manual, code: failure.code, detail: failure.detail, failures },
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
