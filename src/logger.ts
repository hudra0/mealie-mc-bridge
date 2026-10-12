import { pino, type Logger, type LoggerOptions } from "pino";

// Never let credentials reach the logs, whatever shape the log call has.
export const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  'headers["x-api-key"]',
  "authorization",
  "cookie",
  "cookies",
  "token",
  "*.token",
  "*.accessToken",
  "*.apiKey",
  "*.api_key",
  "*.password",
  "*.cookie",
  "*.cookies",
  "*.authorization",
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: redactPaths, censor: "[redacted]" },
  };
}

export function createLogger(level: string): Logger {
  return pino(loggerOptions(level));
}
