// Corpus normalizer: turns the raw recipe crawl into flat JSON lines for analysis.
//
// Input:  $CORPUS_DIR/details/<id>.json (default CORPUS_DIR: local/corpus)
// Output: $CORPUS_DIR/derived/recipes.jsonl  one object per recipe
//         $CORPUS_DIR/derived/steps.jsonl    one object per step, step text included
//         $CORPUS_DIR/derived/summary.json   aggregated counts
//
// The raw recipes are copyrighted. All output stays under the gitignored corpus
// directory; only aggregated numbers and rules in our own words may leave it.
//
// Run: npm run corpus:normalize

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  rawDetailFileSchema,
  type Accessory,
  type AmountMention,
  type ModeSetting,
  type NormalizedIngredient,
  type NormalizedOutput,
  type NormalizedRecipe,
  type NormalizedStep,
  type Nutrients,
  type RawDeviceSetting,
  type RawRecipe,
  type RawStep,
  type UnitNorm,
} from "./types.js";
import { parseCorpusArgs } from "./locale.js";

// ---------------------------------------------------------------------------
// Amounts and units

const unicodeFractions: Record<string, number> = {
  "½": 1 / 2,
  "¼": 1 / 4,
  "¾": 3 / 4,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 1 / 8,
};
const fractionChars = "½¼¾⅓⅔⅛";

function toNumber(s: string): number {
  return Number(s.replace(",", "."));
}

function fraction(char: string): number {
  return unicodeFractions[char] ?? 0;
}

// One number at the start of `s`: "2", "1,5", "1/2", "½", "1 ½", "1½", "1 1/2".
// Returns the value and the length consumed, or null.
function leadingNumber(s: string): { value: number; length: number } | null {
  let m = /^(\d+)\s+(\d+)\/(\d+)/.exec(s);
  if (m?.[1] && m[2] && m[3] && Number(m[3]) !== 0) {
    return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), length: m[0].length };
  }
  m = new RegExp(`^(\\d+)\\s*([${fractionChars}])`, "u").exec(s);
  if (m?.[1] && m[2]) return { value: Number(m[1]) + fraction(m[2]), length: m[0].length };
  // "11/2" and "13/4" are mixed numbers typed without the space (1 1/2, 1 3/4): a
  // two-digit numerator whose second digit is smaller than the one-digit denominator.
  m = /^(\d)(\d)\/(\d)(?!\d)/.exec(s);
  if (m?.[1] && m[2] && m[3] && Number(m[2]) < Number(m[3])) {
    return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), length: m[0].length };
  }
  m = /^(\d+)\/(\d+)/.exec(s);
  if (m?.[1] && m[2] && Number(m[2]) !== 0) {
    return { value: Number(m[1]) / Number(m[2]), length: m[0].length };
  }
  m = new RegExp(`^([${fractionChars}])`, "u").exec(s);
  if (m?.[1]) return { value: fraction(m[1]), length: m[0].length };
  m = /^(\d+(?:[.,]\d+)?)/.exec(s);
  if (m?.[1]) return { value: toNumber(m[1]), length: m[0].length };
  return null;
}

/**
 * Parses an ingredient amount string. A range ("1-2", "2 - 3") becomes its midpoint.
 * Text without a leading number ("n.B.", "etwas", "") gives null. Whatever follows the
 * number is returned as `rest`, so "250 g" yields 250 and "g".
 */
export function parseAmount(raw: string): { amount: number | null; rest: string } {
  let s = raw.trim().replace(/^ca\.?\s*/i, "");
  const first = leadingNumber(s);
  if (!first) return { amount: null, rest: s };
  let value = first.value;
  s = s.slice(first.length);
  const range = /^\s*[-–]\s*/.exec(s);
  if (range) {
    const second = leadingNumber(s.slice(range[0].length));
    if (second) {
      value = (value + second.value) / 2;
      s = s.slice(range[0].length + second.length);
    }
  }
  return { amount: value, rest: s.trim() };
}

/**
 * Maps a raw unit to a normalized unit and the factor to grams (for g) or
 * millilitres (for ml). Matching ignores case, surrounding space and a trailing dot.
 */
