// Corpus analysis, timing lens: how long the published recipes run each device
// program, and how that relates to the mass in the bowl, the target temperature
// and a simple heating model.
//
// Input:  $CORPUS_DIR/derived/recipes.jsonl and steps.jsonl (from corpus:normalize)
// Output: $CORPUS_DIR/derived/timing.json  all numbers
//         $CORPUS_DIR/derived/timing.md    formulas and findings in our own words
//
// The output holds aggregated numbers only: no step text, titles, authors or ids.
//
// Run: npm run corpus:analyze-timing

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingredientKeys } from "./normalize.js";
import type { NormalizedRecipe, NormalizedStep } from "./types.js";

// ---------------------------------------------------------------------------
// Statistics

export interface Dist {
  n: number;
  min: number | null;
  p05: number | null;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export function dist(values: readonly number[]): Dist {
  const s = [...values].sort((x, y) => x - y);
  const q = (p: number) => {
    const v = quantile(s, p);
    return v === null ? null : round(v);
  };
  return {
    n: s.length,
    min: q(0),
    p05: q(0.05),
    p10: q(0.1),
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p95: q(0.95),
    max: q(1),
    mean: s.length ? round(s.reduce((a, b) => a + b, 0) / s.length) : null,
  };
}

export interface LinearFit {
  n: number;
  /** Intercept. */
  a: number;
  /** Slope per unit of x. */
  b: number;
  r2: number;
  residual: { p10: number | null; median: number | null; p90: number | null };
}

/** Ordinary least squares y = a + b*x. */
export function linearFit(xs: readonly number[], ys: readonly number[]): LinearFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i] ?? 0;
    sy += ys[i] ?? 0;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  const res: number[] = [];
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = (ys[i] ?? 0) - (a + b * (xs[i] ?? 0));
    res.push(r);
    sse += r * r;
  }
  const rd = dist(res);
  return {
    n,
    a: round(a, 3),
    b: round(b, 4),
    r2: syy === 0 ? 0 : round(1 - sse / syy, 3),
    residual: { p10: rd.p10, median: rd.median, p90: rd.p90 },
  };
}

/** Multiple least squares y = c0 + sum(ci * xi); solves the normal equations. */
export function multiFit(
  rows: readonly number[][],
  ys: readonly number[],
): { coef: number[]; r2: number; n: number } | null {
  const n = rows.length;
  const k = (rows[0]?.length ?? 0) + 1;
  if (n <= k) return null;
  const m: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let r = 0; r < n; r++) {
    const x = [1, ...(rows[r] ?? [])];
    const y = ys[r] ?? 0;
    for (let i = 0; i < k; i++) {
      const row = m[i];
      if (!row) continue;
      for (let j = 0; j < k; j++) row[j] = (row[j] ?? 0) + (x[i] ?? 0) * (x[j] ?? 0);
      row[k] = (row[k] ?? 0) + (x[i] ?? 0) * y;
    }
  }
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = r;
    }
    const tmp = m[col];
    const pv = m[pivot];
    if (!tmp || !pv) return null;
    m[col] = pv;
    m[pivot] = tmp;
    const div = pv[col] ?? 0;
    if (Math.abs(div) < 1e-12) return null;
    for (let j = col; j <= k; j++) pv[j] = (pv[j] ?? 0) / div;
    for (let r = 0; r < k; r++) {
      const row = m[r];
      if (r === col || !row) continue;
      const f = row[col] ?? 0;
      for (let j = col; j <= k; j++) row[j] = (row[j] ?? 0) - f * (pv[j] ?? 0);
    }
  }
  const coef = m.map((row) => row[k] ?? 0);
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sse = 0;
  let sst = 0;
  for (let r = 0; r < n; r++) {
    const x = [1, ...(rows[r] ?? [])];
    const pred = coef.reduce((s, c, i) => s + c * (x[i] ?? 0), 0);
    const y = ys[r] ?? 0;
    sse += (y - pred) ** 2;
    sst += (y - my) ** 2;
  }
  return { coef: coef.map((c) => round(c, 4)), r2: sst === 0 ? 0 : round(1 - sse / sst, 3), n };
}

/** Group values into buckets of `size` on x and return a distribution of y per bucket. */
export function buckets(
  pairs: readonly { x: number; y: number }[],
  size: number,
  minN = 1,
): { from: number; to: number; time: Dist }[] {
  const groups = new Map<number, number[]>();
  for (const p of pairs) {
    const key = Math.floor(p.x / size);
    const list = groups.get(key) ?? [];
    list.push(p.y);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, ys]) => ys.length >= minN)
    .map(([key, ys]) => ({ from: key * size, to: (key + 1) * size, time: dist(ys) }));
}

// ---------------------------------------------------------------------------
// Physics

export const HEATER_WATTS = 1050;
export const HEATER_EFFICIENCY = 0.7;
export const WATER_HEAT_CAPACITY = 4200; // J/(kg*K)
export const START_TEMPERATURE = 20;

/**
 * Seconds needed to heat `grams` of water-like content from 20 degC to `tempC`.
 * Content with water cannot exceed 100 degC, so the target is capped at boiling.
 */
export function physicalMinSeconds(grams: number, tempC: number): number {
  const deltaT = Math.max(0, Math.min(tempC, 100) - START_TEMPERATURE);
  return ((grams / 1000) * WATER_HEAT_CAPACITY * deltaT) / (HEATER_WATTS * HEATER_EFFICIENCY);
}

// ---------------------------------------------------------------------------
// Bowl mass estimate
//
// The normalizer's cumulativeGramsBefore never drops: it keeps counting after the
// bowl is emptied, counts food that is weighed on a plate on top of the lid, and
// counts ingredients that a text step merely mentions. This estimator walks the
// steps again and is stricter:
//   - A scale step adds its weight to the bowl, unless its text says the weighing
//     happens in a separate vessel on top ("Schüssel auf den Mixbehälter ... darin
//     abwiegen"), in the steamer, or outside the machine. Such weights are parked
//     per ingredient and join the bowl when a later step adds that ingredient.
//   - A text or machine step adds an ingredient's grams the first time it names
//     it, but only when the text has an adding verb (dazugeben, hinzufuegen, in den
//     Mixbehaelter ...). Ingredients that go into the steamer go to the steamer pool.
//   - A strong reset cue (umfuellen, Mixbehaelter spuelen/leeren/reinigen) empties
//     the bowl; "die Haelfte umfuellen" halves it. A weak cue (in eine Schuessel
//     geben, abgiessen) empties it only when the step names no new ingredient.

const addCue =
  /in den (mix(behälter|topf)|topf|behälter|kocheinsatz|gareinsatz)|dazu(geben|gießen|bröckeln|wiegen|füllen|schütten)|hinzu(fügen|geben)|zugeben|zufügen|einwiegen|einfüllen|einstreuen|hinein(geben|bröckeln|gießen)|darüber(gießen|geben)|aufgießen|zur flüssigkeit|zurück in den|in (den|die|dem) (tiefen |flachen )?dampfgar/;
// Scale steps that only weigh food for preparation (wash, cut, set aside) do not
// fill the bowl; the weight is parked until a later step adds the ingredient.
const prepOnlyScaleCue =
  /beiseite|waschen|schneiden|schälen|putzen|halbieren|vierteln|achteln|abspülen|tupfen|entkernen|entfernen|abtropfen|reiben|würfeln|teilen|entrinden|verlesen|auspressen|abreiben|stellen und/;
const offBowlScaleCue =
  /(schüssel|teller|schale|gefäß|messbecher|becher|form|brett|topf|glas)[^.]{0,40}(auf|über) (den|dem) (mix|deckel)|\bdarauf\b|\bdarin\b|nach packungsanweisung|dampfgar/;
const steamerCue = /dampfgar/;
const strongResetCue =
  /umfüllen|(mix(behälter|topf)|behälter)[^.]{0,25}(spülen|reinigen|leeren|säubern|auswischen|ausspülen|auswaschen)|(spülen|reinigen|leeren|säubern|ausspülen|auswischen)[^.]{0,12}(mix(behälter|topf)|behälter)|aus dem mix(behälter|topf)/;
const halfCue = /hälfte/;
const weakResetCue =
  /in (eine|die|einen|ein|den|das) [^.]{0,50}(schüssel|form|schale|kanne|karaffe|flasche|gläser|glas|tassen?|teller|sieb|topf|pfanne|dose|behältnis)[^.]{0,30}(geben|füllen|gießen|abfüllen|streichen|verteilen)|abgießen|abschütten|abseihen|abtropfen/;
// Food handled in a pan, pot or bowl outside the machine.
const outsideVesselCue =
  /in (einer|einem) [^.]{0,30}(pfanne|topf|schüssel|form|schale|auflaufform|glas)/;
// The step talks about the machine bowl or the basket inside it.
const machineVessel = /(mix(behälter|topf)|kocheinsatz|gareinsatz)/;
const mixtureWords = /teig|masse|inhalt|sauce|soße|suppe|creme|mischung|brühe|püree|marmelade/;

