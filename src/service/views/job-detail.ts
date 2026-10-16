// One job: header with picture, status and the links to the editor and to Mealie, an
// actions menu, and four tabs: overview, the converted steps, the ingredients with their
// catalog ids, and the log.

import type { SavedStatus } from "../../i18n/index.js";
import type { Job, JobEvent } from "../../store/jobs.js";
import { html, type SafeHtml } from "../html.js";
import {
  badge,
  button,
  callout,
  card,
  copyField,
  csrfField,
  descriptionList,
  emptyState,
  linkButton,
  linkTabs,
  menu,
  pageHeader,
  statusDot,
  table,
  thumbnail,
} from "../ui/components.js";
import { formatDuration, formatNumber } from "../ui/format.js";
import { recipeSteps, storedRecipe, type ViewRecipe } from "../ui/steps.js";
import {
  dateTag,
  isActive,
  jobHref,
  jobStatus,
  jobTitle,
  money,
  thumbnailSrc,
  timeTag,
  type ViewContext,
} from "./context.js";
import { eventTimeline } from "./events.js";
import { jobActions, jobSubline } from "./jobs.js";

export const JOB_TABS = ["overview", "steps", "ingredients", "events"] as const;
export type JobTab = (typeof JOB_TABS)[number];

export interface JobDetailData {
  job: Job;
  events: JobEvent[];
  mealieUrl: string | null;
  recipeStatus: SavedStatus;
  tab: JobTab;
}

const texts = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];

// The review hints and converter warnings of the conversion stored on the job.
export function storedNotes(job: Pick<Job, "conversion">): { hints: string[]; warnings: string[] } {
  const result = job.conversion?.result;
  if (!result || typeof result !== "object") return { hints: [], warnings: [] };
  const record = result as { reviewHints?: unknown; warnings?: unknown; recipe?: unknown };
  const recipe = record.recipe as { reviewHints?: unknown } | undefined;
  return {
    hints: [...new Set([...texts(record.reviewHints), ...texts(recipe?.reviewHints)])],
    warnings: texts(record.warnings),
  };
}

interface IngredientRow {
  name: string;
  amount: string;
  // True with a catalog id, false without, null when the lookup was off or unknown.
  resolved: boolean | null;
}

function ingredientRows(job: Job, recipe: ViewRecipe | null): IngredientRow[] {
  const stats = job.ingredients;
  const unresolved = new Set(stats?.unresolvedNames ?? []);
  const state = (name: string) => (stats && stats.enabled ? !unresolved.has(name) : null);
  if (recipe) {
    const seen = new Set<string>();
    const rows: IngredientRow[] = [];
    for (const group of recipe.groups) {
      for (const item of group.ingredients) {
        const name = typeof item.name === "string" ? item.name.trim() : "";
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const value = item.amount;
        const amount = [
          typeof value === "number" || typeof value === "string" ? String(value) : "",
          typeof item.unit === "string" ? item.unit : "",
        ]
          .filter((part) => part !== "")
          .join(" ");
        rows.push({ name, amount, resolved: state(name) });
      }
    }
    return rows;
  }
  return [...unresolved].map((name) => ({ name, amount: "", resolved: false }));
}

function checkCallout(job: Job, ctx: ViewContext): SafeHtml | string {
  const { hints, warnings } = storedNotes(job);
  const l = ctx.t.jobDetail;
  if (hints.length === 0 && warnings.length === 0 && job.status !== "done") return "";
  const list = (items: readonly string[]) =>
    html`<ul class="mt-1 list-disc space-y-1 pl-5">
      ${items.map((item) => html`<li>${item}</li>`)}
    </ul>`;
  return callout({
    tone: "warn",
    id: "check",
    title: l.checkTitle,
    body: html`<p class="text-fg-muted">${l.checkLead}</p>
      ${
        hints.length > 0
          ? html`<p class="mt-3 font-medium">${l.reviewHints}</p>
              ${list(hints)}`
          : html`<p class="mt-2 text-fg-muted">${l.noHints}</p>`
      }
      ${
        warnings.length > 0
          ? html`<p class="mt-3 font-medium">${l.warnings}</p>
              ${list(warnings)}`
          : ""
      }`,
  });
}

function resolution(job: Job, ctx: ViewContext): string {
  const stats = job.ingredients;
  const l = ctx.t.jobDetail;
  if (!stats) return "–";
  if (!stats.enabled) return l.resolutionOff(stats.unresolved);
  return l.resolution(
    stats.catalog,
    stats.catalogRelaxed ?? 0,
    stats.cache,
    stats.search,
    stats.unresolved,
  );
}

