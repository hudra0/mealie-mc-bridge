// Where the Monsieur Cuisine session cookie comes from, and who hears about a dead session.
//
// The session is the full Cookie header of a logged-in browser on www.monsieur-cuisine.com
// (wordpress_logged_in_<hash> and lidl_sso_id_token are the two that matter). It is a
// secret: providers keep it in private fields and never log it.

import { readFile } from "node:fs/promises";
import type { SessionErrorKind } from "./transport.js";

export interface SessionProvider {
  // The Cookie header value, or null when no session is configured.
  getCookie(): Promise<string | null>;
  // Called after the server rejected the cookie. Implementations flag the session for
  // renewal; they must not throw.
  onSessionError(kind: SessionErrorKind): Promise<void>;
}

export type SessionErrorListener = (kind: SessionErrorKind) => void | Promise<void>;

// Accepts what people paste: a bare header value, a "Cookie: ..." line, or one cookie per
// line. Lines starting with # are comments. Returns null when nothing is left.
export function normalizeCookieHeader(raw: string): string | null {
  const joined = raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^cookie:\s*/i, ""))
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join("; ")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("; ");
  return joined === "" ? null : joined;
}

// A cookie given once, for example from the MC_COOKIE environment variable.
export class StaticSessionProvider implements SessionProvider {
  readonly #cookie: string | null;
  readonly #listener: SessionErrorListener | undefined;
  #lastError: SessionErrorKind | null = null;

  constructor(cookie: string | null | undefined, listener?: SessionErrorListener) {
    this.#cookie = cookie ? normalizeCookieHeader(cookie) : null;
    this.#listener = listener;
  }

  get lastError(): SessionErrorKind | null {
    return this.#lastError;
  }

  getCookie(): Promise<string | null> {
    return Promise.resolve(this.#cookie);
  }

  async onSessionError(kind: SessionErrorKind): Promise<void> {
    this.#lastError = kind;
    await notify(this.#listener, kind);
  }
}

// A cookie kept in a file. The file is read on every call, so a renewed session is picked
// up without a restart. A missing file means no session.
export class FileSessionProvider implements SessionProvider {
  readonly #path: string;
  readonly #listener: SessionErrorListener | undefined;
  #lastError: SessionErrorKind | null = null;

  constructor(path: string, listener?: SessionErrorListener) {
    this.#path = path;
    this.#listener = listener;
  }

  get lastError(): SessionErrorKind | null {
    return this.#lastError;
  }

  async getCookie(): Promise<string | null> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new Error(`Cannot read the session cookie file: ${errorCode(error)}`);
    }
    return normalizeCookieHeader(raw);
  }

  async onSessionError(kind: SessionErrorKind): Promise<void> {
    this.#lastError = kind;
    await notify(this.#listener, kind);
  }
}

async function notify(listener: SessionErrorListener | undefined, kind: SessionErrorKind) {
  if (!listener) return;
  try {
    await listener(kind);
  } catch {
    // A failing listener must not hide the session error the caller is about to see.
  }
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown error";
}
