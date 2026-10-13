import { describe, expect, it } from "vitest";
import {
  analyze,
  counts,
  isOnTemperatureGrid,
  positionThird,
  programLabel,
  quantile,
  quantiles,
  tempBand,
} from "./analyze-modes.js";
import type { NormalizedRecipe, NormalizedStep } from "./types.js";

describe("quantile", () => {
  it("interpolates linearly between ranks", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.9)).toBe(10);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("ignores null values in quantiles()", () => {
    const q = quantiles([null, 5, 1, undefined, 3]);
    expect(q).toMatchObject({ n: 3, min: 1, p50: 3, max: 5, mean: 3 });
  });
});

describe("counts", () => {
  it("sorts numeric keys numerically", () => {
    expect(Object.keys(counts([10, 2, 2, 100]))).toEqual(["2", "10", "100"]);
  });

  it("sorts text keys by count", () => {
    expect(Object.keys(counts(["a", "b", "b"]))).toEqual(["b", "a"]);
  });
});

describe("temperature helpers", () => {
  it("maps temperatures to bands", () => {
    expect(tempBand(0)).toBe("0");
    expect(tempBand(37)).toBe("37-60");
    expect(tempBand(60)).toBe("37-60");
    expect(tempBand(65)).toBe("65-95");
    expect(tempBand(100)).toBe("100");
    expect(tempBand(130)).toBe("105-130");
    expect(tempBand(null)).toBeNull();
  });

  it("accepts 0, 37 and 40-130 in steps of 5", () => {
    expect(isOnTemperatureGrid(0)).toBe(true);
    expect(isOnTemperatureGrid(37)).toBe(true);
    expect(isOnTemperatureGrid(45)).toBe(true);
    expect(isOnTemperatureGrid(130)).toBe(true);
    expect(isOnTemperatureGrid(38)).toBe(false);
    expect(isOnTemperatureGrid(135)).toBe(false);
  });
});

describe("positionThird", () => {
  it("splits a recipe into thirds by step index", () => {
    expect(positionThird(0, 10)).toBe("first");
    expect(positionThird(4, 10)).toBe("middle");
    expect(positionThird(9, 10)).toBe("last");
    expect(positionThird(0, 1)).toBe("first");
  });
});

describe("programLabel", () => {
  const step = (o: Partial<NormalizedStep>) => ({
    mode: "customized",
    temperature: 0,
    speed: 1,
    reverse: false,
    timeSeconds: 10,
    ...o,
  });

  it("reads cold steps by speed and time", () => {
    expect(programLabel(step({ speed: 6, timeSeconds: 8 }))).toBe("chop (cold)");
    expect(programLabel(step({ speed: 10, timeSeconds: 60 }))).toBe("blend/puree (cold)");
    expect(programLabel(step({ speed: 2, reverse: true }))).toBe("fold/stir in (cold, reverse)");
    expect(programLabel(step({ speed: 4, timeSeconds: 30 }))).toBe("mix (cold)");
  });

  it("reads heated steps by temperature band and reverse", () => {
    expect(programLabel(step({ temperature: 37, speed: 1 }))).toBe("warm/dissolve (37-60)");
    expect(programLabel(step({ temperature: 100, reverse: true }))).toBe("simmer, reverse (100)");
    expect(programLabel(step({ temperature: 120 }))).toBe("saute/steam off (105-130)");
  });

  it("groups all kneading modes", () => {
    expect(programLabel(step({ mode: "kneading_soft_dough" }))).toBe("knead");
    expect(programLabel(step({ mode: "steaming" }))).toBe("steaming");
  });
});

describe("analyze", () => {
  const base: NormalizedStep = {
    recipeId: 1,
    source: "official",
    categories: [7],
    stepIndex: 0,
    stepCount: 3,
    kind: "machine",
    mode: "customized",
    temperature: 0,
    timeSeconds: 8,
    speed: 6,
    reverse: false,
    turbo: false,
    weight: null,
    modeSetting: null,
    title: "",
    titleLen: 0,
    textLen: 0,
    text: "",
    prevTextSteps: null,
    cumulativeGramsBefore: 0,
    amountsInText: [],
  };
  const steps: NormalizedStep[] = [
    base,
    {
      ...base,
      stepIndex: 1,
      kind: "text",
      mode: "text",
      temperature: null,
      speed: null,
      timeSeconds: null,
    },
    { ...base, stepIndex: 2, temperature: 100, speed: 5, reverse: true, timeSeconds: 600 },
    {
      ...base,
      recipeId: 2,
      source: "member",
      mode: "roasting",
      temperature: 130,
      speed: null,
      timeSeconds: 240,
    },
  ];
  const recipe = (id: number, source: string) =>
    ({ id, source, categories: [{ id: 7, name: "Cat" }] }) as unknown as NormalizedRecipe;
  const r = analyze(steps, [recipe(1, "official"), recipe(2, "member")]);

  it("counts modes per source", () => {
    expect(r.frequency.overall.official.customized?.steps).toBe(2);
    expect(r.frequency.overall.member.roasting?.shareOfRecipes).toBe(1);
    expect(r.frequency.textSteps.official).toBe(1);
  });

  it("flags heated or reverse steps above speed 3", () => {
    const [heat, rev] = r.customized.official.violations;
    expect(heat?.steps).toBe(1);
    expect(rev?.steps).toBe(1);
  });

  it("ranks programs by official recipes", () => {
    expect(r.programs.exact[0]?.officialRecipes).toBe(1);
    expect(r.programs.exact.some((p) => p.key === "roasting | 130C | 240s")).toBe(true);
  });
});
