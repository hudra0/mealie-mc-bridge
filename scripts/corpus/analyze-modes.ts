// Corpus analysis: device modes and their parameters.
//
// Input:  $CORPUS_DIR/derived/steps.jsonl and recipes.jsonl (written by normalize.ts)
// Output: $CORPUS_DIR/derived/modes.json  full numbers
//         $CORPUS_DIR/derived/modes.md    readable report
//
// Only aggregated numbers and recipe ids go into the outputs, never step text.
// Official recipes are the reference; member recipes are reported next to them.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedRecipe, NormalizedStep } from "./types.js";

// ---------------------------------------------------------------------------
// Assumed device rules, checked against the corpus. Keep in one place.

export const ASSUMED_LIMITS = {
  /** Highest speed allowed while heating or in reverse. */
  maxSpeedWithHeatOrReverse: 3,
  maxTemperature: 130,
  minHeatedTemperature: 37,
  temperatureStep: 5,
  minSpeed: 1,
  maxSpeed: 10,
} as const;

export const TEMP_BANDS = [
  { name: "0", min: 0, max: 0 },
  { name: "37-60", min: 1, max: 60 },
  { name: "65-95", min: 61, max: 95 },
  { name: "100", min: 96, max: 100 },
  { name: "105-130", min: 101, max: 10_000 },
] as const;

export const KNEADING_MODES = [
  "kneading",
  "kneading_solid_dough",
  "kneading_soft_dough",
  "kneading_liquid_dough",
] as const;

export const OTHER_MODES = [
  "steaming",
  "puree",
  "smoothie",
  "turbo",
  "slow_cooking",
  "sous_vide",
  "fermentation",
  "rice_cooking",
  "cooking_eggs",
  "scale",
  "precleaning",
  "food_processor",
  "ramp",
] as const;

type Group = "all" | "official" | "member";

// ---------------------------------------------------------------------------
// Small statistics helpers.

export interface Quantiles {
  n: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
}

/** Linear interpolation between closest ranks (the common "type 7" definition). */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return round(a + (b - a) * (pos - lo));
}

export function quantiles(values: readonly (number | null | undefined)[]): Quantiles {
  const v = values.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  const sum = v.reduce((s, x) => s + x, 0);
  return {
    n: v.length,
    min: v.length ? (v[0] ?? null) : null,
    p10: quantile(v, 0.1),
    p25: quantile(v, 0.25),
    p50: quantile(v, 0.5),
    p75: quantile(v, 0.75),
    p90: quantile(v, 0.9),
    max: v.length ? (v[v.length - 1] ?? null) : null,
    mean: v.length ? round(sum / v.length) : null,
  };
}

export function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function share(part: number, whole: number): number {
  return whole === 0 ? 0 : round(part / whole, 4);
}

