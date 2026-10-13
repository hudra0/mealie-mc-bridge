import { describe, expect, it } from "vitest";
import {
  classify,
  chopClasses,
  dist,
  estimateBowl,
  isFlour,
  linearFit,
  multiFit,
  passiveMinutes,
  physicalMinSeconds,
  quantile,
  steamClasses,
} from "./analyze-timing.js";
import type { NormalizedIngredient, NormalizedRecipe, NormalizedStep } from "./types.js";

// Synthetic recipe and steps written for these tests; not taken from the corpus.
function ingredient(order: number, name: string, grams: number | null): NormalizedIngredient {
  return {
    order,
    name,
    amount: grams,
    amountRaw: grams === null ? "" : String(grams),
    unit: grams === null ? "Stück" : "g",
    unitNorm: grams === null ? "Stueck" : "g",
    grams,
    systemIngredientId: null,
    group: null,
  };
}

function recipe(ingredients: NormalizedIngredient[]): NormalizedRecipe {
  return {
    id: 1,
    title: "Test",
    source: "official",
    deviceTypes: ["MC3.0"],
    isSmartOnly: true,
    categories: [],
    complexity: null,
    servings: { amount: 4, unit: "Portionen" },
    prepMinutes: 10,
    totalMinutes: 30,
    nutrients: { kcal: null, carb: null, fat: null, protein: null },
    rating: null,
    totalRating: null,
    popularity: null,
    ingredientCount: ingredients.length,
    ingredients,
    stepCount: 0,
    machineStepCount: 0,
    scaleStepCount: 0,
    textStepCount: 0,
    modeSequence: [],
    totalMachineSeconds: 0,
    maxTemperature: null,
    usesReverse: false,
    usesTurbo: false,
    accessories: [],
    contentHash: "",
  };
}

function step(
  index: number,
  mode: string,
  text: string,
  extra: { weight?: number; temperature?: number; timeSeconds?: number; speed?: number } = {},
): NormalizedStep {
  return {
    recipeId: 1,
    source: "official",
    categories: [],
    stepIndex: index,
    stepCount: 0,
    kind: mode === "text" ? "text" : "machine",
    mode,
    temperature: null,
    timeSeconds: null,
    speed: null,
    reverse: false,
    turbo: false,
    weight: null,
    modeSetting: null,
    titleLen: text.length,
    textLen: text.length,
    text,
    prevTextSteps: null,
    cumulativeGramsBefore: 0,
    amountsInText: [],
    ...extra,
  };
}

describe("statistics", () => {
  it("interpolates quantiles", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
    expect(dist([3, 1, 2]).median).toBe(2);
  });

  it("fits a straight line exactly", () => {
    const fit = linearFit([0, 1, 2, 3], [5, 7, 9, 11]);
    expect(fit?.a).toBe(5);
    expect(fit?.b).toBe(2);
    expect(fit?.r2).toBe(1);
  });

  it("fits a plane with two terms", () => {
    const rows = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ];
    const ys = rows.map(([a = 0, b = 0]) => 1 + 2 * a + 3 * b);
    expect(multiFit(rows, ys)?.coef).toEqual([1, 2, 3]);
  });
});

describe("physicalMinSeconds", () => {
  it("needs about 457 s to bring 1 kg of water to the boil", () => {
    expect(Math.round(physicalMinSeconds(1000, 100))).toBe(457);
  });

  it("caps the target at 100 degC", () => {
    expect(physicalMinSeconds(500, 130)).toBe(physicalMinSeconds(500, 100));
    expect(physicalMinSeconds(500, 10)).toBe(0);
  });
});

describe("estimateBowl", () => {
  const r = recipe([
    ingredient(0, "Zwiebel", 100),
    ingredient(1, "Gemüsebrühe", 800),
    ingredient(2, "Lachsfilet", 300),
    ingredient(3, "Mehl (Type 405)", 500),
  ]);

  it("adds scale weights, parks plate weighings and empties the bowl on umfüllen", () => {
    const steps = [
      step(0, "scale", "100 g Zwiebel in den Mixbehälter geben.", { weight: 100 }),
      step(1, "customized", "Zerkleinern", { temperature: 0, timeSeconds: 5, speed: 5 }),
      step(2, "scale", "Schale auf den Deckel setzen, 300 g Lachsfilet darauf wiegen.", {
        weight: 300,
      }),
      step(3, "scale", "800 g Gemüsebrühe dazugeben.", { weight: 800 }),
      step(4, "customized", "Kochen", { temperature: 100, timeSeconds: 600, speed: 1 }),
      step(5, "text", "Die Suppe umfüllen."),
      step(6, "scale", "500 g Mehl in den Mixbehälter geben.", { weight: 500 }),
    ];
    const est = estimateBowl(r, steps);
    expect(est.map((e) => e.bowlGrams)).toEqual([100, 100, 100, 900, 900, 0, 500]);
    expect(est[5]?.reset).toBe("strong");
    expect(est[6]?.flourAddedGrams).toBe(500);
  });

  it("counts a text mention once and replaces it when a scale step weighs the same item", () => {
    const steps = [
      step(0, "text", "Die Zwiebel in den Mixbehälter geben."),
      step(1, "scale", "100 g Zwiebel dazugeben.", { weight: 120 }),
    ];
    expect(estimateBowl(r, steps).map((e) => e.bowlGrams)).toEqual([100, 120]);
  });

  it("does not add food put into the steamer or a pan", () => {
    const steps = [
      step(0, "text", "Das Lachsfilet in den tiefen Dampfgaraufsatz geben."),
      step(1, "text", "Die Zwiebel in einer Pfanne anbraten und hineingeben."),
    ];
    const est = estimateBowl(r, steps);
    expect(est[0]?.bowlGrams).toBe(0);
    expect(est[0]?.steamerAddedGrams).toBe(300);
    expect(est[1]?.bowlGrams).toBe(0);
  });
});

describe("text helpers", () => {
  it("recognizes flour but not breadcrumbs or floury potatoes", () => {
    expect(isFlour("Dinkelmehl (Type 630)")).toBe(true);
    expect(isFlour("Paniermehl")).toBe(false);
    expect(isFlour("Kartoffeln, mehligkochend")).toBe(false);
    expect(isFlour("Mehl zum Bearbeiten")).toBe(false);
  });

  it("classifies by priority", () => {
    expect(classify("lachs und brokkoli", steamClasses).primary).toBe("fish_seafood");
    expect(classify("zwiebel und knoblauch", chopClasses).primary).toBe("onion_garlic");
    expect(classify("nichts", chopClasses).primary).toBe("other");
  });

  it("reads passive minutes and skips device settings written in text", () => {
    expect(passiveMinutes("Im Ofen 35 Minuten backen.")).toBe(35);
    expect(passiveMinutes("1 Stunde gehen lassen.")).toBe(60);
    expect(passiveMinutes("10-20 Min. ruhen lassen.")).toBe(15);
    expect(passiveMinutes("5 Min./100 °C/Stufe 1 kochen.")).toBe(0);
  });
});
