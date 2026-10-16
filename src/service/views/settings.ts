// The settings page in six tabs: the Monsieur Cuisine session, the Lidl account of the
// automatic login, the Mealie connection with the recipe action URL, the language model
// (read only), notifications and the system with the effective configuration.
//
// The Lidl password is never shown or sent back; secrets of the configuration arrive here
// already reduced to "set" or "unset" (src/config-reference.ts).

import { REQUIRED_DEFAULT, type ConfigEntry } from "../../config-reference.js";
import type { AdminMessages, SavedStatus } from "../../i18n/index.js";
import type { AutoLoginStatus } from "../../session/auto-login.js";
import { browserName, type LoginProgress } from "../../session/browser-login.js";
import type { SessionStatus } from "../../session/manager.js";
import type { JobSummary } from "../../store/jobs.js";
import { html, type SafeHtml } from "../html.js";
import {
  badge,
  button,
  callout,
  card,
  confirmAttributes,
  copyField,
  csrfField,
  descriptionList,
  field,
  icon,
  INPUT_CLASS,
  linkButton,
  linkTabs,
  pageHeader,
  statusDot,
  TEXTAREA_CLASS,
  usageBar,
} from "../ui/components.js";
import { formatMs, formatNumber } from "../ui/format.js";
import { REPOSITORY_URL } from "../ui/shell.js";
import { dateTag, money, timeTag, type ViewContext } from "./context.js";
import type { AiInfo, MealieCheck } from "./dashboard.js";

export const SETTINGS_TABS = ["mc", "lidl", "mealie", "ai", "notify", "system"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function parseSettingsTab(value: unknown): SettingsTab {
  return typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value)
    ? (value as SettingsTab)
    : "mc";
}

// Stands in for the webhook token until the admin reveals it.
export const TOKEN_MASK = "••••••••";

// The two URLs a recipe action can point at, without the token.
export interface WebhookInfo {
  // The bridge's compose service name on the Docker network, the usual setup.
  dockerBase: string;
  // The address this page was opened with; null without a Host header.
  pageBase: string | null;
  token: string;
}

export interface SettingsViewData {
  tab: SettingsTab;
  session: SessionStatus;
  autoLogin: { status: AutoLoginStatus; browserUnavailable: string | null } | null;
  config: readonly ConfigEntry[] | null;
  locale: { mcLocale: string; verified: boolean; uiLanguage: string; recipeStatus: SavedStatus };
  mealie: { url: string | null; check: MealieCheck; webhook: WebhookInfo | null };
  ai: AiInfo | null;
  limits: { jobs: number; costUsd: number };
  usage: { month: JobSummary; today: { jobs: number; costUsd: number } };
  // Null when no mail is configured.
  notify: { recipient: string | null; canTest: boolean };
  system: { version: string; uptimeMs: number; dataDir: string | null };
}

