// Shapes for the corpus normalizer.
//
// The raw schemas describe the recipe detail JSON as returned by
// GET https://mc-api.tecpal.com/api/v2/recipes/{id} and stored by the crawler as
// local/corpus/details/<id>.json. The crawler keeps either the full envelope
// ({code, data: {recipe}}) or just {recipe}; both are accepted. Only the fields the
// normalizer reads are declared; everything else passes through unchecked.

import { z } from "zod";

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

export const rawSettingSchema = z.object({
  order: nullableNumber,
  speed: nullableNumber,
  temperature: nullableNumber,
  time: nullableNumber,
  weight: nullableNumber,
});

export const rawDeviceSettingSchema = z.object({
  mode: z.string(),
  reverse: z.boolean().nullable().optional(),
  turbo: z.boolean().nullable().optional(),
  size: nullableString,
  texture: nullableString,
  cleaningMode: nullableString,
  settings: z.array(rawSettingSchema).nullable().optional(),
});

export const rawStepSchema = z.object({
  step: nullableNumber,
  order: nullableNumber,
  name: nullableString,
  description: nullableString,
  deviceSetting: rawDeviceSettingSchema.nullable().optional(),
});

export const rawIngredientSchema = z.object({
  order: nullableNumber,
  amount: z.union([z.string(), z.number()]).nullable().optional(),
  unit: nullableString,
  name: nullableString,
  systemIngredientId: nullableNumber,
  ingredientGroupId: nullableNumber,
});

export const rawIngredientGroupSchema = z.object({
  id: nullableNumber,
  order: nullableNumber,
  name: nullableString,
});

export const rawServingSizeSchema = z.object({
  amount: z.union([z.number(), z.string()]).nullable().optional(),
  servingUnit: nullableString,
  steps: z.array(rawStepSchema).nullable().optional(),
  ingredients: z.array(rawIngredientSchema).nullable().optional(),
  ingredientGroups: z.array(rawIngredientGroupSchema).nullable().optional(),
});

export const rawNutrientSchema = z.object({
  name: z.string(),
  unit: nullableString,
  amount: nullableNumber,
  amountFloat: nullableNumber,
});

export const rawRecipeSchema = z.object({
  id: z.number(),
  name: nullableString,
  source: nullableString,
  deviceTypes: z.array(z.string()).nullable().optional(),
  categories: z
    .array(z.object({ id: z.number(), name: nullableString }))
    .nullable()
    .optional(),
  complexity: nullableString,
  preparationDuration: nullableNumber,
  duration: nullableNumber,
  rating: nullableNumber,
  totalRating: nullableNumber,
  popularity: nullableNumber,
  nutrients: z.array(rawNutrientSchema).nullable().optional(),
  servingSizes: z.array(rawServingSizeSchema).min(1),
});

export const rawDetailFileSchema = z.union([
  z.object({ recipe: rawRecipeSchema }),
  z.object({ data: z.object({ recipe: rawRecipeSchema }) }),
]);

export type RawSetting = z.infer<typeof rawSettingSchema>;
export type RawDeviceSetting = z.infer<typeof rawDeviceSettingSchema>;
export type RawStep = z.infer<typeof rawStepSchema>;
export type RawIngredient = z.infer<typeof rawIngredientSchema>;
export type RawIngredientGroup = z.infer<typeof rawIngredientGroupSchema>;
export type RawRecipe = z.infer<typeof rawRecipeSchema>;
export type RawDetailFile = z.infer<typeof rawDetailFileSchema>;

// Normalized shapes, written as JSON lines under local/corpus/derived/.

export type UnitNorm = "g" | "ml" | "Stueck" | "TL" | "EL" | "Prise" | "other" | "none";

export type Accessory = "Ruehraufsatz" | "Gareinsatz" | "Dampfgaraufsatz" | "Messbecher" | "Spatel";

export interface NormalizedIngredient {
  order: number;
  name: string;
  /** Parsed amount in the unit given by `unit`; ranges become their midpoint. */
  amount: number | null;
  amountRaw: string;
  unit: string;
  unitNorm: UnitNorm;
  /** Estimated weight in grams, or null when the unit gives no reliable weight. */
  grams: number | null;
  systemIngredientId: number | null;
  group: string | null;
}

export interface Nutrients {
  kcal: number | null;
  carb: number | null;
  fat: number | null;
  protein: number | null;
}

export interface NormalizedRecipe {
  id: number;
  title: string;
  source: string | null;
  deviceTypes: string[];
  isSmartOnly: boolean;
  categories: { id: number; name: string | null }[];
  complexity: string | null;
  servings: { amount: number | null; unit: string | null };
  prepMinutes: number | null;
  totalMinutes: number | null;
  /** Per serving, as published. */
  nutrients: Nutrients;
  rating: number | null;
  totalRating: number | null;
  popularity: number | null;
  ingredientCount: number;
  ingredients: NormalizedIngredient[];
  stepCount: number;
  /** Steps with a device setting, scale steps included. */
  machineStepCount: number;
  scaleStepCount: number;
  textStepCount: number;
  /** One entry per step: the device mode, or "text" for a step without device setting. */
  modeSequence: string[];
  /** Sum of programmed time over all machine steps except scale steps. */
  totalMachineSeconds: number;
  maxTemperature: number | null;
  usesReverse: boolean;
  usesTurbo: boolean;
  accessories: Accessory[];
  /** Short hash over title, ingredients and steps, for change detection between crawls. */
  contentHash: string;
}

export interface AmountMention {
  amount: number;
  unit: "g" | "ml" | "EL" | "TL" | "Stueck";
  raw: string;
}

export interface ModeSetting {
  size: string | null;
  texture: string | null;
  cleaningMode: string | null;
  settings: {
    order: number | null;
    speed: number | null;
    temperature: number | null;
    time: number | null;
    weight: number | null;
  }[];
}

export interface NormalizedStep {
  recipeId: number;
  source: string | null;
  categories: number[];
  stepIndex: number;
  stepCount: number;
  kind: "text" | "machine";
  /** Device mode, or "text". */
  mode: string;
  /** Highest temperature over all phases (0 means no heating). */
  temperature: number | null;
  /** Sum of time over all phases. */
  timeSeconds: number | null;
  /** Highest speed over all phases. */
  speed: number | null;
  reverse: boolean;
  turbo: boolean;
  /** Sum of weight over all phases (scale steps). */
  weight: number | null;
  modeSetting: ModeSetting | null;
  /** Step title (step.name, trimmed); missing in derived files from before it was added. */
  title?: string;
  titleLen: number;
  textLen: number;
  /** Step text. Kept only in the gitignored derived file. */
  text: string;
  prevTextSteps: string | null;
  cumulativeGramsBefore: number;
  amountsInText: AmountMention[];
}

export interface NormalizedOutput {
  recipe: NormalizedRecipe;
  steps: NormalizedStep[];
}
