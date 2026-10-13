import { describe, expect, it } from "vitest";
import type { NormalizedIngredient } from "../ingredients/index.js";
import type { Ingredient, RecipeInput, RecipeStep } from "../recipe/schema.js";
import { testKnowledge } from "../testing/locale.js";
import {
  attributeItem,
  ingredientKeys,
  linkIngredients,
  mentionedItems,
  type IngredientLinks,
} from "./mapping.js";
import {
  HOT_ADDITION_C,
  amountMentions,
  clauses,
  densityOf,
  entryGrams,
  gramsFor,
  ingredientGrams,
  itemGrams,
  listUnit,
  parseListAmount,
  pieceWeight,
  stepTemperature,
  stepText,
  mixedTemperature,
  traceBowl,
} from "./mass.js";

const knowledge = await testKnowledge("de-DE");
const english = await testKnowledge("en-US");
const t = knowledge.text;
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

const entry = (name: string, amount: string | number = "", unit = ""): Ingredient => ({
  name,
  amount,
  unit,
  isOptional: false,
});

// A recipe whose ingredient list carries each input under its own name, mapped one to one.
function recipeWith(
  steps: RecipeStep[],
  inputs: readonly NormalizedIngredient[] = [],
  locale = "de-DE",
): RecipeInput {
  const list = inputs.map((input) =>
    entry(input.food, input.quantity ?? "", input.unit === null ? "" : input.unit),
  );
  return {
    title: "Test",
    description: "",
    locale,
    complexity: "easy",
    categoryIds: [1],
    servingSize: {
      amount: 4,
      unit: "Portionen",
      preparationTime: 10,
      readyInTime: 30,
      ingredientGroups: [
        { name: "", ingredients: list.length > 0 ? list : [entry("Wasser", 1, "g")] },
      ],
      steps,
    },
    ingredientMapping: inputs.map((input, inputIndex) => ({ name: input.food, inputIndex })),
  };
}

function trace(steps: RecipeStep[], inputs: NormalizedIngredient[], k = knowledge) {
  const recipe = recipeWith(steps, inputs, k.locale);
  return traceBowl(recipe, inputs, k, linkIngredients(recipe, inputs, k.text));
}

function linksFor(names: readonly string[]): IngredientLinks {
  const inputs = names.map((name) => ingredient(name, 1, "g"));
  const recipe = recipeWith([text("x")], inputs);
  return linkIngredients(recipe, inputs, t);
}

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
    expect(t.stem("Zwiebeln")).toBe(t.stem("Zwiebel"));
    expect(t.stem("Tomaten")).toBe(t.stem("Tomate"));
    expect(t.stem("Eier")).toBe(t.stem("Ei"));
    expect(t.stem("Öl")).toBe("öl");
    expect(english.text.stem("tomatoes")).toBe(english.text.stem("tomato"));
    expect(english.text.stem("onions")).toBe("onion");
  });

  it("drops qualifiers from ingredient names", () => {
    expect(t.nameKeys("Kartoffeln, festkochend, geschält")).toEqual(["kartoffel", "festkochend"]);
    expect(t.nameKeys("frische Hefe")).toEqual(["hef"]);
    expect(english.text.nameKeys("pepper, black, ground")).toEqual(["pepper"]);
  });

  it("reads regional names as the Monsieur Cuisine names", () => {
    expect(t.words("Topfen und Karotten")).toEqual(["quark", "und", "möhren"]);
    expect(english.text.words("zucchini")).toEqual(["courgette"]);
  });

  it("matches names without their qualifiers in parentheses", () => {
    expect(ingredientKeys(t, "Auflaufform (ca. 20 x 30 cm)")).toEqual(["auflaufform"]);
    expect(ingredientKeys(t, "Spaghetti (Kochzeit 9 Minuten)")).toEqual(["spaghetti"]);
    expect(ingredientKeys(t, "(Deko)")).toEqual(["deko"]);
    expect(
      attributeItem(t, "Minuten garen", linksFor(["Spaghetti (Kochzeit 9 Minuten)"])),
    ).toBeNull();
  });

  it("scores exact and compound matches", () => {
    const stems = (source: string) => source.toLowerCase().split(" ").map(t.stem);
    expect(t.matchScore(t.nameKeys("Zwiebeln"), stems("die zwiebel schälen"))).toBe(2);
    expect(t.matchScore(t.nameKeys("Gemüsebrühe"), stems("brühe zugeben"))).toBe(1);
    expect(t.matchScore(t.nameKeys("Olivenöl"), stems("öl erhitzen"))).toBe(1);
    expect(t.matchScore(t.nameKeys("Knoblauchzehen"), stems("knoblauch hacken"))).toBe(1);
    expect(t.matchScore(t.nameKeys("Mehl"), stems("zucker zugeben"))).toBe(0);
  });

  it("finds the best matching list items and attributes a phrase to one of them", () => {
    const links = linksFor(["Paprikapulver", "Paprika", "Sahne"]);
    expect(mentionedItems(t, "Paprika würfeln", links)).toEqual([1]);
    expect(attributeItem(t, "Sahne zugeben", links)).toBe(2);
    expect(attributeItem(t, "Salz", links)).toBeNull();
  });
});

