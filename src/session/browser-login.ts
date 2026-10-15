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
// Both sites put consent dialogs in front of the page. After every navigation and every
// click the flow looks for one for a few seconds and declines it, or closes it; it never
// accepts. After the form is sent it watches for the session, an error message on the form
// and a captcha or verification step, and ends the attempt with the matching reason.
//
// The browser sits behind LoginBrowser, so tests drive the flow with a fake and the bridge
// starts without Playwright. The automatic login gives every attempt a fresh profile;
// npm run mc:login keeps a persistent one on the operator's computer.

import { browserFailureDetail } from "./browser-errors.js";
import {
  ACCEPT_BUTTON,
  CAPTCHA_FRAME,
  CLOSE_LABEL,
  CLOSE_SYMBOL,
  CONTINUE_BUTTON,
  DECLINE_BUTTON,
  ERROR_SELECTOR,
  IGNORED_FRAME,
  MAX_ERROR_LENGTH,
  SKIP_BUTTONS,
  VERIFICATION_TEXT,
  WRONG_PASSWORD,
} from "./login-pages.js";

export const MC_BASE_URL = "https://www.monsieur-cuisine.com";

// The hosts of the Lidl account pages the login form may be filled on.
export const DEFAULT_LOGIN_HOSTS: readonly string[] = ["accounts.lidl.com"];

// Selectors of the Lidl login form.
export const EMAIL_FIELD = 'input[type="email"]';
export const PASSWORD_FIELD = 'input[type="password"]';
export { SKIP_BUTTONS };

// After each navigation the flow looks this long for a consent dialog to decline.
export const CONSENT_WINDOW_MS = 5000;
export const CONSENT_POLL_MS = 500;
// Close buttons clicked per look, so a close button that stays does not get clicked forever.
export const MAX_CLOSE_CLICKS = 2;
// An error message or a captcha must show on this many polls in a row to end the login.
export const INDICATOR_POLLS = 2;

export interface BrowserCookie {
  name: string;
  value: string;
}

// What the flow needs from a browser page.
export interface LoginPage {
  goto(url: string): Promise<void>;
  url(): string;
  // Fills the first visible and enabled element matching the CSS selector; false when none.
  fillVisible(selector: string, value: string): Promise<boolean>;
  // Whether an element matching the selector is visible.
  isVisible(selector: string): Promise<boolean>;
  // Presses Enter in the first visible element matching the selector.
  pressEnter(selector: string): Promise<void>;
  // Clicks the first visible button whose text does not match `skip`; false when none.
  clickButton(skip: RegExp): Promise<boolean>;
  // Clicks the first visible button, in the page or one of its frames, whose text matches
  // `match` and not `avoid`; returns its text, or null when there is none.
  clickButtonByText(match: RegExp, avoid: RegExp): Promise<string | null>;
  // Clicks a visible control that closes a dialog: a button whose accessible name matches
  // `label`, or a button inside a dialog whose text matches `symbol`. False when none.
  closeDialog(label: RegExp, symbol: RegExp): Promise<boolean>;
  // The text of the first visible, non-empty element matching the selector that is at most
  // `maxLength` characters long; null when there is none.
  visibleMessage(selector: string, maxLength: number): Promise<string | null>;
  // The sources of the visible frames of the page.
  frameSources(): Promise<string[]>;
  // The visible text of the page.
  text(): Promise<string>;
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
  // The site answered the form with a message that the password is wrong.
  | "wrong_password"
  // The site asked for a captcha or a verification code.
  | "verification_required"
  // The form was sent, or the person did not log in, but no session followed: another
  // error message of the site, or nothing at all within the time limit.
  | "not_logged_in"
  // A password field showed up on a page that is not a login host over https.
  | "unexpected_page"
  // The browser failed.
  | "error";

// consentDismissed is set when the flow declined or closed a consent dialog on the way.
export type BrowserLoginResult =
  | { ok: true; cookie: string; consentDismissed?: true }
  | {
      ok: false;
      code: BrowserLoginFailure;
      detail: string;
      screenshot: string | null;
      consentDismissed?: true;
    };

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

// A message of the site for the log: one line, without the e-mail address.
export function siteMessage(text: string, email: string): string {
  let line = text.replace(/\s+/g, " ").trim();
  if (email !== "") line = line.split(email).join("<e-mail>");
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
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

interface Outcome {
  code: BrowserLoginFailure;
  detail: string;
  step: string;
}

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
  let consentDismissed = false;
  let consentPending = true;
  let lastUrl: string | null = null;
  // A message the form showed before it was sent is not an answer to it.
  let messageBefore: string | null = null;
  let indicator: { key: string; count: number } | null = null;

  const consent = (): { consentDismissed?: true } =>
    consentDismissed ? { consentDismissed: true } : {};

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
    return { ok: false, code, detail, screenshot, ...consent() };
  };

