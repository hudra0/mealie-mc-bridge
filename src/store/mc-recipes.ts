// Drafts the bridge created, keyed by recipe, scale and source hash. This table, not the
// Mealie extras, decides whether a recipe was already sent: a stale save of the recipe page
// in Mealie can wipe the extras, but not this record.

import type { Db } from "./db.js";

export interface SentRecipe {
  mealieRecipeId: string;
  scale: number;
  sourceHash: string;
  mcRecipeId: number;
  mcRecipeUrl: string;
  createdAt: string;
}

interface Row {
  mealie_recipe_id: string;
  scale: number;
  source_hash: string;
  mc_recipe_id: number;
  mc_recipe_url: string;
  created_at: string;
}

export class McRecipeStore {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  find(recipeId: string, scale: number, sourceHash: string): SentRecipe | null {
    const row = this.#db
      .prepare<[string, number, string], Row>(
        "SELECT * FROM mc_recipes WHERE mealie_recipe_id = ? AND scale = ? AND source_hash = ?",
      )
      .get(recipeId, scale, sourceHash);
    return row ? toSent(row) : null;
  }

  // Remembers a new draft. A forced rebuild of the same content replaces the older record.
  record(entry: Omit<SentRecipe, "createdAt">): SentRecipe {
    const createdAt = this.#now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO mc_recipes (mealie_recipe_id, scale, source_hash, mc_recipe_id, mc_recipe_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (mealie_recipe_id, scale, source_hash)
         DO UPDATE SET mc_recipe_id = excluded.mc_recipe_id,
                       mc_recipe_url = excluded.mc_recipe_url,
                       created_at = excluded.created_at`,
      )
      .run(
        entry.mealieRecipeId,
        entry.scale,
        entry.sourceHash,
        entry.mcRecipeId,
        entry.mcRecipeUrl,
        createdAt,
      );
    return { ...entry, createdAt };
  }

  listForRecipe(recipeId: string): SentRecipe[] {
    return this.#db
      .prepare<[string], Row>(
        "SELECT * FROM mc_recipes WHERE mealie_recipe_id = ? ORDER BY created_at DESC",
      )
      .all(recipeId)
      .map(toSent);
  }
}

function toSent(row: Row): SentRecipe {
  return {
    mealieRecipeId: row.mealie_recipe_id,
    scale: row.scale,
    sourceHash: row.source_hash,
    mcRecipeId: row.mc_recipe_id,
    mcRecipeUrl: row.mc_recipe_url,
    createdAt: row.created_at,
  };
}
