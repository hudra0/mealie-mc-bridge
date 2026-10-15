// The descriptions of every environment variable, in one place. The configuration table in
// README.md (scripts/config-reference.ts) and the settings page of the admin UI both read
// them.
//
// Defaults, required settings and allowed values come from the zod schema in config.ts.
// Only the descriptions are written here, and the type of REFERENCE makes the compiler
// insist on one for every setting the schema has.

import { z } from "zod";
import { SERVICE_REQUIRED, settingsSchema } from "./config.js";

export type SettingName = keyof typeof settingsSchema.shape;

// Variables the process reads outside the schema.
type ExtraName = "TZ" | "NODE_ENV";

export interface ReferenceEntry {
  description: string;
  // Replaces the default taken from the schema, for defaults computed at runtime and for
  // settings that are required only in some setups.
  default?: string;
}

export const REFERENCE = {
  PORT: { description: "TCP port the bridge listens on. The image's health check reads it too." },
  HOST: {
    description:
      "Interface to bind. Keep `0.0.0.0` in a container; `127.0.0.1` keeps a local run off the network.",
  },
  LOG_LEVEL: {
    description:
      "Log verbosity. `debug` logs every request to Mealie and Monsieur Cuisine. Secrets are masked at every level.",
  },
  TZ: {
    default: "UTC in the image",
    description:
      "Time zone of the dates in timeline entries, mails and the admin pages, for example `Europe/Berlin`. Read by Node.js itself.",
  },
  DATA_DIR: {
    description:
      "Directory of `bridge.db`. The image sets `/data`. Do not set it in `.env` with Docker: even an empty line overrides the image's value, and the bridge then falls back to `./data` inside `/app`.",
  },
  SETTINGS_KEY: {
    description:
      "Base64 of 32 random bytes; `generate-secrets` prints one. Encrypts the Monsieur Cuisine cookie in `bridge.db`. With another key the stored cookie cannot be read, and you paste it again.",
  },
  WEBHOOK_TOKEN: {
    description:
      "Secret path segment of the webhook, `/hooks/mealie/<WEBHOOK_TOKEN>`. At least 32 characters of letters, digits and `. _ ~ -`.",
  },
  MEALIE_URL: {
    description:
      "How the bridge reaches Mealie, for example `http://mealie:9000` on a shared Docker network. An http or https URL.",
  },
  MEALIE_API_TOKEN: {
    description: "API token of the Mealie user the bridge acts as. A secret.",
  },
  MEALIE_PUBLIC_URL: {
    default: "`MEALIE_URL`",
    description:
      "How you open Mealie in the browser, for example `https://mealie.example.com`. Used for links on the admin pages and in mails.",
  },
  MEALIE_GROUP_SLUG: {
    description: "The part after `/g/` in your Mealie recipe URLs, for those links.",
  },
  TAG_NAME: {
    description: "Tag the bridge adds to every recipe it sent, 1 to 60 characters.",
  },
  MC_LOCALE: {
    description:
      "Language of the recipes the bridge writes, and the Monsieur Cuisine settings of that language. Needs a locale pack in `KNOWLEDGE_DIR/locales/`: `de-DE` (verified on a device) or `en-US` (not verified).",
  },
  UI_LANGUAGE: {
    default: "language of `MC_LOCALE`, else `en`",
    description: "Language of timeline entries, mails and admin pages.",
  },
  MC_RECIPE_STATUS: {
    description:
      "What happens after the draft is created. `private-publish` saves the recipe on your device only, which makes it show up on the machine. `draft` leaves it in the web editor, where the machine does not see it; for debugging.",
  },
  MC_RESOLVE_INGREDIENTS: {
    description:
      'How ingredients get their Monsieur Cuisine ingredient id, which the app uses for the shopping list. `exact`: bundled catalog, also without qualifiers like "zum Garnieren", local cache, then the site\'s search. `off`: none.',
  },
  MC_COOKIE: {
    description:
      "Cookie header of a logged-in monsieur-cuisine.com browser session. A secret. Stored on the first start and whenever the value changes; the admin page can replace it at any time.",
  },
  SESSION_CHECK_MINUTES: {
    description: "Minutes between session checks. Each check is a cheap account call.",
  },
  DEVICE_PROGRAMS_PATH: {
    description:
      "Device limits the validator enforces. A relative path resolves against the working directory, `/app` in the image.",
  },
  LLM_PROVIDER: {
    description: "Language model provider that converts the recipes.",
  },
  OPENAI_API_KEY: {
    default: "required with `openai`",
    description:
      "OpenAI API key. A secret. Checked when a conversion runs, so a missing key fails the job, not the start.",
  },
  OPENAI_MODEL: {
    description:
      "OpenAI model. Any Responses API model with strict JSON schema support works; check that your account offers the default.",
  },
  OPENAI_REASONING_EFFORT: {
    description: "Reasoning effort of the OpenAI model.",
  },
  ANTHROPIC_API_KEY: {
    default: "required with `anthropic`",
    description: "Anthropic API key. A secret. Checked when a conversion runs.",
  },
  ANTHROPIC_MODEL: {
    description:
      "Anthropic model; check that your account offers the default. The effort is fixed at `high`.",
  },
  LLM_MAX_CORRECTIONS: {
    description:
      "Correction rounds after the first answer when the recipe fails the checks. Each round is another paid model call.",
  },
  KNOWLEDGE_DIR: {
    description:
      "Knowledge base the converter reads, with the locale packs under `locales/<locale>/`. A relative path resolves against the working directory.",
  },
  LLM_PRICES_JSON: {
    description:
      'Token prices in USD per million tokens for the cost estimate, merged over the built-in table, for example `{"gpt-5.5": {"input": 5, "cachedInput": 0.5, "output": 30}}`.',
  },
  WORKER_POLL_SECONDS: {
    description: "Seconds between queue polls. A webhook call wakes the worker at once.",
  },
  ADMIN_USER: {
    description:
      "Basic Auth user for the admin pages. Set it together with `ADMIN_PASSWORD`; without both the pages are open to anyone who reaches the port.",
  },
  ADMIN_PASSWORD: {
    description: "Basic Auth password for the admin pages. A secret.",
  },
  ADMIN_HOSTS: {
    description:
      "Host names the admin pages answer to, comma-separated, without ports. IP addresses and `localhost` always work. Without Basic Auth other names are refused, which blocks DNS rebinding.",
  },
  SMTP_URL: {
    description:
      "`smtp://` or `smtps://` URL with credentials, for example `smtps://user:password@mail.example.com:465`. Without it no mail is sent.",
  },
  NOTIFY_EMAIL: {
    default: "required with `SMTP_URL`",
    description:
      "Recipient of the mails: session expired or invalid, a job failed for good, the session check keeps failing.",
  },
  SMTP_FROM: {
    default: "`NOTIFY_EMAIL`",
    description: "Sender address of the mails.",
  },
  NODE_ENV: {
    default: "`production` in the image",
    description:
      "Anything but `production` makes `npm run dev` and `npm start` read `.env` from the working directory; variables already set win.",
  },
} satisfies Record<SettingName, ReferenceEntry> &
  Record<ExtraName, ReferenceEntry & { default: string }>;

