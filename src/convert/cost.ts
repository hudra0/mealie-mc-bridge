// Token prices per model and the cost estimate for a conversion. Prices are USD per one
// million tokens from the providers' price lists (checked 2026-10); they change, so
// LLM_PRICES_JSON can override or extend the table without a release, for example
// {"gpt-5.5": {"input": 5, "cachedInput": 0.5, "output": 30}}.

import { parsePriceOverrides, type ModelPrice } from "./settings.js";
import type { TokenUsage } from "./types.js";

export { PriceTableError, parsePriceOverrides, type ModelPrice } from "./settings.js";

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
  // A server-side fallback target.
  "claude-opus-4-8": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-5-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
};

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
