// The recipe payload accepted by POST and PUT api/v3/auth/user/recipes, as verified against
// the live API on 2026-10-13. Layout follows SmartRecipe src/recipes/schema.ts
// (SmartRecipePayloadSchema, MIT, https://github.com/gerkensm/smart-recipe).

// Statuses the recipe list knows. The bridge only ever writes the first two: "pending" would
// submit the recipe to Lidl for publication.
export type McRecipeStatus = "draft" | "pending" | "private-publish" | "publish" | "rejected";
export type McWritableStatus = "draft" | "private-publish";
export const MC_WRITABLE_STATUSES: readonly McWritableStatus[] = ["draft", "private-publish"];

export function isWritableStatus(value: unknown): value is McWritableStatus {
  return value === "draft" || value === "private-publish";
}

export interface McMediaRef {
  portraitMediaId: number | null;
  landscapeMediaId: number | null;
  portraitIsAiGenerated: boolean;
  landscapeIsAiGenerated: boolean;
}

export interface McNutrient {
  name: string;
  unit: string;
  amount: number;
}

// Existing sub-objects carry their server id on PUT; new ones have none or null.
export interface McIngredientPayload {
  id?: number | null;
  name: string;
  isOptional: boolean;
  unit: string;
  amount: string;
  systemIngredientId: number | null;
  order: number;
  ingredientCategory: null;
  iconUrl: null;
}

export interface McIngredientGroupPayload {
  id?: number | null;
  name: string;
  isDefault: boolean;
  order: number;
  ingredients: McIngredientPayload[];
}

export type McDeviceSetting = { order: number } & Record<string, number | boolean>;

export interface McStepMode {
  type: string;
  modeSetting: Record<string, string> | null;
  deviceSettings: McDeviceSetting[] | null;
}

export interface McStepPayload {
  id?: number | null;
  title: string;
  description: string;
  duration: null;
  mode: McStepMode | null;
  videoMedia: null;
  order: number;
}

export interface McServingSizePayload {
  id?: number | null;
  amount: number;
  maxServing: null;
  instruction: string;
  unit: string;
  isDefault: true;
  preparationTime: number;
  readyInTime: number;
  ingredientGroups: McIngredientGroupPayload[];
  steps: McStepPayload[];
  order: 0;
}

export interface McRecipePayload {
  status: McWritableStatus;
  source: "member";
  languageLocale: string;
  deviceTypeIds: number[];
  title: string;
  description: string;
  thumbnail: McMediaRef;
  detailsImage: McMediaRef;
  complexityId: number;
  allowSocialSharing: false;
  categoryIds: number[];
  nutrients: McNutrient[];
  servingSizes: [McServingSizePayload];
}
