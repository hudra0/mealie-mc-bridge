// The building blocks of the admin pages: small functions from options to SafeHtml, styled
// with the Tailwind utilities of app.css. Every value passes through html``, which escapes
// it; only SafeHtml (markup these helpers built) is inserted as it is.
//
// No helper emits a style attribute, an inline script or an event handler attribute: the
// content security policy allows none of them.

import { html, SafeHtml, safeHref, type HtmlValue } from "../html.js";
import { ICONS, type IconName } from "./icons.generated.js";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "accent";

// An inline Lucide icon, decorative: the text next to it or an aria-label says what it means.
export function icon(name: IconName, className = "size-4"): SafeHtml {
  return new SafeHtml(
    `<svg class="${className} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`,
  );
}

const DOT: Readonly<Record<Tone, string>> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-neutral",
  accent: "bg-brand",
};

const SOFT: Readonly<Record<Tone, string>> = {
  ok: "bg-ok-soft text-ok-fg",
  warn: "bg-warn-soft text-warn-fg",
  danger: "bg-danger-soft text-danger-fg",
  info: "bg-info-soft text-info-fg",
  neutral: "bg-subtle text-fg-muted",
  accent: "bg-accent-soft text-accent-fg",
};

const TEXT: Readonly<Record<Tone, string>> = {
  ok: "text-ok-fg",
  warn: "text-warn-fg",
  danger: "text-danger-fg",
  info: "text-info-fg",
  neutral: "text-fg-muted",
  accent: "text-accent-fg",
};

export function toneText(tone: Tone): string {
  return TEXT[tone];
}

export function toneSoft(tone: Tone): string {
  return SOFT[tone];
}

// A coloured dot with its label; pulse for something in progress. A long label wraps under
// itself; table cells keep it on one line.
export function statusDot(tone: Tone, label: HtmlValue, options: { pulse?: boolean } = {}) {
  return html`<span class="inline-flex max-w-full min-w-0 items-start gap-2"
    ><span
      class="mt-[0.45em] size-2 shrink-0 rounded-full ${DOT[tone]} ${options.pulse ? "animate-pulse-dot" : ""}"
      aria-hidden="true"
    ></span
    ><span class="min-w-0 [overflow-wrap:anywhere]">${label}</span></span
  >`;
}

export function badge(tone: Tone, text: HtmlValue): SafeHtml {
  return html`<span
    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${
      SOFT[tone]
    }"
    >${text}</span
  >`;
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-busy:opacity-70";
const BUTTON_SIZE: Readonly<Record<ButtonSize, string>> = {
  sm: "h-8 px-2.5 text-[13px]",
  md: "h-9 px-3.5 text-sm",
};
const BUTTON_VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary: "bg-accent text-on-accent shadow-xs hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-fg shadow-xs hover:bg-subtle",
  ghost: "text-fg-muted hover:bg-subtle hover:text-fg",
  danger: "bg-danger text-white shadow-xs hover:bg-danger-hover",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md") {
  return `${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]}`;
}

export interface ButtonOptions {
  label: HtmlValue;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  type?: "submit" | "button";
  name?: string;
  value?: string;
  disabled?: boolean;
  // The label while the form is busy (forms with data-busy).
  busyLabel?: boolean;
  className?: string;
}

export function button(options: ButtonOptions): SafeHtml {
  const size = options.size ?? "md";
  return html`<button
    type="${options.type ?? "submit"}"
    class="${buttonClass(options.variant, size)} ${options.className ?? ""}"
    ${options.name ? html`name="${options.name}"` : ""}
    ${options.value !== undefined ? html`value="${options.value}"` : ""}
    ${options.disabled ? html`disabled` : ""}
  >
    ${options.icon ? icon(options.icon, size === "sm" ? "size-3.5" : "size-4") : ""}<span
      ${options.busyLabel ? html`data-busy-label` : ""}
      >${options.label}</span
    >
  </button>`;
}

export interface LinkButtonOptions {
  href: string;
  label: HtmlValue;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  // Opens a page outside the bridge: a new tab without referrer.
  external?: boolean;
}

