import { z } from "zod";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_KNOWLEDGE_DIR,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_REASONING_EFFORT,
  OPENAI_REASONING_EFFORTS,
  PriceTableError,
  parsePriceOverrides,
} from "./convert/settings.js";
import { UI_LANGUAGES, defaultUiLanguage } from "./i18n/index.js";
import {
  DEFAULT_LOCALE,
  LOCALE_PATTERN,
  availableLocales,
  unknownLocaleMessage,
} from "./locale/pack.js";
import { DEFAULT_DEVICE_PROGRAMS_PATH } from "./recipe/limits.js";

export const LLM_PROVIDERS = ["openai", "anthropic"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

// More settings (Mealie, the job queue) arrive with later features.
const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http or https URL" });

// Every setting the bridge reads. Settings the service cannot run without are optional
// here, so tools that need only a few of them (scripts/mc-smoke.ts) can share the schema;
// loadServiceConfig enforces them for the service.
const settingsSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Device limits the validator enforces. A relative path resolves against the working
  // directory.
  DEVICE_PROGRAMS_PATH: z.string().min(1).default(DEFAULT_DEVICE_PROGRAMS_PATH),
  // Where bridge.db lives.
  DATA_DIR: z.string().min(1).default("./data"),
  // The secret path segment of the webhook URL Mealie posts to.
  WEBHOOK_TOKEN: z
    .string()
    .min(32, "must be at least 32 characters")
    .regex(/^[A-Za-z0-9._~-]+$/, "may only contain letters, digits and . _ ~ -")
    .optional(),
  // How the bridge reaches Mealie, usually the Docker service name.
  MEALIE_URL: httpUrl.optional(),
  // A long-lived Mealie API token. A secret.
  MEALIE_API_TOKEN: z.string().min(1).optional(),
  // How people reach Mealie in the browser, for links. Defaults to MEALIE_URL.
  MEALIE_PUBLIC_URL: httpUrl.optional(),
  // The part after /g/ in a Mealie recipe URL, for links.
  MEALIE_GROUP_SLUG: z.string().min(1).default("home"),
  // What the bridge does after it creates the draft. private-publish saves the recipe on the
  // device only, which is the only way it shows up on the machine. A draft is visible in the
  // web editor but not on the device, so "draft" is for debugging.
  MC_RECIPE_STATUS: z.enum(["draft", "private-publish"]).default("private-publish"),
  // How ingredients get their systemIngredientId, which the app uses for its shopping list
  // and ingredient filters. exact: from the bundled catalog, then a cache, then the
  // Monsieur Cuisine search, exact name matches only. off: every ingredient goes out
  // without an id.
  MC_RESOLVE_INGREDIENTS: z.enum(["exact", "off"]).default("exact"),
  // The language of the recipes the bridge writes, and everything Monsieur Cuisine needs per
  // language (complexity ids, editor path, proxy language). A locale pack for it must exist
  // under KNOWLEDGE_DIR/locales.
  MC_LOCALE: z.string().regex(LOCALE_PATTERN, "must look like de-DE").default(DEFAULT_LOCALE),
  // The language of Mealie timeline entries, mails and the admin pages. Defaults to the
  // language of MC_LOCALE when there is a catalog for it, else English.
  UI_LANGUAGE: z.enum(UI_LANGUAGES).optional(),
  // Cookie header of a logged-in monsieur-cuisine.com session. A secret. The service stores
  // it on first start and whenever the value changes; the admin page can replace it.
  MC_COOKIE: z.string().min(1).optional(),
  // The language model that converts recipes. The key of the selected provider is
  // required when a conversion runs (resolveLlmConfig), not at startup.
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default("openai"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Check the default against the models your OpenAI account offers.
  OPENAI_MODEL: z.string().min(1).default(DEFAULT_OPENAI_MODEL),
  OPENAI_REASONING_EFFORT: z
    .enum(OPENAI_REASONING_EFFORTS)
    .default(DEFAULT_OPENAI_REASONING_EFFORT),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default(DEFAULT_ANTHROPIC_MODEL),
  // Correction rounds after the first answer.
  LLM_MAX_CORRECTIONS: z.coerce.number().int().min(0).max(10).default(3),
  // The knowledge base directory. A relative path resolves against the working directory.
  KNOWLEDGE_DIR: z.string().min(1).default(DEFAULT_KNOWLEDGE_DIR),
  // Overrides for the token price table, JSON: {"model": {"input": 5, "output": 30}}.
  LLM_PRICES_JSON: z
    .string()
    .min(1)
    .optional()
    .superRefine((value, ctx) => {
      try {
        parsePriceOverrides(value);
      } catch (error) {
        if (!(error instanceof PriceTableError)) throw error;
        ctx.addIssue({ code: "custom", message: error.message });
      }
    }),
  // Base64 of 32 random bytes; encrypts secrets in bridge.db.
  SETTINGS_KEY: z
    .string()
    .refine((value) => isSettingsKey(value), "must be the base64 encoding of 32 bytes")
    .optional(),
  ADMIN_USER: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  // Host names the admin pages answer to, comma-separated, without ports. IP addresses and
  // localhost always work. Enforced when Basic Auth is off (it blocks DNS rebinding) and
  // whenever it is set.
  ADMIN_HOSTS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    )
    .optional(),
  // smtp:// or smtps:// URL with credentials. Without it, no mail is sent.
  SMTP_URL: z.url({ protocol: /^smtps?$/, error: "must be an smtp or smtps URL" }).optional(),
  NOTIFY_EMAIL: z.email("must be an email address").optional(),
  // Sender address. Defaults to NOTIFY_EMAIL.
  SMTP_FROM: z.string().min(3).optional(),
  SESSION_CHECK_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  WORKER_POLL_SECONDS: z.coerce.number().positive().max(60).default(2),
  TAG_NAME: z.string().trim().min(1).max(60).default("Monsieur Cuisine"),
});

