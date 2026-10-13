// Corpus analysis, structure and phrasing lens.
//
// Reads the normalizer output ($CORPUS_DIR/derived/recipes.jsonl and steps.jsonl) and
// measures how published MC Smart recipes are built: step shape, mode sequences,
// recurring phrases, how amounts and ingredient names are written, step titles,
// accessory usage and time fields.
//
// Output: $CORPUS_DIR/derived/structure.json  all numbers
//         $CORPUS_DIR/derived/structure.md    findings written as rules for the prompt
//
// The derived files contain copyrighted recipe text. Both outputs stay in the
// gitignored corpus directory. structure.md quotes only short generic phrases
// (at most six words) and aggregated counts; no recipe titles, authors or ids.
//
// Run: npm run corpus:analyze-structure   (needs npm run corpus:normalize first)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingredientKeys } from "./normalize.js";
import type { NormalizedIngredient, NormalizedRecipe, NormalizedStep } from "./types.js";
import { parseCorpusArgs } from "./locale.js";

// ---------------------------------------------------------------------------
// Small helpers

type Counter = Map<string, number>;

function inc(counter: Counter, key: string, by = 1): void {
  counter.set(key, (counter.get(key) ?? 0) + by);
}

function top(counter: Counter, n = Infinity): [string, number][] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function obj(counter: Counter, n = Infinity): Record<string, number> {
  return Object.fromEntries(top(counter, n));
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;
}

function pct(part: number, whole: number): string {
  return `${(share(part, whole) * 100).toFixed(1)} %`;
}

interface Quantiles {
  n: number;
  min: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
  mean: number;
}

function quantiles(values: readonly number[]): Quantiles {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  const at = (q: number): number => {
    if (n === 0) return 0;
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const a = v[lo] ?? 0;
    const b = v[hi] ?? 0;
    return Math.round((a + (b - a) * (pos - lo)) * 100) / 100;
  };
  const mean = n === 0 ? 0 : v.reduce((s, x) => s + x, 0) / n;
  return {
    n,
    min: v[0] ?? 0,
    p10: at(0.1),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: v[n - 1] ?? 0,
    mean: Math.round(mean * 100) / 100,
  };
}

