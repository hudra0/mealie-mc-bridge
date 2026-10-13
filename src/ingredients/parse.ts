// Deterministic parser for free-text ingredient lines in German and English, such as
// "500 g Mehl", "2–3 EL Öl", "1 Dose (400 g) Tomaten" or "Mehl 500 g". The rules follow
// test/fixtures/ingredients/SPEC.md. The parser never guesses an amount: when a line has
// no readable quantity, quantity stays null.

import {
  CONTAINER_UNIT_CODES,
  SIZE_UNIT_CODES,
  normalizeUnit,
  type UnitCode,
  type UnitMatch,
} from "./units.js";

export interface ParsedIngredient {
  quantity: number | null;
  quantityMax: number | null;
  unit: UnitCode | null;
  food: string;
  note: string;
  optional: boolean;
  // False only for section headers such as "Für den Teig:".
  parsed: boolean;
  // Gram weight per unit when the line states one, as in "1 Dose (400 g)".
  weightGrams?: number;
  // 0 to 1. Below 0.5 the line should be treated as not understood.
  confidence: number;
}

export interface ParseOptions {
  // Restricts the number words ("a", "one" or "ein", "zwei") to one language.
  lang?: "de" | "en";
}

const UNICODE_FRACTIONS: Readonly<Record<string, number>> = {
  "½": 1 / 2,
  "¼": 1 / 4,
  "¾": 3 / 4,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅕": 1 / 5,
  "⅖": 2 / 5,
  "⅗": 3 / 5,
  "⅘": 4 / 5,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8,
};
const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join("");
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

// One number: mixed "1 1/2", glued mixed "1½" or "2 ½", fraction "1/2", "½", decimal "0,5".
// The input is cleaned first, so whitespace is always a single space.
const NUM = `(?:\\d+ \\d+ ?\\/ ?\\d+|\\d+ ?[${FRACTION_CHARS}]|\\d+ ?\\/ ?\\d+|[${FRACTION_CHARS}]|\\d+(?:[.,]\\d+)?)`;
const RANGE_SEP = "(?: ?[-–—] ?| (?:bis|to|oder|or) )";
const NUM_RANGE = `${NUM}(?:${RANGE_SEP}${NUM})?`;
const WORD = "\\p{L}+\\.?";

const NUM_RANGE_PARTS = new RegExp(`^(${NUM})(?:${RANGE_SEP}(${NUM}))?$`, "u");
const LEADING_RANGE = new RegExp(`^${NUM_RANGE}(?= |$)`, "u");

// Number words. Multi-word entries come first so "ein halbes" wins over "ein".
const NUMBER_WORDS: ReadonlyArray<readonly [string, number, "de" | "en"]> = [
  ["ein halbes", 0.5, "de"],
  ["ein halber", 0.5, "de"],
  ["eine halbe", 0.5, "de"],
  ["einen halben", 0.5, "de"],
  ["einem halben", 0.5, "de"],
  ["einer halben", 0.5, "de"],
  ["eines halben", 0.5, "de"],
  ["eineinhalb", 1.5, "de"],
  ["anderthalb", 1.5, "de"],
  ["halbe", 0.5, "de"],
  ["halber", 0.5, "de"],
  ["halbes", 0.5, "de"],
  ["halben", 0.5, "de"],
  ["ein", 1, "de"],
  ["eine", 1, "de"],
  ["einen", 1, "de"],
  ["einem", 1, "de"],
  ["einer", 1, "de"],
  ["eines", 1, "de"],
  ["zwei", 2, "de"],
  ["drei", 3, "de"],
  ["vier", 4, "de"],
  ["fünf", 5, "de"],
  ["sechs", 6, "de"],
  ["sieben", 7, "de"],
  ["acht", 8, "de"],
  ["neun", 9, "de"],
  ["zehn", 10, "de"],
  ["zwölf", 12, "de"],
  ["one and a half", 1.5, "en"],
  ["half a", 0.5, "en"],
  ["half an", 0.5, "en"],
  ["half", 0.5, "en"],
  ["a", 1, "en"],
  ["an", 1, "en"],
  ["one", 1, "en"],
  ["two", 2, "en"],
  ["three", 3, "en"],
  ["four", 4, "en"],
  ["five", 5, "en"],
  ["six", 6, "en"],
  ["seven", 7, "en"],
  ["eight", 8, "en"],
  ["nine", 9, "en"],
  ["ten", 10, "en"],
  ["twelve", 12, "en"],
];

