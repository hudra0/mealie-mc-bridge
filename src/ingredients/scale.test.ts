import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NormalizedIngredient } from "./normalize.js";
import {
  DEFAULT_SERVINGS,
  MAX_SERVINGS,
  MIN_SERVINGS,
  PINCH_MIN_FACTOR,
  ROUNDING,
  scaleIngredients,
  scalerBase,
  servingsFor,
} from "./scale.js";

const item = (overrides: Partial<NormalizedIngredient>): NormalizedIngredient => ({
  index: 0,
  section: null,
  quantity: 1,
  quantityMax: null,
  unit: null,
  food: "Zutat",
  note: "",
  optional: false,
  source: "parsed",
  original: "",
  referenceId: null,
  ...overrides,
});

const scaleOne = (overrides: Partial<NormalizedIngredient>, factor: number) => {
  const [scaled] = scaleIngredients([item(overrides)], factor);
  if (!scaled) throw new Error("no result");
  return scaled;
};

describe("rounding rules", () => {
  it.each([
    // g and ml from 100: nearest 5.
    [100, "g", 1.5, 150],
    [250, "g", 1.33, 335],
    [300, "ml", 0.37, 110],
    // g and ml from 10 to 100: nearest 1.
    [30, "g", 1.5, 45],
    [70, "ml", 1.33, 93],
    // g and ml below 10: one decimal.
    [7, "g", 1.33, 9.3],
    [3, "ml", 0.5, 1.5],
    // kg and l: two decimals.
    [1, "kg", 1.333, 1.33],
    [0.75, "l", 1.5, 1.13],
    // Spoons: nearest half, nearest quarter below one.
    [2, "EL", 1.33, 2.5],
    [3, "TL", 0.5, 1.5],
    [1, "TL", 0.5, 0.5],
    [1, "tbsp", 0.33, 0.25],
    [1, "tsp", 0.66, 0.75],
    // Cups: nearest quarter.
    [0.333, "cup", 1.5, 0.5],
    [1, "Tasse", 1.33, 1.25],
    // Ounces like spoons, pounds to a quarter.
    [8, "oz", 1.33, 10.5],
    [1, "lb", 1.33, 1.25],
    // Pieces: nearest half.
    [3, "Stueck", 1.5, 4.5],
    [2, "Zehe", 1.33, 2.5],
    [1, "Dose", 2, 2],
    [3, null, 0.5, 1.5],
    [1, "Handvoll", 3, 3],
  ])("scales %d %s by %d to %d", (quantity, unit, factor, expected) => {
    expect(scaleOne({ quantity, unit }, factor).quantity).toBe(expected);
  });

  it("never rounds a positive amount down to zero", () => {
    expect(scaleOne({ quantity: 0.1, unit: "g" }, 0.1).quantity).toBe(ROUNDING.metric.minimum);
    expect(scaleOne({ quantity: 1, unit: "kg" }, 0.001).quantity).toBe(0.01);
    expect(scaleOne({ quantity: 1, unit: "TL" }, 0.1).quantity).toBe(0.25);
    expect(scaleOne({ quantity: 1, unit: null }, 0.1).quantity).toBe(0.5);
  });

  it("scales both ends of a range and drops an upper bound that collapses", () => {
    expect(scaleOne({ quantity: 2, quantityMax: 3, unit: "EL" }, 2)).toMatchObject({
      quantity: 4,
      quantityMax: 6,
    });
    expect(scaleOne({ quantity: 1, quantityMax: 1.2, unit: "EL" }, 0.5)).toMatchObject({
      quantity: 0.5,
      quantityMax: null,
    });
  });

  it("keeps the amounts before scaling", () => {
    expect(scaleOne({ quantity: 2, quantityMax: 3, unit: "EL" }, 2)).toMatchObject({
      baseQuantity: 2,
      baseQuantityMax: 3,
    });
  });
});

describe("pinches", () => {
  it.each(["Prise", "Msp", "pinch"])("keeps %s unchanged from half the recipe up", (unit) => {
    expect(scaleOne({ quantity: 2, unit }, 3).quantity).toBe(2);
    expect(scaleOne({ quantity: 2, unit }, PINCH_MIN_FACTOR).quantity).toBe(2);
  });

  it("keeps one pinch below half the recipe", () => {
    expect(scaleOne({ quantity: 2, quantityMax: 3, unit: "Prise" }, 0.25)).toMatchObject({
      quantity: 1,
      quantityMax: null,
      flags: [],
    });
  });
});

