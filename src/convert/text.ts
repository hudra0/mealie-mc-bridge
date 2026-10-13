// The text heuristics of the plausibility checks, built from locale packs: how words are
// cut and compared, which words add something to the bowl, empty it, cool it, keep a
// portion aside or put it outside the bowl, how units are written in step texts, and which
// ingredient words mean liquid, flour or foaming contents.
//
// Step texts and the ingredient list are in the output language, so their rules come from
// the active pack. Words read on the source recipe (liquids for cup amounts, "plus more",
// density words) may be in any language, so those lists join the words of every pack.

import { phraseRegex } from "../locale/matcher.js";
import type { LocalePack, UnitConcept, UnitVocabularyEntry } from "../locale/pack.js";

export interface WhiskRules {
  accessory: RegExp;
  fit: RegExp;
  remove: RegExp;
}

export interface TextRules {
  locale: string;
  // Lower-case words of a text, regional names replaced by the Monsieur Cuisine name.
  words: (text: string) => string[];
  // A word without the endings that tell singular and plural apart.
  stem: (word: string) => string;
  // The stems that identify an ingredient name, without stopwords.
  nameKeys: (name: string) => string[];
  // 2 when a word of the text equals a key, 1 when they match as parts of a compound, 0 else.
  matchScore: (keys: readonly string[], textStems: readonly string[]) => 0 | 1 | 2;
  adding: RegExp;
  emptying: RegExp;
  cooling: RegExp;
  reserved: RegExp;
  // A clause that puts back a portion weighed or prepared earlier.
  reused: RegExp;
  outsideBowl: RegExp;
  hot: RegExp;
  whisk: WhiskRules;
  // Matches at the start of the words after a number that make it a size, time or setting.
  measureWord: RegExp;
  // The unit words of step texts, longest first, lower case.
  unitWords: readonly string[];
  // The unit code a spelling in the output language stands for, or null.
  unitCode: (spelling: string) => string | null;
  // How the output language writes a unit concept.
  unitLabel: (concept: UnitConcept) => string;
  // Stems of ingredient words in the output language.
  foamingWords: readonly string[];
  liquidWords: readonly string[];
  flourWords: readonly string[];
  waterWords: readonly string[];
  // Words of every pack: density key to words, liquids for cups, "plus more" markers.
  densityWords: Readonly<Record<string, readonly string[]>>;
  cupLiquidWords: readonly string[];
  moreAllowed: RegExp;
}

const unique = <T>(items: Iterable<T>) => [...new Set(items)];

function spellingsOf(entry: UnitVocabularyEntry): string[] {
  return unique([entry.singular, entry.plural, ...entry.aliases].map((form) => form.toLowerCase()));
}

// Builds the rules for the active pack, with the source-side lists of every pack in
// `inputPacks` (the active one is always included).
export function createTextRules(
  pack: LocalePack,
  inputPacks: readonly LocalePack[] = [],
): TextRules {
  const p = pack.phrases;
  const all = unique([pack, ...inputPacks]);
  const stopwords = new Set(p.matching.stopwords.map((word) => word.toLowerCase()));
  const endings = p.matching.stemEndings.map((ending) => ending.toLowerCase());
  const tails = new Set(p.matching.compoundTails.map((tail) => tail.toLowerCase()));
  const regional = new Map(
    Object.entries(p.matching.regionalNames).map(([from, to]) => [
      from.toLowerCase(),
      to.toLowerCase(),
    ]),
  );

  const stem = (word: string): string => {
    const lower = word.toLowerCase();
    for (const ending of endings) {
      if (lower.endsWith(ending) && lower.length - ending.length >= 2) {
        return lower.slice(0, -ending.length);
      }
    }
    return lower;
  };
  const words = (text: string): string[] =>
    (text.toLowerCase().match(/\p{L}+/gu) ?? []).map((word) => regional.get(word) ?? word);
  const nameKeys = (name: string): string[] =>
    unique(
      words(name)
        .filter((word) => !stopwords.has(word))
        .map(stem),
    ).filter((key) => key.length >= 2);
  const matchScore = (keys: readonly string[], textStems: readonly string[]): 0 | 1 | 2 => {
    let best: 0 | 1 | 2 = 0;
    for (const key of keys) {
      for (const word of textStems) {
        if (word === key) return 2;
        const [short, long] = word.length < key.length ? [word, key] : [key, word];
        const compound =
          (short.length >= 4 && (long.startsWith(short) || long.endsWith(short))) ||
          (tails.has(short) && long.endsWith(short));
        if (compound) best = 1;
      }
    }
    return best;
  };

  const reservedEntries = p.reservedPhrases;
  const spellings = new Map<string, string>();
  for (const entry of pack.units.vocabulary) {
    for (const form of spellingsOf(entry))
      if (!spellings.has(form)) spellings.set(form, entry.code);
  }
  const unitWords = [...spellings.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const labels = new Map(pack.units.vocabulary.map((entry) => [entry.concept, entry.singular]));

  const densityWords: Record<string, string[]> = {};
  for (const source of all) {
    for (const [key, list] of Object.entries(source.units.densityWords)) {
      densityWords[key] = unique([
        ...(densityWords[key] ?? []),
        ...list.map((w) => w.toLowerCase()),
      ]);
    }
  }
  const moreWords = unique(all.flatMap((source) => source.phrases.moreAllowedWords));

  return {
    locale: pack.locale,
    words,
    stem,
    nameKeys,
    matchScore,
    adding: phraseRegex(p.additionVerbs),
    emptying: phraseRegex(p.emptyingPhrases),
    cooling: phraseRegex(p.coolingPhrases),
    reserved: phraseRegex(reservedEntries),
    reused: phraseRegex([...reservedEntries, ...p.reusedPhrases]),
    outsideBowl: phraseRegex(p.outsideBowlPhrases),
    hot: phraseRegex(p.hotPhrases),
    whisk: {
      accessory: phraseRegex(p.whiskPhrases.accessory),
      fit: phraseRegex(p.whiskPhrases.fit),
      remove: phraseRegex(p.whiskPhrases.remove),
    },
    measureWord: phraseRegex(p.measureWords, { anchored: true }),
    unitWords,
    unitCode: (spelling) => {
      const key = spelling.trim().toLowerCase();
      return spellings.get(key) ?? spellings.get(key.replace(/\.$/, "")) ?? null;
    },
    unitLabel: (concept) => labels.get(concept) ?? concept,
    foamingWords: p.ingredientWords.foaming.map(stem),
    liquidWords: p.ingredientWords.liquid.map(stem),
    flourWords: p.ingredientWords.flour.map(stem),
    waterWords: p.ingredientWords.water.map(stem),
    densityWords,
    cupLiquidWords: unique(
      all.flatMap((source) => source.units.liquidWords.map((w) => w.toLowerCase())),
    ),
    // "plus bis zu ½ Tasse mehr zum Verdünnen", "+ a little more for thinning".
    moreAllowed: new RegExp(`(?:^|\\s)(?:plus|\\+)\\s.*${phraseRegex(moreWords).source}`, "iu"),
  };
}
