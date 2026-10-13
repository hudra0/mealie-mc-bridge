// Builds the prompts. The system prompt carries only what is the same for every recipe of
// an installation (role, device limits, conversion rules, technique table, timing and unit
// rules, output contract), so the providers' prompt caches reuse all of it across recipes.
// The user message carries the category list, the servings, the full entries of the
// techniques picked for this recipe and the recipe, and on a correction round the errors
// and the previous answer.
//
// The instructions are English for every output language; the language itself, its unit
// spellings, standard phrases and wording rules come from the locale pack in the knowledge
// base (knowledge.pack).

import { z } from "zod";
import type {
  DeviceLimits,
  LimitCondition,
  LimitValue,
  ModeLimits,
  ParamLimit,
} from "../recipe/limits.js";
import { StepSchema } from "../recipe/schema.js";
import { techniqueSummary, type Knowledge, type ModeFilter, type Technique } from "./knowledge.js";
import type { ConversionRequest, GenerationFeedback } from "./types.js";

export interface Category {
  id: number;
  name: string;
}

export interface SystemPromptOptions {
  // Attachments this installation has, for example "food_processor_attachment".
  attachments?: readonly string[];
}

export interface UserMessageOptions {
  // Techniques picked for this recipe (selectTechniques), printed in full.
  techniques?: readonly Technique[];
  // The technique wording of the output language (knowledge.aliases) and its name.
  aliases?: Readonly<Record<string, readonly string[]>>;
  languageName?: string;
  // The modes this installation can run (usableModes); alternatives in other modes are
  // left out of the technique entries.
  usable?: ModeFilter;
  feedback?: GenerationFeedback;
}

// Section headings of the system prompt, in their fixed order.
export const SYSTEM_SECTIONS = [
  "Role and goal",
  "Device limits",
  "Conversion rules",
  "Wording",
  "Techniques",
  "Timing",
  "Units",
  "Output contract",
] as const;

const section = (title: (typeof SYSTEM_SECTIONS)[number], body: string) => `# ${title}\n\n${body}`;

function roleSection(knowledge: Knowledge): string {
  const { language } = knowledge.pack.mc;
  const full = `${language} (${knowledge.locale})`;
  return section(
    "Role and goal",
    [
      "You convert one recipe from the Mealie recipe manager into a guided-cooking recipe for the Monsieur Cuisine Smart kitchen machine (model MC3.0). The recipe is uploaded as a private draft and cooked from the device step by step, so every step has to work on that device exactly as written.",
      "",
      "- Target only the MC3.0. Use its programs where they fit and keep the dish the same; reordering and simplifying steps is fine.",
      `- Write every text of the recipe in ${full}: title, description, ingredient names, step titles and descriptions, servingSize.instruction and reviewHints.`,
      "- Never invent amounts and never drop an ingredient. The amounts in the input are already scaled to the servings in the user message; keep them and change units only as the unit rules say.",
      `- When something is unclear or guessed (an amount, a time, a missing step, an ingredient line that could not be parsed), take the most plausible reading and add a short ${language} review hint so the cook checks it.`,
      "- Never mention that the recipe was converted or adapted.",
    ].join("\n"),
  );
}

// The modes a recipe for this installation may use: allowed by the device limits and with
// every attachment they need.
export function usableModes(limits: DeviceLimits, attachments: readonly string[] = []): ModeFilter {
  return (id) => {
    const mode = limits.modes.get(id);
    return (
      mode !== undefined &&
      mode.allowed &&
      mode.requires.every((required) => attachments.includes(required))
    );
  };
}

// The knowledge files name their sources and each other; the model sees only the prompt.
// These rewrites point file names to prompt sections and drop provenance remarks.
export const PROMPT_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/\s*\((?:bridge and )?SmartRecipe (?:rules?|flag [^)]*)\)/g, ""],
  [/SmartRecipe rules?: /g, ""],
  [/;\s*SmartRecipe rule [^;)]*/g, ""],
  [/;?\s*the device limits come from SmartRecipe/g, ""],
  [/`?units\.json`? pieceWeights/g, "the piece weights of the Units section"],
  [/\(`?techniques\.json`?\)/g, "(see the Techniques section)"],
  [/`?techniques\.json`?/g, "the Techniques section"],
  [/`?timing-model\.json`?/g, "the Timing section"],
  [/`?device-(?:limits|programs)\.json`?/g, "the Device limits section"],
  [/`?units\.json`?/g, "the Units section"],
];