  // Declines or closes consent dialogs for up to CONSENT_WINDOW_MS. Stops early once a
  // dialog was dismissed and the next look finds none, or once the session exists.
  const dismissConsent = async (context: LoginContext): Promise<void> => {
    const page = context.page;
    const until = Math.min(now() + CONSENT_WINDOW_MS, deadline);
    let dismissed = false;
    let closes = 0;
    while (now() < until) {
      // A saved profile logs in through redirects; no need to wait for a dialog then.
      if ((await readSessionCookie(context, options.editorPath, baseUrl)) !== null) return;
      let done = (await page.clickButtonByText(DECLINE_BUTTON, ACCEPT_BUTTON)) !== null;
      if (
        !done &&
        closes < MAX_CLOSE_CLICKS &&
        (await page.closeDialog(CLOSE_LABEL, CLOSE_SYMBOL))
      ) {
        closes++;
        done = true;
      }
      if (done) {
        dismissed = true;
        consentDismissed = true;
        step("consent dialog dismissed");
      } else if (dismissed) {
        return;
      }
      await sleep(CONSENT_POLL_MS);
    }
  };

  const verificationShown = async (page: LoginPage): Promise<boolean> => {
    const frames = await page.frameSources();
    if (frames.some((src) => CAPTCHA_FRAME.test(src) && !IGNORED_FRAME.test(src))) return true;
    return onLoginHost(page.url(), loginHosts) && VERIFICATION_TEXT.test(await page.text());
  };

  // What the site answered to the sent form, once it showed on INDICATOR_POLLS polls in a
  // row; null while there is no answer yet.
  const answer = async (page: LoginPage, email: string): Promise<Outcome | null> => {
    const message = await page.visibleMessage(ERROR_SELECTOR, MAX_ERROR_LENGTH);
    let found: Outcome | null = null;
    if (message !== null && message !== messageBefore) {
      const quoted = `"${siteMessage(message, email)}"`;
      found =
        passwordSent && WRONG_PASSWORD.test(message)
          ? {
              code: "wrong_password",
              detail: `wrong password reported by the site: ${quoted}`,
              step: "wrong password reported by the site",
            }
          : {
              code: "not_logged_in",
              detail: `the site reported an error: ${quoted}`,
              step: "the site reported an error",
            };
    } else if (await verificationShown(page)) {
      found = {
        code: "verification_required",
        detail: "captcha or verification requested",
        step: "captcha or verification requested",
      };
    }
    if (found === null) {
      indicator = null;
      return null;
    }
    const key = `${found.code} ${found.detail}`;
    indicator = indicator?.key === key ? { key, count: indicator.count + 1 } : { key, count: 1 };
    return indicator.count >= INDICATOR_POLLS ? found : null;
  };

  const fillForm = async (page: LoginPage, login: { email: string; password: string }) => {
    if (!emailFilled && (await page.fillVisible(EMAIL_FIELD, login.email))) {
      emailFilled = true;
      sawForm = true;
      step("e-mail address entered");
    }
    if (await page.fillVisible(PASSWORD_FIELD, login.password)) {
      messageBefore = await page.visibleMessage(ERROR_SELECTOR, MAX_ERROR_LENGTH);
      await page.pressEnter(PASSWORD_FIELD);
      passwordSent = true;
      sawForm = true;
      consentPending = true;
      indicator = null;
      step("login form sent");
    } else if (emailFilled && !emailSent) {
      // A login in two steps: the address first, the password on the next screen.
      messageBefore = await page.visibleMessage(ERROR_SELECTOR, MAX_ERROR_LENGTH);
      if ((await page.clickButtonByText(CONTINUE_BUTTON, SKIP_BUTTONS)) === null) {
        await page.pressEnter(EMAIL_FIELD);
      }
      emailSent = true;
      consentPending = true;
      step("e-mail address sent");
    } else if (!emailFilled && clicks < 3) {
      if (await page.clickButton(SKIP_BUTTONS)) {
        clicks++;
        consentPending = true;
      }
    }
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
        return { ok: true, cookie, ...consent() };
      }
      const page = context.page;
      const url = page.url();
      if (url !== lastUrl) {
        lastUrl = url;
        consentPending = true;
      }
      if (consentPending) {
        consentPending = false;
        await dismissConsent(context);
        continue;
      }
      if (credentials) {
        if (emailSent || passwordSent) {
          const outcome = await answer(page, credentials.email);
          if (outcome !== null) {
            step(outcome.step);
            return await fail(outcome.code, outcome.detail);
          }
        }
        if (!passwordSent && !onLoginHost(page.url(), loginHosts)) {
          // Never type the account into a page that is not the Lidl login.
          if (await page.isVisible(PASSWORD_FIELD)) {
            step("login form on an unexpected page");
            return await fail(
              "unexpected_page",
              `a login form showed up on an unexpected page (${hostOf(page.url()) || "no host"})`,
            );
          }
        } else if (!passwordSent) {
          await fillForm(page, credentials);
        } else if (
          clicks < 3 &&
          onLoginHost(page.url(), loginHosts) &&
          !(await page.isVisible(PASSWORD_FIELD))
        ) {
          // A welcome screen after the form.
          if (await page.clickButton(SKIP_BUTTONS)) {
            clicks++;
            consentPending = true;
          }
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
