// Versioned schema migrations for bridge.db. The applied version lives in SQLite's
// user_version pragma. Each migration runs in its own transaction, so a failed one leaves
// the database at the previous version. Append new migrations; never edit an applied one.

import type { Database } from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const JOB_STATUSES = [
  "queued",
  "running",
  "done",
  "skipped",
  "failed",
  "session_expired",
  "cancelled",
] as const;

const statusList = JOB_STATUSES.map((status) => `'${status}'`).join(", ");

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "jobs, job events, sent recipes and settings",
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        mealie_recipe_id TEXT NOT NULL,
        mealie_slug TEXT,
        title TEXT,
        scale REAL NOT NULL DEFAULT 1,
        servings INTEGER,
        status TEXT NOT NULL CHECK (status IN (${statusList})),
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        mc_recipe_id INTEGER,
        mc_recipe_url TEXT,
        provider TEXT,
        model TEXT,
        usage_json TEXT,
        cost_usd REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        force INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX jobs_status_created ON jobs (status, created_at);
      CREATE INDEX jobs_recipe ON jobs (mealie_recipe_id, status);
      CREATE INDEX jobs_created ON jobs (created_at);

      CREATE TABLE job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
        message TEXT NOT NULL
      );
      CREATE INDEX job_events_job ON job_events (job_id, id);

      CREATE TABLE mc_recipes (
        mealie_recipe_id TEXT NOT NULL,
        scale REAL NOT NULL,
        source_hash TEXT NOT NULL,
        mc_recipe_id INTEGER NOT NULL,
        mc_recipe_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (mealie_recipe_id, scale, source_hash)
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "stored conversion and draft creation marker",
    sql: `
      ALTER TABLE jobs ADD COLUMN conversion_json TEXT;
      ALTER TABLE jobs ADD COLUMN create_started_at TEXT;
    `,
  },
];

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

export function schemaVersion(db: Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

// Brings the database to the newest version. Running it again is a no-op. A database
// written by a newer release is refused rather than guessed at.
export function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  const from = schemaVersion(db);
  const newest = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  if (from > newest) {
    throw new Error(
      `bridge.db has schema version ${from}, but this release knows only up to ${newest}. Use a newer release.`,
    );
  }
  const applied: number[] = [];
  const pending = [...migrations]
    .filter((migration) => migration.version > from)
    .sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      // PRAGMA takes no bound parameters; the version is an integer from the list above.
      db.pragma(`user_version = ${Math.trunc(migration.version)}`);
    }).immediate();
    applied.push(migration.version);
  }
  return { from, to: schemaVersion(db), applied };
}
