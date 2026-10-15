// The intermediate recipe format: what the converter produces and the validator checks
// before the payload builder turns it into an API payload.
//
// Ported from SmartRecipe RecipeInputSchema in src/recipes/schema.ts
// (MIT, https://github.com/gerkensm/smart-recipe) and changed: every step is one flat object
// discriminated by "kind" (the API mode type, or "text"), the status is not part of the
// format (the code sets it), and reviewHints carry notes for the human reviewer.
//
// The schema checks structure and types. Every limit that knowledge/device-programs.json
// states (text lengths, servings, times, categories, nutrients, and the device limits per
// program) is checked by validate.ts against the loaded file, so the file is the only
// source for them. The schema keeps only the format limits the file does not cover.

import { z } from "zod";
import type { DeviceLimits } from "./limits.js";
import { MACHINE_STEP_KINDS } from "./modes.js";

// The locale must look like de-DE; whether a pack exists for it is checked against the
// locale packs (src/locale/pack.ts) by the converter, the validator and the payload builder.
export const RECIPE_LOCALE_PATTERN = /^[a-z]{2,3}-[A-Z]{2}$/;
export const COMPLEXITIES = ["easy", "medium", "hard"] as const;
export const STEP_KINDS = ["text", ...MACHINE_STEP_KINDS] as const;
// Accessories that change what a program may do. The knowledge file caps the speed of
// manual cooking while the butterfly whisk is fitted.
export const ACCESSORIES = ["butterfly_whisk"] as const;

// Format limits of fields the knowledge file says nothing about.
export const SCHEMA_LIMITS = {
  servingUnit: { min: 1, max: 40 },
  instruction: { max: 4000 },
  groupName: { max: 80 },
  ingredientName: { min: 1, max: 120 },
  ingredientAmount: { max: 30 },
  ingredientUnit: { max: 30 },
  reviewHints: { max: 20, itemMax: 200 },
  ingredientMapping: { max: 200 },
} as const;

const L = SCHEMA_LIMITS;

const text = (field: string, min: number, max: number) =>
  min > 0
    ? z
        .string()
        .min(min, `${field} must not be empty`)
        .max(max, `${field} must be at most ${max} characters`)
    : z.string().max(max, `${field} must be at most ${max} characters`);

const int = (field: string) => z.number().int(`${field} must be a whole number`);

const stepTitle = z.string().describe("Short step title shown on the device");
const stepDescription = z.string();
const minutes = int("minutes")
  .min(0, "minutes must not be negative")
  .describe("Whole minutes of the program time");
const seconds = int("seconds")
  .min(0, "seconds must not be negative")
  .max(59, "seconds must be at most 59; carry full minutes into minutes")
  .describe("Remaining seconds of the program time, 0-59");
const temperature = int("temperature")
  .min(0, "temperature must not be negative")
  .describe("Temperature in °C, 0 for no heating");

export const TextStepSchema = z
  .strictObject({
    kind: z.literal("text"),
    title: z
      .string()
      .describe(
        "A short imperative summary of the step, at most 60 characters, not the start of the description",
      ),
    description: stepDescription.describe("Instruction shown on the device, with quantities"),
  })
  .describe("Instruction without a program");

export const CustomizedStepSchema = z
  .strictObject({
    kind: z.literal("customized"),
    title: stepTitle,
    temperature,
    minutes,
    seconds,
    speed: int("speed").describe("Speed 1-10"),
    rotation: z.enum(["right", "left"]).describe("right: normal; left: reverse, gentle stirring"),
    accessory: z
      .enum(ACCESSORIES)
      .optional()
      .describe(
        "Set to butterfly_whisk while the whisk attachment is fitted; the speed limit drops. Not sent to the device.",
      ),
  })
  .describe("Manual cooking: temperature, time, speed and rotation");

export const RoastingStepSchema = z.strictObject({
  kind: z.literal("roasting"),
  title: stepTitle,
  temperature,
  minutes,
  seconds,
});

const timedStep = <K extends string>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), title: stepTitle, minutes, seconds });

const heatedStep = <K extends string>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), title: stepTitle, temperature, minutes, seconds });

export const SteamingStepSchema = timedStep("steaming");
export const KneadingSolidDoughStepSchema = timedStep("kneading_solid_dough");
export const KneadingSoftDoughStepSchema = timedStep("kneading_soft_dough");
export const KneadingLiquidDoughStepSchema = timedStep("kneading_liquid_dough");
export const PureeStepSchema = timedStep("puree");
export const SmoothieStepSchema = timedStep("smoothie");
export const RiceCookingStepSchema = timedStep("rice_cooking");
export const FoodProcessorStepSchema = timedStep("food_processor");
export const SlowCookingStepSchema = heatedStep("slow_cooking");
export const SousVideStepSchema = heatedStep("sous_vide");
export const FermentationStepSchema = heatedStep("fermentation");

