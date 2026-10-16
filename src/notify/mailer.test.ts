import { afterEach, describe, expect, it } from "vitest";
import type { SessionStatus } from "../session/manager.js";
import type { Job } from "../store/jobs.js";
import { capturingLogger, silentLogger, stubMail, type StubMail } from "../testing/fakes.js";
import { tempStore, type TempStore } from "../testing/temp.js";
import { MAIL_SETTINGS_KEY, readMailSettings } from "./mail-settings.js";
import { MailOffError, Mailer, type MailerOptions } from "./mailer.js";

const MARKER = "MARKER-PASSWORD-SMTP-47";
const USER = "marker-user-smtp-47@example.com";

const status = (overrides: Partial<SessionStatus> = {}): SessionStatus => ({
  state: "expired",
  checkedAt: "2026-10-13T10:00:00.000Z",
  cookieSetAt: "2026-10-01T10:00:00.000Z",
  cookieExpiresAt: null,
  cookieIssuedAt: null,
  cookieAgeHours: 288,
  cookieAgeFrom: "stored",
  lastError: "Monsieur Cuisine reported the session as expired",
  ...overrides,
});

const job = (id = "job-1"): Job => ({
  id,
  mealieRecipeId: "00000000-0000-4000-8000-000000000001",
  mealieSlug: "soup",
  title: "Pumpkin soup",
  scale: 1,
  servings: 4,
  servingUnit: "Portionen",
  status: "failed",
  attempts: 1,
  error: "boom",
  mcRecipeId: null,
  mcRecipeUrl: null,
  provider: null,
  model: null,
  usage: null,
  costUsd: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  updatedAt: "2026-10-13T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  force: false,
  conversion: null,
  createStartedAt: null,
  ingredients: null,
});

const form = {
  host: "mail.example.com",
  port: "587",
  security: "starttls",
  username: USER,
  password: MARKER,
  from: "",
  to: "cook@example.com",
  event_session: "1",
  event_job: "1",
  event_health: "1",
};

let store: TempStore | null = null;
afterEach(() => {
  store?.dispose();
  store = null;
});

function mailer(options: Partial<MailerOptions> = {}, mail: StubMail = stubMail()) {
  store ??= tempStore();
  const built = new Mailer({
    env: {},
    settings: store.settings,
    logger: silentLogger(),
    createTransport: mail.createTransport,
    ...options,
  });
  return { mailer: built, mail, store };
}