function overview(data: JobDetailData, ctx: ViewContext): SafeHtml {
  const { job } = data;
  const l = ctx.t.jobDetail;
  const usage = job.usage;
  const intl = ctx.m.intlLocale;
  const jobFacts = card({
    title: l.facts,
    icon: "info",
    body: descriptionList([
      [l.status, jobStatus(job.status, ctx)],
      ...(job.servings === null
        ? []
        : [[l.servings, ctx.t.jobs.servings(job.servings, job.servingUnit)] as const]),
      [l.scale, formatNumber(job.scale, intl, 2)],
      [l.duration, formatDuration(job.startedAt, job.finishedAt, ctx.now)],
      [l.attempts, html`${job.attempts}${job.force ? html` ${badge("neutral", l.forced)}` : ""}`],
      [l.created, dateTag(job.createdAt, ctx)],
      ...(job.finishedAt ? [[l.finished, dateTag(job.finishedAt, ctx)] as const] : []),
      [l.jobId, copyField({ id: "job-id", value: job.id, masked: null, labels: ctx.t.copy })],
    ]),
  });
  const conversionFacts =
    job.provider || job.ingredients
      ? card({
          title: l.conversion,
          icon: "sparkles",
          body: descriptionList([
            ...(job.provider
              ? [
                  [
                    l.model,
                    html`<code class="text-xs">${job.provider} / ${job.model ?? "?"}</code>`,
                  ] as const,
                ]
              : []),
            ...(usage
              ? [
                  [
                    l.tokens,
                    l.tokenCounts(
                      formatNumber(usage.inputTokens, intl),
                      usage.cachedInputTokens ? formatNumber(usage.cachedInputTokens, intl) : null,
                      formatNumber(usage.outputTokens, intl),
                    ),
                  ] as const,
                ]
              : []),
            [
              l.cost,
              html`<span class="tabular-nums">${money(job.costUsd, ctx, { precise: true })}</span>`,
            ],
            ...(job.ingredients ? [[l.ingredientIds, resolution(job, ctx)] as const] : []),
          ]),
        })
      : "";
  const retryable = job.status === "failed" || job.status === "session_expired";
  const error =
    job.error && retryable
      ? callout({
          tone: "danger",
          title: l.error,
          body: job.error,
          actions: html`<form method="post" action="${jobHref(job)}/retry">
            ${csrfField(ctx.csrf)}
            ${button({ label: ctx.t.jobs.retry, icon: "rotate-ccw", size: "sm" })}
          </form>`,
        })
      : "";
  return html`<div class="space-y-4">
    ${error} ${checkCallout(job, ctx)}
    <div class="grid items-start gap-4 xl:grid-cols-2">${jobFacts}${conversionFacts}</div>
  </div>`;
}

function ingredientsTab(job: Job, rows: IngredientRow[], ctx: ViewContext): SafeHtml {
  const l = ctx.t.jobDetail;
  if (rows.length === 0)
    return card({ body: emptyState({ icon: "carrot", text: l.noIngredients }) });
  const withId = rows.filter((row) => row.resolved === true).length;
  const without = rows.filter((row) => row.resolved === false).length;
  return card({
    title: l.ingredientsTitle,
    icon: "carrot",
    subtitle:
      job.ingredients && !job.ingredients.enabled
        ? l.ingredientsOff
        : l.ingredientCounts(withId, without),
    flush: true,
    body: table({
      head: [l.ingredient, l.amount, l.catalogId],
      rows: rows.map(
        (row) =>
          html`<tr>
            <td class="px-4 py-2 [overflow-wrap:anywhere]">${row.name}</td>
            <td class="px-4 py-2 whitespace-nowrap text-fg-muted tabular-nums">${row.amount}</td>
            <td class="px-4 py-2 whitespace-nowrap">
              ${
                row.resolved === null
                  ? html`<span class="text-fg-muted">–</span>`
                  : row.resolved
                    ? statusDot("ok", l.withId)
                    : statusDot("warn", l.withoutId)
              }
            </td>
          </tr>`,
      ),
    }),
    footer: l.ingredientsHint,
  });
}

export function jobDetailView(data: JobDetailData, ctx: ViewContext): SafeHtml {
  const { job } = data;
  const l = ctx.t.jobDetail;
  const recipe = storedRecipe(job.conversion);
  const rows = ingredientRows(job, recipe);
  const actions = jobActions(job, ctx, { open: false });
  const header = pageHeader({
    back: { href: "/admin/jobs", label: ctx.t.titles.jobs },
    media: thumbnail(thumbnailSrc(job.mealieRecipeId), "lg"),
    title: jobTitle(job),
    meta: html`${jobStatus(job.status, ctx)}<span>${jobSubline(job, ctx)}</span
      ><span>${timeTag(job.createdAt, ctx)}</span>`,
    actions: html`${
      job.mcRecipeUrl
        ? linkButton({
            href: job.mcRecipeUrl,
            label: l.openEditor(data.recipeStatus),
            variant: "primary",
            icon: "chef-hat",
            external: true,
          })
        : ""
    }
    ${
      data.mealieUrl
        ? linkButton({ href: data.mealieUrl, label: l.openInMealie, external: true })
        : ""
    }
    ${actions.length > 0 ? menu(ctx.t.jobs.actions, actions) : ""}`,
  });
  const tab = data.tab;
  const tabs = linkTabs(l.tabsLabel, [
    { href: jobHref(job), label: l.tabs.overview, icon: "info", active: tab === "overview" },
    {
      href: jobHref(job, "steps"),
      label: l.tabs.steps,
      icon: "list-ordered",
      count: recipe ? recipe.steps.length : null,
      active: tab === "steps",
    },
    {
      href: jobHref(job, "ingredients"),
      label: l.tabs.ingredients,
      icon: "carrot",
      count: rows.length || null,
      active: tab === "ingredients",
    },
    {
      href: jobHref(job, "events"),
      label: l.tabs.events,
      icon: "activity",
      count: data.events.length,
      active: tab === "events",
    },
  ]);
  let body: SafeHtml;
  if (tab === "steps") {
    body = recipe
      ? recipeSteps(recipe, ctx.t.steps)
      : card({ body: emptyState({ icon: "list-ordered", text: l.noSteps }) });
  } else if (tab === "ingredients") {
    body = ingredientsTab(job, rows, ctx);
  } else if (tab === "events") {
    body = card({
      title: l.tabs.events,
      icon: "activity",
      ...(isActive(job.status) ? { subtitle: ctx.t.autoRefresh } : {}),
      body:
        data.events.length === 0
          ? emptyState({ icon: "activity", text: l.noEvents })
          : eventTimeline(data.events, ctx),
    });
  } else {
    body = overview(data, ctx);
  }
  return html`${header}${tabs}${body}`;
}
