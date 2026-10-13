// Converts recipes with the configured language model, for prompt tuning and checks.
// Nothing is uploaded.
//
//   npm run convert -- convert --mealie-json recipe.json [--scale 1.5] [--provider anthropic] [--out result.json]
//   npm run convert -- prompt --mealie-json recipe.json [--scale 1.5]
//   npm run convert:eval -- --ids 101,102 [--corpus-dir local/corpus] [--provider openai]
//
// --locale picks the output language and its locale pack (default MC_LOCALE); eval reads
// local/corpus for de-DE and local/corpus/<locale> otherwise.
//
// The Mealie file is a recipe as GET /api/recipes/{slug} returns it. The API key of the
// selected provider comes from the environment (.env is read when it exists), never from
// an argument. The category list comes from --categories (a JSON file), else from the
// Monsieur Cuisine API (the public endpoint needs no login); without a list the command
// stops, because the model must not guess category ids.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { MissingApiKeyError, loadConfig, type Config, type LlmProvider } from "../src/config.js";
import {
  ConversionFailedError,
  KnowledgeError,
  LlmConfigError,
  buildSystemPrompt,
  buildUserMessage,
  createConverter,
  createGenerator,
  loadKnowledge,
  priceTable,
  selectTechniques,
  usableModes,
  type Category,
  type ConversionRequest,
  type ConversionResult,
  type Knowledge,
  type RecipeGenerator,
} from "../src/convert/index.js";
import {
  normalizeIngredients,
  normalizeUnit,
  scaleIngredients,
  servingsFor,
  type NormalizedIngredient,
} from "../src/ingredients/index.js";
import { LOCALE_PATTERN, type LocalePack } from "../src/locale/pack.js";
import { McTransport, type FetchLike } from "../src/mc/index.js";
import {
  mealieRecipeSchema,
  renderLabels,
  renderRecipeForLlm,
  type RenderLabels,
} from "../src/mealie/index.js";
import { DeviceLimitsError, loadDeviceLimits, type DeviceLimits } from "../src/recipe/limits.js";
import { stepSeconds } from "../src/recipe/modes.js";
import type { RecipeInput, RecipeStep } from "../src/recipe/schema.js";
import { parseAmount, parseDetailFile, stepText } from "./corpus/normalize.js";
import type { RawRecipe } from "./corpus/types.js";

export const EXIT = {
  ok: 0,
  // The input is unreadable or the recipe still had errors after the last correction.
  failed: 1,
  provider: 3,
  usage: 64,
  noInput: 66,
  config: 78,
} as const;

export const USAGE = `Usage: convert <command> [options]

Commands:
  convert --mealie-json <file>   convert a Mealie recipe and print the result (no upload)
      --scale <factor>           scale like Mealie's servings scaler (default 1)
      --provider <name>          openai or anthropic (default LLM_PROVIDER)
      --out <file>               write the conversion result as JSON
  prompt --mealie-json <file>    print the system prompt and the user message
      --scale <factor>
  eval --ids <id,id,...>         convert corpus recipes and compare the programs with the originals
      --corpus-dir <dir>         default local/corpus
      --provider <name>
      --out <file>               write the converted recipes as JSON

Every command takes --locale <locale> (default MC_LOCALE), the output language: it needs a
locale pack in KNOWLEDGE_DIR/locales; eval reads local/corpus for de-DE and
local/corpus/<locale> otherwise. Every command takes --categories <file>: a JSON list of {id, name}, or a category
response of the Monsieur Cuisine API. Without it the list is fetched from the API;
when that fails, the command stops. The provider's API key is read from
OPENAI_API_KEY or ANTHROPIC_API_KEY, the price table from LLM_PRICES_JSON.`;

export interface ConvertContext {
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  // For tests; the global fetch otherwise.
  fetch?: FetchLike;
  // For tests; createGenerator from src/convert otherwise.
  generator?: (config: Config, provider: LlmProvider) => RecipeGenerator;
}

export class UsageError extends Error {}
class InputError extends Error {}

