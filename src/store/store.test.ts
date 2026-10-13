import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { steppingClock, tempDir, tempStore, type TempStore } from "../testing/temp.js";
import { databasePath, openDatabase } from "./db.js";
import { JobConflictError } from "./jobs.js";
import { MIGRATIONS, migrate, schemaVersion } from "./migrations.js";
import {
  SettingsKeyError,
  SettingsStore,
  decryptSecret,
  encryptSecret,
  generateSettingsKey,
  parseSettingsKey,
} from "./settings.js";

const RECIPE = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

let store: TempStore;
afterEach(() => store?.dispose());

describe("openDatabase and migrations", () => {
  it("creates the file in WAL mode at the newest schema version", () => {
    store = tempStore();
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.at(-1)?.version);
    const tables = store.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["jobs", "job_events", "mc_recipes", "settings"]),
    );
  });

  it("is idempotent: running the migrations again changes nothing", () => {
    store = tempStore();
    store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    expect(migrate(store.db)).toEqual({ from: 1, to: 1, applied: [] });
    store.close();
    const reopened = openDatabase(store.path);
    expect(schemaVersion(reopened)).toBe(1);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
    reopened.close();
  });

  it("applies pending migrations in order inside transactions", () => {
    const { dir, cleanup } = tempDir();
    const db = new Database(`${dir}/m.db`);
    const result = migrate(db, [
      { version: 2, name: "second", sql: "ALTER TABLE t ADD COLUMN b TEXT;" },
      { version: 1, name: "first", sql: "CREATE TABLE t (a TEXT);" },
    ]);
    expect(result).toEqual({ from: 0, to: 2, applied: [1, 2] });
    db.close();
    cleanup();
  });

  it("leaves the version unchanged when a migration fails", () => {
    const { dir, cleanup } = tempDir();
    const db = new Database(`${dir}/m.db`);
    expect(() =>
      migrate(db, [
        { version: 1, name: "ok", sql: "CREATE TABLE t (a TEXT);" },
        { version: 2, name: "broken", sql: "CREATE TABLE u (a TEXT); THIS IS NOT SQL;" },
      ]),
    ).toThrow();
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'u'").get()).toBeUndefined();
    db.close();
    cleanup();
  });

  it("refuses a database from a newer release", () => {
    const { dir, cleanup } = tempDir();
    const db = new Database(`${dir}/m.db`);
    db.pragma("user_version = 99");
    expect(() => migrate(db)).toThrow(/schema version 99/);
    db.close();
    expect(() => openDatabase(`${dir}/m.db`)).toThrow(/schema version 99/);
    cleanup();
  });

  it("puts bridge.db into the data directory", () => {
    expect(databasePath("/data").replace(/\\/g, "/")).toMatch(/\/data\/bridge\.db$/);
  });

  it("rejects a status outside the state machine", () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    expect(() =>
      store.db.prepare("UPDATE jobs SET status = 'exploded' WHERE id = ?").run(job.id),
    ).toThrow(/CHECK constraint/);
  });
});

