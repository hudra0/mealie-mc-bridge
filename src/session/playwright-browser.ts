// LoginBrowser on Playwright's Chromium. Playwright is loaded on first use, so the bridge
// starts and works without it; the automatic login then reports the browser as missing.
//
// In the Docker image the headless Chromium lives in PLAYWRIGHT_BROWSERS_PATH. On a desktop,
// `channel: "chrome"` uses an installed Google Chrome instead of a downloaded Chromium.
//
// Three rules keep the browser from leaking what the bridge knows:
// - No Playwright error message leaves this file. Playwright appends the call log of a
//   failed action to its message, and the call log of a fill() or pressSequentially() names
//   the typed value, the Lidl password included. Every failure becomes a BrowserActionError with a fixed text.
// - The browser gets a minimal environment (browserEnvironment), never the bridge's
//   secrets: Playwright would otherwise hand it process.env as it is.
// - A browser that does not close in time is killed with its process group, found by the
//   profile directory on its command line (Linux only).
//
// The login page runs reCAPTCHA Enterprise and Akamai Bot Manager, which score how much a
// browser looks like a person's. The adapter keeps the plain signs of automation away,
// without any stealth package:
// - Headless runs in Chromium's new headless mode, the full browser without a window
//   (Playwright: channel "chromium"), not in the separate headless shell. When only the
//   shell is installed, the adapter falls back to it and says so in the diagnostics.
// - The user agent is the browser's own, with "HeadlessChrome" replaced by "Chrome"; the
//   probe reads it from a blank page once.
// - --disable-blink-features=AutomationControlled, so navigator.webdriver is false.
// - A common viewport (1280x800 at scale 1), the locale and time zone of the bridge, and an
//   Accept-Language header that matches the locale.
// - The e-mail address and the password are typed one character at a time, 40 to 120 ms
//   apart, instead of being set at once.
// Playwright passes --no-sandbox by default (chromiumSandbox: false); the container needs
// it, because it runs without the capabilities Chromium's sandbox wants.
//
// The full Chromium starts its crash handler with a database under XDG_CONFIG_HOME (or
// ~/.config), and quits when that directory cannot be created. In the container the home
// directory is a tmpfs owned by root, so the browser gets XDG_CONFIG_HOME and XDG_CACHE_HOME
// inside the profile of the attempt, or inside a temporary directory for the probe.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { browserFailure, type BrowserFailureKind } from "./browser-errors.js";
import {
  sanitizeUserAgent,
  type BrowserCookie,
  type BrowserInfo,
  type LoginBrowser,
  type LoginContext,
  type LoginPage,
} from "./browser-login.js";
import { DIALOG_SELECTOR, buttonText, type DialogPatterns } from "./login-pages.js";

