// Loads the knowledge base the prompt and the plausibility checks use: the language-neutral
// files in KNOWLEDGE_DIR (cooking techniques, the timing model, densities, recommended
// device ranges, the converter's own tables, the neutral prompt rules) and the locale pack
// of the output language under KNOWLEDGE_DIR/locales/<locale>/ (unit vocabulary, phrases,
// technique wording, language-specific prompt rules). The technique wording of every other
// pack joins the selection of techniques, so a source recipe in any of those languages finds
// its techniques. step-patterns.md stays in the directory as the evidence behind the prompt
// rules; the converter does not read it.
//
// Each JSON file is checked leniently: only the fields this module reads must be present,
// everything else passes through. A missing file, a missing field or a placeholder the pack
// cannot fill fails the load, so a broken knowledge base never reaches a conversion.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_LOCALE,
  LocalePackError,
  loadAllLocalePacks,
  loadLocalePack,
  type LocalePack,
  type PackUnits,
} from "../locale/pack.js";
import { fillPlaceholders } from "../locale/placeholders.js";
import { DEFAULT_KNOWLEDGE_DIR } from "./settings.js";
import { createTextRules, type TextRules } from "./text.js";
import type { ConversionRequest } from "./types.js";

export { DEFAULT_KNOWLEDGE_DIR } from "./settings.js";

// The language-neutral files, in the order a missing one is reported.
export const KNOWLEDGE_FILES = {
  techniques: "techniques.json",
  timing: "timing-model.json",
  units: "units.json",
  recommended: "device-limits.json",
  converterRules: "converter-rules.json",
  promptRules: "prompt-rules.md",
} as const;

export class KnowledgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KnowledgeError";
  }
}

const range = z.tuple([z.number(), z.number()]);
const quantile = z.looseObject({
  typical: z.number(),
  range: range.optional(),
  max: z.number().optional(),
  note: z.string().optional(),
  formula: z.string().optional(),
  formulaNote: z.string().optional(),
  formulaR2: z.number().optional(),
});
const speed = z.looseObject({ typical: z.number(), max: z.number().optional() });

const techniqueSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string(),
  ingredientClasses: z.array(z.string()),
  device: z.looseObject({
    mode: z.string().min(1),
    temperature: quantile.nullish(),
    timeSeconds: quantile.nullish(),
    speed: speed.nullish(),
    weightGrams: z
      .looseObject({ typical: z.number(), range: range.optional(), max: z.number().optional() })
      .nullish(),
    modeSetting: z.record(z.string(), z.looseObject({ typical: z.string().optional() })).nullish(),
    reverse: z.union([z.boolean(), z.string()]).optional(),
    turbo: z.boolean().optional(),
    accessory: z
      .looseObject({
        measuringCup: z.string().optional(),
        attachment: z.string().nullable().optional(),
      })
      .optional(),
  }),
  alternatives: z
    .array(
      z.looseObject({
        mode: z.string(),
        temperature: quantile.optional(),
        timeSeconds: quantile.optional(),
        speed: speed.optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  timeByLoadClass: z
    .record(z.string(), z.looseObject({ typical: z.number(), range: range.optional() }))
    .optional(),
  structure: z.array(z.string()).default([]),
  notes: z.array(z.string()).optional(),
  pendingVerification: z.string().optional(),
});

const techniquesFileSchema = z.looseObject({ techniques: z.array(techniqueSchema).min(1) });

const typicalRange = z.looseObject({ typical: z.number(), range: range.optional() });
const massLimitSchema = z.looseObject({
  id: z.string(),
  maxGrams: z.number().optional(),
  minGrams: z.number().optional(),
  appliesTo: z.string(),
  severity: z.enum(["error", "warning"]),
  condition: z.string().optional(),
});

const timingFileSchema = z.looseObject({
  constants: z.looseObject({
    heaterWatts: z.number().positive(),
    efficiency: z.number().positive(),
    heatCapacityJoulePerKgKelvin: z.number().positive(),
    startTemperatureC: z.number(),
  }),
  functions: z.looseObject({
    tMinSeconds: z.looseObject({
      expression: z.string(),
      secondsPerKgToBoil: z.number().positive(),
    }),
  }),
  heatUpRules: z.array(
    z.looseObject({
      id: z.string(),
      appliesTo: z.string(),
      condition: z.string(),
      severity: z.string().optional(),
      typicalFactor: z.number().positive().optional(),
    }),
  ),
  manualCooking: z.looseObject({
    note: z.string().optional(),
    defaultsByTemperature: z.record(z.string(), typicalRange),
  }),
  roasting: z.looseObject({
    note: z.string().optional(),
    defaultsByTemperature: z.record(z.string(), typicalRange),
  }),
  steaming: z.looseObject({
    note: z.string().optional(),
    byLoadClass: z.record(z.string(), typicalRange),
    liquidWeighedBefore: typicalRange.optional(),
  }),
  kneading: z.looseObject({ note: z.string().optional() }),
  blending: z.looseObject({ note: z.string().optional() }),
  chopping: z.looseObject({ note: z.string().optional() }),
  massLimits: z.array(massLimitSchema).min(1),
  temperatureNotes: z.array(z.string()).default([]),
  durations: z.looseObject({ rule: z.string().optional() }).optional(),
});

// The neutral part of the unit rules: densities in g per ml by kind of liquid.
const unitsFileSchema = z.looseObject({
  densities: z.record(z.string(), z.union([z.number(), z.string()])),
});

const recommendedFileSchema = z.looseObject({
  rules: z.array(
    z.looseObject({
      id: z.string(),
      rule: z.string(),
      value: z.number().optional(),
      severity: z.string().optional(),
    }),
  ),
});

const converterRulesFileSchema = z.looseObject({
  amountBalance: z.looseObject({ tolerance: z.number().min(0).max(1) }),
});

export type Technique = z.infer<typeof techniqueSchema>;
export type TimingModel = z.infer<typeof timingFileSchema>;
// The unit rules of the output language with the neutral densities.
export type UnitsKnowledge = PackUnits & { densities: Record<string, number | string> };
export type RecommendedLimits = z.infer<typeof recommendedFileSchema>;
export type MassLimit = z.infer<typeof massLimitSchema>;

export interface HeatUpThresholds {
  // A first heating shorter than errorFactor x tMin is an error, shorter than
  // warningFactor x tMin a warning.
  errorFactor: number;
  warningFactor: number;
  // The check applies from this temperature up.
  minTemperature: number;
  // Median time over tMin of official first heatings, when the timing model states it.
  typicalFactor?: number;
}

export interface Knowledge {
  // The output locale and its pack.
  locale: string;
  pack: LocalePack;
  techniques: Technique[];
  timing: TimingModel;
  units: UnitsKnowledge;
  recommended: RecommendedLimits;
  // The neutral prompt rules with the pack's wording filled in, Markdown.
  promptRules: string;
  // The pack's own prompt rules, Markdown.
  languageRules: string;
  heatUp: HeatUpThresholds;
  massLimits: ReadonlyMap<string, MassLimit>;
  // Wording of each technique in the output language (technique-aliases.json).
  aliases: Readonly<Record<string, readonly string[]>>;
  // Aliases of every pack, lower case, for picking techniques on a source recipe in any
  // language.
  selectionAliases: Readonly<Record<string, readonly string[]>>;
  // Words per ingredient class of techniques.json, of every pack. A word matches the start
  // of a word in the recipe, so "zwiebel" also finds "Zwiebeln".
  ingredientClassWords: Readonly<Record<string, readonly string[]>>;
  // Share by which an amount may exceed or fall short of the input (converter-rules.json).
  amountTolerance: number;
  // The text heuristics of the plausibility checks for the output language.
  text: TextRules;
}

// Techniques every prompt carries: the scale step, chopping, sautéing and simmering cover
// the skeleton of most savory recipes.
export const ALWAYS_SELECTED = [
  "weigh_ingredient",
  "chop_onion_garlic",
  "saute_onions",
  "simmer_cook",
] as const;

// Entries the plausibility checks read; the load fails without them.
export const REQUIRED_MASS_LIMITS = [
  "bowl_max",
  "bowl_max_foaming",
  "turbo_bowl_max",
  "flour_max_per_knead",
  "steaming_liquid_min",
] as const;
export type RequiredMassLimit = (typeof REQUIRED_MASS_LIMITS)[number];
export const REQUIRED_RULES = ["speed_max_whisk", "turbo_content_temperature"] as const;
export type RequiredRule = (typeof REQUIRED_RULES)[number];
export const REQUIRED_TECHNIQUES = [...ALWAYS_SELECTED, "sear_roast"] as const;
// Standard phrases the checks quote in their messages.
export const REQUIRED_PHRASES = ["whiskOut", "rinseBowl"] as const;

async function readText(dir: string, file: string): Promise<string> {
  const path = join(dir, file);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new KnowledgeError(`Cannot read the knowledge file ${path}`, { cause: error });
  }
}

function parseJson<T extends z.ZodType>(schema: T, text: string, file: string): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new KnowledgeError(`${file} is not valid JSON`, { cause: error });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new KnowledgeError(`${file} does not have the expected shape: ${issues}`);
  }
  return result.data;
}

