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
// Both sites put consent dialogs in front of the page. After every navigation and every
// click the flow looks for one for up to 3 seconds and declines it, or closes it; it never
// accepts. After the form is sent it watches for the session, an error message on the form
// and a captcha or verification step, and ends the attempt with the matching reason.
//
// The Lidl login comes in two steps: the e-mail address and "Weiter", then the password and
// "Weiter". The page may open asking for a phone number; the flow then clicks the link to
// the e-mail address and never touches the country selector or the phone field. Enter is
// pressed only in a visible e-mail or password field, when the page has no button to click.
//
// On the first login monsieur-cuisine.com may ask for the terms of use and the device before
// it sets the session. When the session has not come 10 seconds after the redirect, the
// automatic login ticks the terms checkbox, confirms it, picks MC Smart and closes the hint
// next to the chooser; the result says so, and the settings page shows it.
//
// The browser sits behind LoginBrowser, so tests drive the flow with a fake and the bridge
// starts without Playwright. A persistent profile keeps the Lidl login between runs, so a
// later run often finishes without the password.

import {
  ACCEPT_BUTTON,
  CAPTCHA_FRAME,
  CLOSE_LABEL,
  CLOSE_SYMBOL,
  CONTINUE_BUTTON,
  DECLINE_BUTTON,
  DEVICE_CHOICE,
  DEVICE_PROMPT,
  DIALOG_SELECTOR,
  EMAIL_SWITCH,
  ERROR_SELECTOR,
  HINT_BUTTON,
  IGNORED_FRAME,
  MAX_ERROR_LENGTH,
  NEW_ACCOUNT_TEXT,
  OPTIONAL_CONSENT,
  OTHER_DEVICES,
  OTHER_PROVIDER,
  PHONE_FIELD,
  PHONE_WORDS,
  SIGN_IN_BUTTON,
  SKIP_BUTTONS,
  TERMS_CONFIRM,
  TERMS_LABEL,
  UNKNOWN_ACCOUNT,
  VERIFICATION_TEXT,
  WRONG_PASSWORD,
} from "./login-pages.js";

export const MC_BASE_URL = "https://www.monsieur-cuisine.com";

// Selectors of the Lidl login form.
export const EMAIL_FIELD = 'input[type="email"]';
export const PASSWORD_FIELD = 'input[type="password"]';
export { SKIP_BUTTONS };

// After each navigation the flow looks up to this long for a consent dialog to decline; it
// stops at once when the page has no dialog.
export const CONSENT_WINDOW_MS = 3000;
export const CONSENT_POLL_MS = 500;
// How long the Lidl page may take to show its e-mail field.
export const EMAIL_WAIT_MS = 15_000;
// Clicks on the link from the phone login to the e-mail address.
export const MAX_SWITCH_CLICKS = 2;
// How long after the redirect to monsieur-cuisine.com the session may take before the flow
// looks for the terms of use and the device chooser.
export const ONBOARDING_AFTER_MS = 10_000;
// What a click on a welcome screen skips: registrations, consent buttons and the phone login.
const WELCOME_SKIP = new RegExp(`${SKIP_BUTTONS.source}|${PHONE_WORDS.source}`, "iu");
// What a click that sends the form or switches it skips: the same, and other identity
// providers ("Weiter mit Google").
const FORM_SKIP = new RegExp(`${WELCOME_SKIP.source}|${OTHER_PROVIDER.source}`, "iu");
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
  // Clicks the first visible and enabled button, in the page or one of its frames, whose
  // text matches `match` and not `avoid`; returns its text, or null when there is none.
  clickButtonByText(match: RegExp, avoid: RegExp): Promise<string | null>;
  // Like clickButtonByText, for links and other controls as well (labels, radios, options).
  // With `anyElement`, falls back to any visible element whose text matches, such as a card.
  clickByText(
    match: RegExp,
    avoid: RegExp,
    options?: { anyElement?: boolean },
  ): Promise<string | null>;
  // Ticks the first visible checkbox whose label matches `label` and not `avoid`. True when
  // such a checkbox is ticked afterwards, also when it was ticked already; never unticks.
  checkBox(label: RegExp, avoid: RegExp): Promise<boolean>;
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
}

export interface LoginBrowser {
  // Null when a browser can be started, otherwise why not.
  unavailable(): Promise<string | null>;
  // A browser with a persistent profile: cookies and the Lidl login survive between runs.
  open(options: { profileDir: string; headless: boolean }): Promise<LoginContext>;
}

