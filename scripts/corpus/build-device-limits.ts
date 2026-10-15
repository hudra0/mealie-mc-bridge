// Builds knowledge/device-limits.json: recommended ranges per mode for the validator.
//
// Layers per mode: the corpus observation (all and official recipes), SmartRecipe's assumed
// limits (typed in from its source analysis), the member editor's limits (read from the
// device-programs document) and the recommended range: the stricter of all of them and of the
// hard limit in the device-programs effective layer. Hard limits (reject) live only in
// device-programs.json; the recommended range (warn) always lies inside them.
//
// Input: the machine steps of $CORPUS_DIR/derived/steps.jsonl (written by corpus:normalize)
// and the device-programs document built by build-device-programs.ts.
// Called by build-knowledge.ts (npm run corpus:build-knowledge); this module does no I/O.

import type { NormalizedStep } from "./types.js";

const SOURCE = "corpus 2026-10";

const grid = (from: number, to: number, step = 5) => {
  const out: number[] = [];
  for (let t = from; t <= to; t += step) out.push(t);
  return out;
};
const HEATING_GRID = [0, 37, ...grid(40, 130)];
const LOW_GRID = [37, ...grid(40, 95)];
const FERMENT_GRID = [37, ...grid(40, 65)];

interface Range {
  min: number;
  max: number;
}
interface TemperatureLimit {
  values?: number[];
  range?: Range;
  integer?: boolean;
}
interface Limits {
  temperature?: TemperatureLimit;
  timeSeconds?: Range;
  speed?: Range;
  weightGrams?: Range;
  phases?: Range;
  phaseTimeSeconds?: Range;
  phaseSpeed?: Range;
  modeSetting?: Record<string, string[]>;
}

/** The parts of the device-programs document this generator reads. */
export interface ProgramLayerLike {
  min: number | null;
  max: number | null;
  step: number | null;
  values: readonly (number | string | boolean)[] | null;
}
export interface ProgramsLike {
  modes: readonly {
    id: string;
    memberVisible?: boolean;
    params?: Record<string, { editor?: ProgramLayerLike; effective?: ProgramLayerLike }>;
  }[];
}

export interface DeviceLimitsInput {
  /** All rows of steps.jsonl; text steps are skipped. */
  steps: readonly NormalizedStep[];
  programs: ProgramsLike;
}

// ------------------------------------------------------------------ corpus
interface Observation {
  steps: number;
  recipes: number;
  temperature?: { min?: number; max?: number; values: number[] };
  timeSeconds?: Range;
  speed?: Range;
  weightGrams?: Range;
  phases?: Range;
  stepTimeSeconds?: Range;
  modeSetting?: Record<string, Record<string, number>>;
}

type Phase = NonNullable<NormalizedStep["modeSetting"]>["settings"][number];
type PhaseKey = "temperature" | "time" | "speed" | "weight";

const isNumber = (v: unknown): v is number => typeof v === "number";
const minMax = (a: readonly number[]): Range | undefined =>
  a.length ? { min: Math.min(...a), max: Math.max(...a) } : undefined;

function observe(rows: readonly NormalizedStep[]): Observation | null {
  if (!rows.length) return null;
  const phases: Phase[] = rows.flatMap((r) => r.modeSetting?.settings ?? []);
  const vals = (k: PhaseKey) => phases.map((p) => p[k]).filter(isNumber);
  const o: Observation = { steps: rows.length, recipes: new Set(rows.map((r) => r.recipeId)).size };
  const T = vals("temperature");
  if (T.length && Math.max(...T) > 0)
    o.temperature = {
      min: Math.min(...T),
      max: Math.max(...T),
      values: [...new Set(T)].sort((a, b) => a - b),
    };
  else if (T.length) o.temperature = { values: [0] };
  const t = minMax(vals("time"));
  if (t) o.timeSeconds = t;
  const v = minMax(vals("speed"));
  if (v) o.speed = v;
  const w = minMax(vals("weight"));
  if (w) o.weightGrams = w;
  const pc = rows.map((r) => (r.modeSetting?.settings ?? []).length).filter((n) => n > 0);
  const pcRange = minMax(pc);
  if (pcRange && pcRange.max > 1) {
    o.phases = pcRange;
    const st = minMax(rows.map((r) => r.timeSeconds).filter(isNumber));
    if (st) o.stepTimeSeconds = st;
  }
  const ms: Record<string, Record<string, number>> = {};
  for (const r of rows)
    for (const k of ["size", "texture", "cleaningMode"] as const) {
      const val = r.modeSetting?.[k];
      if (val) {
        const counts = (ms[k] ??= {});
        counts[val] = (counts[val] ?? 0) + 1;
      }
    }
  if (Object.keys(ms).length) o.modeSetting = ms;
  return o;
}