/** Value counts, sorted by numeric key when all keys are numeric, else by count. */
export function counts(
  values: readonly (string | number | boolean | null)[],
): Record<string, number> {
  const m = new Map<string, number>();
  for (const v of values) {
    const k = v === null ? "null" : String(v);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const entries = [...m.entries()];
  const numeric = entries.every(([k]) => k !== "" && !Number.isNaN(Number(k)));
  entries.sort(numeric ? (a, b) => Number(a[0]) - Number(b[0]) : (a, b) => b[1] - a[1]);
  return Object.fromEntries(entries);
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

function distinct(steps: readonly NormalizedStep[]): number {
  return new Set(steps.map((s) => s.recipeId)).size;
}

export function tempBand(t: number | null): string | null {
  if (t === null) return null;
  return TEMP_BANDS.find((b) => t >= b.min && t <= b.max)?.name ?? null;
}

export function isOnTemperatureGrid(t: number): boolean {
  if (t === 0 || t === ASSUMED_LIMITS.minHeatedTemperature) return true;
  return t >= 40 && t <= ASSUMED_LIMITS.maxTemperature && t % ASSUMED_LIMITS.temperatureStep === 0;
}

/** Relative position of a step in its recipe: first, middle or last third. */
export function positionThird(stepIndex: number, stepCount: number): "first" | "middle" | "last" {
  if (stepCount <= 1) return "first";
  const rel = stepIndex / (stepCount - 1);
  if (rel < 1 / 3) return "first";
  if (rel <= 2 / 3) return "middle";
  return "last";
}

function inGroup(source: string | null, g: Group): boolean {
  return g === "all" || source === g;
}

function perGroup<T>(
  steps: readonly NormalizedStep[],
  f: (s: NormalizedStep[]) => T,
): Record<Group, T> {
  return {
    all: f(steps.filter((s) => inGroup(s.source, "all"))),
    official: f(steps.filter((s) => inGroup(s.source, "official"))),
    member: f(steps.filter((s) => inGroup(s.source, "member"))),
  };
}

// ---------------------------------------------------------------------------
// Sections.

interface Ctx {
  steps: NormalizedStep[];
  recipes: NormalizedRecipe[];
  recipeCount: Record<Group, number>;
}

function modeFrequency(ctx: Ctx) {
  const machine = ctx.steps.filter((s) => s.kind === "machine");
  const freq = (g: Group) => {
    const ss = machine.filter((s) => inGroup(s.source, g));
    const byMode = groupBy(ss, (s) => s.mode);
    const nonScale = ss.filter((s) => s.mode !== "scale").length;
    return Object.fromEntries(
      [...byMode.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([mode, arr]) => [
          mode,
          {
            steps: arr.length,
            recipes: distinct(arr),
            shareOfMachineSteps: share(arr.length, ss.length),
            shareOfNonScaleMachineSteps: mode === "scale" ? null : share(arr.length, nonScale),
            shareOfRecipes: share(distinct(arr), ctx.recipeCount[g]),
          },
        ]),
    );
  };
  const overall = { all: freq("all"), official: freq("official"), member: freq("member") };

  const kneadingAny = perGroup(machine, (ss) => {
    const arr = ss.filter((s) => (KNEADING_MODES as readonly string[]).includes(s.mode));
    return { steps: arr.length, recipes: distinct(arr) };
  });

  // By category: share of the category's recipes that use each mode, and step counts.
  const catName = new Map<number, string>();
  for (const r of ctx.recipes)
    for (const c of r.categories) catName.set(c.id, c.name ?? String(c.id));
  const byCategory: Record<
    string,
    {
      recipes: number;
      officialRecipes: number;
      modes: Record<string, { steps: number; recipes: number; shareOfRecipes: number }>;
    }
  > = {};
  for (const [id, name] of catName) {
    const recs = ctx.recipes.filter((r) => r.categories.some((c) => c.id === id));
    const ss = machine.filter((s) => s.categories.includes(id));
    const byMode = groupBy(ss, (s) => s.mode);
    byCategory[name] = {
      recipes: recs.length,
      officialRecipes: recs.filter((r) => r.source === "official").length,
      modes: Object.fromEntries(
        [...byMode.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([mode, arr]) => [
            mode,
            {
              steps: arr.length,
              recipes: distinct(arr),
              shareOfRecipes: share(distinct(arr), recs.length),
            },
          ]),
      ),
    };
  }
  const sortedCategories = Object.fromEntries(
    Object.entries(byCategory).sort((a, b) => b[1].recipes - a[1].recipes),
  );
  return {
    textSteps: perGroup(ctx.steps, (ss) => ss.filter((s) => s.kind === "text").length),
    machineSteps: perGroup(machine, (ss) => ss.length),
    overall,
    kneadingAny,
    byCategory: sortedCategories,
  };
}

function customizedSection(ctx: Ctx) {
  const cust = ctx.steps.filter((s) => s.mode === "customized");
  const analyze = (ss: NormalizedStep[]) => {
    const temps = ss.map((s) => s.temperature);
    const zero = ss.filter((s) => s.temperature === 0);
    const heated = ss.filter((s) => (s.temperature ?? 0) > 0);
    const reverseBy = (key: (s: NormalizedStep) => string | null) =>
      Object.fromEntries(
        [...groupBy(ss, (s) => key(s) ?? "null").entries()]
          .sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))
          .map(([k, arr]) => {
            const rev = arr.filter((s) => s.reverse).length;
            return [k, { n: arr.length, reverse: rev, share: share(rev, arr.length) }];
          }),
      );
    const timeBy = (key: (s: NormalizedStep) => string | null) =>
      Object.fromEntries(
        [...groupBy(ss, (s) => key(s) ?? "null").entries()]
          .sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))
          .map(([k, arr]) => [k, quantiles(arr.map((s) => s.timeSeconds))]),
      );
    const bandOrder = TEMP_BANDS.map((b) => b.name as string);
    const sortBands = <T>(o: Record<string, T>) =>
      Object.fromEntries(
        Object.entries(o).sort((a, b) => bandOrder.indexOf(a[0]) - bandOrder.indexOf(b[0])),
      );

    const joint = [...groupBy(ss, (s) => `${s.temperature}|${s.speed}|${s.reverse}`).entries()]
      .map(([k, arr]) => {
        const [t, sp, rev] = k.split("|");
        const q = quantiles(arr.map((s) => s.timeSeconds));
        return {
          temperature: t === "null" ? null : Number(t),
          speed: sp === "null" ? null : Number(sp),
          reverse: rev === "true",
          steps: arr.length,
          recipes: distinct(arr),
          timeP25: q.p25,
          timeMedian: q.p50,
          timeP75: q.p75,
        };
      })
      .sort(
        (a, b) =>
          (a.temperature ?? -1) - (b.temperature ?? -1) ||
          (a.speed ?? -1) - (b.speed ?? -1) ||
          Number(a.reverse) - Number(b.reverse),
      );

    const ref = (s: NormalizedStep) => ({
      recipeId: s.recipeId,
      stepIndex: s.stepIndex,
      source: s.source,
      temperature: s.temperature,
      speed: s.speed,
      reverse: s.reverse,
      timeSeconds: s.timeSeconds,
    });
    const L = ASSUMED_LIMITS;
    const rule = (name: string, pred: (s: NormalizedStep) => boolean) => {
      const hits = ss.filter(pred);
      return {
        rule: name,
        steps: hits.length,
        recipes: distinct(hits),
        shareOfCustomizedSteps: share(hits.length, ss.length),
        byValue: counts(hits.map((s) => `${s.temperature}C/speed ${s.speed}/rev ${s.reverse}`)),
        examples: hits.slice(0, 15).map(ref),
      };
    };
    const violations = [
      rule(
        `speed > ${L.maxSpeedWithHeatOrReverse} while heated (temperature > 0)`,
        (s) => (s.temperature ?? 0) > 0 && (s.speed ?? 0) > L.maxSpeedWithHeatOrReverse,
      ),
      rule(
        `speed > ${L.maxSpeedWithHeatOrReverse} with reverse`,
        (s) => s.reverse && (s.speed ?? 0) > L.maxSpeedWithHeatOrReverse,
      ),
      rule(`temperature > ${L.maxTemperature}`, (s) => (s.temperature ?? 0) > L.maxTemperature),
      rule(
        "temperature off the grid (0, 37, 40-130 in steps of 5)",
        (s) => s.temperature !== null && !isOnTemperatureGrid(s.temperature),
      ),
      rule("speed 0", (s) => s.speed === 0),
      rule("speed null", (s) => s.speed === null),
      rule(`speed > ${L.maxSpeed}`, (s) => (s.speed ?? 0) > L.maxSpeed),
      rule("time null or 0", (s) => !s.timeSeconds),
      rule("turbo flag set", (s) => s.turbo),
      rule("more than one settings phase", (s) => (s.modeSetting?.settings.length ?? 0) > 1),
    ];

    // Where heat and higher speeds meet: which temperatures are combined with which top speed.
    const maxSpeedByTemperature = Object.fromEntries(
      [...groupBy(heated, (s) => String(s.temperature)).entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([t, arr]) => [
          t,
          {
            n: arr.length,
            maxSpeed: Math.max(...arr.map((s) => s.speed ?? 0)),
            speeds: counts(arr.map((s) => s.speed)),
          },
        ]),
    );

    return {
      steps: ss.length,
      recipes: distinct(ss),
      temperatureHistogram: counts(temps),
      shareTemperature0: share(zero.length, ss.length),
      temperatureBands: sortBands(counts(ss.map((s) => tempBand(s.temperature)))),
      speedDistribution: {
        temperature0: counts(zero.map((s) => s.speed)),
        heated: counts(heated.map((s) => s.speed)),
      },
      maxSpeedByTemperature,
      reverseShare: {
        overall: share(ss.filter((s) => s.reverse).length, ss.length),
        byTemperatureBand: sortBands(reverseBy((s) => tempBand(s.temperature))),
        bySpeed: reverseBy((s) => (s.speed === null ? null : String(s.speed))),
      },
      timeQuantiles: {
        overall: quantiles(ss.map((s) => s.timeSeconds)),
        byTemperatureBand: sortBands(timeBy((s) => tempBand(s.temperature))),
        bySpeed: timeBy((s) => (s.speed === null ? null : String(s.speed))),
        byTemperatureBandAndReverse: Object.fromEntries(
          TEMP_BANDS.flatMap((b) =>
            [false, true].map((rev) => [
              `${b.name}|rev ${rev}`,
              quantiles(
                ss
                  .filter((s) => tempBand(s.temperature) === b.name && s.reverse === rev)
                  .map((s) => s.timeSeconds),
              ),
            ]),
          ),
        ),
      },
      timeHistogram: counts(ss.map((s) => s.timeSeconds)),
      joint,
      violations,
    };
  };
  return perGroup(cust, analyze);
}

