import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENTERPRISE_ANCHOR,
  FAKE_TEXT,
  fakeBrowser,
  loopClock,
  type FakeBrowserScript,
} from "../testing/browser.js";
import { tempDir } from "../testing/temp.js";
import { BrowserActionError, UNKNOWN_BROWSER_FAILURE } from "./browser-errors.js";
import {
  ACTION_PAUSE_MS,
  FIELD_PAUSE_MS,
  LOGIN_STEPS,
  LOGIN_STEP_TEXT,
  browserLabel,
  browserLogin,
  browserName,
  closeWithin,
  buildCookieHeader,
  hasLoginCookies,
  onLoginHost,
  readSessionCookie,
  sanitizeUserAgent,
  siteLanguage,
  siteMessage,
  ssoLoginUrl,
  stuckAfter,
} from "./browser-login.js";

const EDITOR = "/de/create-recipe?devices=mc-smart";
const CREDENTIALS = { email: "cook@example.com", password: "not-a-real-password" };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// The steps appear in this order, with other steps in between.
function expectInOrder(steps: readonly string[], expected: readonly string[]) {
  let from = 0;
  for (const item of expected) {
    const index = steps.indexOf(item, from);
    expect(index, `${item} after step ${from}`).toBeGreaterThanOrEqual(0);
    from = index + 1;
  }
}

// No click, fill or Enter on the phone login's controls.
function expectPhoneUntouched(steps: readonly string[]) {
  expect(steps).not.toContain(`click ${FAKE_TEXT.country}`);
  expect(steps).not.toContain(`click ${FAKE_TEXT.toPhone}`);
  expect(steps.some((step) => step.includes("tel"))).toBe(false);
  expect(steps).not.toContain("enter without a field");
}

