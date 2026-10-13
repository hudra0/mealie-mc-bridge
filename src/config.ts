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
import { DEFAULT_DEVICE_PROGRAMS_PATH } from "./recipe/limits.js";

export const LLM_PROVIDERS = ["openai", "anthropic"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

// More settings (Mealie, the job queue) arrive with later features.
export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Device limits the validator enforces. A relative path resolves against the working
  // directory.
  DEVICE_PROGRAMS_PATH: z.string().min(1).default(DEFAULT_DEVICE_PROGRAMS_PATH),
  // Cookie header of a logged-in monsieur-cuisine.com session. A secret.
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
});

export type Config = z.infer<typeof envSchema>;

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