export type Command =
  | {
      name: "convert";
      mealieJson: string;
      scale: number;
      provider?: LlmProvider;
      out?: string;
      categories?: string;
      locale?: string;
    }
  | { name: "prompt"; mealieJson: string; scale: number; categories?: string; locale?: string }
  | {
      name: "eval";
      corpusDir: string;
      ids: number[];
      provider?: LlmProvider;
      out?: string;
      categories?: string;
      locale?: string;
    }
  | { name: "help" };

const PROVIDERS = ["openai", "anthropic"] as const;

export function parseCommand(args: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        "mealie-json": { type: "string" },
        scale: { type: "string" },
        provider: { type: "string" },
        out: { type: "string" },
        categories: { type: "string" },
        "corpus-dir": { type: "string" },
        ids: { type: "string" },
        locale: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const [name, ...rest] = positionals;
  if (values.help || name === "help") return { name: "help" };
  if (name === undefined) throw new UsageError("Missing command");
  if (rest.length > 0) throw new UsageError(`Unexpected argument ${rest.join(" ")}`);

  const provider = values.provider;
  if (provider !== undefined && !(PROVIDERS as readonly string[]).includes(provider)) {
    throw new UsageError(`--provider must be openai or anthropic, not ${provider}`);
  }
  const locale = values.locale;
  if (locale !== undefined && !LOCALE_PATTERN.test(locale)) {
    throw new UsageError(`--locale must look like de-DE, not ${locale}`);
  }
  const scale = values.scale === undefined ? 1 : Number(values.scale);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 100) {
    throw new UsageError("--scale must be a number above 0 and at most 100");
  }
  const optional = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
  const reject = (allowed: readonly string[]) => {
    const used = Object.entries(values)
      .filter(([key, value]) => value !== undefined && key !== "help")
      .map(([key]) => key);
    const extra = used.filter((key) => !allowed.includes(key));
    if (extra.length > 0) throw new UsageError(`--${extra.join(", --")} does not apply to ${name}`);
  };

  switch (name) {
    case "convert":
    case "prompt": {
      reject(
        name === "convert"
          ? ["mealie-json", "scale", "provider", "out", "categories", "locale"]
          : ["mealie-json", "scale", "categories", "locale"],
      );
      const mealieJson = values["mealie-json"];
      if (!mealieJson) throw new UsageError(`${name} needs --mealie-json <file>`);
      if (name === "prompt") {
        return {
          name,
          mealieJson,
          scale,
          ...optional("categories", values.categories),
          ...optional("locale", locale),
        };
      }
      return {
        name,
        mealieJson,
        scale,
        ...optional("provider", provider as LlmProvider | undefined),
        ...optional("out", values.out),
        ...optional("categories", values.categories),
        ...optional("locale", locale),
      };
    }
    case "eval": {
      reject(["corpus-dir", "ids", "provider", "out", "categories", "locale"]);
      const ids = (values.ids ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length === 0) throw new UsageError("eval needs --ids <id,id,...>");
      if (ids.some((id) => !/^\d+$/.test(id))) throw new UsageError("--ids takes recipe numbers");
      return {
        name,
        corpusDir: values["corpus-dir"] ?? defaultCorpusDir(locale ?? "de-DE"),
        ids: ids.map(Number),
        ...optional("provider", provider as LlmProvider | undefined),
        ...optional("out", values.out),
        ...optional("categories", values.categories),
        ...optional("locale", locale),
      };
    }
    default:
      throw new UsageError(`Unknown command ${name}`);
  }
}

// The corpus of a locale: local/corpus for the de-DE reference corpus, local/corpus/<locale>
// for the others.
export function defaultCorpusDir(locale: string): string {
  return locale === "de-DE" ? "local/corpus" : `local/corpus/${locale}`;
}

