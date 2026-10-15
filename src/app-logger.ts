import type { BaseLogger } from "pino";

// The logger methods the service modules use. Fastify's request and app loggers and any
// pino instance satisfy it.
export type AppLogger = Pick<BaseLogger, "debug" | "info" | "warn" | "error">;

// Values that look like credentials, wherever they appear in free text: cookie headers and
// the Monsieur Cuisine session cookies, bearer tokens, key=value secrets and the webhook
// token in the hook path. Error messages from clients are scrubbed with this before they
// reach a mail, the Mealie timeline or a page.
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Playwright appends the call log of a failed action to its message, and the call log of
  // a fill() names the typed value. Everything from "Call log:" on goes.
  [/\s*Call log:[\s\S]*$/gi, ""],
  [/\b(fill|type|pressSequentially)\(\s*(["'`])(?:\\.|(?!\2)[^\\])*\2\s*\)/g, '$1("[redacted]")'],
  [/\b(cookie:\s*)[^\r\n]+/gi, "$1[redacted]"],
  [/\b(wordpress_logged_in_[A-Za-z0-9]*|lidl_sso_id_token|PHPSESSID)=[^;\s]+/g, "$1=[redacted]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [
    /\b(token|api[_-]?key|password|passwd|secret)(["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi,
    "$1$2[redacted]",
  ],
  [/(\/hooks\/mealie\/)[^/?#\s]+/g, "$1[redacted]"],
];

export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

// A short, single-line message for an unknown error value.
export function errorMessage(error: unknown, max = 500): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = scrubSecrets(raw).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}
