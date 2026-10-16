// A tiny HTML templating layer for the admin pages: every interpolated value is escaped
// unless it is already SafeHtml, so a recipe title such as "<script>" renders as text.
// The page frame lives in ui/shell.ts, the building blocks in ui/components.ts.

export class SafeHtml {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

export type HtmlValue =
  SafeHtml | string | number | boolean | null | undefined | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.html;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  return new SafeHtml(out);
}

// Only http and https links; anything else becomes "#".
export function safeHref(url: string | null | undefined): string {
  if (!url) return "#";
  try {
    const parsed = new URL(url, "http://relative.invalid");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "#";
  } catch {
    return "#";
  }
  return url;
}
