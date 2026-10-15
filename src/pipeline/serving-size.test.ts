import { describe, expect, it } from "vitest";
import {
  formatServingSize,
  portionWord,
  servingSizeFor,
  servingUnitText,
  type ServingWords,
} from "./serving-size.js";

const de: ServingWords = {
  portion: { singular: "Portion", plural: "Portionen" },
  unitCase: "capitalize",
};
const en: ServingWords = {
  portion: { singular: "portion", plural: "portions" },
  unitCase: "lower",
};
const range = { min: 1, max: 100 };

const recipe = (servings: number, yieldQuantity: number, yieldText: string | null) => ({
  recipeServings: servings,
  recipeYieldQuantity: yieldQuantity,
  recipeYield: yieldText,
});

describe("servingSizeFor", () => {
  it("takes the yield quantity and text, times the scale", () => {
    expect(servingSizeFor(recipe(0, 10, "Scheiben"), 1, range, de)).toEqual({
      amount: 10,
      unit: "Scheiben",
      source: "yield",
    });
    expect(servingSizeFor(recipe(4, 12, "muffins"), 1.5, range, de)).toEqual({
      amount: 18,
      unit: "Muffins",
      source: "yield",
    });
    expect(servingSizeFor(recipe(0, 12, "Muffins"), 1, range, en).unit).toBe("muffins");
  });

  it("keeps the yield amount within the device range", () => {
    expect(servingSizeFor(recipe(0, 60, "Kekse"), 3, range, de).amount).toBe(100);
    expect(servingSizeFor(recipe(0, 1, "Brot"), 0.25, range, de).amount).toBe(1);
  });

  it("uses the pack's word for portions when only servings are given", () => {
    expect(servingSizeFor(recipe(4, 0, null), 2, range, de)).toEqual({
      amount: 8,
      unit: "Portionen",
      source: "servings",
    });
    expect(servingSizeFor(recipe(2, 0, "  "), 0.5, range, de)).toEqual({
      amount: 1,
      unit: "Portion",
      source: "servings",
    });
    expect(servingSizeFor(recipe(3, 0, null), 1, range, en).unit).toBe("portions");
    // A yield quantity without a text counts like servings, as Mealie's scaler sees it.
    expect(servingSizeFor(recipe(0, 6, null), 1, range, de)).toEqual({
      amount: 6,
      unit: "Portionen",
      source: "servings",
    });
  });

  it("marks the default as an estimate when the recipe states neither", () => {
    expect(servingSizeFor(recipe(0, 0, null), 1, range, de)).toEqual({
      amount: 4,
      unit: "Portionen",
      source: "estimate",
    });
    // A yield text without a quantity says nothing about the amount.
    expect(servingSizeFor(recipe(0, 0, "Scheiben"), 1, range, de).source).toBe("estimate");
  });
});

describe("servingUnitText", () => {
  it("drops a count the text repeats and cases the first letter like the pack", () => {
    expect(servingUnitText("12 Muffins", de)).toBe("Muffins");
    expect(servingUnitText("ca. 4-6 portionen", de)).toBe("Portionen");
    expect(servingUnitText("2,5 Liter", de)).toBe("Liter");
    expect(servingUnitText("Slices", en)).toBe("slices");
    expect(servingUnitText("XL muffins", en)).toBe("XL muffins");
  });

  it("keeps singular and plural as written", () => {
    expect(servingUnitText("Stück", de)).toBe("Stück");
    expect(servingUnitText("Scheibe", de)).toBe("Scheibe");
  });

  it("returns null for text without letters and strips markup", () => {
    expect(servingUnitText("12", de)).toBeNull();
    expect(servingUnitText(null, de)).toBeNull();
    expect(servingUnitText("<b>Gläser</b>", de)).toBe("Gläser");
  });

  it("cuts a long text at a word within the limit", () => {
    const unit = servingUnitText("kleine Gläser mit Schraubdeckel für den Vorratsschrank", de, 30);
    expect(unit).toBe("Kleine Gläser mit");
    expect((unit ?? "").length).toBeLessThanOrEqual(30);
  });
});

describe("formatting", () => {
  it("writes amount and unit", () => {
    expect(formatServingSize({ amount: 10, unit: "Scheiben" })).toBe("10 Scheiben");
    expect(formatServingSize({ amount: 4, unit: null })).toBe("4");
    expect(portionWord(1, de)).toBe("Portion");
  });
});
