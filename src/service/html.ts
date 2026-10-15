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

// The design system of the admin pages, inline because the content security policy allows
// no other style source. Tokens first (spacing, type, colours for the light theme and a dark
// variant), then the components the views use: header and navigation, cards, badges,
// checklist, stat tiles, tables, callouts, forms, timeline, empty states. Text colours on
// their backgrounds keep a contrast of at least 4.5:1 in both themes.
export const STYLE = `
:root {
  color-scheme: light dark;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  --radius: 10px; --radius-s: 6px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --text-s: 13px; --text: 15px; --text-l: 17px; --text-xl: 22px;
  --fg: #1b1d21; --muted: #545a63; --bg: #f3f4f6; --surface: #ffffff; --surface-2: #f7f8fa;
  --line: #dcdfe4; --accent: #1a5bb8; --accent-fg: #ffffff;
  --ok: #156134; --ok-bg: #e3f3e8; --warn: #7f4500; --warn-bg: #fff1dc;
  --bad: #a1221a; --bad-bg: #fdeae8; --info: #1a5bb8; --info-bg: #e7effb; --neutral-bg: #eceef2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e7e9ec; --muted: #a8aeb7; --bg: #111316; --surface: #1a1d22; --surface-2: #21252b;
    --line: #353a42; --accent: #86b4ff; --accent-fg: #0b1a30;
    --ok: #74d394; --ok-bg: #15301f; --warn: #f5b862; --warn-bg: #34250f;
    --bad: #ff958c; --bad-bg: #3b1a17; --info: #8db9ff; --info-bg: #172a45; --neutral-bg: #2a2e35;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; font: var(--text)/1.5 var(--font); color: var(--fg); background: var(--bg); overflow-wrap: break-word; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
code { font-family: var(--mono); font-size: 0.9em; background: var(--neutral-bg); padding: 1px 5px; border-radius: 4px; }
code.url { display: inline-block; max-width: 100%; overflow-wrap: anywhere; word-break: break-all; }
pre { font-family: var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-s); background: var(--surface-2); padding: var(--s3); border-radius: var(--radius-s); border: 1px solid var(--line); margin: var(--s2) 0 0; max-height: 32em; overflow: auto; }
h1 { font-size: var(--text-xl); line-height: 1.25; margin: 0 0 var(--s2); }
h2 { font-size: var(--text-l); line-height: 1.3; margin: 0 0 var(--s2); }
h3 { font-size: var(--text); margin: var(--s4) 0 var(--s2); }
p { margin: 0 0 var(--s3); }
ul, ol { margin: 0 0 var(--s3); padding-left: var(--s5); }
.skip { position: absolute; left: -999px; top: 0; background: var(--surface); padding: var(--s2) var(--s3); z-index: 2; }
.skip:focus { left: var(--s2); }

header.top { background: var(--surface); border-bottom: 1px solid var(--line); }
header.top .bar { max-width: 1120px; margin: 0 auto; padding: var(--s2) var(--s4); display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s4); }
header.top .brand { font-weight: 700; font-size: var(--text-l); color: var(--fg); text-decoration: none; margin-right: var(--s2); }
header.top nav { display: flex; flex-wrap: wrap; gap: var(--s1); }
header.top nav a { color: var(--fg); text-decoration: none; padding: var(--s1) var(--s3); border-radius: 999px; }
header.top nav a:hover { background: var(--neutral-bg); }
header.top nav a[aria-current="page"] { background: var(--info-bg); color: var(--info); font-weight: 600; }
header.top .who { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); font-size: var(--text-s); }
header.top .who a.session { color: var(--fg); text-decoration: none; display: inline-flex; gap: var(--s1); align-items: center; }

main { max-width: 1120px; margin: 0 auto; padding: var(--s5) var(--s4) var(--s6); }
.page-head { margin: 0 0 var(--s5); }
.lead { color: var(--muted); max-width: 72ch; margin: 0 0 var(--s3); }
.page-head .lead { font-size: var(--text-l); margin: 0; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s4) var(--s5); margin: 0 0 var(--s4); min-width: 0; }
.card > :last-child { margin-bottom: 0; }
.grid { display: grid; gap: var(--s4); grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items: start; margin: 0 0 var(--s4); }
.grid > .card { margin: 0; }
.muted { color: var(--muted); }
.small { font-size: var(--text-s); }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .info { color: var(--info); }

.badge { display: inline-block; padding: 1px var(--s2); border-radius: 999px; font-size: var(--text-s); font-weight: 600; line-height: 1.5; white-space: nowrap; color: var(--muted); background: var(--neutral-bg); vertical-align: baseline; }
.badge.ok { color: var(--ok); background: var(--ok-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.bad { color: var(--bad); background: var(--bad-bg); }
.badge.info { color: var(--info); background: var(--info-bg); }
.badge.muted { color: var(--muted); background: var(--neutral-bg); }

.banner { padding: var(--s3) var(--s4); border-radius: var(--radius); margin: 0 0 var(--s4); border: 1px solid currentColor; }
.banner.ok { background: var(--ok-bg); } .banner.bad { background: var(--bad-bg); } .banner.warn { background: var(--warn-bg); }
.callout { border: 1px solid var(--line); border-left: 6px solid var(--warn); background: var(--warn-bg); border-radius: var(--radius); padding: var(--s4) var(--s5); margin: 0 0 var(--s4); }
.callout h2 { color: var(--warn); }
.callout h3 { margin-top: var(--s3); }
.callout li + li { margin-top: var(--s1); }
.callout > :last-child { margin-bottom: 0; }
.empty { border: 1px dashed var(--line); border-radius: var(--radius); padding: var(--s5) var(--s4); text-align: center; color: var(--muted); background: var(--surface-2); margin: 0 0 var(--s3); }
.empty strong { display: block; color: var(--fg); margin-bottom: var(--s1); }

ol.checklist { list-style: none; padding: 0; margin: 0; }
ol.checklist > li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: var(--s1) var(--s3); padding: var(--s3) 0; border-top: 1px solid var(--line); }
ol.checklist > li:first-child { border-top: 0; padding-top: 0; }
ol.checklist .mark { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; background: var(--neutral-bg); color: var(--muted); }
ol.checklist li.done .mark { background: var(--ok-bg); color: var(--ok); }
ol.checklist li.open .mark { background: var(--warn-bg); color: var(--warn); }
ol.checklist li.failed .mark { background: var(--bad-bg); color: var(--bad); }
ol.checklist .step-title { font-weight: 600; display: flex; flex-wrap: wrap; gap: var(--s2); align-items: baseline; }
ol.checklist p { margin: var(--s1) 0 0; }

.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: var(--s2); margin: var(--s2) 0 var(--s3); }
.stats a { display: block; text-decoration: none; color: var(--fg); border: 1px solid var(--line); border-radius: var(--radius-s); padding: var(--s2) var(--s3); background: var(--surface-2); }
.stats a:hover { border-color: var(--accent); }
.stats .count { display: block; font-size: var(--text-xl); font-weight: 700; font-variant-numeric: tabular-nums; }

.table-wrap { overflow-x: auto; margin: 0 0 var(--s3); -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-size: var(--text-s); }
th, td { text-align: left; padding: var(--s2) var(--s3); border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { color: var(--muted); font-weight: 600; white-space: nowrap; background: var(--surface-2); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.nowrap { white-space: nowrap; }
tbody tr:hover { background: var(--surface-2); }

dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s2) var(--s4); margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; min-width: 0; }
dd .badge { white-space: normal; max-width: 100%; }
dl.legend { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s2) var(--s3); margin: var(--s2) 0 0; font-size: var(--text-s); }
dl.legend dd { margin: 0; }

details { margin: var(--s2) 0 0; }
summary { cursor: pointer; color: var(--accent); font-weight: 600; }
details[open] > summary { margin-bottom: var(--s2); }

button, .button { font: inherit; font-size: var(--text-s); font-weight: 600; padding: 6px var(--s4); border-radius: var(--radius-s); border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; line-height: 1.5; }
button:hover, .button:hover { border-color: var(--accent); }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button.danger { color: var(--bad); border-color: currentColor; }
button[disabled] { opacity: 0.55; cursor: not-allowed; }
form.inline { display: inline; }
.buttons { display: flex; flex-wrap: wrap; gap: var(--s2); align-items: center; margin: var(--s3) 0 0; }
.field { display: block; margin: 0 0 var(--s4); }
.field > .label { display: block; font-weight: 600; margin-bottom: var(--s1); }
.help { display: block; color: var(--muted); font-size: var(--text-s); margin-top: var(--s1); max-width: 72ch; font-weight: 400; }
input[type=text], input[type=number], input[type=password], input[type=email], select, textarea { font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-s); padding: 6px var(--s2); max-width: 100%; }
.field input[type=text], .field input[type=password], .field input[type=email] { width: 100%; max-width: 420px; }
.field input[type=number] { width: 9em; }
textarea { width: 100%; font-family: var(--mono); font-size: var(--text-s); }
.check { display: flex; gap: var(--s2); align-items: flex-start; }
.check input { margin-top: 4px; }
.filters { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: flex-end; }
.filters .field { margin: 0; }

dl.actions { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s3) var(--s4); align-items: baseline; margin: 0; }
dl.actions dt { margin: 0; }
dl.actions dd { margin: 0; color: var(--muted); font-size: var(--text-s); }
.spaced { margin-top: var(--s4); }
.links { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: var(--s3) 0 0; }
.two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--s4); }
.two-col ul { padding-left: var(--s4); }
.two-col h3 { margin-top: 0; }

ol.timeline { list-style: none; margin: 0; padding: 0; }
ol.timeline li { display: grid; grid-template-columns: 11em 4.5em minmax(0, 1fr); gap: var(--s1) var(--s3); padding: var(--s2) 0; border-bottom: 1px solid var(--line); }
ol.timeline time { display: block; }
ol.timeline .abs { display: block; font-size: 12px; }
.login { max-width: 440px; margin: var(--s6) auto; }

@media (max-width: 640px) {
  main { padding: var(--s4) var(--s3) var(--s5); }
  .card, .callout { padding: var(--s3) var(--s4); }
  header.top .bar { padding: var(--s2) var(--s3); }
  header.top .who { margin-left: 0; width: 100%; }
  header.top nav a { padding: var(--s1) var(--s2); }
  .page-head .lead { font-size: var(--text); }
  dl.facts, dl.legend, dl.actions { grid-template-columns: minmax(0, 1fr); gap: var(--s1); }
  dl.facts dd, dl.actions dd { margin-bottom: var(--s2); }
  ol.timeline li { grid-template-columns: minmax(0, 1fr) auto; }
  ol.timeline li > span:last-child { grid-column: 1 / -1; }
  .field input[type=text], .field input[type=password], .field input[type=email], select { width: 100%; max-width: none; }
  .grid { grid-template-columns: minmax(0, 1fr); }
}

@media print {
  :root { color-scheme: light; --fg: #000; --muted: #444; --bg: #fff; --surface: #fff; --surface-2: #fff; --line: #bbb; }
  body { background: #fff; font-size: 12pt; }
  header.top, .skip, .no-print, form, button, .button, .banner { display: none !important; }
  main { max-width: none; padding: 0; }
  .card, .callout { break-inside: avoid; padding: 8pt 10pt; }
  .table-wrap { overflow: visible; }
  a { color: #000; text-decoration: none; }
  pre { max-height: none; }
}
`;

