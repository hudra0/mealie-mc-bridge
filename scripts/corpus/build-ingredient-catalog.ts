// Builds knowledge/locales/<locale>/ingredient-catalog.json: every ingredient name that
// published recipes of that locale link to a systemIngredientId, with the id they use most
// and the others as alternatives.
//
// Input:  $CORPUS_DIR/derived/recipes.jsonl (names, ids and source per recipe), falling back
//         to $CORPUS_DIR/details/<id>.json when the normalizer has not run. Categories are
//         read from details/ by id when it exists (the normalizer does not keep them); every
//         recipe that uses an id gives it the same category. Without details/ they are null.
// Output: names, ids, counts and categories only. No recipe text, titles or author data.
//
// Names group by normalizeIngredientName (src/ingredients/catalog.ts), the same comparison
// the resolver uses at runtime. The entry name is the spelling used most within a group.
// Weights: an official recipe counts 3, a member recipe 1, for both the spelling and the
// primary id. Ingredients without an id (member free text carries -1) are left out, and so
// are names below CATALOG_MIN_RECIPES (see there).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  normalizeIngredientName,
  type IngredientCatalogFile,
} from "../../src/ingredients/catalog.js";
import type { NormalizedRecipe } from "./types.js";

// Where a catalog comes from, per locale.
export function catalogGeneratedFrom(locale: string): string {
  return `published Monsieur Cuisine recipes (MC Smart, ${locale})`;
}
export const CATALOG_GENERATED_FROM = catalogGeneratedFrom("de-DE");
export const OFFICIAL_WEIGHT = 3;
// A name enters the catalog when at least this many official recipes, or this many member
// recipes, use it. A name from a single member recipe is mostly free text ("Eigelb und 2 El
// Milch zum Bestreichen") that converter output never matches exactly.
export const CATALOG_MIN_RECIPES = { official: 1, member: 2 } as const;

export interface CatalogIngredient {
  name: string | null | undefined;
  systemIngredientId: number | null | undefined;
}

export interface CatalogRecipe {
  source: string | null | undefined;
  ingredients: readonly CatalogIngredient[];
}

export interface CatalogSource {
  recipes: CatalogRecipe[];
  // systemIngredientId to category name, from the detail files.
  categories: Map<number, string | null>;
  from: "recipes.jsonl" | "details";
}

interface Counts {
  official: number;
  member: number;
}

const weight = (c: Counts) => c.official * OFFICIAL_WEIGHT + c.member;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function bump<K>(map: Map<K, Counts>, key: K, official: boolean) {
  const counts = map.get(key) ?? { official: 0, member: 0 };
  if (official) counts.official++;
  else counts.member++;
  map.set(key, counts);
}

export function buildIngredientCatalog(
  recipes: readonly CatalogRecipe[],
  categories: ReadonlyMap<number, string | null> = new Map(),
  locale = "de-DE",
): IngredientCatalogFile {
  const groups = new Map<
    string,
    { spellings: Map<string, Counts>; ids: Map<number, Counts>; recipes: Counts }
  >();
  for (const recipe of recipes) {
    const official = recipe.source === "official";
    // A recipe counts once per name and id, even when it lists the ingredient twice.
    const seen = new Set<string>();
    for (const ingredient of recipe.ingredients) {
      const id = ingredient.systemIngredientId;
      const name = ingredient.name?.trim().replace(/\s+/g, " ").normalize("NFC");
      if (!name || typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
      const key = normalizeIngredientName(name);
      const group = groups.get(key) ?? {
        spellings: new Map<string, Counts>(),
        ids: new Map<number, Counts>(),
        recipes: { official: 0, member: 0 },
      };
      groups.set(key, group);
      const spellingKey = `s\u0000${name}`;
      const idKey = `i\u0000${key}\u0000${id}`;
      const recipeKey = `r\u0000${key}`;
      if (!seen.has(recipeKey)) {
        if (official) group.recipes.official++;
        else group.recipes.member++;
      }
      seen.add(recipeKey);
      if (!seen.has(spellingKey)) bump(group.spellings, name, official);
      if (!seen.has(idKey)) bump(group.ids, id, official);
      seen.add(spellingKey);
      seen.add(idKey);
    }
  }

  const entries: IngredientCatalogFile["entries"] = [];
  for (const group of groups.values()) {
    if (
      group.recipes.official < CATALOG_MIN_RECIPES.official &&
      group.recipes.member < CATALOG_MIN_RECIPES.member
    ) {
      continue;
    }
    const spellings = [...group.spellings].sort(
      ([a, ca], [b, cb]) => weight(cb) - weight(ca) || compareText(a, b),
    );
    const ids = [...group.ids].sort(
      ([a, ca], [b, cb]) => weight(cb) - weight(ca) || cb.official - ca.official || a - b,
    );
    const [primary, ...others] = ids;
    const [spelling] = spellings;
    if (!primary || !spelling) continue;
    const primaryId = primary[0];
    entries.push({
      name: spelling[0],
      systemIngredientId: primaryId,
      officialRecipes: primary[1].official,
      memberRecipes: primary[1].member,
      category: categories.get(primaryId) ?? null,
      alternatives: others.map(([id, counts]) => ({
        systemIngredientId: id,
        officialRecipes: counts.official,
        memberRecipes: counts.member,
      })),
    });
  }
  entries.sort((a, b) => b.officialRecipes - a.officialRecipes || compareText(a.name, b.name));
  return { generatedFrom: catalogGeneratedFrom(locale), entries };
}

interface DetailIngredient extends CatalogIngredient {
  ingredientCategory?: { name?: string | null } | null;
}

interface DetailRecipe {
  source?: string | null;
  servingSizes?: { ingredients?: DetailIngredient[] | null }[] | null;
}

function detailRecipe(json: unknown): DetailRecipe | null {
  const top = json as { recipe?: DetailRecipe; data?: { recipe?: DetailRecipe } } | null;
  return top?.data?.recipe ?? top?.recipe ?? null;
}

function readDetails(dir: string): {
  recipes: CatalogRecipe[];
  categories: Map<number, string | null>;
} {
  const recipes: CatalogRecipe[] = [];
  const categories = new Map<number, string | null>();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const recipe = detailRecipe(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    const ingredients = recipe?.servingSizes?.[0]?.ingredients ?? [];
    for (const ingredient of ingredients) {
      const id = ingredient.systemIngredientId;
      if (typeof id !== "number" || id <= 0) continue;
      const category = ingredient.ingredientCategory?.name ?? null;
      if (!categories.has(id) || (categories.get(id) === null && category !== null)) {
        categories.set(id, category);
      }
    }
    recipes.push({ source: recipe?.source ?? null, ingredients });
  }
  return { recipes, categories };
}

/** The catalog input, or null when neither recipes.jsonl nor details/ exists. */
export function readCatalogSource(corpusDir: string): CatalogSource | null {
  const jsonl = path.join(corpusDir, "derived", "recipes.jsonl");
  const detailsDir = path.join(corpusDir, "details");
  const hasDetails = existsSync(detailsDir);
  if (existsSync(jsonl)) {
    const recipes = readFileSync(jsonl, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Pick<NormalizedRecipe, "source" | "ingredients">)
      .map((r) => ({ source: r.source, ingredients: r.ingredients }));
    const categories = hasDetails
      ? readDetails(detailsDir).categories
      : new Map<number, string | null>();
    return { recipes, categories, from: "recipes.jsonl" };
  }
  if (hasDetails) return { ...readDetails(detailsDir), from: "details" };
  return null;
}
