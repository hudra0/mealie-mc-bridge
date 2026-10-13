// Turns Mealie's ingredient list into one uniform shape. Ingredients that Mealie has
// parsed (a food or a unit is set) are taken as they are. Free-text ingredients, which
// imported recipes often have, go through the deterministic parser. Lines the parser
// cannot read are kept as "unparsed" with their original text, so nothing is lost.

import type { MealieIngredient, MealieRecipe, MealieUnit } from "../mealie/types.js";
import { cleanIngredientText, mentionsOptional, parseIngredientLine } from "./parse.js";
import type { ParsedIngredient } from "./parse.js";
import { normalizeUnit } from "./units.js";

export type IngredientSource = "structured" | "parsed" | "unparsed";

export interface NormalizedIngredient {
  // Position in the recipe's ingredient list.
  index: number;
  section: string | null;
  quantity: number | null;
  quantityMax: number | null;
  // A unit code from units.ts, or Mealie's own unit name when it is not in the vocabulary.
  unit: string | null;
  food: string;
  note: string;
  optional: boolean;
  source: IngredientSource;
  // The line as the user or the importer wrote it.
  original: string;
  referenceId: string | null;
  weightGrams?: number;
}

// Below this parser confidence a line counts as not understood.
export const MIN_CONFIDENCE = 0.5;

function unitOf(unit: MealieUnit | null): { code: string | null; factor: number } {
  if (!unit) return { code: null, factor: 1 };
  const spellings = [unit.abbreviation, unit.name, unit.pluralName, unit.pluralAbbreviation];
  for (const spelling of spellings) {
    const match = normalizeUnit(spelling);
    if (match) return { code: match.code, factor: match.factor };
  }
  const raw = [unit.abbreviation, unit.name].map((value) => value?.trim() ?? "").find(Boolean);
  return { code: raw ?? null, factor: 1 };
}

function originalOf(ingredient: MealieIngredient): string {
  const candidates = [ingredient.originalText, ingredient.display, ingredient.note];
  return candidates.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
}

function structured(ingredient: MealieIngredient, index: number, section: string | null) {
  const unit = unitOf(ingredient.unit);
  const quantity =
    ingredient.quantity !== null && ingredient.quantity > 0
      ? Math.round(ingredient.quantity * unit.factor * 1000) / 1000
      : null;
  const note = ingredient.note?.trim() ?? "";
  const foodName = ingredient.food?.name.trim() ?? "";
  const item: NormalizedIngredient = {
    index,
    section,
    quantity,
    quantityMax: null,
    unit: unit.code,
    food: foodName || note,
    note: foodName ? note : "",
    optional: mentionsOptional(note),
    source: "structured",
    original: originalOf(ingredient),
    referenceId: ingredient.referenceId,
  };
  return item;
}

interface Candidate {
  text: string;
  result: ParsedIngredient;
}

// Of note, originalText and display, the text whose parse carries the most information.
function richest(ingredient: MealieIngredient): Candidate | null {
  const texts = [ingredient.originalText, ingredient.note, ingredient.display]
    .map((value) => value?.trim() ?? "")
    .filter((value, position, all) => value !== "" && all.indexOf(value) === position);
  const score = ({ text, result }: Candidate): number[] => [
    result.parsed && result.confidence >= MIN_CONFIDENCE ? 1 : 0,
    result.quantity === null ? 0 : 1,
    result.unit === null ? 0 : 1,
    text.length,
  ];
  let best: Candidate | null = null;
  for (const text of texts) {
    const candidate = { text, result: parseIngredientLine(text) };
    if (!best || compare(score(candidate), score(best)) > 0) best = candidate;
  }
  return best;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function headerTitle(text: string): string {
  return cleanIngredientText(text)
    .replace(/^#+ /, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/:$/, "")
    .trim();
}

export function normalizeIngredients(
  recipe: Pick<MealieRecipe, "recipeIngredient">,
): NormalizedIngredient[] {
  const items: NormalizedIngredient[] = [];
  let section: string | null = null;

  recipe.recipeIngredient.forEach((ingredient, index) => {
    const title = ingredient.title?.trim();
    if (title) section = title;

    if (ingredient.food !== null || ingredient.unit !== null) {
      items.push(structured(ingredient, index, section));
      return;
    }

    const best = richest(ingredient);
    if (!best) return;
    // Imported recipes often carry headers such as "Für den Teig:" as ingredient lines.
    if (!best.result.parsed) {
      section = headerTitle(best.text) || section;
      return;
    }

    const understood = best.result.confidence >= MIN_CONFIDENCE;
    const item: NormalizedIngredient = {
      index,
      section,
      quantity: understood ? best.result.quantity : null,
      quantityMax: understood ? best.result.quantityMax : null,
      unit: understood ? best.result.unit : null,
      food: understood ? best.result.food : cleanIngredientText(best.text),
      note: understood ? best.result.note : "",
      optional: best.result.optional,
      source: understood ? "parsed" : "unparsed",
      original: originalOf(ingredient),
      referenceId: ingredient.referenceId,
    };
    if (understood && best.result.weightGrams !== undefined) {
      item.weightGrams = best.result.weightGrams;
    }
    items.push(item);
  });

  return items;
}