describe("JobStore", () => {
  it("enqueues a job with defaults and an event", () => {
    store = tempStore({ now: steppingClock().now });
    const { job, created } = store.jobs.enqueue({
      recipeId: RECIPE,
      scale: 1.5,
      slug: "soup",
      title: "Soup",
    });
    expect(created).toBe(true);
    expect(job).toMatchObject({
      mealieRecipeId: RECIPE,
      mealieSlug: "soup",
      title: "Soup",
      scale: 1.5,
      status: "queued",
      attempts: 0,
      force: false,
      error: null,
      usage: null,
    });
    expect(store.jobs.events(job.id).map((event) => event.message)).toEqual([
      "Queued with scale 1.5",
    ]);
  });

  it("returns the active job instead of adding a second one for the same recipe", () => {
    store = tempStore();
    const first = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    const again = store.jobs.enqueue({ recipeId: RECIPE, scale: 2 });
    expect(again).toEqual({ job: first.job, created: false });

    store.jobs.claimNext();
    expect(store.jobs.enqueue({ recipeId: RECIPE, scale: 1 }).created).toBe(false);

    store.jobs.update(first.job.id, { status: "session_expired" });
    expect(store.jobs.enqueue({ recipeId: RECIPE, scale: 1 }).created).toBe(false);

    store.jobs.finish(first.job.id, "done");
    expect(store.jobs.enqueue({ recipeId: RECIPE, scale: 1 }).created).toBe(true);
    expect(store.jobs.enqueue({ recipeId: OTHER, scale: 1 }).created).toBe(true);
  });

  it("claims the oldest queued job and marks it running", () => {
    store = tempStore({ now: steppingClock().now });
    const a = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 }).job;
    const b = store.jobs.enqueue({ recipeId: OTHER, scale: 1 }).job;
    const claimed = store.jobs.claimNext();
    expect(claimed).toMatchObject({ id: a.id, status: "running", attempts: 1 });
    expect(claimed?.startedAt).not.toBeNull();
    expect(store.jobs.claimNext()?.id).toBe(b.id);
    expect(store.jobs.claimNext()).toBeNull();
  });

  it("updates fields, stores usage as JSON and stamps finished jobs", () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    const updated = store.jobs.update(job.id, {
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
      costUsd: 0.12,
      provider: "openai",
      model: "gpt-test",
      mcRecipeId: 42,
      mcRecipeUrl: "https://mc.example.com/42",
      servings: 4,
      title: "Soup",
      mealieSlug: "soup",
      force: true,
    });
    expect(updated).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
      costUsd: 0.12,
      mcRecipeId: 42,
      servings: 4,
      force: true,
    });
    expect(updated.finishedAt).toBeNull();
    const done = store.jobs.finish(job.id, "done", { error: null });
    expect(done.status).toBe("done");
    expect(done.finishedAt).not.toBeNull();
    const waiting = store.jobs.finish(job.id, "session_expired");
    expect(waiting.finishedAt).toBeNull();
    expect(() => store.jobs.update("missing", { title: "x" })).toThrow(/does not exist/);
  });

  it("keeps events in order and truncates very long messages", () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    store.jobs.appendEvent(job.id, "warn", "careful");
    store.jobs.appendEvent(job.id, "error", "x".repeat(5000));
    const events = store.jobs.events(job.id);
    expect(events.map((event) => event.level)).toEqual(["info", "warn", "error"]);
    expect(events[2]?.message).toHaveLength(2003);
    expect(store.jobs.getWithEvents(job.id)?.events).toHaveLength(3);
    expect(store.jobs.getWithEvents("missing")).toBeNull();
  });

  it("lists recent jobs with status and search filters", () => {
    store = tempStore({ now: steppingClock().now });
    const a = store.jobs.enqueue({ recipeId: RECIPE, scale: 1, title: "Tomato soup 50%" }).job;
    const b = store.jobs.enqueue({ recipeId: OTHER, scale: 1, slug: "bread", title: "Bread" }).job;
    store.jobs.finish(a.id, "failed", { error: "boom" });

    expect(store.jobs.listRecent().map((job) => job.id)).toEqual([b.id, a.id]);
    expect(store.jobs.listRecent({ status: "failed" }).map((job) => job.id)).toEqual([a.id]);
    expect(store.jobs.listRecent({ search: "bread" }).map((job) => job.id)).toEqual([b.id]);
    expect(store.jobs.listRecent({ search: OTHER }).map((job) => job.id)).toEqual([b.id]);
    expect(store.jobs.listRecent({ search: "soup" }).map((job) => job.id)).toEqual([a.id]);
    // LIKE wildcards in the search are literal.
    expect(store.jobs.listRecent({ search: "50%" }).map((job) => job.id)).toEqual([a.id]);
    expect(store.jobs.listRecent({ search: "%" }).map((job) => job.id)).toEqual([a.id]);
    expect(store.jobs.listRecent({ limit: 1, offset: 1 }).map((job) => job.id)).toEqual([a.id]);
  });

  it("counts jobs per status", () => {
    store = tempStore();
    store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    const other = store.jobs.enqueue({ recipeId: OTHER, scale: 1 }).job;
    store.jobs.finish(other.id, "done");
    expect(store.jobs.stats()).toEqual({
      queued: 1,
      running: 0,
      done: 1,
      skipped: 0,
      failed: 0,
      session_expired: 0,
      cancelled: 0,
    });
  });

  it("requeues a finished job, optionally forced, and refuses conflicts", () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    store.jobs.claimNext();
    expect(() => store.jobs.requeue(job.id)).toThrow(JobConflictError);
    store.jobs.finish(job.id, "failed", { error: "boom" });

    const again = store.jobs.requeue(job.id, { force: true });
    expect(again).toMatchObject({ status: "queued", error: null, force: true, finishedAt: null });
    // A queued job stays as it is unless force is given.
    expect(store.jobs.requeue(job.id).force).toBe(true);
    expect(store.jobs.requeue(job.id, { force: false }).force).toBe(false);

    store.jobs.finish(job.id, "done");
    store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    expect(() => store.jobs.requeue(job.id)).toThrow(/for the same recipe is queued/);
    expect(() => store.jobs.requeue("missing")).toThrow(/does not exist/);
  });

  it("cancels only jobs that have not started", () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    expect(store.jobs.cancel(job.id)).toMatchObject({ status: "cancelled" });
    expect(() => store.jobs.cancel(job.id)).toThrow(/cancelled job cannot be cancelled/);
    const running = store.jobs.enqueue({ recipeId: OTHER, scale: 1 }).job;
    store.jobs.claimNext();
    expect(() => store.jobs.cancel(running.id)).toThrow(/running job cannot be cancelled/);
    expect(() => store.jobs.cancel("missing")).toThrow(/does not exist/);
  });

  it("pauses queued jobs and resumes them", () => {
    store = tempStore();
    const a = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 }).job;
    const b = store.jobs.enqueue({ recipeId: OTHER, scale: 1 }).job;
    store.jobs.finish(b.id, "done");
    expect(store.jobs.pauseQueued()).toBe(1);
    expect(store.jobs.get(a.id)?.status).toBe("session_expired");
    expect(store.jobs.get(b.id)?.status).toBe("done");
    expect(store.jobs.resumePaused()).toBe(1);
    expect(store.jobs.get(a.id)?.status).toBe("queued");
    expect(store.jobs.events(a.id).map((event) => event.message)).toContain(
      "Session renewed, queued again",
    );
  });

  it("puts jobs left running by a crash back into the queue", () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    store.jobs.claimNext();
    expect(store.jobs.recoverInterrupted()).toBe(1);
    expect(store.jobs.get(job.id)?.status).toBe("queued");
  });

  it("deletes events with their job", () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE, scale: 1 });
    store.db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
    expect(store.jobs.events(job.id)).toEqual([]);
  });
});