function login(script: FakeBrowserScript, extra: Partial<Parameters<typeof browserLogin>[0]> = {}) {
  const clock = loopClock();
  // The page sees the clock the flow runs on.
  const browser = fakeBrowser(script, extra.now ?? clock.now);
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
    // Pauses of 500 ms between actions.
    random: () => 0.5,
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
      progress: {
        reached: [
          "page_reached",
          "email_entered",
          "password_page",
          "password_entered",
          "redirect_reached",
          "cookies_received",
        ],
        consentDismissals: 0,
      },
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
      detail: "no login within the time limit; stuck after: login page reached",
      screenshot: null,
      progress: { reached: ["page_reached"], consentDismissals: 0 },
    });
  });

  it("reports a missing browser without opening one", async () => {
    const { browser, result } = login({ unavailable: "Playwright is not installed" });
    expect(await result).toEqual({
      ok: false,
      code: "browser_unavailable",
      detail: "Playwright is not installed",
      screenshot: null,
      progress: { reached: [], consentDismissals: 0 },
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
    expect(raw).toMatchObject({
      ok: false,
      code: "error",
      detail: `${UNKNOWN_BROWSER_FAILURE}; stuck after: login page reached`,
    });
    expect(JSON.stringify(raw)).not.toContain(CREDENTIALS.password);
    expect(JSON.stringify(raw)).not.toContain(CREDENTIALS.email);

    const mapped = await login({ form: "both", fillError: new BrowserActionError("timeout") })
      .result;
    expect(mapped).toMatchObject({
      ok: false,
      code: "error",
      detail: "the browser timed out on the login page; stuck after: login page reached",
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

describe("browserLogin with consent dialogs", () => {
  it("declines the dialog before it fills the form", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { browser, result } = login(
      { form: "both", loginWorks: true, consent: ["Akzeptieren", "Ablehnen"], consentClose: true },
      { onStep },
    );
    expect(await result).toMatchObject({ ok: true, consentDismissed: true });
    const declined = browser.steps.indexOf("click Ablehnen");
    expect(declined).toBeGreaterThan(0);
    expect(declined).toBeLessThan(browser.steps.indexOf('fill input[type="email"]'));
    expect(browser.steps.some((step) => step.endsWith("under the dialog"))).toBe(false);
    expect(browser.steps).not.toContain("close dialog");
    expect(onStep).toHaveBeenCalledWith("consent dialog dismissed");
  });

  it("never clicks an accept button, also not as a welcome screen button", async () => {
    const { browser, result } = login({
      form: "both",
      loginWorks: true,
      consent: ["Zustimmen", "Anpassen", "Akzeptieren", "Accept all", "Tout accepter"],
    });
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: false, code: "not_logged_in" });
    expect(outcome).not.toHaveProperty("consentDismissed");
    expect(browser.steps.filter((step) => step.startsWith("click"))).toEqual([]);
  });

  it("closes a dialog without a decline button with its close button", async () => {
    const { browser, result } = login({
      form: "both",
      loginWorks: true,
      consent: ["Zustimmen"],
      consentClose: true,
    });
    expect(await result).toMatchObject({ ok: true, consentDismissed: true });
    expect(browser.steps).toContain("close dialog");
    expect(browser.steps).not.toContain("click Zustimmen");
  });

  it("declines in other languages than the site's", async () => {
    const { browser, result } = login({
      form: "both",
      loginWorks: true,
      consent: ["Accepter", "Tout refuser"],
    });
    expect((await result).ok).toBe(true);
    expect(browser.steps).toContain("click Tout refuser");
  });

  it("leaves a page without a dialog alone", async () => {
    const { browser, result } = login({ form: "both", loginWorks: true, consentClose: false });
    const outcome = await result;
    expect(outcome).toEqual({
      ok: true,
      cookie: expect.any(String) as string,
      progress: expect.objectContaining({ consentDismissals: 0 }) as object,
    });
    expect(browser.steps).not.toContain("close dialog");
  });
});

describe("browserLogin form and answers", () => {
  it("clicks Weiter between the e-mail address and the password", async () => {
    const { browser, result } = login({
      form: "continue",
      loginWorks: true,
      consent: ["Alle ablehnen"],
    });
    expect(await result).toMatchObject({ ok: true, consentDismissed: true });
    expectInOrder(browser.steps, [
      "click Alle ablehnen",
      'fill input[type="email"]',
      "click Weiter",
      'fill input[type="password"]',
      "click Weiter",
    ]);
    expect(browser.steps.filter((step) => step.startsWith("enter"))).toEqual([]);
  });

  it("reports an address the site does not know, without the address", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { browser, result } = login(
      {
        form: "continue",
        unknownAccount: "Zu cook@example.com gibt es kein Konto.",
      },
      { onStep },
    );
    const outcome = await result;
    expect(outcome).toMatchObject({
      ok: false,
      code: "unknown_account",
      detail:
        'the site does not know the e-mail address: "Zu <e-mail> gibt es kein Konto."; stuck after: continue clicked',
    });
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIALS.email);
    expect(onStep).toHaveBeenCalledWith("the site does not know the e-mail address");
    expect(browser.filled).not.toHaveProperty('input[type="password"]');
  });

  it("never types the password into a page that offers a new account", async () => {
    const { browser, result } = login({ form: "continue", loginWorks: true, newAccount: true });
    expect(await result).toMatchObject({ ok: false, code: "unknown_account" });
    expect(browser.filled).not.toHaveProperty('input[type="password"]');
  });

  it("says when the address was sent but no password field followed", async () => {
    // A dialog without a decline button swallows the click on "Weiter".
    const { browser, result } = login({ form: "continue", consent: ["Zustimmen"] });
    expect(await result).toMatchObject({
      ok: false,
      code: "not_logged_in",
      detail:
        "the e-mail address was sent, but no password field followed; stuck after: continue clicked",
    });
    expect(browser.steps).not.toContain("click Zustimmen");
  });

  it("keeps another error after the address as the reason", async () => {
    const { result } = login({ form: "continue", unknownAccount: "Bitte warte kurz." });
    expect(await result).toMatchObject({
      ok: false,
      code: "not_logged_in",
      detail: 'the site reported an error: "Bitte warte kurz."; stuck after: continue clicked',
    });
  });

  it("reports a wrong password the site names, without the address or the password", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { browser, result } = login(
      {
        form: "both",
        siteError: "E-Mail-Adresse cook@example.com oder Passwort ist falsch.",
      },
      { onStep },
    );
    const outcome = await result;
    expect(outcome).toMatchObject({
      ok: false,
      code: "wrong_password",
      detail:
        'wrong password reported by the site: "E-Mail-Adresse <e-mail> oder Passwort ist falsch."; stuck after: password entered',
    });
    expect(outcome.ok ? null : outcome.screenshot).not.toBeNull();
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIALS.password);
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIALS.email);
    expect(onStep).toHaveBeenCalledWith("wrong password reported by the site");
    expect(browser.steps).toContain("screenshot");
  });

  it("keeps another error message of the site as the reason", async () => {
    const { result } = login({ form: "both", siteError: "Konto gesperrt." });
    expect(await result).toMatchObject({
      ok: false,
      code: "not_logged_in",
      detail: 'the site reported an error: "Konto gesperrt."; stuck after: password entered',
    });
  });

  it("reports a throttled login, before reading the message as a wrong password", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { result } = login(
      {
        form: "both",
        siteError:
          "Die Kapazität wurde überschritten. Bitte warte einen Moment und versuche es erneut.",
      },
      { onStep },
    );
    expect(await result).toMatchObject({
      ok: false,
      code: "rate_limited",
      detail:
        'the site throttles the login: "Die Kapazität wurde überschritten. Bitte warte einen Moment und versuche es erneut."; stuck after: password entered',
    });
    expect(onStep).toHaveBeenCalledWith("the site throttles the login");
    const wrong = login({
      form: "both",
      siteError: "Too many incorrect attempts. Try again later.",
    });
    expect(await wrong.result).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("reports a throttled login after the e-mail step, not as an unknown account", async () => {
    const { result } = login({ form: "two-step", unknownAccount: "Too many requests, not found" });
    expect(await result).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("reports a throttled login the page shows outside its error elements", async () => {
    const { browser, result } = login({
      form: "continue",
      pageNotice:
        "Die Kapazität wurde überschritten Bitte warte einen Moment und versuche es erneut",
    });
    expect(await result).toMatchObject({
      ok: false,
      code: "rate_limited",
      detail: "the site throttles the login (message on the page); stuck after: password entered",
    });
    // Back at the e-mail step, the flow does not send the account again.
    expect(
      browser.steps.filter((step) => step.startsWith('fill input[type="password"]')),
    ).toHaveLength(1);
  });

  it("records the browser the attempt ran in", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const info = {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      headless: "new" as const,
    };
    const { result } = login({ form: "both", loginWorks: true, browser: info }, { onStep });
    expect(await result).toMatchObject({ ok: true, progress: { browser: info } });
    expect(onStep).toHaveBeenCalledWith("browser: Chrome 141, new headless");
  });

  it("reports a captcha frame, but not the invisible one every form carries", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { result } = login({ form: "both", verification: "frame" }, { onStep });
    expect(await result).toMatchObject({
      ok: false,
      code: "verification_required",
      detail: "captcha or verification requested; stuck after: password entered",
    });
    expect(onStep).toHaveBeenCalledWith("captcha or verification requested");
    const plain = login({ form: "both" });
    expect(await plain.result).toMatchObject({ ok: false, code: "not_logged_in" });
  });

  it("reports a request for a code on the Lidl pages", async () => {
    const { result } = login({ form: "both", verification: "text" });
    expect(await result).toMatchObject({ ok: false, code: "verification_required" });
    const elsewhere = login({
      form: "both",
      verification: "text",
      url: "https://www.monsieur-cuisine.com/de/",
    });
    // Off the Lidl pages the text is no verification step, and the form is not filled.
    expect(await elsewhere.result).toMatchObject({ ok: false, code: "unexpected_page" });
  });

  it("shortens a site message to one line", () => {
    expect(siteMessage("  a\n  b  ", "")).toBe("a b");
    expect(siteMessage("y".repeat(200), "x@example.com")).toHaveLength(160);
  });
});

