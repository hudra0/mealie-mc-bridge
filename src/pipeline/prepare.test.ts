import { describe, expect, it } from "vitest";
import type { NormalizedIngredient } from "../ingredients/index.js";
import { limits, mealieRecipe } from "../testing/fakes.js";
import { deLocale } from "../testing/locale.js";
import {
  catalogNameHints,
  conversionRequest,
  prepareRecipe,
  type CategoryPlan,
} from "./prepare.js";

const emptyPlan: CategoryPlan = {
  catalog: { categories: [], source: "fallback" } as unknown as CategoryPlan["catalog"],
  matches: [],
  hints: [],
};

const line = (index: number, food: string): NormalizedIngredient => ({
  index,
  section: null,
  quantity: null,
  quantityMax: null,
  unit: null,
  food,
  note: "",
  optional: false,
  source: "structured",
  original: food,
  referenceId: null,
});

const known = new Set(["Salz", "Mehl"]);
const resolver = {
  suggest: (names: readonly string[]) => names.map((name) => [`${name} (catalog)`]),
  knows: (name: string) => known.has(name),
};

describe("catalogNameHints", () => {
  it("offers near names when the catalog knows enough of the source lines", () => {
    const lines = [line(0, "Salz"), line(1, "Mehl"), line(2, "Butternusskürbis")];
    expect(catalogNameHints(lines, resolver)).toEqual([
      { index: 0, names: ["Salz (catalog)"] },
      { index: 1, names: ["Mehl (catalog)"] },
      { index: 2, names: ["Butternusskürbis (catalog)"] },
    ]);
  });

  it("offers nothing for a recipe in another language than the catalog", () => {
    const english = [line(0, "olive oil"), line(1, "salt"), line(2, "red onion")];
    expect(catalogNameHints(english, resolver)).toEqual([]);
    // One known line out of six is below MIN_KNOWN_SHARE.
    const mostlyEnglish = [...english, line(3, "Salz"), line(4, "pasta"), line(5, "lemon")];
    expect(catalogNameHints(mostlyEnglish, resolver)).toEqual([]);
  });

  it("offers every line without a language check when the resolver cannot tell", () => {
    const english = [line(0, "olive oil")];
    expect(catalogNameHints(english, { suggest: resolver.suggest })).toHaveLength(1);
    expect(catalogNameHints(english, undefined)).toEqual([]);
  });
});

describe("prepareRecipe serving size", () => {
  it("carries the yield of the recipe into the converter input and the request", () => {
    const recipe = mealieRecipe({
      recipeServings: 0,
      recipeYieldQuantity: 5,
      recipeYield: "Scheiben",
    });
    const prepared = prepareRecipe(recipe, 2, limits, deLocale);
    expect(prepared.servingSize).toEqual({ amount: 10, unit: "Scheiben", source: "yield" });
    expect(prepared.servings).toBe(10);
    expect(prepared.rendered).toContain("Portionen: 5 → 10 Scheiben (aus der Ergibt-Menge)");
    const request = conversionRequest(recipe, prepared, emptyPlan, "de-DE");
    expect(request).toMatchObject({
      servings: 10,
      servingUnit: "Scheiben",
      servingsSource: "yield",
    });
  });

  it("uses the pack's word for portions for plain servings", () => {
    const prepared = prepareRecipe(mealieRecipe(), 1, limits, deLocale);
    expect(prepared.servingSize).toEqual({ amount: 4, unit: "Portionen", source: "servings" });
  });

  it("marks a recipe without servings and yield as an estimate", () => {
    const recipe = mealieRecipe({ recipeServings: 0, recipeYieldQuantity: 0, recipeYield: null });
    const prepared = prepareRecipe(recipe, 1, limits, deLocale);
    expect(prepared.servingSize.source).toBe("estimate");
    expect(prepared.rendered).toContain("Portionen: 4 (im Rezept nicht angegeben)");
  });
});
