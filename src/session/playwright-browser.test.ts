import { describe, expect, it, vi } from "vitest";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../testing/temp.js";
import { PROFILE_LOCKS, PlaywrightBrowser } from "./playwright-browser.js";

// A stand-in for Playwright's chromium with one page that has the given elements.
function fakeChromium(
  elements: Record<string, { visible: boolean; text?: string }[]>,
  launchError: Error | null = null,
) {
  const actions: string[] = [];
  const locator = (selector: string) => {
    const items = elements[selector] ?? [];
    const at = (index: number) => ({
      isVisible: () => Promise.resolve(items[index]?.visible ?? false),
      fill: (value: string) => {
        actions.push(`fill ${selector} ${value.length}`);
        return Promise.resolve();
      },
      press: (key: string) => {
        actions.push(`press ${selector} ${key}`);
        return Promise.resolve();
      },
      click: () => {
        actions.push(`click ${items[index]?.text ?? ""}`);
        return Promise.resolve();
      },
      innerText: () => Promise.resolve(items[index]?.text ?? ""),
    });
    return {
      count: () => Promise.resolve(items.length),
      nth: (index: number) => at(index),
      first: () => at(0),
    };
  };
  const page = {
    goto: vi.fn(() => Promise.resolve()),
    url: () => "https://accounts.lidl.com/Account/Login",
    locator,
    screenshot: vi.fn(() => Promise.resolve()),
  };
  const context = {
    pages: () => [page],
    newPage: () => Promise.resolve(page),
    cookies: vi.fn(() => Promise.resolve([{ name: "a", value: "1" }])),
    close: vi.fn(() => Promise.resolve()),
  };
  const chromium = {
    launch: vi.fn(() =>
      launchError
        ? Promise.reject(launchError)
        : Promise.resolve({ close: () => Promise.resolve() }),
    ),
    launchPersistentContext: vi.fn(() => Promise.resolve(context)),
  };
  return { chromium, actions, page, context };
}

// The fake has the shape the adapter uses, not Playwright's full types.
const loader = (chromium: unknown) => () => Promise.resolve({ chromium } as never);

describe("PlaywrightBrowser", () => {
  it("reports a missing Playwright or Chromium", async () => {
    const missing = new PlaywrightBrowser({ load: () => Promise.reject(new Error("not found")) });
    expect(await missing.unavailable()).toBe("Playwright is not installed");
    const { chromium } = fakeChromium(
      {},
      new Error("browserType.launch: Executable doesn't exist at /ms-playwright/x\nRun it"),
    );
    const noBrowser = new PlaywrightBrowser({ load: loader(chromium) });
    expect(await noBrowser.unavailable()).toBe("Chromium for Playwright is not installed");
    const broken = fakeChromium({}, new Error("\nbrowserType.launch: Target page crashed\nmore"));
    expect(await new PlaywrightBrowser({ load: loader(broken.chromium) }).unavailable()).toBe(
      "Chromium does not start: browserType.launch: Target page crashed",
    );
  });

  it("probes with a real headless launch, remembers a success and retries a failure later", async () => {
    let now = 0;
    const working = fakeChromium({});
    const browser = new PlaywrightBrowser({ load: loader(working.chromium), now: () => now });
    expect(await browser.unavailable()).toBeNull();
    expect(await browser.unavailable()).toBeNull();
    expect(working.chromium.launch).toHaveBeenCalledTimes(1);
    expect(working.chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, args: ["--disable-dev-shm-usage"] }),
    );

    const failing = fakeChromium({}, new Error("Executable doesn't exist"));
    const later = new PlaywrightBrowser({ load: loader(failing.chromium), now: () => now });
    await later.unavailable();
    now = 5 * 60_000;
    await later.unavailable();
    expect(failing.chromium.launch).toHaveBeenCalledTimes(1);
    now = 11 * 60_000;
    await later.unavailable();
    expect(failing.chromium.launch).toHaveBeenCalledTimes(2);
    const chrome = fakeChromium({});
    await new PlaywrightBrowser({ channel: "chrome", load: loader(chrome.chromium) }).unavailable();
    expect(chrome.chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "chrome" }),
    );
  });

  it("removes stale profile locks before it starts", async () => {
    const temp = tempDir();
    try {
      for (const lock of PROFILE_LOCKS) writeFileSync(join(temp.dir, lock), "stale");
      writeFileSync(join(temp.dir, "Preferences"), "{}");
      const fake = fakeChromium({});
      await new PlaywrightBrowser({ load: loader(fake.chromium) }).open({
        profileDir: temp.dir,
        headless: true,
      });
      expect(readdirSync(temp.dir)).toEqual(["Preferences"]);
    } finally {
      temp.cleanup();
    }
  });

  it("drives the page through the login actions", async () => {
    const fake = fakeChromium({
      'input[type="email"]': [{ visible: false }, { visible: true }],
      'input[type="password"]': [],
      button: [
        { visible: false, text: "Weiter" },
        { visible: true, text: "Konto erstellen" },
        { visible: true, text: "Anmelden" },
      ],
    });
    const browser = new PlaywrightBrowser({
      load: loader(fake.chromium),
    });
    expect(await browser.unavailable()).toBeNull();
    const context = await browser.open({ profileDir: "/tmp/profile", headless: true });
    expect(fake.chromium.launchPersistentContext).toHaveBeenCalledWith(
      "/tmp/profile",
      expect.objectContaining({ headless: true }),
    );
    await context.page.goto("https://www.monsieur-cuisine.com/de/sso/login");
    expect(context.page.url()).toContain("accounts.lidl.com");
    expect(await context.page.fillVisible('input[type="email"]', "cook@example.com")).toBe(true);
    expect(await context.page.fillVisible('input[type="password"]', "x")).toBe(false);
    await context.page.pressEnter('input[type="email"]');
    expect(await context.page.clickButton(/erstellen/i)).toBe(true);
    await context.page.screenshot("/tmp/shot.png");
    expect(await context.cookies("https://www.monsieur-cuisine.com/proxy-api")).toEqual([
      { name: "a", value: "1" },
    ]);
    await context.close();
    expect(fake.actions).toEqual([
      'fill input[type="email"] 16',
      'press input[type="email"] Enter',
      "click Anmelden",
    ]);
    expect(fake.context.close).toHaveBeenCalled();
  });
});
