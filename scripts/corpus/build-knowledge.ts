// Rebuilds the knowledge base in knowledge/ from the corpus analysis.
//
// --locale de-DE (the default) works on the reference corpus in local/corpus and writes the
// language-neutral files and the de-DE pack; any other locale works on local/corpus/<locale>
// and writes only the corpus-derived files of its own pack, never the neutral files.
//
// Input:  $CORPUS_DIR/derived/steps.jsonl, technique-steps.jsonl, timing.json and
//         ingredients.json, written by `npm run corpus:analyze -- --locale <locale>`; for the
//         ingredient catalog derived/recipes.jsonl, or the raw details/ when the normalizer
//         has not run (categories always come from details/). A locale other than de-DE
//         needs steps.jsonl and ingredients.json only.
// Output (de-DE only):
//         knowledge/device-programs.json  hard device limits per program (hand-curated data
//                                          in build-device-programs.ts, no corpus input)
//         knowledge/device-limits.json    corpus, SmartRecipe and editor layers plus the
//                                          recommended range per mode
//         knowledge/timing-model.json     time formulas, heat-up rules and mass limits
//         knowledge/units.json            densities and mass totals
//         knowledge/techniques.json       cooking techniques with device settings
// Output (every locale), knowledge/locales/<locale>/:
//         ingredient-catalog.json         ingredient names with their systemIngredientId
//         units.json                      piece weights and the corpus unit tables; the
//                                          hand-written fields stay as they are
//         phrases.json                    the corpus phrase table; the hand-written fields
//                                          stay as they are
// knowledge/prompt-rules.md, knowledge/step-patterns.md, knowledge/converter-rules.json and
// the hand-written pack files (mc.json, technique-aliases.json, prompt-rules.md) are written
// by hand.
//
// device-programs.json holds values transcribed from a logged-in capture of the recipe editor
// and from server probes with a member account. Its generator reads no files, so the build
// runs without those private captures; changing the editor or server layers needs your own
// capture.
//
// Every input is checked before anything is built. When one is missing, the script names it
// and exits with code 1 without touching the output directory. All files are formatted with
// the repository's Prettier settings, so a rebuild from the same corpus reproduces the
// committed files byte for byte.
//
// Run:   npm run corpus:build-knowledge
//        npm run corpus:build-knowledge -- --locale en-US
//        npm run corpus:build-knowledge -- --check   compare only, exit 1 when a file differs
// Flags: --locale <locale>   (default de-DE)
//        --corpus-dir <dir>  (default $CORPUS_DIR, else local/corpus or local/corpus/<locale>)
//        --out <dir>         (default knowledge)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { buildDeviceLimits } from "./build-device-limits.js";
import { buildDevicePrograms, formatDevicePrograms } from "./build-device-programs.js";
import { buildIngredientCatalog, readCatalogSource } from "./build-ingredient-catalog.js";
import { buildPackPhrases, buildPackUnits } from "./build-locale-pack.js";
import { buildTechniques, type TechniqueStepRow } from "./build-techniques.js";
import {
  buildTimingModel,
  buildUnits,
  type IngredientsAnalysis,
  type TimingAnalysis,
} from "./build-timing-units.js";
import { REFERENCE_LOCALE, corpusDirFor } from "./locale.js";
import type { NormalizedStep } from "./types.js";

export interface Options {
  locale: string;
  corpusDir: string;
  outDir: string;
  check: boolean;
}

// The inputs of the reference build; another locale needs only the pack inputs.
export const requiredInputs = [
  "steps.jsonl",
  "technique-steps.jsonl",
  "timing.json",
  "ingredients.json",
] as const;
export const packInputs = ["steps.jsonl", "ingredients.json"] as const;

const LOCALE = /^[a-z]{2,3}-[A-Z]{2}$/;

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Options {
  let locale = REFERENCE_LOCALE;
  let corpusDir: string | undefined;
  let outDir = "knowledge";
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--check") check = true;
    else if (arg === "--corpus-dir") corpusDir = value();
    else if (arg === "--out") outDir = value();
    else if (arg === "--locale") locale = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!LOCALE.test(locale)) throw new Error(`--locale must look like de-DE, not ${locale}`);
  return {
    locale,
    corpusDir: corpusDir ?? (env.CORPUS_DIR || corpusDirFor(locale)),
    outDir,
    check,
  };
}

