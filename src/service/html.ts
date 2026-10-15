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
  header { display: flex; gap: 8px 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; background: var(--card); }
  header .brand { font-size: 16px; font-weight: 700; margin-right: 8px; }
  header nav { display: flex; gap: 12px; flex-wrap: wrap; }
  header nav a { color: var(--fg); text-decoration: none; padding: 2px 0; border-bottom: 2px solid transparent; }
  header nav a:hover { border-bottom-color: var(--line); }
  header .who { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 0 0 16px; }
  h1 { font-size: 20px; margin: 4px 0 16px; } h2 { font-size: 16px; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; } td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
  .badge { display: inline-block; padding: 0 8px; border-radius: 10px; font-size: 13px; border: 1px solid currentColor; white-space: nowrap; background: color-mix(in srgb, currentColor 12%, transparent); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .info { color: var(--info); } .muted { color: var(--muted); }
  .banner { padding: 8px 16px; border-radius: 8px; margin: 0 0 16px; border: 1px solid currentColor; background: color-mix(in srgb, currentColor 8%, transparent); }
  form.inline { display: inline; } button { font: inherit; padding: 4px 12px; cursor: pointer; }
  textarea, input[type=text], input[type=number], input[type=password], input[type=email], select { font: inherit; padding: 4px 6px; max-width: 100%; }
  textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 13px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 13px; background: var(--bg); padding: 8px; border-radius: 6px; border: 1px solid var(--line); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; } dt { color: var(--muted); }
  form.fields label { display: block; margin: 0 0 10px; } form.fields label input { display: block; width: 100%; max-width: 360px; margin-top: 2px; }
  ol.timeline { list-style: none; margin: 0; padding: 0; } ol.timeline li { display: grid; grid-template-columns: 9em 4em 1fr; gap: 4px 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  ol.timeline time { display: block; } ol.timeline .abs { display: block; font-size: 12px; }
  .login { max-width: 420px; margin: 40px auto; }
  @media (max-width: 640px) {
    main { padding: 8px; } section { padding: 10px; }
    dl { grid-template-columns: 1fr; } dd { margin: 0 0 8px; }
    header .who { margin-left: 0; width: 100%; }
    ol.timeline li { grid-template-columns: 1fr; }
    input[type=text], input[type=number], input[type=password], input[type=email], select { width: 100%; }
  }
`;

export interface PageLabels {
  htmlLang: string;
  nav: { dashboard: string; jobs: string; dryRun: string; settings: string; logout: string };
  header: { mcSession: string; signedIn(user: string): string; noPassword: string };
  authBanner: string;
}

// The header's state: the Monsieur Cuisine session and who is signed in.
export interface PageHeader {
  // The text and colour class of the Monsieur Cuisine session badge.
  session: { label: string; className: string };
  // The signed-in admin; null while the pages have no password.
  user: string | null;
  formToken: string;
}

export interface PageOptions {
  title: string;
  // The texts of the layout in the admin's language (src/i18n).
  labels: PageLabels;
  body: SafeHtml;
  notice?: string | null;
  error?: string | null;
  // Shown on every page while the admin pages have no password.
  authDisabled?: boolean;
  // Navigation, session badge and logout button; the login page has none.
  header?: PageHeader | null;
  // Reloads the page after the given seconds, for pages that follow a running job.
  refresh?: { seconds: number; url: string } | null;
}

export function page(options: PageOptions): string {
  const t = options.labels;
  const header = options.header ?? null;
  const document = html`<!doctype html>
    <html lang="${t.htmlLang}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        ${
          options.refresh
            ? html`<meta
                http-equiv="refresh"
                content="${options.refresh.seconds}; url=${options.refresh.url}"
              />`
            : ""
        }
        <title>${options.title} · mc-bridge</title>
        <style>
          ${new SafeHtml(STYLE)}
        </style>
      </head>
      <body>
        <header>
          <a class="brand" href="/admin">mc-bridge</a>
          ${
            header
              ? html`<nav>
                    <a href="/admin">${t.nav.dashboard}</a>
                    <a href="/admin/jobs">${t.nav.jobs}</a>
                    <a href="/admin/dry-run">${t.nav.dryRun}</a>
                    <a href="/admin/settings">${t.nav.settings}</a>
                  </nav>
                  <div class="who">
                    <span
                      >${t.header.mcSession}
                      <span class="badge ${header.session.className}"
                        >${header.session.label}</span
                      ></span
                    >
                    ${
                      header.user === null
                        ? html`<span class="badge bad">${t.header.noPassword}</span>`
                        : html`<span class="muted">${t.header.signedIn(header.user)}</span>
                            <form class="inline" method="post" action="/admin/logout">
                              <input type="hidden" name="_csrf" value="${header.formToken}" />
                              <button type="submit">${t.nav.logout}</button>
                            </form>`
                    }
                  </div>`
              : ""
          }
        </header>
        <main>
          ${options.authDisabled ? html`<p class="banner bad">${t.authBanner}</p>` : ""}
          ${options.notice ? html`<p class="banner ok">${options.notice}</p>` : ""}
          ${options.error ? html`<p class="banner bad">${options.error}</p>` : ""} ${options.body}
        </main>
      </body>
    </html>`;
  return document.html;
}
