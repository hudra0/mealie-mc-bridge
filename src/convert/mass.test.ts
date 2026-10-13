import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedIngredient } from "../ingredients/index.js";
import type { RecipeInput, RecipeStep } from "../recipe/schema.js";
import { loadKnowledge } from "./knowledge.js";
import {
  HOT_ADDITION_C,
  amountMentions,
  attributeIngredient,
  clauses,
  densityOf,
  gramsFor,
  indexIngredients,
  ingredientGrams,
  ingredientKeys,
  matchScore,
  mentionedIngredients,
  nameKeys,
  pieceWeight,
  stem,
  stepTemperature,
  stepText,
  mixedTemperature,
  traceBowl,
} from "./mass.js";

const knowledge = await loadKnowledge(fileURLToPath(new URL("../../knowledge", import.meta.url)));
const units = knowledge.units;

const ingredient = (
  food: string,
  quantity: number | null,
  unit: string | null,
  extra: Partial<NormalizedIngredient> = {},
): NormalizedIngredient => ({
  index: 0,
  section: null,
  quantity,
  quantityMax: null,
  unit,
  food,
  note: "",
  optional: false,
  source: "structured",
  original: "",
  referenceId: null,
  ...extra,
});

const recipeWith = (steps: RecipeStep[]): RecipeInput => ({
  title: "Test",
  description: "",
  locale: "de-DE",
  complexity: "easy",
  categoryIds: [1],
  servingSize: {
    amount: 4,
    unit: "Portionen",
    preparationTime: 10,
    readyInTime: 30,
    ingredientGroups: [
      { name: "", ingredients: [{ name: "Wasser", amount: 1, unit: "g", isOptional: false }] },
    ],
    steps,
  },
});

const text = (description: string): RecipeStep => ({
  kind: "text",
  title: description.slice(0, 80),
  description,
});
const scale = (grams: number, what: string, where = "in den Mixbehälter geben"): RecipeStep => ({
  kind: "scale",
  title: `${grams} g ${what}`,
  description: `${grams} g ${what} ${where}.`,
  grams,
});

describe("name matching", () => {
  it("stems singular and plural to the same key", () => {
    expect(stem("Zwiebeln")).toBe(stem("Zwiebel"));
    expect(stem("Tomaten")).toBe(stem("Tomate"));
    expect(stem("Eier")).toBe(stem("Ei"));
    expect(stem("Öl")).toBe("öl");
  });

  it("drops qualifiers from ingredient names", () => {
    expect(nameKeys("Kartoffeln, festkochend, geschält")).toEqual(["kartoffel", "festkochend"]);
    expect(nameKeys("frische Hefe")).toEqual(["hef"]);
  });

  it("matches input ingredients without their qualifiers in parentheses", () => {
    expect(ingredientKeys("Auflaufform (ca. 20 x 30 cm)")).toEqual(["auflaufform"]);
    expect(ingredientKeys("Spaghetti (Kochzeit 9 Minuten)")).toEqual(["spaghetti"]);
    expect(ingredientKeys("(Deko)")).toEqual(["deko"]);
    const index = indexIngredients([ingredient("Spaghetti (Kochzeit 9 Minuten)", 500, "g")]);
    expect(attributeIngredient("Minuten garen", index)).toBeNull();
  });

  it("scores exact and compound matches", () => {
    const stems = (text: string) => text.toLowerCase().split(" ").map(stem);
    expect(matchScore(nameKeys("Zwiebeln"), stems("die zwiebel schälen"))).toBe(2);
    expect(matchScore(nameKeys("Gemüsebrühe"), stems("brühe zugeben"))).toBe(1);
    expect(matchScore(nameKeys("Olivenöl"), stems("öl erhitzen"))).toBe(1);
    expect(matchScore(nameKeys("Knoblauchzehen"), stems("knoblauch hacken"))).toBe(1);
    expect(matchScore(nameKeys("Mehl"), stems("zucker zugeben"))).toBe(0);
  });

  it("finds the best matching ingredients and attributes a phrase to one of them", () => {
    const index = indexIngredients([
      ingredient("Paprikapulver", 1, "TL"),
      ingredient("Paprika", 2, null),
      ingredient("Sahne", 200, "g"),
    ]);
    expect(mentionedIngredients("Paprika würfeln", index)).toEqual([1]);
    expect(attributeIngredient("Sahne zugeben", index)).toBe(2);
    expect(attributeIngredient("Salz", index)).toBeNull();
    const twins = indexIngredients([ingredient("Butter", 100, "g"), ingredient("Butter", 50, "g")]);
    expect(attributeIngredient("Butter", twins)).toBeNull();
  });
});

