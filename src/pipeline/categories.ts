// Monsieur Cuisine categories for a recipe: the live catalog (cached for a day in the
// settings table), a name match from the Mealie categories and tags, and the merge with
// the ids the converter picked.

import type { McCategory, McRecipeSink } from "../mc/index.js";
import type { SettingsStore } from "../store/settings.js";

export const CATEGORY_CACHE_KEY = "mc.categories";
export const CATEGORY_CACHE_TTL_MS = 24 * 60 * 60_000;

export interface CategoryCatalog {
  categories: McCategory[];
  fetchedAt: string;
  source: "cache" | "proxy" | "public" | "stale-cache";
}

interface CachedCatalog {
  fetchedAt: string;
  categories: McCategory[];
}

// The catalog from the cache when it is younger than a day, else from Monsieur Cuisine.
// When the fetch fails and an older cache exists, the older cache is used; a dead session
// is never hidden that way, because the job could not upload anyway.
export async function loadCategories(
  mc: Pick<McRecipeSink, "getCategories">,
  settings: SettingsStore,
  options: { now?: () => Date; ttlMs?: number; isSessionError?: (error: unknown) => boolean } = {},
): Promise<CategoryCatalog> {
  const now = options.now ?? (() => new Date());
  const ttl = options.ttlMs ?? CATEGORY_CACHE_TTL_MS;
  const cached = settings.getJson<CachedCatalog>(CATEGORY_CACHE_KEY);
  const valid = cached && Array.isArray(cached.categories) && cached.categories.length > 0;
  if (valid && now().getTime() - new Date(cached.fetchedAt).getTime() < ttl) {
    return { categories: cached.categories, fetchedAt: cached.fetchedAt, source: "cache" };
  }
  try {
    const list = await mc.getCategories();
    const fetchedAt = now().toISOString();
    settings.setJson(CATEGORY_CACHE_KEY, { fetchedAt, categories: list.categories });
    return { categories: list.categories, fetchedAt, source: list.source };
  } catch (error) {
    if (!valid || options.isSessionError?.(error)) throw error;
    return { categories: cached.categories, fetchedAt: cached.fetchedAt, source: "stale-cache" };
  }
}

// Words that say nothing about the dish on their own.
const STOP_WORDS = new Set(["kuche", "rezept", "rezepte", "gericht", "gerichte", "essen", "and"]);

// Lower case without diacritics: umlauts lose their dots, so a plural with an umlaut
// ("Eintöpfe") meets its singular ("Eintopf").
function fold(text: string): string {
  return text.toLowerCase().replace(/ß/g, "ss").normalize("NFKD").replace(/\p{M}/gu, "");
}

// A crude German stem: plural and inflection endings off, as long as four letters remain.
function stem(word: string): string {
  for (const suffix of ["en", "er", "e", "n", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function words(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

// The parts of a category name ("Suppen & Eintöpfe" -> "suppen", "eintoepfe"), each as the
// stems of its words joined.
function parts(name: string): string[] {
  return name
    .split(/\s*(?:[&,/+]|\bund\b)\s*/i)
    .map((part) => words(part).map(stem).join(""))
    .filter((part) => part !== "");
}

function keyWords(text: string): string[] {
  return words(text)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
    .map(stem);
}

// Whether a Mealie category or tag names this Monsieur Cuisine category.
export function namesMatch(mealieName: string, categoryName: string): boolean {
  const whole = words(mealieName).map(stem).join("");
  if (whole === "") return false;
  if (parts(categoryName).includes(whole)) return true;
  const ours = new Set(keyWords(mealieName));
  return keyWords(categoryName).some((word) => ours.has(word));
}

export interface CategoryMatch {
  category: McCategory;
  // The Mealie names that matched.
  matchedBy: string[];
}

// Categories whose name matches a Mealie category or tag, in catalog order.
export function matchCategories(
  mealieNames: readonly string[],
  catalog: readonly McCategory[],
): CategoryMatch[] {
  const names = [...new Set(mealieNames.map((name) => name.trim()).filter(Boolean))];
  const matches: CategoryMatch[] = [];
  for (const category of catalog) {
    const matchedBy = names.filter((name) => namesMatch(name, category.name));
    if (matchedBy.length > 0) matches.push({ category, matchedBy });
  }
  return matches;
}

// "<id>: <name>" lines for the converter, matched categories first.
export function categoryHints(
  catalog: readonly McCategory[],
  matches: readonly CategoryMatch[],
): string[] {
  const first = new Set(matches.map((match) => match.category.id));
  const ordered = [
    ...matches.map((match) => match.category),
    ...catalog.filter((category) => !first.has(category.id)),
  ];
  return ordered.map((category) => `${category.id}: ${category.name}`);
}

export interface MergedCategories {
  ids: number[];
  // Ids the converter picked that are not in the catalog.
  dropped: number[];
}

// The matched ids, then the converter's ids that exist in the catalog, without duplicates,
// cut to the most a recipe may carry.
export function mergeCategoryIds(
  matched: readonly number[],
  picked: readonly number[],
  catalog: readonly McCategory[],
  max: number,
): MergedCategories {
  const known = new Set(catalog.map((category) => category.id));
  const dropped = picked.filter((id) => !known.has(id));
  const ids = [...new Set([...matched, ...picked.filter((id) => known.has(id))])].slice(0, max);
  return { ids, dropped };
}