// Amounts that are deliberately unspecific. They never become a quantity.
const VAGUE_WORDS = [
  "ein klein wenig",
  "ein paar",
  "ein wenig",
  "ein bisschen",
  "ein bißchen",
  "etwas",
  "einige",
  "wenige",
  "wenig",
  "mehrere",
  "reichlich",
  "a couple of",
  "a few",
  "a little",
  "a bit of",
  "some",
  "several",
];

// Approximation words stay in the note; the number after them is the quantity.
const APPROX_WORDS = [
  "ca.",
  "ca",
  "circa",
  "zirka",
  "etwa",
  "ungefähr",
  "rund",
  "gut",
  "gute",
  "knapp",
  "knappe",
  "about",
  "approx.",
  "approx",
  "approximately",
  "around",
  "roughly",
];

// Rule 11: these phrases make an ingredient optional. "nach Geschmack" and "to taste" do not.
const OPTIONAL_PHRASES = [
  "nach Belieben",
  "wenn vorhanden",
  "falls vorhanden",
  "nach Wunsch",
  "optional",
  "if desired",
  "if available",
];

// "Saft von 1 Zitrone": the part of the fruit goes to the note, the fruit is the food.
const PART_NOUNS =
  "saft|abrieb|schale|zeste|zesten|eigelb|eiweiß|eiweiss|eidotter|fruchtfleisch|juice|zest|rind|peel|yolks?|whites?";

// Words that may sit between a number and its unit: "1 gehäufter TL", "1 large can".
const UNIT_MODIFIER =
  /^(?:gehäufte[nmrs]?|gestrichene[nmrs]?|geh\.|gestr\.|knappe[nmrs]?|gute[nmrs]?|volle[nmrs]?|große[nmrs]?|grosse[nmrs]?|kleine[nmrs]?|mittelgroße[nmrs]?|heaped|heaping|level|rounded|scant|generous|good|large|small|medium|big)$/iu;

// Standard German flour type numbers. Without a unit they are a name, never a count.
const FLOUR_TYPE_NUMBERS = [405, 550, 630, 812, 997, 1050, 1150, 1370, 1600, 1700, 1740];
const FLOUR_TYPES: ReadonlySet<number> = new Set(FLOUR_TYPE_NUMBERS);

// A word before a trailing number that makes the number part of the name: "Mehl Type 405".
const NAME_NUMBER_WORDS = /(?:^| )(?:type|typ|nr\.?|no\.?|größe|gr\.|stufe|size)$/iu;
// A bare number after a flour word is never a count: "Weizenmehl 550". "Mehl 500 g" is.
const FLOUR_WORD = /(?:^| )\p{L}*mehl$/iu;
// The same words with their number. Such digits were read as part of the name. After a
// flour word only a standard type counts; "Mandelmehl 100" keeps its digits as not understood.
const NAME_NUMBERS = new RegExp(
  `(?:^| )(?:(?:type|typ|nr\\.?|no\\.?|größe|gr\\.|stufe|size) ?\\d+|\\p{L}*mehl (?:${FLOUR_TYPE_NUMBERS.join("|")})(?!\\d))`,
  "giu",
);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (words: readonly string[]): string =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");

// The first of these phrases ends the food; the phrase and the rest go to the note.
const FOOD_NOTE_SPLIT = new RegExp(
  ` (?=(?:${alternation([
    "zum",
    "zur",
    "für",
    "aus der",
    "aus dem",
    "nach Geschmack",
    "nach Bedarf",
    "oder mehr",
    "plus",
    "à",
    "je",
    ...OPTIONAL_PHRASES,
    "for",
    "to taste",
    "to serve",
    "as needed",
    "or more",
  ])})(?: |$))`,
  "iu",
);

