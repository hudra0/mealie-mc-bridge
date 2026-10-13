// The intermediate recipe format: what the converter produces and the validator checks
// before the payload builder turns it into an API payload.
//
// Ported from SmartRecipe RecipeInputSchema in src/recipes/schema.ts
// (MIT, https://github.com/gerkensm/smart-recipe) and changed: every step is one flat object
// discriminated by "kind" (the API mode type, or "text"), the recipe limits are the
// effective layer of knowledge/device-programs.json, the status is not part of the format
// (the code sets it), and reviewHints carry notes for the human reviewer.
//
// The schema checks structure, types and the recipe-level limits. Device limits per
// program (temperature grids, time ranges, speed rules) live in the knowledge file and are
// checked by validate.ts.

import { z } from "zod";
import { MACHINE_STEP_KINDS } from "./modes.js";

export const RECIPE_LOCALES = ["de-DE"] as const;
export const COMPLEXITIES = ["easy", "medium", "hard"] as const;
export const NUTRIENT_NAMES = ["calories", "carbohydrate", "fat", "protein"] as const;
export const STEP_KINDS = ["text", ...MACHINE_STEP_KINDS] as const;

// Recipe-level limits. They match the effective layer of the knowledge file; a test keeps
// the two in step.
export const SCHEMA_LIMITS = {
  title: { min: 1, max: 86 },
  description: { max: 240 },
  categories: { min: 1, max: 8 },
  servings: { min: 1, max: 100 },
  servingUnit: { min: 1, max: 40 },
  instruction: { max: 4000 },
  preparationTime: { min: 1, max: 1440 },
  readyInTime: { min: 1, max: 18000 },
  groupName: { max: 80 },
  ingredientName: { min: 1, max: 120 },
  ingredientAmount: { max: 30 },
  ingredientUnit: { max: 30 },
  stepTitle: { min: 1, max: 80 },
  stepDescription: { min: 1, max: 240 },
  // The longest program (sous-vide, fermentation) runs 720 minutes.
  stepMinutes: { max: 720 },
  reviewHints: { max: 20, itemMax: 200 },
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

const stepTitle = text("step title", L.stepTitle.min, L.stepTitle.max).describe(
  "Short step title shown on the device",
);
const stepDescription = text("step description", L.stepDescription.min, L.stepDescription.max);
const minutes = int("minutes")
  .min(0, "minutes must not be negative")
  .max(L.stepMinutes.max, `minutes must be at most ${L.stepMinutes.max}`)
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
    title: stepTitle,
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
  unit: text("unit", 0, L.ingredientUnit.max).describe("Unit such as g, EL, TL, Prise, Stück"),
  isOptional: z.boolean(),
});

export const IngredientGroupSchema = z.strictObject({
  name: text("group name", 0, L.groupName.max),
  ingredients: z.array(IngredientSchema).min(1, "a group needs at least one ingredient"),
});

export const NutrientSchema = z.strictObject({
  name: z.enum(NUTRIENT_NAMES),
  amount: z.number().nonnegative("nutrient amount must not be negative"),
});

export const ServingSizeSchema = z
  .strictObject({
    amount: int("servings")
      .min(L.servings.min, `servings must be at least ${L.servings.min}`)
      .max(L.servings.max, `servings must be at most ${L.servings.max}`),
    unit: text("serving unit", L.servingUnit.min, L.servingUnit.max).describe(
      'Serving unit, for example "Portionen" or "Stück"',
    ),
    instruction: text("instruction", 0, L.instruction.max)
      .optional()
      .describe("The whole recipe as plain text, for reading without the device"),
    preparationTime: int("preparationTime")
      .min(L.preparationTime.min, `preparationTime must be at least ${L.preparationTime.min}`)
      .max(L.preparationTime.max, `preparationTime must be at most ${L.preparationTime.max}`)
      .describe("Active preparation time in minutes"),
    readyInTime: int("readyInTime")
      .min(L.readyInTime.min, `readyInTime must be at least ${L.readyInTime.min}`)
      .max(L.readyInTime.max, `readyInTime must be at most ${L.readyInTime.max}`)
      .describe("Total time until the dish is ready, in minutes"),
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
  title: text("title", L.title.min, L.title.max),
  description: text("description", 0, L.description.max),
  locale: z.enum(RECIPE_LOCALES),
  complexity: z.enum(COMPLEXITIES),
  categoryIds: z
    .array(int("category id").positive("category ids are positive"))
    .min(L.categories.min, `pick at least ${L.categories.min} category`)
    .max(L.categories.max, `pick at most ${L.categories.max} categories`)
    .refine((ids) => new Set(ids).size === ids.length, "category ids must be unique"),
  nutrients: z
    .array(NutrientSchema)
    .max(NUTRIENT_NAMES.length)
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
});

export type RecipeInput = z.infer<typeof RecipeInputSchema>;
export type RecipeStep = z.infer<typeof StepSchema>;
export type StepKind = RecipeStep["kind"];
export type TextStep = Extract<RecipeStep, { kind: "text" }>;
export type MachineStep = Exclude<RecipeStep, { kind: "text" }>;
export type Ingredient = z.infer<typeof IngredientSchema>;
export type IngredientGroup = z.infer<typeof IngredientGroupSchema>;
export type Nutrient = z.infer<typeof NutrientSchema>;
export type ServingSize = z.infer<typeof ServingSizeSchema>;

// JSON Schema (draft 2020-12) of the input side, for structured LLM output. Refinements
// (unique ids, readyInTime >= preparationTime) are not expressible there; the validator
// still checks them.
export function recipeInputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(RecipeInputSchema, { target: "draft-2020-12", io: "input" });
}
