import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedIngredient } from "../ingredients/index.js";
import { loadDeviceLimits } from "../recipe/limits.js";
import { RecipeInputSchema, type RecipeInput, type RecipeStep } from "../recipe/schema.js";
import { loadKnowledge } from "./knowledge.js";
import {
  SANITY_RULES,
  amountBalanceRule,
  bowlMaxFoamingRule,
  bowlMaxRule,
  checkSanity,
  duplicateAdditionRule,
  flourRule,
  heatUpRule,
  ingredientListedRule,
  ingredientReferencedRule,
  machineStepDescriptionRule,
  parseListAmount,
  servingsRule,
  steamingWaterRule,
  tMinSeconds,
  temperatureConventionRule,
  textBeforeMachineStepRule,
  turboRule,
  whiskRule,
  type SanityRule,
} from "./sanity.js";

const knowledge = await loadKnowledge(fileURLToPath(new URL("../../knowledge", import.meta.url)));
const limits = await loadDeviceLimits(
  fileURLToPath(new URL("../../knowledge/device-programs.json", import.meta.url)),
);

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

type ListEntry = RecipeInput["servingSize"]["ingredientGroups"][number]["ingredients"][number];

const recipeWith = (steps: RecipeStep[], list: ListEntry[] = []): RecipeInput => ({
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
      {
        name: "",
        ingredients:
          list.length > 0 ? list : [{ name: "Wasser", amount: 1, unit: "g", isOptional: false }],
      },
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
const manual = (
  temperature: number,
  seconds: number,
  speed: number,
  extra: Partial<Extract<RecipeStep, { kind: "customized" }>> = {},
): RecipeStep => ({
  kind: "customized",
  title: "Kochen",
  temperature,
  minutes: Math.floor(seconds / 60),
  seconds: seconds % 60,
  speed,
  rotation: "right",
  ...extra,
});
const turbo: RecipeStep = { kind: "turbo", title: "Turbo", description: "Turbo 2 s", seconds: 2 };

function run(
  rule: SanityRule,
  steps: RecipeStep[],
  ingredients: NormalizedIngredient[] = [],
  options: { list?: ListEntry[]; servings?: number } = {},
) {
  return checkSanity(
    recipeWith(steps, options.list),
    { servings: options.servings ?? 4, ingredients },
    knowledge,
    limits,
    [rule],
  );
}

describe("tMinSeconds", () => {
  it("follows the timing model and stops at the boiling point", () => {
    const c = knowledge.timing.constants;
    expect(tMinSeconds(1000, 100, c)).toBeCloseTo(457.1, 1);
    expect(tMinSeconds(1000, 120, c)).toBeCloseTo(457.1, 1);
    expect(tMinSeconds(1000, 20, c)).toBe(0);
    expect(tMinSeconds(0, 100, c)).toBe(0);
  });
});

describe("heat_up", () => {
  const water = [scale(1500, "Wasser"), text("Deckel schließen.")];

  it("rejects a first heating far below the physical minimum", () => {
    const { errors } = run(heatUpRule, [...water, manual(100, 180, 1)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("servingSize.steps[2].minutes");
    expect(errors[0]?.message).toContain("1500 g");
  });

  it("warns close to the minimum and accepts enough time", () => {
    expect(run(heatUpRule, [...water, manual(100, 420, 1)]).warnings).toHaveLength(1);
    expect(run(heatUpRule, [...water, manual(100, 900, 1)])).toEqual({ errors: [], warnings: [] });
  });

  it("skips contents that are still hot and low temperatures", () => {
    const hot = [...water, manual(100, 900, 1), scale(50, "Wasser"), manual(100, 60, 1)];
    expect(run(heatUpRule, hot)).toEqual({ errors: [], warnings: [] });
    expect(run(heatUpRule, [...water, manual(60, 60, 1)]).errors).toEqual([]);
  });

  it("checks the heating after cold stock was added to sautéed onions", () => {
    const soup = [
      ingredient("Zwiebeln", 100, "g"),
      ingredient("Öl", 20, "g"),
      ingredient("Gemüsebrühe", 1500, "g"),
      ingredient("Karotten", 500, "g"),
    ];
    const steps = [
      scale(100, "Zwiebeln"),
      scale(20, "Öl"),
      manual(120, 180, 1, { title: "Andünsten" }),
      scale(1500, "Gemüsebrühe"),
      scale(500, "Karotten"),
      manual(100, 180, 1),
    ];
    const { errors } = run(heatUpRule, steps, soup);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("servingSize.steps[5].minutes");
    expect(errors[0]?.message).toContain("2120 g from about 26 °C");
    // The suggested duration is never below the physical minimum it states.
    const minimum = Number(/at least (\d+) s/.exec(errors[0]?.message ?? "")?.[1]);
    const suggested = Number(/at least (\d+) min/.exec(errors[0]?.message ?? "")?.[1]);
    expect(suggested * 60).toBeGreaterThanOrEqual(minimum);
    expect(errors[0]?.message).toContain("about 2.3 times the minimum");
  });

  it("says when part of the mass is unknown", () => {
    const { warnings } = run(
      heatUpRule,
      [text("Rosinen und 100 g Wasser in den Mixbehälter geben."), manual(100, 600, 1)],
      [ingredient("Rosinen", 1, "Handvoll")],
    );
    expect(warnings[0]).toMatch(
      /^Step 2 \(customized\): the heat-up time was checked against 100 g/,
    );
  });
});

describe("bowl_max and bowl_max_foaming", () => {
  it("rejects more than 3000 g once per fill", () => {
    const { errors } = run(bowlMaxRule, [scale(2000, "Wasser"), scale(1200, "Wasser"), text("x")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("servingSize.steps[1]");
  });

  it("accepts the same amount in two batches", () => {
    const steps = [scale(2000, "Wasser"), text("Alles umfüllen."), scale(1200, "Wasser")];
    expect(run(bowlMaxRule, steps).errors).toEqual([]);
  });

  it("warns about heating more than 2500 g of foaming contents", () => {
    const milk = [scale(2600, "Milch"), text("Messbecher einsetzen."), manual(90, 600, 2)];
    expect(run(bowlMaxFoamingRule, milk).warnings).toHaveLength(1);
    const water = [scale(2600, "Wasser"), text("Messbecher einsetzen."), manual(90, 600, 2)];
    expect(run(bowlMaxFoamingRule, water).warnings).toEqual([]);
  });
});

describe("turbo_limits", () => {
  it("rejects turbo with too much in the bowl", () => {
    const { errors } = run(turboRule, [scale(2600, "Wasser"), turbo]);
    expect(errors[0]?.message).toContain("2500 g");
  });

  it("rejects turbo on hot contents until they cooled", () => {
    expect(run(turboRule, [manual(100, 600, 1), text("Weiter."), turbo]).errors).toHaveLength(1);
    const cooled = [manual(100, 600, 1), text("Etwas abkühlen lassen."), turbo];
    expect(run(turboRule, cooled).errors).toEqual([]);
  });
});

describe("whisk", () => {
  it("rejects speed above 4 with the accessory field or a fitted whisk", () => {
    const field = run(whiskRule, [manual(0, 60, 5, { accessory: "butterfly_whisk" })]);
    expect(field.errors[0]?.path).toBe("servingSize.steps[0].speed");
    expect(run(whiskRule, [text("Rühraufsatz einsetzen."), manual(0, 10, 6)]).errors).toHaveLength(
      1,
    );
  });

  it("accepts higher speeds after the whisk is removed and rejects turbo while it is fitted", () => {
    const removed = [
      text("Rühraufsatz einsetzen."),
      text("Rühraufsatz entfernen."),
      manual(0, 10, 6),
    ];
    expect(run(whiskRule, removed).errors).toEqual([]);
    expect(run(whiskRule, [text("Rühraufsatz einsetzen."), turbo]).errors).toHaveLength(1);
  });
});

describe("flour_max_per_knead", () => {
  const knead: RecipeStep = {
    kind: "kneading_solid_dough",
    title: "Kneten",
    minutes: 2,
    seconds: 0,
  };

  it("rejects more than 1000 g flour for one kneading step", () => {
    expect(run(flourRule, [scale(1200, "Mehl"), knead]).errors).toHaveLength(1);
    expect(run(flourRule, [scale(800, "Weizenmehl"), knead]).errors).toEqual([]);
  });
});

describe("steaming_liquid_min", () => {
  const steam: RecipeStep = { kind: "steaming", title: "Dampfgaren", minutes: 15, seconds: 0 };

  it("needs 500 g water or stock in the bowl", () => {
    expect(run(steamingWaterRule, [text("Dampfgaraufsatz aufsetzen."), steam]).errors).toHaveLength(
      1,
    );
    expect(run(steamingWaterRule, [scale(1000, "Wasser"), steam]).errors).toEqual([]);
    expect(run(steamingWaterRule, [scale(300, "Gemüsebrühe"), steam]).errors).toHaveLength(1);
  });

  it("skips the check when the water has no amount", () => {
    expect(run(steamingWaterRule, [text("Wasser einfüllen."), steam]).errors).toEqual([]);
  });
});

describe("text_before_machine_step", () => {
  it("rejects a working step without a step that tells the cook what to do", () => {
    const { errors } = run(textBeforeMachineStepRule, [manual(0, 10, 5)]);
    expect(errors[0]?.path).toBe("servingSize.steps[0]");
    const mixed = [text("x"), manual(0, 10, 5), manual(100, 300, 1, { title: "Kochen" })];
    expect(run(textBeforeMachineStepRule, mixed).errors).toEqual([]);
    const different = [
      text("x"),
      manual(0, 10, 5),
      { kind: "puree", title: "P", minutes: 1, seconds: 0 } as RecipeStep,
    ];
    expect(run(textBeforeMachineStepRule, different).errors).toHaveLength(1);
  });

  it("accepts scale steps before and turbo steps anywhere", () => {
    const steps = [scale(100, "Wasser"), manual(0, 10, 5), turbo];
    expect(run(textBeforeMachineStepRule, steps).errors).toEqual([]);
  });
});

describe("ingredient_referenced (translated recipe)", () => {
  it("gives one warning when most ingredients are not named in any step", () => {
    const english = [
      ingredient("pasta", 230, "g"),
      ingredient("red onion", 1, null),
      ingredient("cucumber", 1, null),
    ];
    const { warnings } = run(ingredientReferencedRule, [text("Nudeln kochen.")], english);
    expect(warnings).toEqual([
      "3 of 3 ingredients of the recipe are not named in any step, as in a translated recipe; check that each is used",
    ]);
  });
});

describe("ingredient_referenced", () => {
  it("warns about input ingredients no step names", () => {
    const ingredients = [ingredient("Olivenöl", 2, "EL"), ingredient("Muskatnuss", 1, "Prise")];
    const { warnings } = run(ingredientReferencedRule, [text("Öl erhitzen.")], ingredients);
    expect(warnings).toEqual([
      'The ingredient "Muskatnuss" is not named in any step; check that it is used',
    ]);
  });
});

describe("amount_balance", () => {
  const sahne = [ingredient("Sahne", 200, "g")];

  it("rejects steps that add more than the recipe has", () => {
    const { errors } = run(amountBalanceRule, [scale(400, "Sahne")], sahne);
    expect(errors[0]?.message).toContain('400 g of "Sahne"');
    expect(run(amountBalanceRule, [scale(200, "Sahne")], sahne).errors).toEqual([]);
  });

  it("sums repeated additions in the ingredient's own unit", () => {
    const salt = [ingredient("Salz", 2, "TL")];
    // A text amount may describe an addition counted elsewhere: the cook checks it.
    const twice = [text("2 Tl Salz zugeben."), text("Nochmals 2 Tl Salz zugeben.")];
    const { errors, warnings } = run(amountBalanceRule, twice, salt);
    expect(errors).toEqual([]);
    expect(warnings[0]).toContain('"Salz" may be added more than once');
    expect(run(amountBalanceRule, [text("2 Tl Salz zugeben.")], salt)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("reads a text step's description, not its title as well", () => {
    const eggs = [ingredient("Eier", 4, null)];
    const step: RecipeStep = {
      kind: "text",
      title: "4 Eier zugeben",
      description: "4 Eier aufschlagen und in den Mixbehälter geben.",
    };
    expect(run(amountBalanceRule, [step], eggs)).toEqual({ errors: [], warnings: [] });
  });

  it("counts text amounts only in a clause that adds them to the bowl", () => {
    const ingredients = [
      ingredient("Kartoffeln", 600, "g"),
      ingredient("Nelken", 3, null),
      ingredient("Milch", 30, "g"),
    ];
    const steps = [
      text("600 g Kartoffeln schälen und würfeln."),
      text("Die Zwiebel halbieren."),
      scale(600, "Kartoffeln"),
      text("Die 3 Nelken in den Mixbehälter geben."),
      text("Die 3 Nelken entfernen; 2 Eier hart kochen."),
      scale(30, "Milch"),
      text("Die Brötchen mit den 30 g Milch einpinseln."),
    ];
    expect(run(amountBalanceRule, steps, ingredients)).toEqual({ errors: [], warnings: [] });
  });

  it("does not count text amounts that go into the steamer", () => {
    const broccoli = [ingredient("Brokkoli", 200, "g")];
    const steps = [
      scale(200, "Brokkoli", "in einer Schüssel auf dem Mixbehälter abwiegen"),
      text("Die Zwiebel halbieren."),
      text("200 g Brokkoli in den Dampfgaraufsatz geben."),
    ];
    expect(run(amountBalanceRule, steps, broccoli)).toEqual({ errors: [], warnings: [] });
  });

  it("only warns when a portion set aside goes back in", () => {
    const broth = [ingredient("Gemüsebrühe", 1000, "g")];
    const reused = [
      scale(1000, "Gemüsebrühe"),
      text("Die Brühe durch ein Sieb abgießen und 250 g davon auffangen."),
      scale(250, "Gemüsebrühe", "zurück in den Mixbehälter geben"),
    ];
    const { errors, warnings } = run(amountBalanceRule, reused, broth);
    expect(errors).toEqual([]);
    expect(warnings[0]).toContain("check that a reserved portion is not counted twice");
    const doubled = [scale(1000, "Gemüsebrühe"), text("Rühren."), scale(300, "Gemüsebrühe")];
    expect(run(amountBalanceRule, doubled, broth).errors).toHaveLength(1);
  });

  it("has no upper bound when the recipe allows more", () => {
    const broth = [
      ingredient("Gemüsebrühe", 360, "g", { note: "plus bis zu ½ Tasse mehr zum Verdünnen" }),
    ];
    const steps = [scale(360, "Gemüsebrühe"), text("Rühren."), scale(120, "Gemüsebrühe")];
    expect(run(amountBalanceRule, steps, broth)).toEqual({ errors: [], warnings: [] });
    const fixed = [ingredient("Gemüsebrühe", 360, "g")];
    expect(run(amountBalanceRule, steps, fixed).errors).toHaveLength(1);
  });

  it("skips cups of solids and checks cups of liquids", () => {
    const cheese = [ingredient("vegan parmesan", 1 / 3, "cup")];
    expect(run(amountBalanceRule, [scale(30, "vegan parmesan")], cheese)).toEqual({
      errors: [],
      warnings: [],
    });
    const broth = [ingredient("vegetable broth", 1, "cup")];
    expect(run(amountBalanceRule, [scale(500, "vegetable broth")], broth).errors).toHaveLength(1);
  });

  it("allows rounding to the gram grid and skips amounts in other units", () => {
    expect(
      run(amountBalanceRule, [scale(15, "Butter")], [ingredient("Butter", 12, "g")]).errors,
    ).toEqual([]);
    expect(run(amountBalanceRule, [scale(40, "Öl")], [ingredient("Öl", 2, "EL")]).errors).toEqual(
      [],
    );
    expect(
      run(amountBalanceRule, [scale(500, "Milch")], [ingredient("Milch", 500, "ml")]).errors,
    ).toEqual([]);
  });

  it("does not count a text amount that describes the neighbouring scale step", () => {
    const steps = [text("200 g Sahne einwiegen."), scale(200, "Sahne")];
    expect(run(amountBalanceRule, steps, sahne).errors).toEqual([]);
  });

  it("checks the ingredient list against the input", () => {
    const list: ListEntry[] = [
      { name: "Sahne", amount: "400", unit: "g", isOptional: false },
      { name: "Salz", amount: "", unit: "", isOptional: false },
    ];
    const { errors } = run(
      amountBalanceRule,
      [text("Sahne zugeben.")],
      [...sahne, ingredient("Salz", null, null)],
      { list },
    );
    expect(errors).toEqual([
      expect.objectContaining({ path: "servingSize.ingredientGroups[0].ingredients[0].amount" }),
    ]);
  });

  it("rejects steps that add less than the recipe gives", () => {
    const broth = [ingredient("Gemüsebrühe", 1500, "g")];
    const { errors } = run(amountBalanceRule, [scale(750, "Gemüsebrühe")], broth);
    expect(errors).toEqual([
      expect.objectContaining({
        path: "servingSize.steps[0]",
        message: expect.stringContaining('only 750 g of "Gemüsebrühe"') as unknown,
      }),
    ]);
    expect(run(amountBalanceRule, [scale(1500, "Gemüsebrühe")], broth).errors).toEqual([]);
    // A step that names the ingredient without an amount may add the rest.
    const rest = [scale(750, "Gemüsebrühe"), text("Restliche Gemüsebrühe zugeben.")];
    expect(run(amountBalanceRule, rest, broth).errors).toEqual([]);
  });

  it("rejects an ingredient list that gives less than the recipe", () => {
    const broth = [ingredient("Gemüsebrühe", 1500, "g")];
    const half: ListEntry[] = [
      { name: "Gemüsebrühe", amount: "750", unit: "g", isOptional: false },
    ];
    const { errors } = run(amountBalanceRule, [text("Gemüsebrühe zugeben.")], broth, {
      list: half,
    });
    expect(errors).toEqual([
      expect.objectContaining({
        path: "servingSize.ingredientGroups[0].ingredients[0].amount",
        message: expect.stringContaining("only 750 g") as unknown,
      }),
    ]);
    const split: ListEntry[] = [
      { name: "Gemüsebrühe", amount: "750", unit: "g", isOptional: false },
      { name: "Gemüsebrühe", amount: "750", unit: "g", isOptional: false },
    ];
    expect(
      run(amountBalanceRule, [text("Gemüsebrühe zugeben.")], broth, { list: split }).errors,
    ).toEqual([]);
  });

  it("accepts smaller amounts when the recipe was scaled down to fewer servings", () => {
    const broth = [ingredient("Gemüsebrühe", 3000, "g")];
    expect(
      run(amountBalanceRule, [scale(1500, "Gemüsebrühe")], broth, { servings: 8 }).errors,
    ).toEqual([]);
  });

  it("reads ingredient-list amounts", () => {
    expect(parseListAmount("1 ½")).toBe(1.5);
    expect(parseListAmount("½")).toBe(0.5);
    expect(parseListAmount("1,5")).toBe(1.5);
    expect(parseListAmount("1-2")).toBeNull();
    expect(parseListAmount("")).toBeNull();
  });
});

describe("ingredient_listed", () => {
  const soup = [
    ingredient("Gemüsebrühe", 1500, "g"),
    ingredient("Karotten", 500, "g"),
    ingredient("Zwiebeln", 1, null),
    ingredient("Croûtons", null, null, { optional: true }),
  ];
  const entry = (name: string): ListEntry => ({ name, amount: "1", unit: "", isOptional: false });

  it("rejects a dropped ingredient", () => {
    const list = [entry("Gemüsebrühe"), entry("Zwiebeln")];
    const { errors } = run(ingredientListedRule, [text("x")], soup, { list });
    expect(errors).toEqual([
      expect.objectContaining({
        path: "servingSize.ingredientGroups",
        message: expect.stringContaining('"Karotten"') as unknown,
      }),
    ]);
    const full = [...list, entry("Karotten")];
    expect(run(ingredientListedRule, [text("x")], soup, { list: full })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("only warns when most names differ, as in a translated recipe", () => {
    const english = [
      ingredient("vegetable stock", 1500, "g"),
      ingredient("carrots", 500, "g"),
      ingredient("onion", 1, null),
    ];
    const list = [entry("Gemüsebrühe"), entry("Karotten"), entry("Zwiebeln")];
    const { errors, warnings } = run(ingredientListedRule, [text("x")], english, { list });
    expect(errors).toEqual([]);
    expect(warnings[0]).toContain("3 of 3 ingredients");
  });
});

describe("machine_step_description", () => {
  it("rejects a description on a program that does not show it", () => {
    const step = { ...manual(0, 10, 5), description: "Zerkleinern" } as unknown as RecipeStep;
    const { errors } = run(machineStepDescriptionRule, [text("x"), step]);
    expect(errors[0]?.path).toBe("servingSize.steps[1].description");
    expect(run(machineStepDescriptionRule, [text("x"), turbo]).errors).toEqual([]);
  });
});

describe("temperature_convention", () => {
  it("warns about roasting and sautéing outside the official ranges", () => {
    const roast: RecipeStep = {
      kind: "roasting",
      title: "Anbraten",
      temperature: 100,
      minutes: 3,
      seconds: 0,
    };
    expect(run(temperatureConventionRule, [roast]).warnings[0]).toContain("110-130 °C");
    const good: RecipeStep = { ...roast, temperature: 120 };
    expect(run(temperatureConventionRule, [good]).warnings).toEqual([]);
    // A manual sauté is checked against the manual alternative of saute_onions.
    const saute = manual(130, 300, 1, { title: "Andünsten" });
    expect(run(temperatureConventionRule, [saute]).warnings[0]).toContain("80-120 °C");
    expect(
      run(temperatureConventionRule, [manual(100, 300, 1, { title: "Andünsten" })]).warnings,
    ).toEqual([]);
    expect(
      run(temperatureConventionRule, [manual(130, 300, 1, { title: "Reduzieren" })]).warnings,
    ).toEqual([]);
  });
});

describe("duplicate_addition", () => {
  it("warns about the same amount added twice", () => {
    const steps = [scale(200, "Sahne"), text("Rühren."), scale(200, "Sahne")];
    const { warnings } = run(duplicateAdditionRule, steps, [ingredient("Sahne", 400, "g")]);
    expect(warnings[0]).toContain("steps 1 and 3");
    expect(
      run(
        duplicateAdditionRule,
        [scale(200, "Sahne"), scale(100, "Sahne")],
        [ingredient("Sahne", 300, "g")],
      ).warnings,
    ).toEqual([]);
  });

  it("skips one step that names an amount twice and a portion set aside in between", () => {
    const salt = [ingredient("Salz", 2, "TL")];
    const once = [text("1 Tl Salz zugeben und 1 Tl Salz über die Zwiebeln streuen.")];
    expect(run(duplicateAdditionRule, once, salt).warnings).toEqual([]);
    const parsley = [ingredient("Petersilie", 60, "g")];
    const setAside = [
      scale(30, "Petersilie"),
      text("Umfüllen und beiseitestellen."),
      scale(30, "Petersilie"),
    ];
    expect(run(duplicateAdditionRule, setAside, parsley).warnings).toEqual([]);
  });
});

describe("servings_changed", () => {
  it("warns when the servings differ from the scaled amounts", () => {
    expect(run(servingsRule, [text("x")], [], { servings: 6 }).warnings).toHaveLength(1);
    expect(run(servingsRule, [text("x")], [], { servings: 4 }).warnings).toEqual([]);
  });
});

describe("checkSanity", () => {
  it("finds nothing wrong with a well-formed converted recipe", () => {
    const recipe = RecipeInputSchema.parse(
      JSON.parse(
        readFileSync(
          new URL("../../test/fixtures/convert/soup.recipe-input.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const ingredients = [
      ingredient("Zwiebel", 1, null),
      ingredient("Knoblauch", 2, "Zehe"),
      ingredient("Olivenöl", 2, "EL"),
      ingredient("Hokkaido-Kürbis", 500, "g"),
      ingredient("rote Linsen", 200, "g"),
      ingredient("Gemüsebrühe", 1, "l"),
      ingredient("Salz", null, "Prise"),
      ingredient("Kokosmilch", 150, "ml"),
      ingredient("Koriander", 1, "Bund"),
      ingredient("Kürbiskerne", 30, "g"),
      ingredient("Croûtons", 1, "Handvoll"),
    ];
    expect(checkSanity(recipe, { servings: 4, ingredients }, knowledge, limits)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("runs every rule and keeps each warning once", () => {
    expect(SANITY_RULES.map((rule) => rule.id)).toEqual([
      "heat_up",
      "bowl_max",
      "bowl_max_foaming",
      "turbo_limits",
      "whisk",
      "flour_max_per_knead",
      "steaming_liquid_min",
      "text_before_machine_step",
      "ingredient_listed",
      "ingredient_referenced",
      "amount_balance",
      "machine_step_description",
      "temperature_convention",
      "duplicate_addition",
      "servings_changed",
    ]);
    const twice: SanityRule = {
      id: "twice",
      description: "",
      check: () => [
        { severity: "warning", path: "x", message: "same" },
        { severity: "warning", path: "y", message: "same" },
      ],
    };
    expect(
      checkSanity(recipeWith([text("x")]), { servings: 4, ingredients: [] }, knowledge, limits, [
        twice,
      ]).warnings,
    ).toEqual(["Same"]);
  });
});
