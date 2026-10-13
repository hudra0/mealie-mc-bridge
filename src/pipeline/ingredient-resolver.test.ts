import { describe, expect, it, vi } from "vitest";
import { createIngredientCatalog } from "../ingredients/catalog.js";
import { McApiError, McSessionError, type McIngredientSuggestion } from "../mc/index.js";
import type { CachedIngredient, IngredientCacheSource } from "../store/ingredient-cache.js";
import { silentLogger } from "../testing/fakes.js";
import {
  IngredientResolver,
  NEGATIVE_TTL_MS,
  TokenBucket,
  describeResolution,
  type IngredientResolverOptions,
} from "./ingredient-resolver.js";

const NOW = new Date("2026-10-13T10:00:00.000Z");

const catalog = createIngredientCatalog({
  generatedFrom: "test",
  entries: [
    {
      name: "Testzutat A",
      systemIngredientId: 9001,
      officialRecipes: 3,
      memberRecipes: 0,
      category: null,
      alternatives: [],
    },
  ],
});

function fakeCache(entries: CachedIngredient[] = []) {
  const rows = new Map(entries.map((entry) => [entry.nameNorm, entry]));
  return {
    rows,
    get: vi.fn((nameNorm: string) => rows.get(nameNorm) ?? null),
    put: vi.fn((nameNorm: string, id: number | null, source: IngredientCacheSource) => {
      const row = { nameNorm, systemIngredientId: id, source, resolvedAt: NOW.toISOString() };
      rows.set(nameNorm, row);
      return row;
    }),
  };
}

function fakeSearch(
  answer: McIngredientSuggestion[] | Error | ((q: string) => McIngredientSuggestion[]),
) {
  return {
    searchIngredients: vi.fn((query: string) => {
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(typeof answer === "function" ? answer(query) : answer);
    }),
  };
}

function resolver(overrides: Partial<IngredientResolverOptions> = {}) {
  const cache = fakeCache();
  const search = fakeSearch([]);
  const limiter = { take: vi.fn(() => Promise.resolve()) };
  const logger = silentLogger();
  const warn = vi.spyOn(logger, "warn");
  const options: IngredientResolverOptions = {
    mode: "exact",
    catalog,
    cache,
    search,
    logger,
    limiter,
    now: () => NOW,
    ...overrides,
  };
  return { resolver: new IngredientResolver(options), cache, search, limiter, warn, options };
}

const sessionError = () =>
  new McSessionError({
    kind: "expired",
    status: 401,
    code: 110002,
    serverMessage: "ExpiredAuthCookieException",
    endpoint: "GET api/v1/ingredients/quick-search",
  });

