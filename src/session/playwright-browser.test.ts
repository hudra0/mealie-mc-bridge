import { describe, expect, it, vi } from "vitest";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../testing/temp.js";
import { BrowserActionError } from "./browser-errors.js";
import {
  PROFILE_LOCKS,
  PlaywrightBrowser,
  browserEnvironment,
  killBrowserProcesses,
  type ProcessTools,
} from "./playwright-browser.js";

// A stand-in for Playwright's chromium with one page that has the given elements.
interface FakeElement {
  visible: boolean;
  text?: string;
  enabled?: boolean;
  attributes?: Record<string, string>;
  checked?: boolean;
  // Elements inside this one, by selector.
  children?: Record<string, FakeElement[]>;
  onClick?: () => void;
}

// Elements Playwright's getByText finds, under this key.
const TEXT_KEY = "getByText";

function fakeChromium(
  elements: Record<string, FakeElement[]>,
  launchError: Error | null = null,
  frames: Record<string, FakeElement[]>[] = [],
  fillError: Error | null = null,
) {
  const actions: string[] = [];
  const listOf = (items: FakeElement[], selector = "") => {
    const at = (index: number): Record<string, unknown> => ({
      isVisible: () => Promise.resolve(items[index]?.visible ?? false),
      fill: (value: string) => {
        if (fillError) return Promise.reject(fillError);
        actions.push(`fill ${selector} ${value.length}`);
        return Promise.resolve();
      },
      press: (key: string) => {
        actions.push(`press ${selector} ${key}`);
        return Promise.resolve();
      },
      click: () => {
        actions.push(`click ${items[index]?.text ?? ""}`);
        items[index]?.onClick?.();
        return Promise.resolve();
      },
      isChecked: () => Promise.resolve(items[index]?.checked ?? false),
      locator: (inner: string) => listOf(items[index]?.children?.[inner] ?? []),
      innerText: () => Promise.resolve(items[index]?.text ?? ""),
      isEnabled: () => Promise.resolve(items[index]?.enabled ?? true),
      getAttribute: (name: string) => Promise.resolve(items[index]?.attributes?.[name] ?? null),
    });
    return {
      count: () => Promise.resolve(items.length),
      nth: (index: number) => at(index),
      first: () => at(0),
    };
  };
  const locatorIn = (source: Record<string, FakeElement[]>) => (selector: string) =>
    listOf(source[selector] ?? [], selector);
  const locator = locatorIn(elements);
  const getByText = (match: RegExp) =>
    listOf((elements[TEXT_KEY] ?? []).filter((item) => match.test(item.text ?? "")));
  const page = {
    goto: vi.fn(() => Promise.resolve()),
    url: () => "https://accounts.lidl.com/Account/Login",
    locator,
    frames: () => [
      { locator, getByText },
      ...frames.map((frame) => ({ locator: locatorIn(frame) })),
    ],
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
      "Chromium does not start",
    );
    const libraries = fakeChromium(
      {},
      new Error("browserType.launch: error while loading shared libraries: libnss3.so"),
    );
    expect(await new PlaywrightBrowser({ load: loader(libraries.chromium) }).unavailable()).toBe(
      "Chromium does not start: system libraries are missing (npx playwright install-deps chromium)",
    );
  });

  it("starts the browser without the bridge's secrets in its environment", async () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/bridge",
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      OPENAI_API_KEY: "sk-test-not-real",
      SETTINGS_KEY: "settings-key-for-tests",
      MEALIE_API_TOKEN: "mealie-token",
      SMTP_URL: "smtps://user:pass@mail.example.com",
      MC_COOKIE: "PHPSESSID=x",
      ADMIN_PASSWORD: "admin-password",
    };
    const fake = fakeChromium({});
    const browser = new PlaywrightBrowser({ load: loader(fake.chromium), env });
    await browser.unavailable();
    await browser.open({ profileDir: "/tmp/profile", headless: true });
    const expected = {
      PATH: "/usr/bin",
      HOME: "/home/bridge",
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    };
    if (process.platform !== "win32") {
      expect(fake.chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ env: expected }));
      expect(fake.chromium.launchPersistentContext).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ env: expected }),
      );
    }
    expect(browserEnvironment(env, { platform: "linux" })).toEqual(expected);
    expect(
      browserEnvironment({ ...env, DISPLAY: ":0" }, { platform: "linux", headless: false }),
    ).toEqual({ ...expected, DISPLAY: ":0" });
    expect(
      browserEnvironment(
        { Path: "C:/Windows", SystemRoot: "C:/Windows", OPENAI_API_KEY: "x" },
        { platform: "win32" },
      ),
    ).toEqual({ Path: "C:/Windows", SystemRoot: "C:/Windows" });
  });

  it("replaces Playwright's error messages with fixed ones", async () => {
    const marker = "MARKER-PASSWORD-55";
    const leak = Object.assign(
      new Error(`locator.fill: Timeout 5000ms exceeded.\nCall log:\n  - fill("${marker}")`),
      { name: "TimeoutError" },
    );
    const fake = fakeChromium({ 'input[type="password"]': [{ visible: true }] }, null, [], leak);
    const context = await new PlaywrightBrowser({ load: loader(fake.chromium) }).open({
      profileDir: "/tmp/profile",
      headless: true,
    });
    const error = await context.page
      .fillVisible('input[type="password"]', marker)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserActionError);
    expect((error as Error).message).toBe("the browser timed out on the login page");
    expect(JSON.stringify(error)).not.toContain(marker);
    expect(String((error as Error).stack)).not.toContain(marker);

    fake.page.goto.mockImplementationOnce(() => Promise.reject(new Error(`net::ERR ${marker}`)));
    await expect(context.page.goto("https://www.monsieur-cuisine.com/")).rejects.toThrow(
      /^the login page did not load$/,
    );
    const failing = fakeChromium({});
    failing.chromium.launchPersistentContext.mockImplementationOnce(() =>
      Promise.reject(new Error(`launch failed ${marker}`)),
    );
    await expect(
      new PlaywrightBrowser({ load: loader(failing.chromium) }).open({
        profileDir: "/tmp/profile",
        headless: true,
      }),
    ).rejects.toThrow(/^the browser did not start$/);
  });

  it("kills a hung browser by its profile directory, with its process group", () => {
    const killed: Array<[number, string]> = [];
    const tools = (platform: NodeJS.Platform, refuseGroup = false): ProcessTools => ({
      platform,
      pids: () => ["1", "40", "41", "77"],
      cmdline: (pid) =>
        ({
          "1": "/sbin/tini\0--\0node\0dist/main.js",
          "40": `/ms-playwright/chrome\0--headless\0--user-data-dir=/data/tmp/login-a\0about:blank`,
          "41": "/ms-playwright/chrome\0--user-data-dir=/data/tmp/login-b",
          "77": null,
        })[pid] ?? null,
      kill: (pid, signal) => {
        if (refuseGroup && pid < 0) throw new Error("ESRCH");
        killed.push([pid, signal]);
      },
    });
    expect(killBrowserProcesses("/data/tmp/login-a", tools("linux"))).toBe(1);
    expect(killed).toEqual([[-40, "SIGKILL"]]);
    killed.length = 0;
    expect(killBrowserProcesses("/data/tmp/login-a", tools("linux", true))).toBe(1);
    expect(killed).toEqual([[40, "SIGKILL"]]);
    killed.length = 0;
    expect(killBrowserProcesses("/data/tmp/login-a", tools("win32"))).toBe(0);
    expect(killed).toEqual([]);
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
      'input[type="email"]': [
        { visible: false },
        { visible: true, enabled: false },
        { visible: true },
      ],
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
    expect(await context.page.isVisible('input[type="email"]')).toBe(true);
    expect(await context.page.isVisible('input[type="password"]')).toBe(false);
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

  it("finds consent buttons in frames, close buttons, messages and captcha frames", async () => {
    const fake = fakeChromium(
      {
        'button, [role="button"]': [
          { visible: true, text: " Zustimmen " },
          { visible: false, text: "Ablehnen" },
        ],
        '[role="dialog"] button, [role="alertdialog"] button, [aria-modal="true"] button, dialog button':
          [
            { visible: true, text: "Mehr" },
            { visible: true, text: "×" },
          ],
        "button[aria-label]": [
          { visible: true, text: "", attributes: { "aria-label": "Menü" } },
          { visible: true, text: "", attributes: { "aria-label": "Dialog schließen" } },
        ],
        '[role="alert"]': [
          { visible: true, text: "" },
          { visible: true, text: "x".repeat(400) },
          { visible: true, text: "  Passwort\n falsch " },
        ],
        iframe: [
          { visible: false, attributes: { src: "https://example.com/hidden" } },
          { visible: true, attributes: { src: "https://example.com/captcha" } },
          { visible: true },
        ],
        body: [{ visible: true, text: "Anmelden" }],
      },
      null,
      [{ 'button, [role="button"]': [{ visible: true, text: "Alle ablehnen" }] }],
    );
    const browser = new PlaywrightBrowser({ load: loader(fake.chromium) });
    const { page } = await browser.open({ profileDir: "/tmp/profile", headless: true });
    expect(await page.clickButtonByText(/^(ablehnen|alle ablehnen)/i, /zustimmen/i)).toBe(
      "Alle ablehnen",
    );
    expect(await page.clickButtonByText(/^weiter/i, /zustimmen/i)).toBeNull();
    expect(await page.closeDialog(/schließen/i, /^×$/)).toBe(true);
    expect(await page.closeDialog(/schließen/i, /^✕$/)).toBe(true);
    expect(await page.closeDialog(/close/i, /^✕$/)).toBe(false);
    expect(await page.visibleMessage('[role="alert"]', 300)).toBe("Passwort falsch");
    expect(await page.visibleMessage(".none", 300)).toBeNull();
    expect(await page.frameSources()).toEqual(["https://example.com/captcha"]);
    expect(await page.text()).toBe("Anmelden");
    expect(fake.actions).toEqual(["click Alle ablehnen", "click ×", "click "]);
  });
  it("clicks links and cards by their text and skips disabled buttons", async () => {
    const controls =
      'button, [role="button"], a, [role="link"], [role="radio"], [role="option"], [role="tab"], label';
    const fake = fakeChromium({
      'button, [role="button"]': [
        { visible: true, text: "Jetzt loslegen", enabled: false },
        { visible: true, text: "Weiter" },
      ],
      [controls]: [
        { visible: true, text: "Land +43" },
        { visible: true, text: "Verwende stattdessen deine E-Mail-Adresse" },
      ],
      [TEXT_KEY]: [
        { visible: true, text: "MC COMPACT" },
        { visible: false, text: "MC SMART" },
        { visible: true, text: "MC SMART" },
      ],
    });
    const { page } = await new PlaywrightBrowser({ load: loader(fake.chromium) }).open({
      profileDir: "/tmp/profile",
      headless: true,
    });
    expect(await page.clickButtonByText(/^(jetzt loslegen|weiter)/i, /^$/)).toBe("Weiter");
    expect(await page.clickByText(/e-mail/i, /land|\+4/i)).toBe(
      "Verwende stattdessen deine E-Mail-Adresse",
    );
    expect(await page.clickByText(/^MC SMART/i, /compact/i)).toBeNull();
    expect(await page.clickByText(/^MC SMART/i, /compact/i, { anyElement: true })).toBe("MC SMART");
    expect(fake.actions).toEqual([
      "click Weiter",
      "click Verwende stattdessen deine E-Mail-Adresse",
      "click MC SMART",
    ]);
  });

  it("ticks the terms checkbox once, through its input or its for attribute", async () => {
    const nested: FakeElement = { visible: true, text: "", checked: false };
    nested.onClick = () => {
      nested.checked = true;
    };
    const linked: FakeElement = { visible: false, text: "", checked: false };
    const fake = fakeChromium({
      'label, [role="checkbox"]': [
        { visible: true, text: "Ich möchte den Newsletter erhalten" },
        {
          visible: true,
          text: "Ich akzeptiere die Nutzungsbestimmungen.",
          children: { 'input[type="checkbox"]': [nested] },
        },
      ],
    });
    const { page } = await new PlaywrightBrowser({ load: loader(fake.chromium) }).open({
      profileDir: "/tmp/profile",
      headless: true,
    });
    expect(await page.checkBox(/nutzungsbestimmungen|newsletter/i, /newsletter/i)).toBe(true);
    expect(await page.checkBox(/nutzungsbestimmungen/i, /newsletter/i)).toBe(true);
    expect(fake.actions).toEqual(["click "]);
    expect(await page.checkBox(/terms of use/i, /newsletter/i)).toBe(false);

    const byId = fakeChromium({
      'label, [role="checkbox"]': [
        {
          visible: true,
          text: "Ich akzeptiere die Nutzungsbestimmungen.",
          attributes: { for: "terms" },
          onClick: () => {
            linked.checked = true;
          },
        },
      ],
      '[id="terms"]': [linked],
    });
    const second = await new PlaywrightBrowser({ load: loader(byId.chromium) }).open({
      profileDir: "/tmp/profile",
      headless: true,
    });
    expect(await second.page.checkBox(/nutzungsbestimmungen/i, /newsletter/i)).toBe(true);
    expect(byId.actions).toEqual(["click Ich akzeptiere die Nutzungsbestimmungen."]);

    const custom = fakeChromium({
      'label, [role="checkbox"]': [
        {
          visible: true,
          text: "",
          attributes: { role: "checkbox", "aria-label": "Terms of use", "aria-checked": "true" },
        },
      ],
    });
    const third = await new PlaywrightBrowser({ load: loader(custom.chromium) }).open({
      profileDir: "/tmp/profile",
      headless: true,
    });
    expect(await third.page.checkBox(/terms of use/i, /newsletter/i)).toBe(true);
    expect(custom.actions).toEqual([]);
  });
});