export type ReferenceName = keyof typeof REFERENCE;

const code = (value: string) => `\`${value}\``;

function innerType(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodDefault || current instanceof z.ZodOptional) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

// Allowed values the schema states: enum members and number ranges.
export function valuesCell(schema: z.ZodType): string {
  const inner = innerType(schema);
  if (inner instanceof z.ZodEnum)
    return inner.options.map((option) => code(String(option))).join(", ");
  if (inner instanceof z.ZodNumber) {
    const json = z.toJSONSchema(inner) as {
      type?: string;
      minimum?: number;
      exclusiveMinimum?: number;
      maximum?: number;
    };
    const kind = json.type === "integer" ? "integer" : "number";
    const max = json.maximum === undefined ? "" : ` to ${json.maximum}`;
    if (json.minimum !== undefined) return `${kind} ${json.minimum}${max}`;
    if (json.exclusiveMinimum !== undefined) return `${kind} above ${json.exclusiveMinimum}${max}`;
    return kind;
  }
  return "";
}

// Defaults are strings, numbers or string lists.
const schemaDefaults = settingsSchema.parse({}) as Record<
  string,
  string | number | string[] | undefined
>;

export const REQUIRED_DEFAULT = "**required**";

export function defaultCell(name: ReferenceName, entry: ReferenceEntry): string {
  if (entry.default !== undefined) return entry.default;
  if ((SERVICE_REQUIRED as readonly string[]).includes(name)) return REQUIRED_DEFAULT;
  const value = schemaDefaults[name];
  return value === undefined
    ? "unset"
    : code(Array.isArray(value) ? value.join(",") : String(value));
}

export function isSetting(name: string): name is SettingName {
  return name in settingsSchema.shape;
}

// One row per variable: name, default, allowed values, description.
export function referenceRows(): string[][] {
  return (Object.entries(REFERENCE) as Array<[ReferenceName, ReferenceEntry]>).map(
    ([name, entry]) => [
      code(name),
      defaultCell(name, entry),
      isSetting(name) ? valuesCell(settingsSchema.shape[name] as z.ZodType) : "",
      entry.description,
    ],
  );
}

// Settings whose values are secrets. The admin page says only whether they are set.
export const SECRET_SETTINGS: ReadonlySet<ReferenceName> = new Set<ReferenceName>([
  "SETTINGS_KEY",
  "WEBHOOK_TOKEN",
  "MEALIE_API_TOKEN",
  "MC_COOKIE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ADMIN_PASSWORD",
  // Carries the mail account's password.
  "SMTP_URL",
]);

export interface ConfigEntry {
  name: ReferenceName;
  // "env": set in the environment; "default": the default applies; "unset": no value.
  source: "env" | "default" | "unset";
  // The effective value as text. Always null for a secret.
  value: string | null;
  secret: boolean;
  // The cells of the README table, with `code` spans.
  default: string;
  values: string;
  description: string;
}

// Parsed settings are strings, numbers, booleans or string lists.
function asText(value: unknown): string | null {
  if (Array.isArray(value)) return value.map((item) => asText(item) ?? "").join(",");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

// The configuration the service runs with, one entry per variable of the reference, with
// secrets reduced to "set" or "unset". `config` is the parsed configuration, `env` the
// environment it came from (to tell a set value from a default).
export function effectiveConfig(
  config: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
): ConfigEntry[] {
  return (Object.entries(REFERENCE) as Array<[ReferenceName, ReferenceEntry]>).map(
    ([name, entry]) => {
      const secret = SECRET_SETTINGS.has(name);
      const raw = env[name];
      const fromEnv = raw !== undefined && raw !== "";
      const text = isSetting(name) ? asText(config[name]) : fromEnv ? (raw ?? null) : null;
      return {
        name,
        source: fromEnv ? "env" : text === null ? "unset" : "default",
        value: secret ? null : text,
        secret,
        default: defaultCell(name, entry),
        values: isSetting(name) ? valuesCell(settingsSchema.shape[name] as z.ZodType) : "",
        description: entry.description,
      };
    },
  );
}
