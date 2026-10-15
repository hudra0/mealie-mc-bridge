import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { databasePath, openDatabase, type Db } from "./db.js";
import { IngredientCacheStore } from "./ingredient-cache.js";
import { JobStore } from "./jobs.js";
import { McRecipeStore } from "./mc-recipes.js";
import { SettingsStore } from "./settings.js";

export * from "./data-dir.js";
export * from "./db.js";
export * from "./ingredient-cache.js";
export * from "./jobs.js";
export * from "./mc-recipes.js";
export * from "./migrations.js";
export * from "./settings.js";

export interface Store {
  db: Db;
  jobs: JobStore;
  mcRecipes: McRecipeStore;
  settings: SettingsStore;
  ingredientCache: IngredientCacheStore;
  // Throws when the store cannot serve requests: the database is closed or unreadable, or
  // the process may no longer write the database file or its directory. /health answers
  // 503 then, so the container healthcheck fails.
  check(): void;
  close(): void;
}

export interface OpenStoreOptions {
  // A file path, or DATA_DIR to use DATA_DIR/bridge.db.
  path?: string;
  dataDir?: string;
  key?: Buffer | null;
  now?: () => Date;
}

export function openStore(options: OpenStoreOptions): Store {
  const path = options.path ?? databasePath(options.dataDir ?? "./data");
  const db = openDatabase(path);
  const now = options.now;
  const clock = now ? { now } : {};
  return {
    db,
    jobs: new JobStore(db, clock),
    mcRecipes: new McRecipeStore(db, clock),
    settings: new SettingsStore(db, { ...clock, key: options.key ?? null }),
    ingredientCache: new IngredientCacheStore(db, clock),
    check: () => {
      db.prepare("SELECT 1 FROM jobs LIMIT 1").get();
      accessSync(dirname(path), constants.W_OK);
      accessSync(path, constants.R_OK | constants.W_OK);
    },
    close: () => db.close(),
  };
}