function sessionTab(data: SettingsViewData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.settings.mc;
  const { session } = data;
  const tone =
    session.state === "valid" ? "ok" : session.state === "unknown" ? "neutral" : "danger";
  const expiry = session.cookieExpiresAt;
  const expired = expiry !== null && Date.parse(expiry) <= ctx.now.getTime();
  const status = card({
    title: l.title,
    icon: "chef-hat",
    actions: html`<form method="post" action="/admin/session/check">
      ${csrfField(ctx.csrf)} ${button({ label: l.checkNow, icon: "refresh-cw", size: "sm" })}
    </form>`,
    body: descriptionList([
      [l.state, statusDot(tone, ctx.t.sessionState[session.state])],
      ...(expiry
        ? [
            [
              l.expires,
              html`${dateTag(expiry, ctx)}
                <span class="${expired ? "text-danger-fg" : "text-fg-muted"}"
                  >· ${timeTag(expiry, ctx)}</span
                >`,
            ] as const,
          ]
        : []),
      [l.lastCheck, timeTag(session.checkedAt, ctx)],
      [
        l.age,
        session.cookieAgeHours === null
          ? l.noCookie
          : l.ageValue(session.cookieAgeHours, session.cookieAgeFrom ?? "stored"),
      ],
      ...(session.lastError
        ? [[l.lastError, html`<span class="text-danger-fg">${session.lastError}</span>`] as const]
        : []),
    ]),
    footer: l.checkHint,
  });
  const renew = card({
    title: l.renewTitle,
    icon: "key-round",
    body: html`<ol class="space-y-3">
      <li class="flex gap-3">
        <span class="mt-0.5 text-fg-subtle">${icon("power")}</span>
        <div>
          <p class="font-medium">${l.ways.auto}</p>
          <p class="text-fg-muted">
            ${l.ways.autoHint}
            <a href="/admin/settings?tab=lidl" class="font-medium text-accent-fg hover:underline"
              >${l.ways.autoLink}</a
            >
          </p>
        </div>
      </li>
      <li class="flex gap-3">
        <span class="mt-0.5 text-fg-subtle">${icon("monitor")}</span>
        <div class="min-w-0 flex-1">
          <p class="font-medium">${l.ways.helper}</p>
          <p class="mb-2 text-fg-muted">${l.ways.helperHint}</p>
          ${copyField({
            id: "login-helper",
            value: "npm run mc:login -- --bridge http://<bridge>:3000",
            masked: null,
            labels: ctx.t.copy,
          })}
        </div>
      </li>
      <li class="flex gap-3">
        <span class="mt-0.5 text-fg-subtle">${icon("file-text")}</span>
        <div class="min-w-0 flex-1">
          <details>
            <summary class="font-medium hover:text-accent-fg">
              ${l.ways.cookie} ${icon("chevron-down", "inline size-4 text-fg-subtle")}
            </summary>
            <form method="post" action="/admin/session" class="mt-3 space-y-3">
              ${csrfField(ctx.csrf)}
              ${field({
                id: "cookie",
                label: l.cookieLabel,
                hint: l.cookieHint,
                control: html`<textarea
                  id="cookie"
                  name="cookie"
                  rows="4"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  class="${TEXTAREA_CLASS}"
                ></textarea>`,
              })}
              ${button({ label: l.saveCookie, variant: "primary", size: "sm" })}
            </form>
          </details>
        </div>
      </li>
    </ol>`,
  });
  return html`<div class="grid items-start gap-4 xl:grid-cols-2">${status}${renew}</div>`;
}

// The steps an attempt reached, in order. A stored step this version does not know is
// left out.
function progressSteps(progress: LoginProgress, l: AdminMessages["settings"]["lidl"]) {
  const reached = (Array.isArray(progress.reached) ? progress.reached : []).filter((name) =>
    Object.hasOwn(l.steps, name),
  );
  return reached.map((name) =>
    name === "consent_dismissed" && progress.consentDismissals > 1
      ? l.consentSteps(progress.consentDismissals)
      : l.steps[name],
  );
}

