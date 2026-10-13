import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseDeviceLimits, type DeviceLimits } from "./limits.js";
import { validateRecipeInput, type ValidateOptions } from "./validate.js";

type Json = Record<string, unknown>;
type Knowledge = {
  modes: { id: string; effective: Json; params: Record<string, { effective: Json }> }[];
  recipeLimits: Record<string, Record<string, Record<string, Json>>>;
};

const read = (url: URL) => JSON.parse(readFileSync(url, "utf8")) as unknown;
const knowledge = read(
  new URL("../../knowledge/device-programs.json", import.meta.url),
) as Knowledge;
const sampleRecipe = read(
  new URL("../../test/fixtures/recipe/all-modes.recipe-input.json", import.meta.url),
);

const sample = () => structuredClone(sampleRecipe) as Json;
const serving = (recipe: Json) => recipe.servingSize as Json;
const steps = (recipe: Json) => serving(recipe).steps as Json[];

// Index of the first customized step in the sample; replaced by the step under test.
const AT = 2;
const PATH = `servingSize.steps[${AT}]`;

function withStep(step: Json): Json {
  const recipe = sample();
  steps(recipe)[AT] = step;
  return recipe;
}

const customized = (over: Json = {}): Json => ({
  kind: "customized",
  title: "Kochen",
  temperature: 100,
  minutes: 5,
  seconds: 0,
  speed: 1,
  rotation: "right",
  ...over,
});
const timed = (kind: string, minutes: number, seconds: number, over: Json = {}): Json => ({
  kind,
  title: "Programm",
  minutes,
  seconds,
  ...over,
});
const heated = (kind: string, temperature: number, minutes: number, seconds = 0): Json =>
  timed(kind, minutes, seconds, { temperature });

function limitsWith(mutate: (k: Knowledge) => void): DeviceLimits {
  const copy = structuredClone(knowledge);
  mutate(copy);
  return parseDeviceLimits(copy);
}

const modeOf = (k: Knowledge, id: string) => {
  const mode = k.modes.find((m) => m.id === id);
  if (!mode) throw new Error(`no mode ${id}`);
  return mode;
};

let limits: DeviceLimits;
beforeAll(() => {
  limits = parseDeviceLimits(knowledge);
});

function check(recipe: unknown, options?: ValidateOptions, custom?: DeviceLimits) {
  return validateRecipeInput(recipe, custom ?? limits, options);
}