export function linkButton(options: LinkButtonOptions): SafeHtml {
  const size = options.size ?? "md";
  return html`<a
    href="${options.external ? safeHref(options.href) : options.href}"
    class="${buttonClass(options.variant, size)}"
    ${options.external ? html`target="_blank" rel="noopener noreferrer"` : ""}
    >${options.icon ? icon(options.icon, size === "sm" ? "size-3.5" : "size-4") : ""}<span>${options.label}</span>${options.external ? icon("external-link", "size-3.5 opacity-70") : ""}</a
  >`;
}

// A square button with only an icon; label is its accessible name and tooltip.
export function iconButton(options: {
  icon: IconName;
  label: string;
  type?: "submit" | "button";
  name?: string;
  value?: string;
  pressed?: boolean;
  className?: string;
}): SafeHtml {
  return html`<button
    type="${options.type ?? "button"}"
    class="inline-grid size-8 place-items-center rounded-md text-fg-muted transition-colors hover:bg-subtle hover:text-fg aria-pressed:bg-subtle aria-pressed:text-fg ${
      options.className ?? ""
    }"
    aria-label="${options.label}"
    title="${options.label}"
    ${options.name ? html`name="${options.name}"` : ""}
    ${options.value !== undefined ? html`value="${options.value}"` : ""}
    ${options.pressed === undefined ? "" : html`aria-pressed="${String(options.pressed)}"`}
  >
    ${icon(options.icon)}
  </button>`;
}

export function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${token}" />`;
}

// The data attributes that make a form ask before it submits (client script).
export interface Confirmation {
  title: string;
  message: string;
  ok: string;
  tone?: "danger" | "primary";
}

export function confirmAttributes(confirm: Confirmation | undefined): SafeHtml | string {
  if (!confirm) return "";
  return html`data-confirm="${confirm.message}" data-confirm-title="${confirm.title}"
  data-confirm-ok="${confirm.ok}" data-confirm-tone="${confirm.tone ?? "danger"}"`;
}

export interface CardOptions {
  title?: HtmlValue;
  icon?: IconName;
  // One short line under the title.
  subtitle?: HtmlValue;
  actions?: HtmlValue;
  body: HtmlValue;
  footer?: HtmlValue;
  id?: string;
  // The body without padding, for tables and lists that run edge to edge.
  flush?: boolean;
  className?: string;
}

export function card(options: CardOptions): SafeHtml {
  const headingId = options.id ? `${options.id}-title` : undefined;
  const header =
    options.title !== undefined
      ? html`<header
          class="flex min-h-13 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-2.5"
        >
          <div class="flex min-w-0 items-center gap-2">
            ${options.icon ? icon(options.icon, "size-4 text-fg-subtle") : ""}
            <div class="min-w-0">
              <h2 class="text-sm font-semibold" ${headingId ? html`id="${headingId}"` : ""}>
                ${options.title}
              </h2>
              ${options.subtitle ? html`<p class="text-xs text-fg-muted">${options.subtitle}</p>` : ""}
            </div>
          </div>
          ${options.actions ? html`<div class="flex items-center gap-2">${options.actions}</div>` : ""}
        </header>`
      : "";
  return html`<section
    class="min-w-0 rounded-lg border border-line bg-surface shadow-xs ${options.className ?? ""}"
    ${options.id ? html`id="${options.id}"` : ""}
    ${headingId ? html`aria-labelledby="${headingId}"` : ""}
  >
    ${header}
    <div class="${options.flush ? "" : "p-4"}">${options.body}</div>
    ${
      options.footer
        ? html`<footer class="border-t border-line px-4 py-3 text-xs text-fg-muted">
            ${options.footer}
          </footer>`
        : ""
    }
  </section>`;
}

export function statCard(options: {
  label: HtmlValue;
  value: HtmlValue;
  hint?: HtmlValue;
  icon: IconName;
  // A meter under the value, such as the share of a daily limit (0 to 1).
  meter?: { value: number; label: string };
}): SafeHtml {
  return html`<div class="min-w-0 rounded-lg border border-line bg-surface p-4 shadow-xs">
    <div class="flex items-center justify-between gap-2 text-fg-muted">
      <span class="truncate text-xs font-medium">${options.label}</span>
      ${icon(options.icon, "size-4 text-fg-subtle")}
    </div>
    <p class="mt-2 text-2xl font-semibold tracking-tight tabular-nums">${options.value}</p>
    ${
      options.meter
        ? html`<div class="mt-2">${usageBar(options.meter.value, options.meter.label)}</div>`
        : ""
    }
    ${options.hint ? html`<p class="mt-1 truncate text-xs text-fg-muted">${options.hint}</p>` : ""}
  </div>`;
}

