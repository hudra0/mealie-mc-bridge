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

// The Lidl login page opens either asking for an e-mail address or for a phone number. In
// phone mode it shows a country selector and a phone field, which the login never touches;
// a link switches the page to the e-mail field.
export const PHONE_FIELD = [
  'input[type="tel"]',
  'input[inputmode="tel"]',
  'input[autocomplete^="tel"]',
].join(", ");

// Words of a control that leads to the phone login or belongs to it: the switch link of
// the e-mail mode, the country selector and the phone field.
export const PHONE_WORDS = anyFragment([
  "telefon",
  "handy",
  "mobil",
  "phone",
  "téléphone",
  "portable",
  "telefono",
  "cellulare",
  "teléfono",
  "móvil",
  "celular",
  "telefonní",
  "mobilní",
  "telefonu",
  "komórk",
  "telemóvel",
  "telefoon",
  "mobiel",
  "telefonul",
  "land",
  "country",
  "pays",
  "paese",
  "país",
  "země",
  "kraj",
  "+4",
  "+3",
]);

// The link that switches the phone login to the e-mail address, in the sites' languages.
export const EMAIL_SWITCH_PHRASES = [
  "Verwende stattdessen deine E-Mail-Adresse",
  "Stattdessen E-Mail-Adresse verwenden",
  "Use your e-mail address instead",
  "Use your email address instead",
  "Use email instead",
  "Utiliser votre adresse e-mail",
  "Utilise ton adresse e-mail",
  "Usa il tuo indirizzo e-mail",
  "Usa la tua e-mail",
  "Usa tu correo electrónico",
  "Použít e-mail",
  "Použijte e-mail",
  "Użyj adresu e-mail",
  "Usar o e-mail",
  "Utilizar o e-mail",
  "Gebruik je e-mailadres",
  "Folosește adresa de e-mail",
] as const;
// The switch link: one of the phrases, or any link or button that names the e-mail
// address. PHONE_WORDS is the counterpart the click avoids.
export const EMAIL_SWITCH = new RegExp(
  [anyFragment(EMAIL_SWITCH_PHRASES).source, "e-?mail", "correo", "adresse électronique"].join("|"),
  "iu",
);

// The button that sends the password on a combined form, when no continue button is there.
export const SIGN_IN_BUTTON = startsWithPhrase([
  "Anmelden",
  "Einloggen",
  "Login",
  "Log in",
  "Sign in",
  "Se connecter",
  "Connexion",
  "Accedi",
  "Iniciar sesión",
  "Přihlásit",
  "Zaloguj",
  "Entrar",
  "Iniciar sessão",
  "Inloggen",
  "Aanmelden",
  "Conectare",
  "Autentificare",
]);
// Sign-in buttons of other identity providers, which the login never uses.
export const OTHER_PROVIDER = anyWord(["Google", "Apple", "Facebook", "Microsoft", "Amazon"]);

// An error message after the e-mail address that says the site has no account for it.
export const UNKNOWN_ACCOUNT = anyFragment([
  "kein Konto",
  "keinen Account",
  "kein Benutzerkonto",
  "nicht gefunden",
  "existiert nicht",
  "nicht registriert",
  "unbekannt",
  "no account",
  "not found",
  "doesn't exist",
  "does not exist",
  "not registered",
  "unknown",
  "aucun compte",
  "introuvable",
  "n'existe pas",
  "nessun account",
  "non esiste",
  "non trovat",
  "no existe",
  "ninguna cuenta",
  "no encontrad",
  "neexistuje",
  "nenalezen",
  "nie istnieje",
  "nie znaleziono",
  "não existe",
  "não encontrad",
  "bestaat niet",
  "geen account",
  "niet gevonden",
  "nu există",
]);

