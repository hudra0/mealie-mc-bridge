import { describe, expect, it } from "vitest";
import {
  ACCEPT_BUTTON,
  ACCEPT_PHRASES,
  CAPTCHA_FRAME,
  CLOSE_LABEL,
  CLOSE_SYMBOL,
  CONTINUE_BUTTON,
  DECLINE_BUTTON,
  DECLINE_PHRASES,
  DEVICE_CHOICE,
  DEVICE_PROMPT,
  DIALOG_SELECTOR,
  EMAIL_SWITCH,
  EMAIL_SWITCH_PHRASES,
  HINT_BUTTON,
  IGNORED_FRAME,
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
  buttonText,
} from "./login-pages.js";

describe("consent buttons", () => {
  it("declines with every phrase, in any case, with words after it", () => {
    for (const phrase of DECLINE_PHRASES) {
      expect(DECLINE_BUTTON.test(phrase), phrase).toBe(true);
      expect(DECLINE_BUTTON.test(phrase.toUpperCase()), phrase).toBe(true);
      expect(ACCEPT_BUTTON.test(phrase), phrase).toBe(false);
    }
    expect(DECLINE_BUTTON.test(buttonText("  Alle\n ablehnen  "))).toBe(true);
    expect(DECLINE_BUTTON.test("Reject all cookies")).toBe(true);
    expect(DECLINE_BUTTON.test("Nur notwendige Cookies")).toBe(true);
  });

  it("never takes an accept or settings button for a decline", () => {
    for (const phrase of ACCEPT_PHRASES) {
      expect(DECLINE_BUTTON.test(phrase), phrase).toBe(false);
      expect(ACCEPT_BUTTON.test(phrase), phrase).toBe(true);
    }
    expect(DECLINE_BUTTON.test("Ablehnung ansehen")).toBe(false);
    expect(DECLINE_BUTTON.test("Cookies ablehnen")).toBe(false);
  });

  it("finds close controls of a dialog", () => {
    expect(CLOSE_LABEL.test("Dialog schließen")).toBe(true);
    expect(CLOSE_LABEL.test("Close")).toBe(true);
    expect(CLOSE_LABEL.test("Fermer la fenêtre")).toBe(true);
    expect(CLOSE_LABEL.test("Menü")).toBe(false);
    expect(CLOSE_SYMBOL.test("×")).toBe(true);
    expect(CLOSE_SYMBOL.test("✕")).toBe(true);
    expect(CLOSE_SYMBOL.test("Mehr")).toBe(false);
  });
});

describe("login buttons", () => {
  it("skips registrations and every consent button on a welcome screen", () => {
    for (const text of ["Konto erstellen", "Registrieren", "Zustimmen", "Ablehnen", "Anpassen"]) {
      expect(SKIP_BUTTONS.test(text), text).toBe(true);
    }
    for (const text of ["Anmelden", "Weiter", "Einloggen", "Log in"]) {
      expect(SKIP_BUTTONS.test(text), text).toBe(false);
    }
  });

  it("finds the button between the e-mail address and the password", () => {
    for (const text of ["Weiter", "Continue", "Next", "Suivant", "Avanti", "Dalej"]) {
      expect(CONTINUE_BUTTON.test(text), text).toBe(true);
    }
    expect(CONTINUE_BUTTON.test("Weiterleitung")).toBe(false);
    expect(CONTINUE_BUTTON.test("Anmelden")).toBe(false);
  });
});

describe("answers of the site", () => {
  it("tells a wrong password from other errors", () => {
    for (const text of [
      "E-Mail-Adresse oder Passwort ist falsch.",
      "Die Anmeldedaten stimmen nicht.",
      "Incorrect email or password.",
      "Mot de passe incorrect.",
      "Password errata.",
      "Contraseña incorrecta.",
      "Nieprawidłowe hasło.",
    ]) {
      expect(WRONG_PASSWORD.test(text), text).toBe(true);
    }
    expect(WRONG_PASSWORD.test("Zu viele Versuche. Bitte warte.")).toBe(false);
  });

  it("recognizes a captcha or a verification request", () => {
    expect(CAPTCHA_FRAME.test("https://www.google.com/recaptcha/api2/bframe?k=x")).toBe(true);
    expect(CAPTCHA_FRAME.test("https://challenges.cloudflare.com/turnstile/v0")).toBe(true);
    expect(IGNORED_FRAME.test("https://www.google.com/recaptcha/api2/anchor?size=invisible")).toBe(
      true,
    );
    expect(CAPTCHA_FRAME.test("https://www.youtube.com/embed/x")).toBe(false);
    for (const text of [
      "Bitte gib den Sicherheitscode ein.",
      "Enter the code we sent you",
      "Please verify that you are human",
      "Saisissez le code",
    ]) {
      expect(VERIFICATION_TEXT.test(text), text).toBe(true);
    }
    expect(VERIFICATION_TEXT.test("Gutscheincode einlösen")).toBe(false);
    expect(VERIFICATION_TEXT.test("Anmelden mit E-Mail und Passwort")).toBe(false);
  });
});

