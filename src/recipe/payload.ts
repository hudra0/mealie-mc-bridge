// Builds the Monsieur Cuisine API payload from a validated RecipeInput.
//
// Field layout ported from SmartRecipe src/recipes/payload.ts, complexity ids from
// src/catalogs/catalogs.ts (MIT, https://github.com/gerkensm/smart-recipe), checked against
// the live API on 2026-10-13: one serving size, ingredient order from 1, group and step
// order from 0, amounts as strings, integer nutrients, empty descriptions on program steps.

import {
  isWritableStatus,
  type McDeviceSetting,
  type McMediaRef,
  type McRecipePayload,
  type McStepMode,
  type McStepPayload,
  type McWritableStatus,
} from "../mc/types.js";
import { MC_SMART_DEVICE_TYPE_ID, MODES, apiModeSettings, apiSettings } from "./modes.js";
import type { IngredientGroup, MachineStep, RecipeInput, RecipeStep } from "./schema.js";

// Complexity ids differ per locale.
export const COMPLEXITY_IDS: Readonly<
  Record<RecipeInput["locale"], Record<RecipeInput["complexity"], number>>
> = {
  "de-DE": { easy: 142, medium: 99, hard: 104 },
};

// The name the web editor gives an unnamed ingredient group.
export const DEFAULT_GROUP_NAMES: Readonly<Record<RecipeInput["locale"], string>> = {
  "de-DE": "Allgemeine Zutaten",
};

export const NUTRIENT_UNITS: Readonly<Record<string, string>> = {
  calories: "kCal",
  carbohydrate: "g",
  fat: "g",
  protein: "g",
};

export interface BuildPayloadOptions {
  // Set by the code, never by the model. The server creates every recipe as a draft;
  // "private-publish" takes effect through McClient.setStatus.
  status: McWritableStatus;
  detailsMediaId?: number | null;
  thumbnailMediaId?: number | null;
  // Overrides input.categoryIds, for example after filtering against the live catalog.
  categoryIds?: readonly number[];
}

export function buildMcPayload(input: RecipeInput, options: BuildPayloadOptions): McRecipePayload {
  if (!isWritableStatus(options.status)) {
    throw new TypeError(`Refusing to build a payload with status "${String(options.status)}"`);
  }
  const serving = input.servingSize;
  return {
    status: options.status,
    source: "member",
    languageLocale: input.locale,
    deviceTypeIds: [MC_SMART_DEVICE_TYPE_ID],
    title: input.title,
    description: input.description,
    thumbnail: mediaRef(options.thumbnailMediaId),
    detailsImage: mediaRef(options.detailsMediaId),
    complexityId: COMPLEXITY_IDS[input.locale][input.complexity],
    allowSocialSharing: false,
    categoryIds: [...(options.categoryIds ?? input.categoryIds)],
    nutrients: (input.nutrients ?? []).map((nutrient) => ({
      name: nutrient.name,
      unit: NUTRIENT_UNITS[nutrient.name] ?? "g",
      amount: Math.round(nutrient.amount),
    })),
    servingSizes: [
      {
        amount: serving.amount,
        maxServing: null,
        instruction: serving.instruction ?? "",
        unit: serving.unit,
        isDefault: true,
        preparationTime: serving.preparationTime,
        readyInTime: serving.readyInTime,
        ingredientGroups: serving.ingredientGroups.map((group, index) =>
          toGroup(group, index, DEFAULT_GROUP_NAMES[input.locale]),
        ),
        steps: serving.steps.map(toStep),
        order: 0,
      },
    ],
  };
}

function mediaRef(mediaId: number | null | undefined): McMediaRef {
  const id = mediaId ?? null;
  return {
    portraitMediaId: id,
    landscapeMediaId: id,
    portraitIsAiGenerated: false,
    landscapeIsAiGenerated: false,
  };
}

function toGroup(group: IngredientGroup, index: number, defaultName: string) {
  return {
    name: group.name.trim() === "" ? defaultName : group.name,
    isDefault: index === 0,
    order: index,
    ingredients: group.ingredients.map((ingredient, position) => ({
      name: ingredient.name,
      isOptional: ingredient.isOptional,
      unit: ingredient.unit,
      amount: formatAmount(ingredient.amount),
      systemIngredientId: null,
      order: position + 1,
      ingredientCategory: null,
      iconUrl: null,
    })),
  };
}

function toStep(step: RecipeStep, order: number): McStepPayload {
  if (step.kind === "text") {
    return {
      title: step.title,
      description: step.description,
      duration: null,
      mode: null,
      videoMedia: null,
      order,
    };
  }
  return {
    title: step.title,
    description: MODES[step.kind].description && "description" in step ? step.description : "",
    duration: null,
    mode: toMode(step),
    videoMedia: null,
    order,
  };
}

function toMode(step: MachineStep): McStepMode {
  const mapping = MODES[step.kind];
  let deviceSettings: McDeviceSetting[] | null = null;
  if (mapping.deviceSettingsKeys) {
    const values = apiSettings(step);
    const setting: McDeviceSetting = { order: 0 };
    for (const key of mapping.deviceSettingsKeys) {
      const value = values[key];
      if (value === undefined) throw new Error(`${step.kind} has no value for ${key}`);
      setting[key] = value;
    }
    deviceSettings = [setting];
  }
  let modeSetting: Record<string, string> | null = null;
  if (mapping.modeSettingKeys) {
    const values = apiModeSettings(step);
    modeSetting = {};
    for (const key of mapping.modeSettingKeys) {
      const value = values[key];
      if (value === undefined) throw new Error(`${step.kind} has no value for ${key}`);
      modeSetting[key] = value;
    }
  }
  return { type: mapping.apiType, modeSetting, deviceSettings };
}

// Amounts travel as strings. Numbers lose floating point noise (0.1 + 0.2 becomes "0.3").
export function formatAmount(amount: string | number): string {
  if (typeof amount === "string") return amount;
  return String(Math.round(amount * 1000) / 1000);
}