describe("validateRecipeInput", () => {
  it("accepts the all-modes sample and returns the parsed recipe", () => {
    const result = check(sample());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.recipe?.servingSize.steps).toHaveLength(20);
  });

  // Each rule: a step that breaks it (path and message of the error) and one that passes.
  it.each<[string, Json, string, RegExp, Json]>([
    [
      "customized temperature grid",
      customized({ temperature: 102 }),
      "temperature",
      /^temperature 102 °C is not available for customized; allowed: 0 °C, 37 °C, 40 °C, 45 °C,.* 130 °C$/,
      customized({ temperature: 105 }),
    ],
    [
      "customized temperature above 130",
      customized({ temperature: 135 }),
      "temperature",
      /135 °C is not available/,
      customized({ temperature: 130 }),
    ],
    [
      "slow cooking grid",
      heated("slow_cooking", 97, 30),
      "temperature",
      /97 °C is not available for slow_cooking/,
      heated("slow_cooking", 95, 30),
    ],
    [
      "fermentation grid",
      heated("fermentation", 70, 60),
      "temperature",
      /70 °C is not available for fermentation/,
      heated("fermentation", 65, 60),
    ],
    [
      "sous-vide minimum",
      heated("sous_vide", 39, 60),
      "temperature",
      /temperature 39 °C is below the minimum of 40 °C for sous_vide/,
      heated("sous_vide", 40, 60),
    ],
    [
      "sous-vide maximum",
      heated("sous_vide", 86, 60),
      "temperature",
      /temperature 86 °C is above the maximum of 85 °C/,
      heated("sous_vide", 61, 60),
    ],
    [
      "roasting only 100-130 °C",
      heated("roasting", 95, 3),
      "temperature",
      /95 °C is not available for roasting; allowed: 100 °C, 105 °C/,
      heated("roasting", 100, 3),
    ],
    [
      "sous-vide whole minutes",
      heated("sous_vide", 60, 15, 30),
      "seconds",
      /^sous_vide runs in whole minutes; set seconds to 0 \(time is 15 min 30 s\)$/,
      heated("sous_vide", 60, 16),
    ],
    [
      "slow cooking whole minutes",
      heated("slow_cooking", 90, 30, 1),
      "seconds",
      /slow_cooking runs in whole minutes/,
      heated("slow_cooking", 90, 30),
    ],
    [
      "fermentation whole minutes",
      heated("fermentation", 40, 45, 59),
      "seconds",
      /fermentation runs in whole minutes/,
      heated("fermentation", 40, 45),
    ],
    [
      "speed with heat",
      customized({ speed: 4 }),
      "speed",
      /^speed 4 is above the maximum of 3 for customized when temperature is not 0 °C$/,
      customized({ speed: 3 }),
    ],
    [
      "speed in reverse",
      customized({ temperature: 0, minutes: 1, speed: 4, rotation: "left" }),
      "speed",
      /speed 4 is above the maximum of 3 for customized when rotation is left/,
      customized({ temperature: 0, minutes: 1, speed: 4 }),
    ],
    [
      "speed zero",
      customized({ temperature: 0, speed: 0 }),
      "speed",
      /speed 0 is below the minimum of 1 for customized/,
      customized({ temperature: 0, speed: 1 }),
    ],
    [
      "speed eleven",
      customized({ temperature: 0, minutes: 0, seconds: 20, speed: 11 }),
      "speed",
      /speed 11 is above the maximum of 10/,
      customized({ temperature: 0, minutes: 0, seconds: 20, speed: 10 }),
    ],
    [
      "high speed at most 10 minutes",
      customized({ temperature: 0, minutes: 11, speed: 6 }),
      "minutes",
      /^time 11 min is above the maximum of 10 min for customized when speed is at least 6$/,
      customized({ temperature: 0, minutes: 10, speed: 6 }),
    ],
    [
      "customized minimum time",
      customized({ minutes: 0, seconds: 0 }),
      "minutes",
      /time 0 s is below the minimum of 1 s for customized/,
      customized({ minutes: 0, seconds: 1 }),
    ],
    [
      "customized maximum time",
      customized({ minutes: 99, seconds: 1 }),
      "minutes",
      /time 99 min 1 s is above the maximum of 99 min/,
      customized({ minutes: 99 }),
    ],
    [
      "puree time",
      timed("puree", 0, 20),
      "minutes",
      /time 20 s is below the minimum of 30 s for puree/,
      timed("puree", 0, 30),
    ],
    [
      "smoothie time",
      timed("smoothie", 2, 1),
      "minutes",
      /above the maximum of 2 min for smoothie/,
      timed("smoothie", 2, 0),
    ],
    [
      "turbo maximum",
      { kind: "turbo", title: "Turbo", description: "Zerkleinern.", seconds: 21 },
      "seconds",
      /time 21 s is above the maximum of 20 s for turbo/,
      { kind: "turbo", title: "Turbo", description: "Zerkleinern.", seconds: 20 },
    ],
    [
      "turbo minimum",
      { kind: "turbo", title: "Turbo", description: "Zerkleinern.", seconds: 0 },
      "seconds",
      /below the minimum of 1 s for turbo/,
      { kind: "turbo", title: "Turbo", description: "Zerkleinern.", seconds: 1 },
    ],
    [
      "firm dough time",
      timed("kneading_solid_dough", 0, 44),
      "minutes",
      /below the minimum of 45 s/,
      timed("kneading_solid_dough", 4, 0),
    ],
    [
      "liquid dough time",
      timed("kneading_liquid_dough", 6, 1),
      "minutes",
      /above the maximum of 6 min for kneading_liquid_dough/,
      timed("kneading_liquid_dough", 6, 0),
    ],
    [
      "rice time",
      timed("rice_cooking", 19, 59),
      "minutes",
      /below the minimum of 20 min for rice_cooking/,
      timed("rice_cooking", 40, 0),
    ],
    [
      "steaming at least 3 minutes",
      timed("steaming", 2, 59),
      "minutes",
      /time 2 min 59 s is below the minimum of 3 min for steaming/,
      timed("steaming", 3, 0),
    ],
    [
      "steaming at most 60 minutes",
      timed("steaming", 60, 1),
      "minutes",
      /above the maximum of 60 min/,
      timed("steaming", 60, 0),
    ],
    [
      "roasting at least 1 minute",
      heated("roasting", 120, 0, 30),
      "minutes",
      /time 30 s is below the minimum of 1 min for roasting/,
      heated("roasting", 120, 14),
    ],
    [
      "roasting at most 14 minutes",
      heated("roasting", 120, 14, 1),
      "minutes",
      /above the maximum of 14 min/,
      heated("roasting", 130, 1),
    ],
    [
      "scale minimum",
      { kind: "scale", title: "Waage", description: "Mehl abwiegen.", grams: 4 },
      "grams",
      /^grams 4 g is below the minimum of 5 g for scale$/,
      { kind: "scale", title: "Waage", description: "Mehl abwiegen.", grams: 5 },
    ],
    [
      "scale maximum",
      { kind: "scale", title: "Waage", description: "Mehl abwiegen.", grams: 5001 },
      "grams",
      /above the maximum of 5000 g/,
      { kind: "scale", title: "Waage", description: "Mehl abwiegen.", grams: 5000 },
    ],
    [
      "no description on program steps",
      { ...heated("roasting", 120, 3), description: "Anbraten." },
      "description",
      /^roasting steps take no description because the device does not show it; put the instruction into a text step before it$/,
      heated("roasting", 120, 3),
    ],
    [
      "scale needs a description",
      { kind: "scale", title: "Waage", grams: 50 },
      "description",
      /Invalid input/,
      { kind: "scale", title: "Waage", description: "50 g Butter.", grams: 50 },
    ],
    [
      "text needs a description",
      { kind: "text", title: "Hinweis", description: "" },
      "description",
      /step description must not be empty/,
      { kind: "text", title: "Hinweis", description: "Abkühlen lassen." },
    ],
    [
      "step title length",
      customized({ title: "x".repeat(81) }),
      "title",
      /^step title has 81 characters; at most 80 are allowed$/,
      customized({ title: "x".repeat(80) }),
    ],
    // The butterfly whisk caps the speed of manual cooking at 4 (official guide).
    [
      "speed with the butterfly whisk",
      customized({ temperature: 0, minutes: 1, speed: 5, accessory: "butterfly_whisk" }),
      "speed",
      /^speed 5 is above the maximum of 4 for customized when the butterfly whisk is fitted$/,
      customized({ temperature: 0, minutes: 1, speed: 4, accessory: "butterfly_whisk" }),
    ],
    [
      "speed without the butterfly whisk",
      customized({ temperature: 0, minutes: 1, speed: 11 }),
      "speed",
      /speed 11 is above the maximum of 10 for customized$/,
      customized({ temperature: 0, minutes: 1, speed: 8 }),
    ],
    // Time ranges of the knowledge file, one step past and exactly on each bound.
    [
      "sous-vide minimum time",
      heated("sous_vide", 60, 14),
      "minutes",
      /^time 14 min is below the minimum of 15 min for sous_vide$/,
      heated("sous_vide", 60, 15),
    ],
    [
      "sous-vide maximum time",
      heated("sous_vide", 60, 721),
      "minutes",
      /^time 721 min is above the maximum of 720 min for sous_vide$/,
      heated("sous_vide", 60, 720),
    ],
    [
      "slow cooking minimum time",
      heated("slow_cooking", 95, 14),
      "minutes",
      /^time 14 min is below the minimum of 15 min for slow_cooking$/,
      heated("slow_cooking", 95, 15),
    ],
    [
      "slow cooking maximum time",
      heated("slow_cooking", 95, 481),
      "minutes",
      /^time 481 min is above the maximum of 480 min for slow_cooking$/,
      heated("slow_cooking", 95, 480),
    ],
    [
      "fermentation minimum time",
      heated("fermentation", 40, 29),
      "minutes",
      /^time 29 min is below the minimum of 30 min for fermentation$/,
      heated("fermentation", 40, 30),
    ],
    [
      "fermentation maximum time",
      heated("fermentation", 40, 721),
      "minutes",
      /^time 721 min is above the maximum of 720 min for fermentation$/,
      heated("fermentation", 40, 720),
    ],
    [
      "soft dough minimum time",
      timed("kneading_soft_dough", 0, 44),
      "minutes",
      /^time 44 s is below the minimum of 45 s for kneading_soft_dough$/,
      timed("kneading_soft_dough", 0, 45),
    ],
    [
      "soft dough maximum time",
      timed("kneading_soft_dough", 4, 1),
      "minutes",
      /^time 4 min 1 s is above the maximum of 4 min for kneading_soft_dough$/,
      timed("kneading_soft_dough", 4, 0),
    ],
    [
      "firm dough maximum time",
      timed("kneading_solid_dough", 4, 1),
      "minutes",
      /^time 4 min 1 s is above the maximum of 4 min for kneading_solid_dough$/,
      timed("kneading_solid_dough", 0, 45),
    ],
    [
      "rice maximum time",
      timed("rice_cooking", 40, 1),
      "minutes",
      /^time 40 min 1 s is above the maximum of 40 min for rice_cooking$/,
      timed("rice_cooking", 20, 0),
    ],
    [
      "unknown program",
      { kind: "kneading", title: "Kneten", minutes: 1, seconds: 0 },
      "kind",
      /^unknown step kind; use one of: text, customized,/,
      timed("kneading_soft_dough", 1, 0),
    ],
  ])("%s", (_rule, failing, field, message, passing) => {
    const bad = check(withStep(failing));
    expect(bad.ok).toBe(false);
    expect(bad.recipe).toBeNull();
    expect(bad.errors).toContainEqual({
      path: `${PATH}.${field}`,
      message: expect.stringMatching(message) as unknown,
    });
    expect(check(withStep(passing)).errors).toEqual([]);
  });

  it("allows the food processor only with the attachment", () => {
    const recipe = withStep(timed("food_processor", 1, 0));
    expect(check(recipe).errors).toEqual([
      {
        path: `${PATH}.kind`,
        message:
          "food_processor needs the food processor attachment, which this installation does not have; use another program",
      },
    ]);
    expect(check(recipe, { attachments: ["food_processor_attachment"] }).ok).toBe(true);
  });

  it.each<[number, number, string | null]>([
    [0, 0, "time 0 s is below the minimum of 1 s for food_processor"],
    [0, 1, null],
    [5, 0, null],
    [5, 1, "time 5 min 1 s is above the maximum of 5 min for food_processor"],
  ])("checks the food processor time %i min %i s", (minutes, seconds, message) => {
    const recipe = withStep(timed("food_processor", minutes, seconds));
    const errors = check(recipe, { attachments: ["food_processor_attachment"] }).errors;
    expect(errors).toEqual(message ? [{ path: `${PATH}.minutes`, message }] : []);
  });

  it("accepts the butterfly whisk only on manual cooking", () => {
    const recipe = withStep({ ...timed("steaming", 5, 0), accessory: "butterfly_whisk" });
    expect(check(recipe).errors).toEqual([
      { path: `${PATH}.accessory`, message: "unknown field accessory" },
    ]);
  });

  it("checks categories against the live catalog when one is given", () => {
    expect(check(sample(), { knownCategoryIds: [228, 260] }).ok).toBe(true);
    expect(check(sample(), { knownCategoryIds: new Set([260, 220]) }).errors).toEqual([
      { path: "categoryIds[0]", message: "category 228 does not exist; known ids: 220, 260" },
    ]);
  });

  it("reports schema errors and device errors of well-formed steps in one round", () => {
    const recipe = sample();
    recipe.title = "x".repeat(87);
    steps(recipe)[0] = { kind: "text", title: "Leer" };
    steps(recipe)[AT] = customized({ speed: 5 });
    steps(recipe)[4] = heated("roasting", 140, 3);
    const result = check(recipe);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual([
      "servingSize.steps[0].description",
      "title",
      `${PATH}.speed`,
      "servingSize.steps[4].temperature",
    ]);
  });

  it("does not repeat a recipe limit on a field the schema already rejected", () => {
    const recipe = sample();
    serving(recipe).amount = 2.5;
    steps(recipe)[0] = { kind: "text", title: "Leer" };
    expect(check(recipe).errors.map((error) => error.path)).toEqual([
      "servingSize.amount",
      "servingSize.steps[0].description",
    ]);
  });

  it("does not run device rules on a step that already has schema errors", () => {
    const result = check(withStep(customized({ speed: 5, seconds: 61 })));
    expect(result.errors).toEqual([
      {
        path: `${PATH}.seconds`,
        message: "seconds must be at most 59; carry full minutes into minutes",
      },
    ]);
  });

  it("names unknown fields", () => {
    const recipe = sample();
    recipe.status = "publish";
    serving(recipe).maxServing = 4;
    expect(check(recipe).errors).toEqual([
      { path: "servingSize.maxServing", message: "unknown field maxServing" },
      { path: "status", message: "unknown field status" },
    ]);
  });

  it("explains input that is not a recipe", () => {
    expect(check(null).errors).toEqual([
      { path: "(recipe)", message: expect.stringContaining("expected object") as unknown },
    ]);
    expect(check({ ...sample(), servingSize: { steps: "none" } }).ok).toBe(false);
  });

  it("reports several unknown fields together", () => {
    const recipe = withStep({ ...customized(), foo: 1, bar: 2 });
    expect(check(recipe).errors).toEqual([{ path: PATH, message: "unknown field foo, bar" }]);
  });
});

