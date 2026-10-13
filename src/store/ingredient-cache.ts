// Ingredient ids the resolver found by searching Monsieur Cuisine, and names it did not
// find, keyed by the normalized name. A found id is kept for good; a miss is kept so the
// same unknown name does not trigger a search on every job, and the resolver decides when
// a miss is old enough to search again.

import type { Db } from "./db.js";

export type IngredientCacheSource = "catalog" | "search" | "none";

export interface CachedIngredient {
  nameNorm: string;
  // Null for a miss (source "none").
  systemIngredientId: number | null;
  source: IngredientCacheSource;
  resolvedAt: string;
}

interface Row {
  name_norm: string;
  system_ingredient_id: number | null;
  source: IngredientCacheSource;
  resolved_at: string;
}

export class IngredientCacheStore {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  get(nameNorm: string): CachedIngredient | null {
    const row = this.#db
      .prepare<[string], Row>("SELECT * FROM ingredient_cache WHERE name_norm = ?")
      .get(nameNorm);
    return row ? toCached(row) : null;
  }

  // Stores or replaces the result for a name.
  put(
    nameNorm: string,
    systemIngredientId: number | null,
    source: IngredientCacheSource,
  ): CachedIngredient {
    const resolvedAt = this.#now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO ingredient_cache (name_norm, system_ingredient_id, source, resolved_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (name_norm) DO UPDATE SET system_ingredient_id = excluded.system_ingredient_id,
           source = excluded.source, resolved_at = excluded.resolved_at`,
      )
      .run(nameNorm, systemIngredientId, source, resolvedAt);
    return { nameNorm, systemIngredientId, source, resolvedAt };
  }

  count(): number {
    return (
      this.#db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM ingredient_cache")
        .get()?.count ?? 0
    );
  }
}

function toCached(row: Row): CachedIngredient {
  return {
    nameNorm: row.name_norm,
    systemIngredientId: row.system_ingredient_id,
    source: row.source,
    resolvedAt: row.resolved_at,
  };
}