export function promptText(text: string): string {
  return PROMPT_REWRITES.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

const anyMode: ModeFilter = () => true;

// "0, 37, 40-130 in steps of 5": runs of three or more equally spaced values are shortened.
export function compactValues(values: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < values.length) {
    const start = values[i] as number;
    let j = i + 1;
    const stepSize = j < values.length ? (values[j] as number) - start : 0;
    while (j < values.length && (values[j] as number) - (values[j - 1] as number) === stepSize) j++;
    if (j - i >= 3 && stepSize > 0) {
      const end = values[j - 1] as number;
      parts.push(stepSize === 1 ? `${start}-${end}` : `${start}-${end} in steps of ${stepSize}`);
      i = j;
    } else {
      parts.push(String(start));
      i++;
    }
  }
  return parts.join(", ");
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} s`;
  if (totalSeconds % 3600 === 0 && totalSeconds >= 3600) return `${totalSeconds / 3600} h`;
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

const OP_WORDS: Readonly<Record<string, string>> = {
  eq: "is",
  ne: "is not",
  gt: "is above",
  gte: "is at least",
  lt: "is below",
  lte: "is at most",
};

function conditionText(condition: LimitCondition, param: string): string {
  const clauses = Object.entries(condition.when).flatMap(([field, ops]) =>
    Object.entries(ops ?? {}).map(([op, expected]) => {
      if (field === "clockwise") return `rotation is ${expected === false ? "left" : "right"}`;
      if (field === "accessory") return `the ${String(expected).replace(/_/g, " ")} is fitted`;
      const shown =
        field === "time" && typeof expected === "number"
          ? formatDuration(expected)
          : String(expected);
      return `${field} ${OP_WORDS[op] ?? op} ${shown}`;
    }),
  );
  const limits = Object.entries(condition.set).map(([key, value]) => {
    const shown =
      param === "time" && typeof value === "number" ? formatDuration(value) : String(value);
    return key === "max"
      ? `at most ${shown}`
      : key === "min"
        ? `at least ${shown}`
        : `${key} ${shown}`;
  });
  return `${limits.join(", ")} when ${clauses.join(" and ")}`;
}

function valueText(value: LimitValue): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function paramText(name: string, limit: ParamLimit, kind: string): string {
  const conditions = limit.conditions.map((condition) => conditionText(condition, name));
  const extra = conditions.length > 0 ? `; ${conditions.join("; ")}` : "";
  switch (name) {
    case "temperature":
      if (limit.values) {
        return `temperature °C one of ${compactValues(limit.values.filter((v): v is number => typeof v === "number"))}${extra}`;
      }
      return `temperature ${limit.min ?? 0}-${limit.max ?? 0} °C${limit.step && limit.step !== 1 ? ` in steps of ${limit.step}` : ""}${extra}`;
    case "time": {
      const field = kind === "turbo" ? "seconds" : "minutes + seconds";
      const range = `${formatDuration(limit.min ?? 0)} to ${formatDuration(limit.max ?? 0)}`;
      const whole = limit.step === 60 ? ", whole minutes only (seconds 0)" : "";
      return `time (${field}) ${range}${whole}${extra}`;
    }
    case "speed":
      return `speed ${limit.min ?? 1}-${limit.max ?? 10}${extra}`;
    case "clockwise":
      return `rotation "right" (normal) or "left" (reverse, gentle)${extra}`;
    case "weight":
      return `grams ${limit.min ?? 0}-${limit.max ?? 0}${extra}`;
    default:
      if (limit.values) return `${name} one of ${limit.values.map(valueText).join(", ")}${extra}`;
      return `${name} ${limit.min ?? ""}-${limit.max ?? ""}${extra}`;
  }
}

// Input fields per step kind, read from the step schema so the prompt never drifts from it.
export function stepFields(): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const option of StepSchema.options) {
    const shape = option.shape as Record<string, z.ZodType>;
    const kindSchema = shape.kind as z.ZodLiteral<string>;
    const kind = String(kindSchema.value);
    const keys = Object.entries(shape)
      .filter(([key]) => key !== "kind")
      .map(([key, schema]) => (schema instanceof z.ZodOptional ? `${key} (optional)` : key));
    fields.set(kind, keys);
  }
  return fields;
}

function modeLine(
  mode: ModeLimits,
  fields: ReadonlyMap<string, string[]>,
  attachments: readonly string[],
  shown: ReadonlySet<string>,
): string {
  if (!mode.allowed) {
    return `- ${mode.id}: do not use${mode.reason ? `. ${mode.reason}` : ""}`;
  }
  const missing = mode.requires.filter((required) => !attachments.includes(required));
  if (missing.length > 0) {
    return `- ${mode.id}: do not use; it needs the ${missing.map((m) => m.replace(/_/g, " ")).join(" and ")}, which this installation does not have`;
  }
  const params = Object.entries(mode.params).map(([name, limit]) =>
    paramText(name, limit, mode.id),
  );
  const description = shown.has(mode.id) ? "description required" : "no description";
  const keys = fields.get(mode.id);
  const parts = [...params, description];
  if (keys) parts.push(`fields: ${keys.join(", ")}`);
  return `- ${mode.id}: ${parts.join("; ")}`;
}

function limitsSection(limits: DeviceLimits, attachments: readonly string[]): string {
  const r = limits.recipe;
  const fields = stepFields();
  const shown = new Set(r.stepDescription.requiredOn);
  const recipe = [
    "The validator rejects every recipe outside these limits.",
    "",
    "## Recipe",
    "",
    `- title ${r.recipeTitle.min}-${r.recipeTitle.max} characters; description at most ${r.recipeDescription.max} characters.`,
    `- servingSize.amount ${r.servings.min}-${r.servings.max}${r.servings.step === 1 ? " (whole numbers)" : `, in steps of ${r.servings.step}`}.`,
    `- categoryIds: ${r.categories.min}-${r.categories.max} ids from the category list in the user message, each once.`,
    `- servingSize.preparationTime ${r.preparationTime.min}-${r.preparationTime.max} min; servingSize.readyInTime ${r.readyInTime.min}-${r.readyInTime.max} min and never shorter than preparationTime.`,
    `- nutrients (optional, per serving): names ${r.nutrients.names.join(", ")}; amounts ${r.nutrients.min}-${r.nutrients.max}. Leave out what you do not know.`,
    `- Step title ${r.stepTitle.min}-${r.stepTitle.max} characters. Step description ${r.stepDescription.min}-${r.stepDescription.max} characters, required on ${r.stepDescription.requiredOn.join(", ")} steps; every other step has no description, because the device shows only its title.`,
    "",
    "## Programs",
    "",
    'Each step has a "kind": "text" for an instruction without a program, or one of the programs below. Times are given as minutes plus seconds (seconds 0-59, so 90 s is 1 min 30 s); turbo takes seconds only.',
    "",
    `- text: an instruction shown on the device; fields: ${(fields.get("text") ?? []).join(", ")}`,
  ];
  const modes = [...limits.modes.values()].map((mode) =>
    modeLine(mode, fields, attachments, shown),
  );
  return section("Device limits", [...recipe, ...modes].join("\n"));
}

// Drops a document's "# " title and tightens Markdown tables: the padding Prettier adds
// costs tokens and tells the model nothing.
export function documentBody(markdown: string): string {
  const lines = markdown.split("\n");
  const body = lines[0]?.startsWith("# ") ? lines.slice(1) : lines;
  return body
    .map((line) => {
      if (!line.startsWith("|")) return line;
      if (/^\|[\s:|-]+\|$/.test(line)) return line.replace(/-+/g, "-").replace(/ +/g, "");
      return line.replace(/ {2,}/g, " ");
    })
    .join("\n")
    .trim();
}

function rangeText(value: { typical: number; range?: [number, number] | undefined }, unit: string) {
  const [low, high] = value.range ?? [value.typical, value.typical];
  return low === high ? `${value.typical} ${unit}` : `${value.typical} ${unit} (${low}-${high})`;
}

// A fitted time formula below this R² predicts nothing (the simmering fit has 0.07) and only
// pads times, so the prompt leaves it out. Physical formulas carry no R² and stay.
export const MIN_FORMULA_R2 = 0.3;

export function techniqueDetail(
  technique: Technique,
  usable: ModeFilter = anyMode,
  wording: { aliases?: readonly string[]; languageName?: string } = {},
): string {
  const d = technique.device;
  const lines = [`### ${technique.id}: ${technique.label}`, ""];
  const aliases = wording.aliases ?? [];
  if (aliases.length > 0) {
    lines.push(`- ${wording.languageName ?? "Recipe"} wording: ${aliases.join(", ")}`);
  }
  if (technique.ingredientClasses.length > 0) {
    lines.push(`- Ingredients: ${technique.ingredientClasses.join(", ")}`);
  }
  const program: string[] = [d.mode];
  if (d.temperature) program.push(`temperature ${rangeText(d.temperature, "°C")}`);
  if (d.timeSeconds) program.push(`time ${rangeText(d.timeSeconds, "s")}`);
  if (d.speed)
    program.push(`speed ${d.speed.typical}${d.speed.max ? ` (max ${d.speed.max})` : ""}`);
  if (d.weightGrams) program.push(`weight ${rangeText(d.weightGrams, "g")}`);
  if (d.modeSetting) {
    for (const [key, value] of Object.entries(d.modeSetting)) {
      if (value.typical) program.push(`${key} ${value.typical}`);
    }
  }
  if (d.reverse === true) program.push("reverse");
  else if (typeof d.reverse === "string") program.push(`reverse: ${d.reverse}`);
  if (d.turbo) program.push("turbo");
  if (d.accessory?.measuringCup && d.accessory.measuringCup !== "n/a") {
    program.push(`measuring cup ${d.accessory.measuringCup}`);
  }
  if (d.accessory?.attachment) program.push(`attachment ${d.accessory.attachment}`);
  lines.push(`- Program: ${program.join("; ")}`);
  if (d.temperature?.note) lines.push(`- Temperature: ${d.temperature.note}`);
  const fit = d.timeSeconds?.formulaR2;
  if (d.timeSeconds?.formula && (fit === undefined || fit >= MIN_FORMULA_R2)) {
    lines.push(
      `- Time formula: ${d.timeSeconds.formula}${d.timeSeconds.formulaNote ? ` (${d.timeSeconds.formulaNote})` : ""}`,
    );
  }
  for (const alternative of technique.alternatives ?? []) {
    if (!usable(alternative.mode)) continue;
    const parts = [alternative.mode];
    if (alternative.temperature) parts.push(rangeText(alternative.temperature, "°C"));
    if (alternative.timeSeconds) parts.push(rangeText(alternative.timeSeconds, "s"));
    if (alternative.speed) {
      parts.push(
        `speed ${alternative.speed.typical}${alternative.speed.max ? ` (max ${alternative.speed.max})` : ""}`,
      );
    }
    lines.push(
      `- Alternative: ${parts.join(", ")}${alternative.note ? `. ${alternative.note}` : ""}`,
    );
  }
  if (technique.timeByLoadClass) {
    const loads = Object.entries(technique.timeByLoadClass)
      .map(([load, value]) => `${load} ${rangeText(value, "s")}`)
      .join("; ");
    lines.push(`- Time by load: ${loads}`);
  }
  for (const rule of technique.structure) lines.push(`- ${rule}`);
  for (const note of technique.notes ?? []) lines.push(`- Note: ${note}`);
  return promptText(lines.join("\n"));
}

