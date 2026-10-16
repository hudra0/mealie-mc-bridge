// The notifier the service runs with. It builds an EmailNotifier from the effective mail
// setup and builds a new one when the settings page saves or deletes mail settings, so new
// settings apply without a restart. The session manager and the pipeline hold the mailer,
// never the EmailNotifier inside it.
//
// Precedence: SMTP_URL with NOTIFY_EMAIL in the environment wins, and the settings page shows
// it read only; otherwise the settings stored on the page apply; without either, no mail goes
// out. What has been reported (NotificationMemory) carries over to every new notifier.

import { createTransport as nodemailerTransport } from "nodemailer";
import { errorMessage, type AppLogger } from "../app-logger.js";
import type { UiLanguage } from "../i18n/index.js";
import type { SessionStatus } from "../session/manager.js";
import type { Job } from "../store/jobs.js";
import type { SettingsStore } from "../store/settings.js";
import {
  EmailNotifier,
  NotificationMemory,
  NullNotifier,
  type MailTransport,
  type Notifier,
  type SessionMailDetails,
} from "./email.js";
import {
  deleteMailSettings,
  envMail,
  parseMailForm,
  readMailSettings,
  storedMail,
  writeMailSettings,
  type MailEnv,
  type MailFieldErrors,
  type MailFormValues,
  type MailSettings,
  type MailSummary,
  type ResolvedMail,
  type SmtpOptions,
} from "./mail-settings.js";

// "env": SMTP_URL and NOTIFY_EMAIL; "ui": the settings page; "off": no mail.
export type MailSource = "env" | "ui" | "off";

export interface MailStatus {
  source: MailSource;
  // What the settings page shows; null when mail is off.
  summary: MailSummary | null;
  // Settings are stored but cannot be read, for example under another SETTINGS_KEY.
  unreadable: boolean;
}

export type MailSaveResult =
  | { status: "saved" }
  // The environment decides; the page cannot change it.
  | { status: "env" }
  | { status: "invalid"; errors: MailFieldErrors; values: MailFormValues };

export class MailOffError extends Error {
  constructor() {
    super("mail is not set up");
    this.name = "MailOffError";
  }
}

export interface MailerOptions {
  env: MailEnv & { UI_LANGUAGE?: UiLanguage | undefined };
  settings: SettingsStore;
  logger: AppLogger;
  // Builds the link to a recipe in Mealie, when the public URL is known.
  recipeUrl?: (job: Job) => string | null;
  // nodemailer's createTransport; tests pass a stub.
  createTransport?: (options: SmtpOptions) => MailTransport;
}

// What the settings page needs of the mailer.
export type MailPort = Pick<Mailer, "status" | "save" | "delete" | "testMail">;

export class Mailer implements Notifier {
  readonly #options: MailerOptions;
  readonly #memory = new NotificationMemory();
  #current: Notifier = new NullNotifier();
  #status: MailStatus = { source: "off", summary: null, unreadable: false };

  constructor(options: MailerOptions) {
    this.#options = options;
    this.#rebuild();
  }

  status(): MailStatus {
    return this.#status;
  }

  // Checks and stores the form of the settings page, then sends with it right away.
  save(body: Readonly<Record<string, unknown>>): MailSaveResult {
    if (this.#status.source === "env") return { status: "env" };
    const result = parseMailForm(body, this.#stored());
    if (!result.ok) return { status: "invalid", errors: result.errors, values: result.values };
    writeMailSettings(this.#options.settings, result.settings);
    this.#options.logger.info({}, "mail settings saved on the settings page");
    this.#rebuild();
    return { status: "saved" };
  }

  // Removes the stored settings; mail is off afterwards.
  delete(): "deleted" | "env" {
    if (this.#status.source === "env") return "env";
    deleteMailSettings(this.#options.settings);
    this.#options.logger.info({}, "mail settings deleted on the settings page");
    this.#rebuild();
    return "deleted";
  }

  // Throws MailOffError without a mail setup, or the mail server's scrubbed error.
  async testMail(): Promise<void> {
    const current = this.#current;
    if (!current.testMail) throw new MailOffError();
    await current.testMail();
  }

  sessionExpired(status: SessionStatus, details?: SessionMailDetails): Promise<void> {
    return this.#current.sessionExpired(status, details);
  }

  jobFailed(job: Job, error: string): Promise<void> {
    return this.#current.jobFailed(job, error);
  }

  healthFailed(error: string): Promise<void> {
    return this.#current.healthFailed(error);
  }

  // The stored settings, or null when there are none or they cannot be read.
  #stored(): MailSettings | null {
    try {
      return readMailSettings(this.#options.settings);
    } catch {
      return null;
    }
  }

  #rebuild(): void {
    const { logger } = this.#options;
    const fromEnv = envMail(this.#options.env);
    let mail: ResolvedMail | null = fromEnv;
    let unreadable = false;
    if (mail === null) {
      try {
        const stored = readMailSettings(this.#options.settings);
        mail = stored ? storedMail(stored) : null;
      } catch (error) {
        unreadable = true;
        logger.warn(
          { err: errorMessage(error) },
          "the stored mail settings cannot be read; mail is off until they are saved again",
        );
      }
    }
    const source: MailSource = fromEnv ? "env" : mail ? "ui" : "off";
    this.#current = mail ? this.#notifier(mail) : new NullNotifier();
    this.#status = { source, summary: mail?.summary ?? null, unreadable };
    logger.info(
      { source },
      source === "env"
        ? "email notifications use SMTP_URL from the environment"
        : source === "ui"
          ? "email notifications use the mail settings of the settings page"
          : "email notifications are off (no SMTP_URL and no mail settings)",
    );
  }

  #notifier(mail: ResolvedMail): EmailNotifier {
    const create =
      this.#options.createTransport ??
      ((options: SmtpOptions): MailTransport => nodemailerTransport(options));
    const { recipeUrl, env } = this.#options;
    return new EmailNotifier({
      transport: create(mail.transport),
      to: mail.to,
      from: mail.from,
      logger: this.#options.logger,
      memory: this.#memory,
      events: mail.events,
      redact: mail.secrets,
      ...(recipeUrl ? { recipeUrl } : {}),
      ...(env.UI_LANGUAGE ? { language: env.UI_LANGUAGE } : {}),
    });
  }
}
