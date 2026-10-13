// Near matches in the ingredient catalog, for two jobs:
//
// - suggest: before the conversion, up to three catalog names per source ingredient, so
//   the model can write a name the catalog knows ("Butternusskürbis" -> "Butternutkürbis").
//   Suggestions are only offered to the model; they never set an id by themselves.
// - relaxedLookup: after the conversion, a second catalog lookup for a name without an
//   exact hit, with qualifiers taken off ("Ingwer, frisch" -> "Ingwer"), a parenthesis
//   turned into the catalog's comma form ("Zwiebeln (rot)" -> "Zwiebeln, rot") and
//   singular and plural folded together ("Knoblauchknollen" -> "Knoblauchknolle").
//
// The relaxed lookup stays conservative, because a wrong id files the ingredient under a
// different product: it only removes phrases the locale pack lists as qualifiers, and it
// folds endings only on words of at least MIN_STEM_WORD letters, so "Eis" never meets
// "Ei" and "Butt" never meets "Butter".

import type { LocalePack } from "../locale/pack.js";
import { normalizeIngredientName, type IngredientCatalog } from "./catalog.js";

// What a locale pack says about ingredient names (phrases.json matching and
// qualifierSuffixes).
export interface CatalogMatchRules {
  // Words that qualify a name rather than name the food ("frisch", "rot", "zum").
  stopwords: readonly string[];
  // Endings stripped so singular and plural meet, tried in order.
  stemEndings: readonly string[];
  // Trailing phrases that say how an ingredient is used or bought, not what it is.
  qualifierSuffixes: readonly string[];
}

export function catalogMatchRules(pack: Pick<LocalePack, "phrases">): CatalogMatchRules {
  return {
    stopwords: pack.phrases.matching.stopwords,
    stemEndings: pack.phrases.matching.stemEndings,
    qualifierSuffixes: pack.phrases.qualifierSuffixes,
  };
}

export interface CatalogHit {
  name: string;
  systemIngredientId: number;
}

export interface CatalogMatcher {
  // Up to `limit` catalog names close to `name`, best first.
  suggest(name: string, limit?: number): string[];
  // The catalog entry a relaxed form of `name` matches, or null. The exact match is the
  // caller's first try (lookupCatalog); this is the second.
  relaxedLookup(name: string): CatalogHit | null;
}

export const DEFAULT_SUGGESTIONS = 3;
// Words shorter than this keep their endings in the relaxed key.
export const MIN_STEM_WORD = 5;
const MIN_STEM = 4;

// Score weights of suggest. A content word that matches counts 1, a qualifier word 0.4;
// words of the catalog name the query does not have cost a little, an amount in the name
// ("Zwiebel (100 g)") costs more.
const QUALIFIER_WEIGHT = 0.4;
const UNMATCHED_CONTENT_PENALTY = 0.15;
const UNMATCHED_QUALIFIER_PENALTY = 0.05;
const DIGIT_PENALTY = 0.3;
const MIN_CONTENT_SCORE = 0.75;
const MIN_SCORE = 0.6;
// A spelling variant shares a start and an end: "butternuss|kürbis" and "butternut|kürbis".
// A word that only shares the start is usually another product ("Butter", "Butterkeks").
const MIN_PREFIX = 4;
const MIN_SUFFIX = 3;
const MIN_VARIANT_SHARE = 0.6;

interface Token {
  word: string;
  stem: string;
  qualifier: boolean;
}