describe("amountMentions", () => {
  it("reads amounts with units, fractions and bare counts", () => {
    expect(amountMentions("200 g Sahne und 1 ½ Tl Salz zugeben, dann 2 Eier.")).toEqual([
      { amount: 200, unit: "g", phrase: "Sahne und" },
      { amount: 1.5, unit: "TL", phrase: "Salz zugeben" },
      { amount: 2, unit: null, phrase: "Eier" },
    ]);
    expect(amountMentions("0,5 l Milch")).toEqual([{ amount: 0.5, unit: "l", phrase: "Milch" }]);
    expect(amountMentions("¼ Tl Muskat")[0]).toMatchObject({ amount: 0.25, unit: "TL" });
    expect(amountMentions("1/2 El Öl")[0]).toMatchObject({ amount: 0.5, unit: "EL" });
  });

  it("ignores numbers without a following name", () => {
    expect(amountMentions("Stufe 3.")).toEqual([]);
  });

  it("does not read sizes, times and settings as amounts", () => {
    expect(amountMentions("Eine Form von 20 x 30 cm einfetten")).toEqual([]);
    expect(amountMentions("Die Spaghetti 9 Minuten garen")).toEqual([]);
    expect(amountMentions("Auf 100 °C erhitzen")).toEqual([]);
    expect(amountMentions("2 Min. warten, dann 2 Eier zugeben")).toEqual([
      { amount: 2, unit: null, phrase: "Eier zugeben" },
    ]);
  });
});

describe("step texts", () => {
  it("splits sentences and semicolon parts, not abbreviations", () => {
    expect(clauses("Zwiebel schälen; 2 Eier zugeben. Dann rühren.")).toEqual([
      "Zwiebel schälen",
      "2 Eier zugeben",
      "Dann rühren",
    ]);
    expect(clauses("Ca. 1 Msp. Muskat zugeben.")).toEqual(["Ca. 1 Msp. Muskat zugeben"]);
  });

  it("reads a text step's description and a scale step's title only when it adds something", () => {
    const step: RecipeStep = {
      kind: "text",
      title: "4 Eier zugeben",
      description: "4 Eier aufschlagen und in den Mixbehälter geben.",
    };
    expect(stepText(step)).toBe("4 Eier aufschlagen und in den Mixbehälter geben.");
    expect(stepText(scale(200, "Sahne"))).toBe("200 g Sahne in den Mixbehälter geben.");
    const short: RecipeStep = {
      kind: "scale",
      title: "200 g Sahne",
      description: "Einwiegen.",
      grams: 200,
    };
    expect(stepText(short)).toBe("200 g Sahne\nEinwiegen.");
  });
});

