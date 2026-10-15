import { describe, expect, it, vi } from "vitest";
import { PlaywrightBrowser } from "./playwright-browser.js";

// A stand-in for Playwright's chromium with one page that has the given elements.
function fakeChromium(
  elements: Record<string, { visible: boolean; text?: string }[]>,
  executable = process.execPath,
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
    executablePath: () => executable,
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
    const { chromium } = fakeChromium({}, "/nowhere/chrome");
    const noBrowser = new PlaywrightBrowser({ load: loader(chromium) });
    expect(await noBrowser.unavailable()).toMatch(/Chromium for Playwright is not installed/);
    const channel = new PlaywrightBrowser({
      channel: "chrome",
      load: loader(chromium),
    });
    expect(await channel.unavailable()).toBeNull();
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