// Widths in steps of 5 %, as whole class names so the stylesheet build finds them; a
// style attribute would break the content security policy.
const BAR_WIDTHS = [
  "w-0",
  "w-[5%]",
  "w-[10%]",
  "w-[15%]",
  "w-[20%]",
  "w-[25%]",
  "w-[30%]",
  "w-[35%]",
  "w-[40%]",
  "w-[45%]",
  "w-[50%]",
  "w-[55%]",
  "w-[60%]",
  "w-[65%]",
  "w-[70%]",
  "w-[75%]",
  "w-[80%]",
  "w-[85%]",
  "w-[90%]",
  "w-[95%]",
  "w-full",
] as const;

// A thin bar for the used share of a limit (0 to 1): orange, amber above 80 %, red at 95 %.
export function usageBar(share: number, label: string): SafeHtml {
  const value = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
  const step = value > 0 ? Math.max(1, Math.round(value * 20)) : 0;
  const tone = value >= 0.95 ? "bg-danger" : value >= 0.8 ? "bg-warn" : "bg-brand";
  return html`<div
    class="h-1.5 w-full overflow-hidden rounded-full bg-subtle"
    role="meter"
    aria-label="${label}"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow="${Math.round(value * 100)}"
  >
    <div class="h-full rounded-full ${tone} ${BAR_WIDTHS[step]}"></div>
  </div>`;
}

export function emptyState(options: {
  icon: IconName;
  text: HtmlValue;
  title?: HtmlValue;
  action?: HtmlValue;
}): SafeHtml {
  return html`<div class="flex flex-col items-center gap-3 px-4 py-10 text-center">
    <span class="grid size-10 place-items-center rounded-full bg-subtle text-fg-subtle"
      >${icon(options.icon, "size-5")}</span
    >
    ${options.title ? html`<p class="font-medium">${options.title}</p>` : ""}
    <p class="max-w-sm text-fg-muted">${options.text}</p>
    ${options.action ?? ""}
  </div>`;
}

const CALLOUT_ICON: Readonly<Record<"info" | "warn" | "danger" | "ok", IconName>> = {
  info: "info",
  warn: "triangle-alert",
  danger: "octagon-alert",
  ok: "circle-check",
};

const CALLOUT_FRAME: Readonly<Record<"info" | "warn" | "danger" | "ok", string>> = {
  info: "border-info/30 bg-info-soft",
  warn: "border-warn/40 bg-warn-soft",
  danger: "border-danger/30 bg-danger-soft",
  ok: "border-ok/30 bg-ok-soft",
};

export function callout(options: {
  tone: "info" | "warn" | "danger" | "ok";
  title?: HtmlValue;
  body?: HtmlValue;
  id?: string;
  // role="alert" for an error the page reports right after an action.
  alert?: boolean;
  actions?: HtmlValue;
}): SafeHtml {
  return html`<div
    class="flex gap-3 rounded-lg border px-4 py-3 ${CALLOUT_FRAME[options.tone]}"
    ${options.id ? html`id="${options.id}"` : ""}
    ${options.alert ? html`role="alert"` : ""}
  >
    <span class="mt-0.5 ${TEXT[options.tone]}">${icon(CALLOUT_ICON[options.tone])}</span>
    <div class="min-w-0 flex-1 space-y-1">
      ${
        options.title ? html`<p class="font-medium ${TEXT[options.tone]}">${options.title}</p>` : ""
      }
      ${options.body ? html`<div class="text-fg [overflow-wrap:anywhere]">${options.body}</div>` : ""}
      ${options.actions ? html`<div class="flex flex-wrap gap-2 pt-1">${options.actions}</div>` : ""}
    </div>
  </div>`;
}