export type NavKey = "dashboard" | "jobs" | "dryRun" | "settings";

export interface PageLabels {
  htmlLang: string;
  nav: Readonly<Record<NavKey, string>> & { logout: string; label: string };
  header: { mcSession: string; signedIn(user: string): string; noPassword: string };
  authBanner: string;
  skipToContent: string;
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
  // The navigation entry of the page, marked as the current one.
  active?: NavKey | null;
  // Reloads the page after the given seconds, for pages that follow a running job.
  refresh?: { seconds: number; url: string } | null;
}

const NAV: ReadonlyArray<readonly [NavKey, string]> = [
  ["dashboard", "/admin"],
  ["jobs", "/admin/jobs"],
  ["dryRun", "/admin/dry-run"],
  ["settings", "/admin/settings"],
];

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
        <a class="skip" href="#main">${t.skipToContent}</a>
        <header class="top">
          <div class="bar">
            <a class="brand" href="/admin">mc-bridge</a>
            ${
              header
                ? html`<nav aria-label="${t.nav.label}">
                      ${NAV.map(
                        ([key, href]) =>
                          html`<a
                            href="${href}"
                            ${key === options.active ? html`aria-current="page"` : ""}
                            >${t.nav[key]}</a
                          >`,
                      )}
                    </nav>
                    <div class="who">
                      <a class="session" href="/admin/settings#session"
                        >${t.header.mcSession}
                        <span class="badge ${header.session.className}"
                          >${header.session.label}</span
                        ></a
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
          </div>
        </header>
        <main id="main">
          ${options.authDisabled ? html`<p class="banner bad">${t.authBanner}</p>` : ""}
          ${options.notice ? html`<p class="banner ok" role="status">${options.notice}</p>` : ""}
          ${options.error ? html`<p class="banner bad" role="alert">${options.error}</p>` : ""}
          ${options.body}
        </main>
      </body>
    </html>`;
  return document.html;
}
