// Text and mass helpers for the plausibility checks: reading amounts such as "200 g Sahne"
// from step texts, estimating an ingredient's weight from the unit rules, and following
// what is in the bowl from step to step.
//
// Everything here is a heuristic over recipe text in the output language; the words come
// from the locale pack (src/convert/text.ts). It errs on the side of not reporting: an
// amount it cannot attribute or convert is left out, not guessed.

import type { NormalizedIngredient } from "../ingredients/index.js";
import { UNITS, isUnitCode, normalizeUnit } from "../ingredients/units.js";
import type { Ingredient, RecipeInput, RecipeStep } from "../recipe/schema.js";
import type { Knowledge, UnitsKnowledge } from "./knowledge.js";
import { attributeItem, mentionedItems, type IngredientLinks, type OutputItem } from "./mapping.js";
import type { TextRules } from "./text.js";

const FRACTIONS: Readonly<Record<string, number>> = {
  "½": 0.5,
  "¼": 0.25,
  "¾": 0.75,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 0.125,
};

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  const mixed = /^(\d+)\s*([½¼¾⅓⅔⅛])$/u.exec(trimmed);
  if (mixed?.[1] && mixed[2]) return Number(mixed[1]) + (FRACTIONS[mixed[2]] ?? 0);
  const fraction = FRACTIONS[trimmed];
  if (fraction !== undefined) return fraction;
  const ratio = /^(\d+)\/(\d+)$/.exec(trimmed);
  if (ratio?.[1] && ratio[2] && Number(ratio[2]) !== 0) return Number(ratio[1]) / Number(ratio[2]);
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

const LIST_FRACTIONS: Readonly<Record<string, number>> = { "½": 0.5, "¼": 0.25, "¾": 0.75 };

// An ingredient-list amount: "200", "1 ½", "½", "1,5". Ranges and words give null.
export function parseListAmount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const mixed = /^(\d+)?\s*([½¼¾])$/u.exec(trimmed);
  if (mixed?.[2]) return Number(mixed[1] ?? 0) + (LIST_FRACTIONS[mixed[2]] ?? 0);
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