export type DescriptionItem = readonly [label: HtmlValue, value: HtmlValue];

export function descriptionList(items: readonly DescriptionItem[]): SafeHtml {
  return html`<dl class="divide-y divide-line">
    ${items.map(
      ([label, value]) =>
        html`<div
          class="grid grid-cols-[minmax(6.5rem,2fr)_minmax(0,3fr)] gap-3 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4"
        >
          <dt class="text-fg-muted">${label}</dt>
          <dd class="min-w-0 [overflow-wrap:anywhere]">${value}</dd>
        </div>`,
    )}
  </dl>`;
}

export interface TabLink {
  href: string;
  label: HtmlValue;
  icon?: IconName;
  count?: number | null;
  active: boolean;
}

// Tabs that are links: each tab is its own page, chosen with a query parameter.
export function linkTabs(label: string, items: readonly TabLink[]): SafeHtml {
  return html`<nav
    class="-mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0"
    aria-label="${label}"
  >
    ${items.map(
      (item) =>
        html`<a
          href="${item.href}"
          class="-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
            item.active
              ? "border-brand text-fg"
              : "border-transparent text-fg-muted hover:border-line-strong hover:text-fg"
          }"
          ${item.active ? html`aria-current="page"` : ""}
          >${item.icon ? icon(item.icon, "size-4") : ""}${item.label}${
            item.count === undefined || item.count === null
              ? ""
              : html`<span
                  class="rounded-full bg-subtle px-1.5 text-xs font-medium text-fg-muted tabular-nums"
                  >${item.count}</span
                >`
          }</a
        >`,
    )}
  </nav>`;
}

export interface PageTab {
  id: string;
  label: HtmlValue;
  icon?: IconName;
  count?: number;
  body: HtmlValue;
  selected?: boolean;
}

// Tabs inside one page: all panels are in the markup. Without the script they stand one
// below the other with their headings and the tab bar links to them; the script turns them
// into tabs.
export function pageTabs(label: string, tabs: readonly PageTab[]): SafeHtml {
  return html`<div data-tabs class="min-w-0">
    <nav
      class="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0"
      aria-label="${label}"
    >
      ${tabs.map(
        (tab) =>
          html`<a
            href="#${tab.id}"
            id="${tab.id}-tab"
            data-tab="${tab.id}"
            ${tab.selected ? html`data-selected="true"` : ""}
            class="-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-fg-muted transition-colors hover:text-fg aria-selected:border-brand aria-selected:text-fg"
            >${tab.icon ? icon(tab.icon, "size-4") : ""}${tab.label}${
              tab.count === undefined
                ? ""
                : html`<span
                    class="rounded-full bg-subtle px-1.5 text-xs font-medium text-fg-muted tabular-nums"
                    >${tab.count}</span
                  >`
            }</a
          >`,
      )}
    </nav>
    ${tabs.map(
      (tab) =>
        html`<section id="${tab.id}" class="mb-6 min-w-0 scroll-mt-20">
          <h2 class="mb-3 text-sm font-semibold" data-tab-heading>${tab.label}</h2>
          ${tab.body}
        </section>`,
    )}
  </div>`;
}

export interface SegmentItem {
  href: string;
  label: HtmlValue;
  count?: number;
  active: boolean;
}

// A row of filter links that look like one control.
export function segmented(label: string, items: readonly SegmentItem[]): SafeHtml {
  return html`<nav class="max-w-full overflow-x-auto" aria-label="${label}">
    <div class="inline-flex gap-0.5 rounded-lg border border-line bg-subtle p-0.5">
      ${items.map(
        (item) =>
          html`<a
            href="${item.href}"
            class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium whitespace-nowrap transition-colors ${
              item.active ? "bg-surface text-fg shadow-xs" : "text-fg-muted hover:text-fg"
            }"
            ${item.active ? html`aria-current="true"` : ""}
            >${item.label}${
              item.count === undefined
                ? ""
                : html`<span class="text-xs text-fg-muted tabular-nums">${item.count}</span>`
            }</a
          >`,
      )}
    </div>
  </nav>`;
}