function techniquesSection(knowledge: Knowledge, usable: ModeFilter): string {
  return section(
    "Techniques",
    [
      "The techniques this installation can run, one line each (id: label | program, typical value with the p10-p90 range of official recipes in parentheses). The user message adds the full entries of the techniques the recipe probably needs; prefer their programs and values. The cooking goal sets the time, not the mass.",
      "",
      ...techniqueSummary(knowledge, usable).map((line) => `- ${line}`),
    ].join("\n"),
  );
}

const byTemperature = (
  table: Readonly<Record<string, { typical: number; range?: [number, number] | undefined }>>,
) =>
  Object.entries(table)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([temperature, value]) => `${temperature} °C ${rangeText(value, "s")}`)
    .join("; ");

function timingSection(knowledge: Knowledge): string {
  const t = knowledge.timing;
  const c = t.constants;
  const h = knowledge.heatUp;
  const lines = [
    `- Heat-up: tMin = grams / 1000 × ${c.heatCapacityJoulePerKgKelvin} × (min(T, 100) − ${c.startTemperatureC}) / (${c.heaterWatts} × ${c.efficiency}) seconds, about ${t.functions.tMinSeconds.secondsPerKgToBoil} s per kg of watery contents to the boil. A heated manual step at ${h.minTemperature} °C or more on contents below that temperature must last at least ${h.warningFactor} × tMin; below ${h.errorFactor} × tMin the recipe is rejected.${h.typicalFactor !== undefined ? ` Official first heatings of cold contents run about ${h.typicalFactor} × tMin; that factor is not a target for later steps.` : ""} Cold ingredients added to hot contents cool them to the mixing temperature, and tMin then counts from there for the whole bowl: sautéed onions plus a litre of cold stock need nearly the full heat-up again. Hot additions such as hot stock barely cool the bowl. Steps on contents that are still hot are often shorter than tMin in official recipes; do not pad them. The cooking goal sets the time beyond the heat-up. Roasting does not follow this model.`,
  ];
  if (t.manualCooking.note) lines.push(`- Manual cooking: ${t.manualCooking.note}`);
  lines.push(
    `- Manual cooking time by temperature: ${byTemperature(t.manualCooking.defaultsByTemperature)}.`,
  );
  lines.push(
    `- Roasting${t.roasting.note ? `: ${t.roasting.note}` : ""} Time by temperature: ${byTemperature(t.roasting.defaultsByTemperature)}.`,
  );
  const loads = Object.entries(t.steaming.byLoadClass)
    .map(([load, value]) => `${load} ${rangeText(value, "s")}`)
    .join("; ");
  lines.push(`- Steaming${t.steaming.note ? `: ${t.steaming.note}` : ""} Time by load: ${loads}.`);
  if (t.steaming.liquidWeighedBefore) {
    lines.push(
      `- Water or stock weighed in before steaming: ${rangeText(t.steaming.liquidWeighedBefore, "g")}.`,
    );
  }
  for (const [name, note] of [
    ["Kneading", t.kneading.note],
    ["Blending", t.blending.note],
    ["Chopping", t.chopping.note],
  ] as const) {
    if (note) lines.push(`- ${name}: ${note}`);
  }
  lines.push("", "Mass limits:", "");
  for (const limit of t.massLimits) {
    const bound =
      limit.maxGrams !== undefined
        ? `at most ${limit.maxGrams} g`
        : limit.minGrams !== undefined
          ? `at least ${limit.minGrams} g`
          : undefined;
    const rule = bound
      ? `${bound} for ${limit.appliesTo}`
      : `${limit.condition ?? ""} (${limit.appliesTo})`;
    lines.push(`- ${limit.id} (${limit.severity}): ${rule}`);
  }
  if (t.temperatureNotes.length > 0)
    lines.push("", ...t.temperatureNotes.map((note) => `- ${note}`));
  if (t.durations?.rule) lines.push(`- ${t.durations.rule}`);
  return section("Timing", lines.join("\n"));
}

