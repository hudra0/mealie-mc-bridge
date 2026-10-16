// The mail server settings: from the environment (SMTP_URL, NOTIFY_EMAIL, SMTP_FROM,
// SMTP_ALLOW_INSECURE) or from the settings page, where they are stored in bridge.db as one
// value encrypted with SETTINGS_KEY, like the Lidl account. The environment wins (mailer.ts).
//
// Both sources end up as the same nodemailer options: STARTTLS is required unless an
// unencrypted connection is allowed explicitly, SSL/TLS talks TLS from the start, and a
// silent server is given up on after seconds. The password is never part of what a page
// shows (MailSummary), and a stored password is kept only for the host and user it was
// typed for.

import { isIP } from "node:net";
import { z } from "zod";
import type { SettingsStore } from "../store/settings.js";

export const MAIL_SECURITY = ["starttls", "tls", "none"] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];

export const MAIL_EVENTS = ["session", "job", "health"] as const;
export type MailEvent = (typeof MAIL_EVENTS)[number];
export type MailEvents = Readonly<Record<MailEvent, boolean>>;
export const ALL_EVENTS: MailEvents = { session: true, job: true, health: true };

// The settings row that holds the encrypted settings.
export const MAIL_SETTINGS_KEY = "notify.smtp";
export const MAX_RECIPIENTS = 10;
const MAX_USERNAME = 254;
const MAX_PASSWORD = 1024;

// nodemailer waits up to two minutes for a connection and ten for a reply by default; the
// test mail button would hang that long.
export const MAIL_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 60_000,
} as const;

// What the settings page stores and the bridge sends with. An empty `from` means the first
// recipient; an empty `username` means no login.
export interface MailSettings {
  host: string;
  port: number;
  security: MailSecurity;
  allowInsecure: boolean;
  username: string;
  password: string;
  from: string;
  to: string[];
  events: MailEvents;
}

const storedSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  security: z.enum(MAIL_SECURITY),
  allowInsecure: z.boolean(),
  username: z.string(),
  password: z.string(),
  from: z.string(),
  to: z.array(z.string()).min(1),
  events: z.object({ session: z.boolean(), job: z.boolean(), health: z.boolean() }),
});

