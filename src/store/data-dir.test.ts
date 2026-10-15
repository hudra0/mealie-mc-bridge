import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, tempStore, type TempStore } from "../testing/temp.js";
import { DataDirError, checkDataDir, isPermissionError, storeStartupMessage } from "./data-dir.js";
import { openDatabase } from "./db.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function dir(): string {
  const temp = tempDir();
  cleanups.push(temp.cleanup);
  return temp.dir;
}

function codeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("checkDataDir", () => {
  it("creates a missing directory and leaves no probe file behind", () => {
    const target = join(dir(), "nested", "data");
    checkDataDir(target);
    expect(() => checkDataDir(target)).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "creates the directory and a new database for the bridge user only",
    () => {
      const target = join(dir(), "data");
      checkDataDir(target);
      expect(statSync(target).mode & 0o777).toBe(0o700);
      const db = openDatabase(join(target, "bridge.db"));
      db.close();
      expect(statSync(join(target, "bridge.db")).mode & 0o777).toBe(0o600);
    },
  );

  it("names the directory when it cannot write there", () => {
    const base = dir();
    const blocked = join(base, "file");
    writeFileSync(blocked, "not a directory");
    expect(() => checkDataDir(blocked)).toThrow(DataDirError);
    expect(() => checkDataDir(blocked)).toThrow(/DATA_DIR .*file is not writable/);
  });
});

describe("storeStartupMessage", () => {
  const ids = { uid: 0, gid: 0 };

  it("tells the admin to chown the directory when the process may not write", () => {
    const message = storeStartupMessage(
      new DataDirError("DATA_DIR /data is not writable (EACCES: permission denied)"),
      "/data",
      ids,
    );
    expect(message).toBe(
      "Cannot open the database: DATA_DIR /data is not writable (EACCES: permission denied); chown the data directory to the service user, uid 1000 (for example: chown -R 1000:1000 <host path of the data volume>). The bridge runs as uid 0, gid 0.",
    );
    expect(message).not.toContain("\n");
  });

  it("recognises SQLite's own words for a directory it cannot write", () => {
    const sqlite = codeError("SQLITE_CANTOPEN", "unable to open database file");
    expect(isPermissionError(sqlite)).toBe(true);
    expect(
      isPermissionError(codeError("SQLITE_READONLY", "attempt to write a readonly database")),
    ).toBe(true);
    expect(isPermissionError(codeError("EROFS", "read-only file system"))).toBe(true);
    expect(storeStartupMessage(sqlite, "/data", ids)).toContain("chown the data directory");
  });

  it("leaves the chown hint out of a failed migration", () => {
    const message = storeStartupMessage(
      new Error(
        "bridge.db has schema version 9, but this release knows only up to 4. Use a newer release.",
      ),
      "/data",
      { uid: 1000, gid: 1000 },
    );
    expect(message).toContain("Cannot open or migrate the database in DATA_DIR");
    expect(message).toContain("schema version 9");
    expect(message).not.toContain("chown");
    expect(message).toContain("uid 1000, gid 1000");
  });

  it("works where the platform has no uid", () => {
    expect(storeStartupMessage(new Error("boom"), "/data", { uid: null, gid: null })).not.toContain(
      "uid",
    );
  });
});

describe("Store.check", () => {
  let store: TempStore | null = null;
  afterEach(() => {
    store?.dispose();
    store = null;
  });

  it("passes on a working store and throws once the database is closed", () => {
    store = tempStore();
    expect(() => store?.check()).not.toThrow();
    store.close();
    expect(() => store?.check()).toThrow();
  });
});
