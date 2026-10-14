// Near matches in the ingredient catalog, for two jobs:
//
// - suggest: before the conversion, up to three catalog names per source ingredient, so
//   the model can write a name the catalog knows ("Butternusskürbis" -> "Butternutkürbis").
//   Suggestions are only offered to the model; they never set an id by themselves.
// - relaxedLookup: after the conversion, a second catalog lookup for a name without an
//   exact hit: usage notes taken off ("Gemüsebrühe zum Verdünnen" -> "Gemüsebrühe"), a
//   parenthesis turned into the catalog's comma form ("Zwiebeln (rot)" -> "Zwiebeln, rot"),
//   the words in any order ("Rosmarin, getrocknet" -> "getrockneter Rosmarin") and
//   singular and plural folded together ("Knoblauchknollen" -> "Knoblauchknolle").
//
// The relaxed lookup stays conservative, because a wrong id files the ingredient under a
// different product:
// - it tries the forms of a name from the most to the least specific, and each form
//   exactly, folded and in any word order before the next, so "Hefe frisch" finds
//   "Hefe, frisch" and never stops at "Hefe";
// - it removes only phrases the locale pack lists as usage notes, and a buying form ("aus
//   der Dose", "frisch") only when no catalog entry has the base name in that form;
// - it drops a parenthesis only when every word in it is a qualifier, so "Milch (Hafer)"
//   never becomes "Milch";
// - it folds endings only on words of at least MIN_STEM_WORD letters, so "Eis" never meets
//   "Ei" and "Butt" never meets "Butter". Qualifier words (the pack's stopwords) fold at
//   any length, so "rot" meets "rote".

import type { LocalePack } from "../locale/pack.js";
import { normalizeIngredientName, type IngredientCatalog } from "./catalog.js";

// What a locale pack says about ingredient names (phrases.json matching, qualifierSuffixes
// and buyingFormSuffixes).
export interface CatalogMatchRules {
  // Words that qualify a name rather than name the food ("frisch", "rot", "zum").
  stopwords: readonly string[];
  // Endings stripped so singular and plural meet, tried in order.
  stemEndings: readonly string[];
  // Trailing phrases that say how an ingredient is used, not what it is ("zum Garnieren").
  qualifierSuffixes: readonly string[];
  // Trailing phrases that name a buying form ("aus der Dose"), each with the words that
  // mark that form in a catalog name ("dose", "glas"). The relaxed lookup removes one only
  // when no catalog entry has the base name together with one of its words.
  buyingFormSuffixes?: Readonly<Record<string, readonly string[]>>;
  // A regional word and the word the catalog uses ("karotten" -> "möhren"). Suggest only.
  regionalNames?: Readonly<Record<string, string>>;
}