const APPROX_ALT = alternation(APPROX_WORDS);
const OPTIONAL_RE = new RegExp(
  `(?:^|[^\\p{L}])(?:${alternation(OPTIONAL_PHRASES)})(?!\\p{L})`,
  "iu",
);
const LEADING_OPTIONAL = new RegExp(`^(${alternation(OPTIONAL_PHRASES)}) `, "iu");
const LEADING_VAGUE = new RegExp(`^(${alternation(VAGUE_WORDS)})(?= |$)`, "iu");
const AMOUNT_AHEAD = `(?=\\d|[${FRACTION_CHARS}]|(?:${alternation(NUMBER_WORDS.map(([word]) => word))}) )`;
const LEADING_APPROX = new RegExp(`^(${APPROX_ALT}) ?${AMOUNT_AHEAD}`, "iu");
const LEADING_PART = new RegExp(
  `^((?:${PART_NOUNS})(?: (?:und|and|&) (?:${PART_NOUNS}))?(?: (?:von|vom|of|from|aus))?) ${AMOUNT_AHEAD}`,
  "iu",
);
const TRAILING_AMOUNT = new RegExp(
  `^(.+?) ?[:–-]? (?:(${APPROX_ALT}) ?)?(${NUM_RANGE})(?: (${WORD}))?$`,
  "iu",
);
const TAIL_AMOUNT = new RegExp(
  `^(?:(.+?) )?(?:(${APPROX_ALT}) ?)?(${NUM_RANGE})(?: (${WORD}))?$`,
  "iu",
);
const SIZE_PHRASE = new RegExp(
  `^(?:à|á|a|je|zu je|zu|@) (${NUM}) ?(${WORD})(?: each)?(?= |$)`,
  "iu",
);
const SIZED_CONTAINER = new RegExp(`^(${NUM}) ?-? ?(\\p{L}+) ?- ?(\\p{L}+)(?= |$)`, "u");
const SIZE_AFTER_X = new RegExp(`^(${NUM}) ?(${WORD})(?= |$)`, "u");
const REPEATED_UNIT_UPPER = new RegExp(`^(?:[-–—] ?|(?:bis|to) )(${NUM}) ?(${WORD})(?= |$)`, "iu");
const WEIGHT_GROUP = new RegExp(
  `^(?:(?:${APPROX_ALT}|à|je) ?)?(${NUM}) ?(${WORD})(?: each)?$`,
  "iu",
);
// A weight stated for each piece: "je 150 g", "à 150 g", "150 g each".
const PER_UNIT_WEIGHT = /^(?:à|je)(?: |$)|(?:^| )each$/iu;
const MIXED_NUMBER = /^(\d+) (\d+) ?\/ ?(\d+)$/;
const GLUED_FRACTION = new RegExp(`^(\\d+) ?([${FRACTION_CHARS}])$`, "u");
const SIMPLE_FRACTION = /^(\d+) ?\/ ?(\d+)$/;
const DIGIT_BEFORE_LETTER = new RegExp(`([\\d${FRACTION_CHARS}])(?=\\p{L})`, "gu");
const LOOSE_DIGIT = new RegExp(`[\\d${FRACTION_CHARS}]`, "u");
const PLUS_EXTRA = new RegExp(
  ` \\+ (?=\\d|[${FRACTION_CHARS}]|(?:etwas|mehr|extra|more|some|a little)(?: |$))`,
  "iu",
);

const HEADER_PATTERNS: readonly RegExp[] = [
  /:$/u,
  /^#{1,6} /u,
  /^\*\*[^*]+\*\*$/u,
  /^(?:zutaten|ingredients?)(?: (?:für|for) .*)?$/iu,
  /^(?:für|for) (?:den|die|das|dem|the) \p{L}/iu,
  /^(?:für|for) \d+ (?:portionen|personen|stück|servings?|people|persons)(?: |$)/iu,
];

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

