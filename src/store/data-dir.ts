// Startup checks for DATA_DIR. The container runs as the unprivileged user "bridge" (uid and
// gid 1000), so a bind mount or volume owned by root is the most common reason the bridge
// cannot start. The check turns that into one log line that says what to do.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The uid and gid of the service user in the Docker image.
export const SERVICE_UID = 1000;

export const CHOWN_HINT = `chown the data directory to the service user, uid ${SERVICE_UID} (for example: chown -R ${SERVICE_UID}:${SERVICE_UID} <host path of the data volume>)`;

export class DataDirError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DataDirError";
  }
}

const PROBE_FILE = ".write-test";

// Creates DATA_DIR when it is missing and proves that the process can write into it. SQLite
// alone would report "unable to open database file", which names neither the directory nor
// the cause.
export function checkDataDir(dataDir: string): void {
  const dir = resolve(dataDir);
  const probe = join(dir, PROBE_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (error) {
    throw new DataDirError(`DATA_DIR ${dir} is not writable (${errorText(error)})`, {
      cause: error,
    });
  }
}

// Error codes and SQLite messages that mean "this process may not write here".
const PERMISSION_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "SQLITE_CANTOPEN",
  "SQLITE_READONLY",
]);
const PERMISSION_TEXT = /unable to open database file|readonly database|permission denied/i;

export function isPermissionError(error: unknown): boolean {
  if (error instanceof DataDirError) return true;
  const code = errorCode(error);
  if (code !== null && PERMISSION_CODES.has(code)) return true;
  return PERMISSION_TEXT.test(errorText(error));
}

export interface ProcessIds {
  uid: number | null;
  gid: number | null;
}

export function processIds(): ProcessIds {
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
  };
}

// The one line the bridge logs before it exits because the store cannot be opened or
// migrated.
export function storeStartupMessage(
  error: unknown,
  dataDir: string,
  ids: ProcessIds = processIds(),
): string {
  const dir = resolve(dataDir);
  const who =
    ids.uid === null ? "" : ` The bridge runs as uid ${ids.uid}, gid ${ids.gid ?? "unknown"}.`;
  if (isPermissionError(error)) {
    const reason = error instanceof DataDirError ? error.message : `${errorText(error)} in ${dir}`;
    return `Cannot open the database: ${reason}; ${CHOWN_HINT}.${who}`;
  }
  return `Cannot open or migrate the database in DATA_DIR ${dir}: ${errorText(error)}.${who}`;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = errorCode(error);
    return code && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