export function catalogMatchRules(pack: Pick<LocalePack, "phrases">): CatalogMatchRules {
  return {
    stopwords: pack.phrases.matching.stopwords,
    stemEndings: pack.phrases.matching.stemEndings,
    qualifierSuffixes: pack.phrases.qualifierSuffixes,
    buyingFormSuffixes: pack.phrases.buyingFormSuffixes,
    regionalNames: pack.phrases.matching.regionalNames,
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
// A qualifier word keeps at least this many letters when folded ("rote" -> "rot").
const MIN_QUALIFIER_STEM = 3;
// Suggest also folds short words of at least this length ("eier" -> "ei", "eggs" -> "egg"),
// but not three-letter words, so "Eis" still does not meet "Ei".
const MIN_SHORT_FOLD_WORD = 4;
const MIN_SHORT_STEM = 2;

// Score weights of suggest. A content word that matches counts 1, a qualifier word 0.4.
// Words of the catalog name the query does not have cost a little, words of the query the
// catalog name does not have cost a lot (a match on one of two words is a guess), and an
// amount in the name ("Zwiebel (100 g)") costs more.
const QUALIFIER_WEIGHT = 0.4;
const UNMATCHED_CONTENT_PENALTY = 0.15;
const UNMATCHED_QUALIFIER_PENALTY = 0.05;
const UNMATCHED_QUERY_PENALTY = 0.45;
const DIGIT_PENALTY = 0.3;
const MIN_CONTENT_SCORE = 0.75;
const MIN_SCORE = 0.6;
// Ranking only, never the threshold: names official recipes use often come first.
const POPULARITY_WEIGHT = 0.04;
// A spelling variant shares a start and an end: "butternuss|kürbis" and "butternut|kürbis".
// A word that only shares the start is usually another product ("Butter", "Butterkeks").
const MIN_PREFIX = 4;
const MIN_SUFFIX = 3;
const MIN_VARIANT_SHARE = 0.6;

interface Token {
  word: string;
  // The relaxed-lookup form.
  stem: string;
  // The suggest form: like stem, with short plurals folded too.
  fold: string;
  qualifier: boolean;
}

interface Entry {
  name: string;
  id: number;
  uses: number;
  official: number;
  hasDigit: boolean;
  // The name ends in a usage note ("Salz zum Abschmecken").
  noted: boolean;
  numbers: string[];
  tokens: Token[];
  stems: Set<string>;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createCatalogMatcher(
  catalog: IngredientCatalog,
  rules: CatalogMatchRules,
): CatalogMatcher {
  const stopwords = new Set(rules.stopwords.map((word) => word.toLowerCase()));
  const endings = rules.stemEndings.map((ending) => ending.toLowerCase());
  const regional = new Map(
    Object.entries(rules.regionalNames ?? {}).map(([from, to]) => [
      from.toLowerCase(),
      to.toLowerCase(),
    ]),
  );
  const usage = new Set(
    rules.qualifierSuffixes.map((suffix) => normalizeIngredientName(suffix)).filter(Boolean),
  );
  const buying = new Map<string, readonly string[]>(
    Object.entries(rules.buyingFormSuffixes ?? {})
      .map(([suffix, marks]) => [normalizeIngredientName(suffix), marks] as const)
      .filter(([suffix]) => suffix !== ""),
  );
  const suffixes = [...usage, ...buying.keys()].sort((a, b) => b.length - a.length);
  const suffixPattern =
    suffixes.length > 0
      ? new RegExp(`(?:^|[\\s,;–-]+)(${suffixes.map(escapeRegex).join("|")})\\s*$`, "iu")
      : null;

  const foldEnding = (word: string, min: number): string => {
    for (const ending of endings) {
      if (word.endsWith(ending) && word.length - ending.length >= min) {
        return word.slice(0, -ending.length);
      }
    }
    return word;
  };
  // A short content word keeps its form and a marker, so it never equals the stem of a
  // longer word: "butt" stays "butt#" while "butter" becomes "butt".
  const stem = (word: string): string => {
    if (stopwords.has(word)) return foldEnding(word, MIN_QUALIFIER_STEM);
    if (word.length < MIN_STEM_WORD) return `${word}#`;
    return foldEnding(word, MIN_STEM);
  };
  const fold = (word: string): string =>
    !stopwords.has(word) && word.length >= MIN_SHORT_FOLD_WORD && word.length < MIN_STEM_WORD
      ? `${foldEnding(word, MIN_SHORT_STEM)}#`
      : stem(word);
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
      fold: fold(word),
      qualifier: qualifier || stopwords.has(word),
    }));
  // The name with its words folded: "Zwiebeln, rote" and "Zwiebeln, rot" both become
  // "zwiebel, rot". Short content words stay apart ("butt#").
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
  const numbers = (text: string): string[] => text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  // Removes trailing usage notes and buying forms, for suggest.
  const stripSuffixes = (name: string): string => {
    let current = name.trim();
    while (suffixPattern) {
      const match = suffixPattern.exec(current);
      const next = match ? current.slice(0, match.index).trim() : "";
      if (next === "") return current;
      current = next;
    }
    return current;
  };

  const entries: Entry[] = catalog.entries.map((entry) => {
    const entryTokens = tokens(entry.name);
    return {
      name: entry.name,
      id: entry.systemIngredientId,
      uses: entry.officialRecipes + entry.memberRecipes,
      official: entry.officialRecipes,
      hasDigit: /\d/.test(entry.name),
      numbers: numbers(entry.name),
      noted: stripSuffixes(entry.name) !== entry.name.trim(),
      tokens: entryTokens,
      stems: new Set(entryTokens.map((token) => token.stem)),
    };
  });
  // Name, loose key and word bag to entry. The first entry wins; the catalog lists common
  // names first.
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

  // True when a catalog entry has every content word of `base` and one of `marks`, so the
  // buying form names a product of its own ("Tomaten" and "Tomaten, stückig aus der Dose").
  const formHasEntry = (base: string, marks: readonly string[]): boolean => {
    const content = tokens(base)
      .filter((token) => !token.qualifier)
      .map((token) => token.stem);
    if (content.length === 0) return true;
    const markStems = marks.flatMap((mark) => words(mark)).map(stem);
    return entries.some(
      (entry) =>
        content.every((part) => entry.stems.has(part)) &&
        markStems.some((mark) => entry.stems.has(mark)),
    );
  };
  // True when the part of a parenthesis only qualifies `base`: every word a stopword, or a
  // usage note, or a buying form without an entry of its own. A part with a number never
  // qualifies ("Mehl (Type 1050)").
  const qualifiesOnly = (base: string, part: string): boolean => {
    if (/\d/.test(part)) return false;
    const key = normalizeIngredientName(part);
    if (usage.has(key)) return true;
    const marks = buying.get(key);
    if (marks) return !formHasEntry(base, marks);
    const partWords = words(part);
    return partWords.length > 0 && partWords.every((word) => stopwords.has(word));
  };

  // The forms of a name to look up, most specific first.
  const relaxedForms = (name: string): string[] => {
    const forms: string[] = [];
    const add = (form: string) => {
      const trimmed = form
        .replace(/\s+/g, " ")
        .replace(/[\s,;–-]+$/u, "")
        .trim();
      if (trimmed !== "" && !forms.includes(trimmed)) forms.push(trimmed);
    };
    let current = name.trim();
    add(current);
    while (suffixPattern) {
      const match = suffixPattern.exec(current);
      if (!match) break;
      const next = current.slice(0, match.index).trim();
      if (next === "") break;
      const marks = buying.get(normalizeIngredientName(match[1] ?? ""));
      if (marks && formHasEntry(next, marks)) break;
      current = next;
      add(current);
    }
    // "Zwiebeln (rot, gewürfelt)" -> "Zwiebeln, rot, gewürfelt", "Zwiebeln, rot",
    // "Zwiebeln, gewürfelt", and "Zwiebeln" only when every part is a qualifier.
    const paren = /^(.*?)\s*\(([^()]*)\)\s*$/u.exec(current);
    const base = paren?.[1]?.trim() ?? "";
    if (paren && base !== "") {
      const parts = (paren[2] ?? "")
        .split(/\s*[,;]\s*/u)
        .map((part) => part.trim())
        .filter(Boolean);
      for (let count = parts.length; count >= 1; count--) {
        add(`${base}, ${parts.slice(0, count).join(", ")}`);
      }
      for (const part of parts) add(`${base}, ${part}`);
      if (parts.length > 0 && parts.every((part) => qualifiesOnly(base, part))) {
        for (const form of relaxedForms(base)) add(form);
      }
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
    let unmatchedQuery = 0;
    const matched = new Set<Token>();
    for (const token of query) {
      let best = 0;
      let bestToken: Token | null = null;
      for (const candidate of entry.tokens) {
        const value =
          candidate.fold === token.fold
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
      else if (best > 0) content += best;
      else unmatchedQuery++;
    }
    if (content < MIN_CONTENT_SCORE) return 0;
    let total = content + qualifiers - unmatchedQuery * UNMATCHED_QUERY_PENALTY;
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
      const removedText = name.trim().slice(stripped.length).trim();
      const removed = tokens(removedText, true);
      const queries = [stripped];
      const regionalForm = stripped.replace(
        /\p{L}+/gu,
        (word) => regional.get(word.toLowerCase()) ?? word,
      );
      if (regionalForm !== stripped) queries.push(regionalForm);
      const tokenLists = queries
        .map((query) => [...tokens(query), ...removed])
        .filter((query) => query.some((token) => !token.qualifier));
      if (tokenLists.length === 0) return [];
      const queryHasDigit = /\d/.test(name);
      const queryNumbers = numbers(name);
      return entries
        .map((entry) => {
          const value = Math.max(...tokenLists.map((query) => score(query, queryHasDigit, entry)));
          return {
            entry,
            value,
            rank: value + POPULARITY_WEIGHT * Math.log10(entry.official + 1),
            // A name with an amount or a number the query does not have goes behind every
            // name without one ("½ Tl Salz", "Mehl (Type 405)" for "Mehl (Type 550)").
            amount: (
              queryHasDigit
                ? !queryNumbers.every((number) => entry.numbers.includes(number))
                : entry.hasDigit
            )
              ? 1
              : 0,
            // A name with a usage note goes behind the names without one.
            noted: !removedText && entry.noted ? 1 : 0,
          };
        })
        .filter((scored) => scored.value >= MIN_SCORE)
        .sort(
          (a, b) =>
            a.amount - b.amount ||
            a.noted - b.noted ||
            b.rank - a.rank ||
            b.entry.uses - a.entry.uses,
        )
        .slice(0, limit)
        .map((scored) => scored.entry.name);
    },
    relaxedLookup(name) {
      for (const form of relaxedForms(name)) {
        const entry =
          byName.get(normalizeIngredientName(form)) ??
          byLooseKey.get(looseKey(form)) ??
          byWords.get(wordsKey(form));
        if (entry) return { name: entry.name, systemIngredientId: entry.id };
      }
      return null;
    },
  };
}
