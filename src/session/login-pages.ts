// What the browser login looks for on the Lidl account pages and on monsieur-cuisine.com:
// consent dialogs, the buttons of a login in two steps, error messages and captchas.
//
// The words cover every language the sites serve, independent of MC_LOCALE: the Lidl
// account pages follow the browser and the account country, not the bridge's locale pack.
// Button patterns match the start of a button's text, case-insensitively, after trimming
// and collapsing whitespace ("Alle ablehnen" and "Reject all cookies" both count).

// Builds a pattern that matches a button text starting with one of the phrases, followed by
// the end of the text or a character that is not a letter.
function startsWithPhrase(phrases: readonly string[]): RegExp {
  const sorted = [...phrases].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`^(?:${sorted.join("|")})(?!\\p{L})`, "iu");
}

// Builds a pattern that matches one of the words anywhere, as a whole word.
function anyWord(words: readonly string[]): RegExp {
  const sorted = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<!\\p{L})(?:${sorted.join("|")})(?!\\p{L})`, "iu");
}

// Builds a pattern that matches one of the fragments anywhere, also inside a word.
function anyFragment(fragments: readonly string[]): RegExp {
  return new RegExp(fragments.map(escapeRegExp).join("|"), "iu");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Trimmed, with runs of whitespace collapsed to one space.
export function buttonText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Buttons that decline a consent dialog. The login clicks only these.
export const DECLINE_PHRASES = [
  "Ablehnen",
  "Alle ablehnen",
  "Nur notwendige",
  "Reject",
  "Reject all",
  "Decline",
  "Refuser",
  "Tout refuser",
  "Rifiuta",
  "Rifiuta tutto",
  "Rechazar",
  "Odmítnout",
  "Odrzuć",
  "Recusar",
  "Weigeren",
  "Respinge",
] as const;
export const DECLINE_BUTTON = startsWithPhrase(DECLINE_PHRASES);

// Buttons that accept or tune a consent dialog. The login never clicks them, neither as a
// decline nor as a welcome screen button.
export const ACCEPT_PHRASES = [
  "Akzeptieren",
  "Alle akzeptieren",
  "Zustimmen",
  "Allen zustimmen",
  "Einverstanden",
  "Erlauben",
  "Alle erlauben",
  "Anpassen",
  "Einstellungen",
  "Accept",
  "Accept all",
  "Agree",
  "I agree",
  "Allow",
  "Allow all",
  "Customize",
  "Customise",
  "Manage",
  "Settings",
  "Accepter",
  "Tout accepter",
  "J'accepte",
  "Personnaliser",
  "Accetta",
  "Accetta tutto",
  "Personalizza",
  "Aceptar",
  "Aceptar todo",
  "Personalizar",
  "Přijmout",
  "Přijmout vše",
  "Souhlasím",
  "Akceptuj",
  "Zaakceptuj",
  "Akceptuję",
  "Aceitar",
  "Aceitar tudo",
  "Accepteren",
  "Alles accepteren",
  "Akkoord",
  "Acceptă",
  "Accept toate",
] as const;
export const ACCEPT_BUTTON = startsWithPhrase(ACCEPT_PHRASES);

// The accessible name of a control that closes a dialog.
export const CLOSE_LABEL = anyFragment([
  "close",
  "dismiss",
  "schließen",
  "schliessen",
  "fermer",
  "chiudi",
  "cerrar",
  "zavřít",
  "zamknij",
  "fechar",
  "sluiten",
  "închide",
]);
// The text of a close button inside a dialog.
export const CLOSE_SYMBOL = /^[×✕✖✗xX]$/u;

// The button that sends the e-mail address in a login in two steps.
export const CONTINUE_BUTTON = startsWithPhrase([
  "Weiter",
  "Fortfahren",
  "Continue",
  "Next",
  "Suivant",
  "Continuer",
  "Avanti",
  "Continua",
  "Siguiente",
  "Continuar",
  "Pokračovat",
  "Dalej",
  "Kontynuuj",
  "Volgende",
  "Doorgaan",
  "Următorul",
  "Continuă",
]);

// Buttons on the Lidl welcome screen that lead away from the login: a registration.
export const REGISTRATION_BUTTON = /regist|erstellen|create|sign up|neu/i;

// What a welcome screen click skips: a registration, and every consent button.
export const SKIP_BUTTONS = new RegExp(
  [REGISTRATION_BUTTON.source, ACCEPT_BUTTON.source, DECLINE_BUTTON.source].join("|"),
  "iu",
);

// Elements that hold an error message on the login form.
export const ERROR_SELECTOR = [
  '[role="alert"]',
  '[aria-live="assertive"]',
  ".error",
  ".error-message",
  ".field-validation-error",
  ".validation-summary-errors",
  '[class*="error"]',
].join(", ");
// Longer texts are a page section, not an error message.
export const MAX_ERROR_LENGTH = 300;

// An error message that says the password (or the e-mail and password) is wrong.
export const WRONG_PASSWORD = anyFragment([
  "falsch",
  "inkorrekt",
  "ungültig",
  "nicht korrekt",
  "nicht überein",
  "stimmen nicht",
  "stimmt nicht",
  "incorrect",
  "wrong",
  "invalid",
  "does not match",
  "do not match",
  "didn't match",
  "erroné",
  "invalide",
  "errat",
  "non corrett",
  "non valid",
  "incorrect",
  "inválid",
  "nesprávn",
  "neplatn",
  "nieprawidłow",
  "błędn",
  "incorret",
  "onjuist",
  "ongeldig",
  "greșit",
  "incorect",
]);

// The source of a frame that shows a captcha or a challenge. Invisible reCAPTCHA frames
// sit on many login forms without asking anything.
export const CAPTCHA_FRAME = /captcha|challenge|turnstile|arkose|funcaptcha/i;
export const IGNORED_FRAME = /size=invisible/i;

// Page text that asks for a captcha or a verification code.
export const VERIFICATION_TEXT = anyWord([
  "captcha",
  "recaptcha",
  "hcaptcha",
  "verify",
  "verifizieren",
  "verifizierung",
  "code",
  "Sicherheitscode",
  "Bestätigungscode",
  "Verifizierungscode",
  "vérifier",
  "vérification",
  "verifica",
  "verificar",
  "verificação",
  "ověření",
  "weryfikacja",
  "kod",
  "kód",
  "código",
  "codice",
  "verifiëren",
  "verificatie",
  "verificare",
  "cod",
]);