describe("weights from units.json", () => {
  it("converts weights, volumes and spoons", () => {
    expect(gramsFor(250, "g", "Mehl", units)).toBe(250);
    expect(gramsFor(1.5, "kg", "Mehl", units)).toBe(1500);
    expect(gramsFor(100, "ml", "Olivenöl", units)).toBeCloseTo(92);
    expect(gramsFor(0.5, "l", "Milch", units)).toBeCloseTo(515);
    expect(gramsFor(2, "EL", "Zucker", units)).toBe(30);
    expect(gramsFor(1, "TL", "Salz", units)).toBe(5);
    expect(gramsFor(1, "cup", "Wasser", units)).toBe(240);
  });

  it("uses piece weights, package tables and per-unit weights", () => {
    expect(gramsFor(2, null, "Zwiebeln", units)).toBe(140);
    expect(gramsFor(1, "Stueck", "Zucchini", units)).toBe(200);
    expect(gramsFor(1, "Dose", "Tomaten", units)).toBe(400);
    expect(gramsFor(2, "Packung", "Vanillezucker", units)).toBe(16);
    expect(gramsFor(1, "Wuerfel", "Hefe", units)).toBe(40);
    expect(gramsFor(1, "Bund", "Petersilie", units)).toBe(125);
    expect(gramsFor(1, "Stange", "Lauch", units)).toBe(180);
  });

  it("counts pinches and cloves as nothing and gives up on unknown units", () => {
    expect(gramsFor(1, "Prise", "Salz", units)).toBe(0);
    expect(gramsFor(3, "Zehe", "Knoblauch", units)).toBe(0);
    expect(gramsFor(1, "Glas", "Kapern", units)).toBeNull();
    expect(gramsFor(1, null, "Drachenfrucht", units)).toBeNull();
    expect(gramsFor(1, "Packung", "Blätterteig", units)).toBeNull();
    expect(gramsFor(1, "Handvoll", "Rosinen", units)).toBeNull();
  });

  it("estimates an input ingredient", () => {
    expect(ingredientGrams(ingredient("Mehl", 500, "g"), units)).toBe(500);
    expect(ingredientGrams(ingredient("Mehl", 400, "g", { quantityMax: 500 }), units)).toBe(500);
    expect(ingredientGrams(ingredient("Tomaten", 2, "Dose", { weightGrams: 425 }), units)).toBe(
      850,
    );
    expect(ingredientGrams(ingredient("Salz", null, null), units)).toBe(0);
    expect(ingredientGrams(ingredient("Salz", null, "Prise"), units)).toBe(0);
    expect(ingredientGrams(ingredient("Brühe", null, "ml"), units)).toBeNull();
    expect(
      ingredientGrams(ingredient("irgendwas", 1, null, { source: "unparsed" }), units),
    ).toBeNull();
  });

  it("looks up densities and piece weights by name", () => {
    expect(densityOf("Honig", units)).toBe(1.4);
    expect(densityOf("Apfelsaft", units)).toBe(1);
    expect(pieceWeight("Kartoffeln", units)).toBe(100);
    expect(pieceWeight("und", units)).toBeNull();
  });
});

