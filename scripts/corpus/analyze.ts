// Runs the normalizer and the five analyzers on the corpus of one locale, in order.
//
// Run: npm run corpus:analyze                      the de-DE reference corpus in local/corpus
//      npm run corpus:analyze -- --locale en-US    local/corpus/en-US
// CORPUS_DIR overrides the directory. Output goes to <corpus>/derived/, never into the
// repository.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as analyzeIngredients } from "./analyze-ingredients.js";
import { run as analyzeModes } from "./analyze-modes.js";
import { run as analyzeStructure } from "./analyze-structure.js";
import { run as analyzeTechniques } from "./analyze-techniques.js";
import { run as analyzeTiming } from "./analyze-timing.js";
import { parseCorpusArgs } from "./locale.js";
import { run as normalize } from "./normalize.js";

export const STAGES = [
  ["normalize", (dir: string) => void normalize(dir)],
  ["analyze-modes", (dir: string) => analyzeModes(dir)],
  ["analyze-techniques", (dir: string) => void analyzeTechniques(dir)],
  ["analyze-structure", (dir: string) => analyzeStructure(dir)],
  ["analyze-ingredients", (dir: string) => void analyzeIngredients(dir)],
  ["analyze-timing", (dir: string) => void analyzeTiming(dir)],
] as const;

export function runAll(corpusDir: string, log: (line: string) => void = console.log): void {
  for (const [name, stage] of STAGES) {
    log(`corpus:analyze: ${name} on ${corpusDir}`);
    stage(corpusDir);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return norm(entry) === norm(self) || norm(entry) === norm(self.replace(/\.ts$/, ""));
}

if (isMain()) {
  try {
    runAll(parseCorpusArgs(process.argv.slice(2)).corpusDir);
  } catch (error) {
    console.error(`corpus:analyze: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
