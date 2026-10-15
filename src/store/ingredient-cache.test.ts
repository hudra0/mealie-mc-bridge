import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { steppingClock, tempDir, tempStore, type TempStore } from "../testing/temp.js";
import { openDatabase } from "./db.js";
import { MIGRATIONS, migrate, schemaVersion } from "./migrations.js";

const RECIPE = "00000000-0000-4000-8000-000000000001";

let store: TempStore | null = null;
afterEach(() => {
  store?.dispose();
  store = null;
});

describe("migration v3", () => {
  it("adds the cache table and the stats column to a version 2 database", () => {
    const { dir, cleanup } = tempDir();
    const db = new Database(`${dir}/v2.db`);
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 2),
    );
    db.prepare(
      `INSERT INTO jobs (id, mealie_recipe_id, status, created_at, updated_at)
       VALUES ('job-1', ?, 'done', '2026-10-13T10:00:00.000Z', '2026-10-13T10:00:00.000Z')`,
    ).run(RECIPE);
    const upToV3 = MIGRATIONS.filter((migration) => migration.version <= 3);
    expect(migrate(db, upToV3)).toEqual({ from: 2, to: 3, applied: [3] });
    expect(migrate(db, upToV3)).toEqual({ from: 3, to: 3, applied: [] });
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info(jobs)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("ingredients_json");
    expect(db.prepare("SELECT ingredients_json FROM jobs").get()).toEqual({
      ingredients_json: null,
    });
    const cacheColumns = db
      .prepare<[], { name: string }>("PRAGMA table_info(ingredient_cache)")
      .all()
      .map((column) => column.name);
    expect(cacheColumns).toEqual(["name_norm", "system_ingredient_id", "source", "resolved_at"]);
    db.close();
    cleanup();
  });

  it("keeps the cache across a reopen", () => {
    store = tempStore();
    store.ingredientCache.put("testzutat a", 9001, "search");
    store.close();
    const reopened = openDatabase(store.path);
    expect(schemaVersion(reopened)).toBeGreaterThanOrEqual(3);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM ingredient_cache").get()).toEqual({ n: 1 });
    reopened.close();
  });

  it("refuses an unknown source", () => {
    store = tempStore();
    expect(() => store?.ingredientCache.put("x", null, "guess" as never)).toThrow(/CHECK/);
  });
});

describe("IngredientCacheStore", () => {
  it("stores, reads and replaces results", () => {
    const clock = steppingClock();
    store = tempStore({ now: clock.now });
    const cache = store.ingredientCache;
    expect(cache.get("testzutat a")).toBeNull();
    expect(cache.count()).toBe(0);

    const miss = cache.put("testzutat a", null, "none");
    expect(miss).toEqual({
      nameNorm: "testzutat a",
      systemIngredientId: null,
      source: "none",
      resolvedAt: "2026-10-13T10:00:00.000Z",
    });
    expect(cache.get("testzutat a")).toEqual(miss);

    cache.put("testzutat a", 9001, "search");
    expect(cache.get("testzutat a")).toMatchObject({ systemIngredientId: 9001, source: "search" });
    expect(cache.count()).toBe(1);
  });
});

describe("job ingredient stats", () => {
  it("round-trips through the jobs table", () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    expect(job.ingredients).toBeNull();
    const stats = {
      catalog: 3,
      cache: 1,
      search: 1,
      unresolved: 1,
      unresolvedNames: ["Testzutat Z"],
      enabled: true,
    };
    expect(store.jobs.update(job.id, { ingredients: stats }).ingredients).toEqual(stats);
    expect(store.jobs.update(job.id, { ingredients: null }).ingredients).toBeNull();
  });
});
