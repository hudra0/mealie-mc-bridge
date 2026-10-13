// Zod schemas for the Mealie REST API (camelCase), covering the v3.25 and v3.28 shapes.
// The schemas are lenient: unknown keys pass through untouched, missing lists become
// empty lists, and missing strings become null, so a newer Mealie release with extra
// fields still parses.

import { z } from "zod";

const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
const stringOrEmpty = z
  .string()
  .nullish()
  .transform((value) => value ?? "");
const numberOrZero = z
  .number()
  .nullish()
  .transform((value) => value ?? 0);
const listOf = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((value) => value ?? []);

// Tags and categories share one shape: {id, groupId, name, slug, recipeCount}.
export const mealieTagSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  groupId: z.string().nullish(),
});
export type MealieTag = z.infer<typeof mealieTagSchema>;

// What a recipe PATCH needs to attach a tag.
export interface MealieTagRef {
  id: string;
  name: string;
  slug: string;
}

export const mealieCategorySchema = mealieTagSchema;
export type MealieCategory = z.infer<typeof mealieCategorySchema>;

export const mealieUnitSchema = z.looseObject({
  id: z.string().nullish(),
  name: z.string(),
  pluralName: z.string().nullish(),
  abbreviation: z.string().nullish(),
  pluralAbbreviation: z.string().nullish(),
  useAbbreviation: z.boolean().nullish(),
  fraction: z.boolean().nullish(),
});
export type MealieUnit = z.infer<typeof mealieUnitSchema>;

export const mealieFoodSchema = z.looseObject({
  id: z.string().nullish(),
  name: z.string(),
  pluralName: z.string().nullish(),
});
export type MealieFood = z.infer<typeof mealieFoodSchema>;

// A title on an ingredient starts a section that lasts until the next title.
export const mealieIngredientSchema = z.looseObject({
  quantity: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  unit: mealieUnitSchema.nullish().transform((value) => value ?? null),
  food: mealieFoodSchema.nullish().transform((value) => value ?? null),
  note: nullableString,
  display: stringOrEmpty,
  title: nullableString,
  originalText: nullableString,
  referenceId: nullableString,
});
export type MealieIngredient = z.infer<typeof mealieIngredientSchema>;

// The title on a step is a section header; the summary is the step's own heading.
export const mealieInstructionSchema = z.looseObject({
  id: nullableString,
  title: nullableString,
  summary: nullableString,
  text: stringOrEmpty,
  ingredientReferences: listOf(z.looseObject({ referenceId: z.string().nullish() })),
});
export type MealieInstruction = z.infer<typeof mealieInstructionSchema>;

export const NUTRITION_KEYS = [
  "calories",
  "carbohydrateContent",
  "cholesterolContent",
  "fatContent",
  "fiberContent",
  "proteinContent",
  "saturatedFatContent",
  "sodiumContent",
  "sugarContent",
  "transFatContent",
  "unsaturatedFatContent",
] as const;
export type NutritionKey = (typeof NUTRITION_KEYS)[number];

export const mealieNutritionSchema = z.looseObject({
  calories: nullableString,
  carbohydrateContent: nullableString,
  cholesterolContent: nullableString,
  fatContent: nullableString,
  fiberContent: nullableString,
  proteinContent: nullableString,
  saturatedFatContent: nullableString,
  sodiumContent: nullableString,
  sugarContent: nullableString,
  transFatContent: nullableString,
  unsaturatedFatContent: nullableString,
});
export type MealieNutrition = z.infer<typeof mealieNutritionSchema>;

// v3.25 notes are {title, text}; v3.28 adds referenceId, which steps may point to.
export const mealieNoteSchema = z.looseObject({
  title: stringOrEmpty,
  text: stringOrEmpty,
  referenceId: z.string().nullish(),
});
export type MealieNote = z.infer<typeof mealieNoteSchema>;

export const mealieSettingsSchema = z.looseObject({
  public: z.boolean().nullish(),
  showNutrition: z.boolean().nullish(),
  showAssets: z.boolean().nullish(),
  landscapeView: z.boolean().nullish(),
  disableComments: z.boolean().nullish(),
  locked: z.boolean().nullish(),
});
export type MealieSettings = z.infer<typeof mealieSettingsSchema>;

// Mealie stores extras as string pairs. Other values are turned into strings.
const extrasSchema = z
  .record(z.string(), z.unknown())
  .nullish()
  .transform((value): Record<string, string> => {
    const extras: Record<string, string> = {};
    for (const [key, item] of Object.entries(value ?? {})) {
      if (item === null || item === undefined) continue;
      extras[key] = typeof item === "string" ? item : JSON.stringify(item);
    }
    return extras;
  });

// The image field is a short cache key, or null when the recipe has no image.
const imageSchema = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : String(value)));

// GET /api/recipes/{slug-or-id}.
export const mealieRecipeSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  name: stringOrEmpty,
  description: stringOrEmpty,
  image: imageSchema,
  userId: nullableString,
  groupId: nullableString,
  householdId: nullableString,
  recipeServings: numberOrZero,
  recipeYieldQuantity: numberOrZero,
  recipeYield: nullableString,
  totalTime: nullableString,
  prepTime: nullableString,
  cookTime: nullableString,
  performTime: nullableString,
  recipeCategory: listOf(mealieCategorySchema),
  tags: listOf(mealieTagSchema),
  recipeIngredient: listOf(mealieIngredientSchema),
  recipeInstructions: listOf(mealieInstructionSchema),
  nutrition: mealieNutritionSchema.nullish().transform((value) => value ?? null),
  notes: listOf(mealieNoteSchema),
  extras: extrasSchema,
  settings: mealieSettingsSchema.nullish().transform((value) => value ?? null),
  dateUpdated: nullableString,
  updatedAt: nullableString,
});
export type MealieRecipe = z.infer<typeof mealieRecipeSchema>;

// GET /api/users/self, the owner of the API token.
export const mealieUserSchema = z.looseObject({
  id: z.string(),
  username: z.string(),
  fullName: nullableString,
  admin: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
  groupId: nullableString,
  householdId: nullableString,
  canOrganize: z.boolean().nullish(),
  canManage: z.boolean().nullish(),
  advanced: z.boolean().nullish(),
});
export type MealieUser = z.infer<typeof mealieUserSchema>;

export const TIMELINE_EVENT_TYPES = ["info", "system", "comment"] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

// POST /api/recipes/timeline/events. The subject is plain text, the message Markdown.
export const mealieTimelineEventSchema = z.looseObject({
  id: z.string(),
  recipeId: z.string(),
  subject: z.string(),
  eventType: z.string(),
  eventMessage: nullableString,
  timestamp: nullableString,
  userId: nullableString,
});
export type MealieTimelineEvent = z.infer<typeof mealieTimelineEventSchema>;

// POST /api/comments.
export const mealieCommentSchema = z.looseObject({
  id: z.string(),
  recipeId: z.string(),
  text: z.string(),
  userId: nullableString,
  createdAt: nullableString,
});
export type MealieComment = z.infer<typeof mealieCommentSchema>;

// List endpoints wrap their items in a snake_case pagination envelope.
export const paginated = <T extends z.ZodType>(item: T) =>
  z.looseObject({
    page: z.number().nullish(),
    per_page: z.number().nullish(),
    total: z.number().nullish(),
    total_pages: z.number().nullish(),
    items: z.array(item),
  });
