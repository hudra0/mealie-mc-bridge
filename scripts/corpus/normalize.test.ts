import { describe, expect, it } from "vitest";
import {
  buildSummary,
  detectAccessories,
  estimateGrams,
  findAmountsInText,
  ingredientKeys,
  normalizeIngredient,
  normalizeRecipe,
  normalizeUnit,
  parseAmount,
  parseDetailFile,
} from "./normalize.js";

// Synthetic recipe written for these tests; it mirrors the shape of the API detail
// response but is not taken from any real recipe.
const fixture = {
  recipe: {
    id: 900001,
    name: "Testsuppe",
    source: "official",
    deviceTypes: ["MC3.0"],
    categories: [{ id: 228, name: "Suppen & Eintöpfe" }],
    complexity: "Einfach",
    preparationDuration: 10,
    duration: 30,
    rating: 4.5,
    totalRating: 12,
    popularity: 1.5,
    nutrients: [
      { name: "Calories", unit: "kcal", amount: 210, amountFloat: 210.4 },
      { name: "Carbohydrate", unit: "g", amount: 20, amountFloat: 20 },
      { name: "Fat", unit: "g", amount: 9, amountFloat: null },
      { name: "Protein", unit: "g", amount: 6, amountFloat: 6 },
    ],
    servingSizes: [
      {
        amount: 2,
        servingUnit: "Portionen",
        ingredientGroups: [{ id: 1, order: 0, name: "FÜR DIE SUPPE" }],
        ingredients: [
          {
            order: 0,
            amount: "150",
            unit: "g",
            name: "Karotten, in Stücken",
            ingredientGroupId: 1,
          },
          { order: 1, amount: "1", unit: "Stück", name: "Zwiebel(n)", ingredientGroupId: 1 },
          { order: 2, amount: "400", unit: "ml", name: "Wasser", ingredientGroupId: 1 },
          { order: 3, amount: "1", unit: "Tl", name: "Salz", ingredientGroupId: null },
          { order: 4, amount: "200", unit: "g", name: "rote Linsen", ingredientGroupId: 1 },
        ],
        steps: [
          {
            step: 1,
            order: 0,
            name: "Karotten und Zwiebel in den Mixbehälter geben.",
            description: "Karotten und Zwiebel in den Mixbehälter geben. Messbecher einsetzen.",
            deviceSetting: null,
          },
          {
            step: 2,
            order: 1,
            name: "Zerkleinern",
            description: "",
            deviceSetting: {
              mode: "customized",
              reverse: false,
              turbo: false,
              size: null,
              texture: null,
              cleaningMode: null,
              settings: [{ order: 0, speed: 6, temperature: 0, time: 5, weight: null }],
            },
          },
          {
            step: 3,
            order: 2,
            name: "200 g Linsen zugeben",
            description: "200 g Linsen zugeben",
            deviceSetting: {
              mode: "scale",
              reverse: false,
              turbo: false,
              size: null,
              texture: null,
              cleaningMode: null,
              settings: [{ order: 0, speed: null, temperature: 0, time: null, weight: 200 }],
            },
          },
          {
            step: 4,
            order: 3,
            name: "400 ml Wasser und 1 TL Salz zugeben, mit dem Spatel nach unten schieben.",
            description: "400 ml Wasser und 1 TL Salz zugeben, mit dem Spatel nach unten schieben.",
            deviceSetting: null,
          },
          {
            step: 5,
            order: 4,
            name: "Kochen",
            description: null,
            deviceSetting: {
              mode: "customized",
              reverse: true,
              turbo: false,
              size: null,
              texture: null,
              cleaningMode: null,
              settings: [{ order: 0, speed: 1, temperature: 100, time: 1200, weight: null }],
            },
          },
        ],
      },
    ],
  },
};

describe("parseAmount", () => {
  it.each([
    ["250", 250, ""],
    ["1,5", 1.5, ""],
    ["½", 0.5, ""],
    ["1/4", 0.25, ""],
    ["1 ½", 1.5, ""],
    ["1 1/2", 1.5, ""],
    ["11/2", 1.5, ""],
    ["13/4", 1.75, ""],
    ["15/2", 7.5, ""],
    ["1-2", 1.5, ""],
    ["2 - 3", 2.5, ""],
    ["250 g", 250, "g"],
    ["1 Päckchen", 1, "Päckchen"],
  ])("parses %j", (raw, amount, rest) => {
    expect(parseAmount(raw)).toEqual({ amount, rest });
  });

  it.each(["", "n.B.", "etwas"])("gives null for %j", (raw) => {
    expect(parseAmount(raw).amount).toBeNull();
  });
});