export function normalizeUnit(unit: string | null | undefined): {
  unitNorm: UnitNorm;
  factor: number;
} {
  const u = (unit ?? "").trim().replace(/\.$/, "").toLowerCase();
  switch (u) {
    case "":
      return { unitNorm: "none", factor: 1 };
    case "g":
    case "gr":
    case "gramm":
      return { unitNorm: "g", factor: 1 };
    case "kg":
      return { unitNorm: "g", factor: 1000 };
    case "ml":
      return { unitNorm: "ml", factor: 1 };
    case "cl":
      return { unitNorm: "ml", factor: 10 };
    case "l":
    case "liter":
      return { unitNorm: "ml", factor: 1000 };
    case "stück":
    case "stücke":
    case "stk":
      return { unitNorm: "Stueck", factor: 1 };
    case "tl":
      return { unitNorm: "TL", factor: 1 };
    case "el":
      return { unitNorm: "EL", factor: 1 };
    case "prise":
    case "prisen":
      return { unitNorm: "Prise", factor: 1 };
    default:
      return { unitNorm: "other", factor: 1 };
  }
}

// Liquids with a density close enough to 1 g/ml that millilitres count as grams.
// Oil (about 0.92) and syrups (about 1.3) are deliberately left out.
const waterLike =
  /wasser(?!melone)|milch|brühe|bruehe|bouillon|fond\b|saft|wein\b|weißwein|rotwein|bier\b|essig|sahne|kaffee|espresso|\btee\b/i;

export function isWaterLike(name: string): boolean {
  return waterLike.test(name);
}

/** Grams for g units; for ml only when the ingredient is water-like; else null. */
export function estimateGrams(
  amount: number | null,
  unitNorm: UnitNorm,
  factor: number,
  name: string,
): number | null {
  if (amount === null) return null;
  if (unitNorm === "g") return amount * factor;
  if (unitNorm === "ml" && isWaterLike(name)) return amount * factor;
  return null;
}

export function normalizeIngredient(
  raw: {
    order?: number | null | undefined;
    amount?: string | number | null | undefined;
    unit?: string | null | undefined;
    name?: string | null | undefined;
    systemIngredientId?: number | null | undefined;
    ingredientGroupId?: number | null | undefined;
  },
  index: number,
  groupNames: ReadonlyMap<number, string | null>,
): NormalizedIngredient {
  const name = (raw.name ?? "").trim();
  const amountRaw = raw.amount === null || raw.amount === undefined ? "" : String(raw.amount);
  const unit = raw.unit ?? "";
  const { amount, rest } = parseAmount(amountRaw);
  // Some recipes put the unit into the amount field ("250 g", "240 g Abtropfgewicht")
  // and leave the unit empty; the first word after the number is then the unit.
  // Free text without a number ("n.B.", "nach Belieben") is not a unit.
  const unitFromAmount = amount !== null ? (rest.split(/\s+/)[0] ?? "") : "";
  const effectiveUnit = unit.trim() === "" ? unitFromAmount : unit;
  const { unitNorm, factor } = normalizeUnit(effectiveUnit);
  const groupId = raw.ingredientGroupId ?? null;
  return {
    order: raw.order ?? index,
    name,
    amount,
    amountRaw,
    unit,
    unitNorm,
    grams: estimateGrams(amount, unitNorm, factor, name),
    systemIngredientId: raw.systemIngredientId ?? null,
    group: groupId === null ? null : (groupNames.get(groupId) ?? null),
  };
}

// ---------------------------------------------------------------------------
// Step text analysis

const amountInTextRe = new RegExp(
  String.raw`(?<![\p{L}\d.,/])` +
    String.raw`(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?(?:\s*[${fractionChars}])?|[${fractionChars}])` +
    String.raw`(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?` +
    String.raw`\s*(g|ml|el|tl|stück|stk\.?)(?![\p{L}])`,
  "giu",
);

function mentionUnit(u: string): AmountMention["unit"] {
  const lower = u.toLowerCase().replace(/\.$/, "");
  if (lower === "g") return "g";
  if (lower === "ml") return "ml";
  if (lower === "el") return "EL";
  if (lower === "tl") return "TL";
  return "Stueck";
}

/** All "<number> g|ml|EL|TL|Stück" mentions in a text; a range counts as its midpoint. */
export function findAmountsInText(text: string): AmountMention[] {
  const out: AmountMention[] = [];
  for (const m of text.matchAll(amountInTextRe)) {
    const [raw, num, upper, unit] = m;
    if (num === undefined || unit === undefined) continue;
    const first = leadingNumber(num);
    if (!first) continue;
    const amount = upper === undefined ? first.value : (first.value + toNumber(upper)) / 2;
    out.push({ amount, unit: mentionUnit(unit), raw: raw.trim() });
  }
  return out;
}

