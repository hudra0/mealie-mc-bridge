// The serving size of the Monsieur Cuisine recipe: an amount and a unit, as the recipe card
// on the device shows them ("4 Portionen", "10 Scheiben", "12 Muffins").
//
// Mealie keeps two numbers: recipeServings, and recipeYieldQuantity with the free text
// recipeYield ("Scheiben"). A yield with a text names what the recipe makes, so it wins;
// servings alone become the pack's word for portions. Both are multiplied by the scale the
// user picked in Mealie. A recipe with neither gets a default the converter may replace with
// its own estimate, which it must then flag in a review hint.

import { servingsFor, type ServingsRange } from "../ingredients/index.js";
import { plainText } from "../mealie/index.js";
import type { PackUnits } from "../locale/pack.js";
import { SCHEMA_LIMITS } from "../recipe/schema.js";

// Where the serving size came from: the yield (quantity and text), the servings, or nowhere
// (a default the converter may estimate over).
export type ServingsSource = "yield" | "servings" | "estimate";

export interface ServingSize {
  amount: number;
  unit: string;
  source: ServingsSource;
}

export interface ServingSizeInput {
  recipeServings: number;
  recipeYieldQuantity: number;
  recipeYield: string | null;
}

export type ServingWords = PackUnits["servings"];

// "12 Muffins", "4-6 Portionen" and "ca. 10 Stück" carry the count again; the quantity
// field holds it already.
const LEADING_COUNT =
  /^(?:ca\.?\s+|approx\.?\s+|about\s+|etwa\s+)?\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*/iu;

// The yield text as a serving unit in the style of the pack: plain text, without a leading
// count, the first letter cased like official recipes write it, at most `maxLength`
// characters (cut at a word). Singular or plural stay as written. Null when nothing usable
// is left.
export function servingUnitText(
  raw: string | null | undefined,
  words: Pick<ServingWords, "unitCase">,
  maxLength: number = SCHEMA_LIMITS.servingUnit.max,
): string | null {
  let text = plainText(raw).replace(/\s+/g, " ").trim().replace(LEADING_COUNT, "").trim();
  if (!/\p{L}/u.test(text)) return null;
  if (text.length > maxLength) {
    const head = text.slice(0, maxLength + 1);
    const space = head.lastIndexOf(" ");
    text = (space > 0 ? head.slice(0, space) : text.slice(0, maxLength)).trim();
  }
  const first = text.charAt(0);
  const second = text.charAt(1);
  // An abbreviation in capitals ("XL Muffins") keeps its case.
  const keep = second !== "" && second === second.toUpperCase() && second !== second.toLowerCase();
  const cased =
    words.unitCase === "capitalize" ? first.toUpperCase() : keep ? first : first.toLowerCase();
  return cased + text.slice(1);
}

export function portionWord(amount: number, words: Pick<ServingWords, "portion">): string {
  return amount === 1 ? words.portion.singular : words.portion.plural;
}

export function servingSizeFor(
  recipe: ServingSizeInput,
  scale: number,
  range: ServingsRange,
  words: ServingWords,
): ServingSize {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const clamp = (value: number) => Math.min(range.max, Math.max(range.min, Math.round(value)));
  if (recipe.recipeYieldQuantity > 0) {
    const unit = servingUnitText(recipe.recipeYield, words);
    if (unit !== null) {
      return { amount: clamp(recipe.recipeYieldQuantity * factor), unit, source: "yield" };
    }
  }
  // servingsFor starts from recipeServings, else a yield quantity without a text, as
  // Mealie's scaler does, and falls back to its default when there is neither.
  const amount = servingsFor(recipe, factor, range);
  const known = recipe.recipeServings > 0 || recipe.recipeYieldQuantity > 0;
  return { amount, unit: portionWord(amount, words), source: known ? "servings" : "estimate" };
}

// "10 Scheiben".
export function formatServingSize(size: { amount: number; unit: string | null }): string {
  return size.unit ? `${size.amount} ${size.unit}` : String(size.amount);
}