const flourName = /mehl(?!ig)/i;
const flourExclude =
  /paniermehl|johannisbrot|kartoffelmehl|mehlig|zum (verarbeiten|bestäuben|bearbeiten|ausrollen|bemehlen)|für die (form|arbeitsfläche)|fett und mehl|^mehl zum/i;

export function isFlour(name: string): boolean {
  return flourName.test(name) && !flourExclude.test(name);
}

export type ResetKind = "none" | "strong" | "weak" | "half";

export interface StepEstimate {
  /** Estimated grams in the bowl after this step's own additions. */
  bowlGrams: number;
  /** Grams this step added to the bowl. */
  addedGrams: number;
  /** Part of addedGrams that is flour. */
  flourAddedGrams: number;
  /** Grams this step put into the steamer attachment. */
  steamerAddedGrams: number;
  /** Reset applied before this step's additions. */
  reset: ResetKind;
}

export function estimateBowl(
  recipe: NormalizedRecipe,
  steps: readonly NormalizedStep[],
): StepEstimate[] {
  const keys = recipe.ingredients.map((ing) => ingredientKeys(ing.name));
  const flour = recipe.ingredients.map((ing) => isFlour(ing.name));
  const added = new Set<number>(); // ingredient index already counted somewhere
  const fromText = new Map<number, number>(); // grams counted from a text mention, still in bowl
  const parked = new Map<number, number>(); // grams weighed off-bowl, not yet added
  let bowl = 0;

  return steps.map((step) => {
    const text = step.text.toLowerCase();
    const matched: number[] = [];
    keys.forEach((ks, i) => {
      if (ks.some((k) => text.includes(k))) matched.push(i);
    });
    const newMatches = matched.filter((i) => !added.has(i) && !parked.has(i));

    let reset: ResetKind = "none";
    if (step.mode !== "scale") {
      if (strongResetCue.test(text)) reset = halfCue.test(text) ? "half" : "strong";
      else if (
        weakResetCue.test(text) &&
        !machineVessel.test(text) &&
        (newMatches.length === 0 || mixtureWords.test(text))
      )
        reset = "weak";
    }
    if (reset === "half") bowl *= 0.5;
    else if (reset !== "none") {
      bowl = 0;
      fromText.clear();
    }

    let addedGrams = 0;
    let flourAdded = 0;
    let steamerAdded = 0;

    if (step.mode === "scale") {
      const weight = step.weight ?? 0;
      const offBowl =
        offBowlScaleCue.test(text) ||
        /beiseite/.test(text) ||
        (!addCue.test(text) && prepOnlyScaleCue.test(text));
      const toSteamer = steamerCue.test(text);
      const knownGrams = matched.map((i) => recipe.ingredients[i]?.grams ?? 0);
      const knownSum = knownGrams.reduce((a, b) => a + b, 0);
      const flourShare =
        matched.length === 0
          ? 0
          : knownSum > 0
            ? matched.reduce((s, i, j) => s + (flour[i] ? (knownGrams[j] ?? 0) : 0), 0) / knownSum
            : matched.filter((i) => flour[i]).length / matched.length;
      if (toSteamer) {
        steamerAdded = weight;
        for (const i of matched) added.add(i);
      } else if (offBowl) {
        if (matched.length > 0) {
          matched.forEach((i, j) => {
            const share = knownSum > 0 ? (knownGrams[j] ?? 0) / knownSum : 1 / matched.length;
            parked.set(i, (parked.get(i) ?? 0) + weight * share);
          });
        }
      } else {
        for (const i of matched) {
          const prior = fromText.get(i);
          if (prior !== undefined) {
            bowl -= prior;
            addedGrams -= prior;
            if (flour[i]) flourAdded -= prior;
            fromText.delete(i);
          }
          added.add(i);
        }
        bowl += weight;
        addedGrams += weight;
        flourAdded += weight * flourShare;
      }
    } else if (
      addCue.test(text) &&
      !((weakResetCue.test(text) || outsideVesselCue.test(text)) && !machineVessel.test(text))
    ) {
      // A step that puts food into a glass, form or plate outside the machine adds nothing.
      const toSteamer = steamerCue.test(text);
      for (const i of matched) {
        const parkedGrams = parked.get(i);
        let grams: number;
        if (parkedGrams !== undefined) {
          grams = parkedGrams;
          parked.delete(i);
        } else if (!added.has(i)) {
          grams = recipe.ingredients[i]?.grams ?? 0;
        } else continue;
        added.add(i);
        if (toSteamer) {
          // Parked weights are already counted as off-bowl scale weight by the steaming analysis.
          if (parkedGrams === undefined) steamerAdded += grams;
          continue;
        }
        bowl += grams;
        addedGrams += grams;
        if (flour[i]) flourAdded += grams;
        if (parkedGrams === undefined) fromText.set(i, grams);
      }
    }
    if (bowl < 0) bowl = 0;
    return {
      bowlGrams: round(bowl, 1),
      addedGrams: round(addedGrams, 1),
      flourAddedGrams: round(flourAdded, 1),
      steamerAddedGrams: round(steamerAdded, 1),
      reset,
    };
  });
}

// ---------------------------------------------------------------------------
// Ingredient classes (matched on lowercase step text)

type ClassList = readonly (readonly [string, RegExp])[];

export const steamClasses: ClassList = [
  [
    "dumplings_dough",
    /knödel|klöße|kloß|klösse|dampfnudel|dumpling|\bbao\b|teigtasche|maultasche|spätzle|gnocchi|hefeteig|brötchen|teig/,
  ],
  [
    "dessert_in_form",
    /kuchen|pudding|förmchen|\bform\b|gläser|\bglas\b|auflauf|flan|tassen|muffin|creme/,
  ],
  [
    "fish_seafood",
    /lachs|fisch|kabeljau|seelachs|forelle|garnele|scampi|dorade|zander|thunfisch|muschel|pangasius|rotbarsch|scholle|heilbutt|shrimp|krabbe|tintenfisch/,
  ],
  [
    "meat_poultry",
    /hähnchen|huhn|hühn|pute|fleisch|schwein|rind|frikadelle|würst|wurst|kassler|lamm|hack|bällchen|schnitzel/,
  ],
  ["potatoes", /kartoffel/],
  [
    "vegetables",
    /gemüse|möhre|karotte|brokkoli|broccoli|blumenkohl|zucchini|paprika|bohne|spargel|kohlrabi|erbse|rosenkohl|kürbis|lauch|porree|fenchel|spinat|\bmais\b|pastinake|sellerie|aubergine|kohl|pilz|champignon|zuckerschote|rote bete|rübe|mangold|zwiebel/,
  ],
  ["eggs", /\beier?\b/],
];

export const chopClasses: ClassList = [
  ["chocolate", /schokolade|kuvertüre/],
  ["hard_cheese", /parmesan|pecorino|grana|bergkäse|hartkäse|käse/],
  ["nuts_seeds", /nüsse|nuss|mandel|pistazie|cashew|kerne|samen|sesam/],
  ["bread_biscuits", /brot|brötchen|zwieback|keks|cracker|biskuit|baguette/],
  ["ice", /eiswürfel|crushed ice|\beis\b/],
  ["onion_garlic", /zwiebel|knoblauch|schalotte|ingwer/],
  [
    "herbs",
    /petersilie|kräuter|basilikum|schnittlauch|\bdill\b|koriander|minze|thymian|rosmarin|salbei|oregano/,
  ],
  [
    "meat_fish",
    /fleisch|hähnchen|huhn|pute|schinken|speck|lachs|fisch|thunfisch|hack|wurst|salami/,
  ],
  [
    "vegetables",
    /möhre|karotte|paprika|sellerie|zucchini|gurke|tomate|kohl|lauch|porree|fenchel|brokkoli|blumenkohl|kürbis|rote bete|aubergine|gemüse|chili|pilz|champignon|spinat|radieschen|rettich/,
  ],
  [
    "fruit",
    /apfel|äpfel|birne|beere|erdbeer|banane|mango|ananas|obst|frucht|früchte|orange|kirsch|pfirsich|aprikose|datteln|rosinen|pflaume/,
  ],
  ["sugar_spices", /zucker|pfeffer|gewürz|körner|salz|zimt|kaffeebohnen|vanille/],
];

/** Primary class (first match in priority order) and all matched classes. */
export function classify(text: string, list: ClassList): { primary: string; all: string[] } {
  const all = list.filter(([, re]) => re.test(text)).map(([name]) => name);
  return { primary: all[0] ?? "other", all };
}

// ---------------------------------------------------------------------------
// Durations named in text steps (oven, proofing, resting)

const durationRe =
  /(\d+(?:[.,]\d+)?)(?:\s*(?:-|–|bis)\s*(\d+(?:[.,]\d+)?))?\s*(minuten|min\b|min\.|stunden|stunde|std\b|std\.)/g;