describe("flags", () => {
  it("flags counted items that end up fractional", () => {
    expect(scaleOne({ quantity: 3, unit: "Stueck" }, 1.5).flags).toEqual(["checkRounding"]);
    expect(scaleOne({ quantity: 1, quantityMax: 3, unit: null }, 1.5).flags).toEqual([
      "checkRounding",
    ]);
    expect(scaleOne({ quantity: 2, unit: "Stueck" }, 1.5).flags).toEqual([]);
    expect(scaleOne({ quantity: 250, unit: "g" }, 1.33).flags).toEqual([]);
  });

  it("leaves unparsed items unscaled and flags them", () => {
    const scaled = scaleOne({ quantity: null, source: "unparsed", food: "2-3 Stück irgendwas" }, 2);
    expect(scaled).toMatchObject({ quantity: null, flags: ["unscaled"] });
  });

  it("leaves items without a quantity alone", () => {
    expect(scaleOne({ quantity: null, food: "Salz" }, 2)).toMatchObject({
      quantity: null,
      flags: [],
    });
  });

  it("changes nothing at factor 1", () => {
    const input = [
      item({ quantity: 333, unit: "g" }),
      item({ quantity: null, source: "unparsed" }),
      item({ quantity: 1.5, unit: "Stueck" }),
    ];
    const scaled = scaleIngredients(input, 1);
    expect(scaled.map((entry) => entry.quantity)).toEqual([333, null, 1.5]);
    expect(scaled.every((entry) => entry.flags.length === 0)).toBe(true);
  });

  it("does not change the input", () => {
    const input = item({ quantity: 2, unit: "EL" });
    scaleIngredients([input], 3);
    expect(input.quantity).toBe(2);
  });
});

describe("scaleIngredients input checks", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects the factor %d", (factor) => {
    expect(() => scaleIngredients([item({})], factor)).toThrow(RangeError);
  });
});

describe("servingsFor", () => {
  // Mealie's scaler sets recipe_scale = chosen / base with
  // base = recipeServings || recipeYieldQuantity || 1, so the chosen servings are
  // base × recipe_scale.
  it.each([
    [4, 0, 1, 4],
    [4, 0, 1.5, 6],
    [3, 0, 0.5, 2],
    [4, 0, 0.1, 1],
    [2.5, 0, 1, 3],
    [4, 2, 2, 8],
    [20, 0, 3, 60],
    [40, 0, 3, MAX_SERVINGS],
    [Number.NaN, 0, 1, DEFAULT_SERVINGS],
    [4, 0, 0, 4],
    [4, 0, Number.NaN, 4],
  ])("turns %d servings and yield %d at factor %d into %d", (servings, yieldQty, factor, want) => {
    expect(servingsFor({ recipeServings: servings, recipeYieldQuantity: yieldQty }, factor)).toBe(
      want,
    );
  });

  it.each([
    // No servings: the scaler starts from the yield quantity. 2 → 4 means factor 2.
    [2, 2, 4],
    [2, 1, 2],
    [6, 0.5, 3],
    // Neither servings nor yield: Mealie starts from 1, so the factor is the choice.
    [0, 4, 4],
    [0, 3, 3],
    // Not scaled and nothing stated: the default stands in.
    [0, 1, DEFAULT_SERVINGS],
  ])("without servings, uses yield %d at factor %d for %d servings", (yieldQty, factor, want) => {
    expect(servingsFor({ recipeServings: 0, recipeYieldQuantity: yieldQty }, factor)).toBe(want);
  });

  it("limits the servings to the device range", () => {
    expect(MIN_SERVINGS).toBe(1);
    expect(MAX_SERVINGS).toBe(100);
    expect(servingsFor({ recipeServings: 12, recipeYieldQuantity: 0 }, 3)).toBe(36);
    expect(servingsFor({ recipeServings: 50, recipeYieldQuantity: 0 }, 2)).toBe(100);
    expect(servingsFor({ recipeServings: 50, recipeYieldQuantity: 0 }, 3)).toBe(100);
    expect(servingsFor({ recipeServings: 24, recipeYieldQuantity: 0 }, 0.01)).toBe(1);
  });

  it("uses the servings range from knowledge/device-programs.json", () => {
    const file = new URL("../../knowledge/device-programs.json", import.meta.url);
    const programs = JSON.parse(readFileSync(file, "utf8")) as {
      recipeLimits: { servings: { amount: { effective: { min: number; max: number } } } };
    };
    const { min, max } = programs.recipeLimits.servings.amount.effective;
    expect([MIN_SERVINGS, MAX_SERVINGS]).toEqual([min, max]);
  });
});

describe("scalerBase", () => {
  it.each([
    [4, 2, 4],
    [0, 2, 2],
    [0, 0, null],
    [Number.NaN, Number.NaN, null],
  ])("picks %d servings or yield %d as %s", (servings, yieldQty, want) => {
    expect(scalerBase({ recipeServings: servings, recipeYieldQuantity: yieldQty })).toBe(want);
  });
});
