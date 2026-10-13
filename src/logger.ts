import { stdSerializers, type LoggerOptions } from "pino";
import type { Config } from "./config.js";

const censor = "[redacted]";

// Key names whose values must never reach the logs, at any depth and in any letter case.
// The Monsieur Cuisine session cookies are covered by name: wordpress_logged_in_<hash>
// has a per-site suffix, which pino's path redaction cannot match.
const sensitiveKey =
  /^(wordpress_logged_in_.*|lidl_sso_id_token|authorization|cookie|set-cookie|x-api-key|.*(api[_-]?key|password|passwd|secret|token|cookies?))$/i;

const maxDepth = 8;

// Returns a copy with sensitive values masked. Plain objects and arrays are walked.
// Errors are serialized first, because HTTP client errors often carry the request
// config with its headers. Other class instances pass through to their own serializers.
// Past the depth limit the subtree is dropped, so a deep secret cannot slip through.
export function maskSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (depth > maxDepth) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  // The spread gives a plain object, which the walk below can enter.
  if (value instanceof Error) return maskSecrets({ ...stdSerializers.err(value) }, depth, seen);
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, depth + 1, seen));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? censor : maskSecrets(item, depth + 1, seen),
    ]),
  );
}

// Path redaction as a second layer for objects that are serialized after the mask runs.
export const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  "headers.Authorization",
  "headers.Cookie",
  'headers["set-cookie"]',
  'headers["Set-Cookie"]',
  'headers["x-api-key"]',
  "authorization",
  "cookie",
  "cookies",
  "token",
  "apiKey",
  "api_key",
  "password",
  "lidl_sso_id_token",
  "*.token",
  "*.accessToken",
  "*.idToken",
  "*.apiKey",
  "*.api_key",
  "*.password",
  "*.cookie",
  "*.cookies",
  "*.authorization",
  "*.lidl_sso_id_token",
];

export function loggerOptions(level: Config["LOG_LEVEL"]): LoggerOptions {
  return {
    level,
    redact: { paths: redactPaths, censor },
    // maskSecrets already serialized any Error, so pino's own err serializer must not run again.
    serializers: { err: (value: unknown) => value },
    formatters: {
      log: (object) => maskSecrets(object) as Record<string, unknown>,
    },
  };
}
