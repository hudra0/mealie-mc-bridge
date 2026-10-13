// Notifications for problems nobody watches the admin page for: a dead Monsieur Cuisine
// session, a job that failed for good, a session check that keeps failing. Mails are plain
// German text. They never carry cookies or tokens: the inputs contain none, and every
// error text is scrubbed again before it is sent.

import { createTransport } from "nodemailer";
import { errorMessage, scrubSecrets, type AppLogger } from "../app-logger.js";
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
}

const SUBJECT_PREFIX = "Monsieur-Cuisine-Bridge";
// Job ids already reported; older ones drop out first.
const MAX_REMEMBERED_JOBS = 500;

const SESSION_TEXT: Readonly<Record<string, { subject: string; lead: string }>> = {
  expired: {
    subject: "Sitzung abgelaufen",
    lead: "Die Monsieur-Cuisine-Sitzung der Bridge ist abgelaufen.",
  },
  invalid: {
    subject: "Sitzung ungültig",
    lead: "Monsieur Cuisine lehnt das gespeicherte Sitzungs-Cookie ab, oder es ist keines hinterlegt.",
  },
};

export class EmailNotifier implements Notifier {
  readonly #transport: MailTransport;
  readonly #to: string;
  readonly #from: string;
  readonly #logger: AppLogger;
  readonly #recipeUrl: (job: Job) => string | null;
  #lastSessionKey: string | null = null;
  #lastHealthError: string | null = null;
  readonly #reportedJobs = new Set<string>();

  constructor(options: EmailNotifierOptions) {
    this.#transport = options.transport;
    this.#to = options.to;
    this.#from = options.from;
    this.#logger = options.logger;
    this.#recipeUrl = options.recipeUrl ?? (() => null);
  }

  // One mail per state change: the same state for the same cookie is reported once.
  async sessionExpired(status: SessionStatus): Promise<void> {
    const key = `${status.state}:${status.cookieSetAt ?? "none"}`;
    if (key === this.#lastSessionKey) return;
    this.#lastSessionKey = key;
    this.#lastHealthError = null;
    const text = SESSION_TEXT[status.state] ?? SESSION_TEXT.invalid!;
    const lines = [
      text.lead,
      "",
      "Neue Aufträge aus Mealie warten, bis eine gültige Sitzung hinterlegt ist, und laufen dann automatisch weiter.",
      "",
      "So geht es weiter:",
      "1. Auf www.monsieur-cuisine.com anmelden.",
      "2. Das Cookie aus den Entwicklerwerkzeugen des Browsers kopieren (siehe README, „Run it“, Schritt 5: „Paste the Monsieur Cuisine session“).",
      "3. Auf der Admin-Seite der Bridge (/admin) einfügen und speichern.",
      "",
      `Zuletzt geprüft: ${formatDate(status.checkedAt)}`,
    ];
    if (status.lastError) lines.push(`Letzte Meldung: ${errorMessage(status.lastError)}`);
    await this.#send(text.subject, lines);
  }

  // One mail per job.
  async jobFailed(job: Job, error: string): Promise<void> {
    if (this.#reportedJobs.has(job.id)) return;
    this.#remember(job.id);
    const title = job.title ?? job.mealieSlug ?? job.mealieRecipeId;
    const lines = [
      `Das Rezept „${title}“ konnte nicht an Monsieur Cuisine gesendet werden.`,
      "",
      `Fehler: ${errorMessage(error)}`,
      `Auftrag: ${job.id}`,
      `Versuche: ${job.attempts}`,
    ];
    const url = this.#recipeUrl(job);
    if (url) lines.push(`Rezept in Mealie: ${url}`);
    lines.push(
      "",
      "Auf der Admin-Seite der Bridge (/admin/jobs) lässt sich der Auftrag erneut starten.",
    );
    await this.#send(`„${oneLine(title, 80)}“ nicht gesendet`, lines);
  }

  // Consecutive failures with the same message are reported once.
  async healthFailed(error: string): Promise<void> {
    const message = errorMessage(error);
    if (message === this.#lastHealthError) return;
    this.#lastHealthError = message;
    await this.#send("Sitzungsprüfung fehlgeschlagen", [
      "Die regelmäßige Prüfung der Monsieur-Cuisine-Sitzung ist fehlgeschlagen. Die Sitzung selbst wurde dabei nicht abgelehnt; meist ist die Website kurz nicht erreichbar.",
      "",
      `Fehler: ${message}`,
      "",
      "Die Bridge prüft weiter. Bleibt der Fehler bestehen, hilft ein Blick in die Logs.",
    ]);
  }

  async #send(subject: string, lines: string[]): Promise<void> {
    const message: MailMessage = {
      from: this.#from,
      to: this.#to,
      subject: scrubSecrets(`${SUBJECT_PREFIX}: ${subject}`),
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
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "noch nie";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}