// The parts of Playwright the adapter uses, so the bridge compiles without its types.
interface PwLocator {
  first(): PwLocator;
  nth(index: number): PwLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially(text: string, options?: { timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  innerText(options?: { timeout?: number }): Promise<string>;
  isEnabled(options?: { timeout?: number }): Promise<boolean>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
  isChecked(options?: { timeout?: number }): Promise<boolean>;
  locator(selector: string): PwLocator;
  // The element the locator points at now, to follow it after the locator moves on.
  elementHandle?(options?: { timeout?: number }): Promise<PwHandle | null>;
}

interface PwHandle {
  // "hidden" resolves once the element is not visible or not attached any more.
  waitForElementState(state: "hidden", options?: { timeout?: number }): Promise<void>;
  dispose(): Promise<void>;
}

// What elements can be looked up in: a page, a frame or an element.
interface PwScope {
  locator(selector: string): PwLocator;
}

// A page or one of its frames.
interface PwFrame {
  locator(selector: string): PwLocator;
  getByText?(text: RegExp): PwLocator;
}

interface PwPage extends PwFrame {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  // The main frame and every child frame; consent dialogs sometimes live in a frame.
  frames?(): PwFrame[];
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate?<T>(fn: () => T): Promise<T>;
}

// Buttons the flow reads by their text.
const BUTTONS = 'button, [role="button"]';
// Links and other controls a click on a text may target, beyond buttons.
const CONTROLS = [
  BUTTONS,
  "a",
  '[role="link"]',
  '[role="radio"]',
  '[role="option"]',
  '[role="tab"]',
  "label",
].join(", ");
// Labels and custom checkboxes, for the terms checkbox.
const CHECKBOX_LABELS = 'label, [role="checkbox"]';
// Elements read per selector, so a long page does not stall a poll.
const MAX_ELEMENTS = 50;

interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  cookies(urls?: string | string[]): Promise<BrowserCookie[]>;
  close(): Promise<void>;
}

interface PwBrowser {
  close(): Promise<void>;
  newPage?(): Promise<PwPage>;
}

interface PwChromium {
  launch(options: Record<string, unknown>): Promise<PwBrowser>;
  launchPersistentContext(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<PwContext>;
}

// What killing a hung browser needs from the system; tests pass fakes.
export interface ProcessTools {
  platform: NodeJS.Platform;
  // The process ids of the running processes.
  pids(): string[];
  // The command line of a process, its arguments separated by NUL; null when it is gone.
  cmdline(pid: string): string | null;
  kill(pid: number, signal: NodeJS.Signals): void;
}

export interface PlaywrightBrowserOptions {
  // "chrome" for an installed Google Chrome; the downloaded Chromium otherwise.
  channel?: string;
  // Loads Playwright; tests pass a fake.
  load?: () => Promise<{ chromium: PwChromium }>;
  // Per-action timeout in ms.
  actionTimeoutMs?: number;
  now?: () => number;
  // The environment the browser's environment is taken from; process.env by default.
  env?: NodeJS.ProcessEnv;
  processes?: ProcessTools;
  // The locale the pages see ("de-DE"): navigator.language and Accept-Language.
  locale?: string | undefined;
  // The time zone the pages see ("Europe/Berlin"); an unknown one is left out.
  timezoneId?: string | undefined;
  // The waits between typed characters; tests pass fakes.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const ACTION_TIMEOUT_MS = 5000;
// A failed probe is repeated after this long, so a browser installed later is found.
const PROBE_RETRY_MS = 10 * 60_000;
// Docker gives /dev/shm only 64 MB, too little for Chromium's shared memory. Blink's
// AutomationControlled feature sets navigator.webdriver, the plainest sign of automation.
export const LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
] as const;
// Playwright's channel for the full Chromium in its new headless mode.
export const NEW_HEADLESS_CHANNEL = "chromium";
// The window of a headless browser: a common laptop size.
export const VIEWPORT = { width: 1280, height: 800 } as const;
// The wait between two typed characters, between these bounds.
export const TYPING_DELAY_MS = { min: 40, max: 120 } as const;

// The user agent the browser sends: its own, without the "Headless" that marks it.
export function presentedUserAgent(userAgent: string): string {
  return userAgent.replace(/HeadlessChrome/g, "Chrome");
}

// The Accept-Language header a browser set to the locale sends: "de-DE,de;q=0.9".
export function acceptLanguageHeader(locale: string): string {
  const language = locale.split("-")[0] ?? locale;
  return language === locale ? locale : `${locale},${language};q=0.9`;
}

// The time zone when Chromium knows it, else undefined; Playwright refuses to start with an
// unknown one. TZ values like ":/etc/localtime" are left out.
export function knownTimeZone(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined || timeZone === "" || timeZone.startsWith(":")) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

// The locale when it looks like one ("de-DE", "de"), else undefined.
function knownLocale(locale: string | undefined): string | undefined {
  return locale !== undefined && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)
    ? locale
    : undefined;
}

// How the browser runs without a window: Chromium's new headless mode, or the old headless
// shell when only that is installed.
type HeadlessMode = "new" | "shell";
// Lock files a Chromium that was killed leaves in its profile. Logins run one at a time, so
// a lock found before a launch is always stale.
export const PROFILE_LOCKS = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

// The variables the browser gets. Everything else in the bridge's environment (the API
// keys, SETTINGS_KEY, the Mealie token, SMTP_URL, MC_COOKIE) stays out of it.
export const BROWSER_ENV = ["PATH", "HOME", "LANG", "PLAYWRIGHT_BROWSERS_PATH"] as const;
// A visible window on a desktop (npm run mc:login) needs the display.
const DISPLAY_ENV = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"] as const;
// Windows cannot start a browser without its system folders.
const WINDOWS_ENV = [
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
] as const;

export function browserEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; headless?: boolean; configDir?: string } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const names: string[] = [...BROWSER_ENV];
  if (options.headless === false) names.push(...DISPLAY_ENV);
  if (platform === "win32") names.push(...WINDOWS_ENV);
  const result: Record<string, string> = {};
  // Windows spells variable names in any case.
  const lookup = new Map(Object.keys(env).map((key) => [key.toUpperCase(), key]));
  for (const name of names) {
    const key = platform === "win32" ? lookup.get(name.toUpperCase()) : name;
    const value = key === undefined ? undefined : env[key];
    if (value !== undefined && value !== "") result[key ?? name] = value;
  }
  // A writable place for the browser's configuration and cache, whatever HOME allows.
  if (options.configDir !== undefined) {
    result.XDG_CONFIG_HOME = join(options.configDir, "config");
    result.XDG_CACHE_HOME = join(options.configDir, "cache");
  }
  return result;
}