function markdown(text: string, file: string): string {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (!trimmed.startsWith("# ")) {
    throw new KnowledgeError(`${file} must start with a "# " heading`);
  }
  return trimmed;
}

// Reads the factor out of a heat-up condition such as "timeSeconds < 0.5 * tMinSeconds(...)".
function factorOf(condition: string | undefined, id: string): number {
  const match = condition ? /<\s*([\d.]+)\s*\*\s*tMinSeconds/.exec(condition) : null;
  const factor = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new KnowledgeError(`timing-model.json: heat-up rule ${id} has no "< f * tMinSeconds"`);
  }
  return factor;
}

function heatUpThresholds(timing: TimingModel): HeatUpThresholds {
  const rule = (id: string) => timing.heatUpRules.find((entry) => entry.id === id);
  const error = rule("heatup_too_short");
  const warning = rule("heatup_short");
  const minTemperature = Number(/temperature\s*>=\s*(\d+)/.exec(error?.appliesTo ?? "")?.[1]);
  if (!Number.isFinite(minTemperature)) {
    throw new KnowledgeError(
      'timing-model.json: heat-up rule heatup_too_short needs "temperature >= N" in appliesTo',
    );
  }
  const thresholds: HeatUpThresholds = {
    errorFactor: factorOf(error?.condition, "heatup_too_short"),
    warningFactor: factorOf(warning?.condition, "heatup_short"),
    minTemperature,
  };
  if (warning?.typicalFactor !== undefined) thresholds.typicalFactor = warning.typicalFactor;
  return thresholds;
}

export interface KnowledgeTexts {
  techniques: string;
  timing: string;
  units: string;
  recommended: string;
  converterRules: string;
  promptRules: string;
}

// Fills the placeholders of every string in a parsed knowledge value.
function fillDeep<T>(value: T, fill: (text: string) => string): T {
  if (typeof value === "string") return fill(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => fillDeep(item, fill)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillDeep(item, fill)]),
    ) as T;
  }
  return value;
}

function withPack<T>(where: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof LocalePackError) throw new KnowledgeError(error.message, { cause: error });
    throw new KnowledgeError(`${where}: ${String(error)}`, { cause: error });
  }
}

// Checks the file contents and builds the knowledge object for the output language of
// `pack`. `packs` are all packs whose technique wording joins the technique selection; the
// output pack always counts.
export function buildKnowledge(
  files: KnowledgeTexts,
  pack: LocalePack,
  packs: readonly LocalePack[] = [pack],
): Knowledge {
  const F = KNOWLEDGE_FILES;
  const parsedTechniques = parseJson(techniquesFileSchema, files.techniques, F.techniques);
  const timing = parseJson(timingFileSchema, files.timing, F.timing);
  const neutralUnits = parseJson(unitsFileSchema, files.units, F.units);
  const recommended = parseJson(recommendedFileSchema, files.recommended, F.recommended);
  const converterRules = parseJson(
    converterRulesFileSchema,
    files.converterRules,
    F.converterRules,
  );

  const fill = (where: string) => (text: string) =>
    withPack(where, () => fillPlaceholders(text, pack, where));
  const techniques = fillDeep(parsedTechniques.techniques, fill(F.techniques));
  const ids = new Set<string>();
  for (const technique of techniques) {
    if (ids.has(technique.id)) {
      throw new KnowledgeError(`${F.techniques}: technique ${technique.id} is listed twice`);
    }
    ids.add(technique.id);
  }
  for (const id of REQUIRED_TECHNIQUES) {
    if (!ids.has(id)) throw new KnowledgeError(`${F.techniques}: technique ${id} is missing`);
  }
  const massLimits = new Map(timing.massLimits.map((limit) => [limit.id, limit]));
  for (const id of REQUIRED_MASS_LIMITS) {
    const limit = massLimits.get(id);
    if (!limit || (limit.maxGrams === undefined && limit.minGrams === undefined)) {
      throw new KnowledgeError(
        `${F.timing}: mass limit ${id} with maxGrams or minGrams is missing`,
      );
    }
  }
  for (const id of REQUIRED_RULES) {
    if (recommended.rules.find((rule) => rule.id === id)?.value === undefined) {
      throw new KnowledgeError(`${F.recommended}: rule ${id} with a value is missing`);
    }
  }
  for (const id of REQUIRED_PHRASES) {
    if (pack.phrases.standardPhrases[id] === undefined) {
      throw new KnowledgeError(`${pack.locale}: the standard phrase ${id} is missing`);
    }
  }

  const all = [...new Set([pack, ...packs])];
  const selectionAliases: Record<string, string[]> = {};
  const ingredientClassWords: Record<string, string[]> = {};
  for (const source of all) {
    for (const [id, entry] of Object.entries(source.techniqueAliases.techniques)) {
      if (!ids.has(id)) {
        throw new KnowledgeError(
          `locales/${source.locale}/technique-aliases.json: technique ${id} is not in ${F.techniques}`,
        );
      }
      const merged = [
        ...(selectionAliases[id] ?? []),
        ...entry.aliases.map((a) => a.toLowerCase()),
      ];
      selectionAliases[id] = [...new Set(merged)];
    }
    for (const [name, list] of Object.entries(source.techniqueAliases.ingredientClassWords)) {
      ingredientClassWords[name] = [...new Set([...(ingredientClassWords[name] ?? []), ...list])];
    }
  }
  const aliases = Object.fromEntries(
    Object.entries(pack.techniqueAliases.techniques).map(([id, entry]) => [id, entry.aliases]),
  );

  return {
    locale: pack.locale,
    pack,
    techniques,
    timing,
    units: { ...pack.units, densities: neutralUnits.densities },
    recommended,
    promptRules: markdown(fill(F.promptRules)(files.promptRules), F.promptRules),
    languageRules: fill(`locales/${pack.locale}/prompt-rules.md`)(pack.promptRules),
    heatUp: heatUpThresholds(timing),
    massLimits,
    aliases,
    selectionAliases,
    ingredientClassWords,
    amountTolerance: converterRules.amountBalance.tolerance,
    text: createTextRules(pack, all),
  };
}