describe("recipe limits of the knowledge file", () => {
  const firstStep = (recipe: Json) => steps(recipe)[0] as Json;

  // Each case breaks one limit and then sits exactly on it.
  it.each<[string, (r: Json) => void, string, string, (r: Json) => void]>([
    [
      "empty title",
      (r) => (r.title = ""),
      "title",
      "title must not be empty",
      (r) => (r.title = "x"),
    ],
    [
      "title over 86",
      (r) => (r.title = "x".repeat(87)),
      "title",
      "title has 87 characters; at most 86 are allowed",
      (r) => (r.title = "x".repeat(86)),
    ],
    [
      "description over 240",
      (r) => (r.description = "x".repeat(241)),
      "description",
      "description has 241 characters; at most 240 are allowed",
      (r) => (r.description = "x".repeat(240)),
    ],
    [
      "no category",
      (r) => (r.categoryIds = []),
      "categoryIds",
      "pick 1 to 8 categories, not 0",
      (r) => (r.categoryIds = [1]),
    ],
    [
      "nine categories",
      (r) => (r.categoryIds = [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      "categoryIds",
      "pick 1 to 8 categories, not 9",
      (r) => (r.categoryIds = [1, 2, 3, 4, 5, 6, 7, 8]),
    ],
    [
      "unknown nutrient",
      (r) => (r.nutrients = [{ name: "iron", amount: 1 }]),
      "nutrients[0].name",
      "nutrient iron is not supported; use one of calories, carbohydrate, fat, protein, saturates, sugar, salt, roughage",
      (r) => (r.nutrients = [{ name: "sugar", amount: 1 }]),
    ],
    [
      "nutrient amount",
      (r) => (r.nutrients = [{ name: "fat", amount: 100000 }]),
      "nutrients[0].amount",
      "fat 100000 is above the maximum of 99999",
      (r) => (r.nutrients = [{ name: "fat", amount: 99999 }]),
    ],
    [
      "zero servings",
      (r) => (serving(r).amount = 0),
      "servingSize.amount",
      "servings 0 is below the minimum of 1",
      (r) => (serving(r).amount = 1),
    ],
    [
      "101 servings",
      (r) => (serving(r).amount = 101),
      "servingSize.amount",
      "servings 101 is above the maximum of 100",
      (r) => (serving(r).amount = 100),
    ],
    [
      "preparation 0",
      (r) => (serving(r).preparationTime = 0),
      "servingSize.preparationTime",
      "preparationTime 0 min is below the minimum of 1 min",
      (r) => (serving(r).preparationTime = 1),
    ],
    [
      "preparation 1441",
      (r) => Object.assign(serving(r), { preparationTime: 1441, readyInTime: 1441 }),
      "servingSize.preparationTime",
      "preparationTime 1441 min is above the maximum of 1440 min",
      (r) => Object.assign(serving(r), { preparationTime: 1440, readyInTime: 1440 }),
    ],
    [
      "ready 18001",
      (r) => (serving(r).readyInTime = 18001),
      "servingSize.readyInTime",
      "readyInTime 18001 min is above the maximum of 18000 min",
      (r) => (serving(r).readyInTime = 18000),
    ],
    [
      "long step title",
      (r) => (firstStep(r).title = "x".repeat(81)),
      "servingSize.steps[0].title",
      "step title has 81 characters; at most 80 are allowed",
      (r) => (firstStep(r).title = "x".repeat(80)),
    ],
    [
      "empty text step",
      (r) => (firstStep(r).description = ""),
      "servingSize.steps[0].description",
      "step description must not be empty",
      (r) => (firstStep(r).description = "x"),
    ],
    [
      "long text step",
      (r) => (firstStep(r).description = "x".repeat(241)),
      "servingSize.steps[0].description",
      "step description has 241 characters; at most 240 are allowed",
      (r) => (firstStep(r).description = "x".repeat(240)),
    ],
  ])("%s", (_name, breakIt, path, message, fixIt) => {
    const bad = sample();
    breakIt(bad);
    expect(check(bad).errors).toEqual([{ path, message }]);
    const good = sample();
    fixIt(good);
    expect(check(good).errors).toEqual([]);
  });
});

describe("limits come from the knowledge file", () => {
  it("enforces stricter recipe limits than the schema", () => {
    const strict = limitsWith((k) => {
      const r = k.recipeLimits;
      Object.assign(r.text!.recipeTitle!.effective!, { maxLength: 10 });
      Object.assign(r.text!.recipeDescription!.effective!, { maxLength: 10 });
      Object.assign(r.text!.stepTitle!.effective!, { minLength: 2, maxLength: 20 });
      Object.assign(r.text!.stepDescription!.effective!, { minLength: 5, maxLength: 30 });
      Object.assign(r.servings!.amount!.effective!, { max: 3, step: 1 });
      Object.assign(r.categories!.effective!, { max: 0 });
      Object.assign(r.times!.preparationTime!.effective!, { min: 10 });
      Object.assign(r.times!.readyInTime!.effective!, { max: 100 });
      Object.assign(r.nutrients!.effective!, { max: 299, names: ["calories", "fat", "protein"] });
    });
    const recipe = sample();
    steps(recipe)[3] = { kind: "text", title: "Z", description: "Zwie" };
    const messages = check(recipe, {}, strict).errors.map(
      (error) => `${error.path}: ${error.message}`,
    );
    expect(messages).toEqual([
      "title: title has 21 characters; at most 10 are allowed",
      "description: description has 86 characters; at most 10 are allowed",
      "servingSize.amount: servings 4 is above the maximum of 3",
      "servingSize.preparationTime: preparationTime 5 min is below the minimum of 10 min",
      "servingSize.readyInTime: readyInTime 130 min is above the maximum of 100 min",
      "categoryIds: pick 1 to 0 categories, not 1",
      "nutrients[0].amount: calories 300 is above the maximum of 299",
      "nutrients[1].name: nutrient carbohydrate is not supported; use one of calories, fat, protein",
      "servingSize.steps[0].description: step description has 38 characters; at most 30 are allowed",
      "servingSize.steps[2].title: step title has 24 characters; at most 20 are allowed",
      "servingSize.steps[3].title: step title needs at least 2 characters",
      "servingSize.steps[3].description: step description needs at least 5 characters",
      "servingSize.steps[7].title: step title has 21 characters; at most 20 are allowed",
      "servingSize.steps[11].description: step description has 31 characters; at most 30 are allowed",
      "servingSize.steps[12].title: step title has 26 characters; at most 20 are allowed",
      "servingSize.steps[19].description: step description has 45 characters; at most 30 are allowed",
    ]);
  });

  it("checks the serving step", () => {
    const even = limitsWith((k) =>
      Object.assign(k.recipeLimits.servings!.amount!.effective!, { step: 2 }),
    );
    const recipe = sample();
    serving(recipe).amount = 3;
    expect(check(recipe, {}, even).errors).toEqual([
      { path: "servingSize.amount", message: "servings must be a multiple of 2" },
    ]);
  });

  it("follows the steps that need a description", () => {
    const textOnly = limitsWith((k) => {
      Object.assign(k.recipeLimits.text!.stepDescription!.effective!, {
        requiredOn: ["text", "turbo", "roasting"],
      });
      Object.assign(modeOf(k, "scale"), { stepDescription: "cleared" });
      Object.assign(modeOf(k, "roasting"), { stepDescription: "required" });
    });
    const errors = check(sample(), {}, textOnly).errors;
    expect(errors).toContainEqual({
      path: "servingSize.steps[1].description",
      message: "scale steps take no description because the device does not show it",
    });
    expect(errors).toContainEqual({
      path: "servingSize.steps[4].description",
      message: "roasting steps need a description of 1-240 characters",
    });
  });

  it("refuses programs the knowledge file does not allow or does not know", () => {
    const changed = limitsWith((k) => {
      Object.assign(modeOf(k, "kneading_soft_dough").effective, {
        allowed: false,
        reason: "Untested.",
      });
      Object.assign(modeOf(k, "kneading_solid_dough").effective, {
        allowed: false,
        reason: undefined,
      });
      k.modes = k.modes.filter((mode) => mode.id !== "smoothie");
    });
    expect(check(sample(), {}, changed).errors).toEqual([
      { path: "servingSize.steps[5].kind", message: "kneading_solid_dough is not allowed" },
      {
        path: "servingSize.steps[6].kind",
        message: "kneading_soft_dough is not allowed: Untested.",
      },
      {
        path: "servingSize.steps[10].kind",
        message: "the knowledge file has no limits for smoothie, so the step cannot be checked",
      },
    ]);
  });

  it("checks enumerations against the knowledge file", () => {
    const narrow = limitsWith((k) => {
      modeOf(k, "cooking_eggs").params.size!.effective.values = ["medium", "large"];
    });
    const recipe = withStep({
      kind: "cooking_eggs",
      title: "Eier",
      size: "small",
      texture: "soft",
    });
    expect(check(recipe, {}, narrow).errors).toEqual([
      {
        path: `${PATH}.size`,
        message: "size small is not available for cooking_eggs; allowed: medium, large",
      },
    ]);
  });

  it("evaluates conditions generically", () => {
    const conditional = limitsWith((k) => {
      const time = modeOf(k, "roasting").params.time!.effective;
      time.conditions = [
        { when: { temperature: { gte: 130 } }, set: { min: 120 }, kind: "sanity" },
        { when: { temperature: { lt: 110 } }, set: { max: 300 }, kind: "sanity" },
        { when: { temperature: { lte: 115, gt: 105 } }, set: { max: 400 }, kind: "sanity" },
        { when: { temperature: { eq: 120 } }, set: { max: 500 }, kind: "sanity" },
      ];
      modeOf(k, "scale").params.weight!.effective.step = 5;
    });
    const roast = (temperature: number, minutes: number) =>
      check(withStep(heated("roasting", temperature, minutes)), {}, conditional).errors.map(
        (e) => e.message,
      );
    expect(roast(130, 1)).toEqual([
      "time 1 min is below the minimum of 2 min for roasting when temperature is at least 130 °C",
    ]);
    expect(roast(105, 6)).toEqual([
      "time 6 min is above the maximum of 5 min for roasting when temperature is below 110 °C",
    ]);
    expect(roast(110, 7)).toEqual([
      "time 7 min is above the maximum of 6 min 40 s for roasting when temperature is at most 115 °C and temperature is above 105 °C",
    ]);
    expect(roast(120, 9)).toEqual([
      "time 9 min is above the maximum of 8 min 20 s for roasting when temperature is 120 °C",
    ]);
    expect(roast(125, 14)).toEqual([]);
    const weigh = check(
      withStep({ kind: "scale", title: "Waage", description: "Mehl.", grams: 7 }),
      {},
      conditional,
    );
    expect(weigh.errors).toEqual([
      { path: `${PATH}.grams`, message: "grams must be a multiple of 5 g for scale" },
    ]);
  });
});
