// The frame of every admin page: document head with the self-hosted assets, the sidebar
// with logo, navigation, session state, theme switch, user and version (a drawer below
// 1024 px that opens without the script), notices and the confirmation dialog.

import type { AdminMessages } from "../../i18n/index.js";
import { html, SafeHtml } from "../html.js";
import type { AssetCatalog } from "./assets.js";
import {
  callout,
  confirmDialog,
  csrfField,
  icon,
  iconButton,
  statusDot,
  toasts,
  type Notice,
  type Tone,
} from "./components.js";
import type { IconName } from "./icons.generated.js";
import { logoMarkup } from "./logo.js";

export type NavKey = "dashboard" | "jobs" | "dryRun" | "settings";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "mcb_theme";

export function parseTheme(value: unknown): Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
    ? (value as Theme)
    : "system";
}

export const APP_NAME = "MC Bridge";
export const REPOSITORY_URL = "https://github.com/hudra0/mealie-mc-bridge";

const NAV: ReadonlyArray<readonly [NavKey, string, IconName]> = [
  ["dashboard", "/admin", "layout-dashboard"],
  ["jobs", "/admin/jobs", "list-checks"],
  ["dryRun", "/admin/dry-run", "flask-conical"],
  ["settings", "/admin/settings", "settings"],
];

const THEME_ICON: Readonly<Record<Theme, IconName>> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

export interface ShellNav {
  active: NavKey | null;
  // The signed-in admin; null while the pages have no password.
  user: string | null;
  formToken: string;
  // The Monsieur Cuisine session in the sidebar.
  session: { tone: Tone; label: string };
  version: string;
  // The path of the page, for the theme form to come back to.
  path: string;
}

export interface PageOptions {
  title: string;
  t: AdminMessages;
  body: SafeHtml;
  theme: Theme;
  assets: AssetCatalog;
  notices?: readonly Notice[];
  // An error of the action that led here, above the page.
  error?: string | null;
  // Shown on every page while the admin pages have no password.
  authDisabled?: boolean;
  // Sidebar and navigation; null for the login page.
  nav?: ShellNav | null;
  // Reloads the page while a job runs: the script after the given seconds, a meta refresh
  // without it.
  refresh?: { seconds: number; url: string } | null;
}

function head(options: PageOptions): SafeHtml {
  const { assets } = options;
  return html`<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="same-origin" />
    <meta name="color-scheme" content="light dark" />
    <title>${options.title} · ${APP_NAME}</title>
    <link rel="stylesheet" href="${assets.url("app.css")}" />
    <link
      rel="preload"
      href="${assets.url("inter-latin.woff2")}"
      as="font"
      type="font/woff2"
      crossorigin
    />
    <link rel="icon" href="${assets.url("favicon.svg")}" type="image/svg+xml" />
    <link rel="icon" href="${assets.url("favicon-32.png")}" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="${assets.url("apple-touch-icon.png")}" />
    <script src="${assets.url("app.js")}" defer></script>
    ${
      options.refresh
        ? html`<noscript
            ><meta
              http-equiv="refresh"
              content="${options.refresh.seconds}; url=${options.refresh.url}"
          /></noscript>`
        : ""
    }
  </head>`;
}

function brand(subtitle: string): SafeHtml {
  return html`<a href="/admin" class="flex min-w-0 items-center gap-2.5">
    ${new SafeHtml(logoMarkup("size-8 shrink-0"))}
    <span class="min-w-0 leading-tight">
      <span class="block truncate text-sm font-semibold">${APP_NAME}</span>
      <span class="block truncate text-[11px] text-fg-muted">${subtitle}</span>
    </span>
  </a>`;
}

function themeForm(theme: Theme, nav: ShellNav, t: AdminMessages): SafeHtml {
  return html`<form
    method="post"
    action="/admin/theme"
    data-theme-form
    class="flex items-center justify-between gap-2"
  >
    ${csrfField(nav.formToken)}
    <input type="hidden" name="next" value="${nav.path}" />
    <span class="text-xs text-fg-muted">${t.shell.theme}</span>
    <div class="inline-flex gap-0.5 rounded-lg border border-line bg-subtle p-0.5">
      ${THEMES.map((option) =>
        iconButton({
          icon: THEME_ICON[option],
          label: t.shell.themes[option],
          type: "submit",
          name: "theme",
          value: option,
          pressed: option === theme,
          className: "size-7 aria-pressed:bg-surface aria-pressed:shadow-xs",
        }),
      )}
    </div>
  </form>`;
}