const corpusLimits = (o: Observation | null): Limits => {
  if (!o) return {};
  const l: Limits = {};
  const temp = o.temperature;
  if (temp?.min !== undefined && temp.max !== undefined)
    l.temperature = { range: { min: temp.min, max: temp.max } };
  if (o.phases) {
    l.phases = o.phases;
    if (o.timeSeconds) l.phaseTimeSeconds = o.timeSeconds;
    if (o.speed) l.phaseSpeed = o.speed;
  } else {
    if (o.timeSeconds) l.timeSeconds = o.timeSeconds;
    if (o.speed) l.speed = o.speed;
  }
  if (o.weightGrams) l.weightGrams = o.weightGrams;
  if (o.modeSetting)
    l.modeSetting = Object.fromEntries(
      Object.entries(o.modeSetting).map(([k, v]) => [
        k === "cleaningMode" ? "duration" : k,
        Object.keys(v),
      ]),
    );
  return l;
};

// ------------------------------------------------------------------ SmartRecipe (section D)

// ------------------------------------------------------------------ SmartRecipe (section D)
const smartRecipe: Record<string, Limits | null> = {
  scale: { weightGrams: { min: 5, max: 5000 } },
  turbo: { timeSeconds: { min: 1, max: 20 } },
  customized: {
    temperature: { values: HEATING_GRID },
    timeSeconds: { min: 1, max: 5940 },
    speed: { min: 0, max: 10 },
  },
  roasting: { temperature: { values: HEATING_GRID }, timeSeconds: { min: 0, max: 840 } },
  kneading_solid_dough: { timeSeconds: { min: 45, max: 240 } },
  kneading_soft_dough: { timeSeconds: { min: 45, max: 240 } },
  kneading_liquid_dough: { timeSeconds: { min: 45, max: 360 } },
  steaming: { timeSeconds: { min: 0, max: 3600 } },
  sous_vide: {
    temperature: { range: { min: 40, max: 85 }, integer: true },
    timeSeconds: { min: 900, max: 43200 },
  },
  slow_cooking: { temperature: { values: LOW_GRID }, timeSeconds: { min: 900, max: 28800 } },
  fermentation: { temperature: { values: FERMENT_GRID }, timeSeconds: { min: 1800, max: 43200 } },
  rice_cooking: { timeSeconds: { min: 1200, max: 2400 } },
  food_processor: { timeSeconds: { min: 1, max: 300 } },
  puree: { timeSeconds: { min: 30, max: 120 } },
  smoothie: { timeSeconds: { min: 30, max: 120 } },
  cooking_eggs: {
    modeSetting: { size: ["small", "medium", "large"], texture: ["soft", "waxy_soft", "hard"] },
  },
  precleaning: { modeSetting: { duration: ["short", "long"] } },
  kneading: null,
  ramp: null,
};
const smartRecipeNotes: Record<string, string> = {
  customized: "speed at most 3 when heating or in reverse",
  steaming: "no temperature",
  food_processor: "excluded unless the installation sets MC_HAS_FOOD_PROCESSOR=true",
  cooking_eggs: "no deviceSettings; durations are display-only",
  precleaning: "no deviceSettings",
};

// ------------------------------------------------------------------ editor (device-programs)
const layerRange = (x: ProgramLayerLike | undefined): Range | undefined =>
  x && typeof x.min === "number" && typeof x.max === "number"
    ? { min: x.min, max: x.max }
    : undefined;