/** Paths of the required inputs that do not exist. */
export function missingInputs(corpusDir: string, locale: string = REFERENCE_LOCALE): string[] {
  const inputs = locale === REFERENCE_LOCALE ? requiredInputs : packInputs;
  const missing = inputs
    .map((f) => path.join(corpusDir, "derived", f))
    .filter((f) => !existsSync(f));
  const recipes = path.join(corpusDir, "derived", "recipes.jsonl");
  const details = path.join(corpusDir, "details");
  if (!existsSync(recipes) && !existsSync(details)) missing.push(`${recipes} (or ${details})`);
  return missing;
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readExisting(file: string): Record<string, unknown> | null {
  return existsSync(file) ? readJson<Record<string, unknown>>(file) : null;
}

async function format(text: string, outDir: string, name: string): Promise<string> {
  const target = path.resolve(outDir, name);
  const config = await prettier.resolveConfig(target);
  return prettier.format(text, { ...config, filepath: target });
}

/**
 * Builds every generated knowledge file of a locale in memory: path relative to the output
 * directory to formatted content.
 */
export async function buildAll(
  corpusDir: string,
  outDir: string,
  locale: string = REFERENCE_LOCALE,
): Promise<Map<string, string>> {
  const derived = path.join(corpusDir, "derived");
  const steps = readJsonl<NormalizedStep>(path.join(derived, "steps.jsonl"));
  const ingredients = readJson<IngredientsAnalysis>(path.join(derived, "ingredients.json"));
  const catalogSource = readCatalogSource(corpusDir);
  if (!catalogSource) throw new Error(`no ingredient source in ${corpusDir}`);
  const catalog = buildIngredientCatalog(catalogSource.recipes, catalogSource.categories, locale);

  const docs: [string, string][] = [];
  if (locale === REFERENCE_LOCALE) {
    const techniqueSteps = readJsonl<TechniqueStepRow>(path.join(derived, "technique-steps.jsonl"));
    const timing = readJson<TimingAnalysis>(path.join(derived, "timing.json"));
    const programs = buildDevicePrograms();
    docs.push(
      ["device-programs.json", formatDevicePrograms(programs)],
      ["device-limits.json", JSON.stringify(buildDeviceLimits({ steps, programs })) + "\n"],
      [
        "timing-model.json",
        JSON.stringify(buildTimingModel({ steps, timing, ingredients })) + "\n",
      ],
      ["units.json", JSON.stringify(buildUnits()) + "\n"],
      [
        "techniques.json",
        JSON.stringify(buildTechniques({ steps, techniqueSteps, timing })) + "\n",
      ],
    );
  }
  const pack = path.join("locales", locale);
  const existing = (file: string) => readExisting(path.join(outDir, pack, file));
  docs.push(
    [path.join(pack, "ingredient-catalog.json"), JSON.stringify(catalog) + "\n"],
    [
      path.join(pack, "units.json"),
      JSON.stringify(buildPackUnits(locale, ingredients, existing("units.json"))) + "\n",
    ],
    [
      path.join(pack, "phrases.json"),
      JSON.stringify(buildPackPhrases(locale, steps, existing("phrases.json"))) + "\n",
    ],
  );
  const out = new Map<string, string>();
  for (const [name, text] of docs) out.set(name, await format(text, outDir, name));
  return out;
}

interface Log {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

/** Runs the build and returns the process exit code. */
export async function main(argv: readonly string[], log: Log = console): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    log.error(`corpus:build-knowledge: ${(e as Error).message}`);
    return 2;
  }
  const missing = missingInputs(options.corpusDir, options.locale);
  if (missing.length) {
    for (const f of missing) log.error(`corpus:build-knowledge: missing input ${f}`);
    log.error(
      `Run npm run corpus:analyze -- --locale ${options.locale} first. Nothing was written.`,
    );
    return 1;
  }

  const started = Date.now();
  const files = await buildAll(options.corpusDir, options.outDir, options.locale);
  let differing = 0;
  for (const [name, text] of files) {
    const target = path.join(options.outDir, name);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    const state = current === text ? "unchanged" : current === null ? "new" : "changed";
    if (state !== "unchanged") differing++;
    if (!options.check && state !== "unchanged") {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    log.log(`${target}: ${state}`);
  }
  const catalog = files.get(path.join("locales", options.locale, "ingredient-catalog.json"));
  if (catalog !== undefined) {
    const entries = (JSON.parse(catalog) as { entries: unknown[] }).entries.length;
    log.log(`ingredient catalog: ${entries} entries`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (options.check) {
    log.log(
      `corpus:build-knowledge --check: ${differing} of ${files.size} files differ (${seconds}s)`,
    );
    return differing ? 1 : 0;
  }
  log.log(`corpus:build-knowledge: ${differing} of ${files.size} files written (${seconds}s)`);
  return 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return norm(entry) === norm(self) || norm(entry) === norm(self.replace(/\.ts$/, ""));
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