describe("phone login", () => {
  it("finds the link to the e-mail address in every listed language", () => {
    for (const phrase of EMAIL_SWITCH_PHRASES) {
      expect(EMAIL_SWITCH.test(phrase), phrase).toBe(true);
      expect(PHONE_WORDS.test(phrase), phrase).toBe(false);
    }
    expect(EMAIL_SWITCH.test("Mit E-Mail anmelden")).toBe(true);
    expect(EMAIL_SWITCH.test("Use email")).toBe(true);
  });

  it("keeps the phone link, the country selector and the phone field apart", () => {
    for (const text of [
      "Verwende stattdessen deine Telefonnummer",
      "Use your phone number instead",
      "Land +43",
      "Handynummer",
      "Country +49",
      "Utiliser votre numéro de téléphone",
    ]) {
      expect(PHONE_WORDS.test(text), text).toBe(true);
    }
    expect(PHONE_FIELD).toContain('input[type="tel"]');
  });

  it("sends a combined form with a sign-in button, never through another provider", () => {
    for (const text of ["Anmelden", "Log in", "Sign in", "Se connecter", "Zaloguj się"]) {
      expect(SIGN_IN_BUTTON.test(text), text).toBe(true);
    }
    expect(SIGN_IN_BUTTON.test("Anmeldedaten vergessen")).toBe(false);
    expect(OTHER_PROVIDER.test("Weiter mit Google")).toBe(true);
    expect(OTHER_PROVIDER.test("Weiter")).toBe(false);
  });
});

describe("unknown accounts", () => {
  it("recognizes an address the site does not know", () => {
    for (const text of [
      "Zu dieser E-Mail-Adresse gibt es kein Konto.",
      "Konto nicht gefunden.",
      "We couldn't find an account: account not found",
      "Aucun compte n'est associé à cette adresse.",
      "Nie znaleziono konta.",
    ]) {
      expect(UNKNOWN_ACCOUNT.test(text), text).toBe(true);
    }
    expect(UNKNOWN_ACCOUNT.test("Zu viele Versuche. Bitte warte.")).toBe(false);
  });

  it("recognizes a page that offers a new account", () => {
    expect(NEW_ACCOUNT_TEXT.test("Konto erstellen Passwort Weiter")).toBe(true);
    expect(NEW_ACCOUNT_TEXT.test("Create your account")).toBe(true);
    expect(NEW_ACCOUNT_TEXT.test("Willkommen zurück Passwort Passwort vergessen?")).toBe(false);
  });
});

describe("first login at monsieur-cuisine.com", () => {
  it("finds the terms checkbox and its button, not a newsletter", () => {
    expect(TERMS_LABEL.test("Ich akzeptiere die Nutzungsbestimmungen.")).toBe(true);
    expect(TERMS_LABEL.test("I accept the terms of use.")).toBe(true);
    expect(TERMS_LABEL.test("J'accepte les conditions d'utilisation.")).toBe(true);
    expect(OPTIONAL_CONSENT.test("Ich möchte den Newsletter erhalten.")).toBe(true);
    expect(OPTIONAL_CONSENT.test("Ich akzeptiere die Nutzungsbestimmungen.")).toBe(false);
    for (const text of ["Jetzt loslegen", "Get started", "Weiter", "Commencer"]) {
      expect(TERMS_CONFIRM.test(text), text).toBe(true);
    }
    expect(TERMS_CONFIRM.test("Abbrechen")).toBe(false);
  });

  it("picks MC Smart in the device chooser and no other machine", () => {
    expect(DEVICE_PROMPT.test("Bitte wähle dein Gerät.")).toBe(true);
    expect(DEVICE_PROMPT.test("Please choose your device.")).toBe(true);
    expect(DEVICE_PROMPT.test("Rezept erstellen")).toBe(false);
    expect(DEVICE_CHOICE.test("MC SMART")).toBe(true);
    expect(DEVICE_CHOICE.test("Monsieur Cuisine Smart")).toBe(true);
    for (const other of ["MC COMPACT", "MC CONNECT", "MC PLUS"]) {
      expect(DEVICE_CHOICE.test(other), other).toBe(false);
      expect(OTHER_DEVICES.test(other), other).toBe(true);
    }
    expect(OTHER_DEVICES.test("MC SMART")).toBe(false);
  });

  it("closes the hint, but never with a bare OK or a consent button", () => {
    for (const text of ["OKAY", "Verstanden", "Got it"]) {
      expect(HINT_BUTTON.test(text), text).toBe(true);
    }
    expect(HINT_BUTTON.test("OK")).toBe(false);
    for (const phrase of ACCEPT_PHRASES) {
      expect(HINT_BUTTON.test(phrase), phrase).toBe(false);
      expect(TERMS_CONFIRM.test(phrase), phrase).toBe(false);
    }
  });

  it("tells a page with a dialog by common dialog containers", () => {
    expect(DIALOG_SELECTOR).toContain('[role="dialog"]');
    expect(DIALOG_SELECTOR).toContain("#onetrust-banner-sdk");
  });
});