describe("McRecipeStore", () => {
  it("finds a sent recipe by recipe, scale and hash", () => {
    store = tempStore();
    const entry = {
      mealieRecipeId: RECIPE,
      scale: 1,
      sourceHash: "abc",
      mcRecipeId: 7,
      mcRecipeUrl: "https://mc.example.com/7",
    };
    const recorded = store.mcRecipes.record(entry);
    expect(store.mcRecipes.find(RECIPE, 1, "abc")).toEqual(recorded);
    expect(store.mcRecipes.find(RECIPE, 2, "abc")).toBeNull();
    expect(store.mcRecipes.find(RECIPE, 1, "other")).toBeNull();
  });

  it("replaces the record when the same content is sent again", () => {
    store = tempStore();
    const base = { mealieRecipeId: RECIPE, scale: 1, sourceHash: "abc" };
    store.mcRecipes.record({ ...base, mcRecipeId: 7, mcRecipeUrl: "https://mc.example.com/7" });
    store.mcRecipes.record({ ...base, mcRecipeId: 8, mcRecipeUrl: "https://mc.example.com/8" });
    expect(store.mcRecipes.find(RECIPE, 1, "abc")?.mcRecipeId).toBe(8);
    expect(store.mcRecipes.listForRecipe(RECIPE)).toHaveLength(1);
  });
});

describe("SettingsStore", () => {
  it("stores plain values and JSON", () => {
    store = tempStore();
    expect(store.settings.get("a")).toBeNull();
    expect(store.settings.updatedAt("a")).toBeNull();
    store.settings.set("a", "1");
    store.settings.set("a", "2");
    expect(store.settings.get("a")).toBe("2");
    expect(store.settings.updatedAt("a")).not.toBeNull();
    store.settings.setJson("j", { list: [1, 2] });
    expect(store.settings.getJson("j")).toEqual({ list: [1, 2] });
    store.settings.set("broken", "{");
    expect(store.settings.getJson("broken")).toBeNull();
    expect(store.settings.getJson("none")).toBeNull();
    store.settings.delete("a");
    expect(store.settings.get("a")).toBeNull();
  });

  it("encrypts secrets: the database never holds the plain value", () => {
    store = tempStore();
    store.settings.setSecret("mc.cookie", "wordpress_logged_in_x=secret-value");
    expect(store.settings.get("mc.cookie")).not.toContain("secret-value");
    expect(store.settings.get("mc.cookie")).toMatch(/^v1:/);
    expect(store.settings.getSecret("mc.cookie")).toBe("wordpress_logged_in_x=secret-value");
    expect(store.settings.getSecret("missing")).toBeNull();
  });

  it("fails to decrypt with a different key", () => {
    store = tempStore();
    store.settings.setSecret("mc.cookie", "secret-value");
    const other = new SettingsStore(store.db, { key: Buffer.alloc(32, 9) });
    expect(() => other.getSecret("mc.cookie")).toThrow(SettingsKeyError);
    expect(() => other.getSecret("mc.cookie")).toThrow(/SETTINGS_KEY differs/);
  });

  it("binds the ciphertext to the setting name", () => {
    const key = Buffer.alloc(32, 3);
    const stored = encryptSecret(key, "a", "value");
    expect(decryptSecret(key, "a", stored)).toBe("value");
    expect(() => decryptSecret(key, "b", stored)).toThrow(SettingsKeyError);
    expect(() => decryptSecret(key, "a", "plain")).toThrow(/not an encrypted value/);
  });

  it("refuses secrets without a key", () => {
    store = tempStore({ key: null });
    expect(() => store.settings.setSecret("x", "y")).toThrow(/SETTINGS_KEY is not set/);
    store.settings.set("x", "v1:a:b:c");
    expect(() => store.settings.getSecret("x")).toThrow(/SETTINGS_KEY is not set/);
  });

  it("generates and parses settings keys", () => {
    const key = generateSettingsKey();
    expect(parseSettingsKey(key)).toHaveLength(32);
    expect(generateSettingsKey()).not.toBe(key);
    expect(() => parseSettingsKey(Buffer.alloc(16).toString("base64"))).toThrow(SettingsKeyError);
    expect(() => parseSettingsKey("%%%")).toThrow(SettingsKeyError);
  });
});