export const TurboStepSchema = z
  .strictObject({
    kind: z.literal("turbo"),
    title: stepTitle,
    description: stepDescription.describe("What the turbo does, shown on the device"),
    seconds: int("seconds").min(0, "seconds must not be negative").describe("Turbo duration"),
  })
  .describe("Turbo burst; the device shows the description");

export const ScaleStepSchema = z
  .strictObject({
    kind: z.literal("scale"),
    title: stepTitle,
    description: stepDescription.describe("Ingredient and amount to weigh, shown on the device"),
    grams: int("grams").min(0, "grams must not be negative").describe("Target weight in g"),
  })
  .describe("Weigh an ingredient into the bowl; the device shows the description");

export const CookingEggsStepSchema = z.strictObject({
  kind: z.literal("cooking_eggs"),
  title: stepTitle,
  size: z.enum(["small", "medium", "large"]),
  texture: z.enum(["soft", "waxy_soft", "hard"]),
});

export const PrecleaningStepSchema = z.strictObject({
  kind: z.literal("precleaning"),
  title: stepTitle,
  duration: z.enum(["short", "long"]),
});

export const StepSchema = z.discriminatedUnion(
  "kind",
  [
    TextStepSchema,
    CustomizedStepSchema,
    RoastingStepSchema,
    SteamingStepSchema,
    KneadingSolidDoughStepSchema,
    KneadingSoftDoughStepSchema,
    KneadingLiquidDoughStepSchema,
    PureeStepSchema,
    SmoothieStepSchema,
    TurboStepSchema,
    ScaleStepSchema,
    SlowCookingStepSchema,
    SousVideStepSchema,
    FermentationStepSchema,
    RiceCookingStepSchema,
    CookingEggsStepSchema,
    PrecleaningStepSchema,
    FoodProcessorStepSchema,
  ],
  {
    error: (issue) =>
      issue.code === "invalid_union"
        ? `unknown step kind; use one of: ${STEP_KINDS.join(", ")}`
        : undefined,
  },
);

export const IngredientSchema = z.strictObject({
  name: text("ingredient name", L.ingredientName.min, L.ingredientName.max),
  amount: z
    .union([
      text("amount", 0, L.ingredientAmount.max),
      z.number().nonnegative("amount must not be negative"),
    ])
    .describe('Amount as a number, or as text for ranges and fractions ("1-2", "1/2")'),
  unit: text("unit", 0, L.ingredientUnit.max).describe(
    "Unit as the Units section of the system prompt spells it; empty for counted items",
  ),
  isOptional: z.boolean(),
});

export const IngredientGroupSchema = z.strictObject({
  name: text("group name", 0, L.groupName.max),
  ingredients: z.array(IngredientSchema).min(1, "a group needs at least one ingredient"),
});

// Where an ingredient-list entry comes from: the index [i] of the source ingredient line the
// converter was given, or null for an ingredient the source does not have. The plausibility
// checks compare amounts and coverage through it, whatever the languages of source and
// recipe. Not sent to Monsieur Cuisine. A missing inputIndex counts as null: providers drop
// null fields of a structured answer (stripNulls), so the schema accepts both; the JSON schema
// for the model still requires the field.
export const IngredientMappingSchema = z.strictObject({
  name: text("mapping name", L.ingredientName.min, L.ingredientName.max).describe(
    "An ingredient name exactly as in ingredientGroups",
  ),
  inputIndex: int("inputIndex")
    .min(0, "inputIndex must not be negative")
    .nullable()
    .optional()
    .describe("Index [i] of the source ingredient line, or null when the source does not have it"),
});

export const NutrientSchema = z.strictObject({
  name: z.string().describe("Nutrient name, for example calories, carbohydrate, fat, protein"),
  amount: z.number().nonnegative("nutrient amount must not be negative"),
});

export const ServingSizeSchema = z
  .strictObject({
    amount: int("servings"),
    unit: text("serving unit", L.servingUnit.min, L.servingUnit.max).describe(
      "Serving unit in the recipe language",
    ),
    instruction: text("instruction", 0, L.instruction.max)
      .optional()
      .describe("The whole recipe as plain text, for reading without the device"),
    preparationTime: int("preparationTime").describe("Active preparation time in minutes"),
    readyInTime: int("readyInTime").describe("Total time until the dish is ready, in minutes"),
    ingredientGroups: z
      .array(IngredientGroupSchema)
      .min(1, "the recipe needs at least one ingredient group"),
    steps: z.array(StepSchema).min(1, "the recipe needs at least one step"),
  })
  .superRefine((serving, ctx) => {
    if (serving.readyInTime < serving.preparationTime) {
      ctx.addIssue({
        code: "custom",
        path: ["readyInTime"],
        message: `readyInTime (${serving.readyInTime} min) must not be shorter than preparationTime (${serving.preparationTime} min)`,
      });
    }
  });