const accessoryPatterns: [Accessory, RegExp][] = [
  ["Ruehraufsatz", /r(?:ü|ue|u)hrs?(?:aufsatz|einsatz)|schmetterling/i],
  // The MC Smart's basket insert is called "Kocheinsatz" in most recipes.
  ["Gareinsatz", /(?<!dampf|damf)gar(?:einsatz|korb)|kocheinsatz/i],
  // Steamer parts; the step title is cut at 80 characters, so truncated words count too.
  ["Dampfgaraufsatz", /dam?pfgar(?:auf|ein|beh)|dampfaufsatz/i],
  ["Messbecher", /messbecher/i],
  ["Spatel", /spatel/i],
];

export function detectAccessories(texts: readonly string[]): Accessory[] {
  const joined = texts.join("\n");
  return accessoryPatterns.filter(([, re]) => re.test(joined)).map(([name]) => name);
}

// Lowercase keys used to find an ingredient in step text: the name without
// parentheses and without anything after the first comma, plus its last word
// ("rote Linsen" is also found as "linsen").
export function ingredientKeys(name: string): string[] {
  const core = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .split(",")[0]
    ?.replace(/\s+/g, " ")
    .trim();
  if (!core || core.length < 3) return [];
  const keys = [core];
  const last = core.split(" ").at(-1);
  if (last && last !== core && last.length >= 4) keys.push(last);
  return keys;
}

// ---------------------------------------------------------------------------
// Steps and recipes

export function stepText(step: RawStep): string {
  const description = step.description?.trim() ?? "";
  return description !== "" ? description : (step.name?.trim() ?? "");
}

function phases(ds: RawDeviceSetting): ModeSetting["settings"] {
  return (ds.settings ?? []).map((s) => ({
    order: s.order ?? null,
    speed: s.speed ?? null,
    temperature: s.temperature ?? null,
    time: s.time ?? null,
    weight: s.weight ?? null,
  }));
}

