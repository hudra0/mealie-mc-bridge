// Notifications for problems nobody watches the admin page for: a dead Monsieur Cuisine
// session, a job that failed for good, a session check that keeps failing. Mails are plain
// text in UI_LANGUAGE (src/i18n). They never carry cookies or tokens: the inputs contain
// none, and every error text is scrubbed again before it is sent. The mail account's own
// user name and password are cut out of the mail server's error texts before they reach a
// log or the settings page.

import { errorMessage, scrubSecrets, type AppLogger } from "../app-logger.js";
import { formatDate } from "../i18n/format.js";
import { messages, type Messages, type UiLanguage } from "../i18n/index.js";
import type { SessionStatus } from "../session/manager.js";
import type { Job } from "../store/jobs.js";
import { ALL_EVENTS, type MailEvents } from "./mail-settings.js";

// autoLoginFailed: why the automatic login with the stored Lidl account did not work; the
// mail then says that a manual login is needed.
// autoLoginNextAttempt: the automatic login has to wait until this time (ISO).
export interface SessionMailDetails {
  autoLoginFailed?: string;
  autoLoginNextAttempt?: string;
}

export interface Notifier {
  sessionExpired(status: SessionStatus, details?: SessionMailDetails): Promise<void>;
  jobFailed(job: Job, error: string): Promise<void>;
  healthFailed(error: string): Promise<void>;
  // Sends a test mail and throws when it does not go out. Only notifiers that send mail
  // have it.
  testMail?(): Promise<void>;
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

// Job ids already reported; older ones drop out first.
const MAX_REMEMBERED_JOBS = 500;

// What has been reported already. The mailer hands the same memory to every notifier it
// builds, so new mail settings do not repeat a mail about the same state or job.
export class NotificationMemory {
  lastSessionKey: string | null = null;
  lastHealthError: string | null = null;
  readonly #reportedJobs = new Set<string>();

  hasJob(id: string): boolean {
    return this.#reportedJobs.has(id);
  }

  rememberJob(id: string): void {
    this.#reportedJobs.add(id);
    if (this.#reportedJobs.size > MAX_REMEMBERED_JOBS) {
      const oldest = this.#reportedJobs.values().next().value;
      if (oldest !== undefined) this.#reportedJobs.delete(oldest);
    }
  }
}

export interface EmailNotifierOptions {
  transport: MailTransport;
  to: string | readonly string[];
  from: string;
  logger: AppLogger;
  // Builds the link to a recipe in Mealie, when the public URL is known.
  recipeUrl?: (job: Job) => string | null;
  // The language of the mails; German by default.
  language?: UiLanguage;
  // Shared with other notifiers; a fresh one by default.
  memory?: NotificationMemory;
  // Which mails go out; all by default. The test mail always does.
  events?: MailEvents;
  // Values cut out of the mail server's error texts: the account's user name and password.
  redact?: readonly string[];
}

// Values shorter than this are left alone: cutting out every "a" would garble the message
// and protect nothing.
const MIN_REDACTED_LENGTH = 3;

// Replaces each value, as it is and URL-encoded, with "[redacted]".
export function redactValues(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of values) {
    if (value.length < MIN_REDACTED_LENGTH) continue;
    for (const form of new Set([value, encodeURIComponent(value)])) {
      result = result.split(form).join("[redacted]");
    }
  }
  return result;
}

export class EmailNotifier implements Notifier {
  readonly #transport: MailTransport;
  readonly #to: string;
  readonly #from: string;
  readonly #logger: AppLogger;
  readonly #recipeUrl: (job: Job) => string | null;
  readonly #messages: Messages;
  readonly #memory: NotificationMemory;
  readonly #events: MailEvents;
  readonly #redact: readonly string[];

  constructor(options: EmailNotifierOptions) {
    this.#transport = options.transport;
    this.#to = typeof options.to === "string" ? options.to : options.to.join(", ");
    this.#from = options.from;
    this.#logger = options.logger;
    this.#recipeUrl = options.recipeUrl ?? (() => null);
    this.#messages = messages(options.language ?? "de");
    this.#memory = options.memory ?? new NotificationMemory();
    this.#events = options.events ?? ALL_EVENTS;
    this.#redact = options.redact ?? [];
  }

  // One mail per state change: the same state for the same cookie is reported once.
  async sessionExpired(status: SessionStatus, details: SessionMailDetails = {}): Promise<void> {
    if (!this.#events.session) return;
    const manual = details.autoLoginFailed !== undefined;
    const waiting = details.autoLoginNextAttempt !== undefined;
    const key = `${status.state}:${status.cookieSetAt ?? "none"}${manual ? ":manual" : waiting ? ":waiting" : ""}`;
    if (key === this.#memory.lastSessionKey) return;
    this.#memory.lastSessionKey = key;
    this.#memory.lastHealthError = null;
    const t = this.#messages.email;
    const text = status.state === "expired" ? t.session.expired : t.session.invalid;
    const lines = [
      text.lead,
      ...(details.autoLoginFailed === undefined
        ? []
        : ["", t.autoLoginFailed(errorMessage(details.autoLoginFailed))]),
      ...(details.autoLoginNextAttempt === undefined
        ? []
        : ["", t.autoLoginWaiting(this.#date(details.autoLoginNextAttempt))]),
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
    if (!this.#events.job || this.#memory.hasJob(job.id)) return;
    this.#memory.rememberJob(job.id);
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
    if (!this.#events.health) return;
    const message = errorMessage(error);
    if (message === this.#memory.lastHealthError) return;
    this.#memory.lastHealthError = message;
    const t = this.#messages.email;
    await this.#send(t.healthSubject, [t.healthLead, "", t.error(message), "", t.healthOutro]);
  }

  // Unlike the other mails, a failure reaches the caller, with secrets scrubbed.
  async testMail(): Promise<void> {
    const t = this.#messages.email;
    try {
      await this.#transport.sendMail(this.#message(t.testSubject, [t.testText]));
    } catch (error) {
      throw new Error(this.#errorText(error));
    }
    this.#logger.info({}, "test mail sent");
  }

  #message(subject: string, lines: string[]): MailMessage {
    return {
      from: this.#from,
      to: this.#to,
      subject: scrubSecrets(`${this.#messages.email.subjectPrefix}: ${subject}`),
      text: scrubSecrets(`${lines.join("\n")}\n`),
    };
  }

  async #send(subject: string, lines: string[]): Promise<void> {
    const message = this.#message(subject, lines);
    try {
      await this.#transport.sendMail(message);
      this.#logger.info({ subject: message.subject }, "notification sent");
    } catch (error) {
      // A broken mail server must not break the job or the session check.
      this.#logger.warn({ err: this.#errorText(error) }, "notification failed");
    }
  }

  // The mail server's error as one scrubbed line, without the account's user name and
  // password, which some servers repeat in their answer.
  #errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return errorMessage(redactValues(raw, this.#redact));
  }

  #date(iso: string | null): string {
    return iso ? formatDate(iso, this.#messages.intlLocale) : this.#messages.email.never;
  }
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}
