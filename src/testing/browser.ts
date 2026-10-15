// A scripted LoginBrowser for the login tests. Not part of the build.
//
// The page plays the Lidl login: it shows the fields the script names, and once the
// password is sent (Enter in the field, or "Weiter" on the password page) the site sets its
// login cookies when the script says the login works. A consent dialog can sit on top of
// the form: while it shows, the fields can be filled but Enter and "Weiter" do not reach the
// form; with coverBlocks, fills, clicks and Enter under it time out the way Playwright's do.
// The dialog can come up a moment after the navigation, come back after the e-mail step, or
// come up in the moment of the first fill. The Lidl page can open in phone mode, and
// monsieur-cuisine.com can ask for the terms of use and the device before it sets the
// cookies.

import { writeFileSync } from "node:fs";
import { BrowserActionError } from "../session/browser-errors.js";
import type { BrowserCookie, LoginBrowser, LoginContext } from "../session/browser-login.js";
import { DIALOG_SELECTOR } from "../session/login-pages.js";

export interface FakeBrowserScript {
  // Why the browser cannot start; null or absent when it can.
  unavailable?: string | null;
  // Thrown by open().
  openError?: Error;
  // The page shows these fields. "two-step" shows the e-mail field first and the password
  // field after Enter in it; "continue" shows the password field after a click on "Weiter",
  // and sends the password with another "Weiter".
  form?: "both" | "two-step" | "continue" | "none";
  // The Lidl page opens asking for a phone number: a country selector, a phone field and a
  // control to the e-mail address.
  phoneMode?: boolean;
  // The control to the e-mail address does nothing.
  switchIgnored?: boolean;
  // What the control between the phone login and the e-mail address is: a link (the
  // default), a button, or a plain element that only a search by text finds.
  switchElement?: "link" | "button" | "text";
  // A welcome screen with buttons comes first; clicking one that is not a registration
  // button reveals the form.
  welcome?: string[];
  // A consent dialog with these buttons covers the page from the navigation on. Any of its
  // buttons closes it.
  consent?: string[];
  // The consent dialog has a close button.
  consentClose?: boolean;
  // The consent dialog comes up this long after the navigation instead of at once.
  consentDelayMs?: number;
  // The consent dialog comes up again once the e-mail address is sent.
  consentAgainAfterEmail?: boolean;
  // The consent dialog comes up in the moment of the first fill, not at the navigation.
  consentOnFirstFill?: boolean;
  // While a dialog shows, fills, clicks and Enter on the page under it time out
  // (BrowserActionError "timeout"). Without it, fills go through and clicks do nothing.
  coverBlocks?: boolean;
  // Whether the site logs in after the password is sent.
  loginWorks?: boolean;
  // The message the form shows after the password is sent.
  siteError?: string;
  // The message the form shows after the e-mail address is sent, instead of the password.
  unknownAccount?: string;
  // After the e-mail address the page offers to create an account, with a password field.
  newAccount?: boolean;
  // What the site shows after the password is sent: a captcha frame or a request for a code.
  verification?: "frame" | "text";
  // More frames the page carries from the start.
  frames?: string[];
  // After the login, monsieur-cuisine.com asks for the terms of use: a checkbox and a button
  // that stays disabled until it is ticked. Next to it sits a newsletter checkbox.
  terms?: boolean;
  // After the login (and the terms), monsieur-cuisine.com asks for the device.
  deviceChooser?: boolean;
  // The cookies come only after the hint next to the device chooser is closed as well.
  hintBlocks?: boolean;
  // A consent dialog with these buttons covers monsieur-cuisine.com after the redirect.
  siteConsent?: string[];
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

// The frame of an invisible reCAPTCHA that many login forms carry without asking anything.
export const INVISIBLE_CAPTCHA =
  "https://www.google.com/recaptcha/api2/anchor?k=site&size=invisible";
export const CAPTCHA_CHALLENGE = "https://www.google.com/recaptcha/api2/bframe?k=site";
// The reCAPTCHA Enterprise anchor the Lidl login page loads at once.
export const ENTERPRISE_ANCHOR =
  "https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=site&hl=de";

// The texts of the controls the fake pages show.
export const FAKE_TEXT = {
  country: "Land +43",
  toEmail: "Verwende stattdessen deine E-Mail-Adresse",
  toPhone: "Verwende stattdessen deine Telefonnummer",
  termsBox: "Ich akzeptiere die Nutzungsbestimmungen.",
  newsletterBox: "Ich möchte den Newsletter erhalten.",
  start: "Jetzt loslegen",
  devices: ["MC SMART", "MC COMPACT", "MC CONNECT", "MC PLUS"],
  hint: "OKAY",
} as const;

const LIDL_URL = "https://accounts.lidl.com/Account/Login";
const SITE_URL = "https://www.monsieur-cuisine.com/de/create-recipe?devices=mc-smart";

export interface FakeBrowser extends LoginBrowser {
  steps: string[];
  filled: Record<string, string>;
  opened: { profileDir: string; headless: boolean }[];
  closed: number;
}

interface Control {
  text: string;
  click: () => void;
  disabled?: boolean;
  // A link, which a search for buttons does not find.
  link?: boolean;
  // A card or another element that is not a button or link.
  plain?: boolean;
  // A button of a consent dialog, which the dialog does not cover.
  dialog?: boolean;
}

// Runs a step of the fake page; a thrown error becomes a rejected promise.
function run<T>(action: () => T): Promise<T> {
  try {
    return Promise.resolve(action());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

// `now` is the clock of the flow, for a dialog that comes up later.
export function fakeBrowser(
  script: FakeBrowserScript = {},
  now: () => number = () => 0,
): FakeBrowser {
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
      const hasConsent = (script.consent ?? []).length > 0 || script.consentClose === true;
      // When the consent dialog shows; null while it does not.
      let consentFrom: number | null = null;
      let consentAgain = false;
      let firstFill = true;
      let welcome = (script.welcome ?? []).length > 0;
      let phone = script.phoneMode === true;
      let passwordShown = script.form === "both";
      let passwordSent = false;
      let emailError: string | null = null;
      let loggedIn = script.loggedInProfile === true;
      let url = script.url ?? LIDL_URL;
      // The first-login screens of monsieur-cuisine.com.
      let onSite = false;
      let termsShown = false;
      let termsTicked = false;
      let newsletterTicked = false;
      let chooserShown = false;
      let hintShown = false;
      let deviceChosen = false;
      let siteConsent = false;
      const switchKind = script.switchElement ?? "link";
      const consentShown = () => consentFrom !== null && now() >= consentFrom;
      const hasForm =
        script.form === "both" || script.form === "two-step" || script.form === "continue";
      const lidlShown = () => !welcome && hasForm && !onSite;
      const emailShown = () => lidlShown() && !phone && !(passwordShown && script.form !== "both");
      const passwordVisible = () => lidlShown() && !phone && passwordShown;
      const blocked = () => consentShown() || siteConsent;
      const covered = () => script.coverBlocks === true && blocked();
      const timedOut = (what: string) => {
        steps.push(`${what} timed out`);
        return new BrowserActionError("timeout");
      };
      const visible = (selector: string) => {
        if (selector === DIALOG_SELECTOR) return blocked() || termsShown;
        if (selector.includes("tel")) return lidlShown() && phone;
        if (selector.includes("email")) return emailShown();
        if (selector.includes("password")) return passwordVisible();
        return false;
      };
      // After the password: the cookies, or first the screens of monsieur-cuisine.com.
      const sendPassword = () => {
        passwordSent = true;
        if (!script.loginWorks) return;
        onSite = true;
        url = SITE_URL;
        if (!script.terms && !script.deviceChooser) {
          loggedIn = true;
          return;
        }
        siteConsent = (script.siteConsent ?? []).length > 0;
        termsShown = script.terms === true;
        chooserShown = !termsShown && script.deviceChooser === true;
        hintShown = chooserShown;
      };
      const afterTerms = () => {
        termsShown = false;
        chooserShown = script.deviceChooser === true;
        hintShown = chooserShown;
        if (!chooserShown) loggedIn = true;
      };
      const sendEmail = () => {
        if (script.unknownAccount) emailError = script.unknownAccount;
        else passwordShown = true;
        if (script.consentAgainAfterEmail && !consentAgain) {
          consentAgain = true;
          consentFrom = now();
        }
      };
      // The visible controls, front to back, and what a click on each does.
      const controls = (): Control[] => [
        ...(consentShown() ? (script.consent ?? []) : []).map((text) => ({
          text,
          dialog: true,
          click: () => {
            consentFrom = null;
          },
        })),
        ...(siteConsent ? (script.siteConsent ?? []) : []).map((text) => ({
          text,
          dialog: true,
          click: () => {
            siteConsent = false;
          },
        })),
        ...(welcome ? (script.welcome ?? []) : []).map((text) => ({
          text,
          click: () => {
            welcome = false;
          },
        })),
        ...(lidlShown() && phone
          ? [
              { text: FAKE_TEXT.country, click: () => undefined },
              {
                text: FAKE_TEXT.toEmail,
                link: switchKind === "link",
                plain: switchKind === "text",
                click: () => {
                  if (!script.switchIgnored) phone = false;
                },
              },
            ]
          : []),
        ...(lidlShown() && !phone && !passwordShown
          ? [
              {
                text: FAKE_TEXT.toPhone,
                link: switchKind === "link",
                plain: switchKind === "text",
                click: () => {
                  phone = true;
                },
              },
            ]
          : []),
        ...(script.form === "continue" && emailShown() && !passwordShown
          ? [
              {
                text: "Weiter",
                click: () => {
                  if (!blocked() && filled['input[type="email"]']) sendEmail();
                },
              },
            ]
          : []),
        ...(script.form === "continue" && passwordVisible()
          ? [
              {
                text: "Weiter",
                click: () => {
                  if (!blocked() && filled['input[type="password"]']) sendPassword();
                },
              },
            ]
          : []),
        ...(termsShown
          ? [
              {
                text: FAKE_TEXT.start,
                disabled: !termsTicked,
                click: () => {
                  if (!blocked()) afterTerms();
                },
              },
            ]
          : []),
        ...(chooserShown
          ? FAKE_TEXT.devices.map((text) => ({
              text,
              plain: true,
              click: () => {
                if (blocked() || text !== "MC SMART") return;
                chooserShown = false;
                deviceChosen = true;
                if (!script.hintBlocks) loggedIn = true;
              },
            }))
          : []),
        ...(hintShown
          ? [
              {
                text: FAKE_TEXT.hint,
                click: () => {
                  hintShown = false;
                  if (deviceChosen) loggedIn = true;
                },
              },
            ]
          : []),
      ];
      // Buttons are the controls without the links and the plain elements.
      const isButton = (control: Control) => control.link !== true && control.plain !== true;
      const click = (control: Control | undefined) => {
        if (control === undefined) return null;
        if (control.dialog !== true && covered()) throw timedOut(`click ${control.text}`);
        steps.push(`click ${control.text}`);
        control.click();
        return control.text;
      };
      const context: LoginContext = {
        page: {
          goto: (target) => {
            steps.push(`goto ${target}`);
            if (hasConsent && !script.consentOnFirstFill) {
              consentFrom = now() + (script.consentDelayMs ?? 0);
            }
            return Promise.resolve();
          },
          url: () => url,
          fillVisible: (selector, value) =>
            run(() => {
              if (script.fillError) throw script.fillError;
              if (!visible(selector)) return false;
              if (script.consentOnFirstFill && firstFill) {
                firstFill = false;
                consentFrom = now();
              }
              if (covered()) throw timedOut(`fill ${selector}`);
              filled[selector] = value;
              steps.push(`fill ${selector}${consentShown() ? " under the dialog" : ""}`);
              return true;
            }),
          isVisible: (selector) => Promise.resolve(visible(selector)),
          pressEnter: (selector) =>
            run(() => {
              if (covered()) throw timedOut(`enter ${selector}`);
              steps.push(`enter ${selector}${consentShown() ? " under the dialog" : ""}`);
              if (!visible(selector)) steps.push("enter without a field");
              if (consentShown()) return;
              if (selector.includes("email") && script.form === "two-step") sendEmail();
              if (selector.includes("password")) sendPassword();
            }),
          // Like a page's buttons: the phone login's country selector is one of them.
          clickButton: (skip) =>
            run(
              () =>
                click(controls().find((c) => isButton(c) && !c.disabled && !skip.test(c.text))) !==
                null,
            ),
          clickButtonByText: (match, avoid, options = {}) =>
            run(() => {
              const found = controls().filter(
                (c) => isButton(c) && !c.disabled && match.test(c.text) && !avoid.test(c.text),
              );
              return click(found.find((c) => options.exact?.test(c.text) === true) ?? found[0]);
            }),
          clickByText: (match, avoid, options = {}) =>
            run(() =>
              click(
                controls().find(
                  (c) =>
                    (options.anyElement === true || !c.plain) &&
                    !c.disabled &&
                    match.test(c.text) &&
                    !avoid.test(c.text),
                ),
              ),
            ),
          checkBox: (label, avoid) =>
            run(() => {
              if (!termsShown) return false;
              if (covered()) throw timedOut("check");
              for (const [text, ticked] of [
                [FAKE_TEXT.newsletterBox, newsletterTicked],
                [FAKE_TEXT.termsBox, termsTicked],
              ] as const) {
                if (!label.test(text) || avoid.test(text)) continue;
                if (!ticked) {
                  steps.push(`check ${text}`);
                  if (text === FAKE_TEXT.termsBox) termsTicked = true;
                  else newsletterTicked = true;
                }
                return true;
              }
              return false;
            }),
          // Declines inside the shown dialog, an exact phrase first; else closes it.
          dismissDialog: (patterns, options) => {
            const layers = [
              {
                shown: consentShown(),
                buttons: script.consent ?? [],
                close: script.consentClose === true,
                hide: () => {
                  consentFrom = null;
                },
              },
              {
                shown: siteConsent,
                buttons: script.siteConsent ?? [],
                close: false,
                hide: () => {
                  siteConsent = false;
                },
              },
            ].filter((layer) => layer.shown);
            for (const layer of layers) {
              const declines = layer.buttons.filter(
                (text) => patterns.decline.test(text) && !patterns.accept.test(text),
              );
              const text = declines.find((t) => patterns.declineExact.test(t)) ?? declines[0];
              if (text === undefined) continue;
              steps.push(`click ${text}`);
              layer.hide();
              return Promise.resolve("declined" as const);
            }
            for (const layer of layers) {
              if (!layer.close || !options.close) continue;
              steps.push("close dialog");
              layer.hide();
              return Promise.resolve("closed" as const);
            }
            return Promise.resolve(null);
          },
          visibleMessage: () =>
            Promise.resolve(
              emailError ?? (passwordSent && script.siteError ? script.siteError : null),
            ),
          frameSources: () =>
            Promise.resolve([
              INVISIBLE_CAPTCHA,
              ...(script.frames ?? []),
              ...(passwordSent && script.verification === "frame" ? [CAPTCHA_CHALLENGE] : []),
            ]),
          text: () => {
            if (chooserShown) return Promise.resolve("Bitte wähle dein Gerät.");
            if (termsShown) return Promise.resolve("Nutzungsbedingungen 1. Geltungsbereich");
            if (passwordSent && script.verification === "text") {
              return Promise.resolve(
                "Bitte gib den Sicherheitscode ein, den wir dir geschickt haben.",
              );
            }
            if (passwordShown && script.newAccount) {
              return Promise.resolve("Konto erstellen Passwort Weiter");
            }
            if (passwordShown && script.form !== "both") {
              return Promise.resolve("Willkommen zurück Ändern Passwort Passwort vergessen?");
            }
            return Promise.resolve("Anmelden oder registrieren E-Mail Weiter");
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
