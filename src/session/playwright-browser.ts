// LoginBrowser on Playwright's Chromium. Playwright is loaded on first use, so the bridge
// starts and works without it; the automatic login then reports the browser as missing.
//
// In the Docker image the headless Chromium lives in PLAYWRIGHT_BROWSERS_PATH. On a desktop,
// `channel: "chrome"` uses an installed Google Chrome instead of a downloaded Chromium.

import { rmSync } from "node:fs";
import { join } from "node:path";
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
  isChecked(options?: { timeout?: number }): Promise<boolean>;
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

async function firstVisible(page: PwFrame, selector: string): Promise<PwLocator | null> {
  for await (const item of visibleItems(page, selector)) return item;
  return null;
}

function visibleItems(frame: PwFrame, selector: string): AsyncGenerator<PwLocator> {
  return visibleIn(frame.locator(selector));
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
          // A disabled button waits for the click until the timeout; skip it instead.
          if (!(await button.isEnabled({ timeout }).catch(() => false))) continue;
          await button.click({ timeout });
          return text;
        }
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
            await item.click({ timeout });
            return text;
          }
        }
      }
      return null;
    },
    checkBox: async (label, avoid) => {
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
          await target.click({ timeout });
          return box === null ? true : await isTicked(box, timeout);
        }
      }
      return false;
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
