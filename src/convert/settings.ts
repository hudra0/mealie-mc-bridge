// Settings shared by the configuration and the converter: provider defaults, the knowledge
// directory and the price-override format. Kept apart from the converter modules so
// loading the configuration loads neither the SDKs nor the knowledge base.

import { z } from "zod";

export const DEFAULT_KNOWLEDGE_DIR = "./knowledge";

export const OPENAI_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type OpenAIReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

// Defaults; check them against the models your account offers.
export const DEFAULT_OPENAI_MODEL = "gpt-6.1-sol";
export const DEFAULT_OPENAI_REASONING_EFFORT: OpenAIReasoningEffort = "medium";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_ANTHROPIC_EFFORT: AnthropicEffort = "high";

export interface ModelPrice {
  input: number;
  output: number;
  // Price of input tokens read from the prompt cache; the input price when absent.
  cachedInput?: number;
  // Price of input tokens written to the prompt cache; the input price when absent.
  cacheWrite?: number;
}

const priceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cachedInput: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});
const overridesSchema = z.record(z.string().min(1), priceSchema);

export class PriceTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceTableError";
  }
}

// Parses LLM_PRICES_JSON. Throws PriceTableError with the reason when it is malformed.
export function parsePriceOverrides(json: string | undefined): Record<string, ModelPrice> {
  if (json === undefined || json.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new PriceTableError("LLM_PRICES_JSON is not valid JSON");
  }
  const result = overridesSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new PriceTableError(
      `LLM_PRICES_JSON must map model names to {input, output, cachedInput?, cacheWrite?} in USD per 1M tokens${issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : ""}`,
    );
  }
  const prices: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(result.data)) {
    const entry: ModelPrice = { input: price.input, output: price.output };
    if (price.cachedInput !== undefined) entry.cachedInput = price.cachedInput;
    if (price.cacheWrite !== undefined) entry.cacheWrite = price.cacheWrite;
    prices[model] = entry;
  }
  return prices;
}
