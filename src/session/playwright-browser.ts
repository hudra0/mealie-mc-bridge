// LoginBrowser on Playwright's Chromium. Playwright is loaded on first use, so the bridge
// starts and works without it; the automatic login then reports the browser as missing.
//
// In the Docker image the headless Chromium lives in PLAYWRIGHT_BROWSERS_PATH. On a desktop,
// `channel: "chrome"` uses an installed Google Chrome instead of a downloaded Chromium.
//
// Three rules keep the browser from leaking what the bridge knows:
// - No Playwright error message leaves this file. Playwright appends the call log of a
//   failed action to its message, and the call log of a fill() names the typed value, the
//   Lidl password included. Every failure becomes a BrowserActionError with a fixed text.
// - The browser gets a minimal environment (browserEnvironment), never the bridge's
//   secrets: Playwright would otherwise hand it process.env as it is.
// - A browser that does not close in time is killed with its process group, found by the
//   profile directory on its command line (Linux only).

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { browserFailure, type BrowserFailureKind } from "./browser-errors.js";
import type { BrowserCookie, LoginBrowser, LoginContext, LoginPage } from "./browser-login.js";
import { buttonText } from "./login-pages.js";

// The parts of Playwright the adapter uses, so the bridge compiles without its types.
interface PwLocator {
  first(): PwLocator;
  nth(index: number): PwLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  innerText(options?: { timeout?: number }): Promise<string>;
  isEnabled(options?: { timeout?: number }): Promise<boolean>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
}

// A page or one of its frames.
interface PwFrame {
  locator(selector: string): PwLocator;
}

interface PwPage extends PwFrame {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  // The main frame and every child frame; consent dialogs sometimes live in a frame.
  frames?(): PwFrame[];
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
}

// Buttons the flow reads by their text.
const BUTTONS = 'button, [role="button"]';
// Containers of a dialog, for close buttons that only carry a symbol.
const DIALOG_BUTTONS = [
  '[role="dialog"] button',
  '[role="alertdialog"] button',
  '[aria-modal="true"] button',
  "dialog button",
].join(", ");
// Elements read per selector, so a long page does not stall a poll.
const MAX_ELEMENTS = 50;

interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  cookies(urls?: string | string[]): Promise<BrowserCookie[]>;
  close(): Promise<void>;
}

interface PwChromium {
  launch(options: Record<string, unknown>): Promise<{ close(): Promise<void> }>;
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
}

const ACTION_TIMEOUT_MS = 5000;
// A failed probe is repeated after this long, so a browser installed later is found.
const PROBE_RETRY_MS = 10 * 60_000;
// Docker gives /dev/shm only 64 MB, too little for Chromium's shared memory.
const LAUNCH_ARGS = ["--disable-dev-shm-usage"];
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
  options: { platform?: NodeJS.Platform; headless?: boolean } = {},
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