interface Entry {
  name: string;
  id: number;
  uses: number;
  hasDigit: boolean;
  tokens: Token[];
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createCatalogMatcher(
  catalog: IngredientCatalog,
  rules: CatalogMatchRules,
): CatalogMatcher {
  const stopwords = new Set(rules.stopwords.map((word) => word.toLowerCase()));
  const endings = rules.stemEndings.map((ending) => ending.toLowerCase());
  const suffixes = rules.qualifierSuffixes
    .map((suffix) => suffix.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const suffixPattern =
    suffixes.length > 0
      ? new RegExp(`(?:^|[\\s,;–-]+)(?:${suffixes.map(escapeRegex).join("|")})\\s*$`, "iu")
      : null;

  // A short word keeps its form and a marker, so it never equals the stem of a longer
  // word: "butt" stays "butt#" while "butter" becomes "butt".
  const stem = (word: string): string => {
    if (word.length < MIN_STEM_WORD) return `${word}#`;
    for (const ending of endings) {
      if (word.endsWith(ending) && word.length - ending.length >= MIN_STEM) {
        return word.slice(0, -ending.length);
      }
    }
    return word;
  };
  const words = (text: string): string[] =>
    (
      text
        .normalize("NFC")
        .toLowerCase()
        .match(/\p{L}+/gu) ?? []
    ).filter((word) => word.length >= 2);
  const tokens = (text: string, qualifier = false): Token[] =>
    words(text).map((word) => ({
      word,
      stem: stem(word),
      qualifier: qualifier || stopwords.has(word),
    }));
  // The name with its words folded: "Zwiebeln, rote" and "Zwiebeln, rot" both become
  // "zwiebel, rot". Short words stay as they are.
  const looseKey = (name: string): string =>
    normalizeIngredientName(name).replace(/\p{L}+/gu, (word) => stem(word));
  // The same words and numbers in any order: "Rosmarin, getrocknet" and "getrockneter
  // Rosmarin". Numbers count, so "Mehl (Type 1050)" never meets "Mehl (Type 405)".
  const wordsKey = (name: string): string => {
    const parts =
      name
        .normalize("NFC")
        .toLowerCase()
        .match(/\p{L}+|\d+(?:[.,]\d+)?/gu) ?? [];
    return [...new Set(parts.map((part) => (/\d/.test(part) ? part : stem(part))))]
      .sort()
      .join(" ");
  };
  const stripSuffixes = (name: string): string => {
    let current = name.trim();
    if (!suffixPattern) return current;
    for (;;) {
      const next = current.replace(suffixPattern, "").trim();
      if (next === current || next === "") return current;
      current = next;
    }
  };

  const entries: Entry[] = catalog.entries.map((entry) => ({
    name: entry.name,
    id: entry.systemIngredientId,
    uses: entry.officialRecipes + entry.memberRecipes,
    hasDigit: /\d/.test(entry.name),
    tokens: tokens(entry.name),
  }));
  // Name and loose key to entry. The first entry wins; the catalog lists common names first.
  const byName = new Map<string, Entry>();
  const byLooseKey = new Map<string, Entry>();
  const byWords = new Map<string, Entry>();
  for (const entry of entries) {
    const exact = normalizeIngredientName(entry.name);
    if (!byName.has(exact)) byName.set(exact, entry);
    const loose = looseKey(entry.name);
    if (!byLooseKey.has(loose)) byLooseKey.set(loose, entry);
    const bag = wordsKey(entry.name);
    if (bag !== "" && !byWords.has(bag)) byWords.set(bag, entry);
  }

  // The relaxed forms of a name, most specific first.
  const relaxedForms = (name: string): string[] => {
    const forms: string[] = [];
    const add = (form: string) => {
      const trimmed = form
        .replace(/\s+/g, " ")
        .replace(/[\s,]+$/, "")
        .trim();
      if (trimmed !== "" && !forms.includes(trimmed)) forms.push(trimmed);
    };
    const stripped = stripSuffixes(name);
    add(stripped);
    // "Zwiebeln (rot)" -> "Zwiebeln, rot", then without the parenthesis.
    const paren = /^(.*?)\s*\(([^()]*)\)\s*$/u.exec(stripped);
    if (paren?.[1]) {
      const inner = paren[2]?.trim() ?? "";
      if (inner !== "") add(`${paren[1]}, ${inner}`);
      add(stripSuffixes(paren[1]));
    }
    return forms;
  };

  const variant = (a: string, b: string): number => {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    let prefix = 0;
    while (prefix < short.length && short[prefix] === long[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < short.length - prefix &&
      short[short.length - 1 - suffix] === long[long.length - 1 - suffix]
    ) {
      suffix++;
    }
    if (prefix < MIN_PREFIX || suffix < MIN_SUFFIX) return 0;
    const share = (prefix + suffix) / long.length;
    return share >= MIN_VARIANT_SHARE ? Math.min(0.9, 0.5 + 0.4 * share) : 0;
  };

  const score = (query: readonly Token[], queryHasDigit: boolean, entry: Entry): number => {
    let content = 0;
    let qualifiers = 0;
    const matched = new Set<Token>();
    for (const token of query) {
      let best = 0;
      let bestToken: Token | null = null;
      for (const candidate of entry.tokens) {
        const value =
          candidate.stem === token.stem
            ? 1
            : token.qualifier
              ? 0
              : variant(token.word, candidate.word);
        if (value > best) {
          best = value;
          bestToken = candidate;
        }
      }
      if (bestToken) matched.add(bestToken);
      if (token.qualifier) qualifiers += best === 1 ? QUALIFIER_WEIGHT : 0;
      else content += best;
    }
    if (content < MIN_CONTENT_SCORE) return 0;
    let total = content + qualifiers;
    for (const token of entry.tokens) {
      if (matched.has(token)) continue;
      total -= token.qualifier ? UNMATCHED_QUALIFIER_PENALTY : UNMATCHED_CONTENT_PENALTY;
    }
    if (entry.hasDigit && !queryHasDigit) total -= DIGIT_PENALTY;
    return total;
  };

  return {
    suggest(name, limit = DEFAULT_SUGGESTIONS) {
      if (limit <= 0) return [];
      const stripped = stripSuffixes(name);
      // The words of the stripped qualifiers still favour a catalog name that has them
      // ("frisch" -> "frischer Ingwer"), but they cannot carry a match on their own.
      const removed = name.trim().slice(stripped.length);
      const query = [...tokens(stripped), ...tokens(removed, true)];
      if (!query.some((token) => !token.qualifier)) return [];
      const queryHasDigit = /\d/.test(name);
      return entries
        .map((entry) => ({ entry, value: score(query, queryHasDigit, entry) }))
        .filter((scored) => scored.value >= MIN_SCORE)
        .sort((a, b) => b.value - a.value || b.entry.uses - a.entry.uses)
        .slice(0, limit)
        .map((scored) => scored.entry.name);
    },
    relaxedLookup(name) {
      const forms = relaxedForms(name);
      for (const form of forms) {
        const entry = byName.get(normalizeIngredientName(form));
        if (entry) return { name: entry.name, systemIngredientId: entry.id };
      }
      for (const form of [name, ...forms]) {
        const entry = byLooseKey.get(looseKey(form));
        if (entry) return { name: entry.name, systemIngredientId: entry.id };
      }
      for (const form of [name, ...forms]) {
        const entry = byWords.get(wordsKey(form));
        if (entry) return { name: entry.name, systemIngredientId: entry.id };
      }
      return null;
    },
  };
}