function maxOf(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function sumOf(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

const nutrientKeys: Record<string, keyof Nutrients> = {
  calories: "kcal",
  carbohydrate: "carb",
  fat: "fat",
  protein: "protein",
};

function toNumberOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : toNumber(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes one recipe, using its first serving size.
 *
 * cumulativeGramsBefore is an estimate of what is in the bowl once the step is done:
 * walking the text and scale steps in order, an ingredient adds its grams the first
 * time its name (see ingredientKeys) appears in a step text. A scale step adds its
 * programmed weight instead; ingredients named in a scale step are marked as counted,
 * and if a text step had already counted one of them, that earlier contribution is
 * replaced by the scale weight. Ingredients without a gram estimate add nothing.
 * Other machine steps carry the running total unchanged.
 */
export function normalizeRecipe(recipe: RawRecipe): NormalizedOutput {
  const serving = recipe.servingSizes[0];
  const rawSteps = serving?.steps ?? [];
  const groupNames = new Map<number, string | null>();
  for (const g of serving?.ingredientGroups ?? []) {
    if (g.id !== null && g.id !== undefined) groupNames.set(g.id, g.name ?? null);
  }
  const ingredients = (serving?.ingredients ?? []).map((ing, i) =>
    normalizeIngredient(ing, i, groupNames),
  );
  const ingredientKeyList = ingredients.map((ing) => ingredientKeys(ing.name));
  const categories = (recipe.categories ?? []).map((c) => ({ id: c.id, name: c.name ?? null }));
  const categoryIds = categories.map((c) => c.id);
  const source = recipe.source ?? null;

  const contribution = new Map<number, number>(); // ingredient index -> grams counted
  let runningGrams = 0;
  const texts = rawSteps.map(stepText);

  const steps: NormalizedStep[] = rawSteps.map((step, index) => {
    const ds = step.deviceSetting ?? null;
    const text = texts[index] ?? "";
    const lowerText = text.toLowerCase();
    const matched = ingredientKeyList
      .map((keys, i) => (keys.some((k) => lowerText.includes(k)) ? i : -1))
      .filter((i) => i >= 0);

    const settings = ds ? phases(ds) : [];
    const weight = ds ? sumOf(settings.map((s) => s.weight)) : null;

    if (!ds) {
      for (const i of matched) {
        if (contribution.has(i)) continue;
        const grams = ingredients[i]?.grams ?? 0;
        contribution.set(i, grams);
        runningGrams += grams;
      }
    } else if (ds.mode === "scale") {
      for (const i of matched) {
        runningGrams -= contribution.get(i) ?? 0;
        contribution.set(i, 0);
      }
      runningGrams += weight ?? 0;
    }

    let prevTextSteps: string | null = null;
    if (ds) {
      const collected: string[] = [];
      for (let j = index - 1; j >= 0 && collected.length < 3; j--) {
        const prev = rawSteps[j];
        if (!prev) break;
        const prevDs = prev.deviceSetting ?? null;
        if (prevDs === null) collected.unshift(texts[j] ?? "");
        else if (prevDs.mode !== "scale") break;
      }
      prevTextSteps = collected.length > 0 ? collected.join(" | ") : null;
    }

    return {
      recipeId: recipe.id,
      source,
      categories: categoryIds,
      stepIndex: index,
      stepCount: rawSteps.length,
      kind: ds ? "machine" : "text",
      mode: ds ? ds.mode : "text",
      temperature: ds ? maxOf(settings.map((s) => s.temperature)) : null,
      timeSeconds: ds ? sumOf(settings.map((s) => s.time)) : null,
      speed: ds ? maxOf(settings.map((s) => s.speed)) : null,
      reverse: ds?.reverse === true,
      turbo: ds !== null && (ds.turbo === true || ds.mode === "turbo"),
      weight,
      modeSetting: ds
        ? {
            size: ds.size ?? null,
            texture: ds.texture ?? null,
            cleaningMode: ds.cleaningMode ?? null,
            settings,
          }
        : null,
      title: step.name?.trim() ?? "",
      titleLen: (step.name ?? "").length,
      textLen: text.length,
      text,
      prevTextSteps,
      cumulativeGramsBefore: Math.round(runningGrams * 10) / 10,
      amountsInText: findAmountsInText(text),
    };
  });

  const machine = steps.filter((s) => s.kind === "machine");
  const working = machine.filter((s) => s.mode !== "scale");
  const nutrients: Nutrients = { kcal: null, carb: null, fat: null, protein: null };
  for (const n of recipe.nutrients ?? []) {
    const key = nutrientKeys[n.name.toLowerCase()];
    if (key) nutrients[key] = n.amountFloat ?? n.amount ?? null;
  }
  const deviceTypes = recipe.deviceTypes ?? [];
  const title = recipe.name ?? "";

  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        title,
        ingredients: ingredients.map((i) => [i.name, i.amountRaw, i.unit]),
        steps: steps.map((s) => [s.text, s.mode, s.modeSetting]),
      }),
    )
    .digest("hex")
    .slice(0, 16);

  const normalized: NormalizedRecipe = {
    id: recipe.id,
    title,
    source,
    deviceTypes,
    isSmartOnly: deviceTypes.length === 1 && deviceTypes[0] === "MC3.0",
    categories,
    complexity: recipe.complexity ?? null,
    servings: { amount: toNumberOrNull(serving?.amount), unit: serving?.servingUnit ?? null },
    prepMinutes: recipe.preparationDuration ?? null,
    totalMinutes: recipe.duration ?? null,
    nutrients,
    rating: recipe.rating ?? null,
    totalRating: recipe.totalRating ?? null,
    popularity: recipe.popularity ?? null,
    ingredientCount: ingredients.length,
    ingredients,
    stepCount: steps.length,
    machineStepCount: machine.length,
    scaleStepCount: machine.length - working.length,
    textStepCount: steps.length - machine.length,
    modeSequence: steps.map((s) => s.mode),
    totalMachineSeconds: working.reduce((sum, s) => sum + (s.timeSeconds ?? 0), 0),
    maxTemperature: maxOf(working.map((s) => s.temperature)),
    usesReverse: machine.some((s) => s.reverse),
    usesTurbo: machine.some((s) => s.turbo),
    accessories: detectAccessories(texts),
    contentHash,
  };
  return { recipe: normalized, steps };
}

// ---------------------------------------------------------------------------
// Summary

type Counts = Record<string, number>;

