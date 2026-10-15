import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser, loopClock, type FakeBrowserScript } from "../testing/browser.js";
import { tempDir } from "../testing/temp.js";
import { BrowserActionError, UNKNOWN_BROWSER_FAILURE } from "./browser-errors.js";
import {
  browserLogin,
  closeWithin,
  buildCookieHeader,
  hasLoginCookies,
  onLoginHost,
  readSessionCookie,
  siteLanguage,
  ssoLoginUrl,
} from "./browser-login.js";

const EDITOR = "/de/create-recipe?devices=mc-smart";
const CREDENTIALS = { email: "cook@example.com", password: "not-a-real-password" };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function login(script: FakeBrowserScript, extra: Partial<Parameters<typeof browserLogin>[0]> = {}) {
  const browser = fakeBrowser(script);
  const clock = loopClock();
  const temp = tempDir();
  cleanups.push(temp.cleanup);
  const result = browserLogin({
    browser,
    profileDir: join(temp.dir, "profile"),
    headless: true,
    editorPath: EDITOR,
    credentials: CREDENTIALS,
    timeoutMs: 30_000,
    screenshotPath: () => join(temp.dir, "shot.png"),
    ...clock,
    ...extra,
  });
  return { browser, result, dir: temp.dir };
}

describe("cookie header", () => {
  it("joins every cookie of the site and adds the language cookie", () => {
    const header = buildCookieHeader(
      [
        { name: "PHPSESSID", value: "a" },
        { name: "wordpress_logged_in_9f", value: "b%7Cc" },
        { name: "lidl_sso_id_token", value: "d" },
      ],
      "de",
    );
    expect(header).toBe(
      "PHPSESSID=a; wordpress_logged_in_9f=b%7Cc; lidl_sso_id_token=d; wp-wpml_current_language=de",
    );
    expect(hasLoginCookies(header)).toBe(true);
  });

  it("keeps a language cookie the browser already has", () => {
    const header = buildCookieHeader([{ name: "wp-wpml_current_language", value: "en" }], "de");
    expect(header).toBe("wp-wpml_current_language=en");
    expect(hasLoginCookies(header)).toBe(false);
  });

  it("needs both login cookies", () => {
    expect(hasLoginCookies("wordpress_logged_in_1=x")).toBe(false);
    expect(hasLoginCookies("lidl_sso_id_token=x")).toBe(false);
    expect(hasLoginCookies("xwordpress_logged_in_1=x; lidl_sso_id_token=y")).toBe(false);
  });

  it("reads the cookie only once the site has logged in", async () => {
    const empty = { cookies: () => Promise.resolve([{ name: "PHPSESSID", value: "1" }]) };
    expect(await readSessionCookie(empty, EDITOR)).toBeNull();
  });
});

describe("SSO URL", () => {
  it("starts at the site's SSO login with the editor as target", () => {
    expect(siteLanguage(EDITOR)).toBe("de");
    expect(siteLanguage("/en/create-recipe?devices=mc-smart")).toBe("en");
    expect(siteLanguage("/create")).toBe("de");
    expect(ssoLoginUrl(EDITOR)).toBe(
      `https://www.monsieur-cuisine.com/de/sso/login?redirect_uri=${encodeURIComponent(
        "https://www.monsieur-cuisine.com/de/create-recipe?devices=mc-smart",
      )}`,
    );
  });
});