export const INPUT_CLASS =
  "block h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-fg shadow-xs placeholder:text-fg-subtle focus:border-brand focus:outline-2 focus:outline-offset-0 focus:outline-brand/25";
export const TEXTAREA_CLASS =
  "block w-full rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-fg shadow-xs placeholder:text-fg-subtle focus:border-brand focus:outline-2 focus:outline-offset-0 focus:outline-brand/25";
export const CHECKBOX_CLASS =
  "mt-0.5 size-4 shrink-0 rounded border-line-strong accent-[var(--ui-accent)]";

export function field(options: {
  id: string;
  label: HtmlValue;
  control: SafeHtml;
  hint?: HtmlValue;
  error?: HtmlValue;
  // A "?" popover next to the label for the longer explanation.
  help?: SafeHtml;
}): SafeHtml {
  return html`<div class="space-y-1.5">
    <div class="flex items-center gap-1.5">
      <label for="${options.id}" class="text-sm font-medium">${options.label}</label>
      ${options.help ?? ""}
    </div>
    ${options.control}
    ${
      options.hint
        ? html`<p id="${options.id}-hint" class="text-xs text-fg-muted">${options.hint}</p>`
        : ""
    }
    ${options.error ? html`<p class="text-xs text-danger-fg">${options.error}</p>` : ""}
  </div>`;
}

// A "?" that opens a short explanation; works without the script.
export function helpPopover(label: string, body: HtmlValue): SafeHtml {
  return html`<details class="relative inline-block" data-menu>
    <summary
      class="grid size-5 place-items-center rounded-full text-fg-subtle hover:text-fg"
      aria-label="${label}"
      title="${label}"
    >
      ${icon("circle-help", "size-3.5")}
    </summary>
    <div class="popover left-0 w-72 max-w-[calc(100vw-3rem)] p-3 text-xs leading-relaxed">
      ${body}
    </div>
  </details>`;
}

export interface CopyLabels {
  copy: string;
  copied: string;
  reveal: string;
}

// A value in a monospace box with a copy button. A secret shows masked; the details element
// reveals it, and the copy button copies the full value either way.
export function copyField(options: {
  id: string;
  value: string;
  // What shows while a secret is hidden; null for a value that is not secret.
  masked: string | null;
  labels: CopyLabels;
}): SafeHtml {
  const valueId = `${options.id}-value`;
  const copy = html`<button
    type="button"
    class="js-only inline-flex shrink-0 items-center gap-1.5 border-l border-line-strong px-3 text-xs font-medium text-fg-muted hover:bg-subtle hover:text-fg data-[state=copied]:text-ok-fg"
    data-copy="${valueId}"
    data-copied="${options.labels.copied}"
  >
    ${icon("copy", "size-3.5")}<span data-copy-label>${options.labels.copy}</span>
  </button>`;
  const box = (content: SafeHtml) =>
    html`<div
      class="flex min-w-0 items-stretch overflow-hidden rounded-md border border-line-strong bg-subtle"
    >
      ${content} ${copy}
    </div>`;
  if (options.masked === null) {
    return box(
      html`<code id="${valueId}" class="min-w-0 flex-1 px-3 py-2 text-xs break-all"
        >${options.value}</code
      >`,
    );
  }
  return html`<div class="space-y-2">
    ${box(
      html`<code class="min-w-0 flex-1 px-3 py-2 text-xs break-all" id="${options.id}-masked"
        >${options.masked}</code
      >`,
    )}
    <details class="group">
      <summary
        class="inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-fg"
      >
        ${icon("eye", "size-3.5")}<span>${options.labels.reveal}</span>
      </summary>
      <code
        id="${valueId}"
        class="mt-2 block rounded-md border border-line bg-subtle px-3 py-2 text-xs break-all"
        >${options.value}</code
      >
    </details>
  </div>`;
}

export interface TimelineItem {
  icon: IconName;
  tone: Tone;
  text: HtmlValue;
  time: SafeHtml;
  // A raw error under the sentence.
  sub?: string | null;
  // Collapsed technical details.
  details?: SafeHtml | null;
}

