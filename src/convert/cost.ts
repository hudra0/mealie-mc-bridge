// Token prices per model and the cost estimate for a conversion. Prices are USD per one
// million tokens from the providers' price lists (checked 2026-10); they change, so
// LLM_PRICES_JSON can override or extend the table without a release, for example
// {"gpt-5.5": {"input": 5, "cachedInput": 0.5, "output": 30}}.

import { z } from "zod";
import type { TokenUsage } from "./types.js";

export interface ModelPrice {
  input: number;
  output: number;
  // Price of input tokens read from the prompt cache; the input price when absent.
  cachedInput?: number;
  // Price of input tokens written to the prompt cache; the input price when absent.
  cacheWrite?: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export const PRICES_CHECKED = "2026-10";

// Standard tier, prompts up to the long-context threshold. Anthropic cache writes are the
// 5-minute rate (1.25 times input).
export const DEFAULT_PRICES: PriceTable = {
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  "claude-opus-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-5-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
};

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

export function priceTable(overridesJson?: string): PriceTable {
  return { ...DEFAULT_PRICES, ...parsePriceOverrides(overridesJson) };
}

// The price of a model: an exact match, or the base name of a dated snapshot such as
// gpt-5.5-2026-04-23 or claude-opus-5-5-20260401.
export function priceFor(
  model: string,
  prices: PriceTable = DEFAULT_PRICES,
): ModelPrice | undefined {
  const exact = prices[model];
  if (exact) return exact;
  const base = model.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  return base === model ? undefined : prices[base];
}

// USD for the usage, rounded to a millionth; undefined when the model has no price.
export function estimateCost(
  usage: Omit<TokenUsage, "costUsd">,
  model: string,
  prices: PriceTable = DEFAULT_PRICES,
): number | undefined {
  const price = priceFor(model, prices);
  if (!price) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached - written);
  const usd =
    (uncached * price.input +
      cached * (price.cachedInput ?? price.input) +
      written * (price.cacheWrite ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
