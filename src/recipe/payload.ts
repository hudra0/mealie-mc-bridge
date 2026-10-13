// Builds the Monsieur Cuisine API payload from a validated RecipeInput.
//
// Field layout ported from SmartRecipe src/recipes/payload.ts (MIT,
// https://github.com/gerkensm/smart-recipe), checked against the live API on 2026-10-13:
// one serving size, ingredient order from 1, group and step order from 0, amounts as
// strings, integer nutrients, empty descriptions on program steps. The language, the
// complexity ids and the default group name come from the locale pack (mc.json).

import { normalizeIngredientName } from "../ingredients/catalog.js";
import {
  isWritableStatus,
  type McDeviceSetting,
  type McMediaRef,
  type McRecipePayload,
  type McStepMode,
  type McStepPayload,
  type McWritableStatus,
} from "../mc/types.js";
import type { DeviceLimits, ModeLimits } from "./limits.js";
import { MODES, apiModeSettings, apiSettings } from "./modes.js";
import type { IngredientGroup, MachineStep, RecipeInput, RecipeStep } from "./schema.js";

// What the payload needs to know about the locale: its id (languageLocale), the complexity
// ids, which differ per locale, and the name the web editor gives an unnamed ingredient
// group. The mc.json of a locale pack has these fields.
export interface PayloadLocale {
  locale: string;
  complexityIds: Readonly<Record<RecipeInput["complexity"], number>>;
  defaultGroupName: string;
}

export const NUTRIENT_UNITS: Readonly<Record<string, string>> = {
  calories: "kCal",
  carbohydrate: "g",
  fat: "g",
  protein: "g",
};

export interface BuildPayloadOptions {
  // The locale the recipe is written for; it must match the recipe's locale.
  locale: PayloadLocale;
  // Set by the code, never by the model. The server creates every recipe as a draft;
  // "private-publish" takes effect through McClient.setStatus.
  status: McWritableStatus;
  detailsMediaId?: number | null;
  thumbnailMediaId?: number | null;
  // Overrides input.categoryIds, for example after filtering against the live catalog.
  categoryIds?: readonly number[];
  // systemIngredientId per ingredient, keyed by normalizeIngredientName(name). Names that
  // are missing or map to null go out with systemIngredientId null.
  ingredientIds?: ReadonlyMap<string, number | null>;
}

// The API keys per program, the steps that keep their description and the device type ids
// come from the knowledge file, the same limits the validator checked the input against.
export function buildMcPayload(
  input: RecipeInput,
  limits: DeviceLimits,
  options: BuildPayloadOptions,
): McRecipePayload {
  if (!isWritableStatus(options.status)) {
    throw new TypeError(`Refusing to build a payload with status "${String(options.status)}"`);
  }
  const locale = options.locale;
  if (input.locale !== locale.locale) {
    throw new TypeError(
      `The recipe is written for ${input.locale}, but the payload is built for ${locale.locale}`,
    );
  }
  const serving = input.servingSize;
  return {
    status: options.status,
    source: "member",
    languageLocale: locale.locale,
    deviceTypeIds: [...limits.recipe.deviceTypeIds],
    title: input.title,
    description: input.description,
    thumbnail: mediaRef(options.thumbnailMediaId),
    detailsImage: mediaRef(options.detailsMediaId),
    complexityId: locale.complexityIds[input.complexity],
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
          toGroup(group, index, locale.defaultGroupName, options.ingredientIds),
        ),
        steps: serving.steps.map((step, order) => toStep(step, order, limits)),
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

function toGroup(
  group: IngredientGroup,
  index: number,
  defaultName: string,
  ingredientIds: ReadonlyMap<string, number | null> | undefined,
) {
  return {
    name: group.name.trim() === "" ? defaultName : group.name,
    isDefault: index === 0,
    order: index,
    ingredients: group.ingredients.map((ingredient, position) => ({
      name: ingredient.name,
      isOptional: ingredient.isOptional,
      unit: ingredient.unit,
      amount: formatAmount(ingredient.amount),
      systemIngredientId: ingredientIds?.get(normalizeIngredientName(ingredient.name)) ?? null,
      order: position + 1,
      ingredientCategory: null,
      iconUrl: null,
    })),
  };
}

function toStep(step: RecipeStep, order: number, limits: DeviceLimits): McStepPayload {
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
  const mode = limits.mode(step.kind);
  if (!mode) throw new Error(`The knowledge file has no entry for ${step.kind}`);
  return {
    title: step.title,
    // Program steps the device does not show a description for go out with an empty one.
    // The validator reads the same list.
    description:
      limits.recipe.stepDescription.requiredOn.includes(step.kind) && "description" in step
        ? step.description
        : "",
    duration: null,
    mode: toMode(step, mode),
    videoMedia: null,
    order,
  };
}

function toMode(step: MachineStep, mode: ModeLimits): McStepMode {
  let deviceSettings: McDeviceSetting[] | null = null;
  if (mode.deviceSettingsKeys) {
    const values: Record<string, number | boolean | undefined> = apiSettings(step);
    const setting: McDeviceSetting = { order: 0 };
    for (const key of mode.deviceSettingsKeys) {
      if (key === "order") continue;
      const value = values[key];
      if (value === undefined) throw new Error(`${step.kind} has no value for ${key}`);
      setting[key] = value;
    }
    deviceSettings = [setting];
  }
  let modeSetting: Record<string, string> | null = null;
  if (mode.modeSettingKeys) {
    const values: Record<string, string | undefined> = apiModeSettings(step);
    modeSetting = {};
    for (const key of mode.modeSettingKeys) {
      const value = values[key];
      if (value === undefined) throw new Error(`${step.kind} has no value for ${key}`);
      modeSetting[key] = value;
    }
  }
  return { type: MODES[step.kind].apiType, modeSetting, deviceSettings };
}

// Amounts travel as strings. Numbers lose floating point noise (0.1 + 0.2 becomes "0.3").
export function formatAmount(amount: string | number): string {
  if (typeof amount === "string") return amount;
  return String(Math.round(amount * 1000) / 1000);
}
