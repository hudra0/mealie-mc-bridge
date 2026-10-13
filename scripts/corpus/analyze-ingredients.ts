// Corpus analysis, ingredient lens: units, amounts, portions, mass and nutrients.
//
// Input:  $CORPUS_DIR/derived/recipes.jsonl and steps.jsonl (written by corpus:normalize)
// Output: $CORPUS_DIR/derived/ingredients.json  all tables
//         $CORPUS_DIR/derived/ingredients.md    rules for MC-style ingredient lists
//
// Both outputs stay under the gitignored corpus directory. They hold aggregated numbers
// and generic ingredient names only; rules may later move into knowledge/ in our own words.
//
// Run: npm run corpus:analyze-ingredients

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingredientKeys, normalizeUnit, parseAmount } from "./normalize.js";
import type { NormalizedIngredient, NormalizedRecipe } from "./types.js";

// ---------------------------------------------------------------------------
// Small statistics helpers

export interface Quantiles {
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

export function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Linear-interpolated quantile of a sorted array. */
function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export function quantiles(values: readonly number[], digits = 2): Quantiles | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p: number) => round(quantileSorted(v, p), digits);
  return {
    n: v.length,
    min: round(v[0] ?? 0, digits),
    p10: q(0.1),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    max: round(v.at(-1) ?? 0, digits),
    mean: round(v.reduce((s, x) => s + x, 0) / v.length, digits),
  };
}

function median(values: readonly number[]): number | null {
  return quantiles(values)?.p50 ?? null;
}

function share(part: number, total: number): number {
  return total === 0 ? 0 : round(part / total, 3);
}

export class Counter {
  readonly map = new Map<string, number>();
  total = 0;
  add(key: string, by = 1): void {
    this.map.set(key, (this.map.get(key) ?? 0) + by);
    this.total += by;
  }
  get(key: string): number {
    return this.map.get(key) ?? 0;
  }
  top(n = Infinity): [string, number][] {
    return [...this.map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n);
  }
  first(): string | null {
    return this.top(1)[0]?.[0] ?? null;
  }
  /** Top entries as {key: count}, in descending order. */
  toObject(n = Infinity): Record<string, number> {
    return Object.fromEntries(this.top(n));
  }
  /** Top entries with their share of the total. */
  withShares(n = Infinity): { key: string; count: number; share: number }[] {
    return this.top(n).map(([key, count]) => ({ key, count, share: share(count, this.total) }));
  }
}

