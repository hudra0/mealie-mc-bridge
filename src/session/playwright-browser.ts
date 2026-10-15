// LoginBrowser on Playwright's Chromium. Playwright is loaded on first use, so the bridge
// starts and works without it; the automatic login then reports the browser as missing.
//
// In the Docker image the headless Chromium lives in PLAYWRIGHT_BROWSERS_PATH. On a desktop,
// `channel: "chrome"` uses an installed Google Chrome instead of a downloaded Chromium.

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserCookie, LoginBrowser, LoginContext, LoginPage } from "./browser-login.js";

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
}

interface PwPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): PwLocator;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
}

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

export interface PlaywrightBrowserOptions {
  // "chrome" for an installed Google Chrome; the downloaded Chromium otherwise.
  channel?: string;
  // Loads Playwright; tests pass a fake.
  load?: () => Promise<{ chromium: PwChromium }>;
  // Per-action timeout in ms.
  actionTimeoutMs?: number;
  now?: () => number;
}

const ACTION_TIMEOUT_MS = 5000;
// A failed probe is repeated after this long, so a browser installed later is found.
const PROBE_RETRY_MS = 10 * 60_000;
// Docker gives /dev/shm only 64 MB, too little for Chromium's shared memory.
const LAUNCH_ARGS = ["--disable-dev-shm-usage"];
// Lock files a Chromium that was killed leaves in its profile. Logins run one at a time, so
// a lock found before a launch is always stale.
export const PROFILE_LOCKS = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

async function loadPlaywright(): Promise<{ chromium: PwChromium }> {
  // A variable module name keeps TypeScript from requiring Playwright's types at build time.
  const name = "playwright";
  return (await import(name)) as { chromium: PwChromium };
}

// The first line of a launch error, in words for the settings page.
export function launchProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|executable.*not found|playwright install/i.test(message)) {
    return "Chromium for Playwright is not installed";
  }
  const first = message.split("\n").find((line) => line.trim() !== "") ?? message;
  return `Chromium does not start: ${first.trim().slice(0, 200)}`;
}

export class PlaywrightBrowser implements LoginBrowser {
  readonly #channel: string | undefined;
  readonly #load: () => Promise<{ chromium: PwChromium }>;
  readonly #timeout: number;
  readonly #now: () => number;
  #probe: { result: string | null; at: number } | null = null;

  constructor(options: PlaywrightBrowserOptions = {}) {
    this.#channel = options.channel;
    this.#load = options.load ?? loadPlaywright;
    this.#timeout = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
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
    const { chromium } = await this.#load();
    for (const lock of PROFILE_LOCKS) {
      rmSync(join(options.profileDir, lock), { force: true });
    }
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless,
      ...(this.#channel ? { channel: this.#channel } : {}),
      args: LAUNCH_ARGS,
      viewport: options.headless ? { width: 1280, height: 900 } : null,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page: pageAdapter(page, this.#timeout),
      cookies: (url) => context.cookies(url),
      close: () => context.close(),
    };
  }
}

async function firstVisible(page: PwPage, selector: string): Promise<PwLocator | null> {
  const all = page.locator(selector);
  const count = await all.count();
  for (let index = 0; index < count; index++) {
    const item = all.nth(index);
    if (await item.isVisible()) return item;
  }
  return null;
}

function pageAdapter(page: PwPage, timeout: number): LoginPage {
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    },
    url: () => page.url(),
    fillVisible: async (selector, value) => {
      const field = await firstVisible(page, selector);
      if (!field) return false;
      await field.fill(value, { timeout });
      return true;
    },
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