function bump(counts: Counts, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function sortedCounts(counts: Counts): Counts {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function stats(values: number[]): { min: number; max: number; median: number; mean: number } {
  if (values.length === 0) return { min: 0, max: 0, median: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0, median, mean: Math.round(mean * 10) / 10 };
}

export interface FailedFile {
  file: string;
  error: string;
}

export function buildSummary(outputs: NormalizedOutput[], failed: FailedFile[], files: number) {
  const bySource: Counts = {};
  const byDeviceSet: Counts = {};
  const byCategory: Counts = {};
  const byComplexity: Counts = {};
  const modeFrequency: Counts = {};
  const modeFrequencyBySource: Record<string, Counts> = {};
  const modeRecipes: Counts = {};
  const unitNorm: Counts = {};
  const otherUnits: Counts = {};
  const accessories: Counts = {};
  let smartOnly = 0;
  let noSteps = 0;
  let noIngredients = 0;
  let noMachineSteps = 0;

  for (const { recipe, steps } of outputs) {
    const source = recipe.source ?? "unknown";
    bump(bySource, source);
    bump(byDeviceSet, [...recipe.deviceTypes].sort().join("+") || "none");
    for (const c of recipe.categories) bump(byCategory, c.name ?? String(c.id));
    bump(byComplexity, recipe.complexity ?? "unknown");
    if (recipe.isSmartOnly) smartOnly++;
    if (recipe.stepCount === 0) noSteps++;
    if (recipe.ingredientCount === 0) noIngredients++;
    if (recipe.machineStepCount - recipe.scaleStepCount === 0) noMachineSteps++;
    for (const a of recipe.accessories) bump(accessories, a);
    for (const ing of recipe.ingredients) {
      bump(unitNorm, ing.unitNorm);
      if (ing.unitNorm === "other")
        bump(otherUnits, ing.unit.trim() || `(in amount) ${ing.amountRaw}`);
    }
    const bySrc = (modeFrequencyBySource[source] ??= {});
    for (const s of steps) {
      bump(modeFrequency, s.mode);
      bump(bySrc, s.mode);
    }
    for (const mode of new Set(steps.filter((s) => s.kind === "machine").map((s) => s.mode))) {
      bump(modeRecipes, mode);
    }
  }

  const machineModes = Object.entries(sortedCounts(modeFrequency)).filter(([m]) => m !== "text");
  return {
    generatedAt: new Date().toISOString(),
    files,
    recipes: outputs.length,
    failed: failed.length,
    failedFiles: failed,
    smartOnly,
    emptyRecipes: { noSteps, noIngredients, noMachineStepsBesidesScale: noMachineSteps },
    bySource: sortedCounts(bySource),
    byDeviceSet: sortedCounts(byDeviceSet),
    byCategory: sortedCounts(byCategory),
    byComplexity: sortedCounts(byComplexity),
    stepsPerRecipe: stats(outputs.map((o) => o.recipe.stepCount)),
    machineStepsPerRecipe: stats(outputs.map((o) => o.recipe.machineStepCount)),
    machineStepsPerRecipeWithoutScale: stats(
      outputs.map((o) => o.recipe.machineStepCount - o.recipe.scaleStepCount),
    ),
    textStepsPerRecipe: stats(outputs.map((o) => o.recipe.textStepCount)),
    modeFrequency: sortedCounts(modeFrequency),
    modeFrequencyBySource: Object.fromEntries(
      Object.entries(modeFrequencyBySource).map(([k, v]) => [k, sortedCounts(v)]),
    ),
    distinctModes: machineModes.map(([mode, steps]) => ({
      mode,
      steps,
      recipes: modeRecipes[mode] ?? 0,
    })),
    accessories: sortedCounts(accessories),
    unitNorm: sortedCounts(unitNorm),
    otherUnits: sortedCounts(otherUnits),
  };
}

// ---------------------------------------------------------------------------
// CLI

export function parseDetailFile(json: string): RawRecipe {
  const parsed = rawDetailFileSchema.parse(JSON.parse(json));
  return "recipe" in parsed ? parsed.recipe : parsed.data.recipe;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

export function run(corpusDir: string): ReturnType<typeof buildSummary> {
  const started = Date.now();
  const detailsDir = path.join(corpusDir, "details");
  const outDir = path.join(corpusDir, "derived");
  const files = readdirSync(detailsDir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  const outputs: NormalizedOutput[] = [];
  const failed: FailedFile[] = [];
  for (const file of files) {
    try {
      outputs.push(
        normalizeRecipe(parseDetailFile(readFileSync(path.join(detailsDir, file), "utf8"))),
      );
    } catch (err) {
      const error = errorMessage(err);
      failed.push({ file, error });
      console.error(`corpus:normalize: skipped ${file}: ${error}`);
    }
  }

  mkdirSync(outDir, { recursive: true });
  const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path.join(outDir, "recipes.jsonl"), lines(outputs.map((o) => o.recipe)));
  writeFileSync(path.join(outDir, "steps.jsonl"), lines(outputs.flatMap((o) => o.steps)));
  const summary = buildSummary(outputs, failed, files.length);
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `corpus:normalize: ${outputs.length} recipes, ${failed.length} failed, ` +
      `${outputs.reduce((n, o) => n + o.steps.length, 0)} steps -> ${outDir} (${seconds}s)`,
  );
  return summary;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return norm(entry) === norm(self) || norm(entry) === norm(self.replace(/\.ts$/, ""));
}

if (isMain()) {
  run(parseCorpusArgs(process.argv.slice(2)).corpusDir);
}