describe("traceBowl", () => {
  it("adds scale steps and named ingredients, and empties the bowl on a transfer", () => {
    const ingredients = [ingredient("Zwiebeln", 2, null), ingredient("Kartoffeln", 500, "g")];
    const traces = traceBowl(
      recipeWith([
        text("Zwiebeln halbieren und in den Mixbehälter geben."),
        { kind: "turbo", title: "Turbo", description: "Zwiebeln hacken", seconds: 2 },
        text("Zwiebeln in eine Schüssel umfüllen."),
        scale(1000, "Wasser"),
        text("Kartoffeln in den Mixbehälter geben."),
      ]),
      ingredients,
      knowledge,
    );
    expect(traces.map((trace) => trace.after.grams)).toEqual([140, 140, 0, 1000, 1500]);
    expect(traces[3]?.after.liquidGrams).toBe(1000);
    expect(traces[4]?.after.foaming).toBe(true);
  });

  it("replaces a text estimate by the weight of a following scale step", () => {
    const traces = traceBowl(
      recipeWith([text("Zwiebeln in den Mixbehälter geben."), scale(80, "Zwiebeln")]),
      [ingredient("Zwiebeln", 1, null)],
      knowledge,
    );
    expect(traces.map((trace) => trace.after.grams)).toEqual([70, 80]);
  });

  it("uses the amount stated in the text and marks unknown weights", () => {
    const traces = traceBowl(
      recipeWith([
        text("300 g Mehl und den Teig in den Mixbehälter geben."),
        text("Rosinen zugeben."),
      ]),
      [ingredient("Mehl", 500, "g"), ingredient("Rosinen", 1, "Handvoll")],
      knowledge,
    );
    expect(traces[0]?.after).toMatchObject({ grams: 300, flourGrams: 300, unknown: false });
    expect(traces[1]?.after.unknown).toBe(true);
  });

  it("counts oil poured onto the lid as going into the bowl", () => {
    const traces = traceBowl(
      recipeWith([
        scale(100, "Eigelb"),
        text("250 g Öl langsam auf den Deckel gießen, sodass es in den Mixbehälter läuft."),
      ]),
      [ingredient("Eigelb", 100, "g"), ingredient("Öl", 250, "g")],
      knowledge,
    );
    expect(traces[1]?.after.grams).toBe(350);
  });

  it("counts hot additions at a hot temperature", () => {
    const boil: RecipeStep = {
      kind: "customized",
      title: "Kochen",
      temperature: 100,
      minutes: 5,
      seconds: 0,
      speed: 1,
      rotation: "right",
    };
    const traces = traceBowl(
      recipeWith([scale(500, "Wasser"), boil, scale(500, "heiße Gemüsebrühe")]),
      [],
      knowledge,
    );
    expect(traces[2]?.after.temperature).toBe((100 + HOT_ADDITION_C) / 2);
  });

  it("keeps steamer contents out of the bowl and follows liquid in text", () => {
    const traces = traceBowl(
      recipeWith([
        text("500 g Wasser in den Mixbehälter geben."),
        scale(400, "Brokkoli", "im Dampfgaraufsatz verteilen"),
        text("Brokkoli in den Dampfgaraufsatz geben."),
        text("Wasser einfüllen."),
      ]),
      [ingredient("Brokkoli", 400, "g")],
      knowledge,
    );
    expect(traces[1]?.after.grams).toBe(500);
    expect(traces[1]?.after.liquidGrams).toBe(500);
    expect(traces[2]?.after.grams).toBe(500);
    expect(traces[3]?.after.liquidUnknown).toBe(true);
  });

  it("follows the whisk and the heat of the contents", () => {
    const traces = traceBowl(
      recipeWith([
        text("Rühraufsatz einsetzen."),
        {
          kind: "customized",
          title: "Erhitzen",
          temperature: 90,
          minutes: 5,
          seconds: 0,
          speed: 2,
          rotation: "right",
        },
        text("Rühraufsatz entfernen und abkühlen lassen."),
        { kind: "steaming", title: "Dampfgaren", minutes: 20, seconds: 0 },
      ]),
      [],
      knowledge,
    );
    expect(traces.map((trace) => trace.after.whisk)).toEqual([true, true, false, false]);
    expect(traces.map((trace) => trace.after.temperature)).toEqual([20, 90, 20, 100]);
  });

  it("lowers the temperature to the mixing temperature when cold contents go in", () => {
    const traces = traceBowl(
      recipeWith([
        scale(100, "Wasser"),
        {
          kind: "customized",
          title: "Kochen",
          temperature: 100,
          minutes: 5,
          seconds: 0,
          speed: 1,
          rotation: "right",
        },
        scale(300, "Wasser"),
      ]),
      [],
      knowledge,
    );
    expect(traces.map((trace) => trace.after.temperature)).toEqual([20, 100, 40]);
    expect(mixedTemperature(0, 100, 50, 20)).toBe(20);
    expect(mixedTemperature(100, 90, 0, 20)).toBe(90);
  });

  it("reports the temperature a step heats to", () => {
    expect(stepTemperature({ kind: "steaming", title: "x", minutes: 1, seconds: 0 })).toBe(100);
    expect(stepTemperature({ kind: "puree", title: "x", minutes: 1, seconds: 0 })).toBe(0);
  });
});
