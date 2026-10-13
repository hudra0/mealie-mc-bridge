import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDeviceLimits } from "./limits.js";
import { MACHINE_STEP_KINDS } from "./modes.js";
import { RecipeInputSchema, STEP_KINDS, StepSchema, recipeInputJsonSchema } from "./schema.js";

type Json = Record<string, unknown>;

const sample = (): Json =>
  JSON.parse(
    readFileSync(
      new URL("../../test/fixtures/recipe/all-modes.recipe-input.json", import.meta.url),
      "utf8",
    ),
  ) as Json;

// Small accessors for the mutations below; the sample's shape is known.
const serving = (recipe: Json) => recipe.servingSize as Json;
const steps = (recipe: Json) => serving(recipe).steps as Json[];
const step = (recipe: Json, index: number) => steps(recipe)[index] as Json;
const group = (recipe: Json) => (serving(recipe).ingredientGroups as Json[])[0] as Json;
const ingredient = (recipe: Json) => (group(recipe).ingredients as Json[])[0] as Json;

function issuesOf(mutate: (recipe: Json) => void) {
  const recipe = sample();
  mutate(recipe);
  const result = RecipeInputSchema.safeParse(recipe);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

describe("RecipeInputSchema", () => {
  it("accepts the all-modes sample", () => {
    const result = RecipeInputSchema.safeParse(sample());
    expect(result.success).toBe(true);
  });

  it("accepts a recipe without the optional fields", () => {
    expect(
      issuesOf((r) => {
        delete r.nutrients;
        delete r.reviewHints;
        delete serving(r).instruction;
      }),
    ).toEqual([]);
  });

  // Each case breaks exactly one limit.
  it.each<[string, (recipe: Json) => void, string, RegExp]>([
    ["malformed locale", (r) => (r.locale = "german"), "locale", /must look like de-DE/],
    [
      "mapping index below 0",
      (r) => (r.ingredientMapping = [{ name: "x", inputIndex: -1 }]),
      "ingredientMapping.0.inputIndex",
      /must not be negative/,
    ],
    ["unknown complexity", (r) => (r.complexity = "extreme"), "complexity", /Invalid option/],
    ["duplicate category", (r) => (r.categoryIds = [228, 228]), "categoryIds", /unique/],
    [
      "fractional category",
      (r) => (r.categoryIds = [2.5]),
      "categoryIds.0",
      /category id must be a whole number/,
    ],
    [
      "duplicate nutrient",
      (r) =>
        (r.nutrients = [
          { name: "fat", amount: 1 },
          { name: "fat", amount: 2 },
        ]),
      "nutrients",
      /only once/,
    ],
    [
      "negative nutrient",
      (r) => (r.nutrients = [{ name: "fat", amount: -1 }]),
      "nutrients.0.amount",
      /negative/,
    ],
    ["fractional servings", (r) => (serving(r).amount = 2.5), "servingSize.amount", /whole number/],
    ["empty serving unit", (r) => (serving(r).unit = ""), "servingSize.unit", /must not be empty/],
    [
      "long instruction",
      (r) => (serving(r).instruction = "x".repeat(4001)),
      "servingSize.instruction",
      /4000/,
    ],
    [
      "ready before preparation",
      (r) => (serving(r).readyInTime = 4),
      "servingSize.readyInTime",
      /must not be shorter than preparationTime/,
    ],
    [
      "no groups",
      (r) => (serving(r).ingredientGroups = []),
      "servingSize.ingredientGroups",
      /at least one ingredient group/,
    ],
    [
      "long group name",
      (r) => (group(r).name = "x".repeat(81)),
      "servingSize.ingredientGroups.0.name",
      /at most 80/,
    ],
    [
      "empty group",
      (r) => (group(r).ingredients = []),
      "servingSize.ingredientGroups.0.ingredients",
      /at least one ingredient/,
    ],
    [
      "empty ingredient name",
      (r) => (ingredient(r).name = ""),
      "servingSize.ingredientGroups.0.ingredients.0.name",
      /must not be empty/,
    ],
    [
      "long ingredient name",
      (r) => (ingredient(r).name = "x".repeat(121)),
      "servingSize.ingredientGroups.0.ingredients.0.name",
      /at most 120/,
    ],
    [
      "long unit",
      (r) => (ingredient(r).unit = "x".repeat(31)),
      "servingSize.ingredientGroups.0.ingredients.0.unit",
      /at most 30/,
    ],
    [
      "negative amount",
      (r) => (ingredient(r).amount = -1),
      "servingSize.ingredientGroups.0.ingredients.0.amount",
      /Invalid input|negative/,
    ],
    ["no steps", (r) => (serving(r).steps = []), "servingSize.steps", /at least one step/],
    [
      "scale without description",
      (r) => delete step(r, 1).description,
      "servingSize.steps.1.description",
      /Invalid input/,
    ],
    [
      "turbo without description",
      (r) => delete step(r, 11).description,
      "servingSize.steps.11.description",
      /Invalid input/,
    ],
    [
      "description on a program step",
      (r) => (step(r, 2).description = "Kochen"),
      "servingSize.steps.2",
      /Unrecognized key/,
    ],
    [
      "unknown step kind",
      (r) => (step(r, 2).kind = "kneading"),
      "servingSize.steps.2.kind",
      /unknown step kind/,
    ],
    [
      "seconds over 59",
      (r) => (step(r, 2).seconds = 60),
      "servingSize.steps.2.seconds",
      /at most 59/,
    ],
    [
      "fractional speed",
      (r) => (step(r, 2).speed = 1.5),
      "servingSize.steps.2.speed",
      /whole number/,
    ],
    [
      "unknown rotation",
      (r) => (step(r, 2).rotation = "up"),
      "servingSize.steps.2.rotation",
      /Invalid option/,
    ],
    [
      "unknown egg size",
      (r) => (step(r, 17).size = "huge"),
      "servingSize.steps.17.size",
      /Invalid option/,
    ],
    [
      "21 review hints",
      (r) => (r.reviewHints = Array.from({ length: 21 }, () => "x")),
      "reviewHints",
      /at most 20/,
    ],
    [
      "long review hint",
      (r) => (r.reviewHints = ["x".repeat(201)]),
      "reviewHints.0",
      /at most 200/,
    ],
    ["status from the model", (r) => (r.status = "publish"), "", /Unrecognized key: "status"/],
  ])("rejects %s", (_name, mutate, path, message) => {
    const issues = issuesOf(mutate);
    expect(issues).toContainEqual({ path, message: expect.stringMatching(message) as unknown });
  });

  // These limits come from the knowledge file; validate.test.ts checks them.
  it("leaves the limits of the knowledge file to the validator", () => {
    expect(
      issuesOf((r) => {
        r.title = "x".repeat(200);
        r.categoryIds = [];
        r.nutrients = [{ name: "sugar", amount: 1 }];
        serving(r).amount = 0;
        serving(r).preparationTime = 0;
        serving(r).readyInTime = 99999;
        step(r, 0).description = "";
        step(r, 15).minutes = 721;
      }),
    ).toEqual([]);
  });

  it("knows every step kind", () => {
    expect(STEP_KINDS).toEqual(["text", ...MACHINE_STEP_KINDS]);
    expect([...StepSchema.options.map((option) => option.shape.kind.value)].sort()).toEqual(
      [...STEP_KINDS].sort(),
    );
  });
});

describe("recipeInputJsonSchema", () => {
  it("exports the input side as JSON Schema", () => {
    const schema = recipeInputJsonSchema() as {
      $schema: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "title",
        "description",
        "locale",
        "complexity",
        "categoryIds",
        "servingSize",
      ]),
    );
    expect(schema.required).not.toContain("reviewHints");
    // The converter always asks for the mapping.
    expect(schema.required).toContain("ingredientMapping");
    const mapping = schema.properties.ingredientMapping as { items: { required: string[] } };
    expect(mapping.items.required).toEqual(["name", "inputIndex"]);
    // An answer whose provider dropped a null index still parses.
    expect(
      RecipeInputSchema.shape.ingredientMapping.parse([
        { name: "Wasser" },
        { name: "Salz", inputIndex: null },
      ]),
    ).toEqual([{ name: "Wasser" }, { name: "Salz", inputIndex: null }]);
    const located = recipeInputJsonSchema(undefined, { locale: "en-US" }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(located.properties.locale).toMatchObject({ enum: ["en-US"] });
    expect(located.properties.locale).not.toHaveProperty("pattern");
    expect(schema.properties.title).toEqual({ type: "string" });
    const steps = (
      schema.properties.servingSize as {
        properties: { steps: { items: { oneOf?: unknown[]; anyOf?: unknown[] } } };
      }
    ).properties.steps.items;
    expect((steps.oneOf ?? steps.anyOf ?? []).length).toBe(STEP_KINDS.length);
  });

  it("names no unit or serving words of one language, so every locale can use it", () => {
    const text = JSON.stringify(recipeInputJsonSchema(undefined, { locale: "en-US" }));
    for (const word of ["EL", "TL", "Tl", "El", "Prise", "Stück", "Portionen", "Rühraufsatz"]) {
      expect(text).not.toMatch(new RegExp(String.raw`(?<![\p{L}_])${word}(?![\p{L}_])`, "u"));
    }
  });

  it("writes the recipe limits of the knowledge file into the schema", async () => {
    const limits = await loadDeviceLimits();
    const schema = recipeInputJsonSchema(limits) as { properties: Record<string, Json> };
    const p = schema.properties;
    expect(p.title).toMatchObject({ minLength: 1, maxLength: 86 });
    expect(p.description).toMatchObject({ maxLength: 240 });
    expect(p.categoryIds).toMatchObject({ minItems: 1, maxItems: 8 });
    const nutrient = (p.nutrients as { items: { properties: Record<string, Json> } }).items;
    expect(nutrient.properties.name).toMatchObject({ enum: limits.recipe.nutrients.names });
    expect(nutrient.properties.amount).toMatchObject({ minimum: 0, maximum: 99999 });
    const servingProps = (p.servingSize as { properties: Record<string, Json> }).properties;
    expect(servingProps.amount).toMatchObject({ minimum: 1, maximum: 100, multipleOf: 1 });
    expect(servingProps.preparationTime).toMatchObject({ minimum: 1, maximum: 1440 });
    expect(servingProps.readyInTime).toMatchObject({ minimum: 1, maximum: 18000 });
    const items = (servingProps.steps as { items: { oneOf?: Json[]; anyOf?: Json[] } }).items;
    const variants = (items.oneOf ?? items.anyOf ?? []) as { properties: Record<string, Json> }[];
    for (const variant of variants) {
      expect(variant.properties.title).toMatchObject({ minLength: 1, maxLength: 80 });
      if (variant.properties.description) {
        expect(variant.properties.description).toMatchObject({ minLength: 1, maxLength: 240 });
      }
    }
    expect(variants.filter((variant) => variant.properties.description)).toHaveLength(3);
  });
});
