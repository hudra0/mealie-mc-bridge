// Mapping from our machine step kinds to the Monsieur Cuisine smart (MC3.0) recipe API.
//
// Ported from SmartRecipe src/recipes/modes.ts and src/recipes/constants.ts
// (MIT, https://github.com/gerkensm/smart-recipe), with the step kinds renamed to the API's
// own snake_case type strings and the key lists checked against the live API on
// 2026-10-13. The numeric limits are not here: they live in knowledge/device-programs.json.

import type { MachineStep } from "./schema.js";

export const MACHINE_STEP_KINDS = [
  "customized",
  "roasting",
  "steaming",
  "kneading_solid_dough",
  "kneading_soft_dough",
  "kneading_liquid_dough",
  "puree",
  "smoothie",
  "turbo",
  "scale",
  "slow_cooking",
  "sous_vide",
  "fermentation",
  "rice_cooking",
  "cooking_eggs",
  "precleaning",
  "food_processor",
] as const;

export type MachineStepKind = (typeof MACHINE_STEP_KINDS)[number];

export type DeviceSettingKey = "temperature" | "speed" | "time" | "clockwise" | "weight";
export type ModeSettingKey = "size" | "texture" | "duration";

export interface ModeMapping {
  // The API's mode.type.
  apiType: string;
  // Keys of the single deviceSettings entry, besides order. null: the mode sends
  // deviceSettings null and a modeSetting instead.
  deviceSettingsKeys: readonly DeviceSettingKey[] | null;
  modeSettingKeys: readonly ModeSettingKey[] | null;
  // Input granularity of the time: "s" minutes and seconds, "min" whole minutes,
  // null no time. The API always stores seconds.
  timeUnit: "s" | "min" | null;
  // Whether the device shows the step description. Only these steps carry one.
  description: boolean;
}

export const MODES: Readonly<Record<MachineStepKind, ModeMapping>> = {
  customized: {
    apiType: "customized",
    deviceSettingsKeys: ["temperature", "speed", "time", "clockwise"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  roasting: {
    apiType: "roasting",
    deviceSettingsKeys: ["temperature", "time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  steaming: {
    apiType: "steaming",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  kneading_solid_dough: {
    apiType: "kneading_solid_dough",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  kneading_soft_dough: {
    apiType: "kneading_soft_dough",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  kneading_liquid_dough: {
    apiType: "kneading_liquid_dough",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  puree: {
    apiType: "puree",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  smoothie: {
    apiType: "smoothie",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  turbo: {
    apiType: "turbo",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: true,
  },
  scale: {
    apiType: "scale",
    deviceSettingsKeys: ["weight"],
    modeSettingKeys: null,
    timeUnit: null,
    description: true,
  },
  slow_cooking: {
    apiType: "slow_cooking",
    deviceSettingsKeys: ["temperature", "time"],
    modeSettingKeys: null,
    timeUnit: "min",
    description: false,
  },
  sous_vide: {
    apiType: "sous_vide",
    deviceSettingsKeys: ["temperature", "time"],
    modeSettingKeys: null,
    timeUnit: "min",
    description: false,
  },
  fermentation: {
    apiType: "fermentation",
    deviceSettingsKeys: ["temperature", "time"],
    modeSettingKeys: null,
    timeUnit: "min",
    description: false,
  },
  rice_cooking: {
    apiType: "rice_cooking",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
  cooking_eggs: {
    apiType: "cooking_eggs",
    deviceSettingsKeys: null,
    modeSettingKeys: ["size", "texture"],
    timeUnit: null,
    description: false,
  },
  precleaning: {
    apiType: "precleaning",
    deviceSettingsKeys: null,
    modeSettingKeys: ["duration"],
    timeUnit: null,
    description: false,
  },
  food_processor: {
    apiType: "food_processor",
    deviceSettingsKeys: ["time"],
    modeSettingKeys: null,
    timeUnit: "s",
    description: false,
  },
};

// Device type id of the Monsieur Cuisine smart (code MC3.0).
export const MC_SMART_DEVICE_TYPE_ID = 13;

// Which input field carries each API setting. Used for error paths.
export const INPUT_FIELD: Readonly<Record<DeviceSettingKey | ModeSettingKey, string>> = {
  temperature: "temperature",
  speed: "speed",
  time: "minutes",
  clockwise: "rotation",
  weight: "grams",
  size: "size",
  texture: "texture",
  duration: "duration",
};

// Program time in seconds. Turbo has only seconds; every other timed step has minutes and
// seconds.
export function stepSeconds(step: MachineStep): number | null {
  if (step.kind === "turbo") return step.seconds;
  if ("minutes" in step) return step.minutes * 60 + step.seconds;
  return null;
}

// The step's settings in API terms: time in seconds, rotation as clockwise, grams as weight.
// Only the keys the step has are present.
export function apiSettings(
  step: MachineStep,
): Partial<Record<DeviceSettingKey, number | boolean>> {
  const settings: Partial<Record<DeviceSettingKey, number | boolean>> = {};
  if ("temperature" in step) settings.temperature = step.temperature;
  if ("speed" in step) settings.speed = step.speed;
  const time = stepSeconds(step);
  if (time !== null) settings.time = time;
  if ("rotation" in step) settings.clockwise = step.rotation !== "left";
  if ("grams" in step) settings.weight = step.grams;
  return settings;
}

export function apiModeSettings(step: MachineStep): Partial<Record<ModeSettingKey, string>> {
  const settings: Partial<Record<ModeSettingKey, string>> = {};
  if ("size" in step) settings.size = step.size;
  if ("texture" in step) settings.texture = step.texture;
  if ("duration" in step) settings.duration = step.duration;
  return settings;
}
