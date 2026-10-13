// Loads the knowledge base the prompt and the plausibility checks use: cooking techniques,
// the timing model, unit rules, recommended device ranges and the two rule documents.
// Each JSON file is checked leniently: only the fields this module reads must be present,
// everything else passes through. A missing file or a missing field fails the load, so a
// broken knowledge base never reaches a conversion.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ConversionRequest } from "./types.js";

export const DEFAULT_KNOWLEDGE_DIR = "./knowledge";

export const KNOWLEDGE_FILES = {
  techniques: "techniques.json",
  timing: "timing-model.json",
  units: "units.json",
  recommended: "device-limits.json",
  promptRules: "prompt-rules.md",
  stepPatterns: "step-patterns.md",
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
});
const speed = z.looseObject({ typical: z.number(), max: z.number().optional() });

const techniqueSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string(),
  aliases: z.looseObject({
    de: z.array(z.string()).default([]),
    en: z.array(z.string()).default([]),
  }),
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

const gramsPerUnit = z.union([z.number(), z.string(), z.record(z.string(), z.number()), z.null()]);

const unitsFileSchema = z.looseObject({
  allowedUnits: z.array(z.looseObject({ unit: z.string(), use: z.string() })).min(1),
  notAllowed: z.array(z.string()).default([]),
  amountFormat: z.looseObject({ rules: z.array(z.string()) }),
  roundingGrid: z.looseObject({
    grams: z.array(
      z.looseObject({ band: z.tuple([z.number(), z.number().nullable()]), step: z.number() }),
    ),
    spoons: z.string().optional(),
  }),
  freeTextMapping: z.array(
    z.looseObject({
      input: z.array(z.string()),
      target: z.string(),
      gramsPerUnit: gramsPerUnit.optional(),
      nameRule: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
  densities: z.record(z.string(), z.union([z.number(), z.string()])),
  pieceWeights: z.looseObject({
    items: z.array(z.looseObject({ name: z.string(), unit: z.string(), grams: z.number() })),
  }),
  nameConventions: z.array(z.string()).default([]),
  groups: z.looseObject({ style: z.string().optional() }).optional(),
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

export type Technique = z.infer<typeof techniqueSchema>;
export type TimingModel = z.infer<typeof timingFileSchema>;
export type UnitsKnowledge = z.infer<typeof unitsFileSchema>;
export type RecommendedLimits = z.infer<typeof recommendedFileSchema>;
export type MassLimit = z.infer<typeof massLimitSchema>;

export interface HeatUpThresholds {
  // A first heating shorter than errorFactor x tMin is an error, shorter than
  // warningFactor x tMin a warning.
  errorFactor: number;
  warningFactor: number;
  // The check applies from this temperature up.
  minTemperature: number;
}

export interface Knowledge {
  techniques: Technique[];
  timing: TimingModel;
  units: UnitsKnowledge;
  recommended: RecommendedLimits;
  // The rule documents as written, Markdown.
  promptRules: string;
  stepPatterns: string;
  heatUp: HeatUpThresholds;
  massLimits: ReadonlyMap<string, MassLimit>;
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
  return {
    errorFactor: factorOf(error?.condition, "heatup_too_short"),
    warningFactor: factorOf(warning?.condition, "heatup_short"),
    minTemperature,
  };
}

export interface KnowledgeTexts {
  techniques: string;
  timing: string;
  units: string;
  recommended: string;
  promptRules: string;
  stepPatterns: string;
}

// Checks the file contents and builds the knowledge object.
export function buildKnowledge(files: KnowledgeTexts): Knowledge {
  const F = KNOWLEDGE_FILES;
  const techniques = parseJson(techniquesFileSchema, files.techniques, F.techniques).techniques;
  const timing = parseJson(timingFileSchema, files.timing, F.timing);
  const units = parseJson(unitsFileSchema, files.units, F.units);
  const recommended = parseJson(recommendedFileSchema, files.recommended, F.recommended);

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
  return {
    techniques,
    timing,
    units,
    recommended,
    promptRules: markdown(files.promptRules, F.promptRules),
    stepPatterns: markdown(files.stepPatterns, F.stepPatterns),
    heatUp: heatUpThresholds(timing),
    massLimits,
  };
}

// Reads the knowledge base from a directory. A relative path resolves against the working
// directory, like DEVICE_PROGRAMS_PATH.
export async function loadKnowledge(dir: string = DEFAULT_KNOWLEDGE_DIR): Promise<Knowledge> {
  const absolute = resolve(dir);
  const F = KNOWLEDGE_FILES;
  const [techniques, timing, units, recommended, promptRules, stepPatterns] = await Promise.all([
    readText(absolute, F.techniques),
    readText(absolute, F.timing),
    readText(absolute, F.units),
    readText(absolute, F.recommended),
    readText(absolute, F.promptRules),
    readText(absolute, F.stepPatterns),
  ]);
  return buildKnowledge({ techniques, timing, units, recommended, promptRules, stepPatterns });
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

export function techniqueById(knowledge: Knowledge, id: string): Technique | undefined {
  return knowledge.techniques.find((technique) => technique.id === id);
}

// German words that point to an ingredient class of techniques.json. A word matches the
// start of a word in the recipe, so "zwiebel" also finds "Zwiebeln" and "Zwiebelwürfel".
export const INGREDIENT_CLASS_WORDS: Readonly<Record<string, readonly string[]>> = {
  onion_garlic: ["zwiebel", "schalotte", "knoblauch", "ingwer", "frühlingszwiebel", "lauchzwiebel"],
  vegetables: [
    "möhre",
    "karotte",
    "paprika",
    "zucchini",
    "tomate",
    "sellerie",
    "lauch",
    "porree",
    "brokkoli",
    "blumenkohl",
    "kohl",
    "aubergine",
    "gurke",
    "kürbis",
    "spinat",
    "erbse",
    "bohne",
    "champignon",
    "pilz",
    "fenchel",
    "spargel",
    "gemüse",
    "linse",
    "kichererbse",
  ],
  herbs: [
    "petersilie",
    "basilikum",
    "schnittlauch",
    "dill",
    "koriander",
    "minze",
    "thymian",
    "rosmarin",
    "oregano",
    "salbei",
    "kräuter",
  ],
  nuts_seeds: [
    "nuss",
    "nüsse",
    "mandel",
    "haselnuss",
    "walnuss",
    "cashew",
    "pinienkern",
    "sesam",
    "kürbiskern",
    "sonnenblumenkern",
    "leinsamen",
    "pistazie",
  ],
  hard_cheese: ["parmesan", "pecorino", "grana", "bergkäse", "hartkäse"],
  chocolate: ["schokolade", "kuvertüre", "kakao"],
  fruit: [
    "apfel",
    "äpfel",
    "birne",
    "banane",
    "beere",
    "erdbeere",
    "himbeere",
    "kirsche",
    "mango",
    "orange",
    "zitrone",
    "pfirsich",
    "aprikose",
    "pflaume",
    "ananas",
    "obst",
  ],
  meat: [
    "fleisch",
    "hähnchen",
    "huhn",
    "rind",
    "schwein",
    "hackfleisch",
    "gehacktes",
    "speck",
    "schinken",
    "wurst",
    "pute",
    "lamm",
  ],
  fish: ["fisch", "lachs", "thunfisch", "kabeljau", "garnele", "shrimp", "forelle"],
  dairy: [
    "milch",
    "sahne",
    "butter",
    "joghurt",
    "quark",
    "schmand",
    "frischkäse",
    "mascarpone",
    "crème",
  ],
  egg: ["eier", "eigelb", "eiweiß", "eiklar"],
  flour_dough: ["mehl", "hefe", "teig", "backpulver", "stärke"],
  sugar_spices: ["zucker", "zimt", "pfeffer", "kümmel", "gewürz", "vanille", "muskat"],
  bread_biscuits: ["brot", "brötchen", "semmel", "zwieback", "keks", "biskuit"],
  rice_grain: ["reis", "risotto", "hafer", "grieß", "quinoa", "couscous", "bulgur", "hirse"],
  pasta: ["nudel", "pasta", "spaghetti", "penne", "makkaroni", "tagliatelle", "lasagne"],
  potatoes: ["kartoffel"],
  liquid: ["wasser", "brühe", "fond", "wein", "saft"],
  ice: ["eiswürfel", "crushed ice", "tiefgekühlt", "gefroren"],
};

export interface TechniqueSelection {
  // Full entries of the selected techniques, in knowledge-file order.
  techniques: Technique[];
  // One line per technique of the knowledge base.
  summary: string[];
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whether a phrase starts a word somewhere in the text.
function occurs(text: string, phrase: string): boolean {
  return new RegExp(`(?<!\\p{L})${escapeRegex(phrase.toLowerCase())}`, "u").test(text);
}

function countHits(text: string, phrases: readonly string[]): number {
  return phrases.filter((phrase) => occurs(text, phrase)).length;
}

const aliasesOf = (technique: Technique) => [
  ...new Set([...technique.aliases.de, ...technique.aliases.en].map((a) => a.toLowerCase())),
];

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

// Picks the techniques whose German or English aliases or ingredient classes occur in the
// recipe. The techniques of ALWAYS_SELECTED are always in; the others rank by score, ties
// in knowledge-file order. An alias hit scores 3 divided by the number of techniques that
// share the alias ("zerkleinern" names five chopping techniques), an ingredient class
// with a hit scores 1, so the ingredients decide between techniques of the same verb.
export function selectTechniques(
  request: Pick<ConversionRequest, "title" | "rendered" | "ingredients">,
  knowledge: Knowledge,
  max = 12,
): TechniqueSelection {
  const text = [request.title, request.rendered, ...request.ingredients.map((i) => i.food)]
    .join("\n")
    .toLowerCase();
  const shared = new Map<string, number>();
  for (const technique of knowledge.techniques) {
    for (const alias of aliasesOf(technique)) shared.set(alias, (shared.get(alias) ?? 0) + 1);
  }
  const always = new Set<string>(ALWAYS_SELECTED);
  const scored = knowledge.techniques
    .map((technique, order) => {
      const aliasScore = aliasesOf(technique)
        .filter((alias) => occurs(text, alias))
        .reduce((sum, alias) => sum + 3 / (shared.get(alias) ?? 1), 0);
      const classHits = technique.ingredientClasses.filter(
        (name) => countHits(text, INGREDIENT_CLASS_WORDS[name] ?? []) > 0,
      ).length;
      return { technique, order, score: aliasScore + classHits };
    })
    .filter(({ technique, score }) => !always.has(technique.id) && score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen = new Set<string>(always);
  for (const { technique } of scored) {
    if (chosen.size >= max) break;
    chosen.add(technique.id);
  }
  return {
    techniques: knowledge.techniques.filter((technique) => chosen.has(technique.id)),
    summary: knowledge.techniques.map(techniqueSummaryLine),
  };
}