function bucket(n: number, cap: number): string {
  return n >= cap ? `${cap}+` : String(n);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function words(s: string): number {
  const t = s.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/** Cuts a phrase to at most `max` words so structure.md never quotes long text. */
function short(s: string, max = 6): string {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length <= max ? w.join(" ") : `${w.slice(0, max).join(" ")} ...`;
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

// ---------------------------------------------------------------------------
// Step tokens

export function tempBand(t: number | null): string {
  if (t === null || t === 0) return "0";
  if (t <= 60) return "37-60";
  if (t <= 95) return "65-95";
  if (t <= 100) return "100";
  return "105-130";
}

export function speedBand(s: number | null): string {
  if (s === null) return "-";
  if (s === 0) return "0";
  if (s <= 2) return "1-2";
  if (s <= 4) return "3-4";
  if (s <= 7) return "5-7";
  return "8-10";
}

/** A normalized step with its title filled in (older derived files lack it). */
type Step = NormalizedStep & { title: string };

type StepLike = Pick<NormalizedStep, "kind" | "mode" | "temperature" | "speed" | "reverse">;

/**
 * Fine token: T for text, S for scale, C<temp band>/<speed band>[/R] for manual
 * (customized) steps, the mode name for every other program.
 */
export function fineToken(s: StepLike): string {
  if (s.kind === "text") return "T";
  if (s.mode === "scale") return "S";
  if (s.mode === "customized") {
    return `C${tempBand(s.temperature)}/${speedBand(s.speed)}${s.reverse ? "/R" : ""}`;
  }
  return s.mode;
}

/** Coarse token: T, S, C<temp band> for manual steps, the mode name otherwise. */
export function coarseToken(s: StepLike): string {
  if (s.kind === "text") return "T";
  if (s.mode === "scale") return "S";
  if (s.mode === "customized") return `C${tempBand(s.temperature)}`;
  return s.mode;
}

function isWorking(s: Step): boolean {
  return s.kind === "machine" && s.mode !== "scale";
}

/** T, S or M (machine step other than scale). */
function kindLetter(s: Step | undefined, edge: string): string {
  if (!s) return edge;
  if (s.kind === "text") return "T";
  return s.mode === "scale" ? "S" : "M";
}

// ---------------------------------------------------------------------------
// Phrases
//
// A step text is split into clauses at sentence marks, commas and a few joiners;
// accessory actions are classified per clause so "Messbecher entfernen und
// Rühraufsatz einsetzen" yields one action for each part.

export function clauses(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[.!?;:\n,]+|\s(?:und|dann|anschließend|danach|sowie)\s/u)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

const removeVerb =
  /entfern|abnehm|abgenommen|herausnehm|herausheb|herausgenommen|entnehm|entnommen|abheb|wegnehm|weglass|runternehm|\bohne\b|nicht einsetz|nicht aufsetz/u;
const insertVerb =
  /einsetz|eingesetzt|aufsetz|aufgesetzt|einsteck|aufsteck|draufsetz|einhäng|eingehängt|einleg|montier|anbring|verschlie|schließ|setzen|stecken/u;
const splashRe = /spritzschutz|auf den deckel|auf die deckelöffnung|in die deckelöffnung/u;

export type Action = "insert" | "remove" | "splash" | "other";

export function classifyAction(clause: string, allowSplash: boolean): Action {
  if (allowSplash && splashRe.test(clause)) return "splash";
  if (removeVerb.test(clause)) return "remove";
  if (insertVerb.test(clause)) return "insert";
  return "other";
}

export const accessoryNouns = {
  messbecher: /messbecher/u,
  ruehraufsatz: /r(?:ü|ue|u)hr(?:aufsatz|einsatz)|schmetterling/u,
  // The MC Smart's basket is called Kocheinsatz in most recipes, Gareinsatz in some.
  gareinsatz: /(?<!dampf|damf)gar(?:einsatz|korb)|kocheinsatz/u,
  dampfgaraufsatz: /dam?pfgar(?:aufsatz|einsatz|behälter)|dampfaufsatz|dampfentsafter/u,
  deckel: /deckel(?!öffnung)/u,
} as const;

type AccessoryKey = keyof typeof accessoryNouns;

/** Actions on one accessory found in a step text, in order. */
export function accessoryActions(text: string, key: AccessoryKey): Action[] {
  const noun = accessoryNouns[key];
  const out: Action[] = [];
  for (const c of clauses(text)) {
    if (!noun.test(c)) continue;
    // "Messbecher aus dem Deckel entfernen" is an action on the cup, not the lid.
    if (
      key === "deckel" &&
      (accessoryNouns.messbecher.test(c) || accessoryNouns.gareinsatz.test(c))
    )
      continue;
    out.push(classifyAction(c, key === "gareinsatz"));
  }
  return out;
}

interface PhraseDef {
  key: string;
  /** Short generic label, at most six words. */
  label: string;
  test: (text: string) => boolean;
}

const has =
  (re: RegExp) =>
  (text: string): boolean =>
    re.test(text.toLowerCase());

const action =
  (key: AccessoryKey, a: Action) =>
  (text: string): boolean =>
    accessoryActions(text, key).includes(a);

export const phrases: PhraseDef[] = [
  {
    key: "messbecher_einsetzen",
    label: "Messbecher einsetzen",
    test: action("messbecher", "insert"),
  },
  {
    key: "messbecher_entfernen",
    label: "Messbecher entfernen",
    test: action("messbecher", "remove"),
  },
  {
    key: "spatel_nach_unten",
    label: "mit dem Spatel nach unten schieben",
    test: has(
      /spa?r?tel[^.]*?(nach unten|hinunter|herunter|runter)|(nach unten|hinunter|herunter|runter)\w*[^.]*?spa?r?tel/u,
    ),
  },
  {
    key: "spatel_sonst",
    label: "Spatel, anderer Gebrauch",
    test: (t) =>
      /spa?r?tel/iu.test(t) &&
      !/spa?r?tel[^.]*?(nach unten|hinunter|herunter|runter)|(nach unten|hinunter|herunter|runter)\w*[^.]*?spa?r?tel/iu.test(
        t,
      ),
  },
  {
    key: "ruehraufsatz_einsetzen",
    label: "Rühraufsatz einsetzen",
    test: action("ruehraufsatz", "insert"),
  },
  {
    key: "ruehraufsatz_entfernen",
    label: "Rühraufsatz entfernen",
    test: action("ruehraufsatz", "remove"),
  },
  {
    key: "gareinsatz_einsetzen",
    label: "Kocheinsatz einsetzen",
    test: action("gareinsatz", "insert"),
  },
  {
    key: "gareinsatz_spritzschutz",
    label: "Kocheinsatz als Spritzschutz",
    test: action("gareinsatz", "splash"),
  },
  {
    key: "gareinsatz_entfernen",
    label: "Kocheinsatz entnehmen",
    test: action("gareinsatz", "remove"),
  },
  {
    key: "gareinsatz_befuellen",
    label: "in den Kocheinsatz geben",
    test: action("gareinsatz", "other"),
  },
  {
    key: "dampfgaraufsatz_aufsetzen",
    label: "Dampfgaraufsatz aufsetzen",
    test: action("dampfgaraufsatz", "insert"),
  },
  {
    key: "dampfgaraufsatz_abnehmen",
    label: "Dampfgaraufsatz abnehmen",
    test: action("dampfgaraufsatz", "remove"),
  },
  {
    key: "dampfgaraufsatz_befuellen",
    label: "im Dampfgaraufsatz verteilen",
    test: action("dampfgaraufsatz", "other"),
  },
  { key: "deckel_schliessen", label: "Deckel schließen", test: action("deckel", "insert") },
  { key: "deckel_oeffnen", label: "Deckel abnehmen", test: action("deckel", "remove") },
  { key: "deckeloeffnung", label: "durch die Deckelöffnung", test: has(/deckelöffnung/u) },
  { key: "abschmecken", label: "abschmecken", test: has(/abschmeck|abgeschmeckt/u) },
  {
    key: "beiseitestellen",
    label: "beiseitestellen",
    test: has(/beiseite ?(stell|gestellt)|zur seite (stell|gestellt)/u),
  },
  { key: "umfuellen", label: "umfüllen", test: has(/umfüll|umgefüllt/u) },
  {
    key: "mixbehaelter_ausspuelen",
    label: "Mixbehälter ausspülen",
    test: has(
      /(mixbehälter|mixtopf|topf)[^.]*?(ausspül|spülen|reinig|säuber|auswasch)|(ausspül|spülen|reinig|säuber)[^.]*?(mixbehälter|mixtopf)/u,
    ),
  },
  {
    key: "wasser_nachfuellen",
    label: "Wasser nachfüllen",
    test: has(/wasser[^.]*?(nachfüll|auffüll|nachgießen)|(nachfüll|auffüll)[^.]*?wasser/u),
  },
  {
    key: "in_mixbehaelter_geben",
    label: "in den Mixbehälter geben",
    test: has(/in den (mixbehälter|mixtopf|topf)\b[^.]*?(geben|füllen)/u),
  },
  {
    key: "zugeben",
    label: "zugeben / dazugeben / hinzufügen",
    test: has(/zugeben|dazugeben|hinzufügen|hinzugeben|dazu geben|zufügen/u),
  },
  { key: "abkuehlen_lassen", label: "abkühlen lassen", test: has(/abkühlen|auskühlen|erkalten/u) },
  { key: "servieren", label: "servieren", test: has(/servier|anrichten|genießen/u) },
  { key: "ofen_vorheizen", label: "Backofen vorheizen", test: has(/vorheiz|backofen|ofen auf/u) },
  { key: "turbo_taste", label: "Turbo-Taste drücken", test: has(/turbo/u) },
  { key: "stufe_im_text", label: "Stufe N im Text", test: has(/stufe\s*\d/u) },
  {
    key: "zeit_im_text",
    label: "N Minuten / Sekunden im Text",
    test: has(/\d+\s*(min|sek|sec|std|stunde)/u),
  },
  { key: "temperatur_im_text", label: "N °C / Grad im Text", test: has(/\d+\s*(°|grad)/u) },
];

const vesselNames: [string, RegExp][] = [
  ["Mixbehälter", /mixbehälter/iu],
  ["Mixtopf", /mixtopf/iu],
  ["Topf (bare)", /(?<![\p{L}])topf(?![\p{L}])/iu],
  ["Behälter (bare)", /(?<![\p{L}])behälter(?![\p{L}])/iu],
  ["Schüssel", /schüssel/iu],
];

// ---------------------------------------------------------------------------
// Amount formats in step text (broader than the normalizer's mention finder)

// The optional fraction takes its leading space only when a fraction follows, so the
// space group before the unit sees "200 g" as spaced.
export const amountFormatRe = new RegExp(
  String.raw`(?<![\p{L}\d.,/])` +
    String.raw`(\d+\s+\d\/\d|\d+\/\d+|\d+(?:[.,]\d+)?(?:\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])` +
    String.raw`(\s*[-–]\s*\d+(?:[.,]\d+)?)?` +
    String.raw`(\s*)` +
    String.raw`(kg|g|ml|l|cl|el|tl|prisen?|msp\.?|messerspitzen?|stück|stk\.?|zehen?|päckchen|pck\.?|pkg\.?|dosen?|bund|scheiben?|handvoll|tropfen|blätter|blatt|becher|liter|gramm|esslöffel|teelöffel)` +
    String.raw`(?![\p{L}])`,
  "giu",
);

const wordAmountRe =
  /(?<![\p{L}])(eine?n?|einem|einer|halbe[nr]?|zwei|drei|vier|etwas|einige|wenig|reichlich)\s+(prisen?|msp\.?|messerspitzen?|teelöffel|esslöffel|tl|el|schuss|spritzer|handvoll|päckchen|dose|bund|stück)(?![\p{L}])/giu;

export function numberFormat(num: string, range: string | undefined): string {
  if (range) return "range";
  const n = num.trim();
  if (/^\d+\s+\d\/\d$/.test(n)) return "mixed_ascii_fraction";
  if (/^\d+\/\d+$/.test(n)) return "ascii_fraction";
  if (/^\d+\s*[½¼¾⅓⅔⅛]$/u.test(n)) return "mixed_unicode_fraction";
  if (/^[½¼¾⅓⅔⅛]$/u.test(n)) return "unicode_fraction";
  if (/^\d+,\d+$/.test(n)) return "decimal_comma";
  if (/^\d+\.\d+$/.test(n)) return "decimal_dot";
  return "integer";
}

export function unitClass(u: string): string {
  const l = u.toLowerCase().replace(/\.$/, "");
  if (l === "g" || l === "gramm") return "g";
  if (l === "kg") return "kg";
  if (l === "ml" || l === "cl" || l === "l" || l === "liter") return "ml/l";
  if (l === "el" || l === "esslöffel") return "EL";
  if (l === "tl" || l === "teelöffel") return "TL";
  if (l.startsWith("prise")) return "Prise";
  if (l === "msp" || l.startsWith("messerspitze")) return "Msp";
  if (l === "stück" || l === "stk") return "Stück";
  return "other";
}

// ---------------------------------------------------------------------------
// Ingredient references

interface IngredientMatcher {
  verbatim: RegExp;
  core: RegExp | null;
  coreSuffix: RegExp | null;
  firstWord: RegExp | null;
  lastWord: RegExp | null;
  hasParens: boolean;
  /** First word of the core name, for compound matches (Knoblauch for Knoblauchzehen). */
  head: string | null;
}

/**
 * True when some word of the step text is the leading part of a compound ingredient
 * name: "Knoblauch" for "Knoblauchzehen", "Petersilie" for "Petersilienstiele".
 */
export function compoundPartUsed(head: string, textWords: ReadonlySet<string>): boolean {
  for (const w of textWords) {
    if (w.length < 4 || w === head) continue;
    if (head.startsWith(w) && head.length - w.length >= 3) return true;
    const stem = w.replace(/(en|n|e|s)$/u, "");
    if (stem.length >= 4 && stem !== w && head.startsWith(stem) && head.length - stem.length >= 3)
      return true;
  }
  return false;
}

function wordRe(key: string): RegExp {
  return new RegExp(`(?<![\\p{L}])${escapeRe(key)}(?![\\p{L}])`, "iu");
}

function coreName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\([^)]*\)/g, "")
      .split(",")[0]
      ?.replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

function ingredientMatcher(name: string): IngredientMatcher {
  const lower = name.toLowerCase().replace(/\s+/g, " ").trim();
  const core = coreName(name);
  const parts = core.split(" ").filter((w) => w.length >= 4);
  const first = parts[0];
  const last = parts.at(-1);
  return {
    verbatim: new RegExp(escapeRe(lower), "iu"),
    core: core.length >= 2 ? wordRe(core) : null,
    coreSuffix:
      core.length >= 2
        ? new RegExp(`(?<![\\p{L}])${escapeRe(core)}(n|en|e|s|er|ern)(?![\\p{L}])`, "iu")
        : null,
    firstWord: first && first !== core ? wordRe(first) : null,
    lastWord: last && last !== core && last !== first ? wordRe(last) : null,
    hasParens: /\(/.test(name),
    head: first && first.length >= 7 ? first : null,
  };
}

/** Ingredients that are tools or packaging rather than food. */
const equipmentRe =
  /form\b|backpapier|frischhaltefolie|folie|gläser|glas\b|flasche|spieß|zahnstocher|förmchen|papier|gefrierbeutel|beutel|ausstecher|spritzbeutel|tülle|sieb\b|tuch\b/i;

// ---------------------------------------------------------------------------
// Analysis

interface RecipeData {
  recipe: NormalizedRecipe;
  steps: Step[];
  categoryNames: string[];
}

const MIN_CATEGORY = 30;

function groupBy<T>(items: readonly T[], keys: (t: T) => readonly string[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    for (const k of keys(it)) {
      const list = out.get(k);
      if (list) list.push(it);
      else out.set(k, [it]);
    }
  }
  return out;
}

function srcOf(r: RecipeData): string {
  return r.recipe.source ?? "unknown";
}

// (a) recipe shape -----------------------------------------------------------

function shapeOf(group: readonly RecipeData[]) {
  const steps = group.map((r) => r.recipe.stepCount);
  const working = group.map((r) => r.recipe.machineStepCount - r.recipe.scaleStepCount);
  const scale = group.map((r) => r.recipe.scaleStepCount);
  const text = group.map((r) => r.recipe.textStepCount);
  const totalSteps = steps.reduce((a, b) => a + b, 0);
  return {
    recipes: group.length,
    stepsMedian: quantiles(steps).p50,
    stepsMean: quantiles(steps).mean,
    workingMachineStepsMedian: quantiles(working).p50,
    scaleStepsMedian: quantiles(scale).p50,
    textStepsMedian: quantiles(text).p50,
    shareText: share(
      text.reduce((a, b) => a + b, 0),
      totalSteps,
    ),
    shareScale: share(
      scale.reduce((a, b) => a + b, 0),
      totalSteps,
    ),
    shareWorkingMachine: share(
      working.reduce((a, b) => a + b, 0),
      totalSteps,
    ),
  };
}

function analyzeShape(recipes: readonly RecipeData[]) {
  const byCategory = groupBy(recipes, (r) => r.categoryNames);
  const bySource = groupBy(recipes, (r) => [srcOf(r)]);

  // What directly precedes a working machine step, and what sits between two of them.
  const precededBy = new Map<string, Counter>(); // source -> T/S/M/start
  const blockText = new Map<string, Counter>();
  const blockScale = new Map<string, Counter>();
  const blockTotal = new Map<string, Counter>();
  const blockShape: Counter = new Map();
  let blocks = 0;
  let blocksWithAmount = 0;
  let blocksWithIngredient = 0;
  let blocksEmpty = 0;
  const textBeforeFirst: number[] = [];
  const textAfterLast: number[] = [];
  const firstStep = new Map<string, number>();
  const lastStep = new Map<string, number>();

  // Scale steps.
  let scaleSteps = 0;
  const scalePrev = new Map<string, number>();
  let scaleNamesIngredient = 0;
  let scaleNamesOne = 0;
  let scaleWeightEqualsMatched = 0;
  let scaleWeightEqualsAny = 0;
  let scaleTextHasWeight = 0;
  let scaleStartsWithAmount = 0;
  let scaleTare = 0;
  let scaleAfterTextSameIngredient = 0;
  let scaleAfterText = 0;
  const scaleRunLengths = new Map<string, number>();
  const scaleBySource = new Map<
    string,
    { n: number; startsWithAmount: number; namesIngredient: number }
  >();

  for (const r of recipes) {
    const src = srcOf(r);
    const steps = r.steps;
    const keys = r.recipe.ingredients.map((i) => ingredientKeys(i.name));
    const named = (text: string): number[] => {
      const lower = text.toLowerCase();
      return keys
        .map((k, i) => (k.some((key) => lower.includes(key)) ? i : -1))
        .filter((i) => i >= 0);
    };
    inc(firstStep, kindLetter(steps[0], "none"));
    inc(lastStep, kindLetter(steps.at(-1), "none"));

    const workingIdx = steps.flatMap((s, i) => (isWorking(s) ? [i] : []));
    const firstW = workingIdx[0];
    const lastW = workingIdx.at(-1);
    if (firstW !== undefined)
      textBeforeFirst.push(steps.slice(0, firstW).filter((s) => s.kind === "text").length);
    if (lastW !== undefined)
      textAfterLast.push(steps.slice(lastW + 1).filter((s) => s.kind === "text").length);

    let prevW = -1;
    for (const wi of workingIdx) {
      const pb = precededBy.get(src) ?? new Map<string, number>();
      precededBy.set(src, pb);
      inc(pb, kindLetter(steps[wi - 1], "start"));
      const block = steps.slice(prevW + 1, wi);
      const t = block.filter((s) => s.kind === "text").length;
      const sc = block.length - t;
      for (const [m, v] of [
        [blockText, t],
        [blockScale, sc],
        [blockTotal, block.length],
      ] as const) {
        const c = m.get(src) ?? new Map<string, number>();
        m.set(src, c);
        inc(c, bucket(v, 6));
      }
      inc(blockShape, block.map((s) => (s.kind === "text" ? "T" : "S")).join("") || "(none)");
      blocks++;
      if (block.length === 0) blocksEmpty++;
      if (
        block.some((s) => s.amountsInText.length > 0 || (s.mode === "scale" && (s.weight ?? 0) > 0))
      )
        blocksWithAmount++;
      if (block.some((s) => named(s.text).length > 0)) blocksWithIngredient++;
      prevW = wi;
    }

    // Scale steps.
    let run = 0;
    for (let i = 0; i <= steps.length; i++) {
      const s = steps[i];
      if (s?.mode === "scale") {
        run++;
        continue;
      }
      if (run > 0) inc(scaleRunLengths, bucket(run, 6));
      run = 0;
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s?.mode !== "scale") continue;
      scaleSteps++;
      const bs = scaleBySource.get(src) ?? { n: 0, startsWithAmount: 0, namesIngredient: 0 };
      scaleBySource.set(src, bs);
      bs.n++;
      const prev = steps[i - 1];
      inc(scalePrev, kindLetter(prev, "start"));
      const text = `${s.title} ${s.text}`;
      const m = named(text);
      if (m.length > 0) {
        scaleNamesIngredient++;
        bs.namesIngredient++;
      }
      if (m.length === 1) scaleNamesOne++;
      const w = s.weight ?? 0;
      const near = (g: number | null): boolean => g !== null && Math.abs(g - w) <= 1;
      if (m.some((idx) => near(r.recipe.ingredients[idx]?.grams ?? null)))
        scaleWeightEqualsMatched++;
      if (r.recipe.ingredients.some((ing) => near(ing.grams))) scaleWeightEqualsAny++;
      if (w > 0 && new RegExp(`(?<![\\d.,])${w}(?![\\d.,])`).test(text)) scaleTextHasWeight++;
      if (/^\s*\d+(?:[.,]\d+)?\s*(g|kg|ml)\b/i.test(s.title)) {
        scaleStartsWithAmount++;
        bs.startsWithAmount++;
      }
      if (/schüssel|teller|gefäß|auf den deckel|auf die waage|tara/i.test(text) && m.length === 0)
        scaleTare++;
      if (prev?.kind === "text") {
        scaleAfterText++;
        const pm = named(prev.text);
        if (m.some((idx) => pm.includes(idx))) scaleAfterTextSameIngredient++;
      }
    }
  }

  const perSource = (m: Map<string, Counter>) =>
    Object.fromEntries([...m.entries()].map(([k, v]) => [k, obj(v)]));
  const allPreceded = new Map<string, number>();
  for (const c of precededBy.values()) for (const [k, v] of c) inc(allPreceded, k, v);
  const totalPreceded = [...allPreceded.values()].reduce((a, b) => a + b, 0);

  return {
    bySource: Object.fromEntries([...bySource.entries()].map(([k, v]) => [k, shapeOf(v)])),
    byCategory: Object.fromEntries(
      [...byCategory.entries()]
        .filter(([, v]) => v.length >= MIN_CATEGORY)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, v]) => [
          k,
          {
            all: shapeOf(v),
            official: shapeOf(v.filter((r) => srcOf(r) === "official")),
            member: shapeOf(v.filter((r) => srcOf(r) === "member")),
          },
        ]),
    ),
    workingStepPrecededBy: {
      all: obj(allPreceded),
      shareText: share(allPreceded.get("T") ?? 0, totalPreceded),
      shareTextOrScale: share(
        (allPreceded.get("T") ?? 0) + (allPreceded.get("S") ?? 0),
        totalPreceded,
      ),
      bySource: perSource(precededBy),
    },
    blocksBetweenWorkingSteps: {
      note: "block = steps after the previous working machine step (or the recipe start) up to the next one",
      blocks,
      emptyBlocks: blocksEmpty,
      shareWithAmount: share(blocksWithAmount, blocks),
      shareNamingIngredient: share(blocksWithIngredient, blocks),
      textStepsInBlock: perSource(blockText),
      scaleStepsInBlock: perSource(blockScale),
      stepsInBlock: perSource(blockTotal),
      topBlockShapes: obj(blockShape, 20),
    },
    textStepsBeforeFirstWorkingStep: quantiles(textBeforeFirst),
    textStepsAfterLastWorkingStep: quantiles(textAfterLast),
    firstStepKind: obj(firstStep),
    lastStepKind: obj(lastStep),
    scale: {
      steps: scaleSteps,
      precededBy: obj(scalePrev),
      shareNamingIngredient: share(scaleNamesIngredient, scaleSteps),
      shareNamingExactlyOne: share(scaleNamesOne, scaleSteps),
      shareWeightEqualsNamedIngredientGrams: share(scaleWeightEqualsMatched, scaleSteps),
      shareWeightEqualsSomeIngredientGrams: share(scaleWeightEqualsAny, scaleSteps),
      shareTextContainsWeight: share(scaleTextHasWeight, scaleSteps),
      shareTitleStartsWithAmount: share(scaleStartsWithAmount, scaleSteps),
      tareLikeSteps: scaleTare,
      afterTextStep: scaleAfterText,
      shareAfterTextNamingSameIngredient: share(scaleAfterTextSameIngredient, scaleAfterText),
      runLengths: obj(scaleRunLengths),
      bySource: Object.fromEntries(
        [...scaleBySource.entries()].map(([k, v]) => [
          k,
          {
            steps: v.n,
            shareTitleStartsWithAmount: share(v.startsWithAmount, v.n),
            shareNamingIngredient: share(v.namesIngredient, v.n),
          },
        ]),
      ),
    },
  };
}