describe("Mailer precedence", () => {
  it("is off without the environment and without stored settings", async () => {
    const { mailer: m, mail } = mailer();
    expect(m.status()).toEqual({ source: "off", summary: null, unreadable: false });
    await m.sessionExpired(status());
    await m.jobFailed(job(), "x");
    await m.healthFailed("x");
    await expect(m.testMail()).rejects.toBeInstanceOf(MailOffError);
    expect(mail.transports).toEqual([]);
  });

  it("uses SMTP_URL and NOTIFY_EMAIL, read only, even with stored settings", async () => {
    store = tempStore();
    const ui = mailer();
    expect(ui.mailer.save(form)).toEqual({ status: "saved" });
    const env = {
      SMTP_URL: `smtps://env-user:${MARKER}@env.example.com`,
      NOTIFY_EMAIL: "env@example.com",
    };
    const { mailer: m, mail } = mailer({ env });
    expect(m.status()).toMatchObject({
      source: "env",
      summary: { host: "env.example.com", port: 465, security: "tls", username: "env-user" },
    });
    expect(m.save({ ...form, host: "other.example.com" })).toEqual({ status: "env" });
    expect(m.delete()).toBe("env");
    expect(readMailSettings(store.settings)?.host).toBe("mail.example.com");
    await m.healthFailed("site down");
    expect(mail.transports.map((t) => t.options.url)).toEqual([env.SMTP_URL]);
    expect(mail.sent[0]).toMatchObject({ to: "env@example.com", from: "env@example.com" });
  });

  it("writes the mails in UI_LANGUAGE and links the recipe", async () => {
    const { mailer: m, mail } = mailer({
      env: {
        SMTP_URL: "smtp://mail.example.com:587",
        NOTIFY_EMAIL: "cook@example.com",
        UI_LANGUAGE: "en",
      },
      recipeUrl: () => "https://mealie.example.com/g/home/r/soup",
    });
    await m.sessionExpired(status());
    await m.jobFailed(job(), "boom");
    await m.healthFailed("site down");
    const [expired, failed, health] = mail.sent;
    expect(expired?.subject).toBe("Monsieur Cuisine bridge: Session expired");
    expect(failed?.subject).toBe("Monsieur Cuisine bridge: “Pumpkin soup” not sent");
    expect(failed?.text).toContain("Recipe in Mealie: https://mealie.example.com/g/home/r/soup");
    expect(health?.text).toContain("Error: site down");
  });

  it("keeps a browser call log with the password out of the session mail", async () => {
    const { mailer: m, mail } = mailer({
      env: { SMTP_URL: "smtps://mail.example.com", NOTIFY_EMAIL: "cook@example.com" },
    });
    await m.sessionExpired(status(), {
      autoLoginFailed:
        'locator.fill: Timeout 5000ms exceeded.\nCall log:\n  - fill("MARKER-PASSWORD-12")',
    });
    expect(mail.sent[0]?.text).toContain("locator.fill: Timeout 5000ms exceeded.");
    expect(mail.sent[0]?.text).not.toContain("MARKER-PASSWORD-12");
  });

  it("builds a real nodemailer transport when none is passed, without connecting", () => {
    store = tempStore();
    const m = new Mailer({
      env: { SMTP_URL: "smtps://user:pass@mail.example.com:465", NOTIFY_EMAIL: "c@example.com" },
      settings: store.settings,
      logger: silentLogger(),
    });
    expect(m.status().source).toBe("env");
  });
});

