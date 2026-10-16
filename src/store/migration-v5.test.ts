import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/temp.js";
import { MIGRATIONS, PURGED_LOGIN_DETAIL, migrate } from "./migrations.js";

const MARKER = "MARKER-PASSWORD-63";
// The migrations up to this one, so the test stays valid when newer ones follow.
const V5 = MIGRATIONS.filter((migration) => migration.version <= 5);
const TS = "2026-10-15T08:00:00.000Z";

function v4Database(dir: string) {
  const db = new Database(`${dir}/v4.db`);
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version <= 4),
  );
  return db;
}

const setting = (db: Database.Database, key: string) =>
  db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?").get(key)
    ?.value ?? null;

describe("migration v5", () => {
  it("replaces the stored reason of the last automatic login", () => {
    const { dir, cleanup } = tempDir();
    const db = v4Database(dir);
    try {
      const attempt = {
        at: TS,
        ok: false,
        manual: true,
        code: "error",
        detail: `locator.fill: Timeout 5000ms exceeded. Call log: - fill("${MARKER}")`,
        screenshot: "2026-10-15T08-00-00-000Z.png",
      };
      const insert = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
      insert.run("autologin.last_attempt", JSON.stringify(attempt), TS);
      insert.run("autologin.failures", "2", TS);
      expect(migrate(db, V5)).toEqual({ from: 4, to: 5, applied: [5] });
      const stored = setting(db, "autologin.last_attempt") ?? "";
      expect(stored).not.toContain(MARKER);
      expect(JSON.parse(stored)).toEqual({ ...attempt, detail: PURGED_LOGIN_DETAIL });
      expect(setting(db, "autologin.failures")).toBe("2");
      expect(migrate(db, V5)).toEqual({ from: 5, to: 5, applied: [] });
    } finally {
      db.close();
      cleanup();
    }
  });

  it("leaves a successful attempt alone and drops an unreadable one", () => {
    const { dir, cleanup } = tempDir();
    const db = v4Database(dir);
    try {
      const ok = { at: TS, ok: true, manual: false, code: null, detail: null, screenshot: null };
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
        "autologin.last_attempt",
        JSON.stringify(ok),
        TS,
      );
      migrate(db, V5);
      expect(JSON.parse(setting(db, "autologin.last_attempt") ?? "")).toEqual(ok);

      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
        `not json ${MARKER}`,
        "autologin.last_attempt",
      );
      db.pragma("user_version = 4");
      migrate(db, V5);
      expect(setting(db, "autologin.last_attempt")).toBeNull();
    } finally {
      db.close();
      cleanup();
    }
  });
});
