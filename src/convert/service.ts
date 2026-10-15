// The converter as the service loads it (src/pipeline/converter-port.ts): built from the
// environment at startup, with the category catalog taken from each request. The service
// sends the live catalog as category hints, one "<id>: <name>" line per category, and
// merges the categories that match the Mealie recipe itself after the conversion.

import { loadConfig, type Config } from "../config.js";
import type { DeviceLimits } from "../recipe/limits.js";
import { priceTable } from "./cost.js";
import { RecipeTooLargeError } from "./errors.js";
import { createGenerator } from "./generator.js";
import { loadKnowledge } from "./knowledge.js";
import { createConverter, type ConverterLogger } from "./loop.js";
import type { Category } from "./prompt.js";
import type { ConversionRequest, ConversionResult, Converter, RecipeGenerator } from "./types.js";

export interface ServiceConverterContext {
  env: NodeJS.ProcessEnv;
  limits: DeviceLimits;
  logger: ConverterLogger;
}

const CATEGORY_LINE = /^\s*(\d+):\s*(\S.*?)\s*$/;

// Splits category hints into the catalog lines ("228: Suppen & Eintöpfe") and the rest.
export function categoriesFromHints(hints: readonly string[]): {
  categories: Category[];
  hints: string[];
} {
  const categories: Category[] = [];
  const rest: string[] = [];
  const seen = new Set<number>();
  for (const hint of hints) {
    const match = CATEGORY_LINE.exec(hint);
    if (match?.[1] && match[2]) {
      const id = Number(match[1]);
      if (!seen.has(id)) categories.push({ id, name: match[2] });
      seen.add(id);
    } else if (hint.trim() !== "") {
      rest.push(hint);
    }
  }
  return { categories, hints: rest };
}

export async function createServiceConverter(
  context: ServiceConverterContext,
  makeGenerator: (config: Config) => RecipeGenerator = (config) => createGenerator(config),
): Promise<Converter> {
  const config = loadConfig(context.env);
  const knowledge = await loadKnowledge(config.KNOWLEDGE_DIR, config.MC_LOCALE);
  const prices = priceTable(config.LLM_PRICES_JSON);
  let generator: RecipeGenerator | undefined;
  return {
    async convert(request: ConversionRequest, opts = {}): Promise<ConversionResult> {
      // Before any model call, so a recipe that is too long costs nothing.
      const bytes = Buffer.byteLength(request.rendered, "utf8");
      if (bytes > config.LLM_MAX_RECIPE_KB * 1024) {
        throw new RecipeTooLargeError(Math.ceil(bytes / 1024), config.LLM_MAX_RECIPE_KB);
      }
      // Built at the first conversion: a missing API key fails the job with its message
      // instead of keeping the service from starting.
      generator ??= makeGenerator(config);
      const { categories, hints } = categoriesFromHints(request.categoryHints ?? []);
      const converter = createConverter({
        generator,
        knowledge,
        limits: context.limits,
        categories,
        maxCorrections: config.LLM_MAX_CORRECTIONS,
        prices,
        logger: context.logger,
      });
      return converter.convert({ ...request, categoryHints: hints }, opts);
    },
  };
}