function groupBy<T>(items: readonly T[], keys: (item: T) => string[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    for (const k of keys(item)) {
      const list = out.get(k);
      if (list) list.push(item);
      else out.set(k, [item]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingredient classification

/** Lowercase, trimmed unit without trailing dot: the spelling-insensitive unit key. */
export function canonicalUnit(unit: string): string {
  return unit.trim().replace(/\.$/, "").toLowerCase();
}

/**
 * The unit in effect: the unit field, or, when it is empty, the first word after the
 * number in the amount field ("250 g" with an empty unit means g). Mirrors the normalizer.
 */
export function effectiveUnit(ing: Pick<NormalizedIngredient, "unit" | "amountRaw">): string {
  if (ing.unit.trim() !== "") return ing.unit;
  const { amount, rest } = parseAmount(ing.amountRaw);
  return amount !== null ? (rest.split(/\s+/)[0] ?? "") : "";
}

/** Grams for g/kg and millilitres for ml/l/cl, or null when the unit is not a measure. */
export function measuredMass(ing: Pick<NormalizedIngredient, "unit" | "amountRaw" | "amount">) {
  if (ing.amount === null) return null;
  const { unitNorm, factor } = normalizeUnit(effectiveUnit(ing));
  if (unitNorm === "g") return { kind: "g" as const, value: ing.amount * factor };
  if (unitNorm === "ml") return { kind: "ml" as const, value: ing.amount * factor };
  return null;
}

const equipmentName =
  /förmchen|schraubgl|einmachgl|einweckgl|backpapier|frischhaltefolie|alufolie|holzspie|schaschlikspie|spieße|muffinpapier|muffinform|papierförmchen|gefrierbeutel|küchengarn|zahnstocher|eisstiel|springform|backform|kastenform|spritzbeutel|^gläser|^glas\b|^flaschen?\b|^à\s/i;

/** Equipment listed as an ingredient (jars, moulds, baking paper), or in a ZUBEHÖR group. */
export function isEquipment(ing: Pick<NormalizedIngredient, "name" | "group">): boolean {
  return /zubeh/i.test(ing.group ?? "") || equipmentName.test(ing.name.trim());
}

const optionalMarker =
  /optional|nach belieben|nach geschmack|\bn\.\s?b\.?|bei bedarf|wer mag|\bnb\b/i;
const garnishMarker =
  /zum (garnieren|bestreuen|servieren|dekorieren|verzieren|bestäuben|einfetten|bestreichen|anrichten|wälzen)|für die form|\bdeko/i;

export type AmountStyle =
  | "empty"
  | "integer"
  | "decimal-comma"
  | "decimal-point"
  | "unicode-fraction"
  | "ascii-fraction"
  | "range"
  | "with-unit"
  | "text";

export function amountStyle(raw: string): AmountStyle {
  const s = raw.trim();
  if (s === "") return "empty";
  if (/^\d+(?:[.,]\d+)?\s*[-–]\s*\d/.test(s)) return "range";
  if (/^\d+$/.test(s)) return "integer";
  if (/^\d+,\d+$/.test(s)) return "decimal-comma";
  if (/^\d+\.\d+$/.test(s)) return "decimal-point";
  if (/^(\d+\s*)?[½¼¾⅓⅔⅛]$/u.test(s)) return "unicode-fraction";
  if (/^(\d+\s+)?\d+\/\d+$/.test(s)) return "ascii-fraction";
  if (/^[\d.,/½¼¾⅓⅔⅛\s]+\s*\p{L}/u.test(s)) return "with-unit";
  return "text";
}

// ---------------------------------------------------------------------------
// Unit concepts used in free-text recipes, for the mapping table

interface UnitConcept {
  key: string;
  unitRe: RegExp;
  /** How the concept shows up in ingredient names when it is not the unit. */
  nameRe: RegExp | null;
}

export const unitConcepts: UnitConcept[] = [
  { key: "EL", unitRe: /^(el|essl[öo]ffel)$/, nameRe: null },
  { key: "TL", unitRe: /^(tl|teel[öo]ffel)$/, nameRe: null },
  { key: "Prise", unitRe: /^prisen?$/, nameRe: null },
  { key: "Msp", unitRe: /^msp$/, nameRe: null },
  { key: "Stück", unitRe: /^(stück|stücke|stk)$/, nameRe: null },
  { key: "Dose", unitRe: /^dosen?$/, nameRe: /\bdosen?\b/i },
  {
    key: "Pkg",
    unitRe: /^(p|pck|pkg|pkt|päckchen|packung|pack)$/,
    nameRe: /päckchen|packung|\bpck\b|\bpkg\b/i,
  },
  { key: "Bund", unitRe: /^bund$/, nameRe: /\bbund\b/i },
  { key: "Zehe", unitRe: /^zehen?$/, nameRe: /zehe/i },
  { key: "Scheibe", unitRe: /^scheiben?$/, nameRe: /scheibe/i },
  { key: "Tasse", unitRe: /^tassen?$/, nameRe: /\btassen?\b/i },
  { key: "Becher", unitRe: /^becher$/, nameRe: /\bbecher\b/i },
  { key: "Würfel", unitRe: /^würfel$/, nameRe: /würfel/i },
  { key: "Handvoll", unitRe: /^handvoll$/, nameRe: /handvoll/i },
  { key: "Glas", unitRe: /^(glas|gläser)$/, nameRe: /\bglas\b/i },
  { key: "Stiel/Zweig", unitRe: /^(stiele?|stängel|zweige?)$/, nameRe: /stiel|zweig|stängel/i },
  { key: "Blatt", unitRe: /^bl(a|ä)tt(er)?$/, nameRe: null },
  { key: "Spritzer/Tropfen", unitRe: /^(spritzer|tropfen|schuss)$/, nameRe: null },
];

export function conceptOf(unit: string): string | null {
  const u = canonicalUnit(unit);
  return unitConcepts.find((c) => c.unitRe.test(u))?.key ?? null;
}

const numberToken = String.raw`\d+\s+[½¼¾⅓⅔]|\d+\s+\d\/\d|\d+(?:[.,]\d+)?|[½¼¾⅓⅔]`;
const annotationRe = new RegExp(
  `(${numberToken})\\s+` +
    String.raw`(?:(tl|el|stück|stk\.?|prisen?|msp\.?|dosen?|bund|zehen?|scheiben?|becher|tassen?|päckchen|pck\.?|pkg\.?|p\.|würfel|gläser|glas|handvoll)\s+)?` +
    String.raw`((?:[\p{L}-]+\s+){0,3}?[\p{L}-]+)\s*\(\s*(?:ca\.\s*|à\s*)?(\d+(?:[.,]\d+)?)\s*(g|ml)\s*\)`,
  "giu",
);

export interface GramAnnotation {
  count: number;
  /** Unit concept key, or "Stück" when only a count is given ("1 Zwiebel (80 g)"). */
  concept: string;
  words: string;
  grams: number;
  gramsPerUnit: number;
}

/** Finds "<n> [unit] <name> (ca. <x> g)" in a text: an explicit weight for a counted amount. */
export function findGramAnnotations(text: string): GramAnnotation[] {
  const out: GramAnnotation[] = [];
  for (const m of text.replace(/\s+/g, " ").matchAll(annotationRe)) {
    const [, num, unit, words, grams, gUnit] = m;
    if (num === undefined || words === undefined || grams === undefined) continue;
    if (gUnit?.toLowerCase() === "ml") continue;
    const { amount } = parseAmount(num);
    const g = Number(grams.replace(",", "."));
    if (amount === null || amount <= 0 || !Number.isFinite(g) || g <= 0) continue;
    const concept = unit ? (conceptOf(unit) ?? canonicalUnit(unit)) : "Stück";
    out.push({
      count: amount,
      concept,
      words: words.toLowerCase(),
      grams: g,
      gramsPerUnit: g / amount,
    });
  }
  return out;
}

/** "Ingwer (30 g)" with 1 Stück, or "Kalbsrouladen (à 170 g)": weight given in the name. */
export function gramsPerUnitFromName(name: string, amount: number | null): number | null {
  const m = /\((?:[^)]*?,\s*)?(?:ca\.\s*)?(à\s*)?(\d+(?:[.,]\d+)?)\s*g\s*\)/i.exec(name);
  if (!m?.[2]) return null;
  const g = Number(m[2].replace(",", "."));
  if (!Number.isFinite(g) || g <= 0) return null;
  if (m[1]) return g;
  return amount !== null && amount > 0 ? g / amount : null;
}

// ---------------------------------------------------------------------------
// Rounding grid

const gridSteps = [1, 5, 10, 25, 50, 100] as const;

export function isMultiple(value: number, step: number): boolean {
  return Math.abs(value / step - Math.round(value / step)) < 1e-9;
}

/** The coarsest step from 1, 5, 10, 25, 50, 100 that at least `threshold` of the values sit on. */
export function inferGrid(values: readonly number[], threshold = 0.9): number | null {
  if (values.length === 0) return null;
  let best: number | null = null;
  for (const step of gridSteps) {
    const on = values.filter((v) => isMultiple(v, step)).length;
    if (on / values.length >= threshold) best = step;
  }
  return best;
}

const massBands: [string, number, number][] = [
  ["<10", 0, 10],
  ["10-49", 10, 50],
  ["50-99", 50, 100],
  ["100-249", 100, 250],
  ["250-499", 250, 500],
  ["500-999", 500, 1000],
  [">=1000", 1000, Infinity],
];

function gridTable(values: readonly number[]) {
  return massBands.map(([band, lo, hi]) => {
    const v = values.filter((x) => x >= lo && x < hi);
    const ints = v.filter((x) => Number.isInteger(x));
    const lastDigit = new Counter();
    for (const x of ints) lastDigit.add(String(x % 10));
    const values10 = new Counter();
    for (const x of v) values10.add(String(x));
    return {
      band,
      n: v.length,
      nonIntegerShare: share(v.length - ints.length, v.length),
      lastDigit: Object.fromEntries(
        Array.from({ length: 10 }, (_, d) => [
          String(d),
          share(lastDigit.get(String(d)), ints.length),
        ]),
      ),
      multipleOf: Object.fromEntries(
        gridSteps.map((s) => [
          String(s),
          share(v.filter((x) => isMultiple(x, s)).length, v.length),
        ]),
      ),
      inferredGrid90: inferGrid(v, 0.9),
      inferredGrid80: inferGrid(v, 0.8),
      topValues: values10.toObject(12),
    };
  });
}

// ---------------------------------------------------------------------------
// Loading

interface StepLite {
  recipeId: number;
  mode: string;
  text: string;
  weight: number | null;
  cumulativeGramsBefore: number;
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

type Source = "official" | "member";

function perSource<T>(fn: (src: Source) => T): Record<Source, T> {
  return { official: fn("official"), member: fn("member") };
}

function sourceOf(r: NormalizedRecipe): Source {
  return r.source === "official" ? "official" : "member";
}

function isPortionUnit(unit: string | null): boolean {
  return /^portion|person/i.test(unit ?? "");
}

interface IngRow {
  recipe: NormalizedRecipe;
  ing: NormalizedIngredient;
  source: Source;
  servings: number | null;
  portionServings: boolean;
  equipment: boolean;
  unitExact: string;
  unitCanon: string;
  unitNormEff: string;
  mass: { kind: "g" | "ml"; value: number } | null;
}

function buildRows(recipes: readonly NormalizedRecipe[]): IngRow[] {
  const rows: IngRow[] = [];
  for (const recipe of recipes) {
    const s = recipe.servings.amount;
    for (const ing of recipe.ingredients) {
      const eff = effectiveUnit(ing);
      rows.push({
        recipe,
        ing,
        source: sourceOf(recipe),
        servings: s !== null && s > 0 ? s : null,
        portionServings: isPortionUnit(recipe.servings.unit),
        equipment: isEquipment(ing),
        unitExact: ing.unit,
        unitCanon: canonicalUnit(eff),
        unitNormEff: normalizeUnit(eff).unitNorm,
        mass: measuredMass(ing),
      });
    }
  }
  return rows;
}

function categoryNames(r: NormalizedRecipe): string[] {
  return ["(all)", ...r.categories.map((c) => c.name ?? String(c.id))];
}

/**
 * Key that joins uses of one ingredient across recipes. Catalog ids map one to one to
 * names, and member recipes often carry id -1 with a catalog name typed as free text, so
 * the lowercase name joins more uses than the id does.
 */
function ingredientKey(ing: NormalizedIngredient): string {
  return `name:${ing.name.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Sections

function unitVocabulary(rows: readonly IngRow[]) {
  const food = rows.filter((r) => !r.equipment);
  const bySource = perSource((src) => {
    const list = food.filter((r) => r.source === src);
    const exact = new Counter();
    const canon = new Counter();
    const norm = new Counter();
    for (const r of list) {
      exact.add(JSON.stringify(r.unitExact));
      canon.add(r.unitCanon === "" ? "(none)" : r.unitCanon);
      norm.add(r.unitNormEff);
    }
    const grams = list.filter((r) => r.mass?.kind === "g").length;
    const ml = list.filter((r) => r.mass?.kind === "ml").length;
    return {
      ingredients: list.length,
      gramsShare: share(grams, list.length),
      gramsOrMlShare: share(grams + ml, list.length),
      numericAmountShare: share(list.filter((r) => r.ing.amount !== null).length, list.length),
      unitExact: exact.withShares(60),
      unitCanonical: canon.withShares(40),
      unitNorm: norm.withShares(),
    };
  });
  const casing = perSource((src) => {
    const c = new Counter();
    for (const r of food.filter((x) => x.source === src)) {
      if (["tl", "el", "prise", "msp", "stück", "p"].includes(r.unitCanon)) c.add(r.unitExact);
    }
    return c.toObject(20);
  });
  const prise = perSource((src) => {
    const c = new Counter();
    for (const r of food.filter((x) => x.source === src && x.unitCanon.startsWith("prise"))) {
      const n = r.ing.amount;
      c.add(`${n === null ? "?" : n <= 1 ? "<=1" : ">1"} ${r.unitExact.trim()}`);
    }
    return c.toObject();
  });
  const style = perSource((src) => {
    const c = new Counter();
    for (const r of food.filter((x) => x.source === src)) c.add(amountStyle(r.ing.amountRaw));
    return c.withShares();
  });
  return {
    equipmentRowsExcluded: rows.length - food.length,
    bySource,
    spoonAndPinchCasing: casing,
    priseVsPrisen: prise,
    amountStyle: style,
  };
}

function topIngredients(rows: readonly IngRow[], limit: number) {
  const food = rows.filter((r) => !r.equipment);
  const byName = groupBy(food, (r) => [r.ing.name.trim()]);
  const ranked = [...byName.entries()]
    .map(([name, list]) => ({ name, list, recipes: new Set(list.map((r) => r.recipe.id)).size }))
    .sort((a, b) => b.recipes - a.recipes || a.name.localeCompare(b.name));

  const top = ranked.slice(0, limit).map(({ name, list, recipes }) => {
    const units = new Counter();
    const ids = new Counter();
    for (const r of list) {
      units.add(r.unitExact.trim() === "" ? "(none)" : r.unitExact.trim());
      if (r.ing.systemIngredientId !== null && r.ing.systemIngredientId > 0) {
        ids.add(String(r.ing.systemIngredientId));
      }
    }
    // Usual unit by normalized unit (Tl, TL and tl count together), spelled as most rows
    // in that unit spell it; the per-serving quantiles are in that same unit.
    const usualNorm = new Counter();
    for (const r of list) usualNorm.add(r.unitNormEff);
    const norm = usualNorm.first() ?? "none";
    const spelled = new Counter();
    for (const r of list) {
      if (r.unitNormEff === norm)
        spelled.add(r.unitExact.trim() === "" ? "(none)" : r.unitExact.trim());
    }
    const usualUnit = spelled.first() ?? "(none)";
    const inNorm = list.filter((r) => r.unitNormEff === norm && r.ing.amount !== null);
    const valueOf = (r: IngRow) => (r.mass ? r.mass.value : (r.ing.amount ?? 0));
    const id = ids.first();
    return {
      name,
      recipes,
      official: list.filter((r) => r.source === "official").length,
      member: list.filter((r) => r.source === "member").length,
      systemIngredientId: id === null ? null : Number(id),
      idShare: share(ids.total, list.length),
      usualUnit,
      usualUnitNorm: norm,
      units: units.toObject(5),
      gramsShare: share(list.filter((r) => r.mass?.kind === "g").length, list.length),
      emptyAmountShare: share(
        list.filter((r) => r.ing.amountRaw.trim() === "").length,
        list.length,
      ),
      perServing: quantiles(
        inNorm.filter((r) => r.servings !== null).map((r) => valueOf(r) / (r.servings ?? 1)),
      ),
      perServingPortionen: quantiles(
        inNorm
          .filter((r) => r.servings !== null && r.portionServings)
          .map((r) => valueOf(r) / (r.servings ?? 1)),
      ),
      perRecipe: quantiles(inNorm.map(valueOf)),
    };
  });

  // Catalog coverage
  const withId = food.filter(
    (r) => r.ing.systemIngredientId !== null && r.ing.systemIngredientId > 0,
  );
  const namesById = groupBy(withId, (r) => [String(r.ing.systemIngredientId)]);
  const catalogNames = new Set(withId.map((r) => r.ing.name.trim().toLowerCase()));
  const idsByName = new Map<string, Set<number>>();
  for (const r of withId) {
    const k = r.ing.name.trim().toLowerCase();
    const set = idsByName.get(k) ?? new Set<number>();
    set.add(r.ing.systemIngredientId ?? 0);
    idsByName.set(k, set);
  }
  const spellings = [...namesById.entries()]
    .map(([id, list]) => {
      const names = new Counter();
      for (const r of list) names.add(r.ing.name.trim());
      return {
        systemIngredientId: Number(id),
        uses: list.length,
        names: names.toObject(6),
        nameCount: names.map.size,
      };
    })
    .sort((a, b) => b.nameCount - a.nameCount || b.uses - a.uses);
  const catalog = [...namesById.entries()]
    .map(([id, list]) => {
      const names = new Counter();
      const units = new Counter();
      for (const r of list) {
        names.add(r.ing.name.trim());
        units.add(r.unitExact.trim() === "" ? "(none)" : r.unitExact.trim());
      }
      return {
        systemIngredientId: Number(id),
        uses: list.length,
        name: names.first(),
        usualUnit: units.first(),
      };
    })
    .filter((c) => c.uses >= 3)
    .sort((a, b) => b.uses - a.uses);

  return {
    distinctNames: byName.size,
    top,
    topWithIdCount: top.filter((t) => t.systemIngredientId !== null).length,
    catalogCoverage: {
      ingredients: food.length,
      withSystemId: withId.length,
      withSystemIdShare: share(withId.length, food.length),
      systemIdMinusOne: food.filter((r) => r.ing.systemIngredientId === -1).length,
      minusOneWithCatalogName: share(
        food.filter(
          (r) =>
            r.ing.systemIngredientId === -1 && catalogNames.has(r.ing.name.trim().toLowerCase()),
        ).length,
        food.filter((r) => r.ing.systemIngredientId === -1).length,
      ),
      namesWithSeveralIds: [...idsByName.values()].filter((ids) => ids.size > 1).length,
      bySource: perSource((src) => {
        const l = food.filter((r) => r.source === src);
        const w = l.filter(
          (r) => r.ing.systemIngredientId !== null && r.ing.systemIngredientId > 0,
        );
        return share(w.length, l.length);
      }),
      distinctIds: namesById.size,
      idsWithSeveralSpellings: spellings.filter((s) => s.nameCount > 1).length,
      mostSpellings: spellings.slice(0, 15),
    },
    catalog,
  };
}

function groupNames(rows: readonly IngRow[], recipes: readonly NormalizedRecipe[]) {
  const pattern = (g: string): string => {
    const u = g.trim().toUpperCase();
    if (/^AU(SS|ß)ERDEM/.test(u)) return "AUSSERDEM";
    if (/ZUBEH/.test(u)) return "ZUBEHÖR";
    if (
      /^(FÜR )?(\d+|EIN|EINE|EINEN)\b|\d+\s*(PORTION|STÜCK|GLÄS|GLAS|PERSON|FLASCHE|BROT)/.test(u)
    ) {
      return "yield header (FÜR 12 STÜCKE, FÜR 1 BROT, 4 PORTIONEN)";
    }
    if (/^ZUTATEN/.test(u)) return "ZUTATEN ...";
    if (/^FÜR (DEN|DIE|DAS) /.test(u)) return "FÜR DEN/DIE/DAS <component>";
    return "bare component name (TEIG, BELAG, ...)";
  };
  const bySource = perSource((src) => {
    const list = rows.filter((r) => r.source === src);
    const exact = new Counter();
    const norm = new Counter();
    const patterns = new Counter();
    let allCaps = 0;
    let leadingSpace = 0;
    let named = 0;
    for (const r of list) {
      const g = r.ing.group;
      if (g === null || g.trim() === "") {
        exact.add("(no group)");
        continue;
      }
      named++;
      exact.add(g);
      norm.add(g.trim().toUpperCase().replace(/\s+/g, " "));
      patterns.add(pattern(g));
      if (g === g.toUpperCase()) allCaps++;
      if (/^\s/.test(g)) leadingSpace++;
    }
    const rs = recipes.filter((r) => sourceOf(r) === src);
    const groupsPerRecipe = rs.map(
      (r) => new Set(r.ingredients.map((i) => i.group?.trim()).filter((g) => g)).size,
    );
    return {
      ingredients: list.length,
      ungroupedShare: share(list.length - named, list.length),
      recipesWithoutGroups: share(groupsPerRecipe.filter((n) => n === 0).length, rs.length),
      groupsPerRecipe: quantiles(groupsPerRecipe),
      allCapsShare: share(allCaps, named),
      leadingSpace,
      patterns: patterns.withShares(),
      normalized: norm.withShares(40),
      exact: exact.toObject(40),
    };
  });
  return bySource;
}

function servingsByCategory(recipes: readonly NormalizedRecipe[]) {
  const byCat = groupBy(recipes, categoryNames);
  return [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([category, list]) => {
      const units = new Counter();
      const pairs = new Counter();
      for (const r of list) {
        units.add(r.servings.unit ?? "(none)");
        pairs.add(`${r.servings.amount ?? "?"} ${r.servings.unit ?? ""}`.trim());
      }
      return {
        category,
        recipes: list.length,
        units: units.toObject(6),
        topPairs: pairs.toObject(8),
        portionenAmount: quantiles(
          list.filter((r) => isPortionUnit(r.servings.unit)).map((r) => r.servings.amount ?? NaN),
        ),
      };
    });
}

interface PieceWeights {
  byKey: Map<string, number>;
  byConcept: Map<string, number>;
}

function recipeMass(recipe: NormalizedRecipe, pieces: PieceWeights | null) {
  let g = 0;
  let ml = 0;
  let estimated = 0;
  let counted = 0;
  let food = 0;
  for (const ing of recipe.ingredients) {
    if (isEquipment(ing)) continue;
    food++;
    const m = measuredMass(ing);
    if (m) {
      counted++;
      if (m.kind === "g") g += m.value;
      else ml += m.value;
      continue;
    }
    if (!pieces || ing.amount === null) continue;
    const perUnit =
      pieces.byKey.get(
        `${ingredientKey(ing)}|${conceptOf(effectiveUnit(ing)) ?? (effectiveUnit(ing).trim() === "" ? "Stück" : canonicalUnit(effectiveUnit(ing)))}`,
      ) ??
      (["EL", "TL", "Prise", "Msp"].includes(conceptOf(effectiveUnit(ing)) ?? "")
        ? pieces.byConcept.get(conceptOf(effectiveUnit(ing)) ?? "")
        : undefined);
    if (perUnit !== undefined) {
      estimated += perUnit * ing.amount;
      counted++;
    }
  }
  return {
    g,
    ml,
    measured: g + ml,
    withEstimates: g + ml + estimated,
    coverage: share(counted, food),
  };
}

function massByCategory(
  recipes: readonly NormalizedRecipe[],
  pieces: PieceWeights,
  peakByRecipe: Map<number, number>,
  steamRecipes: Set<number>,
) {
  const masses = new Map(
    recipes.map((r) => [r.id, { m: recipeMass(r, null), e: recipeMass(r, pieces) }]),
  );
  const summarize = (list: readonly NormalizedRecipe[]) => {
    const measured = list.map((r) => masses.get(r.id)?.m.measured ?? 0);
    const withEst = list.map((r) => masses.get(r.id)?.e.withEstimates ?? 0);
    const peaks = list.map((r) => peakByRecipe.get(r.id) ?? 0);
    return {
      recipes: list.length,
      measured: quantiles(measured, 0),
      withEstimates: quantiles(withEst, 0),
      coverageWithEstimates: quantiles(list.map((r) => masses.get(r.id)?.e.coverage ?? 0)),
      over2500: share(measured.filter((x) => x > 2500).length, list.length),
      over3000: share(measured.filter((x) => x > 3000).length, list.length),
      over2500WithEstimates: share(withEst.filter((x) => x > 2500).length, list.length),
      over3000WithEstimates: share(withEst.filter((x) => x > 3000).length, list.length),
      bowlPeak: quantiles(peaks, 0),
      bowlPeakOver2500: share(peaks.filter((x) => x > 2500).length, list.length),
      bowlPeakOver3000: share(peaks.filter((x) => x > 3000).length, list.length),
    };
  };
  const over3000 = recipes.filter((r) => (masses.get(r.id)?.m.measured ?? 0) > 3000);
  const cats = new Counter();
  for (const r of over3000) for (const c of r.categories) cats.add(c.name ?? String(c.id));
  return {
    note:
      "measured = sum of g and ml amounts (equipment excluded); withEstimates adds piece and spoon " +
      "weights from the mapping section; bowlPeak = highest cumulativeGramsBefore over the steps " +
      "(normalizer estimate of bowl content).",
    bySource: perSource((s) => summarize(recipes.filter((r) => sourceOf(r) === s))),
    byCategory: [...groupBy(recipes, categoryNames).entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([category, list]) => ({ category, ...summarize(list) })),
    over3000Measured: {
      recipes: over3000.length,
      withSteamingStep: over3000.filter((r) => steamRecipes.has(r.id)).length,
      categories: cats.toObject(10),
    },
  };
}

function nutrientsByCategory(recipes: readonly NormalizedRecipe[]) {
  const summarize = (list: readonly NormalizedRecipe[]) => {
    // A record with 0 kcal is an unfilled form, not a zero-calorie dish.
    const has = list.filter((r) => r.nutrients.kcal !== null && r.nutrients.kcal > 0);
    const pick = (k: "kcal" | "carb" | "fat" | "protein") =>
      quantiles(
        has.map((r) => r.nutrients[k] ?? NaN),
        0,
      );
    const atwater = has
      .map((r) => {
        const { kcal, carb, fat, protein } = r.nutrients;
        const est = 4 * (carb ?? 0) + 4 * (protein ?? 0) + 9 * (fat ?? 0);
        return kcal !== null && est > 0 ? kcal / est : NaN;
      })
      .filter((x) => Number.isFinite(x));
    return {
      recipes: list.length,
      withNutrients: has.length,
      zeroKcal: list.filter((r) => r.nutrients.kcal === 0).length,
      kcal: pick("kcal"),
      carb: pick("carb"),
      fat: pick("fat"),
      protein: pick("protein"),
      kcalToAtwater: quantiles(atwater),
    };
  };
  return {
    note: "Per serving as published; servings may be portions, pieces, jars or bottles.",
    bySource: perSource((s) => summarize(recipes.filter((r) => sourceOf(r) === s))),
    byServingUnit: {
      portionen: summarize(recipes.filter((r) => isPortionUnit(r.servings.unit))),
      other: summarize(recipes.filter((r) => !isPortionUnit(r.servings.unit))),
    },
    byCategory: [...groupBy(recipes, categoryNames).entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([category, list]) => ({ category, ...summarize(list) })),
  };
}

function optionalIngredients(rows: readonly IngRow[], recipes: readonly NormalizedRecipe[]) {
  const food = rows.filter((r) => !r.equipment);
  return perSource((src) => {
    const list = food.filter((r) => r.source === src);
    const where = new Counter();
    const emptyNames = new Counter();
    const optNames = new Counter();
    const textAmounts = new Counter();
    const optRecipes = new Set<number>();
    let empty = 0;
    let freeText = 0;
    let optional = 0;
    let garnish = 0;
    let ausserdem = 0;
    const purpose = new Counter();
    let purposeRows = 0;
    for (const r of list) {
      const raw = r.ing.amountRaw.trim();
      if (raw === "") {
        empty++;
        emptyNames.add(r.ing.name.trim());
      } else if (r.ing.amount === null) {
        freeText++;
        textAmounts.add(raw);
      }
      const inName = optionalMarker.test(r.ing.name);
      const inAmount = optionalMarker.test(raw);
      const inGroup = optionalMarker.test(r.ing.group ?? "");
      if (inName || inAmount || inGroup) {
        optional++;
        optRecipes.add(r.recipe.id);
        optNames.add(r.ing.name.trim());
        if (inName) where.add("name");
        if (inAmount) where.add("amount");
        if (inGroup) where.add("group");
      }
      if (garnishMarker.test(r.ing.name) || garnishMarker.test(r.ing.group ?? "")) garnish++;
      if (/^\s*AU(SS|ß)ERDEM/i.test(r.ing.group ?? "")) ausserdem++;
      // Purpose suffix in the name: "Salz zum Abschmecken", "Fett zum Verarbeiten".
      const p = /\b(zum|zur|für die|für den|für das)\s+([\p{L}-]+)/iu.exec(r.ing.name);
      if (p?.[1] && p[2]) {
        purposeRows++;
        purpose.add(`${p[1].toLowerCase()} ${p[2]}`);
      }
    }
    const rs = recipes.filter((r) => sourceOf(r) === src);
    return {
      ingredients: list.length,
      emptyAmountShare: share(empty, list.length),
      freeTextAmountShare: share(freeText, list.length),
      optionalMarkerShare: share(optional, list.length),
      recipesWithOptionalMarker: share(optRecipes.size, rs.length),
      garnishMarkerShare: share(garnish, list.length),
      purposeSuffixShare: share(purposeRows, list.length),
      purposeSuffixes: purpose.toObject(15),
      purposeSuffixWithEmptyAmount: share(
        list.filter((r) => /\b(zum|zur)\s/i.test(r.ing.name) && r.ing.amountRaw.trim() === "")
          .length,
        list.filter((r) => /\b(zum|zur)\s/i.test(r.ing.name)).length,
      ),
      ausserdemGroupShare: share(ausserdem, list.length),
      markerLocation: where.toObject(),
      topEmptyAmountNames: emptyNames.toObject(20),
      topOptionalNames: optNames.toObject(15),
      topFreeTextAmounts: textAmounts.toObject(15),
    };
  });
}

/** Upper bounds for one spoon or pinch; observations above are mismatches and are dropped. */
const maxGramsPerUnit: Record<string, number> = { TL: 15, EL: 40, Prise: 2, Msp: 2 };

function pieceWeights(rows: readonly IngRow[], steps: readonly StepLite[]) {
  const byRecipe = groupBy(rows, (r) => [String(r.recipe.id)]);
  // Observations: ingredient key -> grams per listed unit, with the listed unit concept.
  const obs: { key: string; name: string; concept: string; gramsPerUnit: number; via: string }[] =
    [];
  const annotationsByConcept = new Map<string, number[]>();

  const match = (recipeId: number, words: string): IngRow | null => {
    const list = byRecipe.get(String(recipeId)) ?? [];
    let best: IngRow | null = null;
    let bestLen = 0;
    for (const r of list) {
      for (const k of ingredientKeys(r.ing.name)) {
        if (words.includes(k) && k.length > bestLen) {
          best = r;
          bestLen = k.length;
        }
      }
    }
    return best;
  };

  for (const s of steps) {
    for (const a of findGramAnnotations(s.text)) {
      const list = annotationsByConcept.get(a.concept) ?? [];
      if (a.gramsPerUnit <= (maxGramsPerUnit[a.concept] ?? Infinity)) list.push(a.gramsPerUnit);
      annotationsByConcept.set(a.concept, list);
      // The text gives the weight of a counted amount; the list may give the same
      // ingredient in g ("Zwiebeln 80 g" listed, "1 Zwiebel (80 g)" in the step), which is
      // exactly the piece weight a free-text "1 Zwiebel" needs.
      const r = match(s.recipeId, a.words);
      if (!r) continue;
      obs.push({
        key: ingredientKey(r.ing),
        name: r.ing.name.trim(),
        concept: a.concept,
        gramsPerUnit: a.gramsPerUnit,
        via: r.mass ? "text, listed in g" : "text",
      });
    }
    // Scale step that weighs one counted ingredient without naming the weight in text.
    if (s.mode === "scale" && s.weight !== null && s.weight > 0 && !/\d\s*(g|ml)\b/i.test(s.text)) {
      const lower = s.text.toLowerCase();
      const named = (byRecipe.get(String(s.recipeId)) ?? []).filter((x) =>
        ingredientKeys(x.ing.name).some((k) => lower.includes(k)),
      );
      // Only when the step names exactly one ingredient, so the weight belongs to it.
      const r = named.length === 1 ? named[0] : undefined;
      if (!r || r.mass || r.ing.amount === null || r.ing.amount <= 0) continue;
      const lead = parseAmount(s.text).amount;
      const count = lead !== null && lead > 0 ? lead : r.ing.amount;
      const concept =
        conceptOf(effectiveUnit(r.ing)) ?? (r.unitCanon === "" ? "Stück" : r.unitCanon);
      obs.push({
        key: ingredientKey(r.ing),
        name: r.ing.name.trim(),
        concept,
        gramsPerUnit: s.weight / count,
        via: "scale",
      });
    }
  }
  for (const r of rows) {
    if (r.mass || r.equipment) continue;
    const gpu = gramsPerUnitFromName(r.ing.name, r.ing.amount);
    if (gpu === null) continue;
    const concept = conceptOf(effectiveUnit(r.ing)) ?? (r.unitCanon === "" ? "Stück" : r.unitCanon);
    obs.push({
      key: ingredientKey(r.ing),
      name: r.ing.name.trim(),
      concept,
      gramsPerUnit: gpu,
      via: "name",
    });
  }

  const plausible = obs.filter((o) => o.gramsPerUnit <= (maxGramsPerUnit[o.concept] ?? Infinity));
  const dropped = obs.length - plausible.length;
  const byKey = groupBy(plausible, (o) => [`${o.key}|${o.concept}`]);
  const table = [...byKey.entries()]
    .map(([k, list]) => {
      const names = new Counter();
      const via = new Counter();
      for (const o of list) {
        names.add(o.name);
        via.add(o.via);
      }
      const [key, concept] = k.split("|");
      return {
        key: key ?? "",
        name: names.first() ?? "",
        concept: concept ?? "",
        n: list.length,
        gramsPerUnit: median(list.map((o) => o.gramsPerUnit)) ?? 0,
        spread: quantiles(
          list.map((o) => o.gramsPerUnit),
          1,
        ),
        via: via.toObject(),
      };
    })
    .sort((a, b) => b.n - a.n);
  return { observations: plausible.length, dropped, table, annotationsByConcept };
}

function crossRecipeRatios(rows: readonly IngRow[]) {
  // Ingredients written in g in some recipes and in a counted unit in others: the ratio of
  // the median per-serving amounts is a weak grams-per-unit estimate.
  const food = rows.filter((r) => !r.equipment && r.servings !== null && r.ing.amount !== null);
  const byKey = groupBy(food, (r) => [ingredientKey(r.ing)]);
  const out: {
    key: string;
    name: string;
    concept: string;
    nGrams: number;
    nUnit: number;
    gramsPerUnit: number;
  }[] = [];
  for (const [key, list] of byKey) {
    const grams = list
      .filter((r) => r.mass?.kind === "g")
      .map((r) => (r.mass?.value ?? 0) / (r.servings ?? 1));
    if (grams.length < 5) continue;
    const byConcept = groupBy(
      list.filter((r) => !r.mass),
      (r) => [conceptOf(effectiveUnit(r.ing)) ?? (r.unitCanon === "" ? "Stück" : r.unitCanon)],
    );
    for (const [concept, ul] of byConcept) {
      if (ul.length < 5) continue;
      const g = median(grams);
      const u = median(ul.map((r) => (r.ing.amount ?? 0) / (r.servings ?? 1)));
      if (g === null || u === null || u <= 0) continue;
      const names = new Counter();
      for (const r of list) names.add(r.ing.name.trim());
      out.push({
        key,
        name: names.first() ?? "",
        concept,
        nGrams: grams.length,
        nUnit: ul.length,
        gramsPerUnit: round(g / u, 1),
      });
    }
  }
  return out.sort((a, b) => b.nGrams + b.nUnit - (a.nGrams + a.nUnit));
}

function unitMapping(
  rows: readonly IngRow[],
  pieces: ReturnType<typeof pieceWeights>,
  ratios: ReturnType<typeof crossRecipeRatios>,
) {
  const food = rows.filter((r) => !r.equipment);
  const officialByKey = groupBy(
    food.filter((r) => r.source === "official"),
    (r) => [ingredientKey(r.ing)],
  );
  return unitConcepts.map((c) => {
    const inUnit = food.filter((r) => c.unitRe.test(r.unitCanon));
    const official = inUnit.filter((r) => r.source === "official");
    const member = inUnit.filter((r) => r.source === "member");
    const exact = new Counter();
    for (const r of official) exact.add(r.unitExact.trim());
    const exactMember = new Counter();
    for (const r of member) exactMember.add(r.unitExact.trim());

    // Concept used inside official names ("Knoblauchzehe", "Tomaten (Dose)") instead of the unit.
    const nameUse = c.nameRe
      ? food.filter(
          (r) =>
            r.source === "official" && c.nameRe?.test(r.ing.name) && !c.unitRe.test(r.unitCanon),
        )
      : [];
    const nameUnits = new Counter();
    const nameExamples = new Counter();
    for (const r of nameUse) {
      nameUnits.add(r.unitExact.trim() === "" ? "(none)" : r.unitExact.trim());
      nameExamples.add(r.ing.name.trim());
    }

    // How official recipes write the same ingredients that members give in this unit.
    const targetUnits = new Counter();
    const perIngredient = groupBy(member.length > 0 ? member : official, (r) => [
      ingredientKey(r.ing),
    ]);
    const examples = [...perIngredient.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 12)
      .map(([key, list]) => {
        const off = officialByKey.get(key) ?? [];
        const units = new Counter();
        for (const r of off)
          units.add(r.unitNormEff === "g" ? "g" : r.unitExact.trim() || "(none)");
        const usual = units.first();
        const offIn = off.filter((r) =>
          usual === "g" ? r.mass?.kind === "g" : r.unitExact.trim() === usual,
        );
        const names = new Counter();
        for (const r of list) names.add(r.ing.name.trim());
        const piece = pieces.table.find((p) => p.key === key && p.concept === c.key);
        const ratio = ratios.find((p) => p.key === key && p.concept === c.key);
        return {
          ingredient: names.first(),
          uses: list.length,
          officialUses: off.length,
          officialUsualUnit: usual,
          officialUnits: units.toObject(4),
          officialMedianPerServing: median(
            offIn
              .filter((r) => r.servings !== null)
              .map((r) => (r.mass?.value ?? r.ing.amount ?? 0) / (r.servings ?? 1)),
          ),
          gramsPerUnit: piece ? { value: piece.gramsPerUnit, n: piece.n, via: piece.via } : null,
          gramsPerUnitCrossRecipe: ratio ? ratio.gramsPerUnit : null,
        };
      });
    for (const r of member) {
      const off = officialByKey.get(ingredientKey(r.ing)) ?? [];
      const u = new Counter();
      for (const o of off)
        u.add(
          o.unitNormEff === "g" || o.unitNormEff === "ml" ? o.unitNormEff : o.unitCanon || "(none)",
        );
      const usual = u.first();
      if (usual !== null) targetUnits.add(usual);
    }
    const ann = pieces.annotationsByConcept.get(c.key) ?? [];
    const conceptPieces = pieces.table.filter((p) => p.concept === c.key);
    return {
      concept: c.key,
      officialUnitUses: official.length,
      memberUnitUses: member.length,
      officialExactSpellings: exact.toObject(5),
      memberExactSpellings: exactMember.toObject(5),
      officialNameUses: nameUse.length,
      officialNameUnits: nameUnits.toObject(5),
      officialNameExamples: nameExamples.toObject(6),
      memberUsesWithOfficialCounterpart: share(targetUnits.total, member.length),
      officialTargetForMemberUses: targetUnits.withShares(6),
      gramsPerUnitAnnotations: quantiles(ann, 1),
      gramsPerUnitAllObservations: quantiles(
        conceptPieces.flatMap((p) => Array<number>(p.n).fill(p.gramsPerUnit)),
        1,
      ),
      topIngredients: examples,
    };
  });
}

function roundingGrid(rows: readonly IngRow[]) {
  const food = rows.filter((r) => !r.equipment && r.ing.amount !== null);
  return perSource((src) => {
    const list = food.filter((r) => r.source === src);
    const g = list.filter((r) => r.mass?.kind === "g").map((r) => r.mass?.value ?? 0);
    const ml = list.filter((r) => r.mass?.kind === "ml").map((r) => r.mass?.value ?? 0);
    const counted = (concept: string) => {
      const c = new Counter();
      for (const r of list) {
        if ((conceptOf(effectiveUnit(r.ing)) ?? "") === concept)
          c.add(String(round(r.ing.amount ?? 0, 3)));
      }
      return c.toObject(12);
    };
    return {
      grams: { n: g.length, overall: inferGrid(g), bands: gridTable(g) },
      ml: { n: ml.length, bands: gridTable(ml).filter((b) => b.n > 0) },
      valuesTL: counted("TL"),
      valuesEL: counted("EL"),
      valuesPrise: counted("Prise"),
      valuesStueck: counted("Stück"),
    };
  });
}

function nameSpelling(rows: readonly IngRow[]) {
  const food = rows.filter((r) => !r.equipment);
  return perSource((src) => {
    const list = food.filter((r) => r.source === src);
    const paren = new Counter();
    const comma = new Counter();
    let withParen = 0;
    let withComma = 0;
    let lowerFirst = 0;
    for (const r of list) {
      const name = r.ing.name.trim();
      const p = /\(([^)]*)\)/.exec(name);
      if (p?.[1] !== undefined) {
        withParen++;
        paren.add(p[1].trim().replace(/\d+(?:[.,]\d+)?/g, "<n>"));
      }
      const c = /,\s*([^,(]+)/.exec(name.replace(/\([^)]*\)/g, ""));
      if (c?.[1] !== undefined) {
        withComma++;
        comma.add(c[1].trim());
      }
      if (/^\p{Ll}/u.test(name)) lowerFirst++;
    }
    const stueck = list.filter(
      (r) => (conceptOf(effectiveUnit(r.ing)) ?? (r.unitCanon === "" ? "Stück" : "")) === "Stück",
    );
    const one = new Counter();
    const many = new Counter();
    for (const r of stueck) {
      if (r.ing.amount === null) continue;
      (r.ing.amount <= 1 ? one : many).add(r.ing.name.trim());
    }
    return {
      names: list.length,
      withParenthesesShare: share(withParen, list.length),
      withCommaQualifierShare: share(withComma, list.length),
      lowercaseFirstShare: share(lowerFirst, list.length),
      topParentheses: paren.toObject(30),
      topCommaQualifiers: comma.toObject(20),
      stueckAmountUpTo1: one.toObject(15),
      stueckAmountOver1: many.toObject(15),
    };
  });
}

// ---------------------------------------------------------------------------
// Markdown

type Json = ReturnType<typeof analyze>;

function fmt(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  return String(round(x, digits));
}

function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? "–" : `${round(x * 100, 1)}%`;
}

function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) =>
    `| ${cells.map((c) => String(c).replace(/\|/g, "/")).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function renderMarkdown(j: Json): string {
  const off = j.units.bySource.official;
  const mem = j.units.bySource.member;
  const gridOff = j.rounding.official;
  const gridMem = j.rounding.member;
  const optOff = j.optional.official;
  const optMem = j.optional.member;
  const grpOff = j.groups.official;
  const spellOff = j.spelling.official;
  const massAll = j.mass.byCategory.find((c) => c.category === "(all)");
  const top = (o: Record<string, number>, n: number) =>
    Object.entries(o)
      .slice(0, n)
      .map(([k, v]) => `${k} (${v})`)
      .join(", ");

  const out: string[] = [];
  out.push("# Ingredient lists in MC Smart recipes");
  out.push("");
  out.push(
    `Generated by \`scripts/corpus/analyze-ingredients.ts\` from ${j.meta.recipes} recipes ` +
      `(${j.meta.official} official, ${j.meta.member} member) and ${j.meta.ingredients} ingredient rows. ` +
      "Aggregated numbers only. Official recipes are the style reference; member recipes show what free-text input looks like.",
  );
  out.push("");
  out.push("## Rules for writing an MC-style ingredient list");
  out.push("");
  out.push(
    `1. **Weigh in grams.** ${pct(off.gramsShare)} of official ingredient rows use g ` +
      `(member: ${pct(mem.gramsShare)}). Liquids are weighed too: ml is practically absent (${pct(off.gramsOrMlShare - off.gramsShare)} ` +
      "of official rows), so water, milk, stock and cream go in as g (1 ml = 1 g is fine for water-like liquids; " +
      "oil about 0.92 g/ml, honey and syrup about 1.4 g/ml). The scale step weighs everything that goes into the bowl.",
  );
  out.push(
    "2. **Allowed non-gram units** (official spelling, exact case): " +
      top(Object.fromEntries(off.unitExact.slice(0, 10).map((u) => [u.key, u.count])), 10) +
      ". In practice: `Stück` for countable items (eggs, onions, cloves of garlic, lemons), `Tl` for spices, " +
      "salt, baking powder and yeast in small amounts, `Prise`/`Prisen` for pinches, `Msp.` for a knife tip, " +
      "an empty unit for 'to taste' items. `El` is rare in official recipes " +
      `(${off.unitCanonical.find((u) => u.key === "el")?.count ?? 0} rows vs ${mem.unitCanonical.find((u) => u.key === "el")?.count ?? 0} in member recipes): convert tablespoons to grams.`,
  );
  out.push(
    `3. **Unit spelling.** Official recipes write \`Tl\` and \`El\` in mixed case and \`Msp.\` with a dot: ${top(j.units.spoonAndPinchCasing.official, 8)}. ` +
      `Pinch: \`Prise\` for 1 and \`Prisen\` for more (${top(j.units.priseVsPrisen.official, 4)}).`,
  );
  out.push(
    "4. **Amount field.** A bare number; fractions as unicode (`½`, `¼`, `1 ½`), never decimals for spoons. " +
      "Amount styles in official rows: " +
      j.units.amountStyle.official.map((s) => `${s.key} ${pct(s.share)}`).join(", ") +
      ". No ranges, no units inside the amount field.",
  );
  out.push(
    `5. **Rounding grid for grams** (official, share of amounts on the grid; inferred grid where ≥90% sit on it):`,
  );
  out.push("");
  out.push(
    table(
      [
        "band (g)",
        "n",
        "on 5",
        "on 10",
        "on 25",
        "on 50",
        "grid 90%",
        "grid 80%",
        "last digit 0 / 5 / other",
      ],
      gridOff.grams.bands.map((b) => [
        b.band,
        b.n,
        pct(b.multipleOf["5"]),
        pct(b.multipleOf["10"]),
        pct(b.multipleOf["25"]),
        pct(b.multipleOf["50"]),
        b.inferredGrid90 ?? "–",
        b.inferredGrid80 ?? "–",
        `${pct(b.lastDigit["0"])} / ${pct(b.lastDigit["5"])} / ${pct(1 - (b.lastDigit["0"] ?? 0) - (b.lastDigit["5"] ?? 0))}`,
      ]),
    ),
  );
  out.push("");
  out.push(
    "   Member recipes for comparison: " +
      gridMem.grams.bands
        .map((b) => `${b.band}: grid ${b.inferredGrid90 ?? "–"} (on 5: ${pct(b.multipleOf["5"])})`)
        .join("; ") +
      ".",
  );
  out.push("");
  out.push(
    `   Typical official Tl values: ${top(gridOff.valuesTL, 8)}. El: ${top(gridOff.valuesEL, 6)}. ` +
      `Prise(n): ${top(gridOff.valuesPrise, 5)}. Stück: ${top(gridOff.valuesStueck, 8)}.`,
  );
  out.push(
    `6. **Names.** Catalog spelling, singular or plural as the catalog has it, qualifiers in parentheses ` +
      `(${pct(spellOff.withParenthesesShare)} of official names) or after a comma (${pct(spellOff.withCommaQualifierShare)}). ` +
      `Common parenthetical qualifiers: ${top(spellOff.topParentheses, 12)}. Comma qualifiers: ${top(spellOff.topCommaQualifiers, 8)}. ` +
      `Prefer a name that maps to a catalog id: ${pct(j.ingredients.catalogCoverage.bySource.official)} of official rows carry one ` +
      `(member ${pct(j.ingredients.catalogCoverage.bySource.member)}). Ids and names map one to one ` +
      `(${j.ingredients.catalogCoverage.idsWithSeveralSpellings} ids with several spellings, ${j.ingredients.catalogCoverage.namesWithSeveralIds} names with several ids), ` +
      `and ${pct(j.ingredients.catalogCoverage.minusOneWithCatalogName)} of unlinked rows (id -1) still use a catalog name verbatim. ` +
      `Catalog names for counted items are plural and stay plural for a count of 1: ${top(spellOff.stueckAmountUpTo1, 6)}.`,
  );
  out.push(
    `7. **Groups.** ${pct(grpOff.recipesWithoutGroups)} of official recipes use no group at all; when grouped, ` +
      `names are upper case (${pct(grpOff.allCapsShare)}) in the patterns ${grpOff.patterns.map((p) => `${p.key} ${pct(p.share)}`).join(", ")}. ` +
      `Most frequent: ${grpOff.normalized
        .slice(0, 10)
        .map((g) => `${g.key} (${g.count})`)
        .join(", ")}. Equipment (jars, moulds) goes in ZUBEHÖR, extras for serving in AUSSERDEM.`,
  );
  out.push(
    `8. **Optional and to-taste items.** Official recipes leave the amount empty for to-taste items ` +
      `(${pct(optOff.emptyAmountShare)} of rows, member ${pct(optMem.emptyAmountShare)}); most often ${top(optOff.topEmptyAmountNames, 8)}. ` +
      `An explicit optional marker is rare (${pct(optOff.optionalMarkerShare)} official, ${pct(optMem.optionalMarkerShare)} member; ` +
      `location: ${top(optOff.markerLocation, 3)}). The official pattern is a purpose suffix in the name with an empty amount: ` +
      `${top(optOff.purposeSuffixes, 6)}; ${pct(optOff.purposeSuffixWithEmptyAmount)} of official "zum ..." rows have no amount. ` +
      `Free-text amounts such as "n. B." are a member habit: ${top(optMem.topFreeTextAmounts, 6)}.`,
  );
  out.push(
    `9. **Bowl mass sanity.** Median total of g + ml per recipe is ${fmt(massAll?.measured?.p50, 0)} g ` +
      `(p90 ${fmt(massAll?.measured?.p90, 0)} g). ${pct(massAll?.over2500)} of recipes exceed 2500 g and ${pct(massAll?.over3000)} exceed 3000 g ` +
      `(with piece estimates: ${pct(massAll?.over2500WithEstimates)} / ${pct(massAll?.over3000WithEstimates)}). ` +
      `The estimated bowl peak from the step walk exceeds 2500 g in ${pct(massAll?.bowlPeakOver2500)} and 3000 g in ${pct(massAll?.bowlPeakOver3000)} of recipes. ` +
      "Totals above the bowl limit are fine when part of the list never enters the bowl (steamer, topping, side).",
  );
  out.push("");

  out.push("## Unit mapping for free-text input");
  out.push("");
  out.push(
    "How official recipes write ingredients that member recipes give in a household unit, and grams per unit where " +
      'the corpus states a weight ("1 Zwiebel (80 g)", scale step weights, "(à 170 g)" in names).',
  );
  out.push("");
  out.push(
    table(
      [
        "unit",
        "official uses",
        "member uses",
        "member uses with official counterpart",
        "official target for the same ingredients",
        "g/unit p50 (n)",
      ],
      j.mapping.map((m) => [
        m.concept,
        m.officialUnitUses,
        m.memberUnitUses,
        pct(m.memberUsesWithOfficialCounterpart),
        m.officialTargetForMemberUses
          .slice(0, 3)
          .map((t) => `${t.key} ${pct(t.share)}`)
          .join(", "),
        m.gramsPerUnitAllObservations
          ? `${m.gramsPerUnitAllObservations.p50} (${m.gramsPerUnitAllObservations.n})`
          : "–",
      ]),
    ),
  );
  out.push("");
  out.push(
    "Where official recipes put the household unit into the name instead of the unit field:",
  );
  out.push("");
  out.push(
    table(
      ["unit", "official rows", "unit field used", "example names"],
      j.mapping
        .filter((m) => m.officialNameUses > 0)
        .map((m) => [
          m.concept,
          m.officialNameUses,
          top(m.officialNameUnits, 3),
          Object.keys(m.officialNameExamples).slice(0, 4).join("; "),
        ]),
    ),
  );
  out.push("");
  out.push("Gram equivalents per ingredient (median, at least 3 observations):");
  out.push("");
  out.push(
    table(
      ["ingredient", "unit", "g per unit", "n", "p10-p90"],
      j.pieceWeights
        .filter((p) => p.n >= 3)
        .slice(0, 40)
        .map((p) => [
          p.name,
          p.concept,
          p.gramsPerUnit,
          p.n,
          p.spread ? `${p.spread.p10}-${p.spread.p90}` : "–",
        ]),
    ),
  );
  out.push("");

  out.push("## Most frequent ingredients");
  out.push("");
  out.push(
    `${j.ingredients.distinctNames} distinct names; ${j.ingredients.topWithIdCount} of the top 150 carry a catalog id. ` +
      "Per-serving amounts are in the usual unit (g for gram-weighed items) over recipes whose servings are portions.",
  );
  out.push("");
  out.push(
    table(
      ["name", "recipes", "usual unit", "g share", "per portion p25 / p50 / p75", "catalog id"],
      j.ingredients.top
        .slice(0, 60)
        .map((t) => [
          t.name,
          t.recipes,
          t.usualUnit,
          pct(t.gramsShare),
          t.perServingPortionen
            ? `${t.perServingPortionen.p25} / ${t.perServingPortionen.p50} / ${t.perServingPortionen.p75}`
            : "–",
          t.systemIngredientId !== null ? "yes" : "no",
        ]),
    ),
  );
  out.push("");
  out.push("(The full 150 with quantiles are in ingredients.json.)");
  out.push("");

  out.push("## Servings by category");
  out.push("");
  out.push(
    table(
      ["category", "recipes", "units", "top amount + unit", "Portionen p50"],
      j.servings
        .slice(0, 26)
        .map((s) => [
          s.category,
          s.recipes,
          top(s.units, 3),
          top(s.topPairs, 3),
          fmt(s.portionenAmount?.p50, 0),
        ]),
    ),
  );
  out.push("");

  out.push("## Total mass per recipe by category (g + ml)");
  out.push("");
  out.push(
    table(
      ["category", "recipes", "p10", "p50", "p90", ">2500 g", ">3000 g", "bowl peak p90"],
      j.mass.byCategory.map((m) => [
        m.category,
        m.recipes,
        fmt(m.measured?.p10, 0),
        fmt(m.measured?.p50, 0),
        fmt(m.measured?.p90, 0),
        pct(m.over2500),
        pct(m.over3000),
        fmt(m.bowlPeak?.p90, 0),
      ]),
    ),
  );
  out.push("");

  out.push("## Nutrients per serving by category");
  out.push("");
  out.push(
    table(
      [
        "category",
        "with values",
        "kcal p25/p50/p75",
        "carb p50",
        "fat p50",
        "protein p50",
        "kcal/Atwater p50",
      ],
      j.nutrients.byCategory.map((n) => [
        n.category,
        `${n.withNutrients}/${n.recipes}`,
        n.kcal ? `${n.kcal.p25}/${n.kcal.p50}/${n.kcal.p75}` : "–",
        fmt(n.carb?.p50, 0),
        fmt(n.fat?.p50, 0),
        fmt(n.protein?.p50, 0),
        fmt(n.kcalToAtwater?.p50, 2),
      ]),
    ),
  );
  out.push("");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main

export function analyze(recipes: readonly NormalizedRecipe[], steps: readonly StepLite[]) {
  const rows = buildRows(recipes);
  const pieces = pieceWeights(rows, steps);
  const ratios = crossRecipeRatios(rows);
  const mapping = unitMapping(rows, pieces, ratios);

  const byKey = new Map<string, number>();
  for (const p of pieces.table) if (p.n >= 2) byKey.set(`${p.key}|${p.concept}`, p.gramsPerUnit);
  // Cross-recipe ratios only for counted items: for spoons they mix unrelated uses
  // (sugar in g for baking, in Tl for seasoning) and give nonsense.
  for (const r of ratios) {
    const k = `${r.key}|${r.concept}`;
    if (r.concept === "Stück" && !byKey.has(k)) byKey.set(k, r.gramsPerUnit);
  }
  const byConcept = new Map<string, number>();
  for (const m of mapping) {
    const v = m.gramsPerUnitAllObservations?.p50;
    if (v !== undefined) byConcept.set(m.concept, v);
  }
  // Defaults where the corpus states no weight: a level spoon or pinch of a typical spice.
  if (!byConcept.has("Prise")) byConcept.set("Prise", 0.5);
  if (!byConcept.has("Msp")) byConcept.set("Msp", 0.3);

  const peak = new Map<number, number>();
  const steam = new Set<number>();
  for (const s of steps) {
    peak.set(s.recipeId, Math.max(peak.get(s.recipeId) ?? 0, s.cumulativeGramsBefore));
    if (s.mode === "steaming") steam.add(s.recipeId);
  }

  return {
    meta: {
      generated: new Date().toISOString(),
      recipes: recipes.length,
      official: recipes.filter((r) => sourceOf(r) === "official").length,
      member: recipes.filter((r) => sourceOf(r) === "member").length,
      ingredients: rows.length,
      equipmentRows: rows.filter((r) => r.equipment).length,
    },
    units: unitVocabulary(rows),
    ingredients: topIngredients(rows, 150),
    groups: groupNames(rows, recipes),
    servings: servingsByCategory(recipes),
    mass: massByCategory(recipes, { byKey, byConcept }, peak, steam),
    nutrients: nutrientsByCategory(recipes),
    optional: optionalIngredients(rows, recipes),
    mapping,
    pieceWeights: pieces.table,
    pieceWeightObservations: { kept: pieces.observations, droppedImplausible: pieces.dropped },
    crossRecipeRatios: ratios.slice(0, 80),
    rounding: roundingGrid(rows),
    spelling: nameSpelling(rows),
  };
}

export function run(corpusDir: string): Json {
  const started = Date.now();
  const derived = path.join(corpusDir, "derived");
  const recipes = readJsonl<NormalizedRecipe>(path.join(derived, "recipes.jsonl"));
  const steps = readJsonl<StepLite>(path.join(derived, "steps.jsonl"));
  const result = analyze(recipes, steps);
  mkdirSync(derived, { recursive: true });
  writeFileSync(path.join(derived, "ingredients.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(path.join(derived, "ingredients.md"), renderMarkdown(result));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `corpus:analyze-ingredients: ${recipes.length} recipes, ${result.meta.ingredients} ingredient rows ` +
      `-> ${derived}${path.sep}ingredients.{json,md} (${seconds}s)`,
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
