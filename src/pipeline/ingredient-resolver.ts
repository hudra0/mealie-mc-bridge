// Finds the systemIngredientId for the ingredient names of a converted recipe, so the
// Monsieur Cuisine app can put them on its shopping list and filter by them. The device
// itself shows no icons either way, so a name without an id still cooks fine.
//
// Three layers, first hit wins:
//   1. the catalog from knowledge/ingredient-catalog.json, in memory;
//   2. the ingredient_cache table: ids an earlier search found, and recent misses;
//   3. the quick search of Monsieur Cuisine, at most one request per second.
//
// Only a name that is the same after normalizeIngredientName counts as a match, in the
// catalog and in the search hits alike. The search answers "Wasser" with "Wasser erhitzen"
// and the like, so its first hit is never taken on trust. A miss is cached for
// NEGATIVE_TTL_MS so an unknown name costs one search a week, not one per job.
//
// A session error from the search is passed on, so the job waits for a new session like
// any other session problem. Every other search failure is logged and leaves the name
// without an id; it is not cached, so the next job tries again.

import { errorMessage, type AppLogger } from "../app-logger.js";
import {
  lookupCatalog,
  normalizeIngredientName,
  type IngredientCatalog,
} from "../ingredients/catalog.js";
import { McSessionError, type McClient } from "../mc/index.js";
import type { IngredientCacheStore } from "../store/ingredient-cache.js";

export type ResolveMode = "exact" | "off";
export const RESOLVE_MODES = ["exact", "off"] as const satisfies readonly ResolveMode[];

export const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SEARCH_REQUESTS_PER_SECOND = 1;

export type IngredientSearch = Pick<McClient, "searchIngredients">;

export interface IngredientResolveStats {
  catalog: number;
  cache: number;
  search: number;
  unresolved: number;
}

export interface IngredientResolution {
  // Normalized name (normalizeIngredientName) to id, null when none was found.
  ids: Map<string, number | null>;
  // Counted per distinct normalized name.
  stats: IngredientResolveStats;
  // The names without an id, as first given.
  unresolvedNames: string[];
  // False when resolution is switched off.
  enabled: boolean;
}

export interface ResolveOptions {
  // Checked before and after the rate-limit wait of every search; once aborted, the
  // remaining names stay without an id and nothing more is cached.
  signal?: AbortSignal;
}

export interface IngredientResolverPort {
  resolveAll(names: readonly string[], options?: ResolveOptions): Promise<IngredientResolution>;
}

// Spaces requests out to `ratePerSecond`, with a burst of `capacity`. Calls queue up in
// order.
export class TokenBucket {
  readonly #rate: number;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #tokens: number;
  #updatedAt: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: {
    ratePerSecond: number;
    capacity?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    if (!(options.ratePerSecond > 0)) throw new RangeError("ratePerSecond must be positive");
    this.#rate = options.ratePerSecond;
    this.#capacity = Math.max(1, options.capacity ?? 1);
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.#tokens = this.#capacity;
    this.#updatedAt = this.#now();
  }

  take(): Promise<void> {
    const next = this.#queue.then(() => this.#takeOne());
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #takeOne(): Promise<void> {
    this.#refill();
    if (this.#tokens < 1) {
      await this.#sleep(Math.ceil(((1 - this.#tokens) / this.#rate) * 1000));
      this.#refill();
    }
    this.#tokens = Math.max(0, this.#tokens - 1);
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#updatedAt) / 1000;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#rate);
    this.#updatedAt = now;
  }
}

export interface IngredientResolverOptions {
  mode: ResolveMode;
  // Required for mode "exact"; may be null when resolution is off.
  catalog: IngredientCatalog | null;
  cache: Pick<IngredientCacheStore, "get" | "put">;
  search: IngredientSearch | null;
  logger: AppLogger;
  negativeTtlMs?: number;
  // The bucket the searches draw from; defaults to SEARCH_REQUESTS_PER_SECOND.
  limiter?: Pick<TokenBucket, "take">;
  now?: () => Date;
  isSessionError?: (error: unknown) => boolean;
}