describe("browserLogin", () => {
  it("fills the Lidl form, sends it and returns the site's cookie", async () => {
    const { browser, result } = login({ form: "both", loginWorks: true });
    const outcome = await result;
    expect(outcome).toEqual({
      ok: true,
      cookie: expect.stringContaining("lidl_sso_id_token=id-token") as string,
    });
    expect(browser.filled).toEqual({
      'input[type="email"]': CREDENTIALS.email,
      'input[type="password"]': CREDENTIALS.password,
    });
    expect(browser.steps[0]).toMatch(/^goto https:\/\/www\.monsieur-cuisine\.com\/de\/sso\/login/);
    expect(browser.opened).toEqual([{ profileDir: expect.any(String) as string, headless: true }]);
    expect(browser.closed).toBe(1);
  });

  it("sends the address first when the password comes on a second screen", async () => {
    const { browser, result } = login({ form: "two-step", loginWorks: true });
    expect((await result).ok).toBe(true);
    expect(browser.steps).toContain('enter input[type="email"]');
    expect(browser.steps).toContain('enter input[type="password"]');
  });

  it("clicks past a welcome screen, never on a registration button", async () => {
    const { browser, result } = login({
      form: "both",
      loginWorks: true,
      welcome: ["Konto erstellen", "Anmelden"],
    });
    expect((await result).ok).toBe(true);
    expect(browser.steps).toContain("click Anmelden");
    expect(browser.steps).not.toContain("click Konto erstellen");
  });

  it("does not click buttons outside the Lidl account pages", async () => {
    const { browser, result } = login({
      form: "both",
      welcome: ["Anmelden"],
      url: "https://www.monsieur-cuisine.com/de/",
    });
    expect((await result).ok).toBe(false);
    expect(browser.steps.some((step) => step.startsWith("click"))).toBe(false);
  });

  it("finishes without any input when the saved profile is still logged in", async () => {
    const { browser, result } = login(
      { form: "none", loggedInProfile: true },
      { credentials: null },
    );
    expect((await result).ok).toBe(true);
    expect(browser.filled).toEqual({});
  });

  it("reports a page without a login form, with a screenshot", async () => {
    const { result, dir } = login({ form: "none" });
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: false, code: "no_login_form" });
    expect(outcome.ok ? null : outcome.screenshot).toBe(join(dir, "shot.png"));
    expect(readdirSync(dir)).toContain("shot.png");
  });

  it("reports a sent form without a session: wrong password, captcha or second factor", async () => {
    const { result } = login({ form: "both", loginWorks: false });
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: false, code: "not_logged_in" });
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIALS.password);
  });

  it("times out when nobody logs in", async () => {
    const { result } = login({ form: "both" }, { credentials: null, screenshotPath: () => null });
    expect(await result).toEqual({
      ok: false,
      code: "not_logged_in",
      detail: "no login within the time limit",
      screenshot: null,
    });
  });

  it("reports a missing browser without opening one", async () => {
    const { browser, result } = login({ unavailable: "Playwright is not installed" });
    expect(await result).toEqual({
      ok: false,
      code: "browser_unavailable",
      detail: "Playwright is not installed",
      screenshot: null,
    });
    expect(browser.opened).toEqual([]);
  });

  it("reports a browser that fails to start", async () => {
    const { result } = login({ openError: new Error("Executable doesn't exist") });
    expect(await result).toMatchObject({ ok: false, code: "error", screenshot: null });
  });

  it.each([
    ["a look-alike host", "https://evil-accounts.lidl.com/Account/Login"],
    ["a host that only starts with the login host", "https://accounts.lidl.com.example.com/"],
    ["plain http", "http://accounts.lidl.com/Account/Login"],
    ["the Monsieur Cuisine site", "https://www.monsieur-cuisine.com/de/"],
  ])("never types the account into %s", async (_name, url) => {
    const { browser, result, dir } = login({ form: "both", loginWorks: true, url });
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: false, code: "unexpected_page" });
    expect(outcome.ok ? null : outcome.screenshot).toBe(join(dir, "shot.png"));
    expect(browser.filled).toEqual({});
    expect(browser.steps.filter((step) => /^(fill|enter|click)/.test(step))).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIALS.email);
  });

  it("fills the form on a configured login host", async () => {
    const { browser, result } = login(
      { form: "both", loginWorks: true, url: "https://login.example.com/signin" },
      { loginHosts: ["login.example.com"] },
    );
    expect((await result).ok).toBe(true);
    expect(browser.filled['input[type="password"]']).toBe(CREDENTIALS.password);
  });

  it("never passes the browser's error message on", async () => {
    const leak = new Error(
      `locator.fill: Timeout 5000ms exceeded.\nCall log:\n  - fill("${CREDENTIALS.password}")\n  - fill("${CREDENTIALS.email}")`,
    );
    const raw = await login({ form: "both", fillError: leak }).result;
    expect(raw).toMatchObject({ ok: false, code: "error", detail: UNKNOWN_BROWSER_FAILURE });
    expect(JSON.stringify(raw)).not.toContain(CREDENTIALS.password);
    expect(JSON.stringify(raw)).not.toContain(CREDENTIALS.email);

    const mapped = await login({ form: "both", fillError: new BrowserActionError("timeout") })
      .result;
    expect(mapped).toMatchObject({
      ok: false,
      code: "error",
      detail: "the browser timed out on the login page",
    });
  });
});

describe("onLoginHost", () => {
  it("matches the login hosts exactly and over https only", () => {
    expect(onLoginHost("https://accounts.lidl.com/Account/Login?x=1")).toBe(true);
    expect(onLoginHost("https://ACCOUNTS.lidl.com/")).toBe(true);
    expect(onLoginHost("https://accounts.lidl.com:443/")).toBe(true);
    expect(onLoginHost("https://lidl.com/")).toBe(false);
    expect(onLoginHost("https://xaccounts.lidl.com/")).toBe(false);
    expect(onLoginHost("https://accounts.lidl.com.evil.example/")).toBe(false);
    expect(onLoginHost("http://accounts.lidl.com/")).toBe(false);
    expect(onLoginHost("about:blank")).toBe(false);
    expect(onLoginHost("not a url")).toBe(false);
    expect(onLoginHost("https://login.example.com/", ["login.example.com"])).toBe(true);
  });
});

describe("closeWithin", () => {
  it("gives up on a browser that never closes and kills it", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn();
      const hanging = { close: () => new Promise<void>(() => undefined), kill };
      const done = closeWithin(hanging, 10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(done).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns as soon as the browser closed, and ignores a failing close", async () => {
    const kill = vi.fn();
    await expect(
      closeWithin({ close: () => Promise.resolve(), kill }, 60_000),
    ).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    await expect(
      closeWithin({ close: () => Promise.reject(new Error("gone")) }, 60_000),
    ).resolves.toBeUndefined();
  });
});
