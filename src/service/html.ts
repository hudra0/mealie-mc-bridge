// A tiny HTML templating layer for the admin pages: every interpolated value is escaped
// unless it is already SafeHtml, so a recipe title such as "<script>" renders as text.

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

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[];

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

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --card: #fff; --muted: #6b6b70;
    --line: #e2e2e6; --ok: #1f7a3a; --warn: #a15c00; --bad: #b3261e; --info: #1f5fa8; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf0; --bg: #161618; --card: #1f1f22;
    --muted: #a0a0a8; --line: #33333a; --ok: #5cc27a; --warn: #f0a640; --bad: #f2867f; --info: #7fb2f0; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  header { display: flex; gap: 16px; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  header strong { font-size: 16px; }
  header a { color: var(--fg); }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 0 0 16px; }
  h1 { font-size: 20px; margin: 4px 0 16px; } h2 { font-size: 16px; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; } td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
  .badge { display: inline-block; padding: 0 8px; border-radius: 10px; font-size: 13px; border: 1px solid currentColor; white-space: nowrap; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .info { color: var(--info); } .muted { color: var(--muted); }
  .banner { padding: 8px 16px; border-radius: 8px; margin: 0 0 16px; border: 1px solid currentColor; }
  form.inline { display: inline; } button { font: inherit; padding: 4px 12px; cursor: pointer; }
  textarea, input[type=text], input[type=number], select { font: inherit; padding: 4px 6px; max-width: 100%; }
  textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 13px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 13px; background: var(--bg); padding: 8px; border-radius: 6px; border: 1px solid var(--line); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; } dt { color: var(--muted); }
`;

export interface PageOptions {
  title: string;
  body: SafeHtml;
  notice?: string | null;
  error?: string | null;
  // Shown on every page while the admin pages have no password.
  authDisabled?: boolean;
}

export function page(options: PageOptions): string {
  const document = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>${options.title} · mc-bridge</title>
        <style>
          ${new SafeHtml(STYLE)}
        </style>
      </head>
      <body>
        <header>
          <strong>mc-bridge</strong>
          <a href="/admin">Dashboard</a>
          <a href="/admin/jobs">Jobs</a>
          <a href="/admin/dry-run">Dry run</a>
        </header>
        <main>
          ${
            options.authDisabled
              ? html`<p class="banner bad">
                  The admin pages have no password. Set ADMIN_USER and ADMIN_PASSWORD.
                </p>`
              : ""
          }
          ${options.notice ? html`<p class="banner ok">${options.notice}</p>` : ""}
          ${options.error ? html`<p class="banner bad">${options.error}</p>` : ""} ${options.body}
        </main>
      </body>
    </html>`;
  return document.html;
}