export class IngredientResolver implements IngredientResolverPort {
  readonly #options: IngredientResolverOptions;
  readonly #limiter: Pick<TokenBucket, "take">;
  readonly #now: () => Date;
  readonly #isSessionError: (error: unknown) => boolean;

  constructor(options: IngredientResolverOptions) {
    if (options.mode === "exact" && !options.catalog) {
      throw new TypeError("IngredientResolver needs a catalog in mode exact");
    }
    this.#options = options;
    this.#limiter =
      options.limiter ?? new TokenBucket({ ratePerSecond: SEARCH_REQUESTS_PER_SECOND });
    this.#now = options.now ?? (() => new Date());
    this.#isSessionError = options.isSessionError ?? ((error) => error instanceof McSessionError);
  }

  get mode(): ResolveMode {
    return this.#options.mode;
  }

  async resolveAll(
    names: readonly string[],
    options: ResolveOptions = {},
  ): Promise<IngredientResolution> {
    const distinct = new Map<string, string>();
    for (const name of names) {
      const key = normalizeIngredientName(name);
      if (key !== "" && !distinct.has(key)) distinct.set(key, name.trim());
    }
    const ids = new Map<string, number | null>();
    const stats: IngredientResolveStats = { catalog: 0, cache: 0, search: 0, unresolved: 0 };
    const unresolvedNames: string[] = [];
    const enabled = this.#options.mode !== "off";
    const miss = (key: string, name: string) => {
      ids.set(key, null);
      stats.unresolved++;
      unresolvedNames.push(name);
    };

    for (const [key, name] of distinct) {
      if (!enabled) {
        miss(key, name);
        continue;
      }
      const fromCatalog = this.#options.catalog ? lookupCatalog(this.#options.catalog, name) : null;
      if (fromCatalog !== null) {
        ids.set(key, fromCatalog);
        stats.catalog++;
        continue;
      }
      const cached = this.#options.cache.get(key);
      if (cached && cached.systemIngredientId !== null) {
        ids.set(key, cached.systemIngredientId);
        stats.cache++;
        continue;
      }
      if (cached && !this.#expired(cached.resolvedAt)) {
        miss(key, name);
        continue;
      }
      if (options.signal?.aborted || !this.#options.search) {
        miss(key, name);
        continue;
      }
      const found = await this.#search(key, name, options.signal);
      if (found === null) {
        miss(key, name);
      } else {
        ids.set(key, found);
        stats.search++;
      }
    }
    return { ids, stats, unresolvedNames, enabled };
  }

  // The id of a hit whose name equals the query after normalization, or null.
  async #search(key: string, name: string, signal?: AbortSignal): Promise<number | null> {
    const search = this.#options.search;
    if (!search) return null;
    await this.#limiter.take();
    // The wait can last a second; a shutdown in the meantime sends no further request.
    if (signal?.aborted) return null;
    let hits: Awaited<ReturnType<IngredientSearch["searchIngredients"]>>;
    try {
      hits = await search.searchIngredients(name);
    } catch (error) {
      if (this.#isSessionError(error)) throw error;
      this.#options.logger.warn(
        { ingredient: name, err: errorMessage(error) },
        "ingredient search failed; continuing without an id",
      );
      return null;
    }
    const hit = hits.find((candidate) => normalizeIngredientName(candidate.name) === key);
    const id = hit?.systemIngredientId ?? null;
    if (id !== null && Number.isInteger(id) && id > 0) {
      this.#options.cache.put(key, id, "search");
      return id;
    }
    this.#options.cache.put(key, null, "none");
    return null;
  }

  #expired(resolvedAt: string): boolean {
    const at = Date.parse(resolvedAt);
    const ttl = this.#options.negativeTtlMs ?? NEGATIVE_TTL_MS;
    return Number.isNaN(at) || this.#now().getTime() - at >= ttl;
  }
}

// One line for the job log.
export function describeResolution(resolution: IngredientResolution): string {
  if (!resolution.enabled) {
    return `Ingredient ids not resolved (MC_RESOLVE_INGREDIENTS=off): ${resolution.stats.unresolved} without id`;
  }
  const s = resolution.stats;
  return `Ingredients resolved: ${s.catalog} catalog, ${s.cache} cache, ${s.search} search, ${s.unresolved} without id`;
}
