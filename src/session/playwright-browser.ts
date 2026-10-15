// LoginBrowser on Playwright's Chromium. Playwright is loaded on first use, so the bridge
// starts and works without it; the automatic login then reports the browser as missing.
//
// In the Docker image the headless Chromium lives in PLAYWRIGHT_BROWSERS_PATH. On a desktop,
// `channel: "chrome"` uses an installed Google Chrome instead of a downloaded Chromium.

import { existsSync } from "node:fs";
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
  executablePath(): string;
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
}

const ACTION_TIMEOUT_MS = 5000;

async function loadPlaywright(): Promise<{ chromium: PwChromium }> {
  // A variable module name keeps TypeScript from requiring Playwright's types at build time.
  const name = "playwright";
  return (await import(name)) as { chromium: PwChromium };
}

export class PlaywrightBrowser implements LoginBrowser {
  readonly #channel: string | undefined;
  readonly #load: () => Promise<{ chromium: PwChromium }>;
  readonly #timeout: number;

  constructor(options: PlaywrightBrowserOptions = {}) {
    this.#channel = options.channel;
    this.#load = options.load ?? loadPlaywright;
    this.#timeout = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
  }

  async unavailable(): Promise<string | null> {
    let chromium: PwChromium;
    try {
      chromium = (await this.#load()).chromium;
    } catch {
      return "Playwright is not installed";
    }
    if (this.#channel) return null;
    try {
      const path = chromium.executablePath();
      return path && existsSync(path) ? null : "Chromium for Playwright is not installed";
    } catch {
      return "Chromium for Playwright is not installed";
    }
  }

  async open(options: { profileDir: string; headless: boolean }): Promise<LoginContext> {
    const { chromium } = await this.#load();
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless,
      ...(this.#channel ? { channel: this.#channel } : {}),
      // Docker gives /dev/shm only 64 MB, too little for Chromium's shared memory.
      args: ["--disable-dev-shm-usage"],
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
