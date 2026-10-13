import { z } from "zod";
import { DEFAULT_DEVICE_PROGRAMS_PATH } from "./recipe/limits.js";

const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http or https URL" });

// Every setting the bridge reads. Settings the service cannot run without are optional
// here, so tools that need only a few of them (scripts/mc-smoke.ts) can share the schema;
// loadServiceConfig enforces them for the service.
export const envSchema = z.object({
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
  // What the bridge does with a new draft: leave it a draft, or save it on the device only.
  MC_RECIPE_STATUS: z.enum(["draft", "private-publish"]).default("draft"),
  // Cookie header of a logged-in monsieur-cuisine.com session. A secret. The service stores
  // it on first start and whenever the value changes; the admin page can replace it.
  MC_COOKIE: z.string().min(1).optional(),
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
  TIMELINE_LANGUAGE: z.enum(["de"]).default("de"),
});

export type Config = z.infer<typeof envSchema>;

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
