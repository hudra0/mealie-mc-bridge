// Placeholders in the language-neutral knowledge files, filled from a locale pack:
//
//   {{language}}          the language with its locale: German (de-DE)
//   {{languageName}}      the language alone: German
//   {{phrase:<id>}}       a standard phrase (phrases.json standardPhrases) or a title rule
//                         (phrases.json stepTitleRules) by id
//   {{phrases:<id>}}      a list of title rules, quoted and joined: "Zerkleinern", "Andünsten"
//   {{unit:<concept>}}    how the language writes a unit concept: Tl, tsp
//   {{unitPlural:<concept>}}  the plural of it: Prisen, pinches
//
// A placeholder the pack cannot fill is an error, so a pack that lacks a phrase the neutral
// files use fails when it is loaded, not in the middle of a prompt.

import { LocalePackError, UNIT_CONCEPTS, type LocalePack, type UnitConcept } from "./pack.js";

const PLACEHOLDER = /\{\{([A-Za-z]+)(?::([A-Za-z0-9_]+))?\}\}/g;

// The placeholders a text uses, as written between the braces ("phrase:pushDown").
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) =>
    match[2] === undefined ? (match[1] ?? "") : `${match[1]}:${match[2]}`,
  );
}

const isConcept = (value: string): value is UnitConcept =>
  (UNIT_CONCEPTS as readonly string[]).includes(value);

// The text for one placeholder, or null when the pack has none.
export function placeholderValue(pack: LocalePack, kind: string, id?: string): string | null {
  const titles = pack.phrases.stepTitleRules as Record<string, unknown>;
  switch (kind) {
    case "language":
      return id === undefined ? `${pack.mc.language} (${pack.mc.locale})` : null;
    case "languageName":
      return id === undefined ? pack.mc.language : null;
    case "phrase": {
      if (id === undefined) return null;
      const phrase = pack.phrases.standardPhrases[id];
      if (phrase !== undefined) return phrase;
      const title = titles[id];
      return typeof title === "string" ? title : null;
    }
    case "phrases": {
      const list = id === undefined ? undefined : titles[id];
      if (!Array.isArray(list) || list.length === 0) return null;
      return list.map((item) => `"${String(item)}"`).join(", ");
    }
    case "unit":
    case "unitPlural": {
      if (id === undefined || !isConcept(id)) return null;
      const entry = pack.units.vocabulary.find((item) => item.concept === id);
      if (!entry) return null;
      return kind === "unit" ? entry.singular : entry.plural;
    }
    default:
      return null;
  }
}

// The placeholders of a text the pack cannot fill.
export function missingPlaceholders(text: string, pack: LocalePack): string[] {
  const missing = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (placeholderValue(pack, match[1] ?? "", match[2]) === null) missing.add(match[0]);
  }
  return [...missing];
}

// Replaces every placeholder with the pack's wording. Throws LocalePackError naming the
// placeholders the pack cannot fill; `where` names the text in that message.
export function fillPlaceholders(
  text: string,
  pack: LocalePack,
  where = "a knowledge file",
): string {
  const missing = missingPlaceholders(text, pack);
  if (missing.length > 0) {
    throw new LocalePackError(
      `${where} uses ${missing.join(", ")}, which the ${pack.locale} pack does not define`,
    );
  }
  // A value that ends a sentence itself ("Msp.") takes the full stop that follows it.
  const withStop = new RegExp(`${PLACEHOLDER.source}(\\.?)`, "g");
  return text.replace(withStop, (_match, kind: string, id: string | undefined, stop: string) => {
    const value = placeholderValue(pack, kind, id) ?? "";
    return stop && value.endsWith(".") ? value : `${value}${stop}`;
  });
}