describe("normalizeUnit", () => {
  it.each([
    ["g", "g", 1],
    ["kg", "g", 1000],
    ["ml", "ml", 1],
    ["L", "ml", 1000],
    ["Stück", "Stueck", 1],
    ["Tl", "TL", 1],
    ["TL", "TL", 1],
    ["El", "EL", 1],
    ["Prise", "Prise", 1],
    ["Prisen", "Prise", 1],
    ["Msp.", "other", 1],
    ["Würfel ", "other", 1],
    ["", "none", 1],
    [null, "none", 1],
  ])("maps %j to %s", (unit, unitNorm, factor) => {
    expect(normalizeUnit(unit)).toEqual({ unitNorm, factor });
  });
});

describe("estimateGrams", () => {
  it("uses the amount for gram units, scaled for kg", () => {
    expect(estimateGrams(150, "g", 1, "Karotten")).toBe(150);
    expect(estimateGrams(1.5, "g", 1000, "Mehl")).toBe(1500);
  });

  it("counts millilitres only for water-like liquids", () => {
    expect(estimateGrams(400, "ml", 1, "Wasser")).toBe(400);
    expect(estimateGrams(200, "ml", 1, "Gemüsebrühe")).toBe(200);
    expect(estimateGrams(50, "ml", 1, "Olivenöl")).toBeNull();
  });

  it("gives null for count and spoon units and missing amounts", () => {
    expect(estimateGrams(1, "Stueck", 1, "Zwiebel")).toBeNull();
    expect(estimateGrams(1, "TL", 1, "Salz")).toBeNull();
    expect(estimateGrams(null, "g", 1, "Mehl")).toBeNull();
  });
});

describe("normalizeIngredient", () => {
  const groups = new Map<number, string | null>();

  it("takes the unit from the amount field when the unit is empty", () => {
    const ing = normalizeIngredient(
      { amount: "240 g Abtropfgewicht", unit: "", name: "Mais" },
      0,
      groups,
    );
    expect([ing.amount, ing.unitNorm, ing.grams]).toEqual([240, "g", 240]);
  });

  it("treats free text without a number as no unit", () => {
    const ing = normalizeIngredient({ amount: "n.B.", unit: "", name: "Pfeffer" }, 0, groups);
    expect([ing.amount, ing.unitNorm, ing.grams]).toEqual([null, "none", null]);
  });

  it("converts kilograms and litres", () => {
    expect(normalizeIngredient({ amount: "1,5", unit: "kg", name: "Mehl" }, 0, groups).grams).toBe(
      1500,
    );
    expect(normalizeIngredient({ amount: "1", unit: "L", name: "Wasser" }, 0, groups).grams).toBe(
      1000,
    );
  });
});

describe("findAmountsInText", () => {
  it("finds amounts with g, ml, EL, TL and Stück", () => {
    const found = findAmountsInText(
      "200 g Mehl, 100ml Milch, 2 EL Öl, ½ TL Salz, 1-2 Stück Ei und 1,5 kg Kartoffeln",
    );
    expect(found).toEqual([
      { amount: 200, unit: "g", raw: "200 g" },
      { amount: 100, unit: "ml", raw: "100ml" },
      { amount: 2, unit: "EL", raw: "2 EL" },
      { amount: 0.5, unit: "TL", raw: "½ TL" },
      { amount: 1.5, unit: "Stueck", raw: "1-2 Stück" },
    ]);
  });

  it("ignores numbers followed by other words", () => {
    expect(findAmountsInText("bei 100 Grad 5 Min. garen, Stufe 3")).toEqual([]);
  });
});

describe("ingredientKeys", () => {
  it("strips parentheses and preparation notes and adds the last word", () => {
    expect(ingredientKeys("Zwiebel(n), halbiert")).toEqual(["zwiebel"]);
    expect(ingredientKeys("rote Linsen")).toEqual(["rote linsen", "linsen"]);
    expect(ingredientKeys("Ei")).toEqual([]);
  });
});

describe("detectAccessories", () => {
  it("matches umlaut and transliterated spellings", () => {
    expect(
      detectAccessories([
        "Ruehraufsatz einsetzen",
        "Kocheinsatz einhängen",
        "Dampfgaraufsatz aufsetzen",
        "Messbecher entfernen",
      ]),
    ).toEqual(["Ruehraufsatz", "Gareinsatz", "Dampfgaraufsatz", "Messbecher"]);
    expect(detectAccessories(["Rühraufsatz", "mit dem Spatel"])).toEqual([
      "Ruehraufsatz",
      "Spatel",
    ]);
    expect(detectAccessories(["Dampfgareinsatz einlegen"])).toEqual(["Dampfgaraufsatz"]);
  });
});