function lastAttemptCard(status: AutoLoginStatus, ctx: ViewContext): SafeHtml | string {
  const l = ctx.t.settings.lidl;
  const last = status.last;
  if (!last) return "";
  const steps = last.progress ? progressSteps(last.progress, l) : [];
  const browser = last.progress?.browser;
  const notes = [
    last.consentDismissed && !last.progress ? l.consentDismissed : null,
    last.termsAccepted ? l.termsAccepted : null,
    last.deviceChosen ? l.deviceChosen : null,
  ].filter((note): note is string => note !== null);
  return card({
    title: l.lastAttempt,
    icon: "history",
    actions: last.screenshot
      ? linkButton({
          href: `/admin/settings/screenshots/${encodeURIComponent(last.screenshot)}`,
          label: l.screenshot,
          icon: "image",
          size: "sm",
        })
      : undefined,
    body: html`<div class="space-y-3">
      <p class="flex flex-wrap items-center gap-x-3 gap-y-1">
        ${statusDot(last.ok ? "ok" : "danger", last.ok ? l.succeeded : l.failed)}
        <span class="text-fg-muted">${timeTag(last.at, ctx)}</span>
        ${last.manual ? badge("neutral", l.manual) : ""}
      </p>
      ${last.code ? html`<p>${l.failure[last.code]}</p>` : ""}
      ${last.detail ? html`<p class="font-mono text-xs text-fg-muted">${last.detail}</p>` : ""}
      ${
        steps.length > 0
          ? html`<div>
              <p class="mb-1.5 text-xs font-medium text-fg-muted">${l.progressTitle}</p>
              <ol class="space-y-1">
                ${steps.map(
                  (step) =>
                    html`<li class="flex items-center gap-2 text-[13px]">
                      <span class="text-ok-fg">${icon("check", "size-3.5")}</span>${step}
                    </li>`,
                )}
              </ol>
            </div>`
          : ""
      }
      ${notes.map((note) => html`<p class="text-xs text-fg-muted">${note}</p>`)}
      ${
        browser
          ? html`<p class="text-xs text-fg-muted">
              ${l.browserUsed(
                browserName(browser.userAgent),
                browser.headless === false ? "window" : browser.headless,
              )}
            </p>`
          : ""
      }
    </div>`,
  });
}

function lidlTab(data: SettingsViewData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.settings.lidl;
  if (data.autoLogin === null) {
    return card({ body: callout({ tone: "info", title: l.unavailable }) });
  }
  const { status, browserUnavailable } = data.autoLogin;
  const cooldown = status.manualAvailableAt;
  const account = card({
    title: l.title,
    icon: "key-round",
    actions: status.configured
      ? html`<form method="post" action="/admin/settings/login">
          ${csrfField(ctx.csrf)}
          ${button({
            label: l.testNow,
            icon: "play",
            size: "sm",
            disabled: status.running || cooldown !== null,
          })}
        </form>`
      : undefined,
    body: html`${descriptionList([
        [
          l.account,
          status.configured && status.email
            ? statusDot("ok", status.email)
            : statusDot("neutral", l.notConfigured),
        ],
        [
          l.browser,
          browserUnavailable === null
            ? statusDot("ok", l.browserReady)
            : statusDot("danger", l.browserMissing(browserUnavailable)),
        ],
        ...(status.running
          ? [[l.state, statusDot("info", l.running, { pulse: true })] as const]
          : []),
        ...(status.nextAttemptAt
          ? [[l.nextAttempt, timeTag(status.nextAttemptAt, ctx)] as const]
          : []),
        ...(cooldown ? [[l.nextTest, timeTag(cooldown, ctx)] as const] : []),
      ])}
      <details class="mt-4 rounded-md border border-line bg-subtle px-3 py-2">
        <summary class="flex items-center gap-1.5 text-[13px] font-medium">
          ${icon("info", "size-4 text-fg-subtle")}${l.howItWorks}
        </summary>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-[13px] text-fg-muted">
          ${l.facts.map((fact) => html`<li>${fact}</li>`)}
        </ul>
      </details>`,
  });
  const form = card({
    title: status.configured ? l.changeAccount : l.storeAccount,
    icon: "user-round",
    body: html`<form method="post" action="/admin/settings/credentials" class="space-y-4">
      ${csrfField(ctx.csrf)}
      ${field({
        id: "lidl-email",
        label: l.email,
        hint: l.emailHint,
        control: html`<input
          id="lidl-email"
          type="email"
          name="email"
          value="${status.email ?? ""}"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          required
          class="${INPUT_CLASS}"
        />`,
      })}
      ${field({
        id: "lidl-password",
        label: l.password,
        hint: l.passwordHint,
        control: html`<input
          id="lidl-password"
          type="password"
          name="password"
          autocomplete="new-password"
          placeholder="${status.configured ? l.passwordStored : ""}"
          ${status.configured ? "" : html`required`}
          class="${INPUT_CLASS}"
        />`,
      })}
      ${button({ label: l.save, variant: "primary" })}
    </form>`,
  });
  const danger = status.configured
    ? html`<section class="rounded-lg border border-danger/40 bg-surface shadow-xs">
        <div class="flex flex-wrap items-center justify-between gap-3 p-4">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-danger-fg">${l.dangerZone}</h2>
            <p class="text-[13px] text-fg-muted">${l.removeHint}</p>
          </div>
          <form
            method="post"
            action="/admin/settings/credentials/delete"
            ${confirmAttributes({ title: l.remove, message: l.removeConfirm, ok: l.remove })}
          >
            ${csrfField(ctx.csrf)}
            ${button({ label: l.remove, variant: "danger", icon: "trash-2", size: "sm" })}
          </form>
        </div>
      </section>`
    : "";
  return html`<div class="grid items-start gap-4 xl:grid-cols-2">
    <div class="space-y-4">${account}${lastAttemptCard(status, ctx)}</div>
    <div class="space-y-4">${form}${danger}</div>
  </div>`;
}

