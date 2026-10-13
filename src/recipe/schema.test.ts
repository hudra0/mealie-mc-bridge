import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    ["empty title", (r) => (r.title = ""), "title", /title must not be empty/],
    ["title over 86", (r) => (r.title = "x".repeat(87)), "title", /at most 86/],
    [
      "description over 240",
      (r) => (r.description = "x".repeat(241)),
      "description",
      /at most 240/,
    ],
    ["other locale", (r) => (r.locale = "en-US"), "locale", /expected "de-DE"/],
    ["unknown complexity", (r) => (r.complexity = "extreme"), "complexity", /Invalid option/],
    ["no category", (r) => (r.categoryIds = []), "categoryIds", /at least 1 category/],
    [
      "nine categories",
      (r) => (r.categoryIds = [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      "categoryIds",
      /at most 8/,
    ],
    ["duplicate category", (r) => (r.categoryIds = [228, 228]), "categoryIds", /unique/],
    [
      "fractional category",
      (r) => (r.categoryIds = [2.5]),
      "categoryIds.0",
      /category id must be a whole number/,
    ],
    [
      "unknown nutrient",
      (r) => (r.nutrients = [{ name: "sugar", amount: 1 }]),
      "nutrients.0.name",
      /Invalid option/,
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
    ["zero servings", (r) => (serving(r).amount = 0), "servingSize.amount", /at least 1/],
    ["101 servings", (r) => (serving(r).amount = 101), "servingSize.amount", /at most 100/],
    ["fractional servings", (r) => (serving(r).amount = 2.5), "servingSize.amount", /whole number/],
    ["empty serving unit", (r) => (serving(r).unit = ""), "servingSize.unit", /must not be empty/],
    [
      "long instruction",
      (r) => (serving(r).instruction = "x".repeat(4001)),
      "servingSize.instruction",
      /4000/,
    ],
    [
      "preparation 0",
      (r) => (serving(r).preparationTime = 0),
      "servingSize.preparationTime",
      /at least 1/,
    ],
    [
      "preparation 1441",
      (r) => (serving(r).preparationTime = 1441),
      "servingSize.preparationTime",
      /at most 1440/,
    ],
    ["ready 0", (r) => (serving(r).readyInTime = 0), "servingSize.readyInTime", /at least 1/],
    [
      "ready 18001",
      (r) => (serving(r).readyInTime = 18001),
      "servingSize.readyInTime",
      /at most 18000/,
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
      "long step title",
      (r) => (step(r, 0).title = "x".repeat(81)),
      "servingSize.steps.0.title",
      /at most 80/,
    ],
    [
      "empty text step",
      (r) => (step(r, 0).description = ""),
      "servingSize.steps.0.description",
      /must not be empty/,
    ],
    [
      "long text step",
      (r) => (step(r, 0).description = "x".repeat(241)),
      "servingSize.steps.0.description",
      /at most 240/,
    ],
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
      "minutes over 720",
      (r) => (step(r, 15).minutes = 721),
      "servingSize.steps.15.minutes",
      /at most 720/,
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
    expect(schema.properties.title).toMatchObject({ type: "string", minLength: 1, maxLength: 86 });
    const steps = (
      schema.properties.servingSize as {
        properties: { steps: { items: { oneOf?: unknown[]; anyOf?: unknown[] } } };
      }
    ).properties.steps.items;
    expect((steps.oneOf ?? steps.anyOf ?? []).length).toBe(STEP_KINDS.length);
  });
});
