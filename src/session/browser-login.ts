// Logs in to monsieur-cuisine.com in a real browser and reads the session cookie, the way a
// person would: open the site's SSO login, which sends the browser to the Lidl account
// page, sign in there, and wait until the site has set its login cookies.
//
// The flow follows the browser login of SmartRecipe (MIT, src/mc/browser-login.ts): start at
// /<lang>/sso/login with the editor as redirect target, fill input[type="email"] and
// input[type="password"], click past a welcome screen with the first button that does not
// lead to a registration, and poll the cookies of www.monsieur-cuisine.com until
// wordpress_logged_in_* and lidl_sso_id_token exist. The Cookie header is every cookie of
// the site plus wp-wpml_current_language, which the proxy expects.
//
// The e-mail address and the password go only into a page served over https from one of
// the login hosts (LIDL_LOGIN_HOSTS, exact host names). A password field anywhere else ends
// the attempt as "unexpected_page" with a screenshot, before anything is typed.
//
// No error message of the browser reaches the result: a thrown error becomes a fixed text
// (browser-errors.ts), because Playwright's messages can carry the typed password.
//
// The browser sits behind LoginBrowser, so tests drive the flow with a fake and the bridge
// starts without Playwright. The automatic login gives every attempt a fresh profile;
// npm run mc:login keeps a persistent one on the operator's computer.

import { browserFailureDetail } from "./browser-errors.js";

export const MC_BASE_URL = "https://www.monsieur-cuisine.com";

// The hosts of the Lidl account pages the login form may be filled on.
export const DEFAULT_LOGIN_HOSTS: readonly string[] = ["accounts.lidl.com"];

// Selectors of the Lidl login form.
export const EMAIL_FIELD = 'input[type="email"]';
export const PASSWORD_FIELD = 'input[type="password"]';
// Buttons on the Lidl welcome screen that lead away from the login.
export const SKIP_BUTTONS = /regist|erstellen|create|sign up|neu/i;

export interface BrowserCookie {
  name: string;
  value: string;
}

// What the flow needs from a browser page.
export interface LoginPage {
  goto(url: string): Promise<void>;
  url(): string;
  // Fills the first visible element matching the CSS selector; false when none is visible.
  fillVisible(selector: string, value: string): Promise<boolean>;
  // Whether an element matching the selector is visible.
  isVisible(selector: string): Promise<boolean>;
  // Presses Enter in the first visible element matching the selector.
  pressEnter(selector: string): Promise<void>;
  // Clicks the first visible button whose text does not match `skip`; false when none.
  clickButton(skip: RegExp): Promise<boolean>;
  screenshot(path: string): Promise<void>;
}

export interface LoginContext {
  page: LoginPage;
  cookies(url: string): Promise<BrowserCookie[]>;
  close(): Promise<void>;
  // Ends a browser that did not close in time, with its child processes.
  kill?(): void;
}

export interface LoginBrowser {
  // Null when a browser can be started, otherwise why not.
  unavailable(): Promise<string | null>;
  // A browser with its profile in profileDir: cookies and logins stay there until the
  // directory is removed.
  open(options: { profileDir: string; headless: boolean }): Promise<LoginContext>;
}

export type BrowserLoginFailure =
  // Playwright or its Chromium is not installed.
  | "browser_unavailable"
  // No login form showed up: a changed page, a captcha or a consent screen.
  | "no_login_form"
  // The form was sent, or the person did not log in, but no session followed: a wrong
  // password, a captcha or a second factor.
  | "not_logged_in"
  // A password field showed up on a page that is not a login host over https.
  | "unexpected_page"
  // The browser failed.
  | "error";

export type BrowserLoginResult =
  | { ok: true; cookie: string }
  | { ok: false; code: BrowserLoginFailure; detail: string; screenshot: string | null };

export interface BrowserLoginOptions {
  browser: LoginBrowser;
  profileDir: string;
  headless: boolean;
  // The web editor path of the locale pack ("/de/create-recipe?devices=mc-smart"); its first
  // segment is the site language.
  editorPath: string;
  baseUrl?: string;
  // Filled into the Lidl form when given. Without them the person logs in, or a saved
  // profile logs in on its own.
  credentials?: { email: string; password: string } | null;
  // The hosts the form may be filled on; DEFAULT_LOGIN_HOSTS when left out.
  loginHosts?: readonly string[];
  timeoutMs: number;
  pollMs?: number;
  // Where to save a screenshot when the login fails; null skips it.
  screenshotPath?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Progress for a person watching ("login form filled"); never carries secrets.
  onStep?: (message: string) => void;
}

// "de" for "/de/create-recipe?devices=mc-smart".
export function siteLanguage(editorPath: string): string {
  const segment = editorPath.split("?")[0]?.split("/")[1] ?? "";
  return /^[a-z]{2}$/.test(segment) ? segment : "de";
}

export function ssoLoginUrl(editorPath: string, baseUrl: string = MC_BASE_URL): string {
  const base = baseUrl.replace(/\/+$/, "");
  const editor = `${base}${editorPath}`;
  return `${base}/${siteLanguage(editorPath)}/sso/login?redirect_uri=${encodeURIComponent(editor)}`;
}

