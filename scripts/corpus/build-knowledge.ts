// Rebuilds the knowledge base in knowledge/ from the corpus analysis.
//
// Input:  $CORPUS_DIR/derived/steps.jsonl, technique-steps.jsonl, timing.json and
//         ingredients.json, written by `npm run corpus:analyze` (default CORPUS_DIR:
//         local/corpus).
// Output: knowledge/device-programs.json  hard device limits per program (hand-curated data
//                                          in build-device-programs.ts, no corpus input)
//         knowledge/device-limits.json    corpus, SmartRecipe and editor layers plus the
//                                          recommended range per mode
//         knowledge/timing-model.json     time formulas, heat-up rules and mass limits
//         knowledge/units.json            unit vocabulary, rounding grid and piece weights
//         knowledge/techniques.json       cooking techniques with device settings
// knowledge/prompt-rules.md and knowledge/step-patterns.md are written by hand.
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
//        npm run corpus:build-knowledge -- --check   compare only, exit 1 when a file differs
// Flags: --corpus-dir <dir>  (default $CORPUS_DIR or local/corpus)
//        --out <dir>         (default knowledge)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { buildDeviceLimits } from "./build-device-limits.js";
import { buildDevicePrograms, formatDevicePrograms } from "./build-device-programs.js";
import { buildTechniques, type TechniqueStepRow } from "./build-techniques.js";
import {
  buildTimingModel,
  buildUnits,
  type IngredientsAnalysis,
  type TimingAnalysis,
} from "./build-timing-units.js";
import type { NormalizedStep } from "./types.js";

export interface Options {
  corpusDir: string;
  outDir: string;
  check: boolean;
}

export const requiredInputs = [
  "steps.jsonl",
  "technique-steps.jsonl",
  "timing.json",
  "ingredients.json",
] as const;

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Options {
  const options: Options = {
    corpusDir: env.CORPUS_DIR ?? path.join("local", "corpus"),
    outDir: "knowledge",
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--corpus-dir") options.corpusDir = value();
    else if (arg === "--out") options.outDir = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** Paths of the required derived files that do not exist. */
export function missingInputs(corpusDir: string): string[] {
  return requiredInputs
    .map((f) => path.join(corpusDir, "derived", f))
    .filter((f) => !existsSync(f));
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

async function format(text: string, outDir: string, name: string): Promise<string> {
  const target = path.resolve(outDir, name);
  const config = await prettier.resolveConfig(target);
  return prettier.format(text, { ...config, filepath: target });
}

/** Builds every generated knowledge file in memory: file name to formatted content. */
export async function buildAll(corpusDir: string, outDir: string): Promise<Map<string, string>> {
  const derived = path.join(corpusDir, "derived");
  const steps = readJsonl<NormalizedStep>(path.join(derived, "steps.jsonl"));
  const techniqueSteps = readJsonl<TechniqueStepRow>(path.join(derived, "technique-steps.jsonl"));
  const timing = readJson<TimingAnalysis>(path.join(derived, "timing.json"));
  const ingredients = readJson<IngredientsAnalysis>(path.join(derived, "ingredients.json"));

  const programs = buildDevicePrograms();
  const docs: [string, string][] = [
    ["device-programs.json", formatDevicePrograms(programs)],
    ["device-limits.json", JSON.stringify(buildDeviceLimits({ steps, programs })) + "\n"],
    ["timing-model.json", JSON.stringify(buildTimingModel({ steps, timing, ingredients })) + "\n"],
    ["units.json", JSON.stringify(buildUnits({ steps, timing, ingredients })) + "\n"],
    ["techniques.json", JSON.stringify(buildTechniques({ steps, techniqueSteps, timing })) + "\n"],
  ];
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
  const missing = missingInputs(options.corpusDir);
  if (missing.length) {
    for (const f of missing) log.error(`corpus:build-knowledge: missing input ${f}`);
    log.error("Run npm run corpus:analyze first. Nothing was written.");
    return 1;
  }

  const started = Date.now();
  const files = await buildAll(options.corpusDir, options.outDir);
  let differing = 0;
  if (!options.check) mkdirSync(options.outDir, { recursive: true });
  for (const [name, text] of files) {
    const target = path.join(options.outDir, name);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    const state = current === text ? "unchanged" : current === null ? "new" : "changed";
    if (state !== "unchanged") differing++;
    if (!options.check && state !== "unchanged") writeFileSync(target, text);
    log.log(`${target}: ${state}`);
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
