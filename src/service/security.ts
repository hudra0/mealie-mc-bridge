// Comparisons and log hygiene for the HTTP side.

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

// Compares two secrets in constant time. Both sides are hashed first, so neither the
// content nor the length of the expected value leaks through timing.
export function safeEqual(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export interface Credentials {
  user: string;
  password: string;
}

// Parses an "Authorization: Basic ..." header. Returns null for anything else.
export function parseBasicAuth(header: string | undefined): Credentials | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

// Checks user and password without stopping at the first mismatch.
export function credentialsMatch(given: Credentials | null, expected: Credentials): boolean {
  const user = safeEqual(given?.user ?? "", expected.user);
  const password = safeEqual(given?.password ?? "", expected.password);
  return given !== null && user && password;
}

// The webhook token sits in the path and the admin form token in dry-run links; neither
// may reach a log line.
export function redactUrl(url: string): string {
  return url
    .replace(/(\/hooks\/mealie\/)[^/?#]*/, "$1[redacted]")
    .replace(/([?&]_csrf=)[^&#]*/g, "$1[redacted]");
}

// Fastify's request serializer, with the URL redacted.
export function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
  };
}

export function serializeReply(reply: FastifyReply): Record<string, unknown> {
  return { statusCode: reply.statusCode };
}

// The serializers for Fastify's request logs. A pino instance passed to Fastify as
// loggerInstance needs them, because Fastify adds its own only to loggers it creates.
export const requestLogSerializers = { req: serializeRequest, res: serializeReply };