export const RecipeInputSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  locale: z.string().regex(RECIPE_LOCALE_PATTERN, "locale must look like de-DE"),
  complexity: z.enum(COMPLEXITIES),
  categoryIds: z
    .array(int("category id").positive("category ids are positive"))
    .refine((ids) => new Set(ids).size === ids.length, "category ids must be unique"),
  nutrients: z
    .array(NutrientSchema)
    .refine(
      (list) => new Set(list.map((nutrient) => nutrient.name)).size === list.length,
      "each nutrient may appear only once",
    )
    .optional()
    .describe("Per serving: calories in kcal, the others in g"),
  servingSize: ServingSizeSchema,
  reviewHints: z
    .array(
      text("review hint", 1, L.reviewHints.itemMax).describe(
        "Something a human should check before cooking",
      ),
    )
    .max(L.reviewHints.max, `at most ${L.reviewHints.max} review hints`)
    .optional(),
  ingredientMapping: z
    .array(IngredientMappingSchema)
    .max(L.ingredientMapping.max, `at most ${L.ingredientMapping.max} mapping entries`)
    .optional()
    .describe(
      "One entry per ingredient-list name: the source ingredient line [i] it comes from, or null",
    ),
});

export type RecipeInput = z.infer<typeof RecipeInputSchema>;
export type RecipeStep = z.infer<typeof StepSchema>;
export type StepKind = RecipeStep["kind"];
export type TextStep = Extract<RecipeStep, { kind: "text" }>;
export type MachineStep = Exclude<RecipeStep, { kind: "text" }>;
export type Ingredient = z.infer<typeof IngredientSchema>;
export type IngredientGroup = z.infer<typeof IngredientGroupSchema>;
export type Nutrient = z.infer<typeof NutrientSchema>;
export type IngredientMapping = z.infer<typeof IngredientMappingSchema>;
export type ServingSize = z.infer<typeof ServingSizeSchema>;

type JsonNode = Record<string, unknown>;

// JSON Schema (draft 2020-12) of the input side, for structured LLM output. With limits,
// the recipe-level bounds of the knowledge file are written into it as well, so the model
// sees them up front. Refinements (unique ids, readyInTime >= preparationTime) and the
// device limits per program are not expressible there; the validator still checks them.
// The converter asks for ingredientMapping on every answer, so it is required here; the
// schema keeps it optional for recipes written by hand. With a locale, the locale field
// takes only that value.
export function recipeInputJsonSchema(
  limits?: DeviceLimits,
  options: { locale?: string } = {},
): JsonNode {
  const schema = z.toJSONSchema(RecipeInputSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as JsonNode;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (!required.includes("ingredientMapping")) schema.required = [...required, "ingredientMapping"];
  const topProps = (schema.properties ?? {}) as Record<string, JsonNode>;
  const mappingItem = topProps.ingredientMapping?.items as JsonNode | undefined;
  if (mappingItem) mappingItem.required = ["name", "inputIndex"];
  if (options.locale && topProps.locale) {
    delete topProps.locale.pattern;
    topProps.locale.enum = [options.locale];
  }
  if (!limits) return schema;
  const r = limits.recipe;
  const props = (node: unknown): Record<string, JsonNode> =>
    ((node as JsonNode | undefined)?.properties ?? {}) as Record<string, JsonNode>;
  const set = (node: JsonNode | undefined, bounds: JsonNode) => {
    if (node) Object.assign(node, bounds);
  };
  const top = props(schema);
  set(top.title, { minLength: r.recipeTitle.min, maxLength: r.recipeTitle.max });
  set(top.description, { maxLength: r.recipeDescription.max });
  set(top.categoryIds, { minItems: r.categories.min, maxItems: r.categories.max });
  const nutrientItem = (top.nutrients?.items ?? undefined) as JsonNode | undefined;
  set(props(nutrientItem).name, { enum: [...r.nutrients.names] });
  set(props(nutrientItem).amount, { minimum: r.nutrients.min, maximum: r.nutrients.max });
  const serving = props(top.servingSize);
  set(serving.amount, {
    minimum: r.servings.min,
    maximum: r.servings.max,
    multipleOf: r.servings.step,
  });
  set(serving.preparationTime, { minimum: r.preparationTime.min, maximum: r.preparationTime.max });
  set(serving.readyInTime, { minimum: r.readyInTime.min, maximum: r.readyInTime.max });
  const stepItems = (serving.steps?.items ?? {}) as { oneOf?: JsonNode[]; anyOf?: JsonNode[] };
  for (const variant of stepItems.oneOf ?? stepItems.anyOf ?? []) {
    const step = props(variant);
    set(step.title, { minLength: r.stepTitle.min, maxLength: r.stepTitle.max });
    set(step.description, { minLength: r.stepDescription.min, maxLength: r.stepDescription.max });
  }
  return schema;
}