describe("normalizeRecipe", () => {
  const { recipe, steps } = normalizeRecipe(parseDetailFile(JSON.stringify(fixture)));

  it("classifies steps by the presence of a device setting", () => {
    expect(steps.map((s) => s.kind)).toEqual(["text", "machine", "machine", "text", "machine"]);
    expect(recipe.textStepCount).toBe(2);
    expect(recipe.machineStepCount).toBe(3);
    expect(recipe.scaleStepCount).toBe(1);
  });

  it("builds the mode sequence with text for text steps", () => {
    expect(recipe.modeSequence).toEqual(["text", "customized", "scale", "text", "customized"]);
  });

  it("uses the title when a machine step has no description", () => {
    expect(steps[1]?.text).toBe("Zerkleinern");
    expect(steps[4]?.text).toBe("Kochen");
  });

  it("keeps the step title next to the text", () => {
    expect(steps[0]?.title).toBe("Karotten und Zwiebel in den Mixbehälter geben.");
    expect(steps[0]?.text).toContain("Messbecher einsetzen.");
    expect(steps[1]?.title).toBe("Zerkleinern");
  });

  it("normalizes ingredients with units, grams and groups", () => {
    expect(recipe.ingredients.map((i) => [i.unitNorm, i.amount, i.grams, i.group])).toEqual([
      ["g", 150, 150, "FÜR DIE SUPPE"],
      ["Stueck", 1, null, "FÜR DIE SUPPE"],
      ["ml", 400, 400, "FÜR DIE SUPPE"],
      ["TL", 1, null, null],
      ["g", 200, 200, "FÜR DIE SUPPE"],
    ]);
  });

  it("estimates the cumulative grams in the bowl", () => {
    // Step 1 names Karotten (150 g) and Zwiebel (no gram estimate). Step 3 is a
    // scale step of 200 g. Step 4 names Wasser (400 ml) and Salz (no estimate).
    expect(steps.map((s) => s.cumulativeGramsBefore)).toEqual([150, 150, 350, 750, 750]);
  });

  it("does not count an ingredient twice when a scale step weighs it after a text mention", () => {
    const twice = structuredClone(fixture);
    const first = twice.recipe.servingSizes[0]?.steps[0];
    if (first) first.description = "Karotten, Zwiebel und rote Linsen in den Mixbehälter geben.";
    const result = normalizeRecipe(parseDetailFile(JSON.stringify(twice)));
    expect(result.steps.map((s) => s.cumulativeGramsBefore)).toEqual([350, 350, 350, 750, 750]);
  });

  it("collects the text steps before each machine step", () => {
    expect(steps[0]?.prevTextSteps).toBeNull();
    expect(steps[1]?.prevTextSteps).toBe(steps[0]?.text);
    expect(steps[4]?.prevTextSteps).toBe(steps[3]?.text);
  });

  it("extracts amounts from step texts", () => {
    expect(steps[3]?.amountsInText).toEqual([
      { amount: 400, unit: "ml", raw: "400 ml" },
      { amount: 1, unit: "TL", raw: "1 TL" },
    ]);
  });

  it("derives recipe-level machine facts", () => {
    expect(recipe.isSmartOnly).toBe(true);
    expect(recipe.totalMachineSeconds).toBe(1205);
    expect(recipe.maxTemperature).toBe(100);
    expect(recipe.usesReverse).toBe(true);
    expect(recipe.usesTurbo).toBe(false);
    expect(recipe.accessories).toEqual(["Messbecher", "Spatel"]);
    expect(recipe.nutrients).toEqual({ kcal: 210.4, carb: 20, fat: 9, protein: 6 });
    expect(recipe.servings).toEqual({ amount: 2, unit: "Portionen" });
    expect(recipe.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("accepts the full API envelope as well", () => {
    const enveloped = JSON.stringify({ code: 0, data: fixture });
    expect(normalizeRecipe(parseDetailFile(enveloped)).recipe.id).toBe(900001);
  });

  it("feeds the summary", () => {
    const summary = buildSummary([{ recipe, steps }], [], 1);
    expect(summary.modeFrequency).toEqual({ text: 2, customized: 2, scale: 1 });
    expect(summary.distinctModes).toEqual([
      { mode: "customized", steps: 2, recipes: 1 },
      { mode: "scale", steps: 1, recipes: 1 },
    ]);
    expect(summary.stepsPerRecipe).toEqual({ min: 5, max: 5, median: 5, mean: 5 });
  });
});
