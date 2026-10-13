// The fingerprint of what the bridge sends: the recipe content that shapes the converted
// recipe (everything renderRecipeForLlm puts into the converter input), plus the scale and
// the output locale, whose pack writes the input labels and sets the recipe language.
// Tags, categories, images, ratings and timestamps are left out, so organizing a recipe in
// Mealie does not count as a change.

import { createHash } from "node:crypto";
import type { NormalizedIngredient } from "../ingredients/index.js";
import { NUTRITION_KEYS, type MealieRecipe } from "../mealie/index.js";

// Bump when the fingerprint's inputs change, so every recipe counts as changed once.
export const SOURCE_HASH_VERSION = 2;

// Hashes written before the locale joined the fingerprint were all de-DE. That locale stays
// out of the hash content, so recipes already sent in de-DE still count as unchanged.
const LEGACY_LOCALE = "de-DE";

export function sourceHash(
  recipe: MealieRecipe,
  ingredients: readonly NormalizedIngredient[],
  scale: number,
  locale: string = LEGACY_LOCALE,
): string {
  // Built field by field, so key order and extra fields from a newer Mealie cannot change it.
  const nutrition = recipe.nutrition;
  const content = {
    v: SOURCE_HASH_VERSION,
    name: recipe.name,
    description: recipe.description,
    times: [recipe.prepTime, recipe.cookTime, recipe.performTime, recipe.totalTime],
    nutrition: nutrition ? NUTRITION_KEYS.map((key) => nutrition[key] ?? null) : null,
    ingredients: ingredients.map((item) => [
      item.section,
      item.quantity,
      item.quantityMax,
      item.unit,
      item.food,
      item.note,
      item.optional,
      item.original,
    ]),
    instructions: recipe.recipeInstructions.map((step) => [step.title, step.summary, step.text]),
    notes: recipe.notes.map((note) => [note.title, note.text]),
    servings: [recipe.recipeServings, recipe.recipeYieldQuantity, recipe.recipeYield],
    scale,
    ...(locale === LEGACY_LOCALE ? {} : { locale }),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
