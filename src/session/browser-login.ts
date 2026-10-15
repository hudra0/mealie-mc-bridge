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
// Both sites put consent dialogs in front of the page, and the Lidl dialog can render a
// moment after the page itself. So the flow looks for a dialog before every action (fill,
// click, Enter) and on every poll while it waits for the form, and declines it inside the
// dialog, or closes it; it never accepts. An action gets 1 second first; when it times out
// (most often because a dialog came up over the element), the flow dismisses dialogs and
// tries once more with the browser's full timeout. Between actions it pauses a few hundred
// milliseconds, like a person. After the form is sent it watches for the session, an error
// message on the form and a captcha or verification step, and ends the attempt with the
// matching reason.
//
// The Lidl login comes in two steps: the e-mail address and "Weiter", then the password and
// "Weiter". The page may open asking for a phone number; the flow then clicks the control
// that switches to the e-mail address (a button, a link or any element with its text) and
// never touches the country selector or the phone field. Enter is pressed only in a visible
// e-mail or password field, when the page has no button to click.
//
// On the first login monsieur-cuisine.com may ask for the terms of use and the device before
// it sets the session. When the session has not come 10 seconds after the redirect, the
// automatic login ticks the terms checkbox, confirms it, picks MC Smart and closes the hint
// next to the chooser; the result says so, and the settings page shows it.
//
// Every attempt records how far it got (LOGIN_STEPS); a failure names the last step reached
// in its reason ("stuck after: e-mail entered").
//
// The browser sits behind LoginBrowser, so tests drive the flow with a fake and the bridge
// starts without Playwright. The automatic login gives every attempt a fresh profile;
// npm run mc:login keeps a persistent one on the operator's computer.

import { BrowserActionError, browserFailureDetail } from "./browser-errors.js";
import {
  CAPTCHA_FRAME,
  CONSENT_DIALOG,
  CONTINUE_BUTTON,
  CONTINUE_EXACT,
  DEVICE_CHOICE,
  DEVICE_PROMPT,
  EMAIL_SWITCH,
  EMAIL_SWITCH_TEXT,
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
  SIGN_IN_EXACT,
  SKIP_BUTTONS,
  TERMS_CONFIRM,
  TERMS_LABEL,
  UNKNOWN_ACCOUNT,
  VERIFICATION_TEXT,
  WRONG_PASSWORD,
  type DialogPatterns,
} from "./login-pages.js";

export const MC_BASE_URL = "https://www.monsieur-cuisine.com";

// The hosts of the Lidl account pages the login form may be filled on.
export const DEFAULT_LOGIN_HOSTS: readonly string[] = ["accounts.lidl.com"];

// Selectors of the Lidl login form. The e-mail field is looked up by its id as well, in case
// its type changes.
export const EMAIL_FIELD = 'input[type="email"]';
export const EMAIL_FIELD_BY_ID = "input#input-email";
export const PASSWORD_FIELD = 'input[type="password"]';
export { SKIP_BUTTONS };

// How long the first try of an action may wait before the flow looks for a dialog in front
// of the page and tries once more with the browser's full timeout.
export const FIRST_TRY_MS = 1000;
// How long a dismissed dialog may take to go away.
export const DIALOG_GONE_MS = 3000;
// Dialogs dismissed per look, so a dialog that keeps coming back does not hold the flow.
export const MAX_DIALOGS_PER_LOOK = 3;
// Close clicks per attempt, so a close control that does nothing is not clicked forever.
export const MAX_CLOSE_CLICKS = 4;
// Without stored credentials a person may be at the window: the flow then looks for dialogs
// only this long after each navigation.
export const CONSENT_WINDOW_MS = 3000;
// The pause after each action, between these bounds, like a person.
export const ACTION_PAUSE_MS = { min: 300, max: 700 } as const;
// How long the Lidl page may take to show its e-mail field.
export const EMAIL_WAIT_MS = 15_000;
// Clicks on the control from the phone login to the e-mail address.
export const MAX_SWITCH_CLICKS = 2;
// How long after the redirect to monsieur-cuisine.com the session may take before the flow
// looks for the terms of use and the device chooser.
export const ONBOARDING_AFTER_MS = 10_000;
// What a click on a welcome screen skips: registrations, consent buttons and the phone login.
const WELCOME_SKIP = new RegExp(`${SKIP_BUTTONS.source}|${PHONE_WORDS.source}`, "iu");
// What a click that sends the form or switches it skips: the same, and other identity
// providers ("Weiter mit Google").
const FORM_SKIP = new RegExp(`${WELCOME_SKIP.source}|${OTHER_PROVIDER.source}`, "iu");
// An error message or a captcha must show on this many polls in a row to end the login.
export const INDICATOR_POLLS = 2;