/** Generic parameter summary for any program mode. */
function modeParams(ss: NormalizedStep[]) {
  const phases = ss.map((s) => s.modeSetting?.settings.length ?? 0);
  return {
    steps: ss.length,
    recipes: distinct(ss),
    temperature: quantiles(ss.map((s) => s.temperature)),
    temperatureValues: counts(ss.map((s) => s.temperature)),
    timeSeconds: quantiles(ss.map((s) => s.timeSeconds)),
    timeValues: counts(ss.map((s) => s.timeSeconds)),
    speedValues: counts(ss.map((s) => s.speed)),
    weight: quantiles(ss.map((s) => s.weight)),
    reverseShare: share(ss.filter((s) => s.reverse).length, ss.length),
    turboShare: share(ss.filter((s) => s.turbo).length, ss.length),
    phases: counts(phases),
    size: counts(ss.map((s) => s.modeSetting?.size ?? null)),
    texture: counts(ss.map((s) => s.modeSetting?.texture ?? null)),
    sizeTexture: counts(
      ss.map((s) => `${s.modeSetting?.size ?? "null"}/${s.modeSetting?.texture ?? "null"}`),
    ),
    cleaningMode: counts(ss.map((s) => s.modeSetting?.cleaningMode ?? null)),
  };
}

function rampDetail(ss: NormalizedStep[]) {
  const seq = (s: NormalizedStep) =>
    (s.modeSetting?.settings ?? [])
      .map((p) => `${p.temperature ?? "-"}C/s${p.speed ?? "-"}/${p.time ?? "-"}s`)
      .join(" > ");
  const speedPath = (s: NormalizedStep) =>
    (s.modeSetting?.settings ?? []).map((p) => p.speed ?? "-").join(">");
  return {
    phaseSequences: counts(ss.map(seq)),
    speedPaths: counts(ss.map(speedPath)),
    phaseTimeSeconds: quantiles(
      ss.flatMap((s) => (s.modeSetting?.settings ?? []).map((p) => p.time)),
    ),
    phaseTemperatures: counts(
      ss.flatMap((s) => (s.modeSetting?.settings ?? []).map((p) => p.temperature)),
    ),
  };
}