// Rule 14: non-breaking spaces, bullets, repeated whitespace and a trailing dot are noise.
export function cleanIngredientText(text: string): string {
  return (
    text
      .normalize("NFC")
      // \s covers non-breaking and other Unicode spaces.
      .replace(/\s/g, " ")
      .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/gu, (c) => String(SUPERSCRIPT_DIGITS.indexOf(c)))
      .replace(/[₀₁₂₃₄₅₆₇₈₉]/gu, (c) => String(SUBSCRIPT_DIGITS.indexOf(c)))
      .replace(/⁄/g, "/")
      .replace(/×/g, "x")
      .trim()
      .replace(/^(?:(?:[-–—•·▪■●○◦▢□☐✓✔]|\*(?!\*))+ ?)+/u, "")
      .replace(DIGIT_BEFORE_LETTER, "$1 ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.$/, "")
      .trim()
  );
}

export function numberValue(raw: string): number | null {
  const text = raw.trim();
  let match = MIXED_NUMBER.exec(text);
  if (match) return fraction(Number(match[2]), Number(match[3]), Number(match[1]));
  match = GLUED_FRACTION.exec(text);
  if (match) return Number(match[1]) + (UNICODE_FRACTIONS[match[2] ?? ""] ?? 0);
  match = SIMPLE_FRACTION.exec(text);
  if (match) return fraction(Number(match[1]), Number(match[2]), 0);
  const unicode = UNICODE_FRACTIONS[text];
  if (unicode !== undefined) return unicode;
  if (/^\d+(?:[.,]\d+)?$/.test(text)) return Number(text.replace(",", "."));
  return null;
}

function fraction(numerator: number, denominator: number, whole: number): number | null {
  return denominator === 0 ? null : whole + numerator / denominator;
}

interface Range {
  quantity: number | null;
  quantityMax: number | null;
}

function parseRange(raw: string): Range {
  const match = NUM_RANGE_PARTS.exec(raw.trim());
  if (!match) return { quantity: null, quantityMax: null };
  const quantity = numberValue(match[1] ?? "");
  const upper = match[2] === undefined ? null : numberValue(match[2]);
  const quantityMax = quantity !== null && upper !== null && upper > quantity ? upper : null;
  return { quantity, quantityMax };
}

// Rule 6: the content of parentheses goes to the note, never to the food.
function extractGroups(text: string): { text: string; groups: string[] } {
  const groups: string[] = [];
  let depth = 0;
  let outside = "";
  let inside = "";
  for (const char of text) {
    if (char === "(" || char === "[") {
      if (depth > 0) inside += char;
      depth++;
    } else if ((char === ")" || char === "]") && depth > 0) {
      depth--;
      if (depth > 0) {
        inside += char;
      } else {
        if (inside.trim()) groups.push(inside.trim());
        inside = "";
        outside += " ";
      }
    } else if (depth > 0) {
      inside += char;
    } else {
      outside += char;
    }
  }
  if (inside.trim()) groups.push(inside.trim());
  const rest = outside
    .replace(/\s+/g, " ")
    .replace(/ ([,;])/g, "$1")
    .trim();
  return { text: rest, groups };
}

// Rule 5: the first comma that is not a decimal comma ends the food.
function splitAtComma(text: string): [string, string] {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== "," && char !== ";") continue;
    const decimal = char === "," && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
    if (!decimal) return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
  }
  return [text.trim(), ""];
}

function gramsOf(value: number | null, unit: UnitMatch | null): number | undefined {
  if (value === null || !unit) return undefined;
  if (unit.code === "g") return round3(value * unit.factor);
  if (unit.code === "kg") return round3(value * 1000);
  return undefined;
}

// A parenthesis that only states a weight, such as "400 g" or "ca. 1,2 kg".
function weightFromGroup(group: string): number | undefined {
  const match = WEIGHT_GROUP.exec(group);
  if (!match) return undefined;
  return gramsOf(numberValue(match[1] ?? ""), normalizeUnit(match[2]));
}

interface Amount {
  quantity: number | null;
  quantityMax: number | null;
  unit: UnitCode | null;
  rest: string;
  notes: string[];
  weightGrams?: number;
  wordText?: string;
}

interface SizedContainer {
  size: string;
  grams?: number;
  unit: UnitCode;
  rest: string;
}