/** Minutes of passive time a text step names; device settings written in text are skipped. */
export function passiveMinutes(text: string): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const m of lower.matchAll(durationRe)) {
    const after = lower.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 20);
    if (/\/|stufe|sek|°c\s*\//.test(after)) continue;
    const a = Number.parseFloat((m[1] ?? "0").replace(",", "."));
    const b = m[2] ? Number.parseFloat(m[2].replace(",", ".")) : a;
    const v = (a + b) / 2;
    const unit = m[3] ?? "";
    total += unit.startsWith("st") ? v * 60 : v;
  }
  if (/über nacht/.test(lower)) total += 480;
  if (/(eine|1) halbe stunde|einer halben stunde/.test(lower)) total += 30;
  else if (/\beine stunde\b|\beiner stunde\b/.test(lower)) total += 60;
  return total;
}

// ---------------------------------------------------------------------------
// Analysis

interface Ctx {
  recipe: NormalizedRecipe;
  steps: NormalizedStep[];
  est: StepEstimate[];
}

const isHeatedCustom = (s: NormalizedStep) => s.mode === "customized" && (s.temperature ?? 0) >= 90;
const isRoast = (s: NormalizedStep) => s.mode === "roasting";
const isKnead = (s: NormalizedStep) => s.mode.startsWith("kneading");
const isOfficial = (s: { source: string | null }) => s.source === "official";

function tempBand(t: number): string {
  if (t < 100) return "90-95";
  if (t === 100) return "100";
  if (t < 120) return "105-115";
  return "120-130";
}

/** Text of the steps since the previous non-scale machine step, up to and including `index`. */
function windowText(ctx: Ctx, index: number): string {
  const parts: string[] = [];
  for (let j = index; j >= 0; j--) {
    const s = ctx.steps[j];
    if (!s) break;
    if (j < index && s.kind === "machine" && s.mode !== "scale") break;
    parts.unshift(s.text.toLowerCase());
  }
  return parts.join(" | ");
}

function windowSum(ctx: Ctx, index: number, pick: (e: StepEstimate) => number): number {
  let sum = 0;
  for (let j = index; j >= 0; j--) {
    const s = ctx.steps[j];
    const e = ctx.est[j];
    if (!s || !e) break;
    if (j < index && s.kind === "machine" && s.mode !== "scale") break;
    sum += pick(e);
    if (e.reset !== "none") break;
  }
  return sum;
}

interface HeatRow {
  source: string | null;
  mode: string;
  temperature: number;
  time: number;
  bowl: number;
  naive: number;
  first: boolean;
  tMin: number;
}

function heatingAnalysis(ctxs: Ctx[]) {
  const rows: HeatRow[] = [];
  for (const ctx of ctxs) {
    let heatedSinceReset = false;
    ctx.steps.forEach((s, i) => {
      const e = ctx.est[i];
      if (!e) return;
      if (e.reset === "strong" || e.reset === "weak") heatedSinceReset = false;
      const heated = isHeatedCustom(s) || isRoast(s);
      if (!heated) {
        // Any program that heats the bowl content also counts as prior heating.
        if ((s.temperature ?? 0) >= 60 || s.mode === "steaming" || s.mode === "slow_cooking")
          heatedSinceReset = true;
        return;
      }
      const t = s.temperature ?? 0;
      const time = s.timeSeconds ?? 0;
      if (t > 0 && time > 0) {
        rows.push({
          source: s.source,
          mode: s.mode,
          temperature: t,
          time,
          bowl: e.bowlGrams,
          naive: s.cumulativeGramsBefore,
          first: !heatedSinceReset,
          tMin: physicalMinSeconds(e.bowlGrams, t),
        });
      }
      heatedSinceReset = true;
    });
  }

  const withMass = rows.filter((r) => r.bowl >= 50);
  const fitsFor = (subset: HeatRow[]) => {
    const bands = [...new Set(subset.map((r) => tempBand(r.temperature)))].sort();
    return Object.fromEntries(
      bands.map((band) => {
        const rs = subset.filter((r) => tempBand(r.temperature) === band);
        const first = rs.filter((r) => r.first);
        return [
          band,
          {
            all: linearFit(
              rs.map((r) => r.bowl),
              rs.map((r) => r.time),
            ),
            firstHeating: linearFit(
              first.map((r) => r.bowl),
              first.map((r) => r.time),
            ),
            official: linearFit(
              rs.filter(isOfficial).map((r) => r.bowl),
              rs.filter(isOfficial).map((r) => r.time),
            ),
            time: dist(rs.map((r) => r.time)),
            mass: dist(rs.map((r) => r.bowl)),
          },
        ];
      }),
    );
  };
  const logFit = (subset: HeatRow[]) =>
    linearFit(
      subset.map((r) => Math.log(r.bowl)),
      subset.map((r) => Math.log(r.time)),
    );
  const ratio = (subset: HeatRow[]) => subset.map((r) => r.time / Math.max(r.tMin, 1));
  const shareBelow = (subset: HeatRow[], f = 1) =>
    subset.length
      ? round(subset.filter((r) => r.time < f * r.tMin).length / subset.length, 3)
      : null;

  const custom = withMass.filter((r) => r.mode === "customized");
  const roast = withMass.filter((r) => r.mode === "roasting");
  const customFirst = custom.filter((r) => r.first);
  const customLater = custom.filter((r) => !r.first);

  const physics = {
    model: "tMinSeconds = grams/1000 * 4200 * (min(T,100) - 20) / (1050 * 0.7)",
    customized: {
      all: {
        n: custom.length,
        shareBelowTMin: shareBelow(custom),
        shareBelowHalfTMin: shareBelow(custom, 0.5),
      },
      firstHeating: {
        n: customFirst.length,
        shareBelowTMin: shareBelow(customFirst),
        shareBelowHalfTMin: shareBelow(customFirst, 0.5),
        ratioTimeToTMin: dist(ratio(customFirst)),
        ratioOfficial: dist(ratio(customFirst.filter(isOfficial))),
        ratioMember: dist(ratio(customFirst.filter((r) => !isOfficial(r)))),
        headroomSecondsOfficial: dist(customFirst.filter(isOfficial).map((r) => r.time - r.tMin)),
      },
      afterEarlierHeating: {
        n: customLater.length,
        shareBelowTMin: shareBelow(customLater),
        ratioTimeToTMin: dist(ratio(customLater)),
      },
      byBandFirstHeating: Object.fromEntries(
        ["90-95", "100", "105-115", "120-130"].map((band) => {
          const rs = customFirst.filter((r) => tempBand(r.temperature) === band);
          return [band, { n: rs.length, shareBelowTMin: shareBelow(rs), ratio: dist(ratio(rs)) }];
        }),
      ),
    },
    roasting: {
      n: roast.length,
      firstHeating: {
        n: roast.filter((r) => r.first).length,
        shareBelowTMin: shareBelow(roast.filter((r) => r.first)),
        ratio: dist(ratio(roast.filter((r) => r.first))),
      },
      note: "Roasting content is mostly fat plus onions or meat with little water; the water model is a rough upper bound.",
    },
  };

  const massBuckets = (subset: HeatRow[]) =>
    buckets(
      subset.map((r) => ({ x: r.bowl, y: r.time })),
      250,
      3,
    ).map((b) => ({
      ...b,
      tMinAtBucketMid: round(physicalMinSeconds((b.from + b.to) / 2, 100)),
    }));

  const allCustomTimes = rows.filter((r) => r.mode === "customized");
  return {
    rows: rows.length,
    rowsWithMass: withMass.length,
    rowsWithoutMass: rows.length - withMass.length,
    shareFirstHeating: round(custom.filter((r) => r.first).length / Math.max(custom.length, 1), 3),
    customized: {
      timeByTemperature: Object.fromEntries(
        [...new Set(allCustomTimes.map((r) => r.temperature))]
          .sort((a, b) => a - b)
          .map((t) => [
            String(t),
            dist(allCustomTimes.filter((r) => r.temperature === t).map((r) => r.time)),
          ]),
      ),
      fitsByBand: fitsFor(custom),
      logLogFitAll: logFit(custom),
      logLogFitFirstHeating: logFit(customFirst),
      fitTimeVsTMinFirstHeating: linearFit(
        customFirst.map((r) => r.tMin),
        customFirst.map((r) => r.time),
      ),
      minTimeByMass250g: massBuckets(custom),
      minTimeByMass250gFirstHeating: massBuckets(customFirst),
      massVsNaive: {
        bowl: dist(custom.map((r) => r.bowl)),
        naive: dist(custom.map((r) => r.naive)),
      },
    },
    roasting: {
      timeByTemperature: Object.fromEntries(
        [...new Set(rows.filter((r) => r.mode === "roasting").map((r) => r.temperature))]
          .sort((a, b) => a - b)
          .map((t) => [
            String(t),
            dist(
              rows.filter((r) => r.mode === "roasting" && r.temperature === t).map((r) => r.time),
            ),
          ]),
      ),
      fitAll: linearFit(
        roast.map((r) => r.bowl),
        roast.map((r) => r.time),
      ),
      fitOfficial: linearFit(
        roast.filter(isOfficial).map((r) => r.bowl),
        roast.filter(isOfficial).map((r) => r.time),
      ),
      mass: dist(roast.map((r) => r.bowl)),
      minTimeByMass250g: massBuckets(roast),
    },
    physics,
  };
}