// (b) mode n-grams -------------------------------------------------------------

function ngrams(seq: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= seq.length; i++) out.push(seq.slice(i, i + n).join(" > "));
  return out;
}

function hasWorkingToken(gram: string): boolean {
  return gram.split(" > ").some((t) => t !== "T" && t !== "S");
}

function ngramTable(
  recipes: readonly RecipeData[],
  n: number,
  token: (s: StepLike) => string,
  limit: number,
  onlyWithWorking = false,
) {
  const occ = new Map<string, number>();
  const rec = new Map<string, number>();
  for (const r of recipes) {
    const grams = ngrams(r.steps.map(token), n).filter(
      (g) => !onlyWithWorking || hasWorkingToken(g),
    );
    for (const g of grams) inc(occ, g);
    for (const g of new Set(grams)) inc(rec, g);
  }
  return top(occ, limit).map(([gram, count]) => ({ gram, count, recipes: rec.get(gram) ?? 0 }));
}

function analyzeNgrams(recipes: readonly RecipeData[]) {
  const byCategory = groupBy(recipes, (r) => r.categoryNames);
  const tokens = new Map<string, number>();
  for (const r of recipes) for (const s of r.steps) inc(tokens, fineToken(s));
  const cats = [...byCategory.entries()]
    .filter(([, v]) => v.length >= MIN_CATEGORY)
    .sort((a, b) => b[1].length - a[1].length);
  return {
    tokenLegend:
      "T text, S scale, C<temp band>/<speed band>[/R] manual (customized) mode; temp bands 0, 37-60, 65-95, 100, 105-130; speed bands 0, 1-2, 3-4, 5-7, 8-10; other programs by mode name",
    tokenFrequency: obj(tokens),
    overall: {
      fine3: ngramTable(recipes, 3, fineToken, 30),
      fine4: ngramTable(recipes, 4, fineToken, 30),
      coarse3: ngramTable(recipes, 3, coarseToken, 30),
      coarse4: ngramTable(recipes, 4, coarseToken, 30),
      fine3WithWorkingStep: ngramTable(recipes, 3, fineToken, 30, true),
      fine4WithWorkingStep: ngramTable(recipes, 4, fineToken, 30, true),
    },
    bySource: Object.fromEntries(
      ["official", "member"].map((src) => {
        const g = recipes.filter((r) => srcOf(r) === src);
        return [
          src,
          {
            fine3: ngramTable(g, 3, fineToken, 30),
            fine4: ngramTable(g, 4, fineToken, 30),
            fine4WithWorkingStep: ngramTable(g, 4, fineToken, 30, true),
          },
        ];
      }),
    ),
    byCategory: Object.fromEntries(
      cats.map(([k, v]) => [
        k,
        {
          recipes: v.length,
          fine3: ngramTable(v, 3, fineToken, 30),
          fine4: ngramTable(v, 4, fineToken, 30),
          fine3WithWorkingStep: ngramTable(v, 3, fineToken, 30, true),
          fine4WithWorkingStep: ngramTable(v, 4, fineToken, 30, true),
        },
      ]),
    ),
    // Working machine steps only: the "program skeleton" of a recipe.
    workingSkeleton3: (() => {
      const occ = new Map<string, number>();
      for (const r of recipes)
        for (const g of ngrams(r.steps.filter(isWorking).map(fineToken), 3)) inc(occ, g);
      return top(occ, 30).map(([gram, count]) => ({ gram, count }));
    })(),
  };
}

// (c) phrases -----------------------------------------------------------------