// "400-g-Dose", "1,5 l-Flasche": a container with its size. Returns null otherwise.
function readSizedContainer(text: string): SizedContainer | null {
  const match = SIZED_CONTAINER.exec(text);
  if (!match) return null;
  const sizeUnit = normalizeUnit(match[2]);
  const container = normalizeUnit(match[3]);
  if (!sizeUnit || !SIZE_UNIT_CODES.has(sizeUnit.code)) return null;
  if (!container || !CONTAINER_UNIT_CODES.has(container.code)) return null;
  const grams = gramsOf(numberValue(match[1] ?? ""), sizeUnit);
  const sized: SizedContainer = {
    size: `${match[1]} ${match[2]}`,
    unit: container.code,
    rest: text.slice(match[0].length).trim(),
  };
  if (grams !== undefined) sized.grams = grams;
  return sized;
}

function readNumberWord(
  text: string,
  lang: ParseOptions["lang"],
): { value: number; word: string; rest: string } | null {
  const lower = text.toLowerCase();
  for (const [word, value, wordLang] of NUMBER_WORDS) {
    if (lang && wordLang !== lang) continue;
    if (lower.startsWith(word + " ")) {
      return { value, word: text.slice(0, word.length), rest: text.slice(word.length + 1).trim() };
    }
  }
  return null;
}

function unitFromWord(word: string, quantity: number | null): UnitMatch | null {
  // Rule 5: "1 gr. Zwiebel" means a large onion, while "500 gr Mehl" is grams.
  if (/^gr\.$/i.test(word) && (quantity === null || quantity <= 5)) return null;
  return normalizeUnit(word);
}

function readUnitWord(
  text: string,
  quantity: number | null,
): { unit: UnitMatch; modifier?: string; rest: string } | null {
  const words = text.split(" ");
  const first = words[0] ?? "";
  // Two-word units such as "fl oz" or "fluid ounces".
  if (words.length > 2) {
    const pair = normalizeUnit(`${first} ${words[1]}`);
    if (pair) return { unit: pair, rest: words.slice(2).join(" ") };
  }
  const direct = unitFromWord(first, quantity);
  if (direct) return { unit: direct, rest: words.slice(1).join(" ") };
  const second = words[1];
  if (second !== undefined && UNIT_MODIFIER.test(first)) {
    const unit = unitFromWord(second, quantity);
    if (unit) return { unit, modifier: first, rest: words.slice(2).join(" ") };
  }
  return null;
}

function scaled(range: Range, unit: UnitMatch | null): Range {
  const factor = unit?.factor ?? 1;
  return {
    quantity: range.quantity === null ? null : round3(range.quantity * factor),
    quantityMax: range.quantityMax === null ? null : round3(range.quantityMax * factor),
  };
}

