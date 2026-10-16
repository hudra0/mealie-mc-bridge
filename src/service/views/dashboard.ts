// The overview: four health chips, the figures of the last 30 days, the recent jobs, the
// setup steps while something is missing, and the last error of the past week.

import type { WorkerStatus } from "../../pipeline/worker.js";
import type { SessionStatus } from "../../session/manager.js";
import type { Job, JobStats, JobSummary } from "../../store/jobs.js";
import { html, type HtmlValue, type SafeHtml } from "../html.js";
import {
  callout,
  card,
  csrfField,
  emptyState,
  icon,
  iconButton,
  linkButton,
  pageHeader,
  statCard,
  statusDot,
  type Tone,
} from "../ui/components.js";
import { formatMs, formatPercent } from "../ui/format.js";
import type { IconName } from "../ui/icons.generated.js";
import { jobHref, jobTitle, money, timeTag, type ViewContext } from "./context.js";
import { failureDetails, failureSummary } from "./failure.js";
import { jobTable } from "./jobs.js";

// The answer of Mealie to the API token: reached (as which user), failed, or not checked.
export interface MealieCheck {
  state: "ok" | "failed" | "unchecked";
  error: string | null;
  checkedAt: string | null;
  // The Mealie user the token belongs to.
  user: string | null;
}

// The language model of the converter, as configured.
export interface AiInfo {
  provider: string;
  model: string;
  // The reasoning effort (OpenAI); null where the provider has none.
  effort: string | null;
  maxCorrections: number;
}