function analyzePhrases(recipes: readonly RecipeData[]) {
  const total = recipes.length;
  const textSteps = recipes.reduce((n, r) => n + r.recipe.textStepCount, 0);
  const results: Record<string, unknown> = {};
  for (const p of phrases) {
    let steps = 0;
    let inScaleSteps = 0;
    let inWorkingStepText = 0;
    const recSet = new Set<number>();
    const srcSteps = new Map<string, number>();
    const srcRecipes = new Map<string, Set<number>>();
    const nextKind = new Map<string, number>();
    const prevKind = new Map<string, number>();
    const nextMachine = new Map<string, number>();
    const prevMachine = new Map<string, number>();
    const nextMachineFine = new Map<string, number>();
    const third = new Map<string, number>();
    for (const r of recipes) {
      const src = srcOf(r);
      r.steps.forEach((s, i) => {
        if (s.kind !== "text") {
          if (p.test(`${s.title}\n${s.text}`)) {
            if (s.mode === "scale") inScaleSteps++;
            else inWorkingStepText++;
          }
          return;
        }
        if (!p.test(s.text)) return;
        steps++;
        recSet.add(r.recipe.id);
        inc(srcSteps, src);
        const set = srcRecipes.get(src) ?? new Set<number>();
        srcRecipes.set(src, set);
        set.add(r.recipe.id);
        inc(nextKind, kindLetter(r.steps[i + 1], "end"));
        inc(prevKind, kindLetter(r.steps[i - 1], "start"));
        const nm = r.steps.slice(i + 1).find(isWorking);
        const pm = r.steps.slice(0, i).reverse().find(isWorking);
        inc(nextMachine, nm ? coarseToken(nm) : "(none)");
        inc(nextMachineFine, nm ? fineToken(nm) : "(none)");
        inc(prevMachine, pm ? coarseToken(pm) : "(none)");
        inc(
          third,
          ["first third", "middle third", "last third"][
            Math.min(2, Math.floor((3 * i) / s.stepCount))
          ] ?? "?",
        );
      });
    }
    results[p.key] = {
      label: p.label,
      textSteps: steps,
      shareOfTextSteps: share(steps, textSteps),
      recipes: recSet.size,
      shareOfRecipes: share(recSet.size, total),
      bySourceSteps: obj(srcSteps),
      bySourceRecipes: Object.fromEntries([...srcRecipes.entries()].map(([k, v]) => [k, v.size])),
      alsoInScaleStepText: inScaleSteps,
      alsoInWorkingStepText: inWorkingStepText,
      nextStep: obj(nextKind),
      prevStep: obj(prevKind),
      nextWorkingStep: obj(nextMachine, 8),
      nextWorkingStepFine: obj(nextMachineFine, 8),
      prevWorkingStep: obj(prevMachine, 8),
      positionInRecipe: obj(third),
    };
  }

  const vessel: Record<string, Record<string, number>> = {};
  for (const [name, re] of vesselNames) {
    const bySrc = new Map<string, number>();
    for (const r of recipes)
      if (r.steps.some((s) => re.test(s.text) || re.test(s.title))) inc(bySrc, srcOf(r));
    vessel[name] = obj(bySrc);
  }
  return { textSteps, phrases: results, vesselNamingRecipesBySource: vessel };
}

// (d) amounts and ingredient names -----------------------------------------------

function analyzeAmounts(recipes: readonly RecipeData[]) {
  const scopes = ["text", "scale", "working"] as const;
  type Scope = (typeof scopes)[number];
  const scopeOf = (s: Step): Scope =>
    s.kind === "text" ? "text" : s.mode === "scale" ? "scale" : "working";
  const stepsIn = new Map<Scope, number>();
  const withAmount = new Map<Scope, number>();
  const withAmountBySource = new Map<string, { n: number; with: number }>();
  const unitsByScope = new Map<Scope, Counter>();
  const spelling = new Map<string, number>();
  const formats = new Map<string, number>();
  const spaceBeforeUnit = new Map<string, number>();
  const wordAmounts = new Map<string, number>();
  let gMentions = 0;
  let gMentionsMatchingIngredient = 0;

  for (const r of recipes) {
    const gramsSet = r.recipe.ingredients
      .map((i) => i.grams)
      .filter((g): g is number => g !== null);
    for (const s of r.steps) {
      const scope = scopeOf(s);
      stepsIn.set(scope, (stepsIn.get(scope) ?? 0) + 1);
      const text = s.kind === "text" ? s.text : `${s.title}\n${s.text === s.title ? "" : s.text}`;
      const found = [...text.matchAll(amountFormatRe)];
      if (found.length > 0) withAmount.set(scope, (withAmount.get(scope) ?? 0) + 1);
      if (scope === "text") {
        const b = withAmountBySource.get(srcOf(r)) ?? { n: 0, with: 0 };
        withAmountBySource.set(srcOf(r), b);
        b.n++;
        if (found.length > 0) b.with++;
      }
      const uc = unitsByScope.get(scope) ?? new Map<string, number>();
      unitsByScope.set(scope, uc);
      for (const m of found) {
        const [, num, range, space, unit] = m;
        if (num === undefined || unit === undefined) continue;
        const cls = unitClass(unit);
        inc(uc, cls);
        inc(spelling, unit);
        inc(
          formats,
          `${numberFormat(num, range)}${cls === "g" || cls === "TL" || cls === "EL" ? ` ${cls}` : ""}`,
        );
        if (cls === "g" || cls === "ml/l") inc(spaceBeforeUnit, space ? "with space" : "no space");
        if (cls === "g" && !range && scope !== "working") {
          const v = Number(num.replace(",", "."));
          if (Number.isFinite(v)) {
            gMentions++;
            if (gramsSet.some((g) => Math.abs(g - v) <= 1)) gMentionsMatchingIngredient++;
          }
        }
      }
      if (scope === "text")
        for (const m of text.matchAll(wordAmountRe))
          inc(wordAmounts, `${m[1]?.toLowerCase()} ${m[2]?.toLowerCase()}`);
    }
  }

  // Ingredient names in the step texts.
  const level = new Map<string, number>();
  const levelByUnit = new Map<string, Counter>();
  const restated = new Map<string, { n: number; restated: number }>();
  let withParens = 0;
  let parensKept = 0;
  let withComma = 0;
  let commaKept = 0;
  let equipment = 0;
  let ingredients = 0;
  for (const r of recipes) {
    const all = r.steps.map((s) => `${s.title}\n${s.text}`).join("\n");
    const textWords = new Set(all.toLowerCase().match(/\p{L}+/gu) ?? []);
    for (const ing of r.recipe.ingredients) {
      if (!ing.name.trim()) continue;
      if (equipmentRe.test(ing.name)) {
        equipment++;
        continue;
      }
      ingredients++;
      const m = ingredientMatcher(ing.name);
      let lv = "not mentioned";
      if (m.verbatim.test(all)) lv = "catalog name verbatim";
      else if (m.core?.test(all)) lv = "core name (qualifiers dropped)";
      else if (m.coreSuffix?.test(all)) lv = "core name inflected (plural/case ending)";
      else if (m.firstWord?.test(all)) lv = "first word only";
      else if (m.lastWord?.test(all)) lv = "last word only";
      else if (m.head && compoundPartUsed(m.head, textWords)) lv = "leading part of a compound";
      inc(level, lv);
      const lu = levelByUnit.get(ing.unitNorm) ?? new Map<string, number>();
      levelByUnit.set(ing.unitNorm, lu);
      inc(lu, lv);
      if (m.hasParens) {
        withParens++;
        if (lv === "catalog name verbatim") parensKept++;
      }
      if (ing.name.includes(",")) {
        withComma++;
        if (lv === "catalog name verbatim") commaKept++;
      }
      const rs = restated.get(ing.unitNorm) ?? { n: 0, restated: 0 };
      restated.set(ing.unitNorm, rs);
      if (ing.amount !== null) {
        rs.n++;
        if (amountRestated(ing, all)) rs.restated++;
      }
    }
  }

  const scopeShare = Object.fromEntries(
    scopes.map((sc) => [
      sc,
      {
        steps: stepsIn.get(sc) ?? 0,
        withAmount: withAmount.get(sc) ?? 0,
        share: share(withAmount.get(sc) ?? 0, stepsIn.get(sc) ?? 0),
      },
    ]),
  );
  return {
    stepsWithExplicitAmount: scopeShare,
    textStepsWithAmountBySource: Object.fromEntries(
      [...withAmountBySource.entries()].map(([k, v]) => [
        k,
        { steps: v.n, withAmount: v.with, share: share(v.with, v.n) },
      ]),
    ),
    unitClassByScope: Object.fromEntries([...unitsByScope.entries()].map(([k, v]) => [k, obj(v)])),
    unitSpellings: obj(spelling, 40),
    numberFormats: obj(formats),
    spaceBetweenNumberAndUnit: obj(spaceBeforeUnit),
    wordAmountsInTextSteps: obj(wordAmounts, 25),
    gramMentions: {
      count: gMentions,
      shareEqualToAnIngredientAmount: share(gMentionsMatchingIngredient, gMentions),
    },
    ingredientReferences: {
      ingredients,
      skippedEquipment: equipment,
      level: obj(level),
      levelByUnit: Object.fromEntries([...levelByUnit.entries()].map(([k, v]) => [k, obj(v)])),
      catalogNamesWithParentheses: withParens,
      shareParenthesesKeptInText: share(parensKept, withParens),
      catalogNamesWithComma: withComma,
      shareCommaQualifierKeptInText: share(commaKept, withComma),
      amountRestatedInStepsByUnit: Object.fromEntries(
        [...restated.entries()].map(([k, v]) => [
          k,
          { withAmount: v.n, restated: v.restated, share: share(v.restated, v.n) },
        ]),
      ),
    },
  };
}

function amountRestated(ing: NormalizedIngredient, text: string): boolean {
  if (ing.amount === null) return false;
  const raw = ing.amountRaw.trim();
  const candidates = new Set<string>([String(ing.amount), String(ing.amount).replace(".", ",")]);
  if (raw && /^[\d.,/½¼¾⅓⅔⅛\s-]+$/u.test(raw)) candidates.add(raw);
  const unitPart =
    ing.unitNorm === "g"
      ? "(g|gramm)"
      : ing.unitNorm === "ml"
        ? "(ml|l|liter)"
        : ing.unitNorm === "TL"
          ? "(tl|teelöffel)"
          : ing.unitNorm === "EL"
            ? "(el|esslöffel)"
            : null;
  for (const c of candidates) {
    const num = escapeRe(c);
    const re = unitPart
      ? new RegExp(`(?<![\\d.,/])${num}\\s*${unitPart}(?![\\p{L}])`, "iu")
      : new RegExp(`(?<![\\d.,/])${num}(?![\\d.,/])`, "u");
    if (re.test(text)) return true;
  }
  return false;
}

// (e) titles -----------------------------------------------------------------

function normTitle(t: string): string {
  return t
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "")
    .trim();
}

