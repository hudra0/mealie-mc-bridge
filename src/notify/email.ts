// Notifications for problems nobody watches the admin page for: a dead Monsieur Cuisine
// session, a job that failed for good, a session check that keeps failing. Mails are plain
// text in UI_LANGUAGE (src/i18n). They never carry cookies or tokens: the inputs contain
// none, and every error text is scrubbed again before it is sent.

import { createTransport } from "nodemailer";
import { errorMessage, scrubSecrets, type AppLogger } from "../app-logger.js";
import { formatDate } from "../i18n/format.js";
import { messages, type Messages, type UiLanguage } from "../i18n/index.js";
import type { SessionStatus } from "../session/manager.js";
import type { Job } from "../store/jobs.js";

export interface Notifier {
  sessionExpired(status: SessionStatus): Promise<void>;
  jobFailed(job: Job, error: string): Promise<void>;
  healthFailed(error: string): Promise<void>;
}

export class NullNotifier implements Notifier {
  sessionExpired(): Promise<void> {
    return Promise.resolve();
  }
  jobFailed(): Promise<void> {
    return Promise.resolve();
  }
  healthFailed(): Promise<void> {
    return Promise.resolve();
  }
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

// The part of a nodemailer transporter the notifier uses.
export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

export interface EmailNotifierOptions {
  transport: MailTransport;
  to: string;
  from: string;
  logger: AppLogger;
  // Builds the link to a recipe in Mealie, when the public URL is known.
  recipeUrl?: (job: Job) => string | null;
  // The language of the mails; German by default.
  language?: UiLanguage;
}

// Job ids already reported; older ones drop out first.
const MAX_REMEMBERED_JOBS = 500;

export class EmailNotifier implements Notifier {
  readonly #transport: MailTransport;
  readonly #to: string;
  readonly #from: string;
  readonly #logger: AppLogger;
  readonly #recipeUrl: (job: Job) => string | null;
  readonly #messages: Messages;
  #lastSessionKey: string | null = null;
  #lastHealthError: string | null = null;
  readonly #reportedJobs = new Set<string>();

  constructor(options: EmailNotifierOptions) {
    this.#transport = options.transport;
    this.#to = options.to;
    this.#from = options.from;
    this.#logger = options.logger;
    this.#recipeUrl = options.recipeUrl ?? (() => null);
    this.#messages = messages(options.language ?? "de");
  }

  // One mail per state change: the same state for the same cookie is reported once.
  async sessionExpired(status: SessionStatus): Promise<void> {
    const key = `${status.state}:${status.cookieSetAt ?? "none"}`;
    if (key === this.#lastSessionKey) return;
    this.#lastSessionKey = key;
    this.#lastHealthError = null;
    const t = this.#messages.email;
    const text = status.state === "expired" ? t.session.expired : t.session.invalid;
    const lines = [
      text.lead,
      "",
      t.sessionWaiting,
      "",
      ...t.sessionNextSteps,
      "",
      t.lastChecked(this.#date(status.checkedAt)),
    ];
    if (status.lastError) lines.push(t.lastMessage(errorMessage(status.lastError)));
    await this.#send(text.subject, lines);
  }

  // One mail per job.
  async jobFailed(job: Job, error: string): Promise<void> {
    if (this.#reportedJobs.has(job.id)) return;
    this.#remember(job.id);
    const t = this.#messages.email;
    const title = job.title ?? job.mealieSlug ?? job.mealieRecipeId;
    const lines = [
      t.jobFailedLead(title),
      "",
      t.error(errorMessage(error)),
      t.job(job.id),
      t.attempts(job.attempts),
    ];
    const url = this.#recipeUrl(job);
    if (url) lines.push(t.recipeInMealie(url));
    lines.push("", t.jobRetry);
    await this.#send(t.jobFailedSubject(oneLine(title, 80)), lines);
  }

  // Consecutive failures with the same message are reported once.
  async healthFailed(error: string): Promise<void> {
    const message = errorMessage(error);
    if (message === this.#lastHealthError) return;
    this.#lastHealthError = message;
    const t = this.#messages.email;
    await this.#send(t.healthSubject, [t.healthLead, "", t.error(message), "", t.healthOutro]);
  }

  async #send(subject: string, lines: string[]): Promise<void> {
    const message: MailMessage = {
      from: this.#from,
      to: this.#to,
      subject: scrubSecrets(`${this.#messages.email.subjectPrefix}: ${subject}`),
      text: scrubSecrets(`${lines.join("\n")}\n`),
    };
    try {
      await this.#transport.sendMail(message);
      this.#logger.info({ subject: message.subject }, "notification sent");
    } catch (error) {
      // A broken mail server must not break the job or the session check.
      this.#logger.warn({ err: errorMessage(error) }, "notification failed");
    }
  }

  #date(iso: string | null): string {
    return iso ? formatDate(iso, this.#messages.intlLocale) : this.#messages.email.never;
  }

  #remember(id: string): void {
    this.#reportedJobs.add(id);
    if (this.#reportedJobs.size > MAX_REMEMBERED_JOBS) {
      const oldest = this.#reportedJobs.values().next().value;
      if (oldest !== undefined) this.#reportedJobs.delete(oldest);
    }
  }
}

export interface NotifierConfig {
  SMTP_URL?: string | undefined;
  NOTIFY_EMAIL?: string | undefined;
  SMTP_FROM?: string | undefined;
  UI_LANGUAGE?: UiLanguage | undefined;
}

// An EmailNotifier when SMTP_URL and NOTIFY_EMAIL are set, otherwise a NullNotifier.
export function createNotifier(
  config: NotifierConfig,
  logger: AppLogger,
  options: { recipeUrl?: (job: Job) => string | null; transport?: MailTransport } = {},
): Notifier {
  if (!config.SMTP_URL || !config.NOTIFY_EMAIL) {
    logger.info({}, "email notifications are off (SMTP_URL or NOTIFY_EMAIL not set)");
    return new NullNotifier();
  }
  const transport = options.transport ?? createTransport(config.SMTP_URL);
  return new EmailNotifier({
    transport,
    to: config.NOTIFY_EMAIL,
    from: config.SMTP_FROM ?? config.NOTIFY_EMAIL,
    logger,
    ...(options.recipeUrl ? { recipeUrl: options.recipeUrl } : {}),
    ...(config.UI_LANGUAGE ? { language: config.UI_LANGUAGE } : {}),
  });
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}