const numbers = (values: readonly (number | string | boolean)[]) => values.filter(isNumber);
const strings = (values: readonly (number | string | boolean)[]) =>
  values.filter((v): v is string => typeof v === "string");

type ProgramLayer = "editor" | "effective";

/** One layer of a mode in the device-programs document as limits; null when the mode is absent. */
function programLimits(programs: ProgramsLike, m: string, layer: ProgramLayer): Limits | null {
  const mode = programs.modes.find((x) => x.id === m);
  if (!mode) return null;
  const p = mode.params ?? {};
  const e: Limits = {};
  const temp = p.temperature?.[layer];
  if (temp) {
    const r = layerRange(temp);
    if (temp.values) e.temperature = { values: numbers(temp.values) };
    else if (r) e.temperature = { range: r, integer: temp.step === 1 };
  }
  const time = layerRange(p.time?.[layer]);
  if (time) e.timeSeconds = time;
  const speed = layerRange(p.speed?.[layer]);
  if (speed) e.speed = speed;
  const weight = layerRange(p.weight?.[layer]);
  if (weight) e.weightGrams = weight;
  const phases = layerRange(p.phaseCount?.[layer]);
  if (phases) e.phases = phases;
  const phaseTime = layerRange(p.phaseTime?.[layer]);
  if (phaseTime) e.phaseTimeSeconds = phaseTime;
  const phaseSpeed = layerRange(p.phaseSpeed?.[layer]);
  if (phaseSpeed) e.phaseSpeed = phaseSpeed;
  const ms: Record<string, string[]> = {};
  for (const k of ["size", "texture", "duration"]) {
    const values = p[k]?.[layer]?.values;
    if (values) ms[k] = strings(values);
  }
  if (Object.keys(ms).length) e.modeSetting = ms;
  return e;
}

// ------------------------------------------------------------------ stricter of all
const stricterRange = (...rs: (Range | undefined)[]): Range | undefined => {
  const ok = rs.filter((r): r is Range => r !== undefined);
  if (!ok.length) return undefined;
  return { min: Math.max(...ok.map((r) => r.min)), max: Math.min(...ok.map((r) => r.max)) };
};
const tempRange = (t: TemperatureLimit): Range | undefined =>
  t.range ?? (t.values ? { min: Math.min(...t.values), max: Math.max(...t.values) } : undefined);

interface CombinedSpeed extends Range {
  maxWhenHeated?: number;
  maxWithReverse?: number;
  conditions?: string[];
}
interface Combined {
  temperature?: { values: number[] } | { range: Range; integer: boolean };
  timeSeconds?: Range;
  speed?: CombinedSpeed;
  weightGrams?: Range;
  phases?: Range;
  phaseTimeSeconds?: Range;
  phaseSpeed?: Range;
  modeSetting?: Record<string, string[]>;
}

const rangeKeys = [
  "timeSeconds",
  "speed",
  "weightGrams",
  "phases",
  "phaseTimeSeconds",
  "phaseSpeed",
] as const;

function combine(m: string, sources: readonly Limits[]): Combined {
  const eff: Combined = {};
  // temperature: values from the first grid source, limited to the stricter range
  const temps = sources.map((s) => s.temperature).filter((t) => t !== undefined);
  if (temps.length) {
    const r = stricterRange(...temps.map(tempRange));
    if (!r) throw new Error(`${m}: no temperature range`);
    const { min, max } = r;
    const gridSrc = temps.find((t) => t.values);
    if (gridSrc?.values)
      eff.temperature = { values: gridSrc.values.filter((v) => v >= min && v <= max) };
    else eff.temperature = { range: r, integer: temps.some((t) => t.integer) };
  }
  for (const k of rangeKeys) {
    const r = stricterRange(...sources.map((s) => s[k]));
    if (r) eff[k] = r;
  }
  const msSources = sources.map((s) => s.modeSetting).filter((s) => s !== undefined);
  if (msSources.length) {
    const keys = [...new Set(msSources.flatMap((s) => Object.keys(s)))];
    eff.modeSetting = Object.fromEntries(
      keys.map((k) => {
        const lists = msSources.map((s) => s[k]).filter((l) => l !== undefined);
        return [k, lists.reduce((a, b) => a.filter((x) => b.includes(x)))];
      }),
    );
  }
  return eff;
}

