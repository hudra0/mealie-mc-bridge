// The corpus of a locale. de-DE is the reference corpus in local/corpus: the language-neutral
// knowledge files (device limits, techniques, timing model) come from it. Every other locale
// crawls into local/corpus/<locale> and feeds only its own locale pack.
//
// Every corpus script takes --locale <locale>; CORPUS_DIR, when set, overrides the directory.

import path from "node:path";

export const REFERENCE_LOCALE = "de-DE";
const LOCALE = /^[a-z]{2,3}-[A-Z]{2}$/;

export function corpusDirFor(locale: string): string {
  return locale === REFERENCE_LOCALE
    ? path.join("local", "corpus")
    : path.join("local", "corpus", locale);
}

export interface CorpusArgs {
  locale: string;
  corpusDir: string;
  // The arguments that were not --locale.
  rest: string[];
}

// Reads --locale from the arguments. Throws on a malformed locale or a missing value.
export function parseCorpusArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  fallbackLocale: string = REFERENCE_LOCALE,
): CorpusArgs {
  let locale = fallbackLocale;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--locale") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--locale needs a value");
      locale = value;
    } else {
      rest.push(arg);
    }
  }
  if (!LOCALE.test(locale)) throw new Error(`--locale must look like de-DE, not ${locale}`);
  return { locale, corpusDir: env.CORPUS_DIR || corpusDirFor(locale), rest };
}