// Reads the knowledge base from a directory for one output locale. A relative path
// resolves against the working directory, like DEVICE_PROGRAMS_PATH.
export async function loadKnowledge(
  dir: string = DEFAULT_KNOWLEDGE_DIR,
  locale: string = DEFAULT_LOCALE,
): Promise<Knowledge> {
  const absolute = resolve(dir);
  const F = KNOWLEDGE_FILES;
  const names = Object.keys(F) as (keyof typeof F)[];
  // All reads settle before an error is thrown, so a missing file is reported in the fixed
  // order of KNOWLEDGE_FILES, not by whichever read fails first.
  const results = await Promise.allSettled(names.map((name) => readText(absolute, F[name])));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const contents = results.map((result) => (result.status === "fulfilled" ? result.value : ""));
  const files = Object.fromEntries(names.map((name, i) => [name, contents[i] ?? ""]));
  let pack: LocalePack;
  let packs: LocalePack[];
  try {
    pack = await loadLocalePack(absolute, locale);
    packs = await loadAllLocalePacks(absolute);
  } catch (error) {
    if (error instanceof LocalePackError) throw new KnowledgeError(error.message, { cause: error });
    throw error;
  }
  return buildKnowledge(files as unknown as KnowledgeTexts, pack, packs);
}

// A mass limit the loader guaranteed to exist, with its gram value.
export function massLimit(
  knowledge: Knowledge,
  id: RequiredMassLimit,
): MassLimit & { grams: number } {
  const limit = knowledge.massLimits.get(id);
  const grams = limit?.maxGrams ?? limit?.minGrams;
  if (!limit || grams === undefined) throw new KnowledgeError(`mass limit ${id} is missing`);
  return { ...limit, grams };
}

// The value of a recommended-limit rule the loader guaranteed to exist.
export function ruleValue(knowledge: Knowledge, id: RequiredRule): number {
  const value = knowledge.recommended.rules.find((rule) => rule.id === id)?.value;
  if (value === undefined) throw new KnowledgeError(`rule ${id} is missing`);
  return value;
}

// A standard phrase of the output language the loader guaranteed to exist.
export function phrase(knowledge: Knowledge, id: (typeof REQUIRED_PHRASES)[number]): string {
  return knowledge.pack.phrases.standardPhrases[id] ?? id;
}

export function techniqueById(knowledge: Knowledge, id: string): Technique | undefined {
  return knowledge.techniques.find((technique) => technique.id === id);
}

export interface TechniqueSelection {
  // Full entries of the selected techniques, in knowledge-file order.
  techniques: Technique[];
}

// Which device modes this installation can run (see usableModes in prompt.ts).
export type ModeFilter = (mode: string) => boolean;
const anyMode: ModeFilter = () => true;

// Techniques the prompt never offers, with the reason. The device has a precleaning
// program, but official recipes rinse the bowl in a text step instead.
export const PROMPT_EXCLUDED_TECHNIQUES: Readonly<Record<string, string>> = {
  preclean: "official recipes rinse the bowl in a text step instead",
};