export async function runConvert(args: readonly string[], ctx: ConvertContext): Promise<number> {
  try {
    const command = parseCommand(args);
    if (command.name === "help") {
      ctx.out(USAGE);
      return EXIT.ok;
    }
    const config = loadConfig(ctx.env);
    const limits = await loadDeviceLimits(config.DEVICE_PROGRAMS_PATH);
    const knowledge = await loadKnowledge(config.KNOWLEDGE_DIR, command.locale ?? config.MC_LOCALE);
    const pack = knowledge.pack;
    if (command.name === "eval") return await runEval(command, config, limits, knowledge, ctx);
    const request = await mealieRequest(command.mealieJson, command.scale, limits, pack);
    const categories = await loadCategories(command.categories, ctx, pack);
    if (command.name === "prompt") {
      const usable = usableModes(limits);
      const { techniques } = selectTechniques(request, knowledge, undefined, usable);
      ctx.out(buildSystemPrompt(knowledge, limits));
      ctx.out("\n---- user message ----\n");
      ctx.out(
        buildUserMessage(request, categories, {
          techniques,
          usable,
          aliases: knowledge.aliases,
          languageName: pack.mc.language,
        }),
      );
      return EXIT.ok;
    }
    const generator = (ctx.generator ?? defaultGenerator)(
      config,
      command.provider ?? config.LLM_PROVIDER,
    );
    const converter = createConverter({
      generator,
      knowledge,
      limits,
      categories,
      maxCorrections: config.LLM_MAX_CORRECTIONS,
      prices: priceTable(config.LLM_PRICES_JSON),
    });
    ctx.err(`Converting "${request.title}" with ${generator.provider} ${generator.model} ...`);
    try {
      const result = await converter.convert(request);
      printResult(result, ctx);
      if (command.out) await writeJson(command.out, result);
      return EXIT.ok;
    } catch (error) {
      if (!(error instanceof ConversionFailedError)) throw error;
      ctx.err(error.message);
      for (const issue of error.errors) ctx.err(`  ${issue.path}: ${issue.message}`);
      ctx.err(usageLine(error.usage));
      if (command.out)
        await writeJson(command.out, { failed: true, ...error, lastJson: error.lastJson });
      return EXIT.failed;
    }
  } catch (error) {
    return report(error, ctx);
  }
}

function defaultGenerator(config: Config, provider: LlmProvider): RecipeGenerator {
  return createGenerator(config, { provider });
}