export interface AmountMention {
  amount: number;
  // A unit code from src/ingredients/units.ts, or null for a bare count ("2 Eier").
  unit: string | null;
  // The words after the amount, which name the ingredient.
  phrase: string;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const amountPatterns = new WeakMap<TextRules, RegExp>();

// "200 g Sahne": a number, an optional unit word of the output language, the words after.
function amountPattern(text: TextRules): RegExp {
  let pattern = amountPatterns.get(text);
  if (!pattern) {
    const units = text.unitWords.map(escapeRegex).join("|");
    pattern = new RegExp(
      `(?<![\\p{L}\\d])(\\d+\\s*[½¼¾⅓⅔⅛]|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|[½¼¾⅓⅔⅛])\\s*(${units || "(?!)"})?(?!\\p{L})\\s*([^,.;:!?()\\d]{1,60})`,
      "giu",
    );
    amountPatterns.set(text, pattern);
  }
  return new RegExp(pattern.source, pattern.flags);
}

// Reads amounts such as "200 g Sahne", "2 Tl Salz" or "2 Eier" from a step text. A number
// followed by a measure word ("20 x 30 cm", "9 Minuten", "Stufe 4") is not an amount.
export function amountMentions(text: TextRules, source: string): AmountMention[] {
  const mentions: AmountMention[] = [];
  for (const match of source.matchAll(amountPattern(text))) {
    const amount = parseNumber(match[1] ?? "");
    if (amount === null) continue;
    const unitWord = match[2];
    const unit = unitWord ? text.unitCode(unitWord) : null;
    if (unitWord && unit === null) continue;
    const phrase = (match[3] ?? "").trim().split(/\s+/).slice(0, 4).join(" ");
    if (phrase === "" || (unitWord === undefined && text.measureWord.test(phrase))) continue;
    mentions.push({ amount, unit, phrase });
  }
  return mentions;
}

// The clauses of a step text: sentences and semicolon parts. A full stop after a word of at
// most three letters ("ca.", "Msp.", "Pck.") is an abbreviation, not a sentence end.
export function clauses(text: string): string[] {
  return text
    .split(/[;!?\n]|(?<!(?<!\p{L})\p{L}{1,3})\.(?=\s+\p{Lu}|\s*$)/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

// Units whose amounts are too small to matter for the bowl.
const NEGLIGIBLE_UNITS = new Set([
  "Prise",
  "Msp",
  "pinch",
  "Spritzer",
  "Tropfen",
  "Schuss",
  "Zehe",
  "clove",
  "Blatt",
]);

// Whether a text names one of the words (stems of the output language).
export function hasAny(text: TextRules, source: string, stems: readonly string[]): boolean {
  return text.matchScore(text.nameKeys(source), stems) > 0;
}

// Grams per millilitre for a food name; water-like when nothing matches. The density words
// of every pack count, so a source ingredient in another language finds its density too.
export function densityOf(text: TextRules, food: string, units: UnitsKnowledge): number {
  const keys = text.nameKeys(food);
  for (const [key, list] of Object.entries(text.densityWords)) {
    if (text.matchScore(keys, list.map(text.stem)) > 0) {
      const value = units.densities[key];
      if (typeof value === "number") return value;
    }
  }
  return 1;
}

function spellings(code: string): string[] {
  const base = [code];
  if (isUnitCode(code)) base.push(...UNITS[code].label, ...UNITS[code].aliases);
  return base.map((spelling) => spelling.toLowerCase().replace(/\.$/, ""));
}

function mappingFor(code: string, units: UnitsKnowledge) {
  const names = new Set(spellings(code));
  return units.freeTextMapping.find((entry) =>
    entry.input.some((input) => names.has(input.toLowerCase().replace(/\.$/, ""))),
  );
}

// Grams of one piece from the pack's piece weights, matched on the name before the comma.
export function pieceWeight(text: TextRules, food: string, units: UnitsKnowledge): number | null {
  const keys = text.nameKeys(food);
  if (keys.length === 0) return null;
  for (const item of units.pieceWeights.items) {
    const core = item.name.split(",")[0] ?? item.name;
    if (text.matchScore(keys, text.nameKeys(core)) === 2) return item.grams;
  }
  return null;
}

function namedValue(
  text: TextRules,
  food: string,
  table: Readonly<Record<string, number>>,
): number | null {
  const keys = text.nameKeys(food);
  for (const [name, value] of Object.entries(table)) {
    if (text.matchScore(keys, text.nameKeys(name.split(",")[0] ?? name)) === 2) return value;
  }
  return null;
}

// The first value a list of names gives, in order: the source name before a translation.
function firstOf<T>(names: readonly string[], value: (name: string) => T | null): T | null {
  for (const name of names) {
    const found = value(name);
    if (found !== null) return found;
  }
  return null;
}

// Grams for an amount in a unit, or null when the unit rules give no conversion. `food` is
// the name, or several names tried in order (a source name and its list name).
export function gramsFor(
  text: TextRules,
  amount: number,
  unit: string | null,
  food: string | readonly string[],
  units: UnitsKnowledge,
): number | null {
  const names = typeof food === "string" ? [food] : food;
  const piece = () => firstOf(names, (name) => pieceWeight(text, name, units));
  if (unit !== null && NEGLIGIBLE_UNITS.has(unit)) return 0;
  if (unit === null) {
    const grams = piece();
    return grams === null ? null : amount * grams;
  }
  const mapping = mappingFor(unit, units);
  const perUnit = mapping?.gramsPerUnit;
  if (typeof perUnit === "number") return amount * perUnit;
  if (perUnit && typeof perUnit === "object") {
    const value = firstOf(names, (name) => namedValue(text, name, perUnit));
    return value === null ? null : amount * value;
  }
  if (typeof perUnit === "string") {
    if (perUnit === "pieceWeights") {
      const grams = piece();
      return grams === null ? null : amount * grams;
    }
    const density = /^([\d.]+)?\s*(?:ml\s*)?\*?\s*density$/.exec(perUnit.trim());
    if (density) {
      const known = names.find((name) => densityOf(text, name, units) !== 1) ?? names[0] ?? "";
      return amount * Number(density[1] ?? 1) * densityOf(text, known, units);
    }
    return null;
  }
  // No usable mapping: pieces such as Stange or Knolle may still have a piece weight.
  const grams = piece();
  return grams === null ? null : amount * grams;
}

// Estimated grams of a source ingredient, the upper end of a range. Null when unknown.
// `alsoNamed` are the list names it became, tried after its own name for piece weights and
// densities.
export function ingredientGrams(
  text: TextRules,
  ingredient: NormalizedIngredient,
  units: UnitsKnowledge,
  alsoNamed: readonly string[] = [],
): number | null {
  if (ingredient.source === "unparsed") return null;
  const amount = ingredient.quantityMax ?? ingredient.quantity;
  // No amount: a to-taste item such as "Salz zum Abschmecken" when it has no unit either.
  if (amount === null) {
    return ingredient.unit === null || NEGLIGIBLE_UNITS.has(ingredient.unit) ? 0 : null;
  }
  if (ingredient.weightGrams !== undefined) return amount * ingredient.weightGrams;
  return gramsFor(text, amount, ingredient.unit, [ingredient.food, ...alsoNamed], units);
}

// The unit code of a list entry's unit: the pack's spelling, else the source vocabulary,
// else the text as written. An empty unit is null.
export function listUnit(text: TextRules, unit: string): string | null {
  const trimmed = unit.trim();
  if (trimmed === "") return null;
  return text.unitCode(trimmed) ?? normalizeUnit(trimmed)?.code ?? trimmed;
}

// Grams of one ingredient-list entry, or null when the amount or unit is unknown.
export function entryGrams(
  text: TextRules,
  entry: Ingredient,
  units: UnitsKnowledge,
): number | null {
  const unit = listUnit(text, entry.unit);
  const amount = typeof entry.amount === "number" ? entry.amount : parseListAmount(entry.amount);
  if (amount === null) {
    const empty = typeof entry.amount === "string" && entry.amount.trim() === "";
    return empty && (unit === null || NEGLIGIBLE_UNITS.has(unit)) ? 0 : null;
  }
  return gramsFor(text, amount, unit, entry.name, units);
}

export interface BowlState {
  // Known grams in the bowl; a lower bound when unknown is true.
  grams: number;
  unknown: boolean;
  flourGrams: number;
  liquidGrams: number;
  liquidUnknown: boolean;
  foaming: boolean;
  // Estimated temperature of the contents in °C: room temperature for cold contents, the
  // highest temperature a heated step set since then, lowered by every cold addition to
  // the mixing temperature (known grams only).
  temperature: number;
  whisk: boolean;
}

export interface StepTrace {
  index: number;
  step: RecipeStep;
  text: string;
  before: BowlState;
  after: BowlState;
}

// The text of a step for the checks. A text or turbo step's title only summarizes its
// description (the bridge derives text step titles from the description), so only the
// description counts. A scale step's title ("200 g Sahne") counts when the description does
// not repeat it.
export function stepText(step: RecipeStep): string {
  if (!("description" in step)) return step.title;
  if (step.kind !== "scale") return step.description;
  const title = step.title.replace(/…$/, "").trim();
  return step.description.includes(title) ? step.description : `${step.title}\n${step.description}`;
}

export function stepTemperature(step: RecipeStep): number {
  if (step.kind === "steaming") return 100;
  return "temperature" in step ? step.temperature : 0;
}

const emptyBowl = (temperature: number): BowlState => ({
  grams: 0,
  unknown: false,
  flourGrams: 0,
  liquidGrams: 0,
  liquidUnknown: false,
  foaming: false,
  temperature,
  whisk: false,
});

// The temperature after adding grams at addedTemperature (room temperature, or
// HOT_ADDITION_C for a hot addition) to the contents.
export function mixedTemperature(
  grams: number,
  temperature: number,
  addedGrams: number,
  addedTemperature: number,
): number {
  const total = grams + addedGrams;
  if (addedGrams <= 0 || total <= 0) return addedGrams > 0 ? addedTemperature : temperature;
  return (Math.max(0, grams) * temperature + addedGrams * addedTemperature) / total;
}

// Additions that are hot already ("heiße Brühe", "kochendes Wasser") count at this
// temperature, not at room temperature, when the bowl temperature is followed.
export const HOT_ADDITION_C = 80;

// Estimated grams of a list item: the source lines it comes from when it alone takes them
// and all have a known weight (the amounts the converter was given), else its list entries.
export function itemGrams(
  knowledge: Knowledge,
  links: IngredientLinks,
  item: number,
  inputs: readonly NormalizedIngredient[],
): number | null {
  const text = knowledge.text;
  const entry = links.items[item];
  if (!entry) return null;
  const cluster = links.clusters[links.clusterOfItem[item] ?? -1];
  if (cluster && cluster.items.length === 1 && cluster.inputs.length > 0) {
    let sum = 0;
    let known = true;
    for (const position of cluster.inputs) {
      const ingredient = inputs[position];
      const grams = ingredient
        ? ingredientGrams(text, ingredient, knowledge.units, [entry.name])
        : null;
      if (grams === null) {
        known = false;
        break;
      }
      sum += grams;
    }
    if (known) return sum;
  }
  let sum = 0;
  for (const { entry: listed } of entry.entries) {
    const grams = entryGrams(text, listed, knowledge.units);
    if (grams === null) return null;
    sum += grams;
  }
  return sum;
}

// Follows the bowl through the recipe. Scale steps add their weight unless they weigh
// onto the steamer, a plate or into another container; text steps with an adding verb add
// the list items they name (their stated amount, else the estimated weight of the whole
// item). Transferring or rinsing empties the bowl. Every item counts once. Heated steps
// raise the temperature of the contents; cold additions lower it to the mixing
// temperature, so a sauté followed by a litre of stock counts as cold again. Additions
// described as hot count at HOT_ADDITION_C.
export function traceBowl(
  recipe: RecipeInput,
  inputs: readonly NormalizedIngredient[],
  knowledge: Knowledge,
  links: IngredientLinks,
): StepTrace[] {
  const text = knowledge.text;
  const units = knowledge.units;
  const counted = new Set<number>();
  const fromText = new Map<number, number>();
  const room = knowledge.timing.constants.startTemperatureC;
  let state: BowlState = emptyBowl(room);
  const traces: StepTrace[] = [];

  const addContents = (grams: number, label: string, temperature = room) => {
    state.temperature = mixedTemperature(state.grams, state.temperature, grams, temperature);
    state.grams += grams;
    if (hasAny(text, label, text.flourWords)) state.flourGrams += grams;
    if (hasAny(text, label, text.liquidWords)) state.liquidGrams += grams;
    if (hasAny(text, label, text.foamingWords)) state.foaming = true;
  };

  recipe.servingSize.steps.forEach((step, position) => {
    const before = { ...state };
    const source = stepText(step);
    const added = text.hot.test(source) ? HOT_ADDITION_C : room;
    if (step.kind === "text") {
      if (text.emptying.test(source)) {
        state = { ...emptyBowl(room), whisk: state.whisk };
        fromText.clear();
      } else if (text.cooling.test(source)) {
        state.temperature = room;
      }
      if (text.whisk.accessory.test(source)) {
        if (text.whisk.remove.test(source)) state.whisk = false;
        else if (text.whisk.fit.test(source)) state.whisk = true;
      }
      if (text.adding.test(source)) {
        const outside = text.outsideBowl.test(source);
        const mentions = amountMentions(text, source);
        for (const item of mentionedItems(text, source, links)) {
          if (counted.has(item)) continue;
          counted.add(item);
          if (outside) continue;
          const entry: OutputItem | undefined = links.items[item];
          if (!entry) continue;
          const stated = mentions.find(
            (mention) => attributeItem(text, mention.phrase, links) === item,
          );
          const grams = stated
            ? gramsFor(text, stated.amount, stated.unit, entry.name, units)
            : itemGrams(knowledge, links, item, inputs);
          if (grams === null) {
            state.unknown = true;
            if (hasAny(text, entry.name, text.liquidWords)) state.liquidUnknown = true;
            if (hasAny(text, entry.name, text.foamingWords)) state.foaming = true;
            continue;
          }
          fromText.set(item, grams);
          addContents(grams, entry.name, added);
        }
        // Liquids the ingredient list does not have, such as water for steaming.
        if (!outside) {
          for (const mention of mentions) {
            if (attributeItem(text, mention.phrase, links) !== null) continue;
            if (!hasAny(text, mention.phrase, text.liquidWords)) continue;
            const grams = gramsFor(text, mention.amount, mention.unit, mention.phrase, units);
            if (grams !== null && mention.unit !== null) addContents(grams, mention.phrase, added);
          }
          if (
            hasAny(text, source, text.waterWords) &&
            !mentions.some((m) => hasAny(text, m.phrase, text.waterWords))
          ) {
            state.liquidUnknown = true;
          }
        }
      }
    } else if (step.kind === "scale") {
      const named = mentionedItems(text, source, links);
      for (const item of named) counted.add(item);
      if (!text.outsideBowl.test(source)) {
        for (const item of named) {
          const earlier = fromText.get(item);
          if (earlier !== undefined) {
            state.grams -= earlier;
            fromText.delete(item);
          }
        }
        addContents(step.grams, source, added);
      }
    } else {
      const temperature = stepTemperature(step);
      if (temperature > 0) state.temperature = Math.max(state.temperature, temperature);
    }
    traces.push({ index: position, step, text: source, before, after: { ...state } });
  });
  return traces;
}
