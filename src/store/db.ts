// Opens bridge.db: one SQLite file under DATA_DIR in WAL mode, migrated to the newest
// schema. better-sqlite3 is synchronous, which suits a single-process service with one
// worker: a transaction cannot interleave with another request.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database, { type Database as Db } from "better-sqlite3";
import { migrate } from "./migrations.js";

export type { Db };

export const DATABASE_FILE = "bridge.db";

export function databasePath(dataDir: string): string {
  return resolve(join(dataDir, DATABASE_FILE));
}

// Opens (and creates) the database at path and applies pending migrations.
export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