function analyzeTitles(recipes: readonly RecipeData[]) {
  const byMode = new Map<
    string,
    { n: number; titles: Counter; bySource: Map<string, { n: number; def: number }> }
  >();
  const descKind = new Map<string, Counter>(); // source -> empty / same / custom
  const customDescLen: number[] = [];
  const machineTitleWords = new Map<string, number>();
  const textRel = new Map<string, Counter>();
  const textLen = new Map<
    string,
    { chars: number[]; words: number[]; titleChars: number[]; sentences: number[] }
  >();
  const scaleTitle = new Map<string, Counter>();
  let turboWithSeconds = 0;
  let turboSecondsMatch = 0;
  const turboTimes: number[] = [];

  for (const r of recipes) {
    const src = srcOf(r);
    for (const s of r.steps) {
      if (s.kind === "text") {
        const rel = textRel.get(src) ?? new Map<string, number>();
        textRel.set(src, rel);
        const title = s.title.trim();
        const text = s.text.trim();
        if (title === text)
          inc(rel, text.length > 80 ? "title = text (over 80 chars)" : "title = text");
        else if (
          text.startsWith(title.replace(/\s+$/, "")) ||
          text.replace(/\s+/g, " ").startsWith(title.replace(/\s+/g, " "))
        )
          inc(rel, "title = start of text (cut)");
        else inc(rel, "title is a separate heading");
        const l = textLen.get(src) ?? { chars: [], words: [], titleChars: [], sentences: [] };
        textLen.set(src, l);
        l.chars.push(text.length);
        l.words.push(words(text));
        l.titleChars.push(title.length);
        l.sentences.push(
          text.split(/[.!?]+(?:\s|$)|\n+/).filter((x) => x.trim().length > 2).length,
        );
        continue;
      }
      if (s.mode === "scale") {
        const c = scaleTitle.get(src) ?? new Map<string, number>();
        scaleTitle.set(src, c);
        const t = s.title.trim();
        if (/^\d+(?:[.,]\d+)?\s*(g|kg|ml)\b/i.test(t)) inc(c, "starts with amount + unit");
        else if (/^\d/.test(t)) inc(c, "starts with other number");
        else if (words(t) <= 2) inc(c, "1-2 words, no number (ingredient name)");
        else inc(c, "other text");
        continue;
      }
      if (s.mode === "turbo") {
        const tm = /(\d+)\s*sekunde/i.exec(s.title);
        if (tm?.[1]) {
          turboWithSeconds++;
          if (Number(tm[1]) === s.timeSeconds) turboSecondsMatch++;
        }
        if (s.timeSeconds !== null) turboTimes.push(s.timeSeconds);
      }
      const m = byMode.get(s.mode) ?? {
        n: 0,
        titles: new Map<string, number>(),
        bySource: new Map(),
      };
      byMode.set(s.mode, m);
      m.n++;
      inc(m.titles, normTitle(s.title));
      inc(machineTitleWords, bucket(words(s.title), 6));
      const dk = descKind.get(src) ?? new Map<string, number>();
      descKind.set(src, dk);
      const desc = s.text.trim();
      if (desc === s.title.trim()) inc(dk, "empty or equal to title");
      else {
        inc(dk, "custom description");
        customDescLen.push(desc.length);
      }
    }
  }

  const modes: Record<string, unknown> = {};
  for (const [mode, m] of [...byMode.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const [defTitle, defCount] = top(m.titles, 1)[0] ?? ["", 0];
    const bySrc: Record<string, { steps: number; defaultTitle: number; share: number }> = {};
    for (const r of recipes) {
      for (const s of r.steps) {
        if (s.mode !== mode || s.kind !== "machine") continue;
        const e = (bySrc[srcOf(r)] ??= { steps: 0, defaultTitle: 0, share: 0 });
        e.steps++;
        if (normTitle(s.title).toLowerCase() === defTitle.toLowerCase()) e.defaultTitle++;
      }
    }
    for (const e of Object.values(bySrc)) e.share = share(e.defaultTitle, e.steps);
    modes[mode] = {
      steps: m.n,
      distinctTitles: m.titles.size,
      mostCommonTitle: defTitle,
      mostCommonTitleShare: share(defCount, m.n),
      defaultTitleBySource: bySrc,
      topTitles: obj(m.titles, 15),
    };
  }
  return {
    workingStepTitlesByMode: modes,
    workingStepTitleWords: obj(machineTitleWords),
    turbo: {
      titlesNamingSeconds: turboWithSeconds,
      shareSecondsEqualProgrammedTime: share(turboSecondsMatch, turboWithSeconds),
      timeSeconds: quantiles(turboTimes),
    },
    workingStepDescription: Object.fromEntries(
      [...descKind.entries()].map(([k, v]) => [k, obj(v)]),
    ),
    customDescriptionLength: quantiles(customDescLen),
    scaleStepTitles: Object.fromEntries([...scaleTitle.entries()].map(([k, v]) => [k, obj(v)])),
    textStepTitleVsText: Object.fromEntries([...textRel.entries()].map(([k, v]) => [k, obj(v)])),
    textStepLengths: Object.fromEntries(
      [...textLen.entries()].map(([k, v]) => [
        k,
        {
          textChars: quantiles(v.chars),
          textWords: quantiles(v.words),
          titleChars: quantiles(v.titleChars),
          sentences: quantiles(v.sentences),
          shareOver80Chars: share(v.chars.filter((c) => c > 80).length, v.chars.length),
          shareOver200Chars: share(v.chars.filter((c) => c > 200).length, v.chars.length),
        },
      ]),
    ),
  };
}

// (f) accessories --------------------------------------------------------------

interface UsageAcc {
  steps: number;
  modes: Counter;
  fine: Counter;
  speed: Counter;
  temp: Counter;
  time: number[];
}

function newUsage(): UsageAcc {
  return {
    steps: 0,
    modes: new Map(),
    fine: new Map(),
    speed: new Map(),
    temp: new Map(),
    time: [],
  };
}

function addUsage(u: UsageAcc, s: Step): void {
  u.steps++;
  inc(u.modes, s.mode);
  inc(u.fine, fineToken(s));
  inc(u.speed, s.speed === null ? "program (no speed)" : String(s.speed));
  inc(u.temp, tempBand(s.temperature));
  if (s.timeSeconds !== null) u.time.push(s.timeSeconds);
}

function usageOut(u: UsageAcc) {
  return {
    workingSteps: u.steps,
    modes: obj(u.modes),
    tokens: obj(u.fine, 12),
    speed: obj(u.speed),
    tempBand: obj(u.temp),
    timeSeconds: quantiles(u.time),
  };
}

function analyzeAccessories(recipes: readonly RecipeData[]) {
  const total = recipes.length;
  const bySrcTotal = new Map<string, number>();
  for (const r of recipes) inc(bySrcTotal, srcOf(r));
  const accessoryNames = [
    "Ruehraufsatz",
    "Gareinsatz",
    "Dampfgaraufsatz",
    "Messbecher",
    "Spatel",
  ] as const;
  const recipeShare: Record<string, unknown> = {};
  for (const a of accessoryNames) {
    const bySrc = new Map<string, number>();
    for (const r of recipes) if (r.recipe.accessories.includes(a)) inc(bySrc, srcOf(r));
    const n = [...bySrc.values()].reduce((x, y) => x + y, 0);
    recipeShare[a] = {
      recipes: n,
      share: share(n, total),
      bySource: Object.fromEntries(
        [...bySrc.entries()].map(([k, v]) => [
          k,
          { recipes: v, share: share(v, bySrcTotal.get(k) ?? 0) },
        ]),
      ),
    };
  }

  // State machines over each recipe: an accessory counts as fitted from a step that
  // inserts it until a step that removes it. The basket used as splash guard applies
  // to the next working step only.
  const ruehr = newUsage();
  const garIn = newUsage();
  const garSplash = newUsage();
  const dampf = newUsage();
  const messIn = new Map<string, UsageAcc>([
    ["inserted", newUsage()],
    ["removed", newUsage()],
    ["never mentioned before", newUsage()],
  ]);
  const messByToken = new Map<string, Counter>();
  const ruehrMaxSpeedViolations = new Map<string, number>();
  const steamingWater: number[] = [];
  let steamingSteps = 0;
  let steamingWithDampfMention = 0;
  const steamingUsage = newUsage();
  const ruehrShareByMode = new Map<string, { n: number; with: number }>();

  for (const r of recipes) {
    let ruehrOn = false;
    let garOn = false;
    let splashNext = false;
    let dampfOn = false;
    let mess: "inserted" | "removed" | "never mentioned before" = "never mentioned before";
    let blockStart = 0;
    r.steps.forEach((s, i) => {
      const text = s.kind === "text" ? s.text : `${s.title}\n${s.text}`;
      for (const a of accessoryActions(text, "ruehraufsatz")) {
        if (a === "insert" || a === "other") ruehrOn = a === "insert" ? true : ruehrOn;
        if (a === "remove") ruehrOn = false;
      }
      for (const a of accessoryActions(text, "gareinsatz")) {
        if (a === "insert") garOn = true;
        if (a === "remove") garOn = false;
        if (a === "splash") splashNext = true;
      }
      for (const a of accessoryActions(text, "dampfgaraufsatz")) {
        if (a === "insert") dampfOn = true;
        if (a === "remove") dampfOn = false;
      }
      for (const a of accessoryActions(text, "messbecher")) {
        if (a === "insert") mess = "inserted";
        if (a === "remove") mess = "removed";
      }
      if (!isWorking(s)) return;
      const rm = ruehrShareByMode.get(coarseToken(s)) ?? { n: 0, with: 0 };
      ruehrShareByMode.set(coarseToken(s), rm);
      rm.n++;
      if (ruehrOn) {
        rm.with++;
        addUsage(ruehr, s);
        if (s.speed !== null && s.speed > 4) inc(ruehrMaxSpeedViolations, String(s.speed));
      }
      if (garOn) addUsage(garIn, s);
      if (splashNext) {
        addUsage(garSplash, s);
        splashNext = false;
      }
      if (dampfOn) addUsage(dampf, s);
      const mu = messIn.get(mess);
      if (mu) addUsage(mu, s);
      const mt = messByToken.get(coarseToken(s)) ?? new Map<string, number>();
      messByToken.set(coarseToken(s), mt);
      inc(mt, mess);
      if (s.mode === "steaming") {
        steamingSteps++;
        addUsage(steamingUsage, s);
        const block = r.steps.slice(0, i);
        if (
          block.some((b) =>
            accessoryNouns.dampfgaraufsatz.test(`${b.title} ${b.text}`.toLowerCase()),
          )
        )
          steamingWithDampfMention++;
        // Water filled since the previous working step: a scale step or an amount next to "Wasser".
        let water = 0;
        for (const b of r.steps.slice(blockStart, i)) {
          if (!/wasser/i.test(b.text)) continue;
          if (b.mode === "scale" && b.weight) water += b.weight;
          else {
            const m = /(\d+(?:[.,]\d+)?)\s*(g|ml)\s*(?:\p{L}+\s+){0,2}wasser/iu.exec(b.text);
            if (m?.[1]) water += Number(m[1].replace(",", "."));
          }
        }
        if (water > 0) steamingWater.push(water);
      }
      blockStart = i + 1;
    });
  }

  return {
    recipeShare,
    ruehraufsatzFitted: {
      ...usageOut(ruehr),
      stepsAboveSpeed4: obj(ruehrMaxSpeedViolations),
      shareOfWorkingStepsByToken: Object.fromEntries(
        top(new Map([...ruehrShareByMode.entries()].map(([k, v]) => [k, v.with])))
          .filter(([, v]) => v > 0)
          .map(([k]) => {
            const v = ruehrShareByMode.get(k) ?? { n: 0, with: 0 };
            return [k, { steps: v.n, withRuehraufsatz: v.with, share: share(v.with, v.n) }];
          }),
      ),
    },
    gareinsatzInBowl: usageOut(garIn),
    gareinsatzAsSplashGuard: usageOut(garSplash),
    dampfgaraufsatzFitted: usageOut(dampf),
    steaming: {
      steps: steamingSteps,
      shareWithDampfgaraufsatzMentionedBefore: share(steamingWithDampfMention, steamingSteps),
      settings: usageOut(steamingUsage),
      waterFilledBeforeGrams: quantiles(steamingWater),
    },
    messbecherStateAtWorkingStep: Object.fromEntries(
      [...messIn.entries()].map(([k, v]) => [k, usageOut(v)]),
    ),
    messbecherStateByToken: Object.fromEntries(
      [...messByToken.entries()]
        .sort(
          (a, b) =>
            [...b[1].values()].reduce((x, y) => x + y, 0) -
            [...a[1].values()].reduce((x, y) => x + y, 0),
        )
        .map(([k, v]) => [k, obj(v)]),
    ),
  };
}

// (g) times --------------------------------------------------------------------

/** Least squares fit y = b0 + b1*x1 + b2*x2 via the normal equations. */
export function fit2(
  rows: readonly [number, number, number][],
): { b0: number; b1: number; b2: number; r2: number } | null {
  const n = rows.length;
  if (n < 3) return null;
  const s = { x1: 0, x2: 0, y: 0, x1x1: 0, x2x2: 0, x1x2: 0, x1y: 0, x2y: 0 };
  for (const [x1, x2, y] of rows) {
    s.x1 += x1;
    s.x2 += x2;
    s.y += y;
    s.x1x1 += x1 * x1;
    s.x2x2 += x2 * x2;
    s.x1x2 += x1 * x2;
    s.x1y += x1 * y;
    s.x2y += x2 * y;
  }
  const a = [
    [n, s.x1, s.x2, s.y],
    [s.x1, s.x1x1, s.x1x2, s.x1y],
    [s.x2, s.x1x2, s.x2x2, s.x2y],
  ];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r]?.[c] ?? 0) > Math.abs(a[p]?.[c] ?? 0)) p = r;
    const rowP = a[p];
    const rowC = a[c];
    if (!rowP || !rowC) return null;
    a[p] = rowC;
    a[c] = rowP;
    const piv = rowP[c] ?? 0;
    if (Math.abs(piv) < 1e-9) return null;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const row = a[r];
      if (!row) return null;
      const f = (row[c] ?? 0) / piv;
      for (let k = c; k < 4; k++) row[k] = (row[k] ?? 0) - f * (rowP[k] ?? 0);
    }
  }
  const b = [0, 1, 2].map((i) => (a[i]?.[3] ?? 0) / (a[i]?.[i] ?? 1));
  const [b0 = 0, b1 = 0, b2 = 0] = b;
  const mean = s.y / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const [x1, x2, y] of rows) {
    ssTot += (y - mean) ** 2;
    ssRes += (y - (b0 + b1 * x1 + b2 * x2)) ** 2;
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    b0: round(b0),
    b1: round(b1),
    b2: round(b2),
    r2: round(ssTot === 0 ? 0 : 1 - ssRes / ssTot),
  };
}