describe("browserLogin on the phone login", () => {
  it("switches to the e-mail address and logs in in two steps", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { browser, result } = login(
      { form: "continue", phoneMode: true, loginWorks: true },
      { onStep },
    );
    expect((await result).ok).toBe(true);
    expectInOrder(browser.steps, [
      `click ${FAKE_TEXT.toEmail}`,
      'fill input[type="email"]',
      "click Weiter",
      'fill input[type="password"]',
      "click Weiter",
    ]);
    expectPhoneUntouched(browser.steps);
    expect(onStep).toHaveBeenCalledWith(
      "switched the Lidl login from the phone number to the e-mail address",
    );
  });

  it("switches behind a declined consent dialog", async () => {
    const { browser, result } = login({
      form: "two-step",
      phoneMode: true,
      loginWorks: true,
      consent: ["Alle akzeptieren", "Alle ablehnen"],
    });
    expect(await result).toMatchObject({ ok: true, consentDismissed: true });
    expectInOrder(browser.steps, ["click Alle ablehnen", `click ${FAKE_TEXT.toEmail}`]);
    expect(browser.steps).not.toContain("click Alle akzeptieren");
    expectPhoneUntouched(browser.steps);
  });

  it("never clicks the country selector when the switch link does nothing", async () => {
    const clock = loopClock();
    const { browser, result } = login(
      { form: "continue", phoneMode: true, switchIgnored: true, loginWorks: true },
      { ...clock, timeoutMs: 120_000 },
    );
    expect(await result).toMatchObject({
      ok: false,
      code: "no_login_form",
      detail: "no e-mail field showed up on the Lidl login page; stuck after: login page reached",
    });
    expectPhoneUntouched(browser.steps);
    expect(browser.steps.filter((step) => step === `click ${FAKE_TEXT.toEmail}`)).toHaveLength(2);
    expect(clock.now()).toBeLessThan(20_000);
  });

  it("gives up on a Lidl page without an e-mail field after 15 seconds", async () => {
    const clock = loopClock();
    const { browser, result } = login({ form: "none" }, { ...clock, timeoutMs: 120_000 });
    expect(await result).toMatchObject({
      ok: false,
      code: "no_login_form",
      detail: "no e-mail field showed up on the Lidl login page; stuck after: login page reached",
    });
    expect(clock.now()).toBeLessThan(20_000);
    expect(browser.steps.some((step) => step.startsWith("enter"))).toBe(false);
  });
});