// The steps of a login, in the order they happen. A failure names the last one reached.
export const LOGIN_STEPS = [
  "page_reached",
  "consent_dismissed",
  "email_entered",
  "continue_clicked",
  "password_page",
  "password_entered",
  "redirect_reached",
  "terms_confirmed",
  "device_chosen",
  "cookies_received",
] as const;
export type LoginStep = (typeof LOGIN_STEPS)[number];

// The steps in the reason of a failure, which is English like the rest of it.
export const LOGIN_STEP_TEXT: Readonly<Record<LoginStep, string>> = {
  page_reached: "login page reached",
  consent_dismissed: "consent dismissed",
  email_entered: "e-mail entered",
  continue_clicked: "continue clicked",
  password_page: "password page reached",
  password_entered: "password entered",
  redirect_reached: "redirect reached",
  terms_confirmed: "terms confirmed",
  device_chosen: "device chosen",
  cookies_received: "cookies received",
};

// How far an attempt got: the steps reached, in LOGIN_STEPS order, and how many dialogs it
// dismissed on the way.
export interface LoginProgress {
  reached: LoginStep[];
  consentDismissals: number;
}

// "; stuck after: e-mail entered" for the reason of a failure; empty when no step was reached.
export function stuckAfter(progress: LoginProgress): string {
  const last = progress.reached[progress.reached.length - 1];
  return last === undefined ? "" : `; stuck after: ${LOGIN_STEP_TEXT[last]}`;
}

export interface BrowserCookie {
  name: string;
  value: string;
}

// Options of an action. Without timeoutMs the browser's own action timeout applies.
export interface ActionOptions {
  timeoutMs?: number;
}

// How a dialog was dismissed.
export type DialogAction = "declined" | "closed";