export function timeline(items: readonly TimelineItem[], detailsLabel: string): SafeHtml {
  return html`<ol class="relative">
    ${items.map(
      (item, index) =>
        html`<li class="relative flex gap-3 pb-4 last:pb-0">
          ${
            index < items.length - 1
              ? html`<span
                  class="absolute top-7 bottom-0 left-3.5 w-px bg-line"
                  aria-hidden="true"
                ></span>`
              : ""
          }
          <span
            class="relative grid size-7 shrink-0 place-items-center rounded-full ring-4 ring-surface ${
              SOFT[item.tone]
            }"
            >${icon(item.icon, "size-3.5")}</span
          >
          <div class="min-w-0 flex-1 pt-0.5">
            <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p class="min-w-0 [overflow-wrap:anywhere]">${item.text}</p>
              <span class="shrink-0 text-xs text-fg-muted">${item.time}</span>
            </div>
            ${
              item.sub
                ? html`<p
                    class="mt-1 line-clamp-3 font-mono text-xs [overflow-wrap:anywhere] ${
                      TEXT[
                        item.tone === "danger"
                          ? "danger"
                          : item.tone === "warn"
                            ? "warn"
                            : "neutral"
                      ]
                    }"
                  >
                    ${item.sub}
                  </p>`
                : ""
            }
            ${
              item.details
                ? html`<details class="mt-0.5">
                    <summary
                      class="inline-flex items-center gap-0.5 text-[11px] text-fg-subtle hover:text-fg-muted"
                    >
                      ${detailsLabel}${icon("chevron-down", "size-3")}
                    </summary>
                    <div class="mt-1.5">${item.details}</div>
                  </details>`
                : ""
            }
          </div>
        </li>`,
    )}
  </ol>`;
}

export interface Notice {
  tone: "ok" | "danger" | "info";
  text: string;
}

// Notices after an action, bottom right. A success notice fades out on its own.
export function toasts(notices: readonly Notice[], closeLabel: string): SafeHtml | string {
  if (notices.length === 0) return "";
  return html`<div
    class="pointer-events-none fixed inset-x-4 bottom-4 z-[70] flex flex-col items-end gap-2 sm:left-auto"
    aria-live="polite"
  >
    ${notices.map(
      (notice) =>
        html`<div
          class="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-lg ${
            notice.tone === "ok" ? "animate-toast" : ""
          }"
          role="status"
          data-toast
        >
          <span class="mt-0.5 ${TEXT[notice.tone]}"
            >${icon(
              notice.tone === "ok"
                ? "circle-check"
                : notice.tone === "danger"
                  ? "circle-x"
                  : "info",
            )}</span
          >
          <p class="min-w-0 flex-1">${notice.text}</p>
          <button
            type="button"
            class="js-only -m-1 grid size-6 place-items-center rounded text-fg-subtle hover:text-fg"
            aria-label="${closeLabel}"
            data-toast-close
          >
            ${icon("x", "size-3.5")}
          </button>
        </div>`,
    )}
  </div>`;
}

// The dialog the client script fills for forms with data-confirm.
export function confirmDialog(labels: { cancel: string; confirm: string }): SafeHtml {
  return html`<dialog id="confirm-dialog" class="modal" aria-labelledby="confirm-dialog-title">
    <form method="dialog" class="p-5">
      <h2 id="confirm-dialog-title" class="text-base font-semibold" data-confirm-title></h2>
      <p class="mt-2 text-fg-muted" data-confirm-message></p>
      <div class="mt-5 flex justify-end gap-2">
        <button type="submit" value="cancel" class="${buttonClass("secondary")}">
          ${labels.cancel}
        </button>
        <button
          type="submit"
          value="ok"
          class="${buttonClass("danger")} data-[tone=primary]:bg-accent data-[tone=primary]:text-on-accent"
          data-confirm-ok
          data-default="${labels.confirm}"
        >
          ${labels.confirm}
        </button>
      </div>
    </form>
  </dialog>`;
}

// A row menu: a details element with an icon button, closed by the script on a click
// outside; without the script it closes on a second click.
export function menu(label: string, items: readonly HtmlValue[]): SafeHtml {
  return html`<details class="relative" data-menu>
    <summary
      class="grid size-8 place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-fg"
      aria-label="${label}"
      title="${label}"
    >
      ${icon("ellipsis")}
    </summary>
    <div class="popover right-0 w-56" role="menu">${items}</div>
  </details>`;
}