function timeStats(group: readonly RecipeData[]) {
  const ratio: number[] = [];
  const offMachine: number[] = [];
  const prepShare: number[] = [];
  const machineMin: number[] = [];
  const total: number[] = [];
  const prep: number[] = [];
  let totalBelowMachine = 0;
  let totalBelowPrep = 0;
  for (const r of group) {
    const m = r.recipe.totalMachineSeconds / 60;
    const t = r.recipe.totalMinutes;
    const p = r.recipe.prepMinutes;
    machineMin.push(Math.round(m * 10) / 10);
    if (t !== null) total.push(t);
    if (p !== null) prep.push(p);
    if (t !== null && m > 0) {
      ratio.push(Math.round((t / m) * 100) / 100);
      offMachine.push(Math.round((t - m) * 10) / 10);
      if (t + 0.5 < m) totalBelowMachine++;
    }
    if (t !== null && p !== null && t > 0) {
      prepShare.push(Math.round((p / t) * 100) / 100);
      if (t < p) totalBelowPrep++;
    }
  }
  return {
    recipes: group.length,
    totalMinutes: quantiles(total),
    prepMinutes: quantiles(prep),
    machineMinutes: quantiles(machineMin),
    totalOverMachineRatio: quantiles(ratio),
    offMachineMinutes: quantiles(offMachine),
    prepOverTotalRatio: quantiles(prepShare),
    totalBelowMachineTime: totalBelowMachine,
    totalBelowPrepTime: totalBelowPrep,
  };
}

function analyzeTimes(recipes: readonly RecipeData[]) {
  const byCategory = groupBy(recipes, (r) => r.categoryNames);
  const usable = recipes.filter(
    (r) =>
      r.recipe.totalMinutes !== null &&
      r.recipe.prepMinutes !== null &&
      r.recipe.totalMinutes <= 600 &&
      r.recipe.totalMachineSeconds <= 6 * 3600,
  );
  const totalFit = fit2(
    usable.map((r) => [
      r.recipe.totalMachineSeconds / 60,
      r.recipe.prepMinutes ?? 0,
      r.recipe.totalMinutes ?? 0,
    ]),
  );
  const prepFit = fit2(
    usable.map((r) => [
      r.recipe.textStepCount,
      r.recipe.ingredientCount,
      r.recipe.prepMinutes ?? 0,
    ]),
  );
  const prepFitMachine = fit2(
    usable.map((r) => [
      r.recipe.stepCount,
      r.recipe.totalMachineSeconds / 60,
      r.recipe.prepMinutes ?? 0,
    ]),
  );
  return {
    overall: timeStats(recipes),
    bySource: Object.fromEntries(
      ["official", "member"].map((s) => [s, timeStats(recipes.filter((r) => srcOf(r) === s))]),
    ),
    byCategory: Object.fromEntries(
      [...byCategory.entries()]
        .filter(([, v]) => v.length >= MIN_CATEGORY)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, v]) => [k, timeStats(v)]),
    ),
    fits: {
      note: "ordinary least squares over recipes with totalMinutes <= 600 and machine time <= 6 h",
      recipes: usable.length,
      totalMinutes_from_machineMinutes_and_prepMinutes: totalFit,
      prepMinutes_from_textSteps_and_ingredientCount: prepFit,
      prepMinutes_from_stepCount_and_machineMinutes: prepFitMachine,
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown report

type Json = Record<string, unknown>;

function get(o: unknown, ...keys: string[]): unknown {
  let cur: unknown = o;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Json)[k];
  }
  return cur;
}

function num(o: unknown, ...keys: string[]): number {
  const v = get(o, ...keys);
  return typeof v === "number" ? v : 0;
}

function p100(x: number): string {
  return `${(x * 100).toFixed(1)} %`;
}

function counterLine(c: unknown, n = 8, total?: number): string {
  if (!c || typeof c !== "object") return "";
  const entries = Object.entries(c as Record<string, number>).slice(0, n);
  const sum = total ?? Object.values(c as Record<string, number>).reduce((a, b) => a + b, 0);
  return entries.map(([k, v]) => `${short(k)} ${v} (${pct(v, sum)})`).join(", ");
}