// Page text that offers to create a new account instead of asking for the password of an
// existing one. The login never types the password into such a page.
export const NEW_ACCOUNT_TEXT = anyFragment([
  "Konto erstellen",
  "Konto anlegen",
  "Passwort erstellen",
  "Passwort festlegen",
  "Create account",
  "Create an account",
  "Create your account",
  "Create a password",
  "Créer un compte",
  "Créer votre compte",
  "Crea un account",
  "Crear cuenta",
  "Crear una cuenta",
  "Vytvořit účet",
  "Załóż konto",
  "Utwórz konto",
  "Criar conta",
  "Account aanmaken",
  "Creează cont",
]);

// After the redirect, monsieur-cuisine.com can ask for the terms of use on the first login:
// a checkbox with this label and a button that stays disabled until it is ticked.
export const TERMS_LABEL = anyFragment([
  "Nutzungsbestimmungen",
  "Nutzungsbedingungen",
  "terms of use",
  "terms and conditions",
  "terms of service",
  "conditions d'utilisation",
  "conditions générales",
  "termini di utilizzo",
  "termini d'uso",
  "condizioni d'uso",
  "condiciones de uso",
  "términos de uso",
  "podmínky použití",
  "podmínky užívání",
  "warunki korzystania",
  "regulamin",
  "termos de utilização",
  "termos de uso",
  "gebruiksvoorwaarden",
  "termeni de utilizare",
]);
// Checkboxes the login leaves alone even when their label names the terms.
export const OPTIONAL_CONSENT = anyFragment([
  "newsletter",
  "werbung",
  "marketing",
  "cookie",
  "angebote",
  "offers",
  "offres",
  "offerte",
  "ofertas",
  "nabíd",
  "oferty",
  "aanbiedingen",
  "oferte",
]);
// The button that confirms the terms: a start button, or a continue button.
export const TERMS_CONFIRM = new RegExp(
  [
    startsWithPhrase([
      "Jetzt loslegen",
      "Loslegen",
      "Los geht's",
      "Get started",
      "Let's go",
      "Start now",
      "Commencer",
      "C'est parti",
      "Inizia",
      "Iniziamo",
      "Empezar",
      "Comenzar",
      "Začít",
      "Začněte",
      "Rozpocznij",
      "Zaczynamy",
      "Começar",
      "Aan de slag",
      "Începe",
    ]).source,
    CONTINUE_BUTTON.source,
  ].join("|"),
  "iu",
);

// The device chooser of the first login: a prompt, a card per machine and a hint button.
export const DEVICE_PROMPT = anyFragment([
  "wähle dein Gerät",
  "wählen Sie Ihr Gerät",
  "choose your device",
  "select your device",
  "choisis ton appareil",
  "choisissez votre appareil",
  "sélectionne ton appareil",
  "scegli il tuo dispositivo",
  "seleziona il tuo dispositivo",
  "elige tu dispositivo",
  "selecciona tu dispositivo",
  "vyber své zařízení",
  "vyberte své zařízení",
  "wybierz swoje urządzenie",
  "wybierz urządzenie",
  "escolha o seu dispositivo",
  "escolhe o teu dispositivo",
  "kies je apparaat",
  "kies uw apparaat",
  "alege dispozitivul",
]);
// The card of the machine the bridge writes recipes for, and the cards it must not pick.
export const DEVICE_CHOICE = /^(?:Monsieur Cuisine|MC)\s*Smart(?!\p{L})/iu;
export const OTHER_DEVICES = /compact|connect|plus|trend|édition|edition/iu;
// The button that closes a hint next to the device chooser. A bare "OK" is left out: on a
// cookie banner it accepts.
export const HINT_BUTTON = startsWithPhrase([
  "OKAY",
  "Verstanden",
  "Alles klar",
  "Got it",
  "Understood",
  "Compris",
  "Capito",
  "Entendido",
  "Rozumím",
  "Rozumiem",
  "Entendi",
  "Begrepen",
  "Am înțeles",
]);

// Elements that hold a dialog, used to tell quickly whether a page has one at all.
export const DIALOG_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  "dialog[open]",
  "#onetrust-banner-sdk",
  "#usercentrics-root",
  "#CybotCookiebotDialog",
  'iframe[id^="sp_message"]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[id*="cookie-banner" i]',
  '[class*="cookie-banner" i]',
].join(", ");