// Playwright passes the profile directory to Chromium as an absolute path.
const absolute = (dir: string): string => (isAbsolute(dir) ? dir : resolve(dir));

const systemProcesses: ProcessTools = {
  platform: process.platform,
  pids: () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)),
  cmdline: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return null;
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
};

// Kills the browser that runs with this profile directory, and its process group:
// Playwright starts Chromium as the leader of a group of its own, so the renderers go with
// it. Returns how many browsers were found. Only Linux has /proc; elsewhere it does nothing.
export function killBrowserProcesses(
  profileDir: string,
  tools: ProcessTools = systemProcesses,
): number {
  if (tools.platform !== "linux") return 0;
  const flag = `--user-data-dir=${absolute(profileDir)}`;
  let found = 0;
  let pids: string[];
  try {
    pids = tools.pids();
  } catch {
    return 0;
  }
  for (const pid of pids) {
    const args = tools.cmdline(pid)?.split("\0") ?? [];
    if (!args.includes(flag)) continue;
    found++;
    const id = Number(pid);
    try {
      tools.kill(-id, "SIGKILL");
    } catch {
      try {
        tools.kill(id, "SIGKILL");
      } catch {
        // Gone in the meantime.
      }
    }
  }
  return found;
}

async function loadPlaywright(): Promise<{ chromium: PwChromium }> {
  // A variable module name keeps TypeScript from requiring Playwright's types at build time.
  const name = "playwright";
  return (await import(name)) as { chromium: PwChromium };
}

// The failure of launchProblem when the browser's files are missing.
const NOT_INSTALLED = "Chromium for Playwright is not installed";

// Why the browser does not start, in fixed words for the settings page. The launch error
// itself is not passed on.
export function launchProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|executable.*not found|playwright install/i.test(message)) {
    return NOT_INSTALLED;
  }
  if (/shared librar|missing dependencies|install-deps/i.test(message)) {
    return "Chromium does not start: system libraries are missing (npx playwright install-deps chromium)";
  }
  return "Chromium does not start";
}

// Runs a browser call and replaces any error with a fixed one of the given class.
async function guard<T>(kind: BrowserFailureKind, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw browserFailure(error, kind);
  }
}