async function readJson(file: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(resolve(file), "utf8");
  } catch {
    throw new InputError(`Cannot read the ${label} ${file}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError(`${file} is not valid JSON`);
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(resolve(file), `${JSON.stringify(value, null, 2)}\n`);
}

// The request the service builds from a Mealie recipe: normalized and scaled
// ingredients, the servings of Mealie's scaler and the rendered Markdown.
export function buildRequest(
  recipeJson: unknown,
  scale: number,
  limits: DeviceLimits,
  pack: LocalePack,
): ConversionRequest {
  const parsed = mealieRecipeSchema.safeParse(recipeJson);
  if (!parsed.success) {
    throw new InputError("The file is not a Mealie recipe (GET /api/recipes/{slug})");
  }
  const recipe = parsed.data;
  const ingredients = scaleIngredients(normalizeIngredients(recipe), scale);
  const servings = servingsFor(recipe, scale, limits.recipe.servings);
  const labels = renderLabels(pack);
  const rendered = renderRecipeForLlm(recipe, { scale, servings, ingredients, labels });
  const hints = recipe.recipeCategory.map((category) => category.name).filter(Boolean);
  return {
    title: recipe.name,
    rendered,
    servings,
    locale: pack.locale,
    ingredients,
    ...(hints.length > 0 ? { categoryHints: hints } : {}),
  };
}

async function mealieRequest(file: string, scale: number, limits: DeviceLimits, pack: LocalePack) {
  return buildRequest(await readJson(file, "Mealie recipe"), scale, limits, pack);
}

const categoryList = z.array(z.looseObject({ id: z.number().int(), name: z.string() }));
// A plain list, {categories: [...]} or the API envelope {data: {categories: [...]}}.
const categoryFile = z.union([
  categoryList,
  z.looseObject({ categories: categoryList }).transform((file) => file.categories),
  z
    .looseObject({ data: z.looseObject({ categories: categoryList }) })
    .transform((file) => file.data.categories),
]);

export function parseCategories(json: unknown): Category[] {
  const parsed = categoryFile.safeParse(json);
  if (!parsed.success) throw new InputError("The category file has no list of {id, name}");
  return parsed.data.map(({ id, name }) => ({ id, name }));
}

async function loadCategories(
  file: string | undefined,
  ctx: ConvertContext,
  pack: LocalePack,
): Promise<Category[]> {
  if (file) return parseCategories(await readJson(file, "category file"));
  try {
    const transport = new McTransport({
      locale: pack.mc,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    const response = await transport.publicGet("/api/v1/categories");
    return parseCategories({ data: response.data });
  } catch (error) {
    throw new InputError(
      `Could not load the categories (${error instanceof Error ? error.message : String(error)}). Pass --categories <file> with a list of {id, name}; the model must not guess category ids.`,
    );
  }
}

function settingsText(step: RecipeStep): string {
  switch (step.kind) {
    case "text":
      return "";
    case "scale":
      return `${step.grams} g`;
    case "turbo":
      return `${step.seconds} s`;
    case "cooking_eggs":
      return `${step.size}, ${step.texture}`;
    case "precleaning":
      return step.duration;
    default: {
      const parts: string[] = [];
      if ("temperature" in step) parts.push(`${step.temperature} °C`);
      const time = stepSeconds(step);
      if (time !== null)
        parts.push(time >= 60 ? `${Math.floor(time / 60)} min ${time % 60} s` : `${time} s`);
      if ("speed" in step) parts.push(`speed ${step.speed}`);
      if ("rotation" in step && step.rotation === "left") parts.push("reverse");
      if ("accessory" in step && step.accessory) parts.push(step.accessory);
      return parts.join(", ");
    }
  }
}

export function stepTable(recipe: RecipeInput): string[] {
  const rows = recipe.servingSize.steps.map((step, index) => [
    String(index + 1),
    step.kind,
    "description" in step ? step.description : step.title,
    settingsText(step),
  ]);
  const width = (column: number, cap: number) =>
    Math.min(cap, Math.max(...rows.map((row) => (row[column] ?? "").length), 1));
  const w = [width(0, 3), width(1, 22), width(2, 70)];
  const cell = (text: string, size: number) =>
    (text.length > size ? `${text.slice(0, size - 1)}…` : text).padEnd(size);
  return rows.map(([n, kind, text, settings]) =>
    `${(n ?? "").padStart(w[0] ?? 3)}  ${cell(kind ?? "", w[1] ?? 22)}  ${cell(text ?? "", w[2] ?? 70)}  ${settings ?? ""}`.trimEnd(),
  );
}

function usageLine(usage: ConversionResult["usage"]): string {
  const cached = usage.cachedInputTokens ? `, ${usage.cachedInputTokens} cached` : "";
  const written = usage.cacheWriteInputTokens
    ? `, ${usage.cacheWriteInputTokens} written to cache`
    : "";
  const cost =
    usage.costUsd === undefined ? "cost unknown" : `about ${usage.costUsd.toFixed(4)} USD`;
  return `Usage: ${usage.inputTokens} input tokens${cached}${written}, ${usage.outputTokens} output tokens, ${cost}`;
}

function printResult(result: ConversionResult, ctx: ConvertContext): void {
  const recipe = result.recipe;
  ctx.out(
    `${recipe.title} (${recipe.servingSize.amount} ${recipe.servingSize.unit}, ${recipe.complexity})`,
  );
  ctx.out("");
  for (const line of stepTable(recipe)) ctx.out(line);
  ctx.out("");
  ctx.out(
    `Validator: ok after ${result.attempts} attempt(s) with ${result.provider} ${result.model}`,
  );
  if (result.warnings.length > 0) {
    ctx.out("Warnings:");
    for (const warning of result.warnings) ctx.out(`  - ${warning}`);
  }
  if (result.reviewHints.length > 0) {
    ctx.out("Review hints:");
    for (const hint of result.reviewHints) ctx.out(`  - ${hint}`);
  }
  ctx.out(usageLine(result.usage));
}

// Corpus evaluation

interface ProgramStep {
  mode: string;
  temperature: number | null;
  seconds: number | null;
}

// A corpus recipe as the converter would see it: ingredients and the instruction texts
// of text and scale steps, without any device setting. The headings follow the locale pack
// of the output language, and the ingredient lines carry their index [i].
export function corpusRequest(
  raw: RawRecipe,
  pack: Pick<LocalePack, "locale" | "phrases">,
): {
  request: ConversionRequest;
  original: ProgramStep[];
} {
  const serving = raw.servingSizes[0];
  const groups = new Map<number, string>();
  for (const group of serving?.ingredientGroups ?? []) {
    if (group.id !== null && group.id !== undefined && group.name) groups.set(group.id, group.name);
  }
  const ingredients: NormalizedIngredient[] = (serving?.ingredients ?? []).flatMap(
    (item, index) => {
      const food = item.name?.trim() ?? "";
      if (food === "") return [];
      const amountText =
        item.amount === null || item.amount === undefined ? "" : String(item.amount);
      const unitText = item.unit?.trim() ?? "";
      const unit = normalizeUnit(unitText)?.code ?? (unitText === "" ? null : unitText);
      const group =
        item.ingredientGroupId === null || item.ingredientGroupId === undefined
          ? undefined
          : groups.get(item.ingredientGroupId);
      return [
        {
          index,
          section: group ?? null,
          quantity: parseAmount(amountText).amount,
          quantityMax: null,
          unit,
          food,
          note: "",
          optional: false,
          source: "structured" as const,
          original: [amountText, unitText, food].filter(Boolean).join(" "),
          referenceId: null,
        },
      ];
    },
  );
  const steps = serving?.steps ?? [];
  const instructions = steps
    .filter((step) => !step.deviceSetting || step.deviceSetting.mode === "scale")
    .map((step) => stepText(step))
    .filter(Boolean);
  const servings = Math.max(1, Math.round(Number(serving?.amount ?? 4)) || 4);
  const labels: Pick<RenderLabels, "servings" | "ingredients" | "steps" | "untitled"> =
    pack.phrases.sectionLabels;
  const title = raw.name?.trim() || `${labels.untitled} ${raw.id}`;
  const lines = [
    `# ${title}`,
    "",
    `${labels.servings}: ${servings}${serving?.servingUnit ? ` ${serving.servingUnit}` : ""}`,
    "",
    `## ${labels.ingredients}`,
    "",
  ];
  let section: string | null = null;
  ingredients.forEach((item, position) => {
    if (item.section !== section && item.section !== null)
      lines.push("", `### ${item.section}`, "");
    section = item.section;
    lines.push(`- [${position}] ${item.original}`);
  });
  lines.push(
    "",
    `## ${labels.steps}`,
    "",
    ...instructions.map((text, i) => `${i + 1}. ${text}`),
    "",
  );
  const original = steps.flatMap((step): ProgramStep[] => {
    const setting = step.deviceSetting;
    if (!setting || setting.mode === "scale") return [];
    const phases = setting.settings ?? [];
    const temperatures = phases
      .map((phase) => phase.temperature)
      .filter((t): t is number => typeof t === "number");
    const times = phases
      .map((phase) => phase.time)
      .filter((t): t is number => typeof t === "number");
    return [
      {
        mode: setting.mode,
        temperature: temperatures.length > 0 ? Math.max(...temperatures) : null,
        seconds: times.length > 0 ? times.reduce((a, b) => a + b, 0) : null,
      },
    ];
  });
  const hints = (raw.categories ?? []).map((category) => category.name ?? "").filter(Boolean);
  return {
    request: {
      title,
      rendered: lines.join("\n"),
      servings,
      locale: pack.locale,
      ingredients,
      ...(hints.length > 0 ? { categoryHints: hints } : {}),
    },
    original,
  };
}