function gramsPerUnitText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return `, ${value} g each`;
  if (value === "pieceWeights") return ", grams from the piece weights";
  if (typeof value === "string") return `, ${value.replace(/ ?\* ?/g, " × ")} g each`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, number>).map(
      ([name, grams]) => `${name} ${grams} g`,
    );
    return `, ${entries.join(", ")}`;
  }
  return "";
}

function unitsSection(knowledge: Knowledge): string {
  const u = knowledge.units;
  const grid = u.roundingGrid.grams
    .map(
      ({ band: [from, to], step }) =>
        `${to === null ? `from ${from} g` : `${Math.max(from, step)}-${to} g`}: steps of ${step} g`,
    )
    .join("; ");
  const densities = Object.entries(u.densities)
    .filter(([, value]) => typeof value === "number")
    .map(([name, value]) => `${name} ${String(value)}`)
    .join(", ");
  const pieces = u.pieceWeights.items.map((item) => `${item.name} ${item.grams} g`).join("; ");
  const lines = [
    "Allowed units in the ingredient list:",
    "",
    ...u.allowedUnits.map(
      (entry) => `- ${entry.unit === "" ? "(empty)" : entry.unit}: ${entry.use}`,
    ),
    "",
    ...u.notAllowed.map((rule) => `- Not allowed: ${rule}`),
    ...u.amountFormat.rules.map((rule) => `- ${rule}`),
    `- Gram grid for weighed amounts (under 5 g nothing is weighed): ${grid}.${u.roundingGrid.spoons ? ` ${u.roundingGrid.spoons}` : ""}`,
    "",
    "Converting units of the source recipe:",
    "",
    ...u.freeTextMapping.map((entry) => {
      const extra = [entry.nameRule, entry.note].filter(Boolean).join("; ");
      return `- ${entry.input.filter((input) => input !== "").join(", ")} → ${entry.target}${gramsPerUnitText(entry.gramsPerUnit)}${extra ? ` (${extra})` : ""}`;
    }),
    `- Densities in g per ml: ${densities}.`,
    `- Piece weights: ${pieces}.`,
    "",
    ...u.nameConventions.map((rule) => `- ${rule}`),
  ];
  if (u.groups?.style) lines.push(`- Ingredient groups: ${u.groups.style}`);
  return section("Units", lines.join("\n"));
}

