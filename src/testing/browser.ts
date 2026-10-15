// A scripted LoginBrowser for the login tests. Not part of the build.
//
// The page plays the Lidl login: it shows the fields the script names, and once the
// password field gets Enter (or right away, for a saved profile) the site sets its login
// cookies when the script says the login works.

import { writeFileSync } from "node:fs";
import type { BrowserCookie, LoginBrowser, LoginContext } from "../session/browser-login.js";

export interface FakeBrowserScript {
  // Why the browser cannot start; null or absent when it can.
  unavailable?: string | null;
  // Thrown by open().
  openError?: Error;
  // The page shows these fields. "two-step" shows the e-mail field first and the password
  // field after Enter in it.
  form?: "both" | "two-step" | "none";
  // A welcome screen with buttons comes first; clicking one that is not a registration
  // button reveals the form.
  welcome?: string[];
  // Whether the site logs in after the password is sent.
  loginWorks?: boolean;
  // The saved profile is still logged in: the cookies exist from the start.
  loggedInProfile?: boolean;
  // The URL the page reports.
  url?: string;
  // Thrown by fillVisible, the way Playwright throws on a field that does not take input.
  fillError?: Error;
}

export const LOGIN_COOKIES: BrowserCookie[] = [
  { name: "PHPSESSID", value: "php-session" },
  { name: "wordpress_logged_in_0123", value: "someone%7C1790000000%7Ctoken%7Chmac" },
  { name: "lidl_sso_id_token", value: "id-token" },
];

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
      let welcome = (script.welcome ?? []).length > 0;
      let passwordShown = script.form === "both";
      let loggedIn = script.loggedInProfile === true;
      const emailShown = () => !welcome && (script.form === "both" || script.form === "two-step");
      const visible = (selector: string) =>
        selector.includes("email") ? emailShown() : !welcome && passwordShown;
      const context: LoginContext = {
        page: {
          goto: (url) => {
            steps.push(`goto ${url}`);
            return Promise.resolve();
          },
          url: () => script.url ?? "https://accounts.lidl.com/Account/Login",
          fillVisible: (selector, value) => {
            if (script.fillError) return Promise.reject(script.fillError);
            if (!visible(selector)) return Promise.resolve(false);
            filled[selector] = value;
            steps.push(`fill ${selector}`);
            return Promise.resolve(true);
          },
          isVisible: (selector) => Promise.resolve(visible(selector)),
          pressEnter: (selector) => {
            steps.push(`enter ${selector}`);
            if (selector.includes("email") && script.form === "two-step") passwordShown = true;
            if (selector.includes("password") && script.loginWorks) loggedIn = true;
            return Promise.resolve();
          },
          clickButton: (skip) => {
            const button = (script.welcome ?? []).find((text) => !skip.test(text));
            if (!welcome || button === undefined) return Promise.resolve(false);
            steps.push(`click ${button}`);
            welcome = false;
            return Promise.resolve(true);
          },
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