function scaleDetail(ss: NormalizedStep[]) {
  const buckets = [5, 10, 20, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, Infinity];
  const label = (w: number) => {
    const i = buckets.findIndex((b) => w <= b);
    const hi = buckets[i] ?? Infinity;
    const lo = i > 0 ? (buckets[i - 1] ?? 0) : 0;
    return hi === Infinity ? `>${lo}` : `${lo === 0 ? 0 : lo + 1}-${hi}`;
  };
  const ordered = buckets.map((b, i) => {
    const lo = i > 0 ? (buckets[i - 1] ?? 0) : 0;
    return b === Infinity ? `>${lo}` : `${lo === 0 ? 0 : lo + 1}-${b}`;
  });
  const c = counts(ss.map((s) => (s.weight === null ? "null" : label(s.weight))));
  const weightBuckets = Object.fromEntries(
    [...ordered, "null"].filter((k) => c[k] !== undefined).map((k) => [k, c[k] ?? 0]),
  );
  const perRecipe = [...groupBy(ss, (s) => String(s.recipeId)).values()].map((a) => a.length);
  return {
    weightBuckets,
    weightZero: ss.filter((s) => s.weight === 0).length,
    weightOver3000: ss.filter((s) => (s.weight ?? 0) > 3000).length,
    scaleStepsPerRecipe: quantiles(perRecipe),
    topWeights: Object.fromEntries(
      Object.entries(counts(ss.map((s) => s.weight)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20),
    ),
  };
}

function programModes(ctx: Ctx) {
  const machine = ctx.steps.filter((s) => s.kind === "machine");
  const byMode = (mode: string) => machine.filter((s) => s.mode === mode);
  const roasting = perGroup(byMode("roasting"), (ss) => ({
    ...modeParams(ss),
    timeByTemperature: Object.fromEntries(
      [...groupBy(ss, (s) => String(s.temperature)).entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([t, arr]) => [t, quantiles(arr.map((s) => s.timeSeconds))]),
    ),
  }));
  const kneading = Object.fromEntries(
    [...KNEADING_MODES].map((m) => [m, perGroup(byMode(m), modeParams)]),
  );
  kneading.any = perGroup(
    machine.filter((s) => (KNEADING_MODES as readonly string[]).includes(s.mode)),
    modeParams,
  );
  const others = Object.fromEntries(
    [...OTHER_MODES].map((m) => [m, perGroup(byMode(m), modeParams)]),
  );
  const known = new Set<string>(["customized", "roasting", ...KNEADING_MODES, ...OTHER_MODES]);
  const unknownModes = counts(machine.filter((s) => !known.has(s.mode)).map((s) => s.mode));
  return {
    roasting,
    kneading,
    others,
    ramp: perGroup(byMode("ramp"), rampDetail),
    scale: perGroup(byMode("scale"), (ss) => ({ ...modeParams(ss), ...scaleDetail(ss) })),
    unknownModes,
  };
}

function placement(ctx: Ctx) {
  const machine = ctx.steps.filter((s) => s.kind === "machine");
  // Ordinal among non-scale machine steps, per recipe.
  const ordinal = new Map<NormalizedStep, { i: number; n: number }>();
  for (const arr of groupBy(
    machine.filter((s) => s.mode !== "scale"),
    (s) => String(s.recipeId),
  ).values()) {
    arr.sort((a, b) => a.stepIndex - b.stepIndex);
    arr.forEach((s, i) => ordinal.set(s, { i, n: arr.length }));
  }
  const analyze = (ss: NormalizedStep[]) =>
    Object.fromEntries(
      [...groupBy(ss, (s) => s.mode).entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([mode, arr]) => {
          const perRecipe = [...groupBy(arr, (s) => String(s.recipeId)).values()].map(
            (a) => a.length,
          );
          const third = counts(arr.map((s) => positionThird(s.stepIndex, s.stepCount)));
          const ord = arr.map((s) => ordinal.get(s)).filter((o) => o !== undefined);
          const ordinalRole = counts(
            ord.map((o) =>
              o.n === 1
                ? "only"
                : o.i === 0
                  ? "firstMachine"
                  : o.i === o.n - 1
                    ? "lastMachine"
                    : "between",
            ),
          );
          return [
            mode,
            {
              steps: arr.length,
              recipes: perRecipe.length,
              usesPerRecipe: quantiles(perRecipe),
              usesPerRecipeHistogram: counts(perRecipe.map((n) => (n >= 5 ? "5+" : String(n)))),
              positionThird: {
                first: share(third.first ?? 0, arr.length),
                middle: share(third.middle ?? 0, arr.length),
                last: share(third.last ?? 0, arr.length),
              },
              relativePosition: quantiles(
                arr.map((s) => (s.stepCount > 1 ? round(s.stepIndex / (s.stepCount - 1), 3) : 0)),
              ),
              roleAmongNonScaleMachineSteps: mode === "scale" ? null : ordinalRole,
            },
          ];
        }),
    );
  const machineCountPerRecipe = perGroup(machine, (ss) => {
    const per = [
      ...groupBy(
        ss.filter((s) => s.mode !== "scale"),
        (s) => String(s.recipeId),
      ).values(),
    ];
    return {
      nonScaleMachineSteps: quantiles(per.map((a) => a.length)),
      distinctModes: quantiles(per.map((a) => new Set(a.map((s) => s.mode)).size)),
    };
  });
  // Typical mode transitions between consecutive non-scale machine steps.
  const transitions = perGroup(machine, (ss) => {
    const keys: string[] = [];
    for (const arr of groupBy(
      ss.filter((s) => s.mode !== "scale"),
      (s) => String(s.recipeId),
    ).values()) {
      arr.sort((a, b) => a.stepIndex - b.stepIndex);
      for (let i = 1; i < arr.length; i++) {
        const a = arr[i - 1];
        const b = arr[i];
        if (a && b) keys.push(`${programLabel(a)} -> ${programLabel(b)}`);
      }
    }
    return Object.fromEntries(
      Object.entries(counts(keys))
        .sort((x, y) => y[1] - x[1])
        .slice(0, 40),
    );
  });
  return { perMode: perGroup(machine, analyze), machineCountPerRecipe, transitions };
}

// ---------------------------------------------------------------------------
// Canonical programs.

/**
 * Heuristic functional label for a machine step. The thresholds describe what the
 * parameters do mechanically; they are a reading aid, not a device rule.
 */
export function programLabel(
  s: Pick<NormalizedStep, "mode" | "temperature" | "speed" | "reverse" | "timeSeconds">,
): string {
  if (s.mode !== "customized") {
    if ((KNEADING_MODES as readonly string[]).includes(s.mode)) return "knead";
    return s.mode;
  }
  const t = s.temperature ?? 0;
  const sp = s.speed ?? 0;
  const time = s.timeSeconds ?? 0;
  if (t === 0) {
    if (sp >= 7 && time >= 30) return "blend/puree (cold)";
    if (sp >= 5 && time <= 30) return "chop (cold)";
    if (sp >= 5) return "blend (cold)";
    if (s.reverse) return "fold/stir in (cold, reverse)";
    if (sp >= 3) return "mix (cold)";
    return "stir (cold)";
  }
  if (t <= 60) return sp <= 3 ? "warm/dissolve (37-60)" : "warm+blend (37-60)";
  if (t <= 95)
    return sp <= 3
      ? s.reverse
        ? "heat gently, reverse (65-95)"
        : "heat/thicken (65-95)"
      : "heat+blend (65-95)";
  if (t <= 100)
    return s.reverse ? "simmer, reverse (100)" : sp <= 3 ? "cook/simmer (100)" : "cook+blend (100)";
  return s.reverse ? "saute, reverse (105-130)" : "saute/steam off (105-130)";
}

function programKey(s: NormalizedStep, withTime: boolean): string {
  const parts = [s.mode, `${s.temperature ?? "-"}C`];
  if (s.speed !== null) parts.push(`speed ${s.speed}`);
  if (s.reverse) parts.push("reverse");
  if (s.mode === "cooking_eggs")
    parts.push(`${s.modeSetting?.size ?? "-"}/${s.modeSetting?.texture ?? "-"}`);
  if (s.mode === "precleaning") parts.push(s.modeSetting?.cleaningMode ?? "-");
  if (withTime) parts.push(`${s.timeSeconds ?? "-"}s`);
  return parts.join(" | ");
}

function programs(ctx: Ctx) {
  const ss = ctx.steps.filter((s) => s.kind === "machine" && s.mode !== "scale");
  const build = (withTime: boolean, limit: number) =>
    [...groupBy(ss, (s) => programKey(s, withTime)).entries()]
      .map(([key, arr]) => {
        const off = arr.filter((s) => s.source === "official");
        const mem = arr.filter((s) => s.source === "member");
        const first = arr[0];
        const t = quantiles(arr.map((s) => s.timeSeconds));
        const tOff = quantiles(off.map((s) => s.timeSeconds));
        return {
          key,
          label: first
            ? programLabel({ ...first, timeSeconds: withTime ? first.timeSeconds : t.p50 })
            : "",
          steps: arr.length,
          recipes: distinct(arr),
          shareOfRecipes: share(distinct(arr), ctx.recipeCount.all),
          officialSteps: off.length,
          officialRecipes: distinct(off),
          shareOfOfficialRecipes: share(distinct(off), ctx.recipeCount.official),
          memberSteps: mem.length,
          memberRecipes: distinct(mem),
          shareOfMemberRecipes: share(distinct(mem), ctx.recipeCount.member),
          ...(withTime
            ? {}
            : {
                timeP25: t.p25,
                timeMedian: t.p50,
                timeP75: t.p75,
                officialTimeMedian: tOff.p50,
                topTimes: Object.fromEntries(
                  Object.entries(counts(arr.map((s) => s.timeSeconds)))
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5),
                ),
              }),
        };
      })
      .sort((a, b) => b.officialRecipes - a.officialRecipes || b.recipes - a.recipes)
      .slice(0, limit);
  const byLabel = Object.fromEntries(
    [...groupBy(ss, programLabel).entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([label, arr]) => [
        label,
        {
          steps: arr.length,
          recipes: distinct(arr),
          shareOfOfficialRecipes: share(
            distinct(arr.filter((s) => s.source === "official")),
            ctx.recipeCount.official,
          ),
          shareOfMemberRecipes: share(
            distinct(arr.filter((s) => s.source === "member")),
            ctx.recipeCount.member,
          ),
          time: quantiles(arr.map((s) => s.timeSeconds)),
        },
      ]),
  );
  return { exact: build(true, 200), families: build(false, 150), byLabel };
}