export function hasLoginCookies(header: string): boolean {
  return (
    /(?:^|;\s*)wordpress_logged_in_[^=]*=/.test(header) &&
    /(?:^|;\s*)lidl_sso_id_token=/.test(header)
  );
}

// The Cookie header the bridge sends: every cookie of the site as name=value, joined with
// "; ", plus the language cookie when the browser has none.
export function buildCookieHeader(cookies: readonly BrowserCookie[], language: string): string {
  const pairs = cookies.filter((cookie) => cookie.name !== "").map((c) => `${c.name}=${c.value}`);
  if (!cookies.some((cookie) => cookie.name === "wp-wpml_current_language")) {
    pairs.push(`wp-wpml_current_language=${language}`);
  }
  return pairs.join("; ");
}

// The session cookie once the site has set both login cookies, else null.
export async function readSessionCookie(
  context: Pick<LoginContext, "cookies">,
  editorPath: string,
  baseUrl: string = MC_BASE_URL,
): Promise<string | null> {
  const cookies = await context.cookies(`${baseUrl.replace(/\/+$/, "")}/proxy-api`);
  const header = buildCookieHeader(cookies, siteLanguage(editorPath));
  return hasLoginCookies(header) ? header : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// True when the page is served over https from one of the hosts, compared exactly:
// "accounts.lidl.com" matches neither "evil-accounts.lidl.com" nor "accounts.lidl.com.evil".
export function onLoginHost(url: string, hosts: readonly string[] = DEFAULT_LOGIN_HOSTS): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return hosts.some((allowed) => allowed.trim().toLowerCase() === host);
}

export const CLOSE_TIMEOUT_MS = 10_000;

// Closes the browser, and kills it when it does not close within ms.
export async function closeWithin(
  context: Pick<LoginContext, "close" | "kill">,
  ms: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    context.close().then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (!closed) {
    try {
      context.kill?.();
    } catch {
      // Nothing more to do; the next login starts a browser of its own.
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function browserLogin(options: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const unavailable = await options.browser.unavailable();
  if (unavailable !== null) {
    return { ok: false, code: "browser_unavailable", detail: unavailable, screenshot: null };
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 1000;
  const step = options.onStep ?? (() => undefined);
  const baseUrl = options.baseUrl ?? MC_BASE_URL;
  const credentials = options.credentials ?? null;
  const loginHosts = options.loginHosts ?? DEFAULT_LOGIN_HOSTS;
  const deadline = now() + options.timeoutMs;

  let context: LoginContext | null = null;
  let sawForm = false;
  let emailFilled = false;
  let emailSent = false;
  let passwordSent = false;
  let clicks = 0;

  const fail = async (code: BrowserLoginFailure, detail: string): Promise<BrowserLoginResult> => {
    let screenshot: string | null = null;
    const path = options.screenshotPath?.() ?? null;
    if (context && path) {
      try {
        await context.page.screenshot(path);
        screenshot = path;
      } catch {
        // A missing screenshot must not hide the login failure.
      }
    }
    return { ok: false, code, detail, screenshot };
  };

  try {
    context = await options.browser.open({
      profileDir: options.profileDir,
      headless: options.headless,
    });
    step("opening the Monsieur Cuisine login");
    await context.page.goto(ssoLoginUrl(options.editorPath, baseUrl));

    while (now() < deadline) {
      const cookie = await readSessionCookie(context, options.editorPath, baseUrl);
      if (cookie !== null) {
        step("logged in");
        return { ok: true, cookie };
      }
      if (credentials && !passwordSent && !onLoginHost(context.page.url(), loginHosts)) {
        // Never type the account into a page that is not the Lidl login.
        if (await context.page.isVisible(PASSWORD_FIELD)) {
          step("login form on an unexpected page");
          return await fail(
            "unexpected_page",
            `a login form showed up on an unexpected page (${hostOf(context.page.url()) || "no host"})`,
          );
        }
      } else if (credentials && !passwordSent) {
        const page = context.page;
        if (!emailFilled && (await page.fillVisible(EMAIL_FIELD, credentials.email))) {
          emailFilled = true;
          sawForm = true;
          step("e-mail address entered");
        }
        if (await page.fillVisible(PASSWORD_FIELD, credentials.password)) {
          await page.pressEnter(PASSWORD_FIELD);
          passwordSent = true;
          sawForm = true;
          step("login form sent");
        } else if (emailFilled && !emailSent) {
          // A login in two steps: the address first, the password on the next screen.
          await page.pressEnter(EMAIL_FIELD);
          emailSent = true;
        } else if (!emailFilled && clicks < 3) {
          if (await page.clickButton(SKIP_BUTTONS)) clicks++;
        }
      }
      await sleep(pollMs);
    }
    if (credentials && !sawForm) {
      return await fail("no_login_form", "no login form showed up");
    }
    return await fail(
      "not_logged_in",
      credentials
        ? "the login form was sent, but no session followed"
        : "no login within the time limit",
    );
  } catch (error) {
    // A fixed text: the browser's own message can carry the typed password.
    return await fail("error", browserFailureDetail(error));
  } finally {
    // A browser that hangs on close must not keep the login marked as running.
    if (context) await closeWithin(context, CLOSE_TIMEOUT_MS);
  }
}