describe("amountMentions", () => {
  it("reads amounts with units, fractions and bare counts", () => {
    expect(amountMentions(t, "200 g Sahne und 1 ½ Tl Salz zugeben, dann 2 Eier.")).toEqual([
      { amount: 200, unit: "g", phrase: "Sahne und" },
      { amount: 1.5, unit: "TL", phrase: "Salz zugeben" },
      { amount: 2, unit: null, phrase: "Eier" },
    ]);
    expect(amountMentions(t, "0,5 l Milch")).toEqual([{ amount: 0.5, unit: "l", phrase: "Milch" }]);
    expect(amountMentions(t, "¼ Tl Muskat")[0]).toMatchObject({ amount: 0.25, unit: "TL" });
    expect(amountMentions(t, "1/2 El Öl")[0]).toMatchObject({ amount: 0.5, unit: "EL" });
    expect(amountMentions(t, "1 Msp. Muskat")[0]).toMatchObject({ amount: 1, unit: "Msp" });
  });

  it("reads English amounts with the en-US unit words", () => {
    expect(amountMentions(english.text, "Add 2 tbsp olive oil and 1 big pinch of salt.")).toEqual([
      { amount: 2, unit: "tbsp", phrase: "olive oil and" },
      { amount: 1, unit: "Msp", phrase: "of salt" },
    ]);
    expect(amountMentions(english.text, "Cook the pasta for 9 minutes.")).toEqual([]);
  });

  it("ignores numbers without a following name", () => {
    expect(amountMentions(t, "Stufe 3.")).toEqual([]);
  });

  it("does not read sizes, times and settings as amounts", () => {
    expect(amountMentions(t, "Eine Form von 20 x 30 cm einfetten")).toEqual([]);
    expect(amountMentions(t, "Die Spaghetti 9 Minuten garen")).toEqual([]);
    expect(amountMentions(t, "Auf 100 °C erhitzen")).toEqual([]);
    expect(amountMentions(t, "2 Min. warten, dann 2 Eier zugeben")).toEqual([
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

describe("weights from the unit rules", () => {
  it("converts weights, volumes and spoons", () => {
    expect(gramsFor(t, 250, "g", "Mehl", units)).toBe(250);
    expect(gramsFor(t, 1.5, "kg", "Mehl", units)).toBe(1500);
    expect(gramsFor(t, 100, "ml", "Olivenöl", units)).toBeCloseTo(92);
    expect(gramsFor(t, 0.5, "l", "Milch", units)).toBeCloseTo(515);
    expect(gramsFor(t, 2, "EL", "Zucker", units)).toBe(30);
    expect(gramsFor(t, 1, "TL", "Salz", units)).toBe(5);
    expect(gramsFor(t, 1, "cup", "Wasser", units)).toBe(240);
  });

  it("uses piece weights, package tables and per-unit weights", () => {
    expect(gramsFor(t, 2, null, "Zwiebeln", units)).toBe(140);
    expect(gramsFor(t, 1, "Stueck", "Zucchini", units)).toBe(200);
    expect(gramsFor(t, 1, "Dose", "Tomaten", units)).toBe(400);
    expect(gramsFor(t, 2, "Packung", "Vanillezucker", units)).toBe(16);
    expect(gramsFor(t, 1, "Wuerfel", "Hefe", units)).toBe(40);
    expect(gramsFor(t, 1, "Bund", "Petersilie", units)).toBe(125);
    expect(gramsFor(t, 1, "Stange", "Lauch", units)).toBe(180);
  });

  it("tries a second name for piece weights and densities", () => {
    expect(gramsFor(t, 2, null, "onions", units)).toBeNull();
    expect(gramsFor(t, 2, null, ["onions", "Zwiebeln"], units)).toBe(140);
    expect(gramsFor(t, 100, "ml", ["oil", "Olivenöl"], units)).toBeCloseTo(92);
  });

  it("counts pinches and cloves as nothing and gives up on unknown units", () => {
    expect(gramsFor(t, 1, "Prise", "Salz", units)).toBe(0);
    expect(gramsFor(t, 3, "Zehe", "Knoblauch", units)).toBe(0);
    expect(gramsFor(t, 1, "Glas", "Kapern", units)).toBeNull();
    expect(gramsFor(t, 1, null, "Drachenfrucht", units)).toBeNull();
    expect(gramsFor(t, 1, "Packung", "Blätterteig", units)).toBeNull();
    expect(gramsFor(t, 1, "Handvoll", "Rosinen", units)).toBeNull();
  });

  it("estimates a source ingredient", () => {
    expect(ingredientGrams(t, ingredient("Mehl", 500, "g"), units)).toBe(500);
    expect(ingredientGrams(t, ingredient("Mehl", 400, "g", { quantityMax: 500 }), units)).toBe(500);
    expect(ingredientGrams(t, ingredient("Tomaten", 2, "Dose", { weightGrams: 425 }), units)).toBe(
      850,
    );
    expect(ingredientGrams(t, ingredient("Salz", null, null), units)).toBe(0);
    expect(ingredientGrams(t, ingredient("Salz", null, "Prise"), units)).toBe(0);
    expect(ingredientGrams(t, ingredient("Brühe", null, "ml"), units)).toBeNull();
    expect(
      ingredientGrams(t, ingredient("irgendwas", 1, null, { source: "unparsed" }), units),
    ).toBeNull();
    expect(ingredientGrams(t, ingredient("onion", 1, null), units, ["Zwiebeln"])).toBe(70);
  });

  it("estimates an ingredient-list entry", () => {
    expect(entryGrams(t, entry("Mehl", 250, "g"), units)).toBe(250);
    expect(entryGrams(t, entry("Zwiebeln", "2", "Stück"), units)).toBe(140);
    expect(entryGrams(t, entry("Salz zum Abschmecken"), units)).toBe(0);
    expect(entryGrams(t, entry("Sahne", "", "g"), units)).toBeNull();
    expect(entryGrams(t, entry("Salz", "1 ½", "Prise"), units)).toBe(0);
    expect(listUnit(t, "Tl")).toBe("TL");
    expect(listUnit(t, "tsp")).toBe("tsp");
    expect(listUnit(t, "Becher")).toBe("Becher");
    expect(listUnit(t, "Löffelchen")).toBe("Löffelchen");
    expect(listUnit(t, " ")).toBeNull();
    expect(parseListAmount("1,5")).toBe(1.5);
    expect(parseListAmount("2-3")).toBeNull();
  });

  it("looks up densities and piece weights by name, in any pack's words", () => {
    expect(densityOf(t, "Honig", units)).toBe(1.4);
    expect(densityOf(t, "honey", units)).toBe(1.4);
    expect(densityOf(t, "Apfelsaft", units)).toBe(1);
    expect(pieceWeight(t, "Kartoffeln", units)).toBe(100);
    expect(pieceWeight(t, "und", units)).toBeNull();
    expect(pieceWeight(english.text, "carrots", english.units)).toBe(75);
  });
});

describe("itemGrams", () => {
  it("prefers the source amounts and falls back to the list entry", () => {
    const inputs = [
      ingredient("onion", 1, null),
      ingredient("Mehl", null, null, { source: "unparsed" }),
    ];
    const recipe: RecipeInput = {
      ...recipeWith([text("x")]),
      servingSize: {
        ...recipeWith([text("x")]).servingSize,
        ingredientGroups: [
          { name: "", ingredients: [entry("Zwiebeln", 1, "Stück"), entry("Mehl", 300, "g")] },
        ],
      },
      ingredientMapping: [
        { name: "Zwiebeln", inputIndex: 0 },
        { name: "Mehl", inputIndex: 1 },
      ],
    };
    const links = linkIngredients(recipe, inputs, t);
    expect(itemGrams(knowledge, links, 0, inputs)).toBe(70);
    expect(itemGrams(knowledge, links, 1, inputs)).toBe(300);
    expect(itemGrams(knowledge, links, 5, inputs)).toBeNull();
  });
});

describe("traceBowl", () => {
  it("adds scale steps and named ingredients, and empties the bowl on a transfer", () => {
    const traces = trace(
      [
        text("Zwiebeln halbieren und in den Mixbehälter geben."),
        { kind: "turbo", title: "Turbo", description: "Zwiebeln hacken", seconds: 2 },
        text("Zwiebeln in eine Schüssel umfüllen."),
        scale(1000, "Wasser"),
        text("Kartoffeln in den Mixbehälter geben."),
      ],
      [ingredient("Zwiebeln", 2, null), ingredient("Kartoffeln", 500, "g")],
    );
    expect(traces.map((step) => step.after.grams)).toEqual([140, 140, 0, 1000, 1500]);
    expect(traces[3]?.after.liquidGrams).toBe(1000);
    expect(traces[4]?.after.foaming).toBe(true);
  });

  it("replaces a text estimate by the weight of a following scale step", () => {
    const traces = trace(
      [text("Zwiebeln in den Mixbehälter geben."), scale(80, "Zwiebeln")],
      [ingredient("Zwiebeln", 1, null)],
    );
    expect(traces.map((step) => step.after.grams)).toEqual([70, 80]);
  });

  it("uses the amount stated in the text and marks unknown weights", () => {
    const traces = trace(
      [text("300 g Mehl und den Teig in den Mixbehälter geben."), text("Rosinen zugeben.")],
      [ingredient("Mehl", 500, "g"), ingredient("Rosinen", 1, "Handvoll")],
    );
    expect(traces[0]?.after).toMatchObject({ grams: 300, flourGrams: 300, unknown: false });
    expect(traces[1]?.after.unknown).toBe(true);
  });

  it("follows an English recipe with the en-US words", () => {
    const traces = trace(
      [
        {
          kind: "scale",
          title: "500 g water",
          description: "Put 500 g water into the blender jug.",
          grams: 500,
        },
        text("Add the potatoes."),
        text("Decant and set aside."),
      ],
      [ingredient("potatoes", 400, "g")],
      english,
    );
    expect(traces.map((step) => step.after.grams)).toEqual([500, 900, 0]);
    expect(traces[1]?.after.foaming).toBe(true);
    expect(traces[0]?.after.liquidGrams).toBe(500);
  });

  it("counts oil poured onto the lid as going into the bowl", () => {
    const traces = trace(
      [
        scale(100, "Eigelb"),
        text("250 g Öl langsam auf den Deckel gießen, sodass es in den Mixbehälter läuft."),
      ],
      [ingredient("Eigelb", 100, "g"), ingredient("Öl", 250, "g")],
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
    const traces = trace([scale(500, "Wasser"), boil, scale(500, "heiße Gemüsebrühe")], []);
    expect(traces[2]?.after.temperature).toBe((100 + HOT_ADDITION_C) / 2);
  });

  it("keeps steamer contents out of the bowl and follows liquid in text", () => {
    const traces = trace(
      [
        text("500 g Wasser in den Mixbehälter geben."),
        scale(400, "Brokkoli", "im Dampfgaraufsatz verteilen"),
        text("Brokkoli in den Dampfgaraufsatz geben."),
        text("Wasser einfüllen."),
      ],
      [ingredient("Brokkoli", 400, "g")],
    );
    expect(traces[1]?.after.grams).toBe(500);
    expect(traces[1]?.after.liquidGrams).toBe(500);
    expect(traces[2]?.after.grams).toBe(500);
    expect(traces[3]?.after.liquidUnknown).toBe(true);
  });

  it("marks liquid and foaming contents of unknown weight", () => {
    const traces = trace([text("Milch dazugeben.")], [ingredient("Milch", 1, "Glas")]);
    expect(traces[0]?.after).toMatchObject({ unknown: true, liquidUnknown: true, foaming: true });
  });

  it("follows the whisk and the heat of the contents", () => {
    const traces = trace(
      [
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
      ],
      [],
    );
    expect(traces.map((step) => step.after.whisk)).toEqual([true, true, false, false]);
    expect(traces.map((step) => step.after.temperature)).toEqual([20, 90, 20, 100]);
  });

  it("lowers the temperature to the mixing temperature when cold contents go in", () => {
    const traces = trace(
      [
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
      ],
      [],
    );
    expect(traces.map((step) => step.after.temperature)).toEqual([20, 100, 40]);
    expect(mixedTemperature(0, 100, 50, 20)).toBe(20);
    expect(mixedTemperature(100, 90, 0, 20)).toBe(90);
  });

  it("reports the temperature a step heats to", () => {
    expect(stepTemperature({ kind: "steaming", title: "x", minutes: 1, seconds: 0 })).toBe(100);
    expect(stepTemperature({ kind: "puree", title: "x", minutes: 1, seconds: 0 })).toBe(0);
  });
});
