// The configuration reference: one Markdown table row per environment variable, built from
// the zod schema in src/config.ts and the descriptions below. README.md carries the table
// between two markers, and config-reference.test.ts fails when the two drift apart.
//
// Defaults, required settings and allowed values come from the schema. Only the
// descriptions are written here, and the type of REFERENCE makes the compiler insist on one
// for every setting the schema has.
//
// Run: npm run docs:config                        rewrite the table in README.md
//      npx tsx scripts/config-reference.ts         print the table
//      npx tsx scripts/config-reference.ts --check exit 1 when README.md is out of date

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { z } from "zod";
import { SERVICE_REQUIRED, settingsSchema } from "../src/config.js";

type SettingName = keyof typeof settingsSchema.shape;

// Variables the process reads outside the schema.
type ExtraName = "TZ" | "NODE_ENV";

interface Entry {
  description: string;
  // Replaces the default taken from the schema, for defaults computed at runtime and for
  // settings that are required only in some setups.
  default?: string;
}

const REFERENCE = {
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
      "Time zone of the dates in timeline entries and mails, for example `Europe/Berlin`. Read by Node.js itself. The admin pages always show UTC.",
  },
  DATA_DIR: {
    description:
      "Directory of `bridge.db`. The image sets `/data`; leave it unset there, an empty value counts as unset anyway.",
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
      "How ingredients get their Monsieur Cuisine ingredient id, which the app uses for the shopping list. `exact`: bundled catalog, local cache, then the site's search, exact name matches only. `off`: no ids and no searches.",
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
} satisfies Record<SettingName, Entry> & Record<ExtraName, Entry & { default: string }>;

export type ReferenceName = keyof typeof REFERENCE;

export const README_START = "<!-- config-reference:start -->";
export const README_END = "<!-- config-reference:end -->";

export const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));

const HEADER = ["Variable", "Default", "Values", "Description"];

const code = (value: string) => `\`${value}\``;

function innerType(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodDefault || current instanceof z.ZodOptional) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

// Allowed values the schema states: enum members and number ranges.
function valuesCell(schema: z.ZodType): string {
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

function defaultCell(name: ReferenceName, entry: Entry): string {
  if (entry.default !== undefined) return entry.default;
  if ((SERVICE_REQUIRED as readonly string[]).includes(name)) return "**required**";
  const value = schemaDefaults[name];
  return value === undefined
    ? "unset"
    : code(Array.isArray(value) ? value.join(",") : String(value));
}

function isSetting(name: string): name is SettingName {
  return name in settingsSchema.shape;
}

export function referenceRows(): string[][] {
  return (Object.entries(REFERENCE) as Array<[ReferenceName, Entry]>).map(([name, entry]) => [
    code(name),
    defaultCell(name, entry),
    isSetting(name) ? valuesCell(settingsSchema.shape[name] as z.ZodType) : "",
    entry.description,
  ]);
}

function row(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
}

// The table as Prettier formats it, so it compares equal to the formatted README.
export async function referenceTable(): Promise<string> {
  const lines = [row(HEADER), row(HEADER.map(() => "---")), ...referenceRows().map(row)];
  const formatted = await prettier.format(`${lines.join("\n")}\n`, {
    ...(await prettier.resolveConfig(readmePath)),
    parser: "markdown",
  });
  return formatted.trimEnd();
}

// The table between the markers, or null when a marker is missing.
export function readmeTable(readme: string): string | null {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start === -1 || end === -1 || end < start) return null;
  return readme.slice(start + README_START.length, end).trim();
}

export function replaceReadmeTable(readme: string, table: string): string {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md needs the markers ${README_START} and ${README_END}`);
  }
  return `${readme.slice(0, start + README_START.length)}\n\n${table}\n\n${readme.slice(end)}`;
}

async function main(argv: readonly string[]): Promise<number> {
  const [mode, ...rest] = argv;
  if (rest.length > 0 || (mode !== undefined && mode !== "--check" && mode !== "--write")) {
    console.error("usage: tsx scripts/config-reference.ts [--check | --write]");
    return 64;
  }
  const table = await referenceTable();
  if (mode === undefined) {
    console.log(table);
    return 0;
  }
  const readme = readFileSync(readmePath, "utf8");
  if (mode === "--check") {
    if (readmeTable(readme) === table) {
      console.log(`README.md lists all ${referenceRows().length} variables.`);
      return 0;
    }
    console.error("The configuration table in README.md is out of date. Run npm run docs:config.");
    return 1;
  }
  writeFileSync(readmePath, replaceReadmeTable(readme, table));
  console.log(`README.md: wrote ${referenceRows().length} variables.`);
  return 0;
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