function sequenceAnalysis(ctxs: Ctx[]) {
  type Link = { token: string; temp: number; time: number };
  const chains: { links: Link[]; source: string | null; recipeId: number }[] = [];
  for (const ctx of ctxs) {
    let current: Link[] = [];
    const flush = () => {
      if (current.length >= 2)
        chains.push({ links: current, source: ctx.recipe.source, recipeId: ctx.recipe.id });
      current = [];
    };
    ctx.steps.forEach((s, i) => {
      const e = ctx.est[i];
      if (e && (e.reset === "strong" || e.reset === "weak")) flush();
      const heated = isHeatedCustom(s) || isRoast(s) || s.mode === "steaming";
      if (heated) {
        const token =
          s.mode === "roasting"
            ? `roast${s.temperature ?? 0}`
            : s.mode === "steaming"
              ? "steam"
              : `cook${s.temperature ?? 0}`;
        current.push({
          token,
          temp: s.mode === "steaming" ? 100 : (s.temperature ?? 0),
          time: s.timeSeconds ?? 0,
        });
        return;
      }
      if (s.kind === "machine" && s.mode !== "scale") {
        // Short unheated programs (chop, stir) keep the content hot; longer ones end the chain.
        if ((s.timeSeconds ?? 0) > 60 || (s.temperature ?? 0) > 0) flush();
      }
    });
    flush();
  }

  const patterns = new Map<
    string,
    { count: number; official: number; times: number[][]; totals: number[] }
  >();
  for (const c of chains) {
    const key = c.links.map((l) => l.token).join(" > ");
    const p = patterns.get(key) ?? { count: 0, official: 0, times: [], totals: [] };
    p.count++;
    if (c.source === "official") p.official++;
    p.times.push(c.links.map((l) => l.time));
    p.totals.push(c.links.reduce((a, l) => a + l.time, 0));
    patterns.set(key, p);
  }
  const topPatterns = [...patterns.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 25)
    .map(([pattern, p]) => ({
      pattern,
      count: p.count,
      official: p.official,
      medianSecondsPerLink: (p.times[0] ?? []).map(
        (_, i) => dist(p.times.map((t) => t[i] ?? 0)).median,
      ),
      totalSeconds: dist(p.totals),
    }));

  const pairs = new Map<string, { count: number; first: number[]; second: number[] }>();
  let drops = 0;
  let rises = 0;
  let same = 0;
  for (const c of chains) {
    for (let i = 1; i < c.links.length; i++) {
      const a = c.links[i - 1];
      const b = c.links[i];
      if (!a || !b) continue;
      if (b.temp < a.temp) drops++;
      else if (b.temp > a.temp) rises++;
      else same++;
      const key = `${a.token} > ${b.token}`;
      const p = pairs.get(key) ?? { count: 0, first: [], second: [] };
      p.count++;
      p.first.push(a.time);
      p.second.push(b.time);
      pairs.set(key, p);
    }
  }
  const transitions = drops + rises + same;
  return {
    recipesWithHeatedStep: ctxs.filter((c) => c.steps.some((s) => isHeatedCustom(s) || isRoast(s)))
      .length,
    chains: chains.length,
    recipesWithChain: new Set(chains.map((c) => c.recipeId)).size,
    chainLength: dist(chains.map((c) => c.links.length)),
    chainTotalSeconds: dist(chains.map((c) => c.links.reduce((a, l) => a + l.time, 0))),
    chainTotalSecondsOfficial: dist(
      chains
        .filter((c) => c.source === "official")
        .map((c) => c.links.reduce((a, l) => a + l.time, 0)),
    ),
    transitionShares: {
      n: transitions,
      tempDrops: round(drops / Math.max(transitions, 1), 3),
      tempRises: round(rises / Math.max(transitions, 1), 3),
      tempSame: round(same / Math.max(transitions, 1), 3),
    },
    topPatterns,
    topTransitions: [...pairs.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([pair, p]) => ({
        pair,
        count: p.count,
        firstSeconds: dist(p.first).median,
        secondSeconds: dist(p.second).median,
      })),
  };
}

function steamingAnalysis(ctxs: Ctx[]) {
  const rows: {
    cls: string;
    all: string[];
    time: number;
    food: number;
    water: number;
    liquidAdded: number;
    official: boolean;
  }[] = [];
  for (const ctx of ctxs) {
    let poolStart = 0;
    ctx.steps.forEach((s, i) => {
      if (s.mode !== "steaming") return;
      // Food since the previous steaming step: steamer pool plus parked plate weighings.
      let food = 0;
      let liquidAdded = 0;
      const parts: string[] = [];
      for (let j = poolStart; j <= i; j++) {
        const st = ctx.steps[j];
        const e = ctx.est[j];
        if (!st || !e) continue;
        food += e.steamerAddedGrams;
        if (st.mode === "scale" && e.addedGrams === 0 && e.steamerAddedGrams === 0)
          food += st.weight ?? 0;
        if (
          st.mode === "scale" &&
          e.addedGrams > 0 &&
          /wasser|brühe|fond/.test(st.text.toLowerCase())
        )
          liquidAdded += e.addedGrams;
        if (j >= i - 6) parts.push(st.text.toLowerCase());
      }
      poolStart = i + 1;
      const c = classify(parts.join(" | "), steamClasses);
      rows.push({
        cls: c.primary,
        all: c.all,
        time: s.timeSeconds ?? 0,
        food,
        water: ctx.est[i]?.bowlGrams ?? 0,
        liquidAdded,
        official: s.source === "official",
      });
    });
  }
  const classes = [...new Set(rows.map((r) => r.cls))];
  const withFood = rows.filter((r) => r.food >= 50);
  return {
    steps: rows.length,
    timeAll: dist(rows.map((r) => r.time)),
    byClass: Object.fromEntries(
      classes
        .map((c) => [c, rows.filter((r) => r.cls === c)] as const)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([c, rs]) => [
          c,
          {
            n: rs.length,
            time: dist(rs.map((r) => r.time)),
            singleClassTime: dist(rs.filter((r) => r.all.length === 1).map((r) => r.time)),
          },
        ]),
    ),
    bowlWaterGrams: dist(rows.map((r) => r.water).filter((w) => w > 0)),
    shareWithWaterEstimate: round(
      rows.filter((r) => r.water > 0).length / Math.max(rows.length, 1),
      3,
    ),
    liquidWeighedBeforeSteaming: dist(rows.map((r) => r.liquidAdded).filter((w) => w > 0)),
    shareWithLiquidWeighed: round(
      rows.filter((r) => r.liquidAdded > 0).length / Math.max(rows.length, 1),
      3,
    ),
    shareBowlHoldsMoreThanLiquid: round(
      rows.filter((r) => r.water - r.liquidAdded > 200).length / Math.max(rows.length, 1),
      3,
    ),
    foodMass: dist(withFood.map((r) => r.food)),
    fitTimeVsFoodMass: linearFit(
      withFood.map((r) => r.food),
      withFood.map((r) => r.time),
    ),
    timeByFoodMass250g: buckets(
      withFood.map((r) => ({ x: r.food, y: r.time })),
      250,
      3,
    ),
  };
}

function kneadingAnalysis(ctxs: Ctx[]) {
  const rows: { mode: string; time: number; flour: number; flourRecipe: number; dough: number }[] =
    [];
  const recipeFlour: number[] = [];
  for (const ctx of ctxs) {
    const total = ctx.recipe.ingredients
      .filter((ing) => isFlour(ing.name))
      .reduce((a, ing) => a + (ing.grams ?? 0), 0);
    if (total > 0) recipeFlour.push(total);
    let flourSince = 0;
    ctx.steps.forEach((s, i) => {
      const e = ctx.est[i];
      if (!e) return;
      if (e.reset === "strong" || e.reset === "weak") flourSince = 0;
      flourSince += e.flourAddedGrams;
      if (!isKnead(s)) return;
      rows.push({
        mode: s.mode,
        time: s.timeSeconds ?? 0,
        flour: flourSince,
        flourRecipe: total,
        dough: e.bowlGrams,
      });
      flourSince = 0;
    });
  }
  const modes = [...new Set(rows.map((r) => r.mode))];
  const withFlour = rows.filter((r) => r.flour >= 50);
  return {
    steps: rows.length,
    shareWithFlourInWindow: round(withFlour.length / Math.max(rows.length, 1), 3),
    byMode: Object.fromEntries(
      modes.map((m) => {
        const rs = rows.filter((r) => r.mode === m);
        const wf = rs.filter((r) => r.flour >= 50);
        return [
          m,
          {
            n: rs.length,
            time: dist(rs.map((r) => r.time)),
            flour: dist(wf.map((r) => r.flour)),
            fitTimeVsFlour: linearFit(
              wf.map((r) => r.flour),
              wf.map((r) => r.time),
            ),
          },
        ];
      }),
    ),
    fitAllTimeVsFlour: linearFit(
      withFlour.map((r) => r.flour),
      withFlour.map((r) => r.time),
    ),
    timeByFlour250g: buckets(
      withFlour.map((r) => ({ x: r.flour, y: r.time })),
      250,
      3,
    ),
    flourPerKneadStep: dist(withFlour.map((r) => r.flour)),
    doughMassAtKneadStep: dist(rows.map((r) => r.dough).filter((d) => d > 0)),
    flourPerRecipe: dist(recipeFlour),
    recipesWithFlour: recipeFlour.length,
  };
}

