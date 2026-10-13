import { databasePath, openDatabase, type Db } from "./db.js";
import { JobStore } from "./jobs.js";
import { McRecipeStore } from "./mc-recipes.js";
import { SettingsStore } from "./settings.js";

export * from "./db.js";
export * from "./jobs.js";
export * from "./mc-recipes.js";
export * from "./migrations.js";
export * from "./settings.js";

export interface Store {
  db: Db;
  jobs: JobStore;
  mcRecipes: McRecipeStore;
  settings: SettingsStore;
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
    close: () => db.close(),
  };
}
