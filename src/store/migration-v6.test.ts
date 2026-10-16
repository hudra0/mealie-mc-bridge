import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/temp.js";
import { JobStore } from "./jobs.js";
import { MIGRATIONS, migrate } from "./migrations.js";

const TS = "2026-10-15T08:00:00.000Z";

describe("migration v6", () => {
  it("adds event codes and keeps older events as their message", () => {
    const { dir, cleanup } = tempDir();
    const db = new Database(`${dir}/v5.db`);
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 5),
      );
      db.prepare(
        `INSERT INTO jobs (id, mealie_recipe_id, scale, status, attempts, created_at, updated_at)
         VALUES ('j1', 'r1', 1, 'done', 1, ?, ?)`,
      ).run(TS, TS);
      db.prepare(
        "INSERT INTO job_events (job_id, ts, level, message) VALUES ('j1', ?, 'info', 'Konvertierung gestartet')",
      ).run(TS);

      expect(migrate(db)).toEqual({ from: 5, to: 6, applied: [6] });
      const columns = db
        .prepare<[], { name: string }>("PRAGMA table_info(job_events)")
        .all()
        .map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["code", "params_json"]));

      const jobs = new JobStore(db, { now: () => new Date(TS) });
      jobs.appendEvent("j1", "info", { code: "done" });
      expect(jobs.events("j1")).toEqual([
        expect.objectContaining({ message: "Konvertierung gestartet", code: null, params: null }),
        expect.objectContaining({ message: "Done", code: "done", params: {} }),
      ]);
      expect(migrate(db)).toEqual({ from: 6, to: 6, applied: [] });
    } finally {
      db.close();
      cleanup();
    }
  });
});