describe("browserLogin on the first login at monsieur-cuisine.com", () => {
  it("confirms the terms once the checkbox is ticked and notes it", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { browser, result } = login(
      { form: "continue", loginWorks: true, terms: true },
      { onStep, timeoutMs: 60_000 },
    );
    expect(await result).toEqual({
      ok: true,
      cookie: expect.any(String) as string,
      termsAccepted: true,
      progress: expect.objectContaining({
        reached: expect.arrayContaining(["redirect_reached", "terms_confirmed"]) as string[],
      }) as object,
    });
    expectInOrder(browser.steps, [
      "click Weiter",
      "click Weiter",
      `check ${FAKE_TEXT.termsBox}`,
      `click ${FAKE_TEXT.start}`,
    ]);
    expect(browser.steps).not.toContain(`check ${FAKE_TEXT.newsletterBox}`);
    expect(onStep).toHaveBeenCalledWith("terms of use confirmed");
  });

  it("waits 10 seconds for the session before it looks at the terms", async () => {
    const clock = loopClock();
    let sentAt = -1;
    let confirmedAt = -1;
    const { result } = login(
      { form: "continue", loginWorks: true, terms: true },
      {
        ...clock,
        timeoutMs: 60_000,
        onStep: (message) => {
          if (message === "login form sent") sentAt = clock.now();
          if (message === "terms of use confirmed") confirmedAt = clock.now();
        },
      },
    );
    expect((await result).ok).toBe(true);
    expect(confirmedAt - sentAt).toBeGreaterThanOrEqual(10_000);
    expect(confirmedAt - sentAt).toBeLessThan(15_000);
  });

  it("chooses MC Smart in the device chooser after the terms", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { browser, result } = login(
      { form: "continue", loginWorks: true, terms: true, deviceChooser: true },
      { onStep, timeoutMs: 60_000 },
    );
    expect(await result).toMatchObject({ ok: true, termsAccepted: true, deviceChosen: true });
    expectInOrder(browser.steps, [`click ${FAKE_TEXT.start}`, "click MC SMART"]);
    for (const other of ["MC COMPACT", "MC CONNECT", "MC PLUS"]) {
      expect(browser.steps).not.toContain(`click ${other}`);
    }
    expect(onStep).toHaveBeenCalledWith("device MC Smart chosen");
  });

  it("closes the hint next to the chooser once the device is chosen", async () => {
    const { browser, result } = login(
      { form: "continue", loginWorks: true, deviceChooser: true, hintBlocks: true },
      { timeoutMs: 60_000 },
    );
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: true, deviceChosen: true });
    expect(outcome).not.toHaveProperty("termsAccepted");
    expectInOrder(browser.steps, ["click MC SMART", `click ${FAKE_TEXT.hint}`]);
  });

  it("declines the consent dialog of the site and never accepts it", async () => {
    const { browser, result } = login(
      {
        form: "continue",
        loginWorks: true,
        terms: true,
        siteConsent: ["Alle akzeptieren", "Ablehnen"],
      },
      { timeoutMs: 60_000 },
    );
    expect(await result).toMatchObject({ ok: true, consentDismissed: true, termsAccepted: true });
    expectInOrder(browser.steps, ["click Ablehnen", `check ${FAKE_TEXT.termsBox}`]);
    expect(browser.steps).not.toContain("click Alle akzeptieren");
  });

  it("leaves the terms to the person in a login without a stored account", async () => {
    const { browser, result } = login(
      {
        form: "continue",
        loginWorks: true,
        terms: true,
        url: "https://www.monsieur-cuisine.com/de/",
      },
      { credentials: null },
    );
    expect((await result).ok).toBe(false);
    expect(browser.steps.some((step) => step.startsWith("check"))).toBe(false);
    expect(browser.steps.some((step) => step.startsWith("click"))).toBe(false);
  });
});