function blendAnalysis(ctxs: Ctx[]) {
  const groups: Record<string, { time: number; mass: number; speed: number | null }[]> = {
    puree: [],
    smoothie: [],
    manual_blend: [],
  };
  for (const ctx of ctxs) {
    ctx.steps.forEach((s, i) => {
      const mass = ctx.est[i]?.bowlGrams ?? 0;
      const time = s.timeSeconds ?? 0;
      if (s.mode === "puree" || s.mode === "smoothie")
        groups[s.mode]?.push({ time, mass, speed: null });
      else if (
        s.mode === "customized" &&
        (s.temperature ?? 0) === 0 &&
        (s.speed ?? 0) >= 8 &&
        time >= 20
      )
        groups.manual_blend?.push({ time, mass, speed: s.speed });
    });
  }
  return Object.fromEntries(
    Object.entries(groups).map(([k, rs]) => {
      const wm = rs.filter((r) => r.mass >= 50);
      return [
        k,
        {
          n: rs.length,
          time: dist(rs.map((r) => r.time)),
          mass: dist(wm.map((r) => r.mass)),
          fitTimeVsMass: linearFit(
            wm.map((r) => r.mass),
            wm.map((r) => r.time),
          ),
          timeByMass250g: buckets(
            wm.map((r) => ({ x: r.mass, y: r.time })),
            250,
            3,
          ),
          speed: k === "manual_blend" ? dist(rs.map((r) => r.speed ?? 0)) : undefined,
        },
      ];
    }),
  );
}

function choppingAnalysis(ctxs: Ctx[]) {
  const rows: {
    speed: number;
    time: number;
    cls: string;
    batch: number;
    official: boolean;
    reverse: boolean;
  }[] = [];
  const turbo: { time: number; cls: string }[] = [];
  for (const ctx of ctxs) {
    ctx.steps.forEach((s, i) => {
      const time = s.timeSeconds ?? 0;
      if (s.mode === "turbo") {
        turbo.push({ time, cls: classify(windowText(ctx, i), chopClasses).primary });
        return;
      }
      if (s.mode !== "customized" || (s.temperature ?? 0) !== 0) return;
      if ((s.speed ?? 0) < 5 || time > 15 || time <= 0) return;
      rows.push({
        speed: s.speed ?? 0,
        time,
        cls: classify(windowText(ctx, i), chopClasses).primary,
        batch: windowSum(ctx, i, (e) => e.addedGrams),
        official: s.source === "official",
        reverse: s.reverse,
      });
    });
  }
  const classes = [...new Set(rows.map((r) => r.cls))];
  return {
    steps: rows.length,
    shareOfficial: round(rows.filter((r) => r.official).length / Math.max(rows.length, 1), 3),
    timeBySpeed: Object.fromEntries(
      [5, 6, 7, 8, 9, 10].map((sp) => [
        String(sp),
        dist(rows.filter((r) => r.speed === sp).map((r) => r.time)),
      ]),
    ),
    byClass: Object.fromEntries(
      classes
        .map((c) => [c, rows.filter((r) => r.cls === c)] as const)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([c, rs]) => {
          const speedCounts: Record<string, number> = {};
          for (const r of rs)
            speedCounts[String(r.speed)] = (speedCounts[String(r.speed)] ?? 0) + 1;
          return [
            c,
            {
              n: rs.length,
              speed: dist(rs.map((r) => r.speed)),
              time: dist(rs.map((r) => r.time)),
              speedCounts,
              batchGrams: dist(rs.map((r) => r.batch).filter((b) => b > 0)),
            },
          ];
        }),
    ),
    fitTimeVsBatch: linearFit(
      rows.filter((r) => r.batch > 0).map((r) => r.batch),
      rows.filter((r) => r.batch > 0).map((r) => r.time),
    ),
    turbo: {
      n: turbo.length,
      time: dist(turbo.map((t) => t.time)),
      byClass: Object.fromEntries(
        [...new Set(turbo.map((t) => t.cls))]
          .map((c) => [c, turbo.filter((t) => t.cls === c)] as const)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 8)
          .map(([c, ts]) => [c, dist(ts.map((t) => t.time))]),
      ),
    },
  };
}

function capacityAnalysis(ctxs: Ctx[]) {
  const maxBowl = ctxs.map((c) => Math.max(0, ...c.est.map((e) => e.bowlGrams)));
  const maxNaive = ctxs.map((c) => Math.max(0, ...c.steps.map((s) => s.cumulativeGramsBefore)));
  const maxHeated = ctxs.map((c) =>
    Math.max(
      0,
      ...c.steps.map((s, i) => (isHeatedCustom(s) || isRoast(s) ? (c.est[i]?.bowlGrams ?? 0) : 0)),
    ),
  );
  const share = (vals: number[], limit: number) =>
    round(vals.filter((v) => v > limit).length / Math.max(vals.length, 1), 4);
  const thresholds = [2000, 2200, 2500, 3000, 3500];
  return {
    recipes: ctxs.length,
    bowlEstimate: {
      maxPerRecipe: dist(maxBowl),
      shareAbove: Object.fromEntries(thresholds.map((t) => [String(t), share(maxBowl, t)])),
      countAbove3000: maxBowl.filter((v) => v > 3000).length,
    },
    bowlEstimateAtHeatedSteps: {
      maxPerRecipe: dist(maxHeated.filter((v) => v > 0)),
      shareAbove: Object.fromEntries(thresholds.map((t) => [String(t), share(maxHeated, t)])),
    },
    naiveCumulative: {
      maxPerRecipe: dist(maxNaive),
      shareAbove: Object.fromEntries(thresholds.map((t) => [String(t), share(maxNaive, t)])),
    },
    resets: {
      recipesWithReset: ctxs.filter((c) => c.est.some((e) => e.reset !== "none")).length,
      strong: ctxs.reduce((n, c) => n + c.est.filter((e) => e.reset === "strong").length, 0),
      weak: ctxs.reduce((n, c) => n + c.est.filter((e) => e.reset === "weak").length, 0),
      half: ctxs.reduce((n, c) => n + c.est.filter((e) => e.reset === "half").length, 0),
    },
  };
}

function durationAnalysis(ctxs: Ctx[]) {
  const rows = ctxs
    .map((c) => {
      const machineMin = c.recipe.totalMachineSeconds / 60;
      const passive = c.steps
        .filter((s) => s.kind === "text")
        .reduce((a, s) => a + passiveMinutes(s.text), 0);
      return {
        total: c.recipe.totalMinutes ?? 0,
        prep: c.recipe.prepMinutes ?? 0,
        machineMin,
        passive,
        text: c.recipe.textStepCount,
        scale: c.recipe.scaleStepCount,
        official: c.recipe.source === "official",
      };
    })
    .filter((r) => r.total > 0 && r.total <= 48 * 60);

  const fit = (rs: typeof rows) =>
    multiFit(
      rs.map((r) => [r.machineMin, r.passive, r.text, r.scale]),
      rs.map((r) => r.total),
    );
  const noPassive = rows.filter((r) => r.passive === 0);
  const perText = noPassive.filter((r) => r.text > 0).map((r) => (r.total - r.machineMin) / r.text);
  // A few recipes declare hours of preparation (proofing counted as prep); keep them out of the fit.
  const prepRows = rows.filter((r) => r.prep > 0 && r.prep <= 120);
  const prepFit = multiFit(
    prepRows.map((r) => [r.text, r.scale, r.machineMin]),
    prepRows.map((r) => r.prep),
  );
  const ratio = rows
    .filter((r) => r.machineMin + r.passive > 0)
    .map((r) => r.total / (r.machineMin + r.passive));
  return {
    recipes: rows.length,
    declaredTotalMinutes: dist(rows.map((r) => r.total)),
    declaredPrepMinutes: dist(rows.map((r) => r.prep)),
    machineMinutes: dist(rows.map((r) => r.machineMin)),
    passiveMinutesFromText: dist(rows.map((r) => r.passive)),
    shareWithPassiveTime: round(
      rows.filter((r) => r.passive > 0).length / Math.max(rows.length, 1),
      3,
    ),
    shareTotalBelowMachine: round(
      rows.filter((r) => r.total < r.machineMin).length / Math.max(rows.length, 1),
      3,
    ),
    fitTotal: {
      terms: ["intercept", "machineMinutes", "passiveMinutes", "textSteps", "scaleSteps"],
      all: fit(rows),
      official: fit(rows.filter((r) => r.official)),
      member: fit(rows.filter((r) => !r.official)),
      withoutPassive: fit(noPassive),
    },
    fitPrep: { terms: ["intercept", "textSteps", "scaleSteps", "machineMinutes"], all: prepFit },
    minutesPerTextStepNoPassive: dist(perText),
    totalOverMachinePlusPassive: dist(ratio),
  };
}

