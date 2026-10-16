import { describe, expect, it, vi } from "vitest";
import { createIngredientCatalog } from "../ingredients/catalog.js";
import { McApiError, McSessionError, type McIngredientSuggestion } from "../mc/index.js";
import type { CachedIngredient, IngredientCacheSource } from "../store/ingredient-cache.js";
import { jobEventMessage } from "../i18n/index.js";
import { silentLogger } from "../testing/fakes.js";
import {
  IngredientResolver,
  CACHE_KEY_VERSION,
  NEGATIVE_TTL_MS,
  TokenBucket,
  cacheKey,
  resolutionEvent,
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
    expect(result.stats).toEqual({
      catalog: 1,
      catalogRelaxed: 0,
      cache: 0,
      search: 0,
      unresolved: 0,
    });
    expect(result.enabled).toBe(true);
    expect(t.cache.get).not.toHaveBeenCalled();
    expect(t.search.searchIngredients).not.toHaveBeenCalled();
  });

  it("takes an id from the cache", async () => {
    const cache = fakeCache([
      {
        nameNorm: cacheKey("testzutat b"),
        systemIngredientId: 9002,
        source: "search",
        resolvedAt: "2020-01-01T00:00:00.000Z",
      },
    ]);
    const t = resolver({ cache });
    const result = await t.resolver.resolveAll(["Testzutat B"]);
    expect(result.ids.get("testzutat b")).toBe(9002);
    expect(result.stats).toEqual({
      catalog: 0,
      catalogRelaxed: 0,
      cache: 1,
      search: 0,
      unresolved: 0,
    });
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
    expect(result.stats).toEqual({
      catalog: 0,
      catalogRelaxed: 0,
      cache: 0,
      search: 1,
      unresolved: 0,
    });
    expect(t.cache.rows.get(cacheKey("testzutat b"))).toMatchObject({
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
    expect(result.stats).toEqual({
      catalog: 0,
      catalogRelaxed: 0,
      cache: 0,
      search: 0,
      unresolved: 1,
    });
    expect(t.cache.rows.get(cacheKey("wasser"))).toMatchObject({
      systemIngredientId: null,
      source: "none",
    });

    // The cached miss keeps the next job from searching again.
    const again = await t.resolver.resolveAll(["Wasser"]);
    expect(again.stats.unresolved).toBe(1);
    expect(search.searchIngredients).toHaveBeenCalledTimes(1);
  });

  it("searches again once a cached miss is older than seven days", async () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const cache = fakeCache([
      {
        nameNorm: cacheKey("fresh"),
        systemIngredientId: null,
        source: "none",
        resolvedAt: at(NEGATIVE_TTL_MS - 1000),
      },
      {
        nameNorm: cacheKey("stale"),
        systemIngredientId: null,
        source: "none",
        resolvedAt: at(NEGATIVE_TTL_MS),
      },
      {
        nameNorm: cacheKey("broken"),
        systemIngredientId: null,
        source: "none",
        resolvedAt: "not a date",
      },
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
    expect(result.stats).toEqual({
      catalog: 0,
      catalogRelaxed: 0,
      cache: 0,
      search: 1,
      unresolved: 2,
    });
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
    expect(result.stats).toEqual({
      catalog: 1,
      catalogRelaxed: 0,
      cache: 0,
      search: 0,
      unresolved: 1,
    });
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
    expect(result.stats).toEqual({
      catalog: 1,
      catalogRelaxed: 0,
      cache: 0,
      search: 0,
      unresolved: 1,
    });
  });

  it("sends no request when the signal is aborted during the rate-limit wait", async () => {
    const controller = new AbortController();
    const limiter = {
      take: vi.fn(() => {
        controller.abort();
        return Promise.resolve();
      }),
    };
    const t = resolver({ limiter });
    const result = await t.resolver.resolveAll(["Testzutat B", "Testzutat C"], {
      signal: controller.signal,
    });
    expect(limiter.take).toHaveBeenCalledTimes(1);
    expect(t.search.searchIngredients).not.toHaveBeenCalled();
    expect(t.cache.put).not.toHaveBeenCalled();
    expect(result.stats.unresolved).toBe(2);
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
    expect(result.stats).toEqual({
      catalog: 0,
      catalogRelaxed: 0,
      cache: 0,
      search: 0,
      unresolved: 2,
    });
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

// The English job log line of a resolution.
function line(resolution: Parameters<typeof resolutionEvent>[0]): string {
  const event = resolutionEvent(resolution);
  return jobEventMessage(event.code, event.params ?? {});
}

describe("resolutionEvent", () => {
  it("writes one line for the job log", () => {
    const stats = { catalog: 5, catalogRelaxed: 0, cache: 1, search: 2, unresolved: 3 };
    expect(line({ ids: new Map(), stats, unresolvedNames: [], enabled: true })).toBe(
      "Ingredients resolved: 5 catalog, 1 cache, 2 search, 3 without id",
    );
    expect(
      line({
        ids: new Map(),
        stats: { catalog: 0, catalogRelaxed: 0, cache: 0, search: 0, unresolved: 4 },
        unresolvedNames: [],
        enabled: false,
      }),
    ).toBe("Ingredient ids not resolved (MC_RESOLVE_INGREDIENTS=off): 4 without id");
  });
});

describe("IngredientResolver relaxed catalog lookup and suggestions", () => {
  const rules = {
    stopwords: ["frisch", "rot", "zum", "aus", "der"],
    stemEndings: ["en", "er", "n", "e", "s"],
    qualifierSuffixes: ["zum Garnieren", "(optional)"],
    buyingFormSuffixes: { frisch: ["frisch"], "aus der Dose/Glas": ["dose", "glas"] },
  };
  const entry = (name: string, systemIngredientId: number) => ({
    name,
    systemIngredientId,
    officialRecipes: 10,
    memberRecipes: 0,
    category: null,
    alternatives: [],
  });
  const relaxedCatalog = createIngredientCatalog({
    generatedFrom: "test",
    entries: [
      entry("Kokosmilch", 46979),
      entry("Zwiebeln", 54731),
      entry("Zwiebeln, rot", 1149548),
      entry("Knoblauchknolle", 288314),
      entry("Ingwer", 1560),
      entry("Butternutkürbis", 1645058),
      entry("Butter", 17436),
    ],
  });

  it("finds a name with qualifiers by its relaxed form and counts it as a catalog hit", async () => {
    const t = resolver({ catalog: relaxedCatalog, rules });
    const result = await t.resolver.resolveAll([
      "Kokosmilch aus der Dose/Glas",
      "Zwiebeln (rot)",
      "Knoblauchknollen",
      "Ingwer, frisch",
      "Kokosmilch zum Garnieren",
    ]);
    expect(result.ids).toEqual(
      new Map([
        ["kokosmilch aus der dose/glas", 46979],
        ["zwiebeln (rot)", 1149548],
        ["knoblauchknollen", 288314],
        ["ingwer, frisch", 1560],
        ["kokosmilch zum garnieren", 46979],
      ]),
    );
    expect(result.stats).toEqual({
      catalog: 5,
      catalogRelaxed: 5,
      cache: 0,
      search: 0,
      unresolved: 0,
    });
    expect(t.search.searchIngredients).not.toHaveBeenCalled();
  });

  it("takes an id a search found for the exact name before a relaxed form", async () => {
    const recent = NOW.toISOString();
    const cache = fakeCache([
      {
        nameNorm: cacheKey("zwiebeln (rot)"),
        systemIngredientId: 777,
        source: "search",
        resolvedAt: recent,
      },
      {
        nameNorm: cacheKey("kokosmilch zum garnieren"),
        systemIngredientId: null,
        source: "none",
        resolvedAt: recent,
      },
    ]);
    const t = resolver({ catalog: relaxedCatalog, rules, cache });
    const result = await t.resolver.resolveAll(["Zwiebeln (rot)", "Kokosmilch zum Garnieren"]);
    // A cached miss does not hide the relaxed hit.
    expect(result.ids).toEqual(
      new Map([
        ["zwiebeln (rot)", 777],
        ["kokosmilch zum garnieren", 46979],
      ]),
    );
    expect(result.stats).toMatchObject({ catalog: 1, catalogRelaxed: 1, cache: 1 });
  });

  it("takes no spelling variant or short word as an id, and searches those names exactly", async () => {
    const search = fakeSearch([{ name: "Butternutkürbis", systemIngredientId: 1645058 }]);
    const t = resolver({ catalog: relaxedCatalog, rules, search });
    const result = await t.resolver.resolveAll(["Butternusskürbis", "Butt"]);
    expect(result.ids).toEqual(
      new Map([
        ["butternusskürbis", null],
        ["butt", null],
      ]),
    );
    expect(search.searchIngredients.mock.calls.map(([q]) => q)).toEqual([
      "Butternusskürbis",
      "Butt",
    ]);
    expect(result.stats).toEqual({
      catalog: 0,
      catalogRelaxed: 0,
      cache: 0,
      search: 0,
      unresolved: 2,
    });
  });

  it("keeps to exact names without the pack rules", async () => {
    const t = resolver({ catalog: relaxedCatalog });
    const result = await t.resolver.resolveAll(["Ingwer, frisch"]);
    expect(result.ids.get("ingwer, frisch")).toBeNull();
    expect(t.resolver.suggest(["Ingwer, frisch"])).toEqual([[]]);
  });

  it("forgets misses cached under an older key version but keeps found ids", async () => {
    expect(cacheKey("wasser")).toBe(`v${CACHE_KEY_VERSION}|wasser`);
    const recent = NOW.toISOString();
    const cache = fakeCache([
      { nameNorm: "wasser", systemIngredientId: null, source: "none", resolvedAt: recent },
      { nameNorm: "testzutat b", systemIngredientId: 9002, source: "search", resolvedAt: recent },
    ]);
    const search = fakeSearch([{ name: "Wasser", systemIngredientId: 4711 }]);
    const t = resolver({ cache, search });
    const result = await t.resolver.resolveAll(["Wasser", "Testzutat B"]);
    expect(result.ids).toEqual(
      new Map([
        ["wasser", 4711],
        ["testzutat b", 9002],
      ]),
    );
    expect(search.searchIngredients).toHaveBeenCalledTimes(1);
    expect(cache.rows.get(cacheKey("wasser"))).toMatchObject({ systemIngredientId: 4711 });
  });

  it("suggests catalog names per source name, in input order", () => {
    const t = resolver({ catalog: relaxedCatalog, rules });
    const suggestions = t.resolver.suggest([
      "Butternusskürbis",
      "Zwiebeln (rot)",
      "Kokosmilch aus der Dose/Glas",
      "Salz",
    ]);
    expect(suggestions[0]).toEqual(["Butternutkürbis"]);
    expect(suggestions[1]?.[0]).toBe("Zwiebeln, rot");
    expect(suggestions[2]).toEqual(["Kokosmilch"]);
    expect(suggestions[3]).toEqual([]);
    expect(t.resolver.suggest(["Zwiebeln (rot)"], 1)).toEqual([["Zwiebeln, rot"]]);
  });

  it("suggests nothing when switched off", () => {
    const t = resolver({ mode: "off", catalog: relaxedCatalog, rules });
    expect(t.resolver.suggest(["Butternusskürbis"])).toEqual([[]]);
  });

  it("names the relaxed hits in the job log line", () => {
    const stats = { catalog: 5, catalogRelaxed: 2, cache: 0, search: 0, unresolved: 1 };
    expect(line({ ids: new Map(), stats, unresolvedNames: [], enabled: true })).toBe(
      "Ingredients resolved: 5 catalog (2 relaxed), 0 cache, 0 search, 1 without id",
    );
  });
});