const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm whitespace-nowrap hover:bg-subtle";

export function menuLink(options: {
  href: string;
  label: HtmlValue;
  icon: IconName;
  external?: boolean;
}): SafeHtml {
  return html`<a
    role="menuitem"
    class="${MENU_ITEM}"
    href="${options.external ? safeHref(options.href) : options.href}"
    ${options.external ? html`target="_blank" rel="noopener noreferrer"` : ""}
    >${icon(options.icon, "size-4 text-fg-subtle")}${options.label}</a
  >`;
}

export function menuForm(options: {
  action: string;
  csrf: string;
  label: HtmlValue;
  icon: IconName;
  danger?: boolean;
  fields?: Readonly<Record<string, string>>;
  confirm?: Confirmation;
}): SafeHtml {
  return html`<form method="post" action="${options.action}" ${confirmAttributes(options.confirm)}>
    ${csrfField(options.csrf)}
    ${Object.entries(options.fields ?? {}).map(
      ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
    )}
    <button
      type="submit"
      role="menuitem"
      class="${MENU_ITEM} ${options.danger ? "text-danger-fg" : ""}"
    >
      ${icon(options.icon, `size-4 ${options.danger ? "" : "text-fg-subtle"}`)}${options.label}
    </button>
  </form>`;
}

export function pageHeader(options: {
  title: HtmlValue;
  subtitle?: HtmlValue;
  actions?: HtmlValue;
  back?: { href: string; label: string };
  // A picture in front of the title, such as the recipe thumbnail.
  media?: SafeHtml;
  // A line under the title with status and facts.
  meta?: HtmlValue;
}): SafeHtml {
  return html`<div class="mb-6 space-y-3">
    ${
      options.back
        ? html`<a
            href="${options.back.href}"
            class="inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
            >${icon("arrow-left", "size-3.5")}${options.back.label}</a
          >`
        : ""
    }
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex min-w-0 items-center gap-4">
        ${options.media ?? ""}
        <div class="min-w-0">
          <h1 class="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
            ${options.title}
          </h1>
          ${options.subtitle ? html`<p class="mt-1 text-fg-muted">${options.subtitle}</p>` : ""}
          ${
            options.meta
              ? html`<div
                  class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-fg-muted"
                >
                  ${options.meta}
                </div>`
              : ""
          }
        </div>
      </div>
      ${
        options.actions
          ? html`<div class="flex flex-wrap items-center gap-2">${options.actions}</div>`
          : ""
      }
    </div>
  </div>`;
}

// A recipe picture through the bridge; a neutral tile stands in when Mealie has none.
export function thumbnail(src: string, size: "sm" | "lg" = "sm"): SafeHtml {
  const box = size === "lg" ? "size-16 rounded-lg" : "size-9 rounded-md";
  return html`<img
    src="${src}"
    alt=""
    width="${size === "lg" ? 64 : 36}"
    height="${size === "lg" ? 64 : 36}"
    loading="lazy"
    decoding="async"
    class="${box} max-w-none shrink-0 border border-line bg-subtle object-cover"
  />`;
}

// A table in a card with a sticky header and row hover; narrow screens scroll it.
export function table(options: {
  head: readonly HtmlValue[];
  rows: readonly SafeHtml[];
  // Right-aligned columns by index.
  numeric?: readonly number[];
}): SafeHtml {
  const numeric = new Set(options.numeric ?? []);
  return html`<div class="overflow-x-auto">
    <table class="w-full text-left text-sm">
      <thead class="sticky top-0 bg-subtle text-xs text-fg-muted">
        <tr>
          ${options.head.map(
            (cell, index) =>
              html`<th
                scope="col"
                class="px-4 py-2 font-medium whitespace-nowrap ${numeric.has(index) ? "text-right" : ""}"
              >
                ${cell}
              </th>`,
          )}
        </tr>
      </thead>
      <tbody class="divide-y divide-line">
        ${options.rows}
      </tbody>
    </table>
  </div>`;
}