// ---------------------------------------------------------------------------
// Report

type Json = Record<string, unknown>;

function f(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  return digits === 0 ? String(Math.round(v)) : v.toFixed(digits);
}

function distRow(label: string, d: Dist): string {
  return `| ${label} | ${d.n} | ${f(d.p10)} | ${f(d.median)} | ${f(d.p90)} | ${f(d.min)} | ${f(d.max)} |`;
}

const distHead = "| Group | n | p10 | median | p90 | min | max |\n|---|---|---|---|---|---|---|";

function fitText(fit: LinearFit | null, unit = "s", x = "grams"): string {
  if (!fit) return "too few rows";
  return `\`${f(fit.a)} + ${fit.b.toFixed(3)} * ${x}\` ${unit} (n ${fit.n}, R² ${fit.r2.toFixed(2)}, residual p10/p50/p90 ${f(fit.residual.p10)}/${f(fit.residual.median)}/${f(fit.residual.p90)})`;
}

export function renderMarkdown(r: {
  heating: ReturnType<typeof heatingAnalysis>;
  sequences: ReturnType<typeof sequenceAnalysis>;
  steaming: ReturnType<typeof steamingAnalysis>;
  kneading: ReturnType<typeof kneadingAnalysis>;
  blending: ReturnType<typeof blendAnalysis>;
  chopping: ReturnType<typeof choppingAnalysis>;
  capacity: ReturnType<typeof capacityAnalysis>;
  durations: ReturnType<typeof durationAnalysis>;
  meta: Json;
}): string {
  const h = r.heating;
  const p = h.physics.customized;
  const lines: string[] = [];
  const push = (...ls: string[]) => lines.push(...ls);

  push(
    "# Timing model and physics",
    "",
    `Derived from ${String(r.meta.recipes)} recipes and ${String(r.meta.steps)} steps of the de-DE MC Smart corpus. ` +
      "Numbers only; no recipe text. Times are seconds unless marked. Regenerate with `npm run corpus:analyze-timing`.",
    "",
    "## Mass estimate (read first)",
    "",
    "Every mass number here comes from `estimateBowl` in `scripts/corpus/analyze-timing.ts`, a text heuristic:",
    "",
    "- scale steps add their programmed weight, unless the text says the weighing happens on a plate or bowl on top of the lid, in the steamer, or outside the machine;",
    "- text steps add an ingredient's listed grams the first time they name it together with an adding verb;",
    "- ingredients listed as Stück, EL, TL or Prise count 0 g unless a scale step weighs them;",
    "- `umfüllen` or rinsing the bowl empties it, `Hälfte umfüllen` halves it, `in eine Schüssel geben` or `abgießen` empties it when no new ingredient is named;",
    "- evaporation, partial removal and liquids drained through the basket are ignored.",
    "",
    `Heated steps with an estimate of at least 50 g: ${h.rowsWithMass} of ${h.rows}. ` +
      `Median bowl estimate at heated manual steps ${f(h.customized.massVsNaive.bowl.median)} g versus ${f(h.customized.massVsNaive.naive.median)} g for the normalizer's never-decreasing cumulative mass. ` +
      `Bowl resets detected: ${r.capacity.resets.strong} strong, ${r.capacity.resets.weak} weak, ${r.capacity.resets.half} half, in ${r.capacity.resets.recipesWithReset} recipes.`,
    "",
    "Treat every mass-based coefficient as low to medium confidence.",
    "",
  );

  // (a)
  push(
    "## (a) Heated manual steps and roasting",
    "",
    "### Time by target temperature (manual cooking, all steps)",
    "",
    distHead,
  );
  for (const [t, d] of Object.entries(h.customized.timeByTemperature)) {
    if (Number(t) >= 90) push(distRow(`${t} °C`, d));
  }
  push("", "### Linear fits `time = a + b * bowlGrams` per temperature band (manual cooking)", "");
  for (const [band, v] of Object.entries(h.customized.fitsByBand)) {
    push(`- **${band} °C**, all: ${fitText(v.all)}`);
    push(`  - first heating since the bowl was filled: ${fitText(v.firstHeating)}`);
    push(`  - official only: ${fitText(v.official)}`);
  }
  push(
    "",
    `Log-log fit (all heated manual steps): \`ln(time) = ${f(h.customized.logLogFitAll?.a, 2)} + ${f(h.customized.logLogFitAll?.b, 2)} * ln(grams)\`, R² ${f(h.customized.logLogFitAll?.r2, 2)}. ` +
      `First heating only: exponent ${f(h.customized.logLogFitFirstHeating?.b, 2)}, R² ${f(h.customized.logLogFitFirstHeating?.r2, 2)}.`,
    "",
    "Mass explains little of the time. The time is set by the cooking goal (simmer a sauce, cook pasta, reduce), not by the heat-up. Use the per-temperature distributions as defaults and mass only for the lower bound.",
    "",
    "### Roasting",
    "",
    distHead,
  );
  for (const [t, d] of Object.entries(h.roasting.timeByTemperature)) push(distRow(`${t} °C`, d));
  push(
    "",
    `Fit all: ${fitText(h.roasting.fitAll)}. Official: ${fitText(h.roasting.fitOfficial)}. Roasting mass p50 ${f(h.roasting.mass.median)} g, p90 ${f(h.roasting.mass.p90)} g.`,
    "",
    "### Empirical lower bound per 250 g of bowl mass (manual cooking ≥ 90 °C, first heating)",
    "",
    "| Bowl g | n | min | p05 | p10 | median | tMin at 100 °C |",
    "|---|---|---|---|---|---|---|",
  );
  for (const b of h.customized.minTimeByMass250gFirstHeating) {
    push(
      `| ${b.from}-${b.to} | ${b.time.n} | ${f(b.time.min)} | ${f(b.time.p05)} | ${f(b.time.p10)} | ${f(b.time.median)} | ${f(b.tMinAtBucketMid)} |`,
    );
  }
  push(
    "",
    "### Physics check",
    "",
    "`tMinSeconds = grams / 1000 * 4200 * (Math.min(tempC, 100) - 20) / (1050 * 0.7)` (about 457 s per kg to boil from 20 °C).",
    "",
    `- All heated manual steps: ${f((p.all.shareBelowTMin ?? 0) * 100, 1)} % are shorter than tMin, ${f((p.all.shareBelowHalfTMin ?? 0) * 100, 1)} % shorter than half of it.`,
    `- First heating since the bowl was filled (n ${p.firstHeating.n}): ${f((p.firstHeating.shareBelowTMin ?? 0) * 100, 1)} % below tMin, ${f((p.firstHeating.shareBelowHalfTMin ?? 0) * 100, 1)} % below half. Ratio time/tMin p10 ${f(p.firstHeating.ratioTimeToTMin.p10, 2)}, median ${f(p.firstHeating.ratioTimeToTMin.median, 2)}, p90 ${f(p.firstHeating.ratioTimeToTMin.p90, 2)}.`,
    `- After an earlier heating step without emptying (n ${p.afterEarlierHeating.n}): ${f((p.afterEarlierHeating.shareBelowTMin ?? 0) * 100, 1)} % below tMin. These steps start hot, so short times are expected.`,
    `- Headroom, official first heating: ratio median ${f(p.firstHeating.ratioOfficial.median, 2)} (p10 ${f(p.firstHeating.ratioOfficial.p10, 2)}), extra seconds over tMin median ${f(p.firstHeating.headroomSecondsOfficial.median)}. Member recipes: ratio median ${f(p.firstHeating.ratioMember.median, 2)} (p10 ${f(p.firstHeating.ratioMember.p10, 2)}).`,
    `- Roasting first heating: ${f((h.physics.roasting.firstHeating.shareBelowTMin ?? 0) * 100, 1)} % below the water tMin (ratio median ${f(h.physics.roasting.firstHeating.ratio.median, 2)}). Roasting content is mostly fat and vegetables with little water, and the program is not meant to bring the content to temperature, so the water model does not apply.`,
    "",
    "| Band (first heating) | n | share < tMin | ratio p10 | ratio median |",
    "|---|---|---|---|---|",
  );
  for (const [band, v] of Object.entries(p.byBandFirstHeating)) {
    push(
      `| ${band} | ${v.n} | ${f((v.shareBelowTMin ?? 0) * 100, 1)} % | ${f(v.ratio.p10, 2)} | ${f(v.ratio.median, 2)} |`,
    );
  }

  // (b)
  const s = r.sequences;
  push(
    "",
    "## (b) Sequences of heated steps",
    "",
    "A chain is two or more heated steps (manual ≥ 90 °C, roasting, steaming) with no bowl reset between them; scale and text steps and short unheated programs (≤ 60 s) may sit in between.",
    "",
    `Recipes with a heated step: ${s.recipesWithHeatedStep}. Chains: ${s.chains}. Chain length median ${f(s.chainLength.median)}, max ${f(s.chainLength.max)}. ` +
      `Cumulative chain time p10/median/p90 ${f(s.chainTotalSeconds.p10)}/${f(s.chainTotalSeconds.median)}/${f(s.chainTotalSeconds.p90)} s (official median ${f(s.chainTotalSecondsOfficial.median)} s). ` +
      `Temperature drops in ${f(s.transitionShares.tempDrops * 100, 1)} % of transitions, rises in ${f(s.transitionShares.tempRises * 100, 1)} %, stays in ${f(s.transitionShares.tempSame * 100, 1)} %.`,
    "",
    "| Pattern | n | official | median s per step | total s median |",
    "|---|---|---|---|---|",
  );
  for (const t of s.topPatterns.slice(0, 15)) {
    push(
      `| ${t.pattern} | ${t.count} | ${t.official} | ${t.medianSecondsPerLink.map((v) => f(v)).join(" / ")} | ${f(t.totalSeconds.median)} |`,
    );
  }
  push("", "| Transition | n | first s | second s |", "|---|---|---|---|");
  for (const t of s.topTransitions.slice(0, 12))
    push(`| ${t.pair} | ${t.count} | ${f(t.firstSeconds)} | ${f(t.secondSeconds)} |`);

  // (c)
  const st = r.steaming;
  push(
    "",
    "## (c) Steaming",
    "",
    `Steaming steps: ${st.steps}. Time p10/median/p90 ${f(st.timeAll.p10)}/${f(st.timeAll.median)}/${f(st.timeAll.p90)} s.`,
    "",
    distHead,
  );
  for (const [c, v] of Object.entries(st.byClass)) push(distRow(c, v.time));
  push(
    "",
    "Classes are matched on the step text and the six steps before it, in priority order (dough, dessert in a form, fish, meat, potatoes, vegetables, eggs). Mixed loads take the first class.",
    "",
    `Water, stock or fond weighed into the bowl before a steaming step (${f(st.shareWithLiquidWeighed * 100, 0)} % of steps): median ${f(st.liquidWeighedBeforeSteaming.median)} g, p10 ${f(st.liquidWeighedBeforeSteaming.p10)}, p90 ${f(st.liquidWeighedBeforeSteaming.p90)}, min ${f(st.liquidWeighedBeforeSteaming.min)}.`,
    `Total estimated bowl content under the steamer: median ${f(st.bowlWaterGrams.median)} g (p10 ${f(st.bowlWaterGrams.p10)}, p90 ${f(st.bowlWaterGrams.p90)}). In ${f(st.shareBowlHoldsMoreThanLiquid * 100, 0)} % of steps the bowl holds more than 200 g besides that liquid, i.e. something cooks below (rice or potatoes in the basket, a soup or sauce) while the steamer runs.`,
    `Food mass in the steamer is known only for ${st.foodMass.n} steps (median ${f(st.foodMass.median)} g). Fit: ${fitText(st.fitTimeVsFoodMass)}.`,
  );

  // (d)
  const k = r.kneading;
  push("", "## (d) Kneading", "", distHead);
  for (const [m, v] of Object.entries(k.byMode)) push(distRow(m, v.time));
  push(
    "",
    `Kneading steps where flour added since the last reset or kneading step is known: ${f(k.shareWithFlourInWindow * 100, 0)} %. Flour per kneading step p50 ${f(k.flourPerKneadStep.median)} g, p90 ${f(k.flourPerKneadStep.p90)} g, max ${f(k.flourPerKneadStep.max)} g.`,
    `Flour per recipe (recipes with flour: ${k.recipesWithFlour}): median ${f(k.flourPerRecipe.median)} g, p90 ${f(k.flourPerRecipe.p90)} g, max ${f(k.flourPerRecipe.max)} g. Dough in the bowl at the kneading step: median ${f(k.doughMassAtKneadStep.median)} g, max ${f(k.doughMassAtKneadStep.max)} g.`,
    `Fit all: ${fitText(k.fitAllTimeVsFlour, "s", "flourGrams")}.`,
    "",
    "| Flour g | n | p10 | median | p90 | max |",
    "|---|---|---|---|---|---|",
  );
  for (const b of k.timeByFlour250g)
    push(
      `| ${b.from}-${b.to} | ${b.time.n} | ${f(b.time.p10)} | ${f(b.time.median)} | ${f(b.time.p90)} | ${f(b.time.max)} |`,
    );

  // (e)
  push("", "## (e) Puree, smoothie and manual blending", "", distHead);
  for (const [m, v] of Object.entries(r.blending)) push(distRow(m, v.time));
  push("");
  for (const [m, v] of Object.entries(r.blending)) {
    push(
      `- ${m}: mass median ${f(v.mass.median)} g (n ${v.mass.n}); fit ${fitText(v.fitTimeVsMass)}`,
    );
  }
  push(
    "",
    "`manual_blend` is manual mode at 0 °C, speed ≥ 8 and at least 20 s, which is how official recipes puree.",
  );

  // (f)
  const c = r.chopping;
  push(
    "",
    "## (f) Chopping (manual, 0 °C, speed ≥ 5, ≤ 15 s)",
    "",
    `Steps: ${c.steps} (${f(c.shareOfficial * 100, 0)} % official).`,
    "",
    distHead,
  );
  for (const [sp, d] of Object.entries(c.timeBySpeed)) push(distRow(`speed ${sp}`, d));
  push(
    "",
    "| Class | n | speed median | speed p10-p90 | time median | time p10-p90 | batch g median |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [cls, v] of Object.entries(c.byClass)) {
    push(
      `| ${cls} | ${v.n} | ${f(v.speed.median)} | ${f(v.speed.p10)}-${f(v.speed.p90)} | ${f(v.time.median)} | ${f(v.time.p10)}-${f(v.time.p90)} | ${f(v.batchGrams.median)} |`,
    );
  }
  push(
    "",
    `Batch mass explains almost nothing: ${fitText(c.fitTimeVsBatch)}.`,
    `Turbo program: n ${c.turbo.n}, time median ${f(c.turbo.time.median)} s, p90 ${f(c.turbo.time.p90)} s, max ${f(c.turbo.time.max)} s.`,
  );

  // (g)
  const cap = r.capacity;
  push(
    "",
    "## (g) Bowl mass above 3000 g",
    "",
    "| Estimate | > 2000 | > 2200 | > 2500 | > 3000 | > 3500 | max |",
    "|---|---|---|---|---|---|---|",
    `| bowl estimate, any step | ${pct(cap.bowlEstimate.shareAbove)} | ${f(cap.bowlEstimate.maxPerRecipe.max)} |`,
    `| bowl estimate, heated steps | ${pct(cap.bowlEstimateAtHeatedSteps.shareAbove)} | ${f(cap.bowlEstimateAtHeatedSteps.maxPerRecipe.max)} |`,
    `| normalizer cumulative (never drops) | ${pct(cap.naiveCumulative.shareAbove)} | ${f(cap.naiveCumulative.maxPerRecipe.max)} |`,
    "",
    `Recipes above 3000 g on the bowl estimate: ${cap.bowlEstimate.countAbove3000}. Spot checks of the largest cases found mostly real one-pot soups and pasta dishes with 1.3-2 kg of stock, filled close to the bowl limit, plus a few estimates inflated by a missed reset or by food weighed for use outside the machine. Evaporation is not subtracted, so the true peak is somewhat lower.`,
  );

  // (h)
  const d = r.durations;
  const fa = d.fitTotal.all;
  const fp = d.fitPrep.all;
  push(
    "",
    "## (h) Declared duration versus programmed time",
    "",
    `Recipes: ${d.recipes}. Declared total minutes median ${f(d.declaredTotalMinutes.median)} (p90 ${f(d.declaredTotalMinutes.p90)}); machine minutes median ${f(d.machineMinutes.median, 1)}; ` +
      `${f(d.shareWithPassiveTime * 100, 0)} % of recipes name passive time in text (oven, proofing, chilling), median among all ${f(d.passiveMinutesFromText.median)} min. ` +
      `Declared total below the programmed machine time: ${f(d.shareTotalBelowMachine * 100, 1)} %.`,
    "",
    `Fit \`totalMinutes = c0 + c1*machineMinutes + c2*passiveMinutes + c3*textSteps + c4*scaleSteps\`: ` +
      (fa
        ? `c = [${fa.coef.map((x) => x.toFixed(2)).join(", ")}], R² ${fa.r2.toFixed(2)}, n ${fa.n}.`
        : "no fit."),
    d.fitTotal.official
      ? `Official: c = [${d.fitTotal.official.coef.map((x) => x.toFixed(2)).join(", ")}], R² ${d.fitTotal.official.r2.toFixed(2)}.`
      : "",
    d.fitTotal.member
      ? `Member: c = [${d.fitTotal.member.coef.map((x) => x.toFixed(2)).join(", ")}], R² ${d.fitTotal.member.r2.toFixed(2)}.`
      : "",
    d.fitTotal.withoutPassive
      ? `Recipes without passive time: c = [${d.fitTotal.withoutPassive.coef.map((x) => x.toFixed(2)).join(", ")}], R² ${d.fitTotal.withoutPassive.r2.toFixed(2)}, n ${d.fitTotal.withoutPassive.n}.`
      : "",
    fp
      ? `Prep fit (prep 1-120 min) \`prepMinutes = c0 + c1*textSteps + c2*scaleSteps + c3*machineMinutes\`: c = [${fp.coef.map((x) => x.toFixed(2)).join(", ")}], R² ${fp.r2.toFixed(2)}.`
      : "",
    `Minutes per text step in recipes without passive time, ((total - machine) / textSteps): p25 ${f(d.minutesPerTextStepNoPassive.p25, 1)}, median ${f(d.minutesPerTextStepNoPassive.median, 1)}, p75 ${f(d.minutesPerTextStepNoPassive.p75, 1)}.`,
  );

  push(
    "",
    "## Formulas for the implementation",
    "",
    ...formulas(r),
    "",
    "## Data limitations",
    "",
    ...limitations(r),
  );
  return lines.join("\n") + "\n";
}

