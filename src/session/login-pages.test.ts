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
  IGNORED_FRAME,
  SKIP_BUTTONS,
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