function sidebar(options: PageOptions, nav: ShellNav): SafeHtml {
  const t = options.t;
  // A drawer below 1024 px; beside the page above, as tall as the page, its content sticky.
  return html`<aside
    id="sidebar"
    class="invisible fixed inset-y-0 left-0 z-50 w-60 -translate-x-full border-r border-line bg-surface transition-[transform,visibility] duration-200 peer-checked/nav:visible peer-checked/nav:translate-x-0 lg:visible lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 lg:transition-none"
  >
    <div class="flex h-full flex-col lg:sticky lg:top-0 lg:h-dvh">
      <div class="flex h-16 items-center justify-between gap-2 px-4">
        ${brand(t.shell.tagline)}
        <label
          for="nav-open"
          class="grid size-8 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-subtle lg:hidden"
          title="${t.shell.closeMenu}"
          >${icon("x")}<span class="sr-only">${t.shell.closeMenu}</span></label
        >
      </div>
      <nav class="flex-1 space-y-0.5 overflow-y-auto px-3 py-2" aria-label="${t.nav.label}">
        ${NAV.map(([key, href, name]) => {
          const active = key === nav.active;
          return html`<a
            href="${href}"
            class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-accent-soft text-accent-fg"
                : "text-fg-muted hover:bg-subtle hover:text-fg"
            }"
            ${active ? html`aria-current="page"` : ""}
            >${icon(name, `size-4 ${active ? "" : "text-fg-subtle"}`)}${t.nav[key]}</a
          >`;
        })}
      </nav>
      <div class="space-y-3 border-t border-line p-3">
        <a
          href="/admin/settings"
          class="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-subtle"
        >
          <span class="text-fg-muted">${t.shell.mcSession}</span>
          <span class="min-w-0 font-medium">${statusDot(nav.session.tone, nav.session.label)}</span>
        </a>
        <div class="px-2">${themeForm(options.theme, nav, t)}</div>
        <div class="flex items-center justify-between gap-2 px-2">
          ${
            nav.user === null
              ? html`<span class="text-xs font-medium text-danger-fg">${t.shell.noPassword}</span>`
              : html`<span class="flex min-w-0 items-center gap-2 text-xs">
                    <span
                      class="grid size-6 shrink-0 place-items-center rounded-full bg-subtle text-fg-muted"
                      >${icon("user-round", "size-3.5")}</span
                    ><span class="truncate" title="${t.shell.signedIn(nav.user)}">${nav.user}</span>
                  </span>
                  <form method="post" action="/admin/logout">
                    ${csrfField(nav.formToken)}
                    ${iconButton({ icon: "log-out", label: t.nav.logout, type: "submit" })}
                  </form>`
          }
        </div>
        <div class="flex items-center justify-between px-2 text-[11px] text-fg-muted">
          <span class="tabular-nums">v${nav.version}</span>
          <a
            href="${REPOSITORY_URL}"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 hover:text-fg"
            >${icon("git-branch", "size-3.5")}GitHub</a
          >
        </div>
      </div>
    </div>
  </aside>`;
}

function shell(options: PageOptions, nav: ShellNav, main: SafeHtml): SafeHtml {
  const t = options.t;
  return html`<div class="lg:flex lg:min-h-dvh">
    <input
      type="checkbox"
      id="nav-open"
      class="peer/nav sr-only"
      aria-label="${t.shell.openMenu}"
    />
    <div
      class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 lg:hidden"
    >
      <label
        for="nav-open"
        class="grid size-9 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-subtle"
        title="${t.shell.openMenu}"
        >${icon("menu", "size-5")}<span class="sr-only">${t.shell.openMenu}</span></label
      >
      ${brand(t.shell.tagline)}
    </div>
    <label
      for="nav-open"
      class="fixed inset-0 z-40 hidden bg-backdrop peer-checked/nav:block lg:hidden"
      aria-hidden="true"
    ></label>
    ${sidebar(options, nav)}
    <div class="min-w-0 flex-1">${main}</div>
  </div>`;
}

export function renderPage(options: PageOptions): string {
  const t = options.t;
  const nav = options.nav ?? null;
  const banners = html`${
    options.authDisabled
      ? html`<div class="mb-4">${callout({ tone: "danger", title: t.authBanner })}</div>`
      : ""
  }${
    options.error
      ? html`<div class="mb-4">
          ${callout({ tone: "danger", body: options.error, alert: true })}
        </div>`
      : ""
  }`;
  const main = html`<main
    id="main"
    class="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
  >
    ${banners}${options.body}
  </main>`;
  const document = html`<!doctype html>
    <html lang="${t.htmlLang}" data-theme="${options.theme}">
      ${head(options)}
      <body
        class="min-h-dvh"
        ${
          options.refresh
            ? html`data-refresh="${options.refresh.seconds}"
              data-refresh-url="${options.refresh.url}"`
            : ""
        }
      >
        <a class="skip-link" href="#main">${t.skipToContent}</a>
        ${nav ? shell(options, nav, main) : main} ${toasts(options.notices ?? [], t.shell.dismiss)}
        ${confirmDialog({ cancel: t.shell.cancel, confirm: t.shell.confirm })}
      </body>
    </html>`;
  return document.html;
}