// The settings with the cross-checks: MC_LOCALE needs a locale pack, and UI_LANGUAGE gets
// its default from MC_LOCALE.
export const envSchema = settingsSchema
  .superRefine((env, ctx) => {
    const available = availableLocales(env.KNOWLEDGE_DIR);
    if (!available.includes(env.MC_LOCALE)) {
      ctx.addIssue({
        code: "custom",
        path: ["MC_LOCALE"],
        message: unknownLocaleMessage(env.MC_LOCALE, available),
      });
    }
  })
  .transform((env) => ({
    ...env,
    UI_LANGUAGE: env.UI_LANGUAGE ?? defaultUiLanguage(env.MC_LOCALE),
  }));

export type Config = z.output<typeof envSchema>;

// The settings the service needs on top of the shared ones.
export const SERVICE_REQUIRED = [
  "WEBHOOK_TOKEN",
  "MEALIE_URL",
  "MEALIE_API_TOKEN",
  "SETTINGS_KEY",
] as const;

export type ServiceConfig = Config & {
  [K in (typeof SERVICE_REQUIRED)[number]]-?: NonNullable<Config[K]>;
};

export function isSettingsKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").length === 32;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value in an env file arrives as an empty string. Treat it as unset.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(present);
  if (!result.success) {
    // Only the field name and zod's message: a value, such as the cookie, is never quoted.
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  return result.data;
}

export type LlmConfig =
  | {
      provider: "openai";
      apiKey: string;
      model: string;
      reasoningEffort: Config["OPENAI_REASONING_EFFORT"];
    }
  | { provider: "anthropic"; apiKey: string; model: string };

export class MissingApiKeyError extends Error {
  constructor(provider: LlmProvider, variable: string) {
    super(`LLM_PROVIDER is ${provider}, but ${variable} is not set. Put the key into ${variable}.`);
    this.name = "MissingApiKeyError";
  }
}

// The settings of the selected provider. Throws MissingApiKeyError when its key is not set.
export function resolveLlmConfig(config: Config, provider: LlmProvider = config.LLM_PROVIDER) {
  if (provider === "openai") {
    if (!config.OPENAI_API_KEY) throw new MissingApiKeyError(provider, "OPENAI_API_KEY");
    return {
      provider,
      apiKey: config.OPENAI_API_KEY,
      model: config.OPENAI_MODEL,
      reasoningEffort: config.OPENAI_REASONING_EFFORT,
    } satisfies LlmConfig;
  }
  if (!config.ANTHROPIC_API_KEY) throw new MissingApiKeyError(provider, "ANTHROPIC_API_KEY");
  return {
    provider,
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_MODEL,
  } satisfies LlmConfig;
}

// The configuration of the service: everything loadConfig checks, plus the settings the
// service cannot start without and the pairs that only make sense together.
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const config = loadConfig(env);
  const problems: string[] = [];
  for (const key of SERVICE_REQUIRED) {
    if (config[key] === undefined) problems.push(`${key}: is required`);
  }
  if ((config.ADMIN_USER === undefined) !== (config.ADMIN_PASSWORD === undefined)) {
    problems.push("ADMIN_USER, ADMIN_PASSWORD: set both or neither");
  }
  if (config.SMTP_URL !== undefined && config.NOTIFY_EMAIL === undefined) {
    problems.push("NOTIFY_EMAIL: is required when SMTP_URL is set");
  }
  if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  return config as ServiceConfig;
}