export interface DashboardData {
  session: SessionStatus;
  worker: WorkerStatus | null;
  // All jobs per status, for the setup steps.
  stats: JobStats;
  // The jobs of the last 30 days.
  summary: JobSummary;
  // The jobs and the cost of the last 24 hours, against the daily limits (0: no limit).
  today: { jobs: number; costUsd: number };
  limits: { jobs: number; costUsd: number };
  jobs: Job[];
  mealie: { url: string | null; check: MealieCheck };
  // Null when the service runs without the automatic login.
  autoLogin: {
    configured: boolean;
    email: string | null;
    last: { ok: boolean; at: string } | null;
  } | null;
  ai: AiInfo | null;
  lastFailedJob: Job | null;
  // The stage of the last failure of the listed jobs (JobStore.failureStages).
  stages: ReadonlyMap<string, string>;
  setupDismissed: boolean;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function chip(options: {
  href: string;
  icon: IconName;
  label: string;
  tone: Tone;
  value: HtmlValue;
  detail: HtmlValue;
}): SafeHtml {
  return html`<a
    href="${options.href}"
    class="group flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-xs transition-colors hover:border-line-strong"
  >
    <span class="grid size-9 shrink-0 place-items-center rounded-md bg-subtle text-fg-muted"
      >${icon(options.icon)}</span
    >
    <span class="min-w-0 flex-1">
      <span class="block text-xs text-fg-muted">${options.label}</span>
      <span class="block font-medium">${statusDot(options.tone, options.value)}</span>
      <span class="block truncate text-xs text-fg-muted">${options.detail}</span>
    </span>
    ${icon("chevron-right", "size-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100")}
  </a>`;
}

function healthChips(data: DashboardData, ctx: ViewContext): SafeHtml {
  const h = ctx.t.dashboard.health;
  const { check } = data.mealie;
  const mealie = chip({
    href: "/admin/settings?tab=mealie",
    icon: "utensils",
    label: "Mealie",
    ...(check.state === "ok"
      ? {
          tone: "ok" as const,
          value: h.connected,
          detail: check.user ? h.asUser(check.user) : (data.mealie.url ?? ""),
        }
      : check.state === "failed"
        ? { tone: "danger" as const, value: h.error, detail: check.error ?? "" }
        : { tone: "neutral" as const, value: h.unchecked, detail: data.mealie.url ?? "" }),
  });

  const { session } = data;
  const expiry = session.cookieExpiresAt;
  const mc = chip({
    href: "/admin/settings",
    icon: "chef-hat",
    label: "Monsieur Cuisine",
    ...(session.state === "valid"
      ? {
          tone: "ok" as const,
          value: h.sessionValid,
          detail: expiry
            ? html`${h.until} ${timeTag(expiry, ctx)}`
            : h.checked(session.checkedAt !== null),
        }
      : session.state === "unknown"
        ? { tone: "neutral" as const, value: ctx.t.sessionState.unknown, detail: h.renew }
        : { tone: "danger" as const, value: ctx.t.sessionState[session.state], detail: h.renew }),
  });

  const auto = data.autoLogin;
  const login = chip({
    href: "/admin/settings?tab=lidl",
    icon: "key-round",
    label: h.autoLogin,
    ...(auto === null
      ? { tone: "neutral" as const, value: h.unavailable, detail: "" }
      : !auto.configured
        ? { tone: "neutral" as const, value: h.off, detail: h.setUp }
        : auto.last && !auto.last.ok
          ? {
              tone: "warn" as const,
              value: h.lastFailed,
              detail: timeTag(auto.last.at, ctx),
            }
          : { tone: "ok" as const, value: h.active, detail: auto.email ?? "" }),
  });

  const ai = chip({
    href: "/admin/settings?tab=ai",
    icon: "sparkles",
    label: h.ai,
    ...(data.ai
      ? {
          tone: "ok" as const,
          value: ctx.t.settings.ai.providers[data.ai.provider] ?? data.ai.provider,
          detail: data.ai.effort ? `${data.ai.model} · ${data.ai.effort}` : data.ai.model,
        }
      : { tone: "neutral" as const, value: "–", detail: "" }),
  });
  return html`<div class="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    ${mealie}${mc}${login}${ai}
  </div>`;
}

function figures(data: DashboardData, ctx: ViewContext): SafeHtml {
  const k = ctx.t.dashboard.kpi;
  const { summary } = data;
  const finished = summary.done + summary.failed;
  const costLimit = data.limits.costUsd;
  return html`<div class="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
    ${statCard({
      label: k.sent,
      value: summary.done,
      icon: "send",
      hint: k.sentHint(summary.total, summary.skipped),
    })}
    ${statCard({
      label: k.successRate,
      value: finished === 0 ? "–" : formatPercent(summary.done / finished, ctx.m.intlLocale),
      icon: "activity",
      hint: finished === 0 ? k.noFinished : k.failed(summary.failed),
    })}
    ${statCard({
      label: k.duration,
      value: formatMs(summary.avgDurationMs),
      icon: "timer",
      hint: k.durationHint,
    })}
    ${statCard({
      label: k.cost,
      value: money(summary.costUsd, ctx),
      icon: "wallet",
      hint:
        costLimit > 0
          ? k.costToday(money(data.today.costUsd, ctx), money(costLimit, ctx))
          : k.costTodayNoLimit(money(data.today.costUsd, ctx)),
      ...(costLimit > 0
        ? { meter: { value: data.today.costUsd / costLimit, label: k.costMeter } }
        : {}),
    })}
  </div>`;
}

interface SetupStep {
  done: boolean;
  title: string;
  href: string | null;
}

function setupSteps(data: DashboardData, ctx: ViewContext): SetupStep[] {
  const s = ctx.t.dashboard.setup;
  const total = Object.values(data.stats).reduce((sum, count) => sum + count, 0);
  return [
    {
      done: data.mealie.check.state === "ok",
      title: s.mealie,
      href: "/admin/settings?tab=mealie",
    },
    { done: data.session.state === "valid", title: s.session, href: "/admin/settings" },
    ...(data.autoLogin
      ? [
          {
            done: data.autoLogin.configured,
            title: s.autoLogin,
            href: "/admin/settings?tab=lidl",
          },
        ]
      : []),
    { done: total > 0, title: s.action, href: "/admin/settings?tab=mealie" },
    { done: data.stats.done > 0, title: s.firstRecipe, href: null },
  ];
}

function setupCard(data: DashboardData, ctx: ViewContext): SafeHtml | string {
  if (data.setupDismissed) return "";
  const steps = setupSteps(data, ctx);
  const open = steps.filter((step) => !step.done).length;
  if (open === 0) return "";
  const s = ctx.t.dashboard.setup;
  return html`<div class="mb-6">
    ${card({
      title: s.title,
      icon: "list-checks",
      subtitle: s.progress(steps.length - open, steps.length),
      actions: html`<form method="post" action="/admin/setup/dismiss">
        ${csrfField(ctx.csrf)} ${iconButton({ icon: "x", label: s.dismiss, type: "submit" })}
      </form>`,
      body: html`<ol class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          ${steps.map(
            (step) =>
              html`<li class="flex items-center gap-2.5 rounded-md border border-line px-3 py-2">
                <span
                  class="grid size-5 shrink-0 place-items-center rounded-full ${
                    step.done ? "bg-ok-soft text-ok-fg" : "bg-subtle text-fg-subtle"
                  }"
                  >${icon(step.done ? "check" : "circle-dot", "size-3")}</span
                >
                <span class="min-w-0 flex-1 ${step.done ? "text-fg-muted" : ""}"
                  >${step.title}</span
                >
                ${
                  !step.done && step.href
                    ? html`<a
                        href="${step.href}"
                        class="text-xs font-medium text-accent-fg hover:underline"
                        >${s.fix}</a
                      >`
                    : ""
                }
                <span class="sr-only">${step.done ? s.done : s.open}</span>
              </li>`,
          )}
        </ol>
        ${steps.at(-1)?.done ? "" : html`<p class="mt-3 text-xs text-fg-muted">${s.firstRecipeHint}</p>`}`,
    })}
  </div>`;
}

function lastError(data: DashboardData, ctx: ViewContext): SafeHtml | string {
  const d = ctx.t.dashboard;
  const since = ctx.now.getTime() - WEEK_MS;
  const worker = data.worker?.lastError
    ? { at: data.worker.lastErrorAt, message: data.worker.lastError }
    : null;
  const job = data.lastFailedJob;
  const jobAt = job ? (job.finishedAt ?? job.updatedAt) : null;
  const workerAt = worker?.at ? Date.parse(worker.at) : Number.NaN;
  const jobTime = jobAt ? Date.parse(jobAt) : Number.NaN;
  if (worker && workerAt >= since && (Number.isNaN(jobTime) || workerAt >= jobTime)) {
    return html`<div class="mb-6">
      ${callout({
        tone: "danger",
        title: html`${d.workerError} · ${timeTag(worker.at, ctx)}`,
        body: html`<p class="font-medium">${failureSummary(worker.message, {}, ctx.t)}</p>
          ${failureDetails(worker.message, ctx.t)}`,
      })}
    </div>`;
  }
  if (job && jobTime >= since) {
    return html`<div class="mb-6">
      ${callout({
        tone: "danger",
        title: html`${d.jobError} · ${timeTag(jobAt, ctx)}`,
        body: html`<p class="font-medium">${jobTitle(job)}</p>
          <p class="text-fg-muted">
            ${failureSummary(job.error, { status: job.status, stage: data.stages.get(job.id) ?? null }, ctx.t)}
          </p>
          ${job.error ? failureDetails(job.error, ctx.t) : ""}`,
        actions: linkButton({ href: jobHref(job), label: d.openJob, size: "sm" }),
      })}
    </div>`;
  }
  return "";
}

export function dashboardView(data: DashboardData, ctx: ViewContext): SafeHtml {
  const d = ctx.t.dashboard;
  const paused = data.worker?.running && data.worker.paused;
  return html`${pageHeader({
    title: ctx.t.titles.dashboard,
    subtitle: d.subtitle,
    ...(paused
      ? { meta: statusDot("warn", d.workerPaused) }
      : data.worker && !data.worker.running
        ? { meta: statusDot("danger", d.workerStopped) }
        : {}),
  })}
  ${lastError(data, ctx)} ${healthChips(data, ctx)} ${setupCard(data, ctx)} ${figures(data, ctx)}
  ${card({
    title: d.recentJobs,
    icon: "list-checks",
    flush: true,
    actions: linkButton({
      href: "/admin/jobs",
      label: d.allJobs,
      variant: "ghost",
      size: "sm",
      icon: "arrow-right",
    }),
    body:
      data.jobs.length === 0
        ? emptyState({ icon: "inbox", title: ctx.t.jobs.empty, text: ctx.t.jobs.emptyHint })
        : jobTable(data.jobs, ctx, data.stages),
  })}`;
}
