// What every page body needs besides its data: the texts, the clock, the time zone and the
// form token, plus the helpers that turn times, money and job states into markup.

import type { AdminMessages, Messages } from "../../i18n/index.js";
import type { Job, JobStatus } from "../../store/jobs.js";
import { html, type SafeHtml } from "../html.js";
import { statusDot, type Tone } from "../ui/components.js";
import { formatCost, formatDateTime, formatExactTime, relativeTime } from "../ui/format.js";

export interface ViewContext {
  // The full catalog of UI_LANGUAGE; t is its admin part.
  m: Messages;
  t: AdminMessages;
  now: Date;
  timeZone: string;
  // The form token for the session of the request.
  csrf: string;
}

// "vor 3 Minuten", with the exact time as tooltip; the client script keeps it current.
export function timeTag(iso: string | null | undefined, ctx: ViewContext): SafeHtml | string {
  if (!iso) return "–";
  return html`<time
    datetime="${iso}"
    title="${formatExactTime(iso, ctx.m.intlLocale, ctx.timeZone)}"
    data-relative
    >${relativeTime(iso, ctx.now, ctx.t.htmlLang)}</time
  >`;
}

// "16. Okt. 2026, 12:45" with the exact time as tooltip.
export function dateTag(iso: string | null | undefined, ctx: ViewContext): SafeHtml | string {
  if (!iso) return "–";
  return html`<time
    datetime="${iso}"
    title="${formatExactTime(iso, ctx.m.intlLocale, ctx.timeZone)}"
    >${formatDateTime(iso, ctx.m.intlLocale, ctx.timeZone)}</time
  >`;
}

export function money(
  costUsd: number | null | undefined,
  ctx: ViewContext,
  options: { precise?: boolean } = {},
): string {
  return formatCost(costUsd, ctx.m.intlLocale, options);
}

export const STATUS_TONE: Readonly<Record<JobStatus, Tone>> = {
  queued: "info",
  running: "info",
  done: "ok",
  skipped: "neutral",
  failed: "danger",
  session_expired: "warn",
  cancelled: "neutral",
};

export function jobStatus(status: JobStatus, ctx: ViewContext): SafeHtml {
  return statusDot(STATUS_TONE[status], ctx.t.jobStatus[status], {
    pulse: status === "running",
  });
}

export function jobTitle(job: Job): string {
  return job.title ?? job.mealieSlug ?? job.mealieRecipeId;
}

export function jobHref(job: Pick<Job, "id">, tab?: string): string {
  return `/admin/jobs/${encodeURIComponent(job.id)}${tab ? `?tab=${tab}` : ""}`;
}

// The proxied Mealie image of a recipe.
export function thumbnailSrc(recipeId: string): string {
  return `/admin/recipes/${encodeURIComponent(recipeId)}/thumbnail`;
}

export function isActive(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}
