// Turns the word lists of a locale pack into regular expressions. An entry matches anywhere
// inside a word, case-insensitively; a leading ^ ties it to the start of a word and a
// trailing $ to its end, so "^geben$" is the whole word "geben", "^heiß" also finds
// "heißes" and "schüssel" also finds "Rührschüssel".

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The regular expression source of one entry.
export function phraseSource(entry: string): string {
  let body = entry;
  let start = "";
  let end = "";
  if (body.startsWith("^")) {
    start = "(?<!\\p{L})";
    body = body.slice(1);
  }
  if (body.endsWith("$") && body.length > 1) {
    end = "(?!\\p{L})";
    body = body.slice(0, -1);
  }
  return `${start}${escapeRegex(body.toLowerCase())}${end}`;
}

// A pattern that matches nothing, for an empty list.
const NEVER = "(?!)";

// One expression for a whole list. `anchored` ties every entry to the start of the text.
export function phraseRegex(entries: readonly string[], options: { anchored?: boolean } = {}) {
  const body = entries.length > 0 ? entries.map(phraseSource).join("|") : NEVER;
  return new RegExp(options.anchored ? `^(?:${body})` : `(?:${body})`, "iu");
}

// Whether a word list entry is well formed: something left between the markers.
export function validPhraseEntry(entry: string): boolean {
  const body = entry.replace(/^\^/, "").replace(/\$$/, "");
  return body.trim() !== "";
}