export function programSteps(recipe: RecipeInput): ProgramStep[] {
  return recipe.servingSize.steps.flatMap((step): ProgramStep[] => {
    if (step.kind === "text" || step.kind === "scale") return [];
    return [
      {
        mode: step.kind,
        temperature: "temperature" in step ? step.temperature : null,
        seconds: stepSeconds(step),
      },
    ];
  });
}

// Official modes the converter may not use, and the member programs that replace them.
const EQUIVALENT_MODES: Readonly<Record<string, readonly string[]>> = {
  kneading: ["kneading_solid_dough", "kneading_soft_dough", "kneading_liquid_dough"],
  ramp: ["puree", "customized"],
};

const sameMode = (original: string, converted: string) =>
  original === converted || (EQUIVALENT_MODES[original] ?? []).includes(converted);

export interface StepComparison {
  original: number;
  converted: number;
  modeMatches: number;
  temperaturePairs: number;
  temperatureOk: number;
  timePairs: number;
  timeOk: number;
}

const temperatureOk = (a: ProgramStep, b: ProgramStep) =>
  a.temperature !== null && b.temperature !== null && Math.abs(a.temperature - b.temperature) <= 10;
const timeOk = (a: ProgramStep, b: ProgramStep) =>
  a.seconds !== null &&
  b.seconds !== null &&
  a.seconds > 0 &&
  Math.abs(a.seconds - b.seconds) / a.seconds <= 0.3;