const modeOrder = [
  "customized",
  "scale",
  "roasting",
  "turbo",
  "steaming",
  "kneading",
  "kneading_solid_dough",
  "kneading_soft_dough",
  "kneading_liquid_dough",
  "puree",
  "smoothie",
  "ramp",
  "food_processor",
  "sous_vide",
  "slow_cooking",
  "fermentation",
  "rice_cooking",
  "cooking_eggs",
  "precleaning",
];
const parameters: Record<string, string[]> = {
  customized: ["temperature", "time", "speed", "reverse"],
  scale: ["weight"],
  roasting: ["temperature", "time"],
  turbo: ["time"],
  steaming: ["time"],
  kneading: ["time"],
  kneading_solid_dough: ["time"],
  kneading_soft_dough: ["time"],
  kneading_liquid_dough: ["time"],
  puree: ["time"],
  smoothie: ["time"],
  ramp: ["phases[{speed, time}]"],
  food_processor: ["time"],
  sous_vide: ["temperature", "time"],
  slow_cooking: ["temperature", "time"],
  fermentation: ["temperature", "time"],
  rice_cooking: ["time"],
  cooking_eggs: ["modeSetting.size", "modeSetting.texture"],
  precleaning: ["modeSetting.duration"],
};
const extraNotes: Record<string, string[]> = {
  customized: [
    "Speed at most 3 when the temperature is above 0 or in reverse (rules speed_max_heated, speed_max_reverse).",
    "Speed 0 is allowed by SmartRecipe as a fake waiting step but never occurs in the corpus and the editor starts at 1; a pause is a text step.",
    "Every manual step in the corpus has exactly one settings phase; the turbo flag is never set on manual steps.",
  ],
  scale: [
    "The editor and SmartRecipe allow up to 5000 g (the hard limit); the corpus maximum is 2500 g, which sets the recommended maximum. Below 5 g the corpus never weighs (amounts go into teaspoons, pinches or knife tips).",
  ],
  roasting: [
    "The temperature starts at 100 °C (hard limit in device-programs.json): official recipes roast at 100-130 °C (398 of 399 steps). Member recipes also roast at 80-95 °C (13 steps) and 4 steps store 0 °C, which looks like data errors.",
    "The editor and SmartRecipe allow 0 s; the minimum is the official minimum of 60 s (member recipes go down to 2 s).",
  ],
  steaming: ["The API stores temperature 0; the device controls the heat."],
  kneading: [
    "Official recipes only (188 steps, 45-120 s). The member editor does not offer it on MC3.0; member recipes use the three kneading_*_dough programs instead.",
  ],
  kneading_liquid_dough: [
    "SmartRecipe and the editor allow up to 360 s; the corpus maximum is 180 s over 16 steps.",
  ],
  ramp: [
    "Official recipes only (60 steps, 262 phases). The member editor does not offer it on MC3.0.",
    "Official ramps contain phases of up to 30 s although the editor limits a phase to 20 s; the limit follows the editor.",
    "Speeds rise phase by phase (59 of 60 corpus paths ascend, for example 4>5>6>7>8), about 10 s per phase (p10 4, p90 15), 10-120 s in total, always at 0 °C.",
  ],
  rice_cooking: ["No corpus step: no reference for quantities or setup."],
  food_processor: [
    "Needs the food processor attachment; offer it only when the installation says it is present.",
  ],
};

const LOW_EVIDENCE = 30;

