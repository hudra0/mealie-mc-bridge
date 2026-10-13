// Text and mass helpers for the plausibility checks: matching ingredient names in step
// texts, reading amounts such as "200 g Sahne" from them, estimating an ingredient's weight
// from units.json, and following what is in the bowl from step to step.
//
// Everything here is a heuristic over German recipe text. It errs on the side of not
// reporting: an amount it cannot attribute or convert is left out, not guessed.

import { normalizeUnit, type NormalizedIngredient } from "../ingredients/index.js";
import { UNITS, isUnitCode } from "../ingredients/units.js";
import type { RecipeInput, RecipeStep } from "../recipe/schema.js";
import type { Knowledge, UnitsKnowledge } from "./knowledge.js";

// Words that say nothing about which ingredient is meant.
const STOPWORDS = new Set([
  "frisch",
  "frische",
  "frischer",
  "gehackt",
  "gehackte",
  "gemahlen",
  "gemahlener",
  "getrocknet",
  "getrocknete",
  "gewürfelt",
  "gerieben",
  "geriebener",
  "geschält",
  "fein",
  "grob",
  "klein",
  "kleine",
  "groß",
  "große",
  "mittelgroß",
  "mittelgroße",
  "rot",
  "rote",
  "grün",
  "grüne",
  "gelb",
  "weiß",
  "schwarz",
  "bio",
  "extra",
  "nativ",
  "natives",
  "etwa",
  "ca",
  "und",
  "oder",
  "mit",
  "ohne",
  "für",
  "zum",
  "zur",
  "nach",
  "belieben",
  "optional",
  "etwas",
  "tk",
  "tiefgekühlt",
  "zimmerwarm",
  "kalt",
  "warm",
  "weich",
  "in",
  "im",
  "aus",
  "der",
  "die",
  "das",
  "dem",
  "den",
  "von",
  "vom",
  "je",
  "typ",
  "type",
  "größe",
  "abschmecken",
  "garnieren",
  "servieren",
  "verarbeiten",
  "dekoration",
]);

// Endings stripped from German words so singular and plural meet: Zwiebeln/Zwiebel,
// Tomaten/Tomate, Eier/Ei. The same stem is computed on both sides, so it need not be a
// real word.
const ENDINGS = ["en", "er", "n", "e", "s"];

export function stem(word: string): string {
  const lower = word.toLowerCase();
  for (const ending of ENDINGS) {
    if (lower.endsWith(ending) && lower.length - ending.length >= 2) {
      return lower.slice(0, -ending.length);
    }
  }
  return lower;
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/\p{L}+/gu) ?? [];
}

// The stems that identify an ingredient name.
export function nameKeys(name: string): string[] {
  return [
    ...new Set(
      words(name)
        .filter((word) => !STOPWORDS.has(word))
        .map(stem),
    ),
  ].filter((key) => key.length >= 2);
}

// Short last parts of compound names that still identify the ingredient: "Öl" in "Olivenöl".
const SHORT_COMPOUND_TAILS = new Set(["öl"]);

// 2 when a word of the text equals a key, 1 when they match as parts of a compound
// (Gemüsebrühe and Brühe, Knoblauchzehe and Knoblauch), 0 otherwise.
export function matchScore(keys: readonly string[], textStems: readonly string[]): 0 | 1 | 2 {
  let best: 0 | 1 | 2 = 0;
  for (const key of keys) {
    for (const word of textStems) {
      if (word === key) return 2;
      const [short, long] = word.length < key.length ? [word, key] : [key, word];
      const compound =
        (short.length >= 4 && (long.startsWith(short) || long.endsWith(short))) ||
        (SHORT_COMPOUND_TAILS.has(short) && long.endsWith(short));
      if (compound) best = 1;
    }
  }
  return best;
}

export interface IngredientIndex {
  ingredients: readonly NormalizedIngredient[];
  keys: string[][];
}

export function indexIngredients(ingredients: readonly NormalizedIngredient[]): IngredientIndex {
  return { ingredients, keys: ingredients.map((ingredient) => nameKeys(ingredient.food)) };
}

