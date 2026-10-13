// Helpers the message catalogs share: Markdown escaping for values inserted into timeline
// entries, shortening, and dates in a catalog's style.

// Backslash-escapes the characters that start Markdown links, emphasis, code, headings or
// HTML, and folds the text onto one line.
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>#|!]/g, (char) => `\\${char}`);
}

// One line of at most max characters, "..." when cut.
export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

// A date and time in the style of an Intl locale.
export function formatDate(iso: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}