export function buildDeviceLimits(input: DeviceLimitsInput) {
  const steps = input.steps.filter((s) => s.kind === "machine");
  const modes: Record<string, unknown> = {};
  for (const m of modeOrder) {
    const rows = steps.filter((s) => s.mode === m);
    const all = observe(rows);
    const official = observe(rows.filter((r) => r.source === "official"));
    const sr = smartRecipe[m] ?? null;
    const editor = programLimits(input.programs, m, "editor");
    const hard = programLimits(input.programs, m, "effective");
    const memberVisible = input.programs.modes.find((x) => x.id === m)?.memberVisible;
    const corpusL = corpusLimits(all);
    if (official && official.steps >= 30) {
      if (corpusL.timeSeconds && official.timeSeconds)
        corpusL.timeSeconds = { min: official.timeSeconds.min, max: corpusL.timeSeconds.max };
      if (corpusL.weightGrams && official.weightGrams)
        corpusL.weightGrams = { min: official.weightGrams.min, max: corpusL.weightGrams.max };
    }
    const sources: Limits[] = [corpusL];
    if (sr) sources.push(sr);
    if (editor) sources.push(editor);
    if (hard) sources.push(hard);
    const recommended = combine(m, sources);
    if (m === "customized") {
      if (!recommended.speed) throw new Error("customized: no speed range");
      recommended.speed = {
        min: recommended.speed.min,
        max: 10,
        maxWhenHeated: 3,
        maxWithReverse: 3,
        conditions: ["speed >= 6: time at most 600 s"],
      };
    }
    if (m === "ramp") recommended.temperature = { values: [0] };
    const notes = [...(extraNotes[m] ?? [])];
    if (!sr) notes.push("Not in SmartRecipe's mapping.");
    if (!all)
      notes.push(
        "No corpus step; the recommended range comes from SmartRecipe, the editor and device-programs.json.",
      );
    const srNote = smartRecipeNotes[m];
    if (sr && srNote) notes.push(`SmartRecipe: ${srNote}.`);
    modes[m] = {
      parameters: parameters[m],
      corpus: { all, official },
      smartRecipe: sr,
      editor,
      recommended,
      lowEvidence: (all?.steps ?? 0) < LOW_EVIDENCE,
      memberEditor: memberVisible ?? null,
      notes,
    };
  }

  const heatedManual = steps.filter((s) => s.mode === "customized" && (s.temperature ?? 0) > 0);
  const reverseManual = steps.filter((s) => s.mode === "customized" && s.reverse);
  const longFast = steps.filter((s) => s.mode === "customized" && (s.speed ?? 0) >= 6);
  return {
    description:
      "Recommended ranges per mode: corpus observation, SmartRecipe's assumed limits, the member editor's limits, and the recommended range (the stricter of all of them). Hard limits live in device-programs.json.",
    version: 1,
    source: SOURCE,
    policy: {
      hardLimits:
        "knowledge/device-programs.json (modes[].params[].effective) is the single source of truth for hard limits: the validator rejects values outside it. This file holds no hard limits.",
      recommended:
        "For each limit the stricter of: the corpus range over all 2221 recipes (member recipes went through the same device, so this shows what the device runs), SmartRecipe's assumed limit, the member editor's limit and the hard limit from knowledge/device-programs.json. Ranges intersect; value lists keep the grid values inside the intersected range. Minimum times and weights come from official recipes when a mode has at least 30 official steps (member recipes contain stray values such as a 2 s roasting step); maximums come from all recipes. Every recommended range lies inside the hard limit. The validator may warn outside the recommended range; it does not reject on it.",
      lowEvidence: `Modes with fewer than ${LOW_EVIDENCE} corpus steps have lowEvidence: true. Their corpus range is a small sample, not a device limit, so their recommended range is a weak hint.`,
      serverDoesNotCheck:
        "The recipe API stores out-of-range numbers unchanged (device-programs.json server layer), so the bridge validates everything itself.",
      relation:
        "knowledge/device-programs.json holds the hard limits, the editor and server layers, labels and payload keys. This file adds the corpus ranges, the SmartRecipe comparison and the recommended ranges.",
      missingInSmartRecipe:
        "kneading and ramp: official recipes only, not offered by the member editor on MC3.0. The server stores them from a member account; whether the device plays them is untested. The converter avoids them.",
      missingInCorpus: "rice_cooking has no corpus step.",
    },
    temperatureGrids: {
      heating: HEATING_GRID,
      lowTemperature: LOW_GRID,
      fermentation: FERMENT_GRID,
    },
    rules: [
      {
        id: "speed_max_heated",
        rule: "customized: speed <= 3 when temperature > 0",
        value: 3,
        severity: "error",
        sources: ["SmartRecipe", "editor"],
        corpus: `${heatedManual.filter((s) => (s.speed ?? 0) > 3).length} of ${heatedManual.length} heated manual steps exceed it (one official step at 50 °C, speed 4).`,
      },
      {
        id: "speed_max_reverse",
        rule: "customized: speed <= 3 when reverse is true",
        value: 3,
        severity: "error",
        sources: ["SmartRecipe", "editor"],
        corpus: `${reverseManual.filter((s) => (s.speed ?? 0) > 3).length} of ${reverseManual.length} reverse steps exceed it (all at 0 °C, speeds 4, 5 and 8).`,
      },
      {
        id: "speed_max_whisk",
        rule: "speed <= 4 while the butterfly whisk attachment is fitted",
        value: 4,
        severity: "error",
        sources: ["official recipe guide", "SmartRecipe prompt"],
        corpus:
          "92 % of 474 working steps with the whisk fitted run at speed 4 or lower; the 30 above are probably missed removals in the text parser.",
      },
      {
        id: "time_max_fast",
        rule: "customized: time <= 600 s when speed >= 6",
        value: 600,
        severity: "error",
        sources: ["device-programs.json sanity rule (MC4.0 and MC0.5 editor tables)"],
        corpus: `The longest of ${longFast.length} manual steps at speed 6 or more runs ${Math.max(...longFast.map((s) => s.timeSeconds ?? 0))} s.`,
      },
      {
        id: "no_turbo_with_whisk",
        rule: "no turbo step while the whisk is fitted",
        severity: "error",
        sources: ["SmartRecipe prompt"],
      },
      {
        id: "turbo_content_temperature",
        rule: "no turbo on contents hotter than 60 °C",
        value: 60,
        severity: "error",
        sources: ["SmartRecipe prompt"],
        corpus:
          "Turbo steps always store 0 °C; 68 % sit in the first third of the recipe, before any heating.",
      },
      {
        id: "temperature_grid",
        rule: "customized and roasting temperatures lie on the heating grid (0, 37, 40-130 in steps of 5)",
        severity: "error",
        sources: ["SmartRecipe", "editor"],
        corpus: "No corpus temperature is off the grid or above 130 °C.",
      },
      {
        id: "single_phase",
        rule: "every mode except ramp has exactly one settings phase",
        severity: "error",
        corpus: "6850 of 6850 manual steps have one phase.",
      },
      {
        id: "no_speed_on_programs",
        rule: "program modes store no speed and no reverse flag; reverse exists only on customized",
        severity: "error",
        corpus: `All program steps have speed null and reverse false; ${reverseManual.length} manual steps use reverse.`,
      },
      {
        id: "turbo_flag",
        rule: "the turbo flag is true on turbo steps and false everywhere else",
        severity: "error",
        corpus: "413 of 413 turbo steps carry the flag; no other step does.",
      },
      {
        id: "step_text",
        rule: "step title 1-80 characters; description 1-240 characters on text, scale and turbo steps, empty on every other mode",
        severity: "error",
        sources: ["editor", "SmartRecipe"],
      },
      {
        id: "text_step_title",
        rule: "a text step title is a short imperative summary of at most this many characters, not the start of its description; titles of more than three words that start the description, and longer titles, get one correction round",
        value: 60,
        severity: "nudge",
        sources: ["bridge style choice"],
      },
      {
        id: "mass_limits",
        rule: "bowl, flour, steaming-water and basket limits live in timing-model.json under massLimits",
      },
    ],
    apiMapping: {
      readApi:
        "GET /api/v2/recipes/{id}: step.deviceSetting = {mode, reverse, turbo, size, texture, cleaningMode, settings[{order, speed, temperature, time, weight}]}",
      upload:
        "POST/PUT api/v3/auth/user/recipes: step.mode = {type, modeSetting, deviceSettings[{order, temperature, time, speed, clockwise}]}",
      reverseToClockwise: "clockwise = !reverse (reverse true means Linkslauf)",
      modeSetting:
        "cooking_eggs: {size, texture}; precleaning: {duration} (the read API calls it cleaningMode)",
      textOnDevice:
        "Only text, scale and turbo steps show a description on the device; other program steps show their title only.",
    },
    modes,
  };
}