function mealieTab(data: SettingsViewData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.settings.mealie;
  const { check, webhook } = data.mealie;
  const connection = card({
    title: l.title,
    icon: "utensils",
    body: descriptionList([
      [l.url, data.mealie.url ? html`<code class="text-xs">${data.mealie.url}</code>` : "–"],
      [
        l.state,
        check.state === "ok"
          ? statusDot("ok", l.connected)
          : check.state === "failed"
            ? statusDot("danger", l.failed)
            : statusDot("neutral", l.unchecked),
      ],
      ...(check.user ? [[l.user, check.user] as const] : []),
      ...(check.error
        ? [[l.error, html`<span class="text-danger-fg">${check.error}</span>`] as const]
        : []),
      [l.lastCheck, timeTag(check.checkedAt, ctx)],
    ]),
    ...(check.state === "failed" ? { footer: l.fix } : {}),
  });
  const action = card({
    title: l.actionTitle,
    icon: "link",
    subtitle: l.actionSubtitle,
    body: webhook
      ? html`<div class="space-y-4">
          <div class="space-y-1.5">
            <p class="text-sm font-medium">${l.dockerUrl}</p>
            ${copyField({
              id: "webhook-docker",
              value: `${webhook.dockerBase}${webhook.token}`,
              masked: `${webhook.dockerBase}${TOKEN_MASK}`,
              labels: { ...ctx.t.copy, reveal: l.reveal },
            })}
          </div>
          ${
            webhook.pageBase
              ? html`<div class="space-y-1.5">
                  <p class="text-sm font-medium">${l.pageUrl}</p>
                  ${copyField({
                    id: "webhook-page",
                    value: `${webhook.pageBase}${webhook.token}`,
                    masked: `${webhook.pageBase}${TOKEN_MASK}`,
                    labels: { ...ctx.t.copy, reveal: l.reveal },
                  })}
                </div>`
              : ""
          }
          ${callout({ tone: "info", body: l.allowList })}
          <p class="text-xs text-fg-muted">${l.secret}</p>
        </div>`
      : html`<p class="text-fg-muted">${l.noToken}</p>`,
  });
  return html`<div class="grid items-start gap-4 xl:grid-cols-2">${connection}${action}</div>`;
}

function limitRow(used: string, limit: string | null, share: number | null, label: string) {
  return html`<div class="space-y-1.5">
    <p class="tabular-nums">${limit === null ? used : `${used} / ${limit}`}</p>
    ${share === null ? "" : usageBar(share, label)}
  </div>`;
}

