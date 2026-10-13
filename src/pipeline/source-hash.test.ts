import { describe, expect, it } from "vitest";
import { normalizeIngredients } from "../ingredients/index.js";
import { NUTRITION_KEYS, type MealieRecipe, type NutritionKey } from "../mealie/index.js";
import { mealieRecipe } from "../testing/fakes.js";
import { sourceHash } from "./source-hash.js";

const hashOf = (recipe: MealieRecipe, scale = 1) =>
  sourceHash(recipe, normalizeIngredients(recipe), scale);

describe("sourceHash", () => {
  const base = mealieRecipe();

  it("is a stable sha256 for the same content", () => {
    expect(hashOf(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(base)).toBe(hashOf(mealieRecipe()));
  });

  it("changes with the name, the steps, the notes, the servings, the ingredients and the scale", () => {
    const original = hashOf(base);
    const step = base.recipeInstructions[0];
    expect(hashOf({ ...base, name: "Andere Suppe" })).not.toBe(original);
    expect(
      hashOf({
        ...base,
        recipeInstructions: [
          { ...step!, text: `${step!.text} Länger kochen.` },
          ...base.recipeInstructions.slice(1),
        ],
      }),
    ).not.toBe(original);
    expect(
      hashOf({ ...base, notes: [{ title: "Tipp", text: "Mit Brot", referenceId: null }] }),
    ).not.toBe(original);
    expect(hashOf({ ...base, recipeServings: 6 })).not.toBe(original);
    expect(hashOf({ ...base, recipeIngredient: base.recipeIngredient.slice(1) })).not.toBe(
      original,
    );
    expect(hashOf(base, 2)).not.toBe(original);
  });

  it("changes with the description, the times and the nutrition the converter sees", () => {
    const original = hashOf(base);
    expect(hashOf({ ...base, description: "Neu beschrieben" })).not.toBe(original);
    expect(hashOf({ ...base, totalTime: "2 Stunden" })).not.toBe(original);
    expect(hashOf({ ...base, prepTime: "5 Minuten" })).not.toBe(original);
    expect(hashOf({ ...base, cookTime: "40 Minuten" })).not.toBe(original);
    expect(hashOf({ ...base, performTime: "30 Minuten" })).not.toBe(original);
    const empty = Object.fromEntries(NUTRITION_KEYS.map((key) => [key, null])) as Record<
      NutritionKey,
      string | null
    >;
    expect(hashOf({ ...base, nutrition: { ...empty, calories: "512 kcal" } })).not.toBe(original);
  });

  it("ignores tags, categories, the image, extras and timestamps", () => {
    const original = hashOf(base);
    expect(
      hashOf({
        ...base,
        tags: [],
        recipeCategory: [],
        image: "other",
        extras: { mc_recipe_id: "1" },
        dateUpdated: "2030-01-01",
        updatedAt: "2030-01-01",
      }),
    ).toBe(original);
  });

  it("changes with the output locale but keeps de-DE hashes as they were", () => {
    const recipe = mealieRecipe();
    const ingredients = normalizeIngredients(recipe);
    const legacy = sourceHash(recipe, ingredients, 1);
    expect(sourceHash(recipe, ingredients, 1, "de-DE")).toBe(legacy);
    expect(sourceHash(recipe, ingredients, 1, "en-US")).not.toBe(legacy);
    expect(sourceHash(recipe, ingredients, 1, "en-US")).not.toBe(
      sourceHash(recipe, ingredients, 1, "fr-FR"),
    );
  });
});