// The pause before a field at random() = 0.5.
const FIELD_MID = (FIELD_PAUSE_MS.min + FIELD_PAUSE_MS.max) / 2;

describe("browserLogin timing", () => {
  it("leaves a page without a dialog at once instead of waiting for one", async () => {
    const clock = loopClock();
    let filledAt = -1;
    const { result } = login(
      { form: "both", loginWorks: true },
      {
        ...clock,
        onStep: (message) => {
          if (message === "e-mail address entered") filledAt = clock.now();
        },
      },
    );
    expect((await result).ok).toBe(true);
    // The pause before the field, the fill at once, then the pause after it.
    expect(filledAt).toBe(FIELD_MID + 500);
  });

  it("does not wait at a dialog it cannot dismiss", async () => {
    const clock = loopClock();
    let filledAt = -1;
    const { result } = login(
      { form: "both", consent: ["Zustimmen"] },
      {
        ...clock,
        onStep: (message) => {
          if (message === "e-mail address entered") filledAt = clock.now();
        },
      },
    );
    expect((await result).ok).toBe(false);
    expect(filledAt).toBe(FIELD_MID + 500);
  });
});

describe("browserLogin with dialogs that come late", () => {
  const timedOut = (steps: readonly string[]) => steps.filter((step) => step.endsWith("timed out"));

  it.each([300, 800, 1500])(
    "declines a dialog that comes up %i ms after the navigation",
    async (delay) => {
      const { browser, result } = login({
        form: "continue",
        loginWorks: true,
        consent: ["Akzeptieren", "Ablehnen"],
        consentClose: true,
        consentDelayMs: delay,
        coverBlocks: true,
      });
      expect(await result).toMatchObject({ ok: true, consentDismissed: true });
      expect(browser.steps).toContain("click Ablehnen");
      expect(browser.steps).not.toContain("click Akzeptieren");
      expect(browser.steps).not.toContain("close dialog");
      expect(timedOut(browser.steps)).toEqual([]);
    },
  );

  it("declines the dialog again when it comes back after the e-mail step", async () => {
    const { browser, result } = login({
      form: "continue",
      loginWorks: true,
      consent: ["Akzeptieren", "Ablehnen"],
      consentAgainAfterEmail: true,
      coverBlocks: true,
    });
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: true, progress: { consentDismissals: 2 } });
    expectInOrder(browser.steps, [
      "click Ablehnen",
      'fill input[type="email"]',
      "click Weiter",
      "click Ablehnen",
      'fill input[type="password"]',
      "click Weiter",
    ]);
    expect(timedOut(browser.steps)).toEqual([]);
  });

  it("dismisses a dialog that covered a fill and fills once more", async () => {
    const { browser, result } = login({
      form: "continue",
      loginWorks: true,
      consent: ["Akzeptieren", "Ablehnen"],
      consentOnFirstFill: true,
      coverBlocks: true,
    });
    expect(await result).toMatchObject({ ok: true, consentDismissed: true });
    expectInOrder(browser.steps, [
      'fill input[type="email"] timed out',
      "click Ablehnen",
      'fill input[type="email"]',
      "click Weiter",
    ]);
    expect(timedOut(browser.steps)).toHaveLength(1);
    expect(browser.filled['input[type="email"]']).toBe(CREDENTIALS.email);
  });

  it("names the last step when a dialog it cannot dismiss covers the continue button", async () => {
    const { browser, result } = login({
      form: "continue",
      consent: ["Zustimmen"],
      // After the e-mail address is typed, before "Weiter".
      consentDelayMs: FIELD_MID + 400,
      coverBlocks: true,
    });
    expect(await result).toMatchObject({
      ok: false,
      code: "error",
      detail: "the browser timed out on the login page; stuck after: e-mail entered",
      progress: { reached: ["page_reached", "email_entered"], consentDismissals: 0 },
    });
    // The first try, then one more after looking for a dialog.
    expect(timedOut(browser.steps)).toEqual(["click Weiter timed out", "click Weiter timed out"]);
    expect(browser.steps).not.toContain("click Zustimmen");
  });

  it("looks for dialogs only shortly after a navigation when a person logs in", async () => {
    const early = login(
      { form: "both", consent: ["Ablehnen"], consentDelayMs: 1500 },
      { credentials: null, timeoutMs: 10_000 },
    );
    expect(await early.result).toMatchObject({ ok: false, consentDismissed: true });
    const late = login(
      { form: "both", consent: ["Ablehnen"], consentDelayMs: 5000 },
      { credentials: null, timeoutMs: 10_000 },
    );
    expect(await late.result).not.toHaveProperty("consentDismissed");
    expect(late.browser.steps).not.toContain("click Ablehnen");
  });
});