function pct(shares: Record<string, number>): string {
  return ["2000", "2200", "2500", "3000", "3500"]
    .map((k) => `${f((shares[k] ?? 0) * 100, 1)} %`)
    .join(" | ");
}

function formulas(r: Parameters<typeof renderMarkdown>[0]): string[] {
  const bands = r.heating.customized.fitsByBand;
  const band100 = bands["100"]?.all;
  const med = (t: string) => r.heating.customized.timeByTemperature[t]?.median ?? null;
  const roastMed = (t: string) => r.heating.roasting.timeByTemperature[t]?.median ?? null;
  const k = r.kneading;
  const fa = r.durations.fitTotal.all;
  const ratioP10 = r.heating.physics.customized.firstHeating.ratioOfficial.p10;
  const out = [
    "Confidence: high = many rows and a tight distribution; medium = enough rows, wide spread; low = depends on the mass heuristic or few rows.",
    "",
    "```js",
    "// Heat-up physics (high confidence as a physical bound; it ignores lid losses and the 37-130 °C control loop)",
    "const tMinSeconds = (grams, tempC) => grams / 1000 * 4200 * (Math.min(tempC, 100) - 20) / (1050 * 0.7);",
    "",
    "// Sanity rule for the first heated manual step after the bowl was filled (medium confidence).",
    `// Official recipes: time/tMin p10 = ${f(ratioP10, 2)}. Warn below half of tMin, unless an earlier step already heated the content.`,
    "const tooShortForHeatUp = (step, grams, contentAlreadyHot) =>",
    "  !contentAlreadyHot && step.temperature >= 90 && step.timeSeconds < 0.5 * tMinSeconds(grams, step.temperature);",
    "",
    "// Default manual cooking time when the source recipe gives none (medium confidence): median per temperature",
    `const defaultCookSeconds = { 90: ${f(med("90"))}, 95: ${f(med("95"))}, 100: ${f(med("100"))}, 105: ${f(med("105"))}, 110: ${f(med("110"))}, 115: ${f(med("115"))}, 120: ${f(med("120"))}, 130: ${f(med("130"))} };`,
    band100
      ? `// Mass-dependent variant at 100 °C (low confidence, R² ${band100.r2.toFixed(2)}): ${f(band100.a)} + ${band100.b.toFixed(3)} * grams`
      : "",
    band100
      ? `const cook100Seconds = (grams) => Math.max(tMinSeconds(grams, 100), ${f(band100.a)} + ${band100.b.toFixed(3)} * grams);`
      : "",
    "",
    "// Roasting (sauté) default by temperature, seconds (high confidence: narrow spread)",
    `const defaultRoastSeconds = { 100: ${f(roastMed("100"))}, 110: ${f(roastMed("110"))}, 120: ${f(roastMed("120"))}, 130: ${f(roastMed("130"))} };`,
    "",
    "// Kneading (medium confidence): time barely depends on flour; the programs run 1-4 min",
    `const kneadSeconds = (flourGrams) => ${k.fitAllTimeVsFlour ? `Math.min(240, Math.max(60, Math.round((${f(k.fitAllTimeVsFlour.a)} + ${k.fitAllTimeVsFlour.b.toFixed(3)} * flourGrams) / 30) * 30))` : "120"};`,
    `const maxFlourGrams = ${f(k.flourPerKneadStep.max)}; // largest flour amount kneaded in one step in the corpus (p90 ${f(k.flourPerKneadStep.p90)})`,
    "",
    "// Chopping: speed by ingredient class, seconds (medium confidence)",
    `const chop = ${JSON.stringify(
      Object.fromEntries(
        Object.entries(r.chopping.byClass)
          .filter(([, v]) => v.n >= 10)
          .map(([cls, v]) => [cls, { speed: v.speed.median, seconds: v.time.median }]),
      ),
    )};`,
    "",
    "// Steaming, seconds by load class (medium confidence)",
    `const steamSeconds = ${JSON.stringify(
      Object.fromEntries(
        Object.entries(r.steaming.byClass)
          .filter(([, v]) => v.n >= 5)
          .map(([cls, v]) => [cls, v.time.median]),
      ),
    )};`,
    `const steamLiquidGrams = ${f(r.steaming.liquidWeighedBeforeSteaming.median)}; // median water or stock weighed in before steaming (p10 ${f(r.steaming.liquidWeighedBeforeSteaming.p10)})`,
    "",
    "// Declared total duration in minutes (medium confidence)",
    fa
      ? `const totalMinutes = (machineSeconds, passiveMinutes, textSteps, scaleSteps) => Math.round(${fa.coef[0]?.toFixed(1)} + ${fa.coef[1]?.toFixed(2)} * machineSeconds / 60 + ${fa.coef[2]?.toFixed(2)} * passiveMinutes + ${fa.coef[3]?.toFixed(2)} * textSteps + ${fa.coef[4]?.toFixed(2)} * scaleSteps);`
      : "",
    "```",
  ];
  return out.filter((l) => l !== "");
}

