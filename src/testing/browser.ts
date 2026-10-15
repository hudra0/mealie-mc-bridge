// A scripted LoginBrowser for the login tests. Not part of the build.
//
// The page plays the Lidl login: it shows the fields the script names, and once the
// password field gets Enter (or right away, for a saved profile) the site sets its login
// cookies when the script says the login works. A consent dialog can sit on top of the
// form: while it shows, the fields can be filled but Enter does not reach the form.

import { writeFileSync } from "node:fs";
import type { BrowserCookie, LoginBrowser, LoginContext } from "../session/browser-login.js";

export interface FakeBrowserScript {
  // Why the browser cannot start; null or absent when it can.
  unavailable?: string | null;
  // Thrown by open().
  openError?: Error;
  // The page shows these fields. "two-step" shows the e-mail field first and the password
  // field after Enter in it; "continue" shows the password field after a click on "Weiter".
  form?: "both" | "two-step" | "continue" | "none";
  // A welcome screen with buttons comes first; clicking one that is not a registration
  // button reveals the form.
  welcome?: string[];
  // A consent dialog with these buttons covers the page from the start. Any of its buttons
  // closes it.
  consent?: string[];
  // The consent dialog has a close button.
  consentClose?: boolean;
  // Whether the site logs in after the password is sent.
  loginWorks?: boolean;
  // The message the form shows after the password is sent.
  siteError?: string;
  // What the site shows after the password is sent: a captcha frame or a request for a code.
  verification?: "frame" | "text";
  // The saved profile is still logged in: the cookies exist from the start.
  loggedInProfile?: boolean;
  // The URL the page reports.
  url?: string;
}

export const LOGIN_COOKIES: BrowserCookie[] = [
  { name: "PHPSESSID", value: "php-session" },
  { name: "wordpress_logged_in_0123", value: "someone%7C1790000000%7Ctoken%7Chmac" },
  { name: "lidl_sso_id_token", value: "id-token" },
];

// The frame of an invisible reCAPTCHA that many login forms carry without asking anything.
export const INVISIBLE_CAPTCHA =
  "https://www.google.com/recaptcha/api2/anchor?k=site&size=invisible";
export const CAPTCHA_CHALLENGE = "https://www.google.com/recaptcha/api2/bframe?k=site";

export interface FakeBrowser extends LoginBrowser {
  steps: string[];
  filled: Record<string, string>;
  opened: { profileDir: string; headless: boolean }[];
  closed: number;
}

export function fakeBrowser(script: FakeBrowserScript = {}): FakeBrowser {
  const steps: string[] = [];
  const filled: Record<string, string> = {};
  const opened: { profileDir: string; headless: boolean }[] = [];
  const browser: FakeBrowser = {
    steps,
    filled,
    opened,
    closed: 0,
    unavailable: () => Promise.resolve(script.unavailable ?? null),
    open: (options) => {
      if (script.openError) return Promise.reject(script.openError);
      opened.push(options);
      let consent = (script.consent ?? []).length > 0 || script.consentClose === true;
      let welcome = (script.welcome ?? []).length > 0;
      let passwordShown = script.form === "both";
      let passwordSent = false;
      let loggedIn = script.loggedInProfile === true;
      const hasForm =
        script.form === "both" || script.form === "two-step" || script.form === "continue";
      const emailShown = () => !welcome && hasForm;
      const visible = (selector: string) =>
        selector.includes("email") ? emailShown() : !welcome && passwordShown;
      // The visible buttons, front to back, and what a click on each does.
      const buttons = (): { text: string; click: () => void }[] => [
        ...(consent ? (script.consent ?? []) : []).map((text) => ({
          text,
          click: () => {
            consent = false;
          },
        })),
        ...(welcome ? (script.welcome ?? []) : []).map((text) => ({
          text,
          click: () => {
            welcome = false;
          },
        })),
        ...(script.form === "continue" && emailShown() && !passwordShown
          ? [
              {
                text: "Weiter",
                click: () => {
                  if (!consent) passwordShown = true;
                },
              },
            ]
          : []),
      ];
      const click = (button: { text: string; click: () => void } | undefined) => {
        if (button === undefined) return null;
        steps.push(`click ${button.text}`);
        button.click();
        return button.text;
      };
      const context: LoginContext = {
        page: {
          goto: (url) => {
            steps.push(`goto ${url}`);
            return Promise.resolve();
          },
          url: () => script.url ?? "https://accounts.lidl.com/Account/Login",
          fillVisible: (selector, value) => {
            if (!visible(selector)) return Promise.resolve(false);
            filled[selector] = value;
            steps.push(`fill ${selector}${consent ? " under the dialog" : ""}`);
            return Promise.resolve(true);
          },
          isVisible: (selector) => Promise.resolve(visible(selector)),
          pressEnter: (selector) => {
            steps.push(`enter ${selector}${consent ? " under the dialog" : ""}`);
            if (consent) return Promise.resolve();
            if (selector.includes("email") && script.form === "two-step") passwordShown = true;
            if (selector.includes("password")) {
              passwordSent = true;
              if (script.loginWorks) loggedIn = true;
            }
            return Promise.resolve();
          },
          clickButton: (skip) =>
            Promise.resolve(click(buttons().find((b) => !skip.test(b.text))) !== null),
          clickButtonByText: (match, avoid) =>
            Promise.resolve(
              click(buttons().find((b) => match.test(b.text) && !avoid.test(b.text))),
            ),
          closeDialog: () => {
            if (!consent || script.consentClose !== true) return Promise.resolve(false);
            steps.push("close dialog");
            consent = false;
            return Promise.resolve(true);
          },
          visibleMessage: () =>
            Promise.resolve(passwordSent && script.siteError ? script.siteError : null),
          frameSources: () =>
            Promise.resolve(
              passwordSent && script.verification === "frame"
                ? [INVISIBLE_CAPTCHA, CAPTCHA_CHALLENGE]
                : [INVISIBLE_CAPTCHA],
            ),
          text: () =>
            Promise.resolve(
              passwordSent && script.verification === "text"
                ? "Bitte gib den Sicherheitscode ein, den wir dir geschickt haben."
                : "Anmelden E-Mail-Adresse Passwort",
            ),
          screenshot: (path) => {
            writeFileSync(path, "png");
            steps.push("screenshot");
            return Promise.resolve();
          },
        },
        cookies: () =>
          Promise.resolve(loggedIn ? LOGIN_COOKIES : [{ name: "PHPSESSID", value: "php" }]),
        close: () => {
          browser.closed++;
          return Promise.resolve();
        },
      };
      return Promise.resolve(context);
    },
  };
  return browser;
}

// A clock for the polling loop: each sleep advances it.
export function loopClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
  };
}