// Positions of the input ingredients a text names, best matches only.
export function mentionedIngredients(text: string, index: IngredientIndex): number[] {
  const stems = words(text).map(stem);
  const scores = index.keys.map((keys) => matchScore(keys, stems));
  const best = Math.max(0, ...scores);
  if (best === 0) return [];
  return scores.flatMap((score, position) => (score === best ? [position] : []));
}

// The one input ingredient a phrase names, or null when it names none or several equally.
export function attributeIngredient(phrase: string, index: IngredientIndex): number | null {
  const found = mentionedIngredients(phrase, index);
  return found.length === 1 ? (found[0] ?? null) : null;
}

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

export interface AmountMention {
  amount: number;
  // A unit code from src/ingredients/units.ts, or null for a bare count ("2 Eier").
  unit: string | null;
  // The words after the amount, which name the ingredient.
  phrase: string;
}

const AMOUNT =
  /(?<![\p{L}\d])(\d+\s*[½¼¾⅓⅔⅛]|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔⅛])\s*(kg|g|ml|l|el|tl|prisen|prise|msp\.?|stück|stk\.?)?(?!\p{L})\s*([^,.;:!?()\d]{1,60})/giu;

// Reads amounts such as "200 g Sahne", "2 Tl Salz" or "2 Eier" from a step text.
export function amountMentions(text: string): AmountMention[] {
  const mentions: AmountMention[] = [];
  for (const match of text.matchAll(AMOUNT)) {
    const amount = parseNumber(match[1] ?? "");
    if (amount === null) continue;
    const unitWord = match[2];
    const unit = unitWord ? (normalizeUnit(unitWord)?.code ?? null) : null;
    if (unitWord && unit === null) continue;
    const phrase = (match[3] ?? "").trim().split(/\s+/).slice(0, 4).join(" ");
    if (phrase === "") continue;
    mentions.push({ amount, unit, phrase });
  }
  return mentions;
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

// German words for the density keys of units.json.
export const DENSITY_WORDS: Readonly<Record<string, readonly string[]>> = {
  water: ["wasser"],
  milk: ["milch"],
  stock: ["brühe", "fond"],
  cream: ["sahne", "rahm"],
  wine: ["wein"],
  oil: ["öl"],
  honey: ["honig"],
  syrup: ["sirup"],
};

// Grams per millilitre for a food name; water-like when nothing matches.
export function densityOf(food: string, units: UnitsKnowledge): number {
  const keys = nameKeys(food);
  for (const [key, list] of Object.entries(DENSITY_WORDS)) {
    if (matchScore(keys, list.map(stem)) > 0) {
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

// Grams of one piece from units.json pieceWeights, matched on the name before the comma.
export function pieceWeight(food: string, units: UnitsKnowledge): number | null {
  const keys = nameKeys(food);
  if (keys.length === 0) return null;
  for (const item of units.pieceWeights.items) {
    const core = item.name.split(",")[0] ?? item.name;
    if (matchScore(keys, nameKeys(core)) === 2) return item.grams;
  }
  return null;
}

function namedValue(food: string, table: Readonly<Record<string, number>>): number | null {
  const keys = nameKeys(food);
  for (const [name, value] of Object.entries(table)) {
    if (matchScore(keys, nameKeys(name.split(",")[0] ?? name)) === 2) return value;
  }
  return null;
}

// Grams for an amount in a unit, or null when units.json gives no conversion.
export function gramsFor(
  amount: number,
  unit: string | null,
  food: string,
  units: UnitsKnowledge,
): number | null {
  if (unit !== null && NEGLIGIBLE_UNITS.has(unit)) return 0;
  if (unit === null) {
    const piece = pieceWeight(food, units);
    return piece === null ? null : amount * piece;
  }
  const mapping = mappingFor(unit, units);
  const perUnit = mapping?.gramsPerUnit;
  if (typeof perUnit === "number") return amount * perUnit;
  if (perUnit && typeof perUnit === "object") {
    const value = namedValue(food, perUnit);
    return value === null ? null : amount * value;
  }
  if (typeof perUnit === "string") {
    if (perUnit === "pieceWeights") {
      const piece = pieceWeight(food, units);
      return piece === null ? null : amount * piece;
    }
    const density = /^([\d.]+)?\s*(?:ml\s*)?\*?\s*density$/.exec(perUnit.trim());
    if (density) return amount * Number(density[1] ?? 1) * densityOf(food, units);
    return null;
  }
  // No usable mapping: pieces such as Stange or Knolle may still have a piece weight.
  const piece = pieceWeight(food, units);
  return piece === null ? null : amount * piece;
}

// Estimated grams of an input ingredient, the upper end of a range. Null when unknown.
export function ingredientGrams(ingredient: NormalizedIngredient, units: UnitsKnowledge) {
  if (ingredient.source === "unparsed") return null;
  const amount = ingredient.quantityMax ?? ingredient.quantity;
  // No amount: a to-taste item such as "Salz zum Abschmecken" when it has no unit either.
  if (amount === null) {
    return ingredient.unit === null || NEGLIGIBLE_UNITS.has(ingredient.unit) ? 0 : null;
  }
  if (ingredient.weightGrams !== undefined) return amount * ingredient.weightGrams;
  return gramsFor(amount, ingredient.unit, ingredient.food, units);
}

// Words that mark contents which foam or boil over (timing-model.json bowl_max_foaming).
export const FOAMING_WORDS = [
  "milch",
  "nudel",
  "pasta",
  "spaghetti",
  "reis",
  "linse",
  "bohne",
  "kichererbse",
  "kartoffel",
  "marmelade",
  "konfitüre",
  "gelierzucker",
  "haferflock",
  "grieß",
];
// Liquids that count toward the water a steaming step needs.
export const LIQUID_WORDS = ["wasser", "brühe", "fond", "milch", "wein", "saft"];
export const FLOUR_WORDS = ["mehl"];

const ADDING =
  /(?<!\p{L})(?:zugeben|dazugeben|hinzugeben|hineingeben|geben|zugießen|angießen|aufgießen|eingießen|dazugießen|einfüllen|einwiegen|zufügen|hinzufügen|einstreuen|unterheben|unterrühren|einrühren|untermischen|ablöschen)(?!\p{L})/iu;
const EMPTYING =
  /umfüllen|ausspülen|ausleeren|entleeren|abgießen|abschütten|(?<!\p{L})leeren|reinigen|vorspülen/iu;
const COOLING = /abkühlen|auskühlen/iu;
// Places a weighed or added ingredient goes that are not the bowl. The lid opening is the
// bowl: "durch die Deckelöffnung zugeben".
const OUTSIDE_BOWL =
  /dampfgar|einlegeboden|deckel(?!öffnung)|teller|schüssel|außerhalb|backform|auflaufform/iu;
const WHISK = /rühraufsatz/iu;
const WHISK_IN = /einsetzen|aufsetzen|einstecken|anbringen/iu;
const WHISK_OUT = /entfernen|abnehmen|herausnehmen|entnehmen/iu;

export interface BowlState {
  // Known grams in the bowl; a lower bound when unknown is true.
  grams: number;
  unknown: boolean;
  flourGrams: number;
  liquidGrams: number;
  liquidUnknown: boolean;
  foaming: boolean;
  // The highest temperature the contents reached since the bowl was last emptied or cooled.
  hotTemperature: number;
  whisk: boolean;
}

export interface StepTrace {
  index: number;
  step: RecipeStep;
  text: string;
  before: BowlState;
  after: BowlState;
}

// The text of a step for the checks. Official text steps repeat the description as the
// title (cut at 80 characters), so the title only counts when it says something else.
export function stepText(step: RecipeStep): string {
  if (!("description" in step)) return step.title;
  const title = step.title.replace(/…$/, "").trim();
  return step.description.includes(title) ? step.description : `${step.title}\n${step.description}`;
}

function hasAny(text: string, list: readonly string[]): boolean {
  return matchScore(nameKeys(text), list.map(stem)) > 0;
}

export function stepTemperature(step: RecipeStep): number {
  if (step.kind === "steaming") return 100;
  return "temperature" in step ? step.temperature : 0;
}

const EMPTY_BOWL: BowlState = {
  grams: 0,
  unknown: false,
  flourGrams: 0,
  liquidGrams: 0,
  liquidUnknown: false,
  foaming: false,
  hotTemperature: 0,
  whisk: false,
};

// Follows the bowl through the recipe. Scale steps add their weight unless they weigh
// onto the steamer, a plate or the lid; text steps with an adding verb add the input
// ingredients they name (their stated amount, else the estimated weight of the whole
// ingredient). Transferring or rinsing empties the bowl. Every input ingredient counts once.
export function traceBowl(
  recipe: RecipeInput,
  ingredients: readonly NormalizedIngredient[],
  knowledge: Knowledge,
): StepTrace[] {
  const units = knowledge.units;
  const index = indexIngredients(ingredients);
  const counted = new Set<number>();
  const fromText = new Map<number, number>();
  let state: BowlState = { ...EMPTY_BOWL };
  const traces: StepTrace[] = [];

  const addContents = (grams: number, label: string) => {
    state.grams += grams;
    if (hasAny(label, FLOUR_WORDS)) state.flourGrams += grams;
    if (hasAny(label, LIQUID_WORDS)) state.liquidGrams += grams;
    if (hasAny(label, FOAMING_WORDS)) state.foaming = true;
  };

  recipe.servingSize.steps.forEach((step, position) => {
    const before = { ...state };
    const text = stepText(step);
    if (step.kind === "text") {
      if (EMPTYING.test(text)) {
        state = { ...EMPTY_BOWL, whisk: state.whisk };
        fromText.clear();
      } else if (COOLING.test(text)) {
        state.hotTemperature = 0;
      }
      if (WHISK.test(text)) {
        if (WHISK_OUT.test(text)) state.whisk = false;
        else if (WHISK_IN.test(text)) state.whisk = true;
      }
      if (ADDING.test(text)) {
        const outside = OUTSIDE_BOWL.test(text);
        const mentions = amountMentions(text);
        for (const position of mentionedIngredients(text, index)) {
          if (counted.has(position)) continue;
          counted.add(position);
          if (outside) continue;
          const ingredient = ingredients[position];
          if (!ingredient) continue;
          const stated = mentions.find(
            (mention) => attributeIngredient(mention.phrase, index) === position,
          );
          const grams = stated
            ? gramsFor(stated.amount, stated.unit, ingredient.food, units)
            : ingredientGrams(ingredient, units);
          if (grams === null) {
            state.unknown = true;
            if (hasAny(ingredient.food, LIQUID_WORDS)) state.liquidUnknown = true;
            if (hasAny(ingredient.food, FOAMING_WORDS)) state.foaming = true;
            continue;
          }
          fromText.set(position, grams);
          addContents(grams, ingredient.food);
        }
        // Liquids the ingredient list does not have, such as water for steaming.
        if (!outside) {
          for (const mention of mentions) {
            if (attributeIngredient(mention.phrase, index) !== null) continue;
            if (!hasAny(mention.phrase, LIQUID_WORDS)) continue;
            const grams = gramsFor(mention.amount, mention.unit, mention.phrase, units);
            if (grams !== null && mention.unit !== null) addContents(grams, mention.phrase);
          }
          if (hasAny(text, ["wasser"]) && !mentions.some((m) => hasAny(m.phrase, ["wasser"]))) {
            state.liquidUnknown = true;
          }
        }
      }
    } else if (step.kind === "scale") {
      const named = mentionedIngredients(text, index);
      for (const position of named) counted.add(position);
      if (!OUTSIDE_BOWL.test(text)) {
        for (const position of named) {
          const earlier = fromText.get(position);
          if (earlier !== undefined) {
            state.grams -= earlier;
            fromText.delete(position);
          }
        }
        addContents(step.grams, text);
      }
    } else {
      const temperature = stepTemperature(step);
      if (temperature > 0) state.hotTemperature = Math.max(state.hotTemperature, temperature);
    }
    traces.push({ index: position, step, text, before, after: { ...state } });
  });
  return traces;
}