function outputSection(limits: DeviceLimits, knowledge: Knowledge): string {
  const r = limits.recipe;
  const { language } = knowledge.pack.mc;
  return section(
    "Output contract",
    [
      "- Answer with exactly one JSON object that matches the response schema: no prose, no Markdown, no code fences.",
      `- locale is "${knowledge.locale}". complexity is easy, medium or hard.`,
      "- servingSize.amount is the servings from the user message. Only when a device limit forces a smaller batch, scale the whole recipe down and say so in reviewHints.",
      `- categoryIds: ${r.categories.min}-${r.categories.max} ids, only from the category list in the user message; prefer categories that match the Mealie category hints.`,
      `- servingSize.instruction (optional): the whole recipe as plain ${language} text for reading without the device.`,
      `- reviewHints: short ${language} notes, at most 200 characters each and 20 in total, for everything guessed, converted with uncertainty or left out. Leave the list empty when nothing is uncertain.`,
      "- ingredientMapping: one entry per ingredient-list name, written exactly as in the list, with the index [i] of the source ingredient line it comes from (the recipe in the user message numbers them), or null for an ingredient the source does not have. Every source line appears at least once.",
      '- Every step has a "kind" from the program list and only the fields of that kind. Set accessory to "butterfly_whisk" on every manual step that runs while the whisk is fitted.',
      "- Do not set a status, ids or images; the bridge sets them.",
      "- When the user message lists errors in a previous answer, fix every one of them and return the complete corrected recipe, not only the changed parts.",
    ].join("\n"),
  );
}

