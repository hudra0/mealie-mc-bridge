import { z } from "zod";

// More settings (Mealie, LLM provider) arrive with later features.
export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Device limits the validator enforces. A relative path resolves against the working
  // directory.
  DEVICE_PROGRAMS_PATH: z.string().min(1).default("./knowledge/device-programs.json"),
  // Cookie header of a logged-in monsieur-cuisine.com session. A secret.
  MC_COOKIE: z.string().min(1).optional(),
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
