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

// A number with at most one decimal in the style of an Intl locale: "13,5", "13.5".
export function formatNumber(value: number, intlLocale: string): string {
  return new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 }).format(value);
}

// US dollars with up to four decimals in the style of an Intl locale: "$0.1162", "0,1162 $".
export function formatUsd(value: number, intlLocale: string): string {
  return new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

// A date and time in the style of an Intl locale.
export function formatDate(iso: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}
