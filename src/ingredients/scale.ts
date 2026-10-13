// Scales normalized ingredients by the factor from Mealie's servings scaler and rounds
// the result to amounts a cook can measure. The rounding rules per unit kind live in
// ROUNDING, so they are data with one test each.

import type { NormalizedIngredient } from "./normalize.js";
import { unitKind, type UnitKind } from "./units.js";

export type ScaleFlag =
  // A counted item ended up with a fractional count, such as 1.5 onions.
  | "checkRounding"
  // The line could not be parsed, so its amount was not scaled.
  | "unscaled";

export interface ScaledIngredient extends NormalizedIngredient {
  // The amounts before scaling.
  baseQuantity: number | null;
  baseQuantityMax: number | null;
  flags: ScaleFlag[];
}

// Used only when a recipe states neither servings nor a yield and was not scaled.
export const DEFAULT_SERVINGS = 4;
// The servings range a Monsieur Cuisine recipe accepts.
export const MIN_SERVINGS = 1;
export const MAX_SERVINGS = 24;

const clean = (value: number): number => Math.round(value * 1000) / 1000;
const toStep = (value: number, step: number): number => clean(Math.round(value / step) * step);

interface RoundingRule {
  round: (value: number) => number;
  // The smallest amount a positive value may round to.
  minimum: number;
}

export const ROUNDING: Readonly<Record<Exclude<UnitKind, "pinch">, RoundingRule>> = {
  // g and ml: from 100 to the nearest 5, from 10 to the nearest 1, below to one decimal.
  metric: {
    round: (value) =>
      value >= 100 ? toStep(value, 5) : value >= 10 ? toStep(value, 1) : toStep(value, 0.1),
    minimum: 0.1,
  },
  // kg and l: two decimals.
  metricLarge: { round: (value) => toStep(value, 0.01), minimum: 0.01 },
  // EL, TL, tbsp, tsp: nearest half spoon, nearest quarter below one spoon.
  spoon: {
    round: (value) => (value < 1 ? toStep(value, 0.25) : toStep(value, 0.5)),
    minimum: 0.25,
  },
  cup: { round: (value) => toStep(value, 0.25), minimum: 0.25 },
  ounce: {
    round: (value) => (value < 1 ? toStep(value, 0.25) : toStep(value, 0.5)),
    minimum: 0.25,
  },
  pound: { round: (value) => toStep(value, 0.25), minimum: 0.25 },
  // Pieces, cloves, cans and everything else that is counted: nearest half.
  count: { round: (value) => toStep(value, 0.5), minimum: 0.5 },
};

// A pinch stays a pinch: unchanged from half the recipe up, otherwise one pinch.
export const PINCH_MIN_FACTOR = 0.5;

function roundAmount(value: number, kind: Exclude<UnitKind, "pinch">): number {
  const rule = ROUNDING[kind];
  const rounded = rule.round(value);
  return rounded > 0 ? rounded : rule.minimum;
}

function scaleOne(item: NormalizedIngredient, factor: number): ScaledIngredient {
  const base = {
    ...item,
    baseQuantity: item.quantity,
    baseQuantityMax: item.quantityMax,
    flags: [] as ScaleFlag[],
  };
  if (factor === 1) return base;
  if (item.source === "unparsed") return { ...base, flags: ["unscaled"] };
  if (item.quantity === null) return base;

  const kind = unitKind(item.unit);
  if (kind === "pinch") {
    if (factor >= PINCH_MIN_FACTOR) return base;
    return { ...base, quantity: 1, quantityMax: null };
  }

  const quantity = roundAmount(item.quantity * factor, kind);
  let quantityMax = item.quantityMax === null ? null : roundAmount(item.quantityMax * factor, kind);
  if (quantityMax !== null && quantityMax <= quantity) quantityMax = null;

  const flags: ScaleFlag[] = [];
  const fractional = [quantity, quantityMax].some(
    (value) => value !== null && !Number.isInteger(value),
  );
  if (kind === "count" && fractional) flags.push("checkRounding");
  return { ...base, quantity, quantityMax, flags };
}

export function scaleIngredients(
  items: readonly NormalizedIngredient[],
  factor: number,
): ScaledIngredient[] {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError(`Scale factor must be a positive number, got ${factor}`);
  }
  return items.map((item) => scaleOne(item, factor));
}

export interface ServingsInfo {
  recipeServings: number;
  recipeYieldQuantity: number;
}

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

// The amount Mealie's servings scaler starts from: recipeServings, else
// recipeYieldQuantity. Null when the recipe states neither; Mealie then starts from 1.
export function scalerBase(recipe: ServingsInfo): number | null {
  if (positive(recipe.recipeServings)) return recipe.recipeServings;
  if (positive(recipe.recipeYieldQuantity)) return recipe.recipeYieldQuantity;
  return null;
}

// Servings for the scaled recipe, as the user picked them in Mealie's scaler:
// base × recipe_scale. A recipe without servings and yield that was not scaled counts as
// DEFAULT_SERVINGS. The result is limited to the range the device accepts.
export function servingsFor(recipe: ServingsInfo, factor: number): number {
  const scale = positive(factor) ? factor : 1;
  const base = scalerBase(recipe);
  const servings = base === null && scale === 1 ? DEFAULT_SERVINGS : (base ?? 1) * scale;
  return Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, Math.round(servings)));
}
