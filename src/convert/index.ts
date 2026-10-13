import { createConverter as createLoopConverter, type ConverterOptions } from "./loop.js";
import { createServiceConverter, type ServiceConverterContext } from "./service.js";
import type { Converter } from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export * from "./knowledge.js";
export * from "./prompt.js";
export * from "./sanity.js";
export * from "./loop.js";
export * from "./cost.js";
export * from "./output.js";
export * from "./settings.js";
export * from "./generator.js";
export {
  categoriesFromHints,
  createServiceConverter,
  type ServiceConverterContext,
} from "./service.js";
export {
  OpenAIGenerator,
  prepareStrictSchema,
  stripNulls,
  type OpenAIGeneratorOptions,
  type OpenAIResponsesClient,
} from "./providers/openai.js";
export {
  AnthropicGenerator,
  recipeOutputFormat,
  supportsFallbacks,
  type AnthropicGeneratorOptions,
  type AnthropicMessagesClient,
} from "./providers/anthropic.js";

// Two entry points under one name: the loop with explicit options (the CLI, tests), and
// the service's factory (src/pipeline/converter-port.ts calls createConverter({ env,
// limits, logger }) on this module).
export function createConverter(options: ConverterOptions): Converter;
export function createConverter(context: ServiceConverterContext): Promise<Converter>;
export function createConverter(
  arg: ConverterOptions | ServiceConverterContext,
): Converter | Promise<Converter> {
  return "generator" in arg ? createLoopConverter(arg) : createServiceConverter(arg);
}