// What the flow needs from a browser page. Every action works on visible elements only.
export interface LoginPage {
  goto(url: string): Promise<void>;
  url(): string;
  // Fills the first visible and enabled element matching the CSS selector; false when none.
  fillVisible(selector: string, value: string, options?: ActionOptions): Promise<boolean>;
  // Whether an element matching the selector is visible.
  isVisible(selector: string): Promise<boolean>;
  // Presses Enter in the first visible element matching the selector.
  pressEnter(selector: string, options?: ActionOptions): Promise<void>;
  // Clicks the first visible button whose text does not match `skip`; false when none.
  clickButton(skip: RegExp, options?: ActionOptions): Promise<boolean>;
  // Clicks the first visible and enabled button, in the page or one of its frames, whose
  // text matches `match` and not `avoid`, preferring one whose text matches `exact`; returns
  // its text, or null when there is none.
  clickButtonByText(
    match: RegExp,
    avoid: RegExp,
    options?: ActionOptions & { exact?: RegExp },
  ): Promise<string | null>;
  // Like clickButtonByText, for links and other controls as well (labels, radios, options).
  // With `anyElement`, falls back to any visible element whose text matches, such as a card.
  clickByText(
    match: RegExp,
    avoid: RegExp,
    options?: ActionOptions & { anyElement?: boolean },
  ): Promise<string | null>;
  // Ticks the first visible checkbox whose label matches `label` and not `avoid`. True when
  // such a checkbox is ticked afterwards, also when it was ticked already; never unticks.
  checkBox(label: RegExp, avoid: RegExp, options?: ActionOptions): Promise<boolean>;
  // Dismisses one visible dialog: clicks the decline button inside it, else (with `close`)
  // its close control, then waits up to `waitMs` until the dialog is hidden or gone. Never
  // clicks an accept button or a hidden element. Null when no dialog could be dismissed.
  dismissDialog(
    patterns: DialogPatterns,
    options: { close: boolean; waitMs: number },
  ): Promise<DialogAction | null>;
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
  // The site does not know the e-mail address, or offers to create an account for it.
  | "unknown_account"
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

// What the flow did on the person's behalf: declined or closed a consent dialog, confirmed
// the terms of use of monsieur-cuisine.com, chose MC Smart in the device chooser; and how
// far it got. browserLogin always sets progress.
export interface LoginNotes {
  consentDismissed?: true;
  termsAccepted?: true;
  deviceChosen?: true;
  progress?: LoginProgress;
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
  // The hosts the form may be filled on; DEFAULT_LOGIN_HOSTS when left out.
  loginHosts?: readonly string[];
  timeoutMs: number;
  pollMs?: number;
  // Where to save a screenshot when the login fails; null skips it.
  screenshotPath?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // A number in [0, 1) for the pauses between actions; Math.random by default.
  random?: () => number;
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

// A timeout of a single action, as the browser adapter reports it.
function isActionTimeout(error: unknown): boolean {
  return error instanceof BrowserActionError && error.kind === "timeout";
}

export async function browserLogin(options: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const reached = new Set<LoginStep>();
  let consentDismissals = 0;
  const progress = (): LoginProgress => ({
    reached: LOGIN_STEPS.filter((name) => reached.has(name)),
    consentDismissals,
  });
  const unavailable = await options.browser.unavailable();
  if (unavailable !== null) {
    return {
      ok: false,
      code: "browser_unavailable",
      detail: unavailable,
      screenshot: null,
      progress: progress(),
    };
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
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
  let switchClicks = 0;
  let closeClicks = 0;
  let termsAccepted = false;
  let deviceChosen = false;
  let lastUrl: string | null = null;
  // Without credentials, dialogs are looked for until this time after a navigation.
  let watchDialogsUntil = 0;
  // When the flow came to the Lidl page without an e-mail field, and to monsieur-cuisine.com
  // without a session.
  let lidlSince: number | null = null;
  let siteSince: number | null = null;
  // A message the form showed before it was sent is not an answer to it.
  let messageBefore: string | null = null;
  let indicator: { key: string; count: number } | null = null;

  const notes = (): LoginNotes => ({
    ...(consentDismissals > 0 ? { consentDismissed: true } : {}),
    ...(termsAccepted ? { termsAccepted: true } : {}),
    ...(deviceChosen ? { deviceChosen: true } : {}),
    progress: progress(),
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
    return {
      ok: false,
      code,
      detail: `${detail}${stuckAfter(progress())}`,
      screenshot,
      ...notes(),
    };
  };

  const pause = () =>
    sleep(Math.round(ACTION_PAUSE_MS.min + random() * (ACTION_PAUSE_MS.max - ACTION_PAUSE_MS.min)));

  // Declines or closes the dialogs in front of the page, a few per look. A dialog that does
  // not take the click does not end the login: the action behind it reports what is wrong.
  const dismissDialogs = async (page: LoginPage): Promise<void> => {
    for (let look = 0; look < MAX_DIALOGS_PER_LOOK; look++) {
      let action: DialogAction | null;
      try {
        action = await page.dismissDialog(CONSENT_DIALOG, {
          close: closeClicks < MAX_CLOSE_CLICKS,
          waitMs: DIALOG_GONE_MS,
        });
      } catch (error) {
        if (error instanceof BrowserActionError) return;
        throw error;
      }
      if (action === null) return;
      if (action === "closed") closeClicks++;
      consentDismissals++;
      reached.add("consent_dismissed");
      step("consent dialog dismissed");
      await pause();
    }
  };

  // One page action: dialogs are dismissed first; a first try that times out, most often
  // because a dialog came up over the element, is followed by another look for dialogs and
  // one more try with the browser's full timeout. A pause follows every action that did
  // something.
  const act = async <T>(page: LoginPage, action: (options: ActionOptions) => Promise<T>) => {
    await dismissDialogs(page);
    let result: T;
    try {
      result = await action({ timeoutMs: FIRST_TRY_MS });
    } catch (error) {
      if (!isActionTimeout(error)) throw error;
      await dismissDialogs(page);
      result = await action({});
    }
    if (result !== null && result !== false) await pause();
    return result;
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

  // Sends a step of the form with its button, the one with the exact text first; Enter only
  // when there is no button and the field is still visible.
  const submit = async (
    page: LoginPage,
    field: string,
    buttons: readonly (readonly [RegExp, RegExp])[],
  ) => {
    for (const [button, exact] of buttons) {
      const clicked = await act(page, (o) =>
        page.clickButtonByText(button, FORM_SKIP, { ...o, exact }),
      );
      if (clicked !== null) return;
    }
    if (await page.isVisible(field)) await act(page, (o) => page.pressEnter(field, o));
  };

  const emailVisible = async (page: LoginPage) =>
    (await page.isVisible(EMAIL_FIELD)) || (await page.isVisible(EMAIL_FIELD_BY_ID));

  const fillEmail = async (page: LoginPage, email: string) =>
    (await act(page, (o) => page.fillVisible(EMAIL_FIELD, email, o))) ||
    (await act(page, (o) => page.fillVisible(EMAIL_FIELD_BY_ID, email, o)));

  // The control from the phone login to the e-mail address: a button or a link, else any
  // element that carries one of the switch phrases.
  const switchToEmail = async (page: LoginPage) =>
    (await act(page, (o) => page.clickByText(EMAIL_SWITCH, FORM_SKIP, o))) ??
    (await act(page, (o) =>
      page.clickByText(EMAIL_SWITCH_TEXT, FORM_SKIP, { ...o, anyElement: true }),
    ));

  // One step of the Lidl form; an outcome when the attempt has to end.
  const fillForm = async (
    page: LoginPage,
    login: { email: string; password: string },
  ): Promise<Outcome | null> => {
    if (!emailFilled && (await fillEmail(page, login.email))) {
      emailFilled = true;
      sawForm = true;
      reached.add("email_entered");
      step("e-mail address entered");
    }
    if (await page.isVisible(PASSWORD_FIELD)) {
      reached.add("password_page");
      if (emailSent && NEW_ACCOUNT_TEXT.test(await page.text())) {
        return {
          code: "unknown_account",
          detail: "the site offers to create a new account for the e-mail address",
          step: "the site does not know the e-mail address",
        };
      }
      if (!(await act(page, (o) => page.fillVisible(PASSWORD_FIELD, login.password, o)))) {
        return null;
      }
      reached.add("password_entered");
      messageBefore = await page.visibleMessage(ERROR_SELECTOR, MAX_ERROR_LENGTH);
      await submit(page, PASSWORD_FIELD, [
        [CONTINUE_BUTTON, CONTINUE_EXACT],
        [SIGN_IN_BUTTON, SIGN_IN_EXACT],
      ]);
      passwordSent = true;
      sawForm = true;
      indicator = null;
      step("login form sent");
      return null;
    }
    if (emailFilled) {
      if (!emailSent) {
        // A login in two steps: the address first, the password on the next screen.
        messageBefore = await page.visibleMessage(ERROR_SELECTOR, MAX_ERROR_LENGTH);
        const field = (await page.isVisible(EMAIL_FIELD)) ? EMAIL_FIELD : EMAIL_FIELD_BY_ID;
        await submit(page, field, [[CONTINUE_BUTTON, CONTINUE_EXACT]]);
        emailSent = true;
        indicator = null;
        reached.add("continue_clicked");
        step("e-mail address sent");
      }
      return null;
    }
    if (!onLoginHost(page.url(), loginHosts)) return null;
    // The Lidl page without a usable e-mail field. A visible one that is still disabled is
    // waited for; otherwise the page is the phone login or a welcome screen.
    lidlSince ??= now();
    if (!(await emailVisible(page))) {
      if (switchClicks < MAX_SWITCH_CLICKS && (await switchToEmail(page)) !== null) {
        switchClicks++;
        step("switched the Lidl login from the phone number to the e-mail address");
        return null;
      }
      if (
        clicks < 3 &&
        !(await page.isVisible(PHONE_FIELD)) &&
        (await act(page, (o) => page.clickButton(WELCOME_SKIP, o)))
      ) {
        clicks++;
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
  // and its hint. One action per call.
  const finishOnboarding = async (page: LoginPage) => {
    if (
      !termsAccepted &&
      (await act(page, (o) => page.checkBox(TERMS_LABEL, OPTIONAL_CONSENT, o)))
    ) {
      const confirmed = await act(page, (o) =>
        page.clickButtonByText(TERMS_CONFIRM, SKIP_BUTTONS, o),
      );
      if (confirmed !== null) {
        termsAccepted = true;
        reached.add("terms_confirmed");
        step("terms of use confirmed");
        return;
      }
    }
    if (!deviceChosen && !DEVICE_PROMPT.test(await page.text())) return;
    if (
      !deviceChosen &&
      (await act(page, (o) =>
        page.clickByText(DEVICE_CHOICE, OTHER_DEVICES, { ...o, anyElement: true }),
      )) !== null
    ) {
      deviceChosen = true;
      reached.add("device_chosen");
      step("device MC Smart chosen");
      return;
    }
    await act(page, (o) => page.clickButtonByText(HINT_BUTTON, SKIP_BUTTONS, o));
  };

  try {
    context = await options.browser.open({
      profileDir: options.profileDir,
      headless: options.headless,
    });
    step("opening the Monsieur Cuisine login");
    await context.page.goto(ssoLoginUrl(options.editorPath, baseUrl));

    while (now() < deadline) {
      const page = context.page;
      const url = page.url();
      if (onLoginHost(url, loginHosts)) {
        reached.add("page_reached");
      } else if (reached.has("page_reached") && hostOf(url) === hostOf(baseUrl)) {
        reached.add("redirect_reached");
      }
      const cookie = await readSessionCookie(context, options.editorPath, baseUrl);
      if (cookie !== null) {
        reached.add("cookies_received");
        step("logged in");
        return { ok: true, cookie, ...notes() };
      }
      if (url !== lastUrl) {
        lastUrl = url;
        watchDialogsUntil = now() + CONSENT_WINDOW_MS;
      }
      // With credentials the flow looks for dialogs on every poll, also while it waits for the
      // form; without, a person may be at the window, so only for a while after a navigation.
      if (credentials || now() < watchDialogsUntil) await dismissDialogs(page);
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
    // A fixed text: the browser's own message can carry the typed password.
    return await fail("error", browserFailureDetail(error));
  } finally {
    // A browser that hangs on close must not keep the login marked as running.
    if (context) await closeWithin(context, CLOSE_TIMEOUT_MS);
  }
}