// Every asynchronous method of the page with its errors replaced: navigation errors for
// goto, element errors for the rest. url() is synchronous and does not throw.
export function guardPage(page: LoginPage): LoginPage {
  const guarded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(page) as Array<[string, unknown]>) {
    if (typeof value !== "function" || name === "url") {
      guarded[name] = value;
      continue;
    }
    const method = value as (...args: unknown[]) => Promise<unknown>;
    const kind: BrowserFailureKind = name === "goto" ? "navigation" : "selector";
    guarded[name] = (...args: unknown[]) => guard(kind, () => method(...args));
  }
  return guarded as unknown as LoginPage;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// The user agent of a blank page of the browser; null when it cannot be read.
async function readUserAgent(page: PwPage | null | undefined): Promise<string | null> {
  try {
    const agent = await page?.evaluate?.(
      () => (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "",
    );
    return typeof agent === "string" && agent !== "" ? agent : null;
  } catch {
    return null;
  }
}

export class PlaywrightBrowser implements LoginBrowser {
  readonly #channel: string | undefined;
  readonly #load: () => Promise<{ chromium: PwChromium }>;
  readonly #timeout: number;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #processes: ProcessTools;
  readonly #locale: string | undefined;
  readonly #timezoneId: string | undefined;
  readonly #typing: Typing;
  #probe: { result: string | null; at: number } | null = null;
  // What the probe found: how headless runs and the browser's own user agent.
  #mode: HeadlessMode = "new";
  #userAgent: string | null = null;

  constructor(options: PlaywrightBrowserOptions = {}) {
    this.#channel = options.channel;
    this.#load = options.load ?? loadPlaywright;
    this.#timeout = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#env = options.env ?? process.env;
    this.#processes = options.processes ?? systemProcesses;
    this.#locale = knownLocale(options.locale);
    this.#timezoneId = knownTimeZone(options.timezoneId);
    this.#typing = { sleep: options.sleep ?? defaultSleep, random: options.random ?? Math.random };
  }

  // Starts the headless browser once, reads its user agent from a blank page and closes it
  // again. A file check would not do: the full Chromium and the headless shell live in
  // different places. A success is remembered; a failure for ten minutes.
  async unavailable(): Promise<string | null> {
    const cached = this.#probe;
    if (cached && (cached.result === null || this.#now() - cached.at < PROBE_RETRY_MS)) {
      return cached.result;
    }
    let result: string | null;
    try {
      const { chromium } = await this.#load();
      result = await this.#probeLaunch(chromium);
    } catch {
      result = "Playwright is not installed";
    }
    this.#probe = { result, at: this.#now() };
    return result;
  }

  // Tries the new headless mode, then, when the full Chromium is missing, the headless shell.
  // An installed Google Chrome (a channel) has no shell to fall back to.
  async #probeLaunch(chromium: PwChromium): Promise<string | null> {
    const modes: HeadlessMode[] = this.#channel ? ["new"] : ["new", "shell"];
    let problem = NOT_INSTALLED;
    const configDir = mkdtempSync(join(tmpdir(), "bridge-chromium-"));
    try {
      for (const mode of modes) {
        let browser: PwBrowser;
        try {
          browser = await chromium.launch(this.#launchOptions(true, mode, configDir));
        } catch (error) {
          problem = launchProblem(error);
          if (problem !== NOT_INSTALLED) return problem;
          continue;
        }
        try {
          this.#userAgent = await readUserAgent(await browser.newPage?.().catch(() => null));
        } finally {
          await browser.close().catch(() => undefined);
        }
        this.#mode = mode;
        return null;
      }
      return problem;
    } finally {
      rmSync(configDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  // What every launch gets: the mode, the arguments, the environment without secrets.
  #launchOptions(
    headless: boolean,
    mode: HeadlessMode,
    configDir: string,
  ): Record<string, unknown> {
    let channel = this.#channel;
    if (channel === undefined && headless && mode === "new") channel = NEW_HEADLESS_CHANNEL;
    return {
      headless,
      ...(channel ? { channel } : {}),
      args: [...LAUNCH_ARGS],
      env: browserEnvironment(this.#env, { headless, configDir }),
      // Playwright's default, stated: --no-sandbox, which the container needs.
      chromiumSandbox: false,
    };
  }

  // What the pages see: the window, the user agent without "Headless", locale and time zone.
  // A visible window keeps its own size and user agent.
  #contextOptions(headless: boolean): Record<string, unknown> {
    const userAgent =
      headless && this.#userAgent !== null ? presentedUserAgent(this.#userAgent) : null;
    const locale = this.#locale;
    return {
      viewport: headless ? VIEWPORT : null,
      ...(headless ? { deviceScaleFactor: 1 } : {}),
      ...(userAgent !== null ? { userAgent } : {}),
      ...(locale
        ? { locale, extraHTTPHeaders: { "Accept-Language": acceptLanguageHeader(locale) } }
        : {}),
      ...(this.#timezoneId ? { timezoneId: this.#timezoneId } : {}),
    };
  }

  async open(options: { profileDir: string; headless: boolean }): Promise<LoginContext> {
    const { chromium } = await guard("launch", () => this.#load());
    // The user agent comes from the probe; the flow runs it first, a direct call here.
    if (options.headless && this.#probe === null) await this.unavailable();
    const profileDir = absolute(options.profileDir);
    for (const lock of PROFILE_LOCKS) {
      rmSync(join(profileDir, lock), { force: true });
    }
    const mode = this.#mode;
    const context = await guard("launch", () =>
      chromium.launchPersistentContext(profileDir, {
        // The configuration directory lives and goes with the profile.
        ...this.#launchOptions(options.headless, mode, join(profileDir, "xdg")),
        ...this.#contextOptions(options.headless),
      }),
    );
    const page = await guard("launch", async () => context.pages()[0] ?? (await context.newPage()));
    const userAgent = await readUserAgent(page);
    const browser: BrowserInfo = {
      userAgent: userAgent === null ? null : sanitizeUserAgent(userAgent),
      headless: options.headless ? mode : false,
    };
    return {
      page: guardPage(pageAdapter(page, this.#timeout, this.#typing)),
      cookies: (url) => guard("navigation", () => context.cookies(url)),
      close: () => guard("launch", () => context.close()),
      kill: () => {
        killBrowserProcesses(profileDir, this.#processes);
      },
      browser,
    };
  }
}

async function firstVisible(page: PwFrame, selector: string): Promise<PwLocator | null> {
  for await (const item of visibleItems(page, selector)) return item;
  return null;
}

function visibleItems(scope: PwScope, selector: string): AsyncGenerator<PwLocator> {
  return visibleIn(scope.locator(selector));
}

async function* visibleIn(all: PwLocator): AsyncGenerator<PwLocator> {
  const count = Math.min(await all.count().catch(() => 0), MAX_ELEMENTS);
  for (let index = 0; index < count; index++) {
    const item = all.nth(index);
    if (await item.isVisible().catch(() => false)) yield item;
  }
}

// The checkbox a label or custom checkbox stands for: itself, an input inside the label, or
// the input its for attribute names. Null when there is none.
async function checkboxOf(frame: PwFrame, item: PwLocator, timeout: number) {
  if ((await item.getAttribute("role", { timeout }).catch(() => null)) === "checkbox") return item;
  const inside = item.locator('input[type="checkbox"]');
  if ((await inside.count().catch(() => 0)) > 0) return inside.first();
  const id = await item.getAttribute("for", { timeout }).catch(() => null);
  if (id) {
    const named = frame.locator(`[id="${id.replace(/["\\]/g, "\\$&")}"]`);
    if ((await named.count().catch(() => 0)) > 0) return named.first();
  }
  return null;
}

async function isTicked(box: PwLocator, timeout: number): Promise<boolean> {
  if ((await box.getAttribute("role", { timeout }).catch(() => null)) === "checkbox") {
    return (await box.getAttribute("aria-checked", { timeout }).catch(() => null)) === "true";
  }
  return box.isChecked({ timeout }).catch(() => false);
}

function framesOf(page: PwPage): PwFrame[] {
  return typeof page.frames === "function" ? page.frames() : [page];
}

interface Candidate {
  item: PwLocator;
  text: string;
  exact: boolean;
}

// The waits between typed characters.
interface Typing {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

function pageAdapter(page: PwPage, timeout: number, typing: Typing): LoginPage {
  const textOf = async (item: PwLocator) =>
    buttonText(await item.innerText({ timeout }).catch(() => ""));
  // The first visible and enabled button in the scope whose text matches `match` and not
  // `avoid`; one whose text also matches `exact` comes first.
  const findButton = async (
    scope: PwScope,
    match: RegExp,
    avoid: RegExp,
    exact?: RegExp,
  ): Promise<Candidate | null> => {
    let fallback: Candidate | null = null;
    for await (const item of visibleItems(scope, BUTTONS)) {
      const text = await textOf(item);
      if (text === "" || !match.test(text) || avoid.test(text)) continue;
      // A disabled button waits for the click until the timeout; skip it instead.
      if (!(await item.isEnabled({ timeout }).catch(() => false))) continue;
      const candidate = { item, text, exact: exact === undefined || exact.test(text) };
      if (candidate.exact) return candidate;
      fallback ??= candidate;
    }
    return fallback;
  };
  // Clicks a control of a dialog and waits until the dialog is hidden or gone.
  const clickAndWait = async (dialog: PwLocator, control: PwLocator, waitMs: number) => {
    const handle = (await dialog.elementHandle?.({ timeout }).catch(() => null)) ?? null;
    await control.click({ timeout });
    if (handle === null) return;
    await handle.waitForElementState("hidden", { timeout: waitMs }).catch(() => undefined);
    await handle.dispose().catch(() => undefined);
  };
  // The close control of a dialog: a button whose accessible name closes, or whose text is a
  // close symbol; never one whose text accepts.
  const findClose = async (dialog: PwLocator, patterns: DialogPatterns) => {
    for await (const control of visibleItems(dialog, BUTTONS)) {
      const text = await textOf(control);
      if (patterns.accept.test(text)) continue;
      const label = (await control.getAttribute("aria-label", { timeout }).catch(() => null)) ?? "";
      if (patterns.closeLabel.test(label) || patterns.closeSymbol.test(text)) return control;
    }
    return null;
  };
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    },
    url: () => page.url(),
    fillVisible: async (selector, value, options = {}) => {
      for await (const field of visibleItems(page, selector)) {
        // A field behind a consent dialog or still loading can be disabled.
        if (!(await field.isEnabled({ timeout }).catch(() => false))) continue;
        const actionTimeout = options.timeoutMs ?? timeout;
        // Emptied first, so a second try after a timeout does not type the value twice.
        await field.fill("", { timeout: actionTimeout });
        for (const character of value) {
          await field.pressSequentially(character, { timeout: actionTimeout });
          const { min, max } = TYPING_DELAY_MS;
          await typing.sleep(Math.round(min + typing.random() * (max - min)));
        }
        return true;
      }
      return false;
    },
    isVisible: async (selector) => (await firstVisible(page, selector)) !== null,
    clickButtonByText: async (match, avoid, options = {}) => {
      let fallback: Candidate | null = null;
      for (const frame of framesOf(page)) {
        const found = await findButton(frame, match, avoid, options.exact);
        if (found?.exact) {
          fallback = found;
          break;
        }
        fallback ??= found;
      }
      if (fallback === null) return null;
      await fallback.item.click({ timeout: options.timeoutMs ?? timeout });
      return fallback.text;
    },
    dismissDialog: async (patterns, options) => {
      const [main, ...children] = framesOf(page);
      if (main === undefined) return null;
      // Inside a visible dialog of the page: its decline button, the exact phrase first.
      for await (const dialog of visibleItems(main, DIALOG_SELECTOR)) {
        const found = await findButton(
          dialog,
          patterns.decline,
          patterns.accept,
          patterns.declineExact,
        );
        if (found === null) continue;
        await clickAndWait(dialog, found.item, options.waitMs);
        return "declined";
      }
      // A consent page in a frame of its own: its decline button anywhere in the frame.
      for (const frame of children) {
        const found = await findButton(
          frame,
          patterns.decline,
          patterns.accept,
          patterns.declineExact,
        );
        if (found === null) continue;
        await found.item.click({ timeout });
        return "declined";
      }
      if (!options.close) return null;
      for await (const dialog of visibleItems(main, DIALOG_SELECTOR)) {
        const control = await findClose(dialog, patterns);
        if (control === null) continue;
        await clickAndWait(dialog, control, options.waitMs);
        return "closed";
      }
      return null;
    },
    clickByText: async (match, avoid, options = {}) => {
      const selectors = options.anyElement ? [CONTROLS, null] : [CONTROLS];
      for (const selector of selectors) {
        for (const frame of framesOf(page)) {
          // Any element: Playwright's text search, which also finds cards and spans.
          const all = selector === null ? frame.getByText?.(match) : frame.locator(selector);
          if (all === undefined) continue;
          for await (const item of visibleIn(all)) {
            const text = await textOf(item);
            if (text === "" || !match.test(text) || avoid.test(text)) continue;
            if (!(await item.isEnabled({ timeout }).catch(() => false))) continue;
            await item.click({ timeout: options.timeoutMs ?? timeout });
            return text;
          }
        }
      }
      return null;
    },
    checkBox: async (label, avoid, options = {}) => {
      for (const frame of framesOf(page)) {
        for await (const item of visibleItems(frame, CHECKBOX_LABELS)) {
          const name =
            (await textOf(item)) ||
            ((await item.getAttribute("aria-label", { timeout }).catch(() => null)) ?? "");
          if (!label.test(name) || avoid.test(name)) continue;
          const box = await checkboxOf(frame, item, timeout);
          if (box !== null && (await isTicked(box, timeout))) return true;
          // The box itself when it shows, so a link inside the label is not hit.
          const target = box !== null && (await box.isVisible().catch(() => false)) ? box : item;
          await target.click({ timeout: options.timeoutMs ?? timeout });
          return box === null ? true : await isTicked(box, timeout);
        }
      }
      return false;
    },
    visibleMessage: async (selector, maxLength) => {
      for await (const item of visibleItems(page, selector)) {
        const text = await textOf(item);
        if (text !== "" && text.length <= maxLength) return text;
      }
      return null;
    },
    frameSources: async () => {
      const sources: string[] = [];
      for await (const frame of visibleItems(page, "iframe")) {
        const src = await frame.getAttribute("src", { timeout }).catch(() => null);
        if (src) sources.push(src);
      }
      return sources;
    },
    text: async () =>
      page
        .locator("body")
        .first()
        .innerText({ timeout })
        .catch(() => ""),
    pressEnter: async (selector, options = {}) => {
      const field = await firstVisible(page, selector);
      await field?.press("Enter", { timeout: options.timeoutMs ?? timeout });
    },
    clickButton: async (skip, options = {}) => {
      const buttons = page.locator("button");
      const count = await buttons.count();
      for (let index = 0; index < count; index++) {
        const button = buttons.nth(index);
        if (!(await button.isVisible())) continue;
        const text = (await button.innerText({ timeout }).catch(() => "")).trim();
        if (text === "" || skip.test(text)) continue;
        await button.click({ timeout: options.timeoutMs ?? timeout });
        return true;
      }
      return false;
    },
    screenshot: async (path) => {
      await page.screenshot({ path, fullPage: true });
    },
  };
}
