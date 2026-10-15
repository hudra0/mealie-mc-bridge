// Error texts of the browser login that are safe to store, log, show and mail.
//
// Playwright appends the call log of a failed action to its error message, and the call
// log of a fill() names the value: `fill("<password>")`. So no Playwright message leaves the
// browser adapter. Each failure becomes one fixed text per class (timeout, navigation,
// selector, launch), and whatever still reaches the stored attempt passes scrubLoginDetail,
// which drops anything that looks like a call log and masks the account's own values.

import { scrubSecrets } from "../app-logger.js";

export type BrowserFailureKind = "timeout" | "navigation" | "selector" | "launch";

export const BROWSER_FAILURE_TEXT: Readonly<Record<BrowserFailureKind, string>> = {
  timeout: "the browser timed out on the login page",
  navigation: "the login page did not load",
  selector: "an element of the login page could not be used",
  launch: "the browser did not start",
};

// What a stored attempt says when its detail cannot be kept.
export const WITHHELD_DETAIL = "browser error (details withheld)";
export const UNKNOWN_BROWSER_FAILURE = "the browser failed unexpectedly";

// A browser failure with a fixed message; the original error is not kept, not even as cause.
export class BrowserActionError extends Error {
  readonly kind: BrowserFailureKind;
  constructor(kind: BrowserFailureKind) {
    super(BROWSER_FAILURE_TEXT[kind]);
    this.name = "BrowserActionError";
    this.kind = kind;
  }
}

// Playwright marks timeouts with the error name TimeoutError.
export function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "TimeoutError" || /\btimeout\b/i.test(error.name))
  );
}

// The fixed error for a failed browser call: a timeout, or the class of the call.
export function browserFailure(error: unknown, kind: BrowserFailureKind): BrowserActionError {
  if (error instanceof BrowserActionError) return error;
  return new BrowserActionError(isTimeout(error) ? "timeout" : kind);
}

// The detail of a failed login for an error thrown in the flow: the fixed text of a
// browser failure, otherwise a generic one. Never the message of an unknown error.
export function browserFailureDetail(error: unknown): string {
  return error instanceof BrowserActionError ? error.message : UNKNOWN_BROWSER_FAILURE;
}

// A Playwright call log or an action with its value.
const CALL_LOG = /call log|\b(?:fill|type|pressSequentially|press)\(\s*["'`]/i;

// The detail as it may be stored and shown: withheld entirely when it carries a call log,
// with the given values (the e-mail address and the password) masked, and scrubbed of
// anything that looks like a credential.
export function scrubLoginDetail(detail: string, secrets: readonly string[] = []): string {
  if (CALL_LOG.test(detail)) return WITHHELD_DETAIL;
  let text = detail;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret)])) {
      text = text.split(form).join("[redacted]");
    }
  }
  const line = scrubSecrets(text).replace(/\s+/g, " ").trim();
  return line.length > 500 ? `${line.slice(0, 500)}...` : line;
}
