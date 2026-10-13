// The ingredient catalog: ingredient names as published Monsieur Cuisine recipes spell them,
// each with the systemIngredientId the app uses for its shopping list and ingredient
// filters. Built by scripts/corpus/build-ingredient-catalog.ts into
// knowledge/ingredient-catalog.json.
//
// A name matches only when it is the same after normalization: no fuzzy matching, no
// stemming, no partial hits. A wrong id is worse than none, because the app would file the
// ingredient under a different product.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { DEFAULT_KNOWLEDGE_DIR } from "../convert/settings.js";

export const INGREDIENT_CATALOG_FILE = "ingredient-catalog.json";

const id = z.number().int().positive();
const count = z.number().int().nonnegative();

export const ingredientCatalogSchema = z.object({
  generatedFrom: z.string(),
  entries: z.array(
    z.object({
      name: z.string().min(1),
      systemIngredientId: id,
      officialRecipes: count,
      memberRecipes: count,
      category: z.string().nullable(),
      alternatives: z.array(
        z.object({ systemIngredientId: id, officialRecipes: count, memberRecipes: count }),
      ),
    }),
  ),
});

export type IngredientCatalogFile = z.infer<typeof ingredientCatalogSchema>;
export type IngredientCatalogEntry = IngredientCatalogFile["entries"][number];

export interface IngredientCatalog {
  generatedFrom: string;
  entries: readonly IngredientCatalogEntry[];
  // Normalized name to the primary id.
  byName: ReadonlyMap<string, number>;
}

export class IngredientCatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IngredientCatalogError";
  }
}

// The form two names are compared in: Unicode NFC, trimmed, runs of whitespace collapsed to
// one space, lower case. Punctuation stays, so "Mehl (Type 405)" and "Mehl Type 405" differ.
export function normalizeIngredientName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

// Indexes a parsed catalog file. When two entries normalize to the same name, the first
// one wins; the builder never writes such a pair.
export function createIngredientCatalog(file: IngredientCatalogFile): IngredientCatalog {
  const byName = new Map<string, number>();
  for (const entry of file.entries) {
    const key = normalizeIngredientName(entry.name);
    if (!byName.has(key)) byName.set(key, entry.systemIngredientId);
  }
  return { generatedFrom: file.generatedFrom, entries: file.entries, byName };
}

export function parseIngredientCatalog(
  json: unknown,
  source = "ingredient catalog",
): IngredientCatalog {
  const result = ingredientCatalogSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "root"}: ${issue.message}` : "invalid";
    throw new IngredientCatalogError(`${source} is not a valid ingredient catalog (${where})`);
  }
  return createIngredientCatalog(result.data);
}

// Reads <dir>/ingredient-catalog.json. A relative dir resolves against the working directory.
export async function loadIngredientCatalog(
  dir: string = DEFAULT_KNOWLEDGE_DIR,
): Promise<IngredientCatalog> {
  const file = resolve(join(dir, INGREDIENT_CATALOG_FILE));
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new IngredientCatalogError(`Cannot read the ingredient catalog ${file}`, {
      cause: error,
    });
  }
  return parseIngredientCatalog(json, file);
}

// The primary id of the entry whose name equals `name` after normalization, or null.
export function lookupCatalog(catalog: IngredientCatalog, name: string): number | null {
  return catalog.byName.get(normalizeIngredientName(name)) ?? null;
}

// The catalog the service runs with: none when resolution is off, otherwise the file in
// KNOWLEDGE_DIR, the directory the converter reads its knowledge base from.
export async function loadConfiguredCatalog(
  config: Pick<Config, "MC_RESOLVE_INGREDIENTS" | "KNOWLEDGE_DIR">,
): Promise<IngredientCatalog | null> {
  if (config.MC_RESOLVE_INGREDIENTS === "off") return null;
  return loadIngredientCatalog(config.KNOWLEDGE_DIR);
}
