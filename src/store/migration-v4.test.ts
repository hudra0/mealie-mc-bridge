import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/temp.js";
import { JobStore } from "./jobs.js";
import { MIGRATIONS, migrate, schemaVersion } from "./migrations.js";

const RECIPE = "00000000-0000-4000-8000-000000000001";

describe("migration v4", () => {
  it("adds the serving unit to the jobs of a version 3 database", () => {
    const { dir, cleanup } = tempDir();
    const db = new Database(`${dir}/v3.db`);
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 3),
      );
      db.prepare(
        `INSERT INTO jobs (id, mealie_recipe_id, status, servings, created_at, updated_at)
         VALUES ('job-1', ?, 'done', 4, '2026-10-13T10:00:00.000Z', '2026-10-13T10:00:00.000Z')`,
      ).run(RECIPE);
      const upToV4 = MIGRATIONS.filter((migration) => migration.version <= 4);
      expect(migrate(db, upToV4)).toEqual({ from: 3, to: 4, applied: [4] });
      expect(schemaVersion(db)).toBe(4);
      const columns = db
        .prepare<[], { name: string }>("PRAGMA table_info(jobs)")
        .all()
        .map((column) => column.name);
      expect(columns).toContain("serving_unit");
      // An old job reads with an unknown unit and takes one on the next update.
      const jobs = new JobStore(db);
      expect(jobs.get("job-1")).toMatchObject({ servings: 4, servingUnit: null });
      jobs.update("job-1", { servingUnit: "Scheiben" });
      expect(jobs.get("job-1")?.servingUnit).toBe("Scheiben");
      expect(migrate(db, upToV4)).toEqual({ from: 4, to: 4, applied: [] });
    } finally {
      db.close();
      cleanup();
    }
  });
});