// The techniques the prompt may offer: their main program runs on this installation.
export function offeredTechniques(knowledge: Knowledge, usable: ModeFilter = anyMode): Technique[] {
  return knowledge.techniques.filter(
    (technique) => !(technique.id in PROMPT_EXCLUDED_TECHNIQUES) && usable(technique.device.mode),
  );
}

// One summary line per offered technique, for the static part of the system prompt.
export function techniqueSummary(knowledge: Knowledge, usable: ModeFilter = anyMode): string[] {
  return offeredTechniques(knowledge, usable).map(techniqueSummaryLine);
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whether a phrase starts a word somewhere in the text.
function occurs(text: string, phrase: string): boolean {
  return new RegExp(`(?<!\\p{L})${escapeRegex(phrase.toLowerCase())}`, "u").test(text);
}

function countHits(text: string, phrases: readonly string[]): number {
  return phrases.filter((phrase) => occurs(text, phrase)).length;
}

function rangeText(value: { typical: number; range?: [number, number] | undefined }): string {
  const [low, high] = value.range ?? [value.typical, value.typical];
  return low === high ? `${value.typical}` : `${value.typical} (${low}-${high})`;
}

// One line: "chop_onion_garlic: Chop onions... | customized, 6 (5-10) s, speed 6 (max 8)".
export function techniqueSummaryLine(technique: Technique): string {
  const d = technique.device;
  const parts: string[] = [d.mode];
  if (d.temperature && !(d.temperature.typical === 0 && (d.temperature.range?.[1] ?? 0) === 0)) {
    parts.push(`${rangeText(d.temperature)} °C`);
  }
  if (d.timeSeconds) parts.push(`${rangeText(d.timeSeconds)} s`);
  if (d.speed) parts.push(`speed ${d.speed.typical}${d.speed.max ? ` (max ${d.speed.max})` : ""}`);
  if (d.weightGrams) parts.push(`${rangeText(d.weightGrams)} g`);
  if (d.modeSetting) {
    const settings = Object.entries(d.modeSetting)
      .map(([key, value]) => (value.typical ? `${key} ${value.typical}` : key))
      .join(", ");
    parts.push(settings);
  }
  if (d.reverse === true) parts.push("reverse");
  if (d.accessory?.attachment) parts.push(d.accessory.attachment);
  return `${technique.id}: ${technique.label} | ${parts.join(", ")}`;
}

// An ingredient class with a hit scores this much. Classes such as liquid or dairy occur in
// almost every recipe, so at a full point they outweighed the aliases and picked yeast
// dough for a custard; at a quarter they only decide between techniques of the same verb.
export const CLASS_HIT_SCORE = 0.25;

// Picks the offered techniques whose aliases (of any pack) or ingredient classes occur in
// the recipe. The techniques of ALWAYS_SELECTED are always in; the others rank by score,
// ties in knowledge-file order. An alias hit scores 3 divided by the number of techniques
// that share the alias ("zerkleinern" names five chopping techniques), an ingredient class
// with a hit scores CLASS_HIT_SCORE, so the ingredients decide between techniques of the
// same verb.
export function selectTechniques(
  request: Pick<ConversionRequest, "title" | "rendered" | "ingredients">,
  knowledge: Knowledge,
  max = 12,
  usable: ModeFilter = anyMode,
): TechniqueSelection {
  const text = [request.title, request.rendered, ...request.ingredients.map((i) => i.food)]
    .join("\n")
    .toLowerCase();
  const aliasesOf = (technique: Technique) => knowledge.selectionAliases[technique.id] ?? [];
  const shared = new Map<string, number>();
  for (const technique of knowledge.techniques) {
    for (const alias of aliasesOf(technique)) shared.set(alias, (shared.get(alias) ?? 0) + 1);
  }
  const always = new Set<string>(ALWAYS_SELECTED);
  const offered = offeredTechniques(knowledge, usable);
  const scored = offered
    .map((technique, order) => {
      const aliasScore = aliasesOf(technique)
        .filter((alias) => occurs(text, alias))
        .reduce((sum, alias) => sum + 3 / (shared.get(alias) ?? 1), 0);
      const classHits = technique.ingredientClasses.filter(
        (name) => countHits(text, knowledge.ingredientClassWords[name] ?? []) > 0,
      ).length;
      return { technique, order, score: aliasScore + classHits * CLASS_HIT_SCORE };
    })
    .filter(({ technique, score }) => !always.has(technique.id) && score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen = new Set<string>(always);
  for (const { technique } of scored) {
    if (chosen.size >= max) break;
    chosen.add(technique.id);
  }
  return { techniques: offered.filter((technique) => chosen.has(technique.id)) };
}
