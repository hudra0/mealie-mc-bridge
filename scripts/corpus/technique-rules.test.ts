import { describe, expect, it } from "vitest";
import { comboKey, quantiles } from "./analyze-techniques.js";
import {
  classifyRecipe,
  cleanTitle,
  isHot,
  mainIngredient,
  type Technique,
} from "./technique-rules.js";
import type { NormalizedStep } from "./types.js";

// Synthetic steps, written for the tests; no corpus text.
type StepSpec =
  string | { mode: string; text?: string; temperature?: number; time?: number; speed?: number };

function recipe(title: string, specs: StepSpec[]) {
  const steps: NormalizedStep[] = specs.map((spec, i) => {
    const text = typeof spec === "string" ? spec : (spec.text ?? "Manuelles Kochen");
    const machine = typeof spec !== "string";
    return {
      recipeId: 1,
      source: "official",
      categories: [],
      stepIndex: i,
      stepCount: specs.length,
      kind: machine ? "machine" : "text",
      mode: machine ? spec.mode : "text",
      temperature: machine ? (spec.temperature ?? 0) : null,
      timeSeconds: machine ? (spec.time ?? null) : null,
      speed: machine ? (spec.speed ?? null) : null,
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
    };
  });
  return classifyRecipe({ title, steps });
}

const techniquesOf = (title: string, specs: StepSpec[]): Technique[] =>
  recipe(title, specs).map((c) => c.result.technique);

const manual = (temperature: number, extra: Partial<{ time: number; speed: number }> = {}) => ({
  mode: "customized",
  temperature,
  ...extra,
});

describe("classifyRecipe", () => {
  it("chops, sautés and simmers a classic soup start", () => {
    expect(
      techniquesOf("Gemüsesuppe", [
        "1 Zwiebel schälen, halbieren und in den Mixbehälter geben.",
        manual(0, { time: 5, speed: 5 }),
        "Mit dem Spatel nach unten schieben.",
        "20 g Öl dazugeben.",
        manual(120, { time: 180, speed: 1 }),
        "500 g Wasser dazugeben.",
        manual(100, { time: 900, speed: 1 }),
        { mode: "ramp", temperature: 0, time: 40 },
      ]),
    ).toEqual(["zerkleinern", "anschwitzen", "koecheln_garen", "suppe_puerieren_heiss"]);
  });

  it("classifies scale steps as weighing", () => {
    expect(
      techniquesOf("Test", [{ mode: "scale", text: "200 g Mehl in den Mixbehälter geben." }]),
    ).toEqual(["waage"]);
  });

  it("treats the basket on the lid as a splash guard, not as steaming", () => {
    expect(
      techniquesOf("Tomatensauce", [
        "400 g passierte Tomaten in den Mixbehälter geben.",
        "Den Kocheinsatz als Spritzschutz auf den Deckel stellen.",
        manual(100, { time: 1200, speed: 1 }),
      ]),
    ).toEqual(["koecheln_garen"]);
  });

  it("steams in the basket when it is hung into the bowl", () => {
    expect(
      techniquesOf("Kartoffeln", [
        "500 g Wasser in den Mixbehälter geben.",
        "Kartoffeln in den Kocheinsatz geben und den Kocheinsatz einhängen.",
        { mode: "steaming", text: "Dampfgaren", time: 1200 },
      ]),
    ).toEqual(["daempfen_gareinsatz"]);
  });

  it("uses yeast in the bowl to tell yeast dough from short dough, and resets on rinsing", () => {
    expect(
      techniquesOf("Brot", [
        "200 g Wasser und 20 g Hefe in den Mixbehälter geben.",
        manual(37, { time: 180, speed: 1 }),
        "400 g Mehl dazugeben.",
        { mode: "kneading", text: "Einfaches Kneten", time: 120 },
        "Den Teig umfüllen und den Mixbehälter ausspülen.",
        "200 g Mehl und 100 g Butter in den Mixbehälter geben.",
        { mode: "kneading", text: "Einfaches Kneten", time: 60 },
      ]),
    ).toEqual(["hefe_aktivieren", "hefeteig_kneten", "muerbteig_kneten"]);
  });

  it("lets a 'run the next step if needed' step repeat the previous technique", () => {
    const out = recipe("Puderzucker", [
      "100 g Zucker in den Mixbehälter geben.",
      manual(0, { time: 10, speed: 10 }),
      "Bei Bedarf den nächsten Schritt ausführen, ansonsten überspringen.",
      manual(0, { time: 10, speed: 10 }),
    ]);
    expect(out.map((c) => c.result.technique)).toEqual(["fein_mahlen", "fein_mahlen"]);
    expect(out[1]?.result.evidence).toBe("repeat");
  });

  it("whips cream with the whisk attachment", () => {
    expect(
      techniquesOf("Dessert", [
        "Den Rühraufsatz einsetzen.",
        "200 g Sahne in den Mixbehälter geben.",
        manual(0, { time: 90, speed: 4 }),
      ]),
    ).toEqual(["schlagen"]);
  });

  it("leaves a step without any evidence unclassified", () => {
    expect(techniquesOf("Test", [manual(80, { time: 60, speed: 2 })])).toEqual(["unclassified"]);
  });
});

describe("helpers", () => {
  it("isHot: temperature or a heating program", () => {
    expect(isHot({ mode: "customized", temperature: 0 })).toBe(false);
    expect(isHot({ mode: "customized", temperature: 37 })).toBe(true);
    expect(isHot({ mode: "steaming", temperature: 0 })).toBe(true);
  });

  it("cleanTitle blanks editor defaults", () => {
    expect(cleanTitle("Manuelles Kochen")).toBe("");
    expect(cleanTitle("Schritt 12")).toBe("");
    expect(cleanTitle("Zwiebel zerkleinern")).toBe("zwiebel zerkleinern");
  });

  it("mainIngredient prefers the specific class over liquid", () => {
    expect(mainIngredient({ title: "", before: "500 g wasser | 300 g rinderhack", bowl: "" })).toBe(
      "meat",
    );
    expect(mainIngredient({ title: "", before: "", bowl: "" })).toBe("unknown");
  });

  it("quantiles use nearest rank", () => {
    expect(quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toMatchObject({ p10: 1, p50: 5, p90: 9 });
    expect(quantiles([]).p50).toBeNull();
  });

  it("comboKey lists only set values", () => {
    const step = recipe("Test", [manual(100, { time: 300, speed: 1 })])[0]?.step;
    expect(step && comboKey(step)).toBe("customized / 100°C / 300s / speed 1");
  });
});