// Why the browser does not start, in fixed words for the settings page. The launch error
// itself is not passed on.
export function launchProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|executable.*not found|playwright install/i.test(message)) {
    return "Chromium for Playwright is not installed";
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

export class PlaywrightBrowser implements LoginBrowser {
  readonly #channel: string | undefined;
  readonly #load: () => Promise<{ chromium: PwChromium }>;
  readonly #timeout: number;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #processes: ProcessTools;
  #probe: { result: string | null; at: number } | null = null;

  constructor(options: PlaywrightBrowserOptions = {}) {
    this.#channel = options.channel;
    this.#load = options.load ?? loadPlaywright;
    this.#timeout = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#env = options.env ?? process.env;
    this.#processes = options.processes ?? systemProcesses;
  }

  // Starts the headless browser once and closes it again. A file check would not do: the
  // image carries only the headless shell, which lives elsewhere than the full Chromium
  // that executablePath() names. A success is remembered; a failure for ten minutes.
  async unavailable(): Promise<string | null> {
    const cached = this.#probe;
    if (cached && (cached.result === null || this.#now() - cached.at < PROBE_RETRY_MS)) {
      return cached.result;
    }
    let result: string | null;
    try {
      const { chromium } = await this.#load();
      try {
        const browser = await chromium.launch({
          headless: true,
          args: LAUNCH_ARGS,
          env: browserEnvironment(this.#env, { headless: true }),
          ...(this.#channel ? { channel: this.#channel } : {}),
        });
        await browser.close();
        result = null;
      } catch (error) {
        result = launchProblem(error);
      }
    } catch {
      result = "Playwright is not installed";
    }
    this.#probe = { result, at: this.#now() };
    return result;
  }

  async open(options: { profileDir: string; headless: boolean }): Promise<LoginContext> {
    const { chromium } = await guard("launch", () => this.#load());
    const profileDir = absolute(options.profileDir);
    for (const lock of PROFILE_LOCKS) {
      rmSync(join(profileDir, lock), { force: true });
    }
    const context = await guard("launch", () =>
      chromium.launchPersistentContext(profileDir, {
        headless: options.headless,
        ...(this.#channel ? { channel: this.#channel } : {}),
        args: LAUNCH_ARGS,
        env: browserEnvironment(this.#env, { headless: options.headless }),
        viewport: options.headless ? { width: 1280, height: 900 } : null,
      }),
    );
    const page = await guard("launch", async () => context.pages()[0] ?? (await context.newPage()));
    return {
      page: guardPage(pageAdapter(page, this.#timeout)),
      cookies: (url) => guard("navigation", () => context.cookies(url)),
      close: () => guard("launch", () => context.close()),
      kill: () => {
        killBrowserProcesses(profileDir, this.#processes);
      },
    };
  }
}

async function firstVisible(page: PwFrame, selector: string): Promise<PwLocator | null> {
  for await (const item of visibleItems(page, selector)) return item;
  return null;
}

async function* visibleItems(frame: PwFrame, selector: string): AsyncGenerator<PwLocator> {
  const all = frame.locator(selector);
  const count = Math.min(await all.count().catch(() => 0), MAX_ELEMENTS);
  for (let index = 0; index < count; index++) {
    const item = all.nth(index);
    if (await item.isVisible().catch(() => false)) yield item;
  }
}

function framesOf(page: PwPage): PwFrame[] {
  return typeof page.frames === "function" ? page.frames() : [page];
}

function pageAdapter(page: PwPage, timeout: number): LoginPage {
  const textOf = async (item: PwLocator) =>
    buttonText(await item.innerText({ timeout }).catch(() => ""));
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    },
    url: () => page.url(),
    fillVisible: async (selector, value) => {
      for await (const field of visibleItems(page, selector)) {
        // A field behind a consent dialog or still loading can be disabled.
        if (!(await field.isEnabled({ timeout }).catch(() => false))) continue;
        await field.fill(value, { timeout });
        return true;
      }
      return false;
    },
    isVisible: async (selector) => (await firstVisible(page, selector)) !== null,
    clickButtonByText: async (match, avoid) => {
      for (const frame of framesOf(page)) {
        for await (const button of visibleItems(frame, BUTTONS)) {
          const text = await textOf(button);
          if (text === "" || !match.test(text) || avoid.test(text)) continue;
          await button.click({ timeout });
          return text;
        }
      }
      return null;
    },
    closeDialog: async (label, symbol) => {
      for (const frame of framesOf(page)) {
        for await (const button of visibleItems(frame, DIALOG_BUTTONS)) {
          if (symbol.test(await textOf(button))) {
            await button.click({ timeout });
            return true;
          }
        }
        for await (const button of visibleItems(frame, "button[aria-label]")) {
          const name =
            (await button.getAttribute("aria-label", { timeout }).catch(() => null)) ?? "";
          if (!label.test(name)) continue;
          await button.click({ timeout });
          return true;
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
    pressEnter: async (selector) => {
      const field = await firstVisible(page, selector);
      await field?.press("Enter", { timeout });
    },
    clickButton: async (skip) => {
      const buttons = page.locator("button");
      const count = await buttons.count();
      for (let index = 0; index < count; index++) {
        const button = buttons.nth(index);
        if (!(await button.isVisible())) continue;
        const text = (await button.innerText({ timeout }).catch(() => "")).trim();
        if (text === "" || skip.test(text)) continue;
        await button.click({ timeout });
        return true;
      }
      return false;
    },
    screenshot: async (path) => {
      await page.screenshot({ path, fullPage: true });
    },
  };
}