function readAmount(text: string, lang: ParseOptions["lang"]): Amount | null {
  const notes: string[] = [];
  // Rule 7: "400-g-Dose Tomaten" has no count of its own, so the quantity is 1.
  const sized = readSizedContainer(text);
  if (sized) {
    const amount: Amount = {
      quantity: 1,
      quantityMax: null,
      unit: sized.unit,
      rest: sized.rest,
      notes: [sized.size],
    };
    if (sized.grams !== undefined) amount.weightGrams = sized.grams;
    return amount;
  }

  let range: Range;
  let rest: string;
  let wordText: string | undefined;
  const numeric = LEADING_RANGE.exec(text);
  if (numeric) {
    range = parseRange(numeric[0]);
    rest = text.slice(numeric[0].length).trim();
  } else {
    const word = readNumberWord(text, lang);
    if (!word) return null;
    range = { quantity: word.value, quantityMax: null };
    rest = word.rest;
    wordText = word.word;
  }
  if (range.quantity === null) return null;

  let unit: UnitMatch | null = null;
  let weightGrams: number | undefined;

  // Rule 7: "2x 400 g Dosen Tomaten", "2 x 400 g cans", "1 x 400-g-Dose".
  const multiplier = /^x ?(?=\d)/u.exec(rest);
  if (multiplier) {
    const afterX = rest.slice(multiplier[0].length);
    const container = readSizedContainer(afterX);
    const size = container ? null : SIZE_AFTER_X.exec(afterX);
    const sizeUnit = size ? normalizeUnit(size[2]) : null;
    if (container) {
      notes.push(container.size);
      unit = { code: container.unit, factor: 1 };
      weightGrams = container.grams;
      rest = container.rest;
    } else if (size && sizeUnit && SIZE_UNIT_CODES.has(sizeUnit.code)) {
      notes.push(`${size[1]} ${size[2]}`);
      weightGrams = gramsOf(numberValue(size[1] ?? ""), sizeUnit);
      rest = afterX.slice(size[0].length).trim();
      const containerWord = readUnitWord(rest, range.quantity);
      if (containerWord) {
        unit = containerWord.unit;
        rest = containerWord.rest;
      }
    }
  } else {
    const word = readUnitWord(rest, range.quantity);
    if (word) {
      unit = word.unit;
      if (word.modifier) notes.push(word.modifier);
      rest = word.rest;
      // Rule 2: "100 g bis 150 g Zucker" names the unit twice.
      const upper = REPEATED_UNIT_UPPER.exec(rest);
      if (upper && range.quantityMax === null && normalizeUnit(upper[2])?.code === unit.code) {
        const value = numberValue(upper[1] ?? "");
        if (value !== null && value > range.quantity) range.quantityMax = value;
        rest = rest.slice(upper[0].length).trim();
      }
    }
  }

  // "2 Dosen à 400 g Tomaten": the size goes to the note.
  const sizePhrase = SIZE_PHRASE.exec(rest);
  const phraseUnit = sizePhrase ? normalizeUnit(sizePhrase[2]) : null;
  if (sizePhrase && phraseUnit && SIZE_UNIT_CODES.has(phraseUnit.code)) {
    notes.push(sizePhrase[0]);
    weightGrams ??= gramsOf(numberValue(sizePhrase[1] ?? ""), phraseUnit);
    rest = rest.slice(sizePhrase[0].length).trim();
  }

  // "a pinch of nutmeg", "1 cup of flour".
  rest = rest.replace(/^of /i, "");

  const amount: Amount = { ...scaled(range, unit), unit: unit?.code ?? null, rest, notes };
  if (weightGrams !== undefined) amount.weightGrams = weightGrams;
  if (wordText !== undefined) amount.wordText = wordText;
  return amount;
}

interface TrailingAmount {
  before: string;
  approx?: string;
  amount: Amount;
}

// Reads an amount at the end: "Mehl 500 g", "Knoblauchzehen 2", "lauwarm 250 ml".
function readTrailingAmount(text: string, pattern: RegExp): TrailingAmount | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const before = (match[1] ?? "").trim();
  if (NAME_NUMBER_WORDS.test(before)) return null;
  const range = parseRange(match[3] ?? "");
  if (range.quantity === null) return null;
  let unit: UnitMatch | null = null;
  if (match[4] !== undefined) {
    unit = unitFromWord(match[4], range.quantity);
    if (!unit) return null;
  }
  if (!unit && (FLOUR_WORD.test(before) || FLOUR_TYPES.has(range.quantity))) return null;
  const trailing: TrailingAmount = {
    before,
    amount: { ...scaled(range, unit), unit: unit?.code ?? null, rest: "", notes: [] },
  };
  if (match[2] !== undefined) trailing.approx = match[2];
  return trailing;
}

// Moves purpose phrases, size phrases and dash comments out of the food.
function splitFood(text: string): { food: string; notes: string[] } {
  let food = text.trim();
  const notes: string[] = [];
  const dash = / [–—-] /u.exec(food);
  if (dash && dash.index > 0) {
    notes.push(food.slice(dash.index + dash[0].length).trim());
    food = food.slice(0, dash.index).trim();
  }
  // "125 g Butter + etwas zum Einfetten": an extra amount goes to the note with its plus
  // sign. "Salz + Pfeffer" stays one food, like "Salz und Pfeffer".
  const plus = PLUS_EXTRA.exec(food);
  if (plus && plus.index > 0) {
    notes.unshift(food.slice(plus.index + 1).trim());
    food = food.slice(0, plus.index).trim();
  }
  const split = FOOD_NOTE_SPLIT.exec(food);
  if (split && split.index > 0) {
    notes.unshift(food.slice(split.index).trim());
    food = food.slice(0, split.index).trim();
  }
  food = food.replace(/[\s:–-]+$/u, "").trim();
  return { food, notes: notes.filter((note) => note !== "") };
}

