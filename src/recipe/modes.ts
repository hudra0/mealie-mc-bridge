// Mapping from our machine step kinds to the Monsieur Cuisine smart (MC3.0) recipe API.
//
// Ported from SmartRecipe src/recipes/modes.ts and src/recipes/constants.ts
// (MIT, https://github.com/gerkensm/smart-recipe), with the step kinds renamed to the API's
// own snake_case type strings. Only what the knowledge file does not say lives here: the
// API type string, the input granularity of the time and how input fields turn into API
// settings. The API keys per program, which steps carry a description, the device type
// id and every numeric limit are read from knowledge/device-programs.json.

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
  // Input granularity of the time: "s" minutes and seconds, "min" whole minutes,
  // null no time. The API always stores seconds.
  timeUnit: "s" | "min" | null;
}

export const MODES: Readonly<Record<MachineStepKind, ModeMapping>> = {
  customized: { apiType: "customized", timeUnit: "s" },
  roasting: { apiType: "roasting", timeUnit: "s" },
  steaming: { apiType: "steaming", timeUnit: "s" },
  kneading_solid_dough: { apiType: "kneading_solid_dough", timeUnit: "s" },
  kneading_soft_dough: { apiType: "kneading_soft_dough", timeUnit: "s" },
  kneading_liquid_dough: { apiType: "kneading_liquid_dough", timeUnit: "s" },
  puree: { apiType: "puree", timeUnit: "s" },
  smoothie: { apiType: "smoothie", timeUnit: "s" },
  turbo: { apiType: "turbo", timeUnit: "s" },
  scale: { apiType: "scale", timeUnit: null },
  slow_cooking: { apiType: "slow_cooking", timeUnit: "min" },
  sous_vide: { apiType: "sous_vide", timeUnit: "min" },
  fermentation: { apiType: "fermentation", timeUnit: "min" },
  rice_cooking: { apiType: "rice_cooking", timeUnit: "s" },
  cooking_eggs: { apiType: "cooking_eggs", timeUnit: null },
  precleaning: { apiType: "precleaning", timeUnit: null },
  food_processor: { apiType: "food_processor", timeUnit: "s" },
};

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