export function buildSystemPrompt(
  knowledge: Knowledge,
  limits: DeviceLimits,
  options: SystemPromptOptions = {},
): string {
  const attachments = options.attachments ?? [];
  const usable = usableModes(limits, attachments);
  return promptText(
    [
      roleSection(knowledge),
      limitsSection(limits, attachments),
      section("Conversion rules", documentBody(knowledge.promptRules)),
      section("Wording", documentBody(knowledge.languageRules)),
      techniquesSection(knowledge, usable),
      timingSection(knowledge),
      unitsSection(knowledge),
      outputSection(limits, knowledge),
    ].join("\n\n"),
  );
}

export function formatFeedback(feedback: GenerationFeedback): string {
  const errors = feedback.errors.map(
    (error, index) => `${index + 1}. ${error.path}: ${error.message}`,
  );
  return [
    "# Correction",
    "",
    "Your previous answer did not pass the checks. These are the errors:",
    "",
    ...errors,
    "",
    "Fix every error and return the full corrected recipe as one JSON object. Keep everything that was not wrong.",
    "",
    "Your previous answer:",
    "",
    "```json",
    feedback.previousJson.trim(),
    "```",
  ].join("\n");
}

// The user message with the correction section appended when there is feedback.
export function withFeedback(user: string, feedback?: GenerationFeedback): string {
  return feedback ? `${user.trimEnd()}\n\n${formatFeedback(feedback)}\n` : user;
}