export type BrowserLoginFailure =
  // Playwright or its Chromium is not installed.
  | "browser_unavailable"
  // No login form showed up: a changed page, a captcha or a consent screen.
  | "no_login_form"
  // The site does not know the e-mail address, or offers to create an account for it.
  | "unknown_account"
  // The site answered the form with a message that the password is wrong.
  | "wrong_password"
  // The site asked for a captcha or a verification code.
  | "verification_required"
  // The form was sent, or the person did not log in, but no session followed: another
  // error message of the site, or nothing at all within the time limit.
  | "not_logged_in"
  // The browser failed.
  | "error";

// What the flow did on the person's behalf: declined or closed a consent dialog, confirmed
// the terms of use of monsieur-cuisine.com, chose MC Smart in the device chooser.
export interface LoginNotes {
  consentDismissed?: true;
  termsAccepted?: true;
  deviceChosen?: true;
}

export type BrowserLoginResult =
  | ({ ok: true; cookie: string } & LoginNotes)
  | ({
      ok: false;
      code: BrowserLoginFailure;
      detail: string;
      screenshot: string | null;
    } & LoginNotes);

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

// A message of the site for the log: one line, without the e-mail address.
export function siteMessage(text: string, email: string): string {
  let line = text.replace(/\s+/g, " ").trim();
  if (email !== "") line = line.split(email).join("<e-mail>");
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

export const CLOSE_TIMEOUT_MS = 10_000;

export async function closeWithin(context: Pick<LoginContext, "close">, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    context.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
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
  const deadline = now() + options.timeoutMs;

  let context: LoginContext | null = null;
  let sawForm = false;
  let emailFilled = false;
  let emailSent = false;
  let passwordSent = false;
  let clicks = 0;
  let switchClicks = 0;
  let consentDismissed = false;
  let termsAccepted = false;
  let deviceChosen = false;
  let consentPending = true;
  let lastUrl: string | null = null;
  // When the flow came to the Lidl page without an e-mail field, and to monsieur-cuisine.com
  // without a session.
  let lidlSince: number | null = null;
  let siteSince: number | null = null;
  // A message the form showed before it was sent is not an answer to it.
  let messageBefore: string | null = null;
  let indicator: { key: string; count: number } | null = null;

  const consent = (): LoginNotes => ({
    ...(consentDismissed ? { consentDismissed: true } : {}),
    ...(termsAccepted ? { termsAccepted: true } : {}),
    ...(deviceChosen ? { deviceChosen: true } : {}),
  });

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

  // Declines or closes consent dialogs for up to CONSENT_WINDOW_MS. Stops early when the page
  // has no dialog, once a dialog was dismissed and the next look finds none, or once the
  // session exists.
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
      } else if (dismissed || !(await page.isVisible(DIALOG_SELECTOR))) {
        return;
      }
      await sleep(CONSENT_POLL_MS);
    }
  };

  const verificationShown = async (page: LoginPage): Promise<boolean> => {
    const frames = await page.frameSources();
    if (frames.some((src) => CAPTCHA_FRAME.test(src) && !IGNORED_FRAME.test(src))) return true;
    return hostOf(page.url()).endsWith("lidl.com") && VERIFICATION_TEXT.test(await page.text());
  };

  // What the site answered to the sent form, once it showed on INDICATOR_POLLS polls in a
  // row; null while there is no answer yet.
  const answer = async (page: LoginPage, email: string): Promise<Outcome | null> => {
    const message = await page.visibleMessage(ERROR_SELECTOR, MAX_ERROR_LENGTH);
    let found: Outcome | null = null;
    if (message !== null && message !== messageBefore) {
      const quoted = `"${siteMessage(message, email)}"`;
      if (passwordSent && WRONG_PASSWORD.test(message)) {
        found = {
          code: "wrong_password",
          detail: `wrong password reported by the site: ${quoted}`,
          step: "wrong password reported by the site",
        };
      } else if (!passwordSent && UNKNOWN_ACCOUNT.test(message)) {
        found = {
          code: "unknown_account",
          detail: `the site does not know the e-mail address: ${quoted}`,
          step: "the site does not know the e-mail address",
        };
      } else {
        found = {
          code: "not_logged_in",
          detail: `the site reported an error: ${quoted}`,
          step: "the site reported an error",
        };
      }
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

  // Sends a step of the form with its button; Enter only when there is no button and the
  // field is still visible.
  const submit = async (page: LoginPage, field: string, buttons: readonly RegExp[]) => {
    for (const button of buttons) {
      if ((await page.clickButtonByText(button, FORM_SKIP)) !== null) return;
    }
    if (await page.isVisible(field)) await page.pressEnter(field);
  };

  // One step of the Lidl form; an outcome when the attempt has to end.
  const fillForm = async (
    page: LoginPage,
    login: { email: string; password: string },
  ): Promise<Outcome | null> => {
    if (!emailFilled && (await page.fillVisible(EMAIL_FIELD, login.email))) {
      emailFilled = true;
      sawForm = true;
      step("e-mail address entered");
    }
    if (await page.isVisible(PASSWORD_FIELD)) {
      if (emailSent && NEW_ACCOUNT_TEXT.test(await page.text())) {
        return {
          code: "unknown_account",
          detail: "the site offers to create a new account for the e-mail address",
          step: "the site does not know the e-mail address",
        };
      }
      if (!(await page.fillVisible(PASSWORD_FIELD, login.password))) return null;
      messageBefore = await page.visibleMessage(ERROR_SELECTOR, MAX_ERROR_LENGTH);
      await submit(page, PASSWORD_FIELD, [CONTINUE_BUTTON, SIGN_IN_BUTTON]);
      passwordSent = true;
      sawForm = true;
      consentPending = true;
      indicator = null;
      step("login form sent");
      return null;
    }
    if (emailFilled) {
      if (!emailSent) {
        // A login in two steps: the address first, the password on the next screen.
        messageBefore = await page.visibleMessage(ERROR_SELECTOR, MAX_ERROR_LENGTH);
        await submit(page, EMAIL_FIELD, [CONTINUE_BUTTON]);
        emailSent = true;
        consentPending = true;
        indicator = null;
        step("e-mail address sent");
      }
      return null;
    }
    if (!hostOf(page.url()).endsWith("lidl.com")) return null;
    // The Lidl page without a usable e-mail field. A visible one that is still disabled is
    // waited for; otherwise the page is the phone login or a welcome screen.
    lidlSince ??= now();
    if (!(await page.isVisible(EMAIL_FIELD))) {
      if (
        switchClicks < MAX_SWITCH_CLICKS &&
        (await page.clickByText(EMAIL_SWITCH, FORM_SKIP)) !== null
      ) {
        switchClicks++;
        consentPending = true;
        step("switched the Lidl login from the phone number to the e-mail address");
        return null;
      }
      if (
        clicks < 3 &&
        !(await page.isVisible(PHONE_FIELD)) &&
        (await page.clickButton(WELCOME_SKIP))
      ) {
        clicks++;
        consentPending = true;
        return null;
      }
    }
    if (now() - lidlSince >= EMAIL_WAIT_MS) {
      return {
        code: "no_login_form",
        detail: "no e-mail field showed up on the Lidl login page",
        step: "no e-mail field on the Lidl login page",
      };
    }
    return null;
  };

  // The first-login screens of monsieur-cuisine.com: the terms of use, the device chooser
  // and its hint. One action per call; consent dialogs are looked for after each.
  const finishOnboarding = async (page: LoginPage) => {
    if (!termsAccepted && (await page.checkBox(TERMS_LABEL, OPTIONAL_CONSENT))) {
      if ((await page.clickButtonByText(TERMS_CONFIRM, SKIP_BUTTONS)) !== null) {
        termsAccepted = true;
        consentPending = true;
        step("terms of use confirmed");
        return;
      }
    }
    if (!deviceChosen && !DEVICE_PROMPT.test(await page.text())) return;
    if (
      !deviceChosen &&
      (await page.clickByText(DEVICE_CHOICE, OTHER_DEVICES, { anyElement: true })) !== null
    ) {
      deviceChosen = true;
      consentPending = true;
      step("device MC Smart chosen");
      return;
    }
    if ((await page.clickButtonByText(HINT_BUTTON, SKIP_BUTTONS)) !== null) {
      consentPending = true;
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
        if (!passwordSent) {
          const outcome = await fillForm(page, credentials);
          if (outcome !== null) {
            step(outcome.step);
            return await fail(outcome.code, outcome.detail);
          }
        }
        if (hostOf(url) === hostOf(baseUrl)) {
          siteSince ??= now();
          if (now() - siteSince >= ONBOARDING_AFTER_MS) await finishOnboarding(page);
        } else {
          siteSince = null;
        }
      }
      await sleep(pollMs);
    }
    if (credentials && !sawForm) {
      return await fail("no_login_form", "no login form showed up");
    }
    let detail = "no login within the time limit";
    if (credentials) {
      detail =
        emailSent && !passwordSent
          ? "the e-mail address was sent, but no password field followed"
          : "the login form was sent, but no session followed";
    }
    return await fail("not_logged_in", detail);
  } catch (error) {
    return await fail("error", error instanceof Error ? error.message : String(error));
  } finally {
    // A browser that hangs on close must not keep the login marked as running.
    if (context) await closeWithin(context, CLOSE_TIMEOUT_MS);
  }
}