// ---------------------------------------------------------------------------
// Markdown rendering.

type Cell = string | number | null | undefined;

function fmt(v: Cell): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(round(v));
  return v.replace(/\|/g, "\\|");
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "–" : `${round(v * 100, 1)}%`;
}

function table(head: string[], rows: Cell[][]): string {
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of rows) lines.push(`| ${r.map(fmt).join(" | ")} |`);
  return lines.join("\n");
}

function qCells(q: Quantiles | undefined): Cell[] {
  if (!q) return ["–", "–", "–", "–", "–", "–"];
  return [q.n, q.p10, q.p25, q.p50, q.p75, q.p90];
}

const Q_HEAD = ["n", "p10", "p25", "p50", "p75", "p90"];

function inline(c: Record<string, number>, limit = 12): string {
  const e = Object.entries(c);
  const s = e
    .slice(0, limit)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  return e.length > limit ? `${s}, … (${e.length - limit} more)` : s;
}

function renderMarkdown(r: ReturnType<typeof analyze>): string {
  const out: string[] = [];
  const h = (level: number, t: string) => out.push(`\n${"#".repeat(level)} ${t}\n`);
  const p = (t: string) => out.push(t);

  out.push("# Corpus analysis: modes and parameters");
  p(
    `\nGenerated ${r.generatedAt} from ${r.input.steps} steps in ${r.input.recipes} recipes ` +
      `(official ${r.input.recipeCount.official}, member ${r.input.recipeCount.member}). ` +
      "Official recipes are the reference; member values are shown next to them. Times in seconds. " +
      "Quantiles use linear interpolation. Numbers only, no recipe text.",
  );

  // (a)
  h(2, "a. Mode frequency");
  const modes = Object.keys(r.frequency.overall.all);
  p(
    table(
      [
        "mode",
        "steps",
        "recipes",
        "% recipes",
        "official steps",
        "official % recipes",
        "member steps",
        "member % recipes",
        "% of non-scale machine steps (official)",
      ],
      modes.map((m) => {
        const a = r.frequency.overall.all[m];
        const o = r.frequency.overall.official[m];
        const mb = r.frequency.overall.member[m];
        return [
          m,
          a?.steps,
          a?.recipes,
          pct(a?.shareOfRecipes),
          o?.steps ?? 0,
          pct(o?.shareOfRecipes ?? 0),
          mb?.steps ?? 0,
          pct(mb?.shareOfRecipes ?? 0),
          pct(o?.shareOfNonScaleMachineSteps),
        ];
      }),
    ),
  );
  p(
    `\nText steps: official ${r.frequency.textSteps.official}, member ${r.frequency.textSteps.member}. ` +
      `Any kneading mode: official ${r.frequency.kneadingAny.official.recipes} recipes, member ${r.frequency.kneadingAny.member.recipes} recipes. ` +
      `Mode names not in the known list: ${inline(r.programModes.unknownModes) || "none"}.`,
  );

  h(3, "By category (share of the category's recipes using the mode, all sources)");
  const catModes = [
    "customized",
    "roasting",
    "turbo",
    "steaming",
    "kneading",
    "kneading_solid_dough",
    "kneading_soft_dough",
    "puree",
    "ramp",
    "smoothie",
  ];
  p(
    table(
      ["category", "recipes", "official", ...catModes],
      Object.entries(r.frequency.byCategory).map(([name, c]) => [
        name,
        c.recipes,
        c.officialRecipes,
        ...catModes.map((m) => (c.modes[m] ? pct(c.modes[m].shareOfRecipes) : "–")),
      ]),
    ),
  );

  // (b)
  h(2, "b. Manual mode (customized)");
  const co = r.customized.official;
  const cm = r.customized.member;
  p(
    `Steps: official ${co.steps} in ${co.recipes} recipes, member ${cm.steps} in ${cm.recipes} recipes. ` +
      `Share at 0 °C: official ${pct(co.shareTemperature0)}, member ${pct(cm.shareTemperature0)}. ` +
      `Reverse share: official ${pct(co.reverseShare.overall)}, member ${pct(cm.reverseShare.overall)}.`,
  );
  h(3, "Temperature histogram");
  const tempKeys = Object.keys(r.customized.all.temperatureHistogram);
  p(
    table(
      ["°C", "official", "member", "all"],
      tempKeys.map((k) => [
        k,
        co.temperatureHistogram[k] ?? 0,
        cm.temperatureHistogram[k] ?? 0,
        r.customized.all.temperatureHistogram[k] ?? 0,
      ]),
    ),
  );
  h(3, "Speed distribution: 0 °C vs heated");
  const speeds = Object.keys(r.customized.all.speedDistribution.temperature0)
    .concat(Object.keys(r.customized.all.speedDistribution.heated))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => Number(a) - Number(b));
  p(
    table(
      ["speed", "official 0 °C", "official heated", "member 0 °C", "member heated"],
      speeds.map((s) => [
        s,
        co.speedDistribution.temperature0[s] ?? 0,
        co.speedDistribution.heated[s] ?? 0,
        cm.speedDistribution.temperature0[s] ?? 0,
        cm.speedDistribution.heated[s] ?? 0,
      ]),
    ),
  );
  h(3, "Highest speed used at each temperature (official / member)");
  p(
    table(
      ["°C", "official n", "official max speed", "member n", "member max speed"],
      tempKeys
        .filter((k) => k !== "0")
        .map((k) => [
          k,
          co.maxSpeedByTemperature[k]?.n ?? 0,
          co.maxSpeedByTemperature[k]?.maxSpeed,
          cm.maxSpeedByTemperature[k]?.n ?? 0,
          cm.maxSpeedByTemperature[k]?.maxSpeed,
        ]),
    ),
  );
  h(3, "Reverse share by temperature band and by speed");
  p(
    table(
      ["band", "official n", "official reverse", "member n", "member reverse"],
      TEMP_BANDS.map((b) => [
        b.name,
        co.reverseShare.byTemperatureBand[b.name]?.n ?? 0,
        pct(co.reverseShare.byTemperatureBand[b.name]?.share),
        cm.reverseShare.byTemperatureBand[b.name]?.n ?? 0,
        pct(cm.reverseShare.byTemperatureBand[b.name]?.share),
      ]),
    ),
  );
  p("");
  p(
    table(
      ["speed", "official n", "official reverse", "member n", "member reverse"],
      speeds.map((s) => [
        s,
        co.reverseShare.bySpeed[s]?.n ?? 0,
        pct(co.reverseShare.bySpeed[s]?.share),
        cm.reverseShare.bySpeed[s]?.n ?? 0,
        pct(cm.reverseShare.bySpeed[s]?.share),
      ]),
    ),
  );
  h(3, "Time quantiles by temperature band (official, then member)");
  p(
    table(
      ["band", ...Q_HEAD.map((x) => `off ${x}`), "mem n", "mem p50"],
      TEMP_BANDS.map((b) => [
        b.name,
        ...qCells(co.timeQuantiles.byTemperatureBand[b.name]),
        cm.timeQuantiles.byTemperatureBand[b.name]?.n,
        cm.timeQuantiles.byTemperatureBand[b.name]?.p50,
      ]),
    ),
  );
  h(3, "Time quantiles by temperature band and reverse (official)");
  p(
    table(
      ["band, reverse", ...Q_HEAD],
      Object.entries(co.timeQuantiles.byTemperatureBandAndReverse).map(([k, q]) => [
        k,
        ...qCells(q),
      ]),
    ),
  );
  h(3, "Time quantiles by speed (official, then member)");
  p(
    table(
      ["speed", ...Q_HEAD.map((x) => `off ${x}`), "mem n", "mem p50"],
      speeds.map((s) => [
        s,
        ...qCells(co.timeQuantiles.bySpeed[s]),
        cm.timeQuantiles.bySpeed[s]?.n,
        cm.timeQuantiles.bySpeed[s]?.p50,
      ]),
    ),
  );
  h(3, "Joint table: temperature x speed x reverse (official, combinations with at least 3 steps)");
  p("Full table for all groups in modes.json under customized.<group>.joint.\n");
  p(
    table(
      ["°C", "speed", "reverse", "steps", "recipes", "time p25", "time p50", "time p75"],
      co.joint
        .filter((j) => j.steps >= 3)
        .map((j) => [
          j.temperature,
          j.speed,
          j.reverse ? "yes" : "",
          j.steps,
          j.recipes,
          j.timeP25,
          j.timeMedian,
          j.timeP75,
        ]),
    ),
  );
  h(3, "Member combinations that official recipes never use (at least 3 steps)");
  const offKeys = new Set(co.joint.map((j) => `${j.temperature}|${j.speed}|${j.reverse}`));
  p(
    table(
      ["°C", "speed", "reverse", "steps", "recipes", "time p50"],
      cm.joint
        .filter((j) => j.steps >= 3 && !offKeys.has(`${j.temperature}|${j.speed}|${j.reverse}`))
        .map((j) => [
          j.temperature,
          j.speed,
          j.reverse ? "yes" : "",
          j.steps,
          j.recipes,
          j.timeMedian,
        ]),
    ),
  );
  h(3, "Checks against the assumed limits");
  p(
    table(
      [
        "rule",
        "official steps",
        "official recipes",
        "member steps",
        "member recipes",
        "values (all)",
      ],
      r.customized.all.violations.map((v, i) => {
        const o = co.violations[i];
        const m = cm.violations[i];
        return [v.rule, o?.steps, o?.recipes, m?.steps, m?.recipes, inline(v.byValue, 8) || "–"];
      }),
    ),
  );
  p("\nExample step references (recipe id, step index) for each hit are in modes.json.");

  // (c)
  h(2, "c. Roasting");
  const ro = r.programModes.roasting;
  p(
    table(
      ["", ...Q_HEAD],
      [
        ["official temperature", ...qCells(ro.official.temperature)],
        ["member temperature", ...qCells(ro.member.temperature)],
        ["official time", ...qCells(ro.official.timeSeconds)],
        ["member time", ...qCells(ro.member.timeSeconds)],
      ],
    ),
  );
  p(
    `\nTemperatures (official): ${inline(ro.official.temperatureValues)}. Member: ${inline(ro.member.temperatureValues)}.`,
  );
  p(`\nTimes (official): ${inline(ro.official.timeValues, 15)}.`);
  p("\nTime by temperature (official):\n");
  p(
    table(
      ["°C", ...Q_HEAD],
      Object.entries(ro.official.timeByTemperature).map(([t, q]) => [t, ...qCells(q)]),
    ),
  );

  // (d)
  h(2, "d. Kneading by dough type (time in seconds)");
  p(
    table(
      ["mode", "group", ...Q_HEAD, "values"],
      [...KNEADING_MODES, "any"]
        .flatMap((m) =>
          (["official", "member"] as const).map((g) => {
            const k = r.programModes.kneading[m]?.[g];
            return [m, g, ...qCells(k?.timeSeconds), k ? inline(k.timeValues, 8) : ""];
          }),
        )
        .filter((row) => row[2] !== 0),
    ),
  );

  // (e)
  h(2, "e. Other program modes");
  p(
    table(
      [
        "mode",
        "group",
        "steps",
        "temperature values",
        "time p10",
        "time p50",
        "time p90",
        "time values",
        "other",
      ],
      [...OTHER_MODES]
        .filter((m) => m !== "scale")
        .flatMap((m) =>
          (["official", "member"] as const).map((g) => {
            const x = r.programModes.others[m]?.[g];
            if (!x || x.steps === 0) return [m, g, 0, "", null, null, null, "", ""];
            const extra: string[] = [];
            if (m === "cooking_eggs") extra.push(`size/texture ${inline(x.sizeTexture)}`);
            if (m === "precleaning") extra.push(`cleaningMode ${inline(x.cleaningMode)}`);
            if (m === "ramp") extra.push(`phases ${inline(x.phases)}`);
            if (x.reverseShare > 0) extra.push(`reverse ${pct(x.reverseShare)}`);
            if (x.turboShare > 0) extra.push(`turbo flag ${pct(x.turboShare)}`);
            return [
              m,
              g,
              x.steps,
              inline(x.temperatureValues, 6),
              x.timeSeconds.p10,
              x.timeSeconds.p50,
              x.timeSeconds.p90,
              inline(x.timeValues, 6),
              extra.join("; "),
            ];
          }),
        ),
    ),
  );
  p("\nrice_cooking does not occur in the corpus when its step count is 0 above.");
  h(3, "Ramp (official only): speed paths and phase timing");
  p(`Speed paths: ${inline(r.programModes.ramp.official.speedPaths, 15)}.`);
  p(
    `\nPhase time: p10 ${r.programModes.ramp.official.phaseTimeSeconds.p10}, p50 ${r.programModes.ramp.official.phaseTimeSeconds.p50}, p90 ${r.programModes.ramp.official.phaseTimeSeconds.p90}. Phase temperatures: ${inline(r.programModes.ramp.official.phaseTemperatures)}.`,
  );
  h(3, "Scale (weight in grams)");
  const so = r.programModes.scale.official;
  const sm = r.programModes.scale.member;
  p(
    table(
      ["group", ...Q_HEAD, "max"],
      [
        ["official", ...qCells(so.weight), so.weight.max],
        ["member", ...qCells(sm.weight), sm.weight.max],
      ],
    ),
  );
  p(`\nWeight buckets (official): ${inline(r.programModes.scale.official.weightBuckets, 20)}.`);
  p(`\nWeight buckets (member): ${inline(r.programModes.scale.member.weightBuckets, 20)}.`);
  p(
    `\nScale steps per recipe (official): p50 ${r.programModes.scale.official.scaleStepsPerRecipe.p50}, p90 ${r.programModes.scale.official.scaleStepsPerRecipe.p90}, max ${r.programModes.scale.official.scaleStepsPerRecipe.max}. Weight 0: official ${r.programModes.scale.official.weightZero}, member ${r.programModes.scale.member.weightZero}. Most common weights (official): ${inline(r.programModes.scale.official.topWeights, 12)}.`,
  );

  // (f)
  h(2, "f. Uses per recipe and position in the recipe");
  p(
    "Position thirds use stepIndex / (stepCount - 1) over all steps. Role counts consider only non-scale machine steps.\n",
  );
  const pmo = r.placement.perMode.official;
  const pmm = r.placement.perMode.member;
  p(
    table(
      [
        "mode",
        "group",
        "recipes",
        "uses/recipe p50",
        "max",
        "1x / 2x / 3x / 4x / 5+",
        "first third",
        "middle",
        "last third",
        "role (only / first / between / last)",
      ],
      Object.keys(r.placement.perMode.all).flatMap((m) =>
        (
          [
            ["official", pmo[m]],
            ["member", pmm[m]],
          ] as const
        )
          .filter(([, x]) => x !== undefined)
          .map(([g, x]) => {
            const hist = x?.usesPerRecipeHistogram ?? {};
            const role = x?.roleAmongNonScaleMachineSteps;
            return [
              m,
              g,
              x?.recipes,
              x?.usesPerRecipe.p50,
              x?.usesPerRecipe.max,
              ["1", "2", "3", "4", "5+"].map((k) => hist[k] ?? 0).join(" / "),
              pct(x?.positionThird.first),
              pct(x?.positionThird.middle),
              pct(x?.positionThird.last),
              role
                ? ["only", "firstMachine", "between", "lastMachine"]
                    .map((k) => role[k] ?? 0)
                    .join(" / ")
                : "–",
            ];
          }),
      ),
    ),
  );
  const mc = r.placement.machineCountPerRecipe;
  p(
    `\nNon-scale machine steps per recipe: official p50 ${mc.official.nonScaleMachineSteps.p50} (p90 ${mc.official.nonScaleMachineSteps.p90}), member p50 ${mc.member.nonScaleMachineSteps.p50} (p90 ${mc.member.nonScaleMachineSteps.p90}). ` +
      `Distinct modes per recipe: official p50 ${mc.official.distinctModes.p50}, member p50 ${mc.member.distinctModes.p50}.`,
  );
  h(3, "Most common transitions between consecutive machine steps (official, heuristic labels)");
  p(
    table(
      ["transition", "count"],
      Object.entries(r.placement.transitions.official)
        .slice(0, 25)
        .map(([k, v]) => [k, v]),
    ),
  );

  // (g)
  h(2, "g. Canonical programs");
  p(
    "Exact parameter combinations (mode, temperature, speed, reverse, time), scale excluded, ranked by the number of official recipes using them. " +
      "Labels are a heuristic reading of the parameters, not device names.\n",
  );
  p(
    table(
      ["#", "program", "label", "official recipes", "% official", "% member", "steps"],
      r.programs.exact
        .slice(0, 40)
        .map((x, i) => [
          i + 1,
          x.key,
          x.label,
          x.officialRecipes,
          pct(x.shareOfOfficialRecipes),
          pct(x.shareOfMemberRecipes),
          x.steps,
        ]),
    ),
  );
  h(3, "Program families (time left free)");
  p(
    table(
      [
        "#",
        "family",
        "label",
        "official recipes",
        "% official",
        "% member",
        "time p25",
        "time p50",
        "time p75",
        "top times",
      ],
      r.programs.families
        .slice(0, 40)
        .map((x, i) => [
          i + 1,
          x.key,
          x.label,
          x.officialRecipes,
          pct(x.shareOfOfficialRecipes),
          pct(x.shareOfMemberRecipes),
          x.timeP25,
          x.timeMedian,
          x.timeP75,
          "topTimes" in x && x.topTimes ? inline(x.topTimes, 5) : "",
        ]),
    ),
  );
  h(3, "By functional label");
  p(
    table(
      [
        "label",
        "steps",
        "% official recipes",
        "% member recipes",
        ...Q_HEAD.map((q) => `time ${q}`),
      ],
      Object.entries(r.programs.byLabel).map(([k, x]) => [
        k,
        x.steps,
        pct(x.shareOfOfficialRecipes),
        pct(x.shareOfMemberRecipes),
        ...qCells(x.time),
      ]),
    ),
  );
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Entry points.