// Throws when the category list is empty: the model cannot know category ids, so it must
// never be asked to guess them.
export function buildUserMessage(
  request: ConversionRequest,
  categories: readonly Category[],
  options: UserMessageOptions = {},
): string {
  if (categories.length === 0) {
    throw new RangeError("buildUserMessage needs a category list; the model must not guess ids");
  }
  const list = [...categories].sort((a, b) => a.id - b.id).map((c) => `- ${c.id}: ${c.name}`);
  const hints = (request.categoryHints ?? []).filter((hint) => hint.trim() !== "");
  const techniques = options.techniques ?? [];
  const parts = [
    "# Categories",
    "",
    "Pick categoryIds only from this list (id: name):",
    "",
    ...list,
    "",
    "# Servings",
    "",
    `The amounts below are scaled to ${request.servings} servings. Set servingSize.amount to ${request.servings}.`,
  ];
  if (hints.length > 0) {
    parts.push("", "# Mealie categories", "", hints.join(", "));
  }
  if (techniques.length > 0) {
    parts.push(
      "",
      "# Techniques for this recipe",
      "",
      "Full entries for the techniques this recipe probably needs:",
      "",
      techniques
        .map((technique) =>
          techniqueDetail(technique, options.usable, {
            aliases: options.aliases?.[technique.id] ?? [],
            ...(options.languageName ? { languageName: options.languageName } : {}),
          }),
        )
        .join("\n\n"),
    );
  }
  const indexed = hasIngredientIndices(request);
  parts.push(
    "",
    "# Recipe",
    "",
    `The source ingredient lines carry their index [0] to [${Math.max(0, request.ingredients.length - 1)}]; ingredientMapping refers to them.`,
    "",
    request.rendered.trim(),
    "",
  );
  if (!indexed && request.ingredients.length > 0) {
    parts.push("# Source ingredient indices", "", ...ingredientIndexLines(request), "");
  }
  return withFeedback(parts.join("\n"), options.feedback);
}

// Whether the rendered recipe numbers every source ingredient line ("- [3] 2 EL Öl"), as
// renderRecipeForLlm does.
export function hasIngredientIndices(request: Pick<ConversionRequest, "rendered" | "ingredients">) {
  const found = new Set(
    [...request.rendered.matchAll(/^- \[(\d+)\]/gm)].map((match) => Number(match[1])),
  );
  return request.ingredients.every((_, position) => found.has(position));
}

// One line per source ingredient with its index, for a rendered recipe without them.
export function ingredientIndexLines(request: Pick<ConversionRequest, "ingredients">): string[] {
  return request.ingredients.map((ingredient, position) => {
    const text =
      ingredient.original.trim() ||
      [ingredient.quantity ?? "", ingredient.unit ?? "", ingredient.food]
        .filter((part) => part !== "")
        .join(" ");
    return `- [${position}] ${text}`;
  });
}