function aiTab(data: SettingsViewData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.settings.ai;
  const { ai, limits, usage } = data;
  const intl = ctx.m.intlLocale;
  const model = card({
    title: l.title,
    icon: "sparkles",
    body: ai
      ? descriptionList([
          [l.provider, l.providers[ai.provider] ?? ai.provider],
          [l.model, html`<code class="text-xs">${ai.model}</code>`],
          ...(ai.effort ? [[l.effort, ai.effort] as const] : []),
          [l.corrections, String(ai.maxCorrections)],
        ])
      : html`<p class="text-fg-muted">–</p>`,
    footer: l.readOnly,
  });
  const quota = card({
    title: l.limits,
    icon: "gauge",
    body: descriptionList([
      [
        l.jobsToday,
        limitRow(
          formatNumber(usage.today.jobs, intl),
          limits.jobs > 0 ? formatNumber(limits.jobs, intl) : null,
          limits.jobs > 0 ? usage.today.jobs / limits.jobs : null,
          l.jobsToday,
        ),
      ],
      [
        l.costToday,
        limitRow(
          money(usage.today.costUsd, ctx),
          limits.costUsd > 0 ? money(limits.costUsd, ctx) : null,
          limits.costUsd > 0 ? usage.today.costUsd / limits.costUsd : null,
          l.costToday,
        ),
      ],
      [l.monthJobs, formatNumber(usage.month.total, intl)],
      [l.monthCost, html`<span class="tabular-nums">${money(usage.month.costUsd, ctx)}</span>`],
      [
        l.monthTokens,
        l.tokens(
          formatNumber(usage.month.inputTokens, intl),
          formatNumber(usage.month.outputTokens, intl),
        ),
      ],
    ]),
    footer: l.limitsHint,
  });
  return html`<div class="grid items-start gap-4 xl:grid-cols-2">${model}${quota}</div>`;
}

function notifyTab(data: SettingsViewData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.settings.notify;
  const { recipient, canTest } = data.notify;
  return html`<div class="grid items-start gap-4 xl:grid-cols-2">
    ${card({
      title: l.title,
      icon: "mail",
      actions:
        recipient && canTest
          ? html`<form method="post" action="/admin/settings/notify/test" data-busy="${l.sending}">
              ${csrfField(ctx.csrf)}
              ${button({ label: l.test, icon: "send", size: "sm", busyLabel: true })}
            </form>`
          : undefined,
      body: html`${descriptionList([
          [l.state, recipient ? statusDot("ok", l.on) : statusDot("neutral", l.off)],
          ...(recipient ? [[l.recipient, recipient] as const] : []),
        ])}
        <p class="mt-4 text-[13px] text-fg-muted">${recipient ? l.what : l.setUp}</p>`,
    })}
  </div>`;
}

function configValue(entry: ConfigEntry, t: AdminMessages): SafeHtml {
  const l = t.settings.system;
  if (entry.secret) {
    return entry.source === "unset"
      ? html`<span class="text-fg-muted">${l.unset}</span>`
      : badge("neutral", l.hidden);
  }
  if (entry.value === null) return html`<span class="text-fg-muted">${l.unset}</span>`;
  return html`<code class="text-xs break-all">${entry.value}</code>${
      entry.source === "default"
        ? html` <span class="text-xs text-fg-muted">${l.isDefault}</span>`
        : ""
    }`;
}

// Text with `code` spans from the configuration reference.
function codeText(text: string): SafeHtml {
  const parts = text.split("`");
  return html`${parts.map((part, index) =>
    index % 2 === 1 ? html`<code class="text-xs">${part}</code>` : part,
  )}`;
}

