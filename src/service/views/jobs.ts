// The job list and the job table the overview shares: thumbnail, title with scale and
// servings, status, age, duration, cost and a menu with the actions of the job.

import type { SavedStatus } from "../../i18n/index.js";
import type { Job, JobStats, JobStatus } from "../../store/jobs.js";
import { html, type SafeHtml } from "../html.js";
import {
  card,
  emptyState,
  icon,
  INPUT_CLASS,
  linkButton,
  menu,
  menuForm,
  menuLink,
  pageHeader,
  segmented,
  thumbnail,
} from "../ui/components.js";
import { formatDuration, formatNumber } from "../ui/format.js";
import {
  jobHref,
  jobStatus,
  jobTitle,
  money,
  thumbnailSrc,
  timeTag,
  type ViewContext,
} from "./context.js";

// The filter groups of the list. "active" is every job that has not finished.
export const JOB_FILTERS = ["all", "active", "done", "skipped", "failed", "cancelled"] as const;
export type JobFilter = (typeof JOB_FILTERS)[number];

export const FILTER_STATUSES: Readonly<Record<JobFilter, readonly JobStatus[] | null>> = {
  all: null,
  active: ["queued", "running", "session_expired"],
  done: ["done"],
  skipped: ["skipped"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

export function filterCount(filter: JobFilter, stats: JobStats): number {
  const statuses = FILTER_STATUSES[filter] ?? (Object.keys(stats) as JobStatus[]);
  return statuses.reduce((sum, status) => sum + stats[status], 0);
}

// "Faktor 2 · 8 Portionen".
export function jobSubline(job: Job, ctx: ViewContext): string {
  const parts = [ctx.t.jobs.scale(formatNumber(job.scale, ctx.m.intlLocale, 2))];
  if (job.servings !== null) parts.push(ctx.t.jobs.servings(job.servings, job.servingUnit));
  return parts.join(" · ");
}

// The actions a job allows, as menu entries. A running job allows none; a skipped one only
// the forced rebuild, since a plain retry would skip again.
export function jobActions(job: Job, ctx: ViewContext, options: { open: boolean }): SafeHtml[] {
  const l = ctx.t.jobs;
  const base = jobHref(job);
  const items: SafeHtml[] = [];
  if (options.open) items.push(menuLink({ href: base, label: l.open, icon: "arrow-right" }));
  if (options.open && job.mcRecipeUrl) {
    items.push(
      menuLink({
        href: job.mcRecipeUrl,
        label: l.openEditor,
        icon: "external-link",
        external: true,
      }),
    );
  }
  if (job.status === "running") return items;
  if (job.status !== "skipped") {
    items.push(
      menuForm({ action: `${base}/retry`, csrf: ctx.csrf, label: l.retry, icon: "rotate-ccw" }),
    );
  }
  items.push(
    menuForm({
      action: `${base}/retry`,
      csrf: ctx.csrf,
      label: l.forceRebuild,
      icon: "refresh-cw",
      fields: { force: "1" },
      confirm: {
        title: l.forceRebuild,
        message: l.forceConfirm,
        ok: l.forceRebuild,
        tone: "primary",
      },
    }),
  );
  if (job.status === "queued" || job.status === "session_expired") {
    items.push(
      menuForm({
        action: `${base}/cancel`,
        csrf: ctx.csrf,
        label: l.cancel,
        icon: "ban",
        danger: true,
        confirm: { title: l.cancel, message: l.cancelConfirm, ok: l.cancel },
      }),
    );
  }
  return items;
}

export function jobTable(jobs: readonly Job[], ctx: ViewContext): SafeHtml {
  const l = ctx.t.jobs;
  const now = ctx.now;
  return html`<table class="stack-table w-full text-left text-sm">
    <thead class="bg-subtle text-xs text-fg-muted">
      <tr>
        <th scope="col" class="py-2 pr-2 pl-4 font-medium">
          <span class="sr-only">${l.image}</span>
        </th>
        <th scope="col" class="px-2 py-2 font-medium">${l.recipe}</th>
        <th scope="col" class="px-2 py-2 font-medium">${l.status}</th>
        <th scope="col" class="px-2 py-2 font-medium">${l.created}</th>
        <th scope="col" class="px-2 py-2 text-right font-medium">${l.duration}</th>
        <th scope="col" class="px-2 py-2 text-right font-medium">${l.cost}</th>
        <th scope="col" class="py-2 pr-4 pl-2"><span class="sr-only">${l.actions}</span></th>
      </tr>
    </thead>
    <tbody class="divide-y divide-line">
      ${jobs.map((job) => {
        const actions = jobActions(job, ctx, { open: true });
        return html`<tr class="transition-colors hover:bg-subtle/60">
          <td class="align-middle md:py-2.5 md:pr-2 md:pl-4">
            ${thumbnail(thumbnailSrc(job.mealieRecipeId))}
          </td>
          <td class="w-full max-w-0 align-middle max-md:max-w-none md:px-2 md:py-2.5">
            <a
              href="${jobHref(job)}"
              class="block truncate font-medium hover:text-accent-fg hover:underline max-md:whitespace-normal"
              >${jobTitle(job)}</a
            >
            <p class="truncate text-xs text-fg-muted">${jobSubline(job, ctx)}</p>
            <p
              class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted md:hidden"
            >
              ${jobStatus(job.status, ctx)}<span>${timeTag(job.createdAt, ctx)}</span>${job.costUsd === null ? "" : html`<span class="tabular-nums">${money(job.costUsd, ctx)}</span>`}
            </p>
          </td>
          <td class="px-2 py-2.5 align-middle whitespace-nowrap max-md:hidden">
            ${jobStatus(job.status, ctx)}
          </td>
          <td class="px-2 py-2.5 align-middle whitespace-nowrap text-fg-muted max-md:hidden">
            ${timeTag(job.createdAt, ctx)}
          </td>
          <td
            class="px-2 py-2.5 text-right align-middle whitespace-nowrap text-fg-muted tabular-nums max-md:hidden"
          >
            ${formatDuration(job.startedAt, job.finishedAt, now)}
          </td>
          <td
            class="px-2 py-2.5 text-right align-middle whitespace-nowrap text-fg-muted tabular-nums max-md:hidden"
          >
            ${money(job.costUsd, ctx)}
          </td>
          <td class="text-right align-middle md:py-2.5 md:pr-4 md:pl-2">
            ${menu(l.actions, actions)}
          </td>
        </tr>`;
      })}
    </tbody>
  </table>`;
}

export interface JobListData {
  jobs: Job[];
  stats: JobStats;
  filter: JobFilter;
  // A single status from an old link, shown instead of a filter group.
  status: JobStatus | null;
  search: string;
  offset: number;
  limit: number;
  recipeStatus: SavedStatus;
}

export function jobListView(data: JobListData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.jobs;
  const url = (changes: { filter?: JobFilter; offset?: number }) => {
    const params = new URLSearchParams();
    const filter = changes.filter ?? (data.status ? null : data.filter);
    if (filter && filter !== "all") params.set("status", filter);
    else if (!changes.filter && data.status) params.set("status", data.status);
    if (data.search) params.set("q", data.search);
    if (changes.offset) params.set("offset", String(changes.offset));
    const query = params.toString();
    return `/admin/jobs${query ? `?${query}` : ""}`;
  };
  const filtered = data.filter !== "all" || data.status !== null || data.search !== "";
  const toolbar = html`<div
    class="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
  >
    ${segmented(
      l.filterLabel,
      JOB_FILTERS.map((filter) => ({
        href: url({ filter }),
        label: l.filters[filter],
        count: filterCount(filter, data.stats),
        active: data.status === null && filter === data.filter,
      })),
    )}
    <form method="get" action="/admin/jobs" role="search" class="relative w-full lg:w-72">
      ${
        data.status
          ? html`<input type="hidden" name="status" value="${data.status}" />`
          : data.filter !== "all"
            ? html`<input type="hidden" name="status" value="${data.filter}" />`
            : ""
      }
      <label for="job-search" class="sr-only">${l.search}</label>
      <span
        class="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-fg-subtle"
        >${icon("search")}</span
      >
      <input
        id="job-search"
        type="search"
        name="q"
        value="${data.search}"
        placeholder="${l.searchPlaceholder}"
        class="${INPUT_CLASS} pl-9"
      />
    </form>
  </div>`;

  let body: SafeHtml;
  if (data.jobs.length > 0) {
    body = jobTable(data.jobs, ctx);
  } else if (data.offset > 0) {
    body = emptyState({ icon: "inbox", text: l.noMore });
  } else if (filtered) {
    body = emptyState({
      icon: "search",
      text: l.noMatch,
      action: linkButton({ href: "/admin/jobs", label: l.reset, size: "sm" }),
    });
  } else {
    body = emptyState({ icon: "inbox", title: l.empty, text: l.emptyHint });
  }
  const from = data.offset + 1;
  const to = data.offset + data.jobs.length;
  const pager =
    data.offset > 0 || data.jobs.length === data.limit
      ? html`<div class="flex items-center justify-between gap-3">
          <span class="tabular-nums">${data.jobs.length > 0 ? l.range(from, to) : ""}</span>
          <div class="flex gap-2">
            ${
              data.offset > 0
                ? linkButton({
                    href: url({ offset: Math.max(0, data.offset - data.limit) }),
                    label: l.newer,
                    icon: "chevron-left",
                    size: "sm",
                  })
                : ""
            }
            ${
              data.jobs.length === data.limit
                ? linkButton({
                    href: url({ offset: data.offset + data.limit }),
                    label: l.older,
                    icon: "chevron-right",
                    size: "sm",
                  })
                : ""
            }
          </div>
        </div>`
      : undefined;
  return html`${pageHeader({ title: ctx.t.titles.jobs, subtitle: l.subtitle })} ${toolbar}
  ${card({ body, flush: true, ...(pager ? { footer: pager } : {}) })}`;
}