// The options handed to nodemailer's createTransport: a URL (environment) or host and port
// (settings page).
export interface SmtpOptions {
  url?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  requireTLS: boolean;
  ignoreTLS?: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

// What the settings page shows of a mail setup. Never the password, only whether there is one.
export interface MailSummary {
  host: string;
  port: number;
  security: MailSecurity;
  allowInsecure: boolean;
  username: string | null;
  passwordSet: boolean;
  // The sender mails go out with, and the one configured: empty when it is the first
  // recipient.
  from: string;
  configuredFrom: string;
  to: readonly string[];
  events: MailEvents;
}

// A mail setup ready to send with.
export interface ResolvedMail {
  transport: SmtpOptions;
  from: string;
  to: readonly string[];
  events: MailEvents;
  // The user name and password, to be cut out of any error text of the mail server.
  secrets: readonly string[];
  summary: MailSummary;
}

// The settings of the environment the mail setup reads.
export interface MailEnv {
  SMTP_URL?: string | undefined;
  NOTIFY_EMAIL?: string | undefined;
  SMTP_FROM?: string | undefined;
  SMTP_ALLOW_INSECURE?: boolean | undefined;
}

// smtps:// talks TLS from the start. smtp:// must upgrade with STARTTLS (requireTLS), so a
// server or a man in the middle that does not offer it cannot get the password and the mails
// in plain text; SMTP_ALLOW_INSECURE=true lifts that for a mail server on the same host or
// network that has no TLS.
export function smtpTransportOptions(url: string, allowInsecure = false): SmtpOptions {
  const secure = url.toLowerCase().startsWith("smtps:");
  return { url, requireTLS: !secure && !allowInsecure, ...MAIL_TIMEOUTS };
}

// The same rules for the settings page. "none" does not even try STARTTLS, for a relay on
// the same host whose certificate would not verify.
export function settingsTransportOptions(settings: MailSettings): SmtpOptions {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls" && !settings.allowInsecure,
    ignoreTLS: settings.security === "none",
    ...(settings.username === ""
      ? {}
      : { auth: { user: settings.username, pass: settings.password } }),
    ...MAIL_TIMEOUTS,
  };
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// The setup of SMTP_URL and NOTIFY_EMAIL, or null when either is missing.
export function envMail(env: MailEnv): ResolvedMail | null {
  if (!env.SMTP_URL || !env.NOTIFY_EMAIL) return null;
  const url = new URL(env.SMTP_URL);
  const secure = url.protocol === "smtps:";
  const username = decoded(url.username);
  const password = decoded(url.password);
  const allowInsecure = env.SMTP_ALLOW_INSECURE === true;
  const from = env.SMTP_FROM ?? env.NOTIFY_EMAIL;
  const to = [env.NOTIFY_EMAIL];
  return {
    transport: smtpTransportOptions(env.SMTP_URL, allowInsecure),
    from,
    to,
    events: ALL_EVENTS,
    secrets: [username, password].filter((value) => value !== ""),
    summary: {
      host: url.hostname,
      // nodemailer's defaults for a URL without a port.
      port: url.port === "" ? (secure ? 465 : 587) : Number(url.port),
      security: secure ? "tls" : "starttls",
      allowInsecure,
      username: username === "" ? null : username,
      passwordSet: password !== "",
      from,
      configuredFrom: env.SMTP_FROM ?? "",
      to,
      events: ALL_EVENTS,
    },
  };
}

// The setup of settings stored on the settings page.
export function storedMail(settings: MailSettings): ResolvedMail {
  const from = settings.from === "" ? (settings.to[0] ?? "") : settings.from;
  return {
    transport: settingsTransportOptions(settings),
    from,
    to: settings.to,
    events: settings.events,
    secrets: [settings.username, settings.password].filter((value) => value !== ""),
    summary: {
      host: settings.host,
      port: settings.port,
      security: settings.security,
      allowInsecure: settings.allowInsecure,
      username: settings.username === "" ? null : settings.username,
      passwordSet: settings.password !== "",
      from,
      configuredFrom: settings.from,
      to: settings.to,
      events: settings.events,
    },
  };
}

// Null when nothing is stored. Throws when the value cannot be decrypted (another
// SETTINGS_KEY) or is not a settings record.
export function readMailSettings(store: SettingsStore): MailSettings | null {
  const raw = store.getSecret(MAIL_SETTINGS_KEY);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Setting ${MAIL_SETTINGS_KEY} is not valid mail settings`);
  return parsed.data;
}

export function writeMailSettings(store: SettingsStore, settings: MailSettings): void {
  store.setSecret(MAIL_SETTINGS_KEY, JSON.stringify(storedSchema.parse(settings)));
}

export function deleteMailSettings(store: SettingsStore): void {
  store.delete(MAIL_SETTINGS_KEY);
}

export type MailField = "host" | "port" | "security" | "username" | "password" | "from" | "to";

export const MAIL_ERROR_CODES = [
  "host_required",
  "host_invalid",
  "port_invalid",
  "security_invalid",
  "security_insecure",
  "username_invalid",
  "password_required",
  "password_reenter",
  "password_invalid",
  "from_invalid",
  "to_required",
  "to_invalid",
  "to_too_many",
] as const;
export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];
export type MailFieldErrors = Partial<Record<MailField, MailErrorCode>>;

// The form as submitted, without the password, to fill the form again after an error.
export interface MailFormValues {
  host: string;
  port: string;
  security: string;
  allowInsecure: boolean;
  username: string;
  from: string;
  to: string;
  events: MailEvents;
}

export type MailFormResult =
  | { ok: true; settings: MailSettings }
  | { ok: false; errors: MailFieldErrors; values: MailFormValues };

// The values a summary puts into the form.
export function summaryValues(summary: MailSummary): MailFormValues {
  return {
    host: summary.host,
    port: String(summary.port),
    security: summary.security,
    allowInsecure: summary.allowInsecure,
    username: summary.username ?? "",
    from: summary.configuredFrom,
    to: summary.to.join(", "),
    events: summary.events,
  };
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const CONTROL = /\p{Cc}/u;
const email = z.email();
// "Mealie Bridge <bridge@example.com>": a display name without quotes or angle brackets.
const NAMED_ADDRESS = /^([^<>"\p{Cc}]*?)\s*<([^<>\s]+)>$/u;

function isEmail(value: string): boolean {
  return !CONTROL.test(value) && email.safeParse(value).success;
}

function isSender(value: string): boolean {
  if (isEmail(value)) return true;
  const named = NAMED_ADDRESS.exec(value);
  return named !== null && isEmail(named[2] ?? "");
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const checked = (value: unknown): boolean => value === "1" || value === "on" || value === "true";

// Checks the form of the settings page. `previous` is what is stored: an empty password
// field keeps its password, but only for the same host and user name.
export function parseMailForm(
  body: Readonly<Record<string, unknown>>,
  previous: MailSettings | null,
): MailFormResult {
  const values: MailFormValues = {
    host: text(body.host).trim(),
    port: text(body.port).trim(),
    security: text(body.security),
    allowInsecure: checked(body.allow_insecure),
    username: text(body.username).trim(),
    from: text(body.from).trim(),
    to: text(body.to).trim(),
    events: {
      session: checked(body.event_session),
      job: checked(body.event_job),
      health: checked(body.event_health),
    },
  };
  const typed = text(body.password);
  const errors: MailFieldErrors = {};

  if (values.host === "") errors.host = "host_required";
  else if (isIP(values.host) === 0 && !HOSTNAME.test(values.host)) errors.host = "host_invalid";

  const port = Number(values.port);
  if (!/^\d{1,5}$/.test(values.port) || port < 1 || port > 65535) errors.port = "port_invalid";

  const security = (MAIL_SECURITY as readonly string[]).includes(values.security)
    ? (values.security as MailSecurity)
    : null;
  if (security === null) errors.security = "security_invalid";
  else if (security === "none" && !values.allowInsecure) errors.security = "security_insecure";

  if (values.username.length > MAX_USERNAME || CONTROL.test(values.username)) {
    errors.username = "username_invalid";
  }

  let password = "";
  if (values.username !== "") {
    if (typed.length > MAX_PASSWORD) errors.password = "password_invalid";
    else if (typed !== "") password = typed;
    else if (!previous || previous.password === "") errors.password = "password_required";
    else if (
      previous.host.toLowerCase() !== values.host.toLowerCase() ||
      previous.username !== values.username
    ) {
      errors.password = "password_reenter";
    } else password = previous.password;
  }

  if (values.from !== "" && !isSender(values.from)) errors.from = "from_invalid";

  const seen = new Set<string>();
  const to = values.to
    .split(/[,;\n]/)
    .map((address) => address.trim())
    .filter((address) => {
      const key = address.toLowerCase();
      if (address === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (to.length === 0) errors.to = "to_required";
  else if (!to.every(isEmail)) errors.to = "to_invalid";
  else if (to.length > MAX_RECIPIENTS) errors.to = "to_too_many";

  if (Object.keys(errors).length > 0 || security === null) return { ok: false, errors, values };
  return {
    ok: true,
    settings: {
      host: values.host,
      port,
      security,
      allowInsecure: values.allowInsecure,
      username: values.username,
      password,
      from: values.from,
      to,
      events: values.events,
    },
  };
}