function configTable(config: readonly ConfigEntry[], t: AdminMessages): SafeHtml {
  const l = t.settings.system;
  return html`<div class="overflow-x-auto rounded-lg border border-line">
    <table class="w-full text-left text-[13px]">
      <thead class="bg-subtle text-xs text-fg-muted">
        <tr>
          <th scope="col" class="px-3 py-2 font-medium">${l.name}</th>
          <th scope="col" class="px-3 py-2 font-medium">${l.value}</th>
          <th scope="col" class="px-3 py-2 font-medium">${l.description}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-line">
        ${config.map(
          (entry) =>
            html`<tr class="align-top">
              <td class="px-3 py-2"><code class="text-xs">${entry.name}</code></td>
              <td class="max-w-56 px-3 py-2">${configValue(entry, t)}</td>
              <td class="min-w-64 px-3 py-2 text-fg-muted">
                ${codeText(entry.description)}
                <span class="mt-1 block text-xs"
                  >${l.defaultLabel}
                  ${
                    entry.default === REQUIRED_DEFAULT
                      ? l.required
                      : entry.default === "unset"
                        ? l.unset
                        : codeText(entry.default)
                  }${entry.values ? html`; ${l.valuesLabel} ${codeText(entry.values)}` : ""}</span
                >
              </td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function systemTab(data: SettingsViewData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.settings.system;
  const { locale, system } = data;
  const info = card({
    title: l.title,
    icon: "server",
    actions: linkButton({
      href: `${REPOSITORY_URL}#readme`,
      label: l.readme,
      icon: "book-open",
      size: "sm",
      external: true,
    }),
    body: descriptionList([
      [l.version, html`<span class="tabular-nums">${system.version}</span>`],
      [l.uptime, formatMs(system.uptimeMs)],
      [l.dataDir, system.dataDir ? html`<code class="text-xs">${system.dataDir}</code>` : "–"],
      [
        l.mcLocale,
        html`<code class="text-xs">${locale.mcLocale}</code>
          ${locale.verified ? "" : badge("warn", l.unverified)}`,
      ],
      [l.uiLanguage, html`<code class="text-xs">${locale.uiLanguage}</code>`],
      [
        l.recipeStatus,
        html`<code class="text-xs">${locale.recipeStatus}</code>
          <p class="text-xs text-fg-muted">${l.recipeStatusHint[locale.recipeStatus]}</p>`,
      ],
    ]),
    footer: l.envHint,
  });
  const advanced =
    data.config === null
      ? ""
      : html`<details class="rounded-lg border border-line bg-surface shadow-xs">
          <summary class="flex items-center justify-between gap-2 px-4 py-3">
            <span class="flex items-center gap-2 text-sm font-semibold"
              >${icon("database", "size-4 text-fg-subtle")}${l.advanced}</span
            >
            ${icon("chevron-down", "size-4 text-fg-subtle")}
          </summary>
          <div class="border-t border-line p-4">
            <p class="mb-3 text-[13px] text-fg-muted">${l.configHint}</p>
            ${configTable(data.config, ctx.t)}
          </div>
        </details>`;
  return html`<div class="space-y-4">${info}${advanced}</div>`;
}

export function settingsView(data: SettingsViewData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.settings;
  const tab = data.tab;
  const tabs = linkTabs(
    l.tabsLabel,
    SETTINGS_TABS.map((key) => ({
      href: key === "mc" ? "/admin/settings" : `/admin/settings?tab=${key}`,
      label: l.tabs[key],
      icon: TAB_ICONS[key],
      active: key === tab,
    })),
  );
  const body =
    tab === "lidl"
      ? lidlTab(data, ctx)
      : tab === "mealie"
        ? mealieTab(data, ctx)
        : tab === "ai"
          ? aiTab(data, ctx)
          : tab === "notify"
            ? notifyTab(data, ctx)
            : tab === "system"
              ? systemTab(data, ctx)
              : sessionTab(data, ctx);
  return html`${pageHeader({ title: l.title, subtitle: l.subtitle })}${tabs}${body}`;
}

const TAB_ICONS = {
  mc: "chef-hat",
  lidl: "key-round",
  mealie: "utensils",
  ai: "sparkles",
  notify: "mail",
  system: "server",
} as const;
