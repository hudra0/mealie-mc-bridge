import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES,
  PriceTableError,
  estimateCost,
  parsePriceOverrides,
  priceFor,
  priceTable,
} from "./cost.js";

describe("price table", () => {
  it("prices the default models of both providers", () => {
    expect(DEFAULT_PRICES["gpt-5.5"]).toEqual({ input: 5, cachedInput: 0.5, output: 30 });
    expect(DEFAULT_PRICES["claude-opus-5-5"]).toEqual({
      input: 4,
      cachedInput: 0.2,
      cacheWrite: 5,
      output: 20,
    });
  });

  it("finds dated snapshots by their base name, but not other models", () => {
    expect(priceFor("gpt-5.5-2026-04-23")).toBe(DEFAULT_PRICES["gpt-5.5"]);
    expect(priceFor("claude-opus-5-5-20260401")).toBe(DEFAULT_PRICES["claude-opus-5-5"]);
    expect(priceFor("gpt-5.5-turbo")).toBeUndefined();
    expect(priceFor("unknown-model")).toBeUndefined();
  });
});

describe("estimateCost", () => {
  it("prices uncached, cached and cache-write input separately", () => {
    // 10k input of which 6k cached and 1k written, 2k output on Opus 5.5:
    // 3k × 4 + 6k × 0.2 + 1k × 5 + 2k × 20 = 12 000 + 1 200 + 5 000 + 40 000 per million.
    const usage = {
      inputTokens: 10_000,
      cachedInputTokens: 6_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 2_000,
    };
    expect(estimateCost(usage, "claude-opus-5-5")).toBe(0.0582);
  });

  it("uses the input price when no cache price is listed", () => {
    expect(
      estimateCost({ inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 0 }, "gpt-5.5-pro"),
    ).toBe(0.03);
  });

  it("returns undefined for a model without a price", () => {
    expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, "mystery")).toBeUndefined();
  });
});

describe("LLM_PRICES_JSON", () => {
  it("overrides and extends the table", () => {
    const prices = priceTable(
      '{"gpt-5.5": {"input": 1, "output": 2}, "local-model": {"input": 0, "output": 0, "cachedInput": 0, "cacheWrite": 0}}',
    );
    expect(prices["gpt-5.5"]).toEqual({ input: 1, output: 2 });
    expect(prices["local-model"]).toEqual({ input: 0, output: 0, cachedInput: 0, cacheWrite: 0 });
    expect(prices["claude-opus-5-5"]).toBe(DEFAULT_PRICES["claude-opus-5-5"]);
    expect(
      estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gpt-5.5", prices),
    ).toBe(3);
  });

  it("treats a missing or empty value as no override", () => {
    expect(parsePriceOverrides(undefined)).toEqual({});
    expect(parsePriceOverrides("  ")).toEqual({});
  });

  it("rejects malformed values", () => {
    expect(() => parsePriceOverrides("{")).toThrow(PriceTableError);
    expect(() => parsePriceOverrides('{"m": {"input": -1, "output": 1}}')).toThrow(/m\.input/);
    expect(() => parsePriceOverrides('{"m": {"input": 1}}')).toThrow(PriceTableError);
  });
});