describe("IngredientResolver", () => {
  it("takes a catalog hit without touching the cache or the search", async () => {
    const t = resolver();
    const result = await t.resolver.resolveAll(["Testzutat A", "  testzutat  a "]);
    expect(result.ids).toEqual(new Map([["testzutat a", 9001]]));
    expect(result.stats).toEqual({ catalog: 1, cache: 0, search: 0, unresolved: 0 });
    expect(result.enabled).toBe(true);
    expect(t.cache.get).not.toHaveBeenCalled();
    expect(t.search.searchIngredients).not.toHaveBeenCalled();
  });

  it("takes an id from the cache", async () => {
    const cache = fakeCache([
      {
        nameNorm: "testzutat b",
        systemIngredientId: 9002,
        source: "search",
        resolvedAt: "2020-01-01T00:00:00.000Z",
      },
    ]);
    const t = resolver({ cache });
    const result = await t.resolver.resolveAll(["Testzutat B"]);
    expect(result.ids.get("testzutat b")).toBe(9002);
    expect(result.stats).toEqual({ catalog: 0, cache: 1, search: 0, unresolved: 0 });
    expect(t.search.searchIngredients).not.toHaveBeenCalled();
  });

  it("accepts a search hit with exactly the same name and caches it", async () => {
    const search = fakeSearch([
      { name: "Testzutat B erhitzen", systemIngredientId: 1 },
      { name: "testzutat b", systemIngredientId: 9002 },
      { name: "Testzutat B", systemIngredientId: 9003 },
    ]);
    const t = resolver({ search });
    const result = await t.resolver.resolveAll(["Testzutat B"]);
    expect(search.searchIngredients).toHaveBeenCalledWith("Testzutat B");
    expect(result.ids.get("testzutat b")).toBe(9002);
    expect(result.stats).toEqual({ catalog: 0, cache: 0, search: 1, unresolved: 0 });
    expect(t.cache.rows.get("testzutat b")).toMatchObject({
      systemIngredientId: 9002,
      source: "search",
    });
    expect(t.limiter.take).toHaveBeenCalledTimes(1);
  });

  it("never takes the first hit when no name matches, and caches the miss", async () => {
    const search = fakeSearch([
      { name: "Wasser erhitzen", systemIngredientId: 1 },
      { name: "Wasser, mineralisiert", systemIngredientId: 2 },
    ]);
    const t = resolver({ search });
    const result = await t.resolver.resolveAll(["Wasser"]);
    expect(result.ids.get("wasser")).toBeNull();
    expect(result.unresolvedNames).toEqual(["Wasser"]);
    expect(result.stats).toEqual({ catalog: 0, cache: 0, search: 0, unresolved: 1 });
    expect(t.cache.rows.get("wasser")).toMatchObject({ systemIngredientId: null, source: "none" });

    // The cached miss keeps the next job from searching again.
    const again = await t.resolver.resolveAll(["Wasser"]);
    expect(again.stats.unresolved).toBe(1);
    expect(search.searchIngredients).toHaveBeenCalledTimes(1);
  });

  it("searches again once a cached miss is older than seven days", async () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const cache = fakeCache([
      {
        nameNorm: "fresh",
        systemIngredientId: null,
        source: "none",
        resolvedAt: at(NEGATIVE_TTL_MS - 1000),
      },
      {
        nameNorm: "stale",
        systemIngredientId: null,
        source: "none",
        resolvedAt: at(NEGATIVE_TTL_MS),
      },
      { nameNorm: "broken", systemIngredientId: null, source: "none", resolvedAt: "not a date" },
    ]);
    const search = fakeSearch((q) =>
      q === "stale" ? [{ name: "Stale", systemIngredientId: 77 }] : [],
    );
    const t = resolver({ cache, search });
    const result = await t.resolver.resolveAll(["fresh", "stale", "broken"]);
    expect(search.searchIngredients.mock.calls.map(([q]) => q)).toEqual(["stale", "broken"]);
    expect(result.ids).toEqual(
      new Map([
        ["fresh", null],
        ["stale", 77],
        ["broken", null],
      ]),
    );
    expect(result.stats).toEqual({ catalog: 0, cache: 0, search: 1, unresolved: 2 });
  });

  it("draws every search from the rate limiter", async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const limiter = new TokenBucket({
      ratePerSecond: 1,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    const t = resolver({ limiter });
    await t.resolver.resolveAll(["eins", "zwei", "drei"]);
    expect(t.search.searchIngredients).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("passes a session error on", async () => {
    const t = resolver({ search: fakeSearch(sessionError()) });
    await expect(t.resolver.resolveAll(["Testzutat B"])).rejects.toBeInstanceOf(McSessionError);
    expect(t.cache.put).not.toHaveBeenCalled();
  });

  it("logs any other search error and leaves the name without an id, uncached", async () => {
    const error = new McApiError({
      status: 500,
      code: null,
      serverMessage: null,
      endpoint: "GET quick-search",
      data: null,
    });
    const t = resolver({ search: fakeSearch(error) });
    const result = await t.resolver.resolveAll(["Testzutat B", "Testzutat A"]);
    expect(result.ids).toEqual(
      new Map([
        ["testzutat b", null],
        ["testzutat a", 9001],
      ]),
    );
    expect(result.stats).toEqual({ catalog: 1, cache: 0, search: 0, unresolved: 1 });
    expect(t.cache.put).not.toHaveBeenCalled();
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ingredient: "Testzutat B" }),
      "ingredient search failed; continuing without an id",
    );
  });

  it("stops searching once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const t = resolver();
    const result = await t.resolver.resolveAll(["Testzutat B", "Testzutat A"], {
      signal: controller.signal,
    });
    expect(t.search.searchIngredients).not.toHaveBeenCalled();
    expect(result.stats).toEqual({ catalog: 1, cache: 0, search: 0, unresolved: 1 });
  });

  it("works without a search client", async () => {
    const t = resolver({ search: null });
    const result = await t.resolver.resolveAll(["Testzutat B"]);
    expect(result.stats.unresolved).toBe(1);
    expect(t.cache.put).not.toHaveBeenCalled();
  });

  it("does nothing when switched off", async () => {
    const t = resolver({ mode: "off", catalog: null });
    const result = await t.resolver.resolveAll(["Testzutat A", "Testzutat B", " "]);
    expect(t.resolver.mode).toBe("off");
    expect(result.enabled).toBe(false);
    expect(result.ids).toEqual(
      new Map([
        ["testzutat a", null],
        ["testzutat b", null],
      ]),
    );
    expect(result.stats).toEqual({ catalog: 0, cache: 0, search: 0, unresolved: 2 });
    expect(t.cache.get).not.toHaveBeenCalled();
    expect(t.search.searchIngredients).not.toHaveBeenCalled();
  });

  it("needs a catalog in mode exact", () => {
    expect(() => resolver({ catalog: null })).toThrow(/needs a catalog/);
  });
});

describe("TokenBucket", () => {
  it("lets a full bucket through and spaces the rest", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket({
      ratePerSecond: 2,
      capacity: 2,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    await Promise.all([bucket.take(), bucket.take(), bucket.take()]);
    expect(sleeps).toEqual([500]);
    clock += 10_000;
    await bucket.take();
    expect(sleeps).toEqual([500]);
  });

  it("waits with real timers by default", async () => {
    const bucket = new TokenBucket({ ratePerSecond: 100 });
    const started = Date.now();
    await bucket.take();
    await bucket.take();
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });

  it("rejects a rate that is not positive", () => {
    expect(() => new TokenBucket({ ratePerSecond: 0 })).toThrow(RangeError);
  });
});

describe("describeResolution", () => {
  it("writes one line for the job log", () => {
    const stats = { catalog: 5, cache: 1, search: 2, unresolved: 3 };
    expect(describeResolution({ ids: new Map(), stats, unresolvedNames: [], enabled: true })).toBe(
      "Ingredients resolved: 5 catalog, 1 cache, 2 search, 3 without id",
    );
    expect(
      describeResolution({
        ids: new Map(),
        stats: { catalog: 0, cache: 0, search: 0, unresolved: 4 },
        unresolvedNames: [],
        enabled: false,
      }),
    ).toBe("Ingredient ids not resolved (MC_RESOLVE_INGREDIENTS=off): 4 without id");
  });
});