describe("browserLogin on the Lidl page as it is", () => {
  it.each(["button", "text"] as const)(
    "switches to the e-mail address when the switch is a %s",
    async (kind) => {
      const { browser, result } = login({
        form: "continue",
        phoneMode: true,
        switchElement: kind,
        loginWorks: true,
      });
      expect((await result).ok).toBe(true);
      expectInOrder(browser.steps, [
        `click ${FAKE_TEXT.toEmail}`,
        'fill input[type="email"]',
        "click Weiter",
      ]);
      expectPhoneUntouched(browser.steps);
    },
  );

  it("ignores the reCAPTCHA Enterprise frame the page loads at once", async () => {
    const works = login({ form: "continue", loginWorks: true, frames: [ENTERPRISE_ANCHOR] });
    expect((await works.result).ok).toBe(true);
    const refused = login({ form: "both", frames: [ENTERPRISE_ANCHOR] });
    expect(await refused.result).toMatchObject({ ok: false, code: "not_logged_in" });
  });

  it("records every step of a first login with a dialog, in order", async () => {
    const onStep = vi.fn<(message: string) => void>();
    const { result } = login(
      {
        form: "continue",
        loginWorks: true,
        consent: ["Ablehnen"],
        terms: true,
        deviceChooser: true,
      },
      { onStep, timeoutMs: 60_000 },
    );
    const outcome = await result;
    expect(outcome.ok).toBe(true);
    expect(outcome.progress).toEqual({ reached: [...LOGIN_STEPS], consentDismissals: 1 });
    expect(onStep).toHaveBeenCalledWith("logged in");
  });

  it("records the steps up to a wrong password", async () => {
    const { result } = login({ form: "continue", siteError: "Passwort ist falsch." });
    expect(await result).toMatchObject({
      ok: false,
      code: "wrong_password",
      progress: {
        reached: [
          "page_reached",
          "email_entered",
          "continue_clicked",
          "password_page",
          "password_entered",
        ],
        consentDismissals: 0,
      },
    });
  });

  it("pauses between actions like a person", async () => {
    const clock = loopClock();
    const times: Record<string, number> = {};
    const { result } = login(
      { form: "continue", loginWorks: true },
      { ...clock, random: () => 0, onStep: (message) => (times[message] = clock.now()) },
    );
    expect((await result).ok).toBe(true);
    // A longer pause before the field, the fill at once and a pause, then the click on
    // "Weiter" and a pause.
    expect(times["e-mail address entered"]).toBe(FIELD_PAUSE_MS.min + ACTION_PAUSE_MS.min);
    expect(times["e-mail address sent"]).toBe(FIELD_PAUSE_MS.min + 2 * ACTION_PAUSE_MS.min);
  });
});

describe("browser diagnostics", () => {
  it("names the browser and its mode in a short label", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36";
    expect(browserName(ua)).toBe("Chrome 141");
    expect(browserName("curl/8")).toBeNull();
    expect(browserLabel({ userAgent: ua, headless: "shell" })).toBe("Chrome 141, headless shell");
    expect(browserLabel({ userAgent: null, headless: false })).toBe(
      "unknown browser, visible window",
    );
    expect(sanitizeUserAgent(`  a\n\tb\u0000c ${"x".repeat(300)}`)).toBe(
      `a b c ${"x".repeat(194)}`,
    );
  });
});

describe("stuckAfter", () => {
  it("names the last step reached, or nothing", () => {
    expect(stuckAfter({ reached: [], consentDismissals: 0 })).toBe("");
    expect(
      stuckAfter({ reached: ["page_reached", "consent_dismissed"], consentDismissals: 2 }),
    ).toBe("; stuck after: consent dismissed");
    for (const name of LOGIN_STEPS) expect(LOGIN_STEP_TEXT[name]).not.toBe("");
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