function table(head: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.map(String).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

export function renderMarkdown(result: ReturnType<typeof analyze>): string {
  const { shape, ngrams: ng, phrases: ph, amounts, titles, accessories: acc, times } = result;
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines);
  const src = (s: string) => shape.bySource[s];
  const off = src("official");
  const mem = src("member");
  const pre = shape.workingStepPrecededBy;
  const blk = shape.blocksBetweenWorkingSteps;
  const sc = shape.scale;

  add(
    "# Corpus structure and phrasing",
    "",
    `Derived from ${result.meta.recipes} published MC Smart recipes (de-DE) and ${result.meta.steps} steps; generated ${result.meta.generatedAt}.`,
    "Terms: *text step* has no device setting; *scale step* is a weighing step; *working step* is any other machine step (manual or program).",
    "Official recipes are the reference; member recipes are shown where they differ. Quoted phrases are short generic wording, not recipe text.",
    "",
    "## Rules for the generator",
    "",
  );

  const rules: string[] = [];
  const pTS = pre.shareTextOrScale;
  rules.push(
    `Put the ingredients into the bowl in their own steps right before the working step that processes them: ${p100(pTS)} of working steps directly follow a text or scale step (${p100(pre.shareText)} a text step). Two working steps back to back are rare (${pct(blk.emptyBlocks, blk.blocks)} of blocks), and are used for a continued phase such as a further cooking stage.`,
  );
  rules.push(
    `Weigh each solid or liquid ingredient given in g in its own scale step whose title starts with the amount and the ingredient (pattern "500 g Zucker dazugeben."): there are ${sc.steps} scale steps, ${p100(sc.shareNamingIngredient)} name an ingredient, ${p100(sc.shareNamingExactlyOne)} exactly one, ${p100(num(sc.bySource, "official", "shareTitleStartsWithAmount"))} of official scale-step titles start with "<N> g", and ${p100(sc.shareWeightEqualsNamedIngredientGrams)} weigh exactly the gram amount of the named ingredient.`,
  );
  const unitsText = get(amounts.unitClassByScope, "text") as Record<string, number> | undefined;
  rules.push(
    `Spoon, pinch and piece amounts (TL, EL, Prise, Stück) go into text steps with the amount written out; g amounts mostly live in scale steps. Units found in text steps: ${counterLine(unitsText, 7)}.`,
  );
  rules.push(
    `Restate the amount whenever an ingredient is added: ${p100(num(amounts.ingredientReferences.amountRestatedInStepsByUnit, "g", "share"))} of g ingredients and ${p100(num(amounts.ingredientReferences.amountRestatedInStepsByUnit, "TL", "share"))} of TL ingredients have their amount written in a step. ${p100(amounts.gramMentions.shareEqualToAnIngredientAmount)} of g amounts in step text equal an amount from the ingredient list; the rest are split portions.`,
  );
  const lvl = amounts.ingredientReferences.level;
  const lvTotal = amounts.ingredientReferences.ingredients;
  rules.push(
    `Use the ingredient-list name in the step, but drop the qualifiers in parentheses and after a comma: plain names appear verbatim, while only ${p100(amounts.ingredientReferences.shareParenthesesKeptInText)} of names with parentheses and ${p100(amounts.ingredientReferences.shareCommaQualifierKeptInText)} of names with a comma qualifier do. Overall: ${counterLine(lvl, 7, lvTotal)}.`,
  );
  const cust = titles.workingStepTitlesByMode.customized as Json | undefined;
  rules.push(
    `Title working steps with the program's default name, not a custom sentence: the most common manual-step title is "${short(String(get(cust, "mostCommonTitle")))}" (${p100(num(cust, "defaultTitleBySource", "official", "share"))} of official manual steps, ${p100(num(cust, "defaultTitleBySource", "member", "share"))} of member ones). Leave the description of working steps empty (official: ${counterLine(get(titles.workingStepDescription, "official"), 2)}).`,
  );
  const tl = get(titles.textStepLengths, "official") as Json | undefined;
  rules.push(
    `Keep text steps short, one or two instructions: official text steps have a median of ${num(tl, "textWords", "p50")} words (p90 ${num(tl, "textWords", "p90")}), ${num(tl, "textChars", "p50")} characters, and ${p100(num(tl, "shareOver80Chars"))} exceed the 80-character title limit. The title is the text itself, cut at 80 characters (${counterLine(get(titles.textStepTitleVsText, "official"), 3)}).`,
  );
  const spatel = ph.phrases.spatel_nach_unten as Json;
  rules.push(
    `After chopping, add a text step to push the food down with the spatula: "mit dem Spatel nach unten schieben" appears in ${num(spatel, "textSteps")} text steps in ${p100(num(spatel, "shareOfRecipes"))} of recipes; the working step before it is ${counterLine(get(spatel, "prevWorkingStep"), 3)}.`,
  );
  const mE = ph.phrases.messbecher_entfernen as Json;
  const mI = ph.phrases.messbecher_einsetzen as Json;
  const messRoast = acc.messbecherStateByToken.roasting ?? {};
  const messC0 = acc.messbecherStateByToken.C0 ?? {};
  rules.push(
    `Handle the measuring cup in its own text step: take it out before the roasting program (state at roasting steps: removed ${messRoast.removed ?? 0}, inserted ${messRoast.inserted ?? 0}) and usually before cooking at 100 °C or more without stirring hard; put it back before cold chopping or mixing (state at C0 steps: inserted ${messC0.inserted ?? 0}, removed ${messC0.removed ?? 0}). "Messbecher entfernen" ${num(mE, "textSteps")} steps, next working step ${counterLine(get(mE, "nextWorkingStep"), 3)}; "Messbecher einsetzen" ${num(mI, "textSteps")} steps, next ${counterLine(get(mI, "nextWorkingStepFine"), 4)}. Most working steps have no stated cup action at all, so the cup is mentioned only when it changes.`,
  );
  const rf = acc.ruehraufsatzFitted;
  rules.push(
    `With the stirring attachment fitted, keep speed at 4 or lower: ${rf.workingSteps} working steps run with it, speeds ${counterLine(rf.speed, 6)}; steps above speed 4: ${Object.values(rf.stepsAboveSpeed4).reduce((a, b) => a + b, 0)}. Insert and remove it with own text steps.`,
  );
  const st = acc.steaming;
  rules.push(
    `Steaming: fill water in a step before the steaming program (median ${st.waterFilledBeforeGrams.p50} g, p10-p90 ${st.waterFilledBeforeGrams.p10}-${st.waterFilledBeforeGrams.p90} g over ${st.waterFilledBeforeGrams.n} steaming steps where it could be read), and name the steamer level before it (${p100(st.shareWithDampfgaraufsatzMentionedBefore)} of ${st.steps} steaming steps).`,
  );
  rules.push(
    `Start with a preparation or weighing step and end with text steps for finishing and serving: first step ${counterLine(shape.firstStepKind, 3)}; median ${shape.textStepsAfterLastWorkingStep.p50} text steps after the last working step (p90 ${shape.textStepsAfterLastWorkingStep.p90}).`,
  );
  const fit = times.fits.totalMinutes_from_machineMinutes_and_prepMinutes;
  const cat = (k: string) => times.byCategory[k];
  const soup = cat("Suppen & Eintöpfe");
  const bake = cat("Backen");
  rules.push(
    `Total time is never below machine time (${times.overall.totalBelowMachineTime} of ${times.overall.recipes} recipes break this) and is estimated per dish type, not from step counts: a linear fit on machine and prep minutes explains almost nothing (R² ${fit?.r2 ?? "?"}). Dishes cooked in the bowl run close to machine time (Suppen & Eintöpfe total/machine median ${soup?.totalOverMachineRatio.p50 ?? "?"}), dishes finished elsewhere add the outside time (Backen: median ${bake?.offMachineMinutes.p50 ?? "?"} minutes beyond machine time). Prep time median ${times.overall.prepMinutes.p50} min, prep/total median ${times.overall.prepOverTotalRatio.p50}.`,
  );
  const tb = titles.turbo;
  rules.push(
    `Turbo is its own step whose title names the seconds (pattern "Turbo-Taste für N Sekunden ..."); the number matches the programmed time in ${p100(tb.shareSecondsEqualProgrammedTime)} of ${tb.titlesNamingSeconds} such titles; turbo time median ${tb.timeSeconds.p50} s (p90 ${tb.timeSeconds.p90}).`,
  );
  const sk = ng.workingSkeleton3
    .slice(0, 4)
    .map((r) => `\`${r.gram}\` ${r.count}`)
    .join(", ");
  rules.push(
    `Typical working-step order in savory cooked dishes: chop cold first (C0 at speed 5-10), then roast, then cook at 100 °C with reverse at speed 1-2; repeated identical steps (stirring in stages) are common. Most frequent program sequences: ${sk}.`,
  );
  rules.forEach((r, i) => add(`${i + 1}. ${r}`));

  add("", "## (a) Recipe shape", "");
  add(
    table(
      [
        "group",
        "recipes",
        "steps p50",
        "working p50",
        "scale p50",
        "text p50",
        "text share",
        "scale share",
        "working share",
      ],
      [
        ...(["official", "member"] as const).flatMap((k) => {
          const s = src(k);
          return s
            ? [
                [
                  k,
                  s.recipes,
                  s.stepsMedian,
                  s.workingMachineStepsMedian,
                  s.scaleStepsMedian,
                  s.textStepsMedian,
                  p100(s.shareText),
                  p100(s.shareScale),
                  p100(s.shareWorkingMachine),
                ],
              ]
            : [];
        }),
        ...Object.entries(shape.byCategory).map(([k, v]) => {
          const s = v.all;
          return [
            k,
            s.recipes,
            s.stepsMedian,
            s.workingMachineStepsMedian,
            s.scaleStepsMedian,
            s.textStepsMedian,
            p100(s.shareText),
            p100(s.shareScale),
            p100(s.shareWorkingMachine),
          ];
        }),
      ],
    ),
    "",
    `- Working step directly preceded by: ${counterLine(pre.all)}. Official: ${counterLine(get(pre.bySource, "official"))}. Member: ${counterLine(get(pre.bySource, "member"))}.`,
    `- Text steps between two working steps (official): ${counterLine(get(blk.textStepsInBlock, "official"))}.`,
    `- Scale steps between two working steps (official): ${counterLine(get(blk.scaleStepsInBlock, "official"))}.`,
    `- Most common block shapes (T text, S scale) before a working step: ${counterLine(blk.topBlockShapes, 10, blk.blocks)}.`,
    `- Blocks with an amount: ${p100(blk.shareWithAmount)}; naming an ingredient: ${p100(blk.shareNamingIngredient)}.`,
    `- Text steps before the first working step: p50 ${shape.textStepsBeforeFirstWorkingStep.p50}, p90 ${shape.textStepsBeforeFirstWorkingStep.p90}. After the last: p50 ${shape.textStepsAfterLastWorkingStep.p50}, p90 ${shape.textStepsAfterLastWorkingStep.p90}.`,
    `- Scale steps preceded by: ${counterLine(sc.precededBy)}. Runs of consecutive scale steps: ${counterLine(sc.runLengths)}. When a text step precedes a scale step, it names the same ingredient in ${p100(sc.shareAfterTextNamingSameIngredient)} of cases: the scale step adds the ingredient itself, the text step before it does something else (prepare, cut, insert).`,
    `- Scale step text contains its weight: ${p100(sc.shareTextContainsWeight)}; weight equals some ingredient's grams: ${p100(sc.shareWeightEqualsSomeIngredientGrams)}; tare-like steps (bowl or plate on the lid, no ingredient): ${sc.tareLikeSteps}.`,
    `- Official vs member: official recipes have ${off?.stepsMedian ?? "?"} steps (median) against ${mem?.stepsMedian ?? "?"}, scale share ${p100(off?.shareScale ?? 0)} against ${p100(mem?.shareScale ?? 0)}.`,
  );

  add("", "## (b) Mode n-grams", "", ng.tokenLegend, "");
  const gramRows = (rows: { gram: string; count: number; recipes: number }[], n = 30) =>
    rows.slice(0, n).map((r) => [r.gram, r.count, r.recipes]);
  add(
    "### Fine, length 3 (all recipes)",
    "",
    table(["sequence", "count", "recipes"], gramRows(ng.overall.fine3)),
    "",
  );
  add(
    "### Fine, length 4 (all recipes)",
    "",
    table(["sequence", "count", "recipes"], gramRows(ng.overall.fine4)),
    "",
  );
  add(
    "### Fine, length 3, containing a working step",
    "",
    table(["sequence", "count", "recipes"], gramRows(ng.overall.fine3WithWorkingStep)),
    "",
  );
  add(
    "### Fine, length 4, containing a working step",
    "",
    table(["sequence", "count", "recipes"], gramRows(ng.overall.fine4WithWorkingStep)),
    "",
  );
  add(
    "### Coarse, length 4 (all recipes)",
    "",
    table(["sequence", "count", "recipes"], gramRows(ng.overall.coarse4, 15)),
    "",
  );
  add(
    "### Program skeleton (working steps only, length 3)",
    "",
    table(
      ["sequence", "count"],
      ng.workingSkeleton3.slice(0, 15).map((r) => [r.gram, r.count]),
    ),
    "",
  );
  add("### Per category (fine, length 4, containing a working step, top 5)", "");
  for (const [cat, v] of Object.entries(ng.byCategory)) {
    add(
      `- **${cat}** (${v.recipes}): ${v.fine4WithWorkingStep
        .slice(0, 5)
        .map((r) => `\`${r.gram}\` ${r.count}`)
        .join("; ")}`,
    );
  }
  add(
    "",
    `Official top 4-grams: ${(
      get(ng.bySource, "official", "fine4") as { gram: string; count: number }[]
    )
      .slice(0, 8)
      .map((r) => `\`${r.gram}\` ${r.count}`)
      .join("; ")}.`,
  );
  add(
    `Member top 4-grams: ${(
      get(ng.bySource, "member", "fine4") as { gram: string; count: number }[]
    )
      .slice(0, 8)
      .map((r) => `\`${r.gram}\` ${r.count}`)
      .join("; ")}.`,
  );

  add(
    "",
    "## (c) Standard phrases",
    "",
    `${ph.textSteps} text steps. Position columns: next/previous step kind (T text, S scale, M working) and the next working step.`,
    "",
  );
  add(
    table(
      [
        "phrase",
        "text steps",
        "recipes",
        "official / member recipes",
        "next step",
        "next working step",
        "previous working step",
      ],
      Object.values(ph.phrases).map((v) => {
        const j = v as Json;
        return [
          short(String(j.label)),
          num(j, "textSteps"),
          `${num(j, "recipes")} (${p100(num(j, "shareOfRecipes"))})`,
          `${num(j, "bySourceRecipes", "official")} / ${num(j, "bySourceRecipes", "member")}`,
          counterLine(j.nextStep, 3),
          counterLine(j.nextWorkingStep, 3),
          counterLine(j.prevWorkingStep, 3),
        ];
      }),
    ),
    "",
    `Vessel naming (recipes using the word, by source): ${Object.entries(
      ph.vesselNamingRecipesBySource,
    )
      .map(([k, v]) => `${k}: official ${v.official ?? 0}, member ${v.member ?? 0}`)
      .join("; ")}.`,
  );

  add("", "## (d) Amounts and ingredient names", "");
  add(
    `- Steps with an explicit amount: ${Object.entries(amounts.stepsWithExplicitAmount)
      .map(([k, v]) => `${k} ${v.withAmount}/${v.steps} (${p100(v.share)})`)
      .join(", ")}.`,
    `- Text steps with an amount by source: ${Object.entries(amounts.textStepsWithAmountBySource)
      .map(([k, v]) => `${k} ${p100(v.share)}`)
      .join(", ")}.`,
    `- Unit classes by step kind: ${Object.entries(amounts.unitClassByScope)
      .map(([k, v]) => `${k}: ${counterLine(v, 6)}`)
      .join(" / ")}.`,
    `- Unit spellings as written: ${counterLine(amounts.unitSpellings, 14)}.`,
    `- Number formats: ${counterLine(amounts.numberFormats, 14)}.`,
    `- g and ml written with a space between number and unit: ${counterLine(amounts.spaceBetweenNumberAndUnit)}.`,
    `- Amounts in words in text steps: ${counterLine(amounts.wordAmountsInTextSteps, 10)}.`,
    `- Ingredient name references (${lvTotal} ingredients, ${amounts.ingredientReferences.skippedEquipment} equipment items skipped): ${counterLine(lvl, 6, lvTotal)}.`,
    `- Catalog names with a comma qualifier (pattern "Hefe, frisch"): ${amounts.ingredientReferences.catalogNamesWithComma}, written verbatim in steps ${p100(amounts.ingredientReferences.shareCommaQualifierKeptInText)}. With parentheses: ${amounts.ingredientReferences.catalogNamesWithParentheses}, verbatim ${p100(amounts.ingredientReferences.shareParenthesesKeptInText)}.`,
    `- Amount restated in a step, by unit: ${Object.entries(
      amounts.ingredientReferences.amountRestatedInStepsByUnit,
    )
      .map(([k, v]) => `${k} ${v.restated}/${v.withAmount} (${p100(v.share)})`)
      .join(", ")}.`,
    `- Not mentioned at all, by unit: ${Object.entries(amounts.ingredientReferences.levelByUnit)
      .map(
        ([k, v]) =>
          `${k} ${pct(
            v["not mentioned"] ?? 0,
            Object.values(v).reduce((a, b) => a + b, 0),
          )}`,
      )
      .join(", ")}.`,
  );

  add("", "## (e) Step titles", "");
  add(
    table(
      [
        "mode",
        "steps",
        "distinct titles",
        "most common title",
        "share",
        "official share",
        "member share",
      ],
      Object.entries(titles.workingStepTitlesByMode).map(([k, v]) => {
        const j = v as Json;
        return [
          k,
          num(j, "steps"),
          num(j, "distinctTitles"),
          short(String(j.mostCommonTitle)),
          p100(num(j, "mostCommonTitleShare")),
          p100(num(j, "defaultTitleBySource", "official", "share")),
          p100(num(j, "defaultTitleBySource", "member", "share")),
        ];
      }),
    ),
    "",
    `- Working-step title length in words: ${counterLine(titles.workingStepTitleWords)}.`,
    `- Working-step description: ${Object.entries(titles.workingStepDescription)
      .map(([k, v]) => `${k}: ${counterLine(v)}`)
      .join(" / ")}. Custom descriptions: median ${titles.customDescriptionLength.p50} chars.`,
    `- Scale-step titles: ${Object.entries(titles.scaleStepTitles)
      .map(([k, v]) => `${k}: ${counterLine(v)}`)
      .join(" / ")}.`,
    `- Text-step title vs text: ${Object.entries(titles.textStepTitleVsText)
      .map(([k, v]) => `${k}: ${counterLine(v)}`)
      .join(" / ")}.`,
    `- Text-step length: ${Object.entries(titles.textStepLengths)
      .map(
        ([k, v]) =>
          `${k}: words p50 ${v.textWords.p50} / p90 ${v.textWords.p90}, chars p50 ${v.textChars.p50} / p90 ${v.textChars.p90}, sentences p50 ${v.sentences.p50}, over 80 chars ${p100(v.shareOver80Chars)}, over 200 chars ${p100(v.shareOver200Chars)}`,
      )
      .join(" / ")}.`,
  );
  add("", "Common custom titles of manual steps (generic, at most six words):", "");
  const custTop = (get(cust, "topTitles") ?? {}) as Record<string, number>;
  add(
    Object.entries(custTop)
      .slice(0, 15)
      .map(([k, v]) => `"${short(k)}" ${v}`)
      .join(", "),
  );

  add("", "## (f) Accessories", "");
  add(
    table(
      ["accessory", "recipes", "share", "official share", "member share"],
      Object.entries(acc.recipeShare).map(([k, v]) => {
        const j = v as Json;
        return [
          k,
          num(j, "recipes"),
          p100(num(j, "share")),
          p100(num(j, "bySource", "official", "share")),
          p100(num(j, "bySource", "member", "share")),
        ];
      }),
    ),
    "",
  );
  const usageLine = (name: string, u: ReturnType<typeof usageOut>) =>
    `- ${name}: ${u.workingSteps} working steps; modes ${counterLine(u.modes, 5)}; tokens ${counterLine(u.tokens, 5)}; speed ${counterLine(u.speed, 6)}; time p50 ${u.timeSeconds.p50} s (p10 ${u.timeSeconds.p10}, p90 ${u.timeSeconds.p90}).`;
  add(
    usageLine("Rühraufsatz fitted", acc.ruehraufsatzFitted),
    `  Steps above speed 4 with it fitted: ${counterLine(acc.ruehraufsatzFitted.stepsAboveSpeed4)} (these may be parse misses where the removal was not phrased as expected).`,
    usageLine("Kocheinsatz in the bowl", acc.gareinsatzInBowl),
    usageLine(
      "Kocheinsatz as splash guard on the lid (next working step)",
      acc.gareinsatzAsSplashGuard,
    ),
    usageLine("Dampfgaraufsatz fitted", acc.dampfgaraufsatzFitted),
    usageLine("Steaming program", acc.steaming.settings),
    `- Water before steaming: ${JSON.stringify(acc.steaming.waterFilledBeforeGrams)}.`,
    "",
    "Measuring-cup state (last stated action) at each working step, by token:",
    "",
    table(
      ["token", "inserted", "removed", "not mentioned before"],
      Object.entries(acc.messbecherStateByToken)
        .slice(0, 14)
        .map(([k, v]) => [k, v.inserted ?? 0, v.removed ?? 0, v["never mentioned before"] ?? 0]),
    ),
  );

  add("", "## (g) Times", "");
  const trow = (k: string, t: ReturnType<typeof timeStats>) => [
    k,
    t.recipes,
    t.totalMinutes.p50,
    t.prepMinutes.p50,
    t.machineMinutes.p50,
    `${t.totalOverMachineRatio.p25} / ${t.totalOverMachineRatio.p50} / ${t.totalOverMachineRatio.p75}`,
    t.offMachineMinutes.p50,
    t.prepOverTotalRatio.p50,
    t.totalBelowMachineTime,
  ];
  add(
    table(
      [
        "group",
        "recipes",
        "total p50",
        "prep p50",
        "machine min p50",
        "total/machine p25/p50/p75",
        "off-machine min p50",
        "prep/total p50",
        "total < machine",
      ],
      [
        trow("all", times.overall),
        ...Object.entries(times.bySource).map(([k, v]) => trow(k, v)),
        ...Object.entries(times.byCategory).map(([k, v]) => trow(k, v)),
      ],
    ),
    "",
    `Fits (${times.fits.recipes} recipes): ${JSON.stringify(times.fits.totalMinutes_from_machineMinutes_and_prepMinutes)} for total ~ machine min + prep min; ${JSON.stringify(times.fits.prepMinutes_from_textSteps_and_ingredientCount)} for prep ~ text steps + ingredients; ${JSON.stringify(times.fits.prepMinutes_from_stepCount_and_machineMinutes)} for prep ~ steps + machine min.`,
    "",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Entry

export function analyze(
  recipeRows: readonly NormalizedRecipe[],
  stepRows: readonly NormalizedStep[],
  started = Date.now(),
) {
  const byRecipe = new Map<number, Step[]>();
  for (const s of stepRows) {
    // Derived files written before the title field existed: fall back to the text.
    const step: Step = { ...s, title: s.title ?? s.text };
    const list = byRecipe.get(step.recipeId);
    if (list) list.push(step);
    else byRecipe.set(step.recipeId, [step]);
  }
  const recipes: RecipeData[] = recipeRows.map((recipe) => ({
    recipe,
    steps: (byRecipe.get(recipe.id) ?? []).sort((a, b) => a.stepIndex - b.stepIndex),
    categoryNames: recipe.categories.map((c) => c.name ?? String(c.id)),
  }));
  const result = {
    meta: {
      generatedAt: new Date().toISOString(),
      recipes: recipes.length,
      steps: stepRows.length,
      minRecipesPerCategory: MIN_CATEGORY,
      runtimeSeconds: 0,
    },
    shape: analyzeShape(recipes),
    ngrams: analyzeNgrams(recipes),
    phrases: analyzePhrases(recipes),
    amounts: analyzeAmounts(recipes),
    titles: analyzeTitles(recipes),
    accessories: analyzeAccessories(recipes),
    times: analyzeTimes(recipes),
  };
  result.meta.runtimeSeconds = Math.round((Date.now() - started) / 100) / 10;
  return result;
}

export function run(corpusDir: string): void {
  const started = Date.now();
  const dir = path.join(corpusDir, "derived");
  const recipes = readJsonl<NormalizedRecipe>(path.join(dir, "recipes.jsonl"));
  const steps = readJsonl<NormalizedStep>(path.join(dir, "steps.jsonl"));
  const result = analyze(recipes, steps, started);
  writeFileSync(path.join(dir, "structure.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(path.join(dir, "structure.md"), renderMarkdown(result));
  console.log(
    `corpus:analyze-structure: ${recipes.length} recipes, ${steps.length} steps -> ${dir} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
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