describe("Mailer settings", () => {
  it("saves the settings encrypted and sends with them at once", async () => {
    const { mailer: m, mail, store: s } = mailer();
    expect(m.save(form)).toEqual({ status: "saved" });
    expect(s.settings.get(MAIL_SETTINGS_KEY)).not.toContain(MARKER);
    expect(m.status()).toMatchObject({
      source: "ui",
      summary: { host: "mail.example.com", username: USER, passwordSet: true },
    });
    await m.testMail();
    expect(mail.transports).toHaveLength(1);
    expect(mail.transports[0]?.options).toMatchObject({
      host: "mail.example.com",
      port: 587,
      requireTLS: true,
      auth: { user: USER, pass: MARKER },
    });
    expect(mail.sent[0]).toMatchObject({ to: "cook@example.com", from: "cook@example.com" });
  });

  it("keeps the stored password when the field is left empty", async () => {
    const { mailer: m, mail } = mailer();
    m.save(form);
    expect(m.save({ ...form, password: "", port: "2525" })).toEqual({ status: "saved" });
    await m.testMail();
    expect(mail.transports.at(-1)?.options).toMatchObject({
      port: 2525,
      auth: { pass: MARKER },
    });
  });

  it("answers an invalid form with the fields, without storing or echoing the password", () => {
    const { mailer: m, store: s } = mailer();
    const result = m.save({ ...form, to: "nope" });
    expect(result).toMatchObject({ status: "invalid", errors: { to: "to_invalid" } });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(s.settings.get(MAIL_SETTINGS_KEY)).toBeNull();
    expect(m.status().source).toBe("off");
  });

  it("deletes the settings and stops sending", async () => {
    const { mailer: m, mail, store: s } = mailer();
    m.save(form);
    expect(m.delete()).toBe("deleted");
    expect(s.settings.get(MAIL_SETTINGS_KEY)).toBeNull();
    expect(m.status().source).toBe("off");
    await m.jobFailed(job(), "boom");
    expect(mail.sent).toEqual([]);
  });

  it("reports stored settings it cannot read and is off then", () => {
    store = tempStore();
    store.settings.set(MAIL_SETTINGS_KEY, "v1:broken");
    const { mailer: m } = mailer();
    expect(m.status()).toEqual({ source: "off", summary: null, unreadable: true });
    // Saving again needs the password, since the old one is gone.
    expect(m.save({ ...form, password: "" })).toMatchObject({
      status: "invalid",
      errors: { password: "password_required" },
    });
    expect(m.save(form)).toEqual({ status: "saved" });
    expect(m.status()).toMatchObject({ source: "ui", unreadable: false });
  });

  it("swaps the transport at runtime and remembers what it reported", async () => {
    const { mailer: m, mail } = mailer();
    m.save(form);
    await m.jobFailed(job("job-1"), "boom");
    await m.sessionExpired(status());
    m.save({ ...form, host: "relay.example.com", password: "another-secret" });
    // The same job and the same session state are not reported twice.
    await m.jobFailed(job("job-1"), "boom");
    await m.sessionExpired(status());
    await m.jobFailed(job("job-2"), "boom");
    expect(mail.transports.map((t) => [t.options.host, t.sent.length])).toEqual([
      ["mail.example.com", 2],
      ["relay.example.com", 1],
    ]);
  });

  it("sends only the notification types that are switched on", async () => {
    const { mailer: m, mail } = mailer();
    m.save({ ...form, event_session: undefined, event_health: undefined });
    await m.sessionExpired(status());
    await m.healthFailed("down");
    await m.jobFailed(job(), "boom");
    await m.testMail();
    expect(mail.sent.map((message) => message.subject)).toEqual([
      "Monsieur-Cuisine-Bridge: „Pumpkin soup“ nicht gesendet",
      "Monsieur-Cuisine-Bridge: Testmail",
    ]);
  });

  it("sends to every recipient", async () => {
    const { mailer: m, mail } = mailer();
    m.save({ ...form, to: "cook@example.com, other@example.com" });
    await m.testMail();
    expect(mail.sent[0]?.to).toBe("cook@example.com, other@example.com");
  });
});

describe("Mailer secrets", () => {
  it("keeps the user name and password out of errors and logs", async () => {
    const leak = new Error(
      `535 5.7.8 authentication failed for ${USER} with password ${MARKER} (${encodeURIComponent(USER)})`,
    );
    const { logger, text } = capturingLogger();
    const { mailer: m } = mailer({ logger }, stubMail(leak));
    m.save(form);
    const error = await m.testMail().then(
      () => new Error("no error"),
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toContain("535 5.7.8 authentication failed for [redacted]");
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain(USER);
    await m.jobFailed(job(), "boom");
    await m.sessionExpired(status());
    const log = text();
    expect(log).toContain("notification failed");
    expect(log).toContain("mail settings saved on the settings page");
    expect(log).not.toContain(MARKER);
    expect(log).not.toContain(USER);
    expect(log).not.toContain(encodeURIComponent(USER));
    expect(JSON.stringify(m.status())).not.toContain(MARKER);
  });

  it("keeps the password of SMTP_URL out of errors and logs", async () => {
    const { logger, text } = capturingLogger();
    const { mailer: m } = mailer(
      {
        logger,
        env: {
          SMTP_URL: `smtps://${encodeURIComponent(USER)}:${MARKER}@mail.example.com`,
          NOTIFY_EMAIL: "cook@example.com",
        },
      },
      stubMail(new Error(`Invalid login: ${MARKER} rejected for ${USER}`)),
    );
    const error = await m.testMail().then(
      () => new Error("no error"),
      (caught: unknown) => caught as Error,
    );
    await m.healthFailed("down");
    expect(`${error.message}\n${text()}`).not.toMatch(new RegExp(`${MARKER}|${USER}`));
  });
});