function limitations(r: Parameters<typeof renderMarkdown>[0]): string[] {
  return [
    `- Mass is a heuristic from text. ${r.heating.rowsWithoutMass} heated steps had no usable estimate (< 50 g), usually because ingredients are counted in pieces or spoons, or are mentioned without an adding verb.`,
    "- Ingredients in Stück, EL, TL or Prise weigh 0 g unless a scale step weighs them; mass is underestimated for vegetable-heavy recipes written in pieces.",
    "- Reset detection uses keywords. Missed resets inflate later masses (see the > 3000 g share); false resets mark later steps as first heating.",
    "- Water lost by evaporation and food removed with the basket are not modelled.",
    "- 'First heating' means no earlier heated program since the last detected reset; content warmed outside the machine (hot stock, hot milk) is not seen.",
    "- Steaming food mass is known only when a scale step or text names it with grams; class matching reads up to seven steps of text and takes the first class in a fixed priority order.",
    "- Passive minutes come from durations written in text steps (oven, proofing). Device settings written in text are skipped by a simple look-ahead; some may slip through.",
    "- Member recipes (about half the corpus) use the newer program names and are less consistent; official recipes are the better reference for defaults.",
    "- The heater constants (1050 W, 70 %) are assumptions, not measurements of the MC Smart.",
  ];
}

// ---------------------------------------------------------------------------
// CLI

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

export function run(corpusDir: string) {
  const started = Date.now();
  const dir = path.join(corpusDir, "derived");
  const recipes = readJsonl<NormalizedRecipe>(path.join(dir, "recipes.jsonl"));
  const steps = readJsonl<NormalizedStep>(path.join(dir, "steps.jsonl"));
  const byRecipe = new Map<number, NormalizedStep[]>();
  for (const s of steps) {
    const list = byRecipe.get(s.recipeId) ?? [];
    list.push(s);
    byRecipe.set(s.recipeId, list);
  }
  const ctxs: Ctx[] = recipes.map((recipe) => {
    const rs = (byRecipe.get(recipe.id) ?? []).sort((a, b) => a.stepIndex - b.stepIndex);
    return { recipe, steps: rs, est: estimateBowl(recipe, rs) };
  });

  const result = {
    meta: {
      generatedAt: new Date().toISOString(),
      recipes: recipes.length,
      steps: steps.length,
      constants: {
        heaterWatts: HEATER_WATTS,
        efficiency: HEATER_EFFICIENCY,
        heatCapacity: WATER_HEAT_CAPACITY,
        startTemperature: START_TEMPERATURE,
      },
    },
    heating: heatingAnalysis(ctxs),
    sequences: sequenceAnalysis(ctxs),
    steaming: steamingAnalysis(ctxs),
    kneading: kneadingAnalysis(ctxs),
    blending: blendAnalysis(ctxs),
    chopping: choppingAnalysis(ctxs),
    capacity: capacityAnalysis(ctxs),
    durations: durationAnalysis(ctxs),
  };
  writeFileSync(path.join(dir, "timing.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(path.join(dir, "timing.md"), renderMarkdown(result));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `corpus:analyze-timing: ${recipes.length} recipes, ${steps.length} steps -> ${dir} (${seconds}s)`,
  );
  return result;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return norm(entry) === norm(self) || norm(entry) === norm(self.replace(/\.ts$/, ""));
}

if (isMain()) {
  run(process.env.CORPUS_DIR ?? path.join("local", "corpus"));
}