// Aligns the program steps in order and checks temperature (within 10 °C) and time (within
// 30 %) on the aligned pairs. The alignment keeps as many same-program pairs as possible
// and, among those, the pairs whose settings agree: a pair scores 1000 plus one point each
// for a matching temperature and time.
export function compareSteps(original: ProgramStep[], converted: ProgramStep[]): StepComparison {
  const n = original.length;
  const m = converted.length;
  const pairScore = (i: number, j: number): number | null => {
    const a = original[i] as ProgramStep;
    const b = converted[j] as ProgramStep;
    if (!sameMode(a.mode, b.mode)) return null;
    return 1000 + (temperatureOk(a, b) ? 1 : 0) + (timeOk(a, b) ? 1 : 0);
  };
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number) => best[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = pairScore(i, j);
      const row = best[i] as number[];
      row[j] = Math.max(at(i + 1, j), at(i, j + 1), pair === null ? 0 : pair + at(i + 1, j + 1));
    }
  }
  const result: StepComparison = {
    original: n,
    converted: m,
    modeMatches: 0,
    temperaturePairs: 0,
    temperatureOk: 0,
    timePairs: 0,
    timeOk: 0,
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const pair = pairScore(i, j);
    if (pair !== null && at(i, j) === pair + at(i + 1, j + 1)) {
      const a = original[i] as ProgramStep;
      const b = converted[j] as ProgramStep;
      result.modeMatches++;
      if (a.temperature !== null && b.temperature !== null) result.temperaturePairs++;
      if (temperatureOk(a, b)) result.temperatureOk++;
      if (a.seconds !== null && b.seconds !== null && a.seconds > 0) result.timePairs++;
      if (timeOk(a, b)) result.timeOk++;
      i++;
      j++;
    } else if (at(i, j) === at(i + 1, j)) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "   -" : `${Math.round((part / whole) * 100)}%`.padStart(4);

async function runEval(
  command: Extract<Command, { name: "eval" }>,
  config: Config,
  limits: DeviceLimits,
  knowledge: Knowledge,
  ctx: ConvertContext,
): Promise<number> {
  const details = join(resolve(command.corpusDir), "details");
  if (!existsSync(details)) {
    ctx.err(
      `No corpus at ${command.corpusDir} (expected ${details}). Build one with npm run corpus:crawl; the corpus stays local and is never committed.`,
    );
    return EXIT.noInput;
  }
  const categories = await loadCategories(command.categories, ctx, knowledge.pack);
  const generator = (ctx.generator ?? defaultGenerator)(
    config,
    command.provider ?? config.LLM_PROVIDER,
  );
  const converter = createConverter({
    generator,
    knowledge,
    limits,
    categories,
    maxCorrections: config.LLM_MAX_CORRECTIONS,
    prices: priceTable(config.LLM_PRICES_JSON),
  });
  const header = "     id  orig  conv  mode  temp  time  tries  cost USD  status";
  const rows: string[] = [];
  const total: StepComparison = {
    original: 0,
    converted: 0,
    modeMatches: 0,
    temperaturePairs: 0,
    temperatureOk: 0,
    timePairs: 0,
    timeOk: 0,
  };
  let cost = 0;
  let failures = 0;
  const tokens = { input: 0, cached: 0, output: 0 };
  const count = (usage: ConversionResult["usage"]) => {
    tokens.input += usage.inputTokens;
    tokens.cached += usage.cachedInputTokens ?? 0;
    tokens.output += usage.outputTokens;
  };
  const outputs: unknown[] = [];
  for (const id of command.ids) {
    const file = join(details, `${id}.json`);
    let raw: RawRecipe;
    try {
      raw = parseDetailFile(await readFile(file, "utf8"));
    } catch (error) {
      failures++;
      rows.push(
        `${String(id).padStart(7)}  missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const { request, original } = corpusRequest(raw, knowledge.pack);
    ctx.err(`Converting ${id} "${request.title}" ...`);
    try {
      const result = await converter.convert(request);
      const comparison = compareSteps(original, programSteps(result.recipe));
      for (const key of Object.keys(total) as (keyof StepComparison)[])
        total[key] += comparison[key];
      cost += result.usage.costUsd ?? 0;
      count(result.usage);
      outputs.push({ id, result });
      rows.push(
        [
          String(id).padStart(7),
          String(comparison.original).padStart(4),
          String(comparison.converted).padStart(4),
          percent(comparison.modeMatches, comparison.original),
          percent(comparison.temperatureOk, comparison.temperaturePairs),
          percent(comparison.timeOk, comparison.timePairs),
          String(result.attempts).padStart(5),
          (result.usage.costUsd ?? 0).toFixed(4).padStart(8),
          result.warnings.length > 0 ? `ok, ${result.warnings.length} warning(s)` : "ok",
        ].join("  "),
      );
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message : String(error);
      rows.push(`${String(id).padStart(7)}  failed: ${message}`);
      if (error instanceof ConversionFailedError) {
        cost += error.usage.costUsd ?? 0;
        count(error.usage);
        const { usage, lastJson, corrections } = error;
        outputs.push({ id, error: message, usage, corrections, lastJson });
      } else {
        outputs.push({ id, error: message });
      }
    }
  }
  ctx.out(header);
  for (const row of rows) ctx.out(row);
  ctx.out(
    [
      "  total",
      String(total.original).padStart(4),
      String(total.converted).padStart(4),
      percent(total.modeMatches, total.original),
      percent(total.temperatureOk, total.temperaturePairs),
      percent(total.timeOk, total.timePairs),
      "     ",
      cost.toFixed(4).padStart(8),
      failures > 0 ? `${failures} failed` : "",
    ]
      .join("  ")
      .trimEnd(),
  );
  ctx.out(
    "mode: original program steps matched in order by the same program; temp: within 10 °C; time: within 30 % (of the matched steps).",
  );
  ctx.out(
    `tokens: ${tokens.input} input (${tokens.cached} cached), ${tokens.output} output; ${cost.toFixed(4)} USD`,
  );
  if (command.out) await writeJson(command.out, outputs);
  return failures > 0 ? EXIT.failed : EXIT.ok;
}

function report(error: unknown, ctx: ConvertContext): number {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    ctx.err(message);
    ctx.err("Run convert --help for the commands.");
    return EXIT.usage;
  }
  ctx.err(message);
  if (error instanceof InputError) return EXIT.failed;
  if (
    error instanceof MissingApiKeyError ||
    error instanceof LlmConfigError ||
    error instanceof KnowledgeError ||
    error instanceof DeviceLimitsError ||
    message.startsWith("Invalid configuration")
  ) {
    return EXIT.config;
  }
  // Refusals, truncated answers and API failures.
  return EXIT.provider;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const exitCode = await runConvert(process.argv.slice(2), {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = exitCode;
}
