import { describe, expect, it } from "vitest";
import {
  amountStyle,
  canonicalUnit,
  conceptOf,
  effectiveUnit,
  findGramAnnotations,
  gramsPerUnitFromName,
  inferGrid,
  isEquipment,
  measuredMass,
  quantiles,
} from "./analyze-ingredients.js";

describe("quantiles", () => {
  it("interpolates and ignores non-finite values", () => {
    const q = quantiles([1, 2, 3, 4, Number.NaN]);
    expect(q).toMatchObject({ n: 4, min: 1, p50: 2.5, max: 4, mean: 2.5 });
  });
  it("returns null for no values", () => {
    expect(quantiles([])).toBeNull();
  });
});

describe("inferGrid", () => {
  it("finds the coarsest step most values sit on", () => {
    expect(inferGrid([100, 150, 200, 250, 300])).toBe(50);
    expect(inferGrid([10, 15, 20, 25, 35])).toBe(5);
    expect(inferGrid([3, 7, 12])).toBe(1);
  });
  it("honours the threshold", () => {
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 125];
    expect(inferGrid(values, 0.9)).toBe(100);
    expect(inferGrid(values, 1)).toBe(25);
  });
});

describe("units", () => {
  it("canonicalizes spelling variants", () => {
    expect(canonicalUnit(" Msp. ")).toBe("msp");
    expect(canonicalUnit("Würfel ")).toBe("würfel");
  });
  it("maps raw units to concepts", () => {
    expect(conceptOf("Tl")).toBe("TL");
    expect(conceptOf("El")).toBe("EL");
    expect(conceptOf("Prisen")).toBe("Prise");
    expect(conceptOf("P.")).toBe("Pkg");
    expect(conceptOf("dosen")).toBe("Dose");
    expect(conceptOf("g")).toBeNull();
  });
  it("takes the unit from the amount field when the unit is empty", () => {
    expect(effectiveUnit({ unit: "", amountRaw: "250 g" })).toBe("g");
    expect(effectiveUnit({ unit: "", amountRaw: "n.B." })).toBe("");
    expect(effectiveUnit({ unit: "Tl", amountRaw: "1" })).toBe("Tl");
  });
  it("measures g, kg and ml but not counted units", () => {
    expect(measuredMass({ unit: "kg", amountRaw: "1,5", amount: 1.5 })).toEqual({
      kind: "g",
      value: 1500,
    });
    expect(measuredMass({ unit: "L", amountRaw: "1", amount: 1 })).toEqual({
      kind: "ml",
      value: 1000,
    });
    expect(measuredMass({ unit: "Stück", amountRaw: "2", amount: 2 })).toBeNull();
  });
});

describe("amountStyle", () => {
  it("classifies amount spellings", () => {
    expect(amountStyle("250")).toBe("integer");
    expect(amountStyle("1 ½")).toBe("unicode-fraction");
    expect(amountStyle("1/2")).toBe("ascii-fraction");
    expect(amountStyle("0,5")).toBe("decimal-comma");
    expect(amountStyle("1-2")).toBe("range");
    expect(amountStyle("250 g")).toBe("with-unit");
    expect(amountStyle("n.B.")).toBe("text");
    expect(amountStyle(" ")).toBe("empty");
  });
});

describe("isEquipment", () => {
  it("flags jars, moulds and the ZUBEHÖR group", () => {
    expect(isEquipment({ name: "Schraubgläser (à 200 ml)", group: null })).toBe(true);
    expect(isEquipment({ name: "Backpapier", group: null })).toBe(true);
    expect(isEquipment({ name: "Butter", group: "ZUBEHÖR" })).toBe(true);
    expect(isEquipment({ name: "Tomaten, stückig aus der Dose/Glas", group: null })).toBe(false);
  });
});

describe("gram annotations", () => {
  it("reads counted amounts with a stated weight from step text", () => {
    const found = findGramAnnotations(
      "½ Zwiebel (40 g) schälen, 1 Dose stückige Tomaten (400 g) dazugeben.",
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ concept: "Stück", count: 0.5, gramsPerUnit: 80 });
    expect(found[1]).toMatchObject({ concept: "Dose", count: 1, gramsPerUnit: 400 });
  });
  it("handles ca., spoons and missing spaces", () => {
    const [a] = findGramAnnotations("2 EL Butter (ca. 30 g) schmelzen");
    expect(a).toMatchObject({ concept: "EL", gramsPerUnit: 15 });
    const [b] = findGramAnnotations("1 P. Vanillezucker (8g) zugeben");
    expect(b).toMatchObject({ concept: "Pkg", gramsPerUnit: 8 });
  });
  it("ignores millilitre annotations", () => {
    expect(findGramAnnotations("4 Gläser (à 200 ml) vorbereiten")).toHaveLength(0);
  });
  it("reads weights from ingredient names", () => {
    expect(gramsPerUnitFromName("Kalbsrouladen (à 170 g)", 4)).toBe(170);
    expect(gramsPerUnitFromName("Möhren (300 g)", 3)).toBe(100);
    expect(gramsPerUnitFromName("Zwiebel, mittelgroß (ca. 75 g)", 1)).toBe(75);
    expect(gramsPerUnitFromName("Joghurt natur (3,5 % Fett)", 1)).toBeNull();
  });
});