function headerResult(confidence: number): ParsedIngredient {
  return {
    quantity: null,
    quantityMax: null,
    unit: null,
    food: "",
    note: "",
    optional: false,
    parsed: false,
    confidence,
  };
}

// Rule 11: true when the text marks the ingredient as optional.
export function mentionsOptional(text: string): boolean {
  return OPTIONAL_RE.test(cleanIngredientText(text));
}

// Rule 13: section headers such as "Für den Teig:", "ZUTATEN" or "For the sauce:".
export function isHeaderLine(text: string): boolean {
  const cleaned = cleanIngredientText(text);
  return cleaned !== "" && HEADER_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function parseIngredientLine(text: string, options: ParseOptions = {}): ParsedIngredient {
  const cleaned = cleanIngredientText(text);
  if (cleaned === "") return headerResult(0);
  if (HEADER_PATTERNS.some((pattern) => pattern.test(cleaned))) return headerResult(0.9);

  const optional = OPTIONAL_RE.test(cleaned);
  const { text: unbracketed, groups } = extractGroups(cleaned);
  const weightGroup = groups.find((group) => weightFromGroup(group) !== undefined);
  let weightGrams = weightGroup === undefined ? undefined : weightFromGroup(weightGroup);
  // "2 Zwiebeln (ca. 300 g)" weighs both onions; "(je 150 g)" weighs one.
  const groupWeightIsTotal = weightGroup !== undefined && !PER_UNIT_WEIGHT.test(weightGroup);
  const [headText, tail] = splitAtComma(unbracketed);

  const prefixNotes: string[] = [];
  let head = headText;
  let match: RegExpExecArray | null;
  while ((match = LEADING_OPTIONAL.exec(head))) {
    prefixNotes.push(match[1] ?? "");
    head = head.slice(match[0].length).trim();
  }
  const part = LEADING_PART.exec(head);
  if (part) {
    prefixNotes.push(part[1] ?? "");
    head = head.slice(part[0].length).trim();
  }
  if ((match = LEADING_APPROX.exec(head))) {
    prefixNotes.push(match[1] ?? "");
    head = head.slice(match[0].length).trim();
  }

  let amount: Amount | null = null;
  let vague = false;
  let leadingFood = false;
  let foodText = head;
  let tailNotes: string[] | null = null;

  const vagueMatch = LEADING_VAGUE.exec(head);
  if (vagueMatch) {
    // Rule 4: a vague amount keeps quantity null, but a following unit is still read.
    vague = true;
    prefixNotes.push(vagueMatch[1] ?? "");
    foodText = head.slice(vagueMatch[0].length).trim();
    const unitWord = readUnitWord(foodText, null);
    if (unitWord && unitWord.rest !== "") {
      amount = {
        quantity: null,
        quantityMax: null,
        unit: unitWord.unit.code,
        rest: unitWord.rest,
        notes: [],
      };
      foodText = unitWord.rest;
    }
  } else {
    amount = readAmount(head, options.lang);
    if (amount) {
      foodText = amount.rest;
      // "Saft einer halben Zitrone": the number words belong to the part phrase.
      if (amount.wordText && part) prefixNotes.push(amount.wordText);
    } else {
      // Rule 9: "Mehl 500 g", "Wasser, lauwarm 250 ml".
      let trailing = readTrailingAmount(head, TRAILING_AMOUNT);
      const tailAmount = tail === "" ? null : readTrailingAmount(tail, TAIL_AMOUNT);
      // "Hefe 1, 42 g": a bare number in front and a measured amount after the comma. The
      // measured amount wins; the bare number stays in the food and lowers the confidence.
      if (trailing && trailing.amount.unit === null && tailAmount?.amount.unit) trailing = null;
      const fromTail = trailing ? null : tailAmount;
      const [tailHead, tailRest] = splitAtComma(tail);
      const leadingTail =
        trailing || fromTail || tail === "" ? null : readAmount(tailHead, options.lang);
      if (trailing) {
        amount = trailing.amount;
        foodText = trailing.before;
        if (trailing.approx) prefixNotes.push(trailing.approx);
        leadingFood = true;
      } else if (fromTail) {
        amount = fromTail.amount;
        if (fromTail.approx) prefixNotes.push(fromTail.approx);
        tailNotes = fromTail.before ? [fromTail.before] : [];
        leadingFood = true;
      } else if (leadingTail && (leadingTail.unit || leadingTail.rest === "")) {
        amount = leadingTail;
        tailNotes = [...leadingTail.notes, leadingTail.rest, tailRest];
        leadingFood = true;
      } else {
        // "Prise Salz": a unit without a number keeps quantity null, like a vague amount.
        const bareUnit = readUnitWord(head, null);
        const unitWord = head.split(" ")[0] ?? "";
        if (bareUnit && !bareUnit.modifier && bareUnit.rest !== "" && unitWord.length >= 3) {
          vague = true;
          amount = {
            quantity: null,
            quantityMax: null,
            unit: bareUnit.unit.code,
            rest: "",
            notes: [],
          };
          foodText = bareUnit.rest;
        }
      }
    }
  }

  const split = splitFood(foodText);
  const amountNotes = amount && !leadingFood ? amount.notes : [];
  const afterNotes = [...amountNotes, ...groups, ...split.notes, ...(tailNotes ?? [tail])];

  for (const note of split.notes) weightGrams ??= weightFromGroup(note.replace(/^(?:à|je) /iu, ""));
  if (amount?.weightGrams !== undefined) weightGrams ??= amount.weightGrams;

  const prefix = prefixNotes.filter((note) => note !== "").join(" ");
  const after = afterNotes.filter((note) => note !== "").join(", ");
  const note = [prefix, after].filter((value) => value !== "").join(" ");

  const quantity = amount?.quantity ?? null;
  const unit = amount?.unit ?? null;
  const result: ParsedIngredient = {
    quantity,
    quantityMax: amount?.quantityMax ?? null,
    unit,
    food: split.food,
    note,
    optional,
    parsed: true,
    confidence: confidenceOf({
      quantity,
      unit,
      food: split.food,
      vague,
      leadingFood,
      digitsInText: hasLooseDigits(unbracketed),
    }),
  };
  if (weightGrams !== undefined && groupWeightIsTotal) {
    weightGrams = perUnitWeight(weightGrams, quantity, result.quantityMax, unit);
  }
  if (weightGrams !== undefined) result.weightGrams = weightGrams;
  return result;
}

// Rule 6: weightGrams is per unit. A weight in parentheses after a container ("1 Dose
// (400 g)") is the container's weight. After a count or a measure ("2 Zwiebeln (300 g)",
// "2 cups (250 g)") it weighs all of them, so it is divided by the quantity. A range has
// no single count, so it carries no weight.
function perUnitWeight(
  grams: number,
  quantity: number | null,
  quantityMax: number | null,
  unit: UnitCode | null,
): number | undefined {
  if (unit !== null && CONTAINER_UNIT_CODES.has(unit)) return grams;
  if (quantity === null || quantity === 1) return grams;
  if (quantityMax !== null) return undefined;
  return round3(grams / quantity);
}

interface ConfidenceFacts {
  quantity: number | null;
  unit: string | null;
  food: string;
  vague: boolean;
  leadingFood: boolean;
  digitsInText: boolean;
}

// Digits or fraction characters outside a name such as "Type 405".
function hasLooseDigits(text: string): boolean {
  return LOOSE_DIGIT.test(text.replace(NAME_NUMBERS, ""));
}

function confidenceOf(facts: ConfidenceFacts): number {
  if (facts.food === "") return 0.2;
  // Digits left in the food, or digits without a quantity, were not understood.
  if (hasLooseDigits(facts.food)) return 0.3;
  if (facts.quantity === null && facts.digitsInText) return 0.3;
  let score: number;
  if (facts.quantity === null) score = facts.vague ? 0.7 : 0.85;
  else score = facts.unit === null ? 0.9 : 1;
  if (facts.leadingFood) score -= 0.05;
  return round3(score);
}