export function analyze(steps: NormalizedStep[], recipes: NormalizedRecipe[]) {
  const recipeCount: Record<Group, number> = {
    all: recipes.length,
    official: recipes.filter((r) => inGroup(r.source, "official")).length,
    member: recipes.filter((r) => inGroup(r.source, "member")).length,
  };
  const ctx: Ctx = { steps, recipes, recipeCount };
  return {
    generatedAt: new Date().toISOString(),
    input: { steps: steps.length, recipes: recipes.length, recipeCount },
    assumedLimits: ASSUMED_LIMITS,
    temperatureBands: TEMP_BANDS,
    frequency: modeFrequency(ctx),
    customized: customizedSection(ctx),
    programModes: programModes(ctx),
    placement: placement(ctx),
    programs: programs(ctx),
  };
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

export function run(corpusDir: string): void {
  const started = performance.now();
  const dir = path.join(corpusDir, "derived");
  const steps = readJsonl<NormalizedStep>(path.join(dir, "steps.jsonl"));
  const recipes = readJsonl<NormalizedRecipe>(path.join(dir, "recipes.jsonl"));
  const result = analyze(steps, recipes);
  writeFileSync(path.join(dir, "modes.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(path.join(dir, "modes.md"), renderMarkdown(result));
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  console.log(
    `corpus:analyze-modes: ${steps.length} steps, ${recipes.length} recipes -> ${dir} (${seconds}s)`,
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
  run(process.env.CORPUS_DIR ?? path.join("local", "corpus"));
}
