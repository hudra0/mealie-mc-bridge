// The contract between the service and the LLM converter (src/convert). The service
// depends on these types only; the converter satisfies them structurally.
//
// loadConverter imports src/convert lazily, so the service builds and runs before the
// converter exists. Until then a placeholder answers every request with
// ConverterNotConfiguredError and the job fails with that message.

import type { AppLogger } from "../app-logger.js";
import type { NormalizedIngredient } from "../ingredients/index.js";
import type { DeviceLimits } from "../recipe/limits.js";
import type { RecipeInput } from "../recipe/schema.js";

export interface ConversionRequest {
  title: string;
  // The recipe as Markdown in the output language (renderRecipeForLlm), scaled.
  rendered: string;
  servings: number;
  // The serving unit ("Portionen", "Scheiben") and where the serving size came from.
  servingUnit?: string;
  servingsSource?: "yield" | "servings" | "estimate";
  locale: string;
  // The scaled ingredients.
  ingredients: NormalizedIngredient[];
  // The live Monsieur Cuisine categories as "<id>: <name>", the ones matching the Mealie
  // categories and tags first.
  categoryHints?: string[];
  // Catalog names close to source ingredients, by index into ingredients.
  catalogNames?: { index: number; names: string[] }[];
}

export interface ConversionResult {
  recipe: RecipeInput;
  attempts: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
  warnings: string[];
  reviewHints: string[];
  provider: string;
  model: string;
}

export interface Converter {
  convert(
    req: ConversionRequest,
    opts?: { signal?: AbortSignal; jobId?: string },
  ): Promise<ConversionResult>;
}

export class ConverterNotConfiguredError extends Error {
  constructor() {
    super("converter not configured");
    this.name = "ConverterNotConfiguredError";
  }
}

export const placeholderConverter: Converter = {
  convert: () => Promise.reject(new ConverterNotConfiguredError()),
};

export interface ConverterContext {
  env: NodeJS.ProcessEnv;
  limits: DeviceLimits;
  logger: AppLogger;
}

// What src/convert/index.ts is expected to export.
export interface ConverterModule {
  createConverter(context: ConverterContext): Converter | Promise<Converter>;
}

// The module the integration points at. A variable keeps the TypeScript compiler from
// resolving it while the converter does not exist yet.
export const CONVERTER_MODULE = "../convert/index.js";

export type ModuleImporter = (specifier: string) => Promise<unknown>;

const importModule: ModuleImporter = (specifier) => import(specifier);

// The real converter when src/convert is present, else the placeholder. A converter module
// that exists but fails to load is an error, not a reason to fall back silently.
export async function loadConverter(
  context: ConverterContext,
  importer: ModuleImporter = importModule,
): Promise<Converter> {
  let loaded: unknown;
  try {
    loaded = await importer(CONVERTER_MODULE);
  } catch (error) {
    if (isModuleNotFound(error)) {
      context.logger.warn(
        {},
        "no converter module found; conversions will fail until one is configured",
      );
      return placeholderConverter;
    }
    throw error;
  }
  if (!isConverterModule(loaded)) {
    throw new Error(`${CONVERTER_MODULE} does not export createConverter(context)`);
  }
  return await loaded.createConverter(context);
}

function isConverterModule(value: unknown): value is ConverterModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "createConverter" in value &&
    typeof value.createConverter === "function"
  );
}

function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  if (error.code !== "ERR_MODULE_NOT_FOUND") return false;
  // Only the converter module itself missing counts, not a dependency inside it, whose
  // message names convert/index.js as the importer instead.
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /Cannot find module '[^']*[\\/]convert[\\/]index\.(js|ts)'/.test(message);
}
