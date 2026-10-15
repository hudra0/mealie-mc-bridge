// Page bodies of the admin UI. Pure functions from data to SafeHtml; admin.ts wires them to
// routes. Every value from a recipe, a job or an error passes through html``, which
// escapes it. The texts come from the message catalog of UI_LANGUAGE (src/i18n).

import type { AdminMessages, SavedStatus } from "../i18n/index.js";
import type { ScaledIngredient } from "../ingredients/index.js";
import type { CheckedRecipe, CategoryPlan, PreparedRecipe } from "../pipeline/prepare.js";
import { formatServingSize } from "../pipeline/serving-size.js";
import type { ConversionResult } from "../pipeline/converter-port.js";
import type { WorkerStatus } from "../pipeline/worker.js";
import type { RecipeStep } from "../recipe/schema.js";
import type { SessionStatus } from "../session/manager.js";
import type { Job, JobEvent, JobStats, JobStatus } from "../store/jobs.js";
import { JOB_STATUSES } from "../store/jobs.js";
import type { SentRecipe } from "../store/mc-recipes.js";
import { escapeHtml, html, safeHref, SafeHtml } from "./html.js";

// Pages that follow a queued or running job reload after this many seconds.
export const REFRESH_SECONDS = 5;

// Stands in for the webhook token until the admin opens the details element.
export const TOKEN_MASK = "••••••••";

// The zone the admin pages show times in: TZ when it names a zone Intl knows, else the
// zone of the system. The Mealie timeline entries use local time as well.
export function adminTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const zone = env.TZ?.trim();
  if (zone) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      // Not a zone name; fall back to the system zone.
    }
  }
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// The short name of a zone at a date: "CEST", "EDT", "UTC". en-US knows the American
// abbreviations and en-GB the European ones; anything else stays "GMT+2" and the like.
function zoneAbbreviation(date: Date, timeZone: string): string {
  let fallback = "";
  for (const locale of ["en-US", "en-GB"]) {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value;
    if (!name) continue;
    if (!/^GMT[+-]/.test(name)) return name;
    fallback ||= name;
  }
  return fallback;
}

// "2026-10-14 01:29:27 CEST": the time in the admin zone with the zone's short name.
export function formatTime(
  iso: string | null | undefined,
  timeZone: string = adminTimeZone(),
): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const time = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  return `${time} ${zoneAbbreviation(date, timeZone)}`.trim();
}

// "3 minutes ago" in the language of the pages, from seconds up to days.
export function relativeTime(iso: string, now: Date, language: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((then - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

// "45 s", "3 min 05 s", "1 h 02 min": how long a job ran. A running job counts up to now;
// "–" before it started or when a time is unreadable.
export function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
  now: Date,
): string {
  if (!startedAt) return "–";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "–";
  const seconds = Math.round((end - start) / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${pad(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${pad(Math.floor((seconds % 3600) / 60))} min`;
}

export function formatCost(costUsd: number | null | undefined): string {
  return costUsd === null || costUsd === undefined ? "–" : `$${costUsd.toFixed(4)}`;
}

// Catalog text with `code` spans, escaped, the spans as <code>.
export function withCode(text: string): SafeHtml {
  return new SafeHtml(escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>"));
}

// The heading of a page and the paragraph that says what the page is for.
export function pageHead(title: string, lead: string, extra?: SafeHtml): SafeHtml {
  return html`<div class="page-head">
    <h1>${title}</h1>
    <p class="lead">${withCode(lead)}</p>
    ${extra ?? ""}
  </div>`;
}

// What a list shows while it has nothing to show, and what to do about it.
export function emptyState(title: string, hint?: string | SafeHtml): SafeHtml {
  return html`<div class="empty">
    <strong>${title}</strong>
    ${hint === undefined ? "" : typeof hint === "string" ? withCode(hint) : hint}
  </div>`;
}

const STATUS_CLASS: Readonly<Record<JobStatus, string>> = {
  queued: "info",
  running: "info",
  done: "ok",
  skipped: "muted",
  failed: "bad",
  session_expired: "warn",
  cancelled: "muted",
};

export function statusBadge(status: JobStatus, t: AdminMessages): SafeHtml {
  return html`<span class="badge ${STATUS_CLASS[status]}">${t.jobStatus[status]}</span>`;
}

// What each job status means, for the legend under the job list.
export function statusLegend(t: AdminMessages): SafeHtml {
  return html`<dl class="legend">
    ${JOB_STATUSES.map(
      (status) =>
        html`<dt>${statusBadge(status, t)}</dt>
          <dd>${t.jobStatusHelp[status]}</dd>`,
    )}
  </dl>`;
}

export const SESSION_CLASS: Readonly<Record<SessionStatus["state"], string>> = {
  valid: "ok",
  invalid: "bad",
  expired: "bad",
  unknown: "muted",
};

export function sessionBadge(state: SessionStatus["state"], t: AdminMessages): SafeHtml {
  return html`<span class="badge ${SESSION_CLASS[state]}">${t.sessionState[state]}</span>`;
}

export function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${token}" />`;
}

function jobTitle(job: Job): string {
  return job.title ?? job.mealieSlug ?? job.mealieRecipeId;
}

function jobsTable(
  jobs: readonly Job[],
  t: AdminMessages,
  status: SavedStatus,
  now: Date,
): SafeHtml {
  const l = t.jobsTable;
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>${l.created}</th>
          <th>${l.recipe}</th>
          <th class="num">${l.scale}</th>
          <th>${l.status}</th>
          <th class="num">${l.duration}</th>
          <th class="num">${l.cost}</th>
          <th>${l.result}</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map(
          (job) =>
            html`<tr>
              <td class="nowrap">${formatTime(job.createdAt)}</td>
              <td><a href="/admin/jobs/${encodeURIComponent(job.id)}">${jobTitle(job)}</a></td>
              <td class="num">${job.scale}</td>
              <td>${statusBadge(job.status, t)}</td>
              <td class="num">${formatDuration(job.startedAt, job.finishedAt, now)}</td>
              <td class="num">${formatCost(job.costUsd)}</td>
              <td>
                ${
                  job.mcRecipeUrl
                    ? html`<a href="${safeHref(job.mcRecipeUrl)}" rel="noreferrer"
                        >${l.recipeLink(job.mcRecipeId ?? "", status)}</a
                      >`
                    : job.error
                      ? html`<span class="bad">${truncate(job.error, 80)}</span>`
                      : ""
                }
              </td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

// The result of the Mealie check on the overview: reached with the token, failed, or not
// checked (no check configured, or none finished yet).
export interface MealieCheck {
  state: "ok" | "failed" | "unchecked";
  error: string | null;
  checkedAt: string | null;
}

// The two URLs a recipe action can point at, without the token.
export interface WebhookInfo {
  // The bridge's compose service name on the Docker network, the usual setup.
  dockerBase: string;
  // The address this page was opened with; null without a Host header.
  pageBase: string | null;
  token: string;
}

export interface DashboardData {
  session: SessionStatus;
  stats: JobStats;
  worker: WorkerStatus | null;
  jobs: Job[];
  recipeStatus: SavedStatus;
  // For telling whether the login has expired.
  now: Date;
  mealie: { url: string | null; check: MealieCheck };
  // Null when the service runs without the automatic login.
  autoLogin: { configured: boolean; email: string | null } | null;
  webhook: WebhookInfo | null;
  // The newest failed job, for the "last error" card.
  lastFailedJob: Job | null;
}

type StepState = "done" | "open" | "failed" | "unknown";

const STEP_MARK: Readonly<Record<StepState, string>> = {
  done: "✓",
  open: "!",
  failed: "✕",
  unknown: "?",
};

function checklistItem(
  state: StepState,
  title: string,
  body: SafeHtml | string,
  t: AdminMessages,
): SafeHtml {
  const badge = { done: "ok", open: "warn", failed: "bad", unknown: "muted" }[state];
  return html`<li class="${state}">
    <span class="mark" aria-hidden="true">${STEP_MARK[state]}</span>
    <div>
      <div class="step-title">
        ${title} <span class="badge ${badge}">${t.setup.stepState[state]}</span>
      </div>
      ${body}
    </div>
  </li>`;
}

function totalJobs(stats: JobStats): number {
  return JOB_STATUSES.reduce((sum, status) => sum + stats[status], 0);
}

// The URL of the recipe action, masked; the details element reveals it with the token.
export function webhookBlock(webhook: WebhookInfo, t: AdminMessages): SafeHtml {
  const s = t.setup.action;
  return html`<p>
      <code class="url">${webhook.dockerBase}${TOKEN_MASK}</code>
    </p>
    <details>
      <summary>${s.reveal}</summary>
      <p class="small">${s.dockerLabel}</p>
      <p><code class="url">${webhook.dockerBase}${webhook.token}</code></p>
      ${
        webhook.pageBase
          ? html`<p class="small">${s.pageLabel}</p>
              <p><code class="url">${webhook.pageBase}${webhook.token}</code></p>`
          : ""
      }
      <p class="small muted">${s.secret}</p>
    </details>`;
}

function setupChecklist(data: DashboardData, t: AdminMessages): SafeHtml {
  const s = t.setup;
  const { session, mealie } = data;
  const mealieUrl = mealie.url ?? "–";
  const mealieStep =
    mealie.check.state === "ok"
      ? checklistItem("done", s.mealie.title, html`<p>${withCode(s.mealie.ok(mealieUrl))}</p>`, t)
      : mealie.check.state === "failed"
        ? checklistItem(
            "failed",
            s.mealie.title,
            html`<p>${withCode(s.mealie.failed(mealieUrl))}</p>
              <p class="small bad">${mealie.check.error ?? ""}</p>
              <p class="small muted">${withCode(s.mealie.fix)}</p>`,
            t,
          )
        : checklistItem(
            "unknown",
            s.mealie.title,
            html`<p>${withCode(s.mealie.unchecked(mealieUrl))}</p>`,
            t,
          );

  const expired =
    session.cookieExpiresAt !== null && Date.parse(session.cookieExpiresAt) <= data.now.getTime();
  const sessionStep =
    session.state === "valid"
      ? checklistItem(
          "done",
          s.session.title,
          html`<p>
            ${
              session.cookieExpiresAt
                ? s.session.validUntil(formatTime(session.cookieExpiresAt), expired)
                : s.session.valid
            }
          </p>`,
          t,
        )
      : checklistItem(
          session.state === "unknown" ? "unknown" : "failed",
          s.session.title,
          html`<p>${s.session.notValid(t.sessionState[session.state])}</p>
            ${session.lastError ? html`<p class="small bad">${session.lastError}</p>` : ""}
            <p class="small"><a href="/admin/settings#session">${s.session.fix}</a></p>`,
          t,
        );

  const autoLoginStep =
    data.autoLogin === null
      ? checklistItem("unknown", s.autoLogin.title, html`<p>${s.autoLogin.unavailable}</p>`, t)
      : data.autoLogin.configured
        ? checklistItem(
            "done",
            s.autoLogin.title,
            html`<p>${s.autoLogin.configured(data.autoLogin.email ?? "")}</p>`,
            t,
          )
        : checklistItem(
            "open",
            s.autoLogin.title,
            html`<p>${s.autoLogin.notConfigured}</p>
              <p class="small"><a href="/admin/settings#autologin">${s.autoLogin.fix}</a></p>`,
            t,
          );

  const total = totalJobs(data.stats);
  const actionStep = checklistItem(
    total > 0 ? "done" : "open",
    s.action.title,
    html`<p>${total > 0 ? s.action.seen(total) : s.action.notSeen}</p>
      <p class="small">${withCode(s.action.where)}</p>
      ${data.webhook ? webhookBlock(data.webhook, t) : html`<p class="muted">${s.action.noToken}</p>`}
      <p class="small muted">${withCode(s.action.network)}</p>`,
    t,
  );

  const done = data.stats.done;
  const firstJobStep = checklistItem(
    done > 0 ? "done" : "open",
    s.firstJob.title,
    html`<p>${done > 0 ? s.firstJob.done(done) : withCode(s.firstJob.notYet)}</p>`,
    t,
  );

  return html`<section class="card" aria-labelledby="setup">
    <h2 id="setup">${s.title}</h2>
    <p class="lead">${s.lead}</p>
    <ol class="checklist">
      ${mealieStep} ${sessionStep} ${autoLoginStep} ${actionStep} ${firstJobStep}
    </ol>
  </section>`;
}

function lastErrorCard(data: DashboardData, t: AdminMessages): SafeHtml {
  const d = t.dashboard;
  const worker = data.worker?.lastError
    ? { at: data.worker.lastErrorAt, message: data.worker.lastError }
    : null;
  const job = data.lastFailedJob;
  const jobAt = job ? (job.finishedAt ?? job.updatedAt) : null;
  const workerNewer =
    worker !== null && (jobAt === null || Date.parse(worker.at ?? "") >= Date.parse(jobAt));
  let body: SafeHtml;
  if (workerNewer && worker) {
    body = html`<p class="small muted">${d.workerError(formatTime(worker.at))}</p>
      <p class="bad">${worker.message}</p>`;
  } else if (job) {
    body = html`<p class="small muted">${d.jobError(formatTime(jobAt))}</p>
      <p>
        <a href="/admin/jobs/${encodeURIComponent(job.id)}">${jobTitle(job)}</a>
      </p>
      <p class="bad">${truncate(job.error ?? "", 400)}</p>`;
  } else {
    body = emptyState(d.noErrors);
  }
  return html`<section class="card" aria-labelledby="last-error">
    <h2 id="last-error">${d.lastError}</h2>
    ${body}
  </section>`;
}

export function dashboardView(data: DashboardData, t: AdminMessages): SafeHtml {
  const d = t.dashboard;
  return html`${pageHead(t.titles.dashboard, d.lead)} ${setupChecklist(data, t)}
    <div class="grid">
      <section class="card" aria-labelledby="queue">
        <h2 id="queue">${d.queue}</h2>
        <p class="lead small">${d.queueLead}</p>
        <p>
          ${d.worker}
          ${
            data.worker === null
              ? html`<span class="badge muted">${d.unknown}</span>`
              : data.worker.running
                ? data.worker.paused
                  ? html`<span class="badge warn">${d.paused}</span>`
                  : html`<span class="badge ok">${d.running}</span>`
                : html`<span class="badge bad">${d.stopped}</span>`
          }
        </p>
        <div class="stats">
          ${JOB_STATUSES.map(
            (status) =>
              html`<a href="/admin/jobs?status=${status}"
                ><span class="count">${data.stats[status]}</span>${statusBadge(status, t)}</a
              >`,
          )}
        </div>
      </section>
      ${lastErrorCard(data, t)}
    </div>
    <section class="card" aria-labelledby="recent">
      <h2 id="recent">${d.recentJobs}</h2>
      ${
        data.jobs.length === 0
          ? emptyState(t.jobsTable.empty, t.jobsTable.emptyHint)
          : jobsTable(data.jobs, t, data.recipeStatus, data.now)
      }
      <p><a href="/admin/jobs">${t.links.allJobs}</a></p>
    </section>`;
}

export interface JobListData {
  recipeStatus: SavedStatus;
  jobs: Job[];
  status: JobStatus | null;
  search: string;
  offset: number;
  limit: number;
  now: Date;
  // Whether the page reloads on its own (a listed job is queued or running).
  refreshing?: boolean;
}

export function jobListView(data: JobListData, t: AdminMessages): SafeHtml {
  const l = t.jobList;
  const query = (offset: number) => {
    const params = new URLSearchParams();
    if (data.status) params.set("status", data.status);
    if (data.search) params.set("q", data.search);
    params.set("offset", String(offset));
    return `/admin/jobs?${params.toString()}`;
  };
  const filtered = data.status !== null || data.search !== "";
  return html`${pageHead(t.titles.jobs, l.lead)}
    <section class="card no-print" aria-label="${l.filter}">
      <form class="filters" method="get" action="/admin/jobs">
        <label class="field"
          ><span class="label">${l.status}</span>
          <select name="status">
            <option value="">${l.all}</option>
            ${JOB_STATUSES.map(
              (status) =>
                html`<option value="${status}" ${status === data.status ? html`selected` : ""}>
                  ${t.jobStatus[status]}
                </option>`,
            )}
          </select></label
        >
        <label class="field"
          ><span class="label">${l.recipe}</span>
          <input type="text" name="q" value="${data.search}" placeholder="${l.searchPlaceholder}"
        /></label>
        <button type="submit" class="primary">${l.filter}</button>
        ${filtered ? html`<a href="/admin/jobs">${l.reset}</a>` : ""}
      </form>
    </section>
    <section class="card">
      ${data.refreshing ? html`<p class="muted small">${t.autoRefresh}</p>` : ""}
      ${
        data.jobs.length === 0
          ? filtered && data.offset === 0
            ? emptyState(l.noMatch, html`<a href="/admin/jobs">${l.reset}</a>`)
            : data.offset > 0
              ? emptyState(l.noMore)
              : emptyState(t.jobsTable.empty, t.jobsTable.emptyHint)
          : jobsTable(data.jobs, t, data.recipeStatus, data.now)
      }
      <p class="buttons">
        ${
          data.offset > 0
            ? html`<a class="button" href="${query(Math.max(0, data.offset - data.limit))}"
                >${l.newer}</a
              >`
            : ""
        }
        ${
          data.jobs.length === data.limit
            ? html`<a class="button" href="${query(data.offset + data.limit)}">${l.older}</a>`
            : ""
        }
      </p>
      <details>
        <summary>${l.legend}</summary>
        ${statusLegend(t)}
      </details>
    </section>`;
}

export interface JobDetailData {
  // For the relative times of the events.
  now: Date;
  // Whether the page reloads on its own (the job is queued or running).
  refreshing?: boolean;
  recipeStatus: SavedStatus;
  job: Job;
  events: JobEvent[];
  formToken: string;
  mealieUrl: string | null;
}

export function jobDetailView(data: JobDetailData, t: AdminMessages): SafeHtml {
  const { job } = data;
  const l = t.jobDetail;
  const usage = job.usage;
  const cancellable = job.status === "queued" || job.status === "session_expired";
  const action = (path: string, label: string, help: string, extra?: SafeHtml, kind = "") =>
    html`<dt>
        <form method="post" action="/admin/jobs/${encodeURIComponent(job.id)}/${path}">
          ${csrfField(data.formToken)} ${extra ?? ""}
          <button type="submit" class="${kind}">${label}</button>
        </form>
      </dt>
      <dd>${help}</dd>`;
  const links = [
    job.mcRecipeUrl
      ? html`<a class="button primary" href="${safeHref(job.mcRecipeUrl)}" rel="noreferrer"
          >${l.openRecipe(job.mcRecipeId ?? "", data.recipeStatus)}</a
        >`
      : "",
    data.mealieUrl
      ? html`<a class="button" href="${safeHref(data.mealieUrl)}" rel="noreferrer"
          >${l.openInMealie}</a
        >`
      : "",
  ];
  return html`${pageHead(
      jobTitle(job),
      l.lead,
      html`<p class="links">${statusBadge(job.status, t)} ${links}</p>`,
    )}
    ${
      job.error
        ? html`<section class="card" aria-labelledby="error">
            <h2 id="error">${l.error}</h2>
            <p class="bad">${job.error}</p>
          </section>`
        : ""
    }
    ${checkBeforeCooking(job, t)}
    <div class="grid">
      <section class="card" aria-labelledby="facts">
        <h2 id="facts">${l.facts}</h2>
        <dl class="facts">
          <dt>${l.job}</dt>
          <dd><code>${job.id}</code></dd>
          <dt>${l.mealieRecipe}</dt>
          <dd>
            ${
              data.mealieUrl
                ? html`<a href="${safeHref(data.mealieUrl)}" rel="noreferrer"
                    >${job.mealieSlug ?? job.mealieRecipeId}</a
                  >`
                : job.mealieRecipeId
            }
          </dd>
          <dt>${l.monsieurCuisine}</dt>
          <dd>
            ${
              job.mcRecipeUrl
                ? html`<a href="${safeHref(job.mcRecipeUrl)}" rel="noreferrer"
                    >${l.openRecipe(job.mcRecipeId ?? "", data.recipeStatus)}</a
                  >`
                : "–"
            }
          </dd>
          <dt>${l.scale}</dt>
          <dd>
            ${job.scale}${job.servings === null ? "" : l.servingSize(job.servings, job.servingUnit)}
          </dd>
          <dt>${l.attempts}</dt>
          <dd>${job.attempts}${job.force ? l.forced : ""}</dd>
          <dt>${l.created}</dt>
          <dd>${formatTime(job.createdAt)}</dd>
          <dt>${l.started}</dt>
          <dd>${formatTime(job.startedAt)}</dd>
          <dt>${l.finished}</dt>
          <dd>${formatTime(job.finishedAt)}</dd>
          <dt>${l.duration}</dt>
          <dd>${formatDuration(job.startedAt, job.finishedAt, data.now)}</dd>
          <dt>${l.model}</dt>
          <dd>${job.provider ? `${job.provider} / ${job.model ?? "?"}` : "–"}</dd>
          <dt>${l.usage}</dt>
          <dd>
            ${
              usage
                ? l.tokens(usage.inputTokens, usage.cachedInputTokens ?? null, usage.outputTokens)
                : "–"
            }
            ${job.costUsd === null ? "" : ` · ${formatCost(job.costUsd)}`}
          </dd>
          <dt>${l.ingredientIds}</dt>
          <dd>${ingredientStats(job, t)}</dd>
        </dl>
      </section>
      <section class="card no-print" aria-labelledby="actions">
        <h2 id="actions">${l.actions}</h2>
        ${
          job.status === "running"
            ? html`<p class="muted">${l.runningLocked}</p>`
            : html`<dl class="actions">
                ${
                  // A plain retry of a skipped job would only skip again.
                  job.status === "skipped" ? "" : action("retry", l.retry, l.retryHelp)
                }
                ${action(
                  "retry",
                  l.forceRebuild,
                  l.forceRebuildHelp,
                  html`<input type="hidden" name="force" value="1" />`,
                )}
                ${cancellable ? action("cancel", l.cancel, l.cancelHelp, undefined, "danger") : ""}
              </dl>`
        }
      </section>
    </div>
    ${ingredientLists(job, t)}
    <section class="card" aria-labelledby="events">
      <h2 id="events">${l.events}</h2>
      ${data.refreshing ? html`<p class="muted small">${t.autoRefresh}</p>` : ""}
      ${data.events.length === 0 ? emptyState(l.noEvents) : timeline(data.events, data.now, t)}
    </section>`;
}

const LEVEL_CLASS: Readonly<Record<JobEvent["level"], string>> = {
  error: "bad",
  warn: "warn",
  info: "muted",
};

function timeline(events: readonly JobEvent[], now: Date, t: AdminMessages): SafeHtml {
  return html`<ol class="timeline">
    ${events.map((event) => {
      const when = relativeTime(event.ts, now, t.htmlLang);
      return html`<li>
        <span>
          <time datetime="${event.ts}">${when}</time>
          <span class="abs muted">${formatTime(event.ts)}</span>
        </span>
        <span class="${LEVEL_CLASS[event.level] ?? "muted"}">${event.level}</span>
        <span>${event.message}</span>
      </li>`;
    })}
  </ol>`;
}

export function loginView(
  data: { formToken: string; next: string; user: string },
  t: AdminMessages,
): SafeHtml {
  const l = t.login;
  return html`<section class="card login">
    <h1>${l.title}</h1>
    <p class="lead">${l.intro}</p>
    <form method="post" action="/admin/login">
      ${csrfField(data.formToken)}
      <input type="hidden" name="next" value="${data.next}" />
      <label class="field"
        ><span class="label">${l.user}</span>
        <input
          type="text"
          name="user"
          value="${data.user}"
          autocomplete="username"
          autocapitalize="none"
          required
      /></label>
      <label class="field"
        ><span class="label">${l.password}</span>
        <input type="password" name="password" autocomplete="current-password" required
      /></label>
      <button type="submit" class="primary">${l.submit}</button>
    </form>
  </section>`;
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

// The distinct ingredient names of the conversion stored on the job, in recipe order.
export function storedIngredientNames(job: Pick<Job, "conversion">): string[] {
  const result = job.conversion?.result as
    { recipe?: { servingSize?: { ingredientGroups?: unknown } } } | null | undefined;
  const groups = result?.recipe?.servingSize?.ingredientGroups;
  if (!Array.isArray(groups)) return [];
  const names: string[] = [];
  for (const group of groups as Array<{ ingredients?: unknown }>) {
    if (!Array.isArray(group?.ingredients)) continue;
    for (const item of group.ingredients as Array<{ name?: unknown }>) {
      if (typeof item?.name === "string" && item.name.trim() !== "") names.push(item.name.trim());
    }
  }
  return [...new Set(names)];
}

function checkBeforeCooking(job: Job, t: AdminMessages): SafeHtml | string {
  const { hints, warnings } = storedNotes(job);
  const l = t.jobDetail;
  if (hints.length === 0 && warnings.length === 0 && job.status !== "done") return "";
  return html`<section class="callout" aria-labelledby="check">
    <h2 id="check">${l.checkTitle}</h2>
    <p>${l.checkLead}</p>
    ${
      hints.length > 0
        ? html`<h3>${l.reviewHints}</h3>
            <ul>
              ${hints.map((hint) => html`<li>${hint}</li>`)}
            </ul>`
        : html`<p class="small">${l.noHints}</p>`
    }
    ${
      warnings.length > 0
        ? html`<h3>${l.warnings}</h3>
            <ul>
              ${warnings.map((warning) => html`<li class="warn">${warning}</li>`)}
            </ul>`
        : ""
    }
  </section>`;
}

// Which ingredients got a Monsieur Cuisine ingredient id and which went out without one.
function ingredientLists(job: Job, t: AdminMessages): SafeHtml | string {
  const stats = job.ingredients;
  if (!stats) return "";
  const l = t.jobDetail;
  const unresolved = new Set(stats.unresolvedNames);
  const resolved = stats.enabled
    ? storedIngredientNames(job).filter((name) => !unresolved.has(name))
    : [];
  const list = (names: readonly string[], empty: string) =>
    names.length === 0
      ? html`<p class="muted small">${empty}</p>`
      : html`<ul>
          ${names.map((name) => html`<li>${name}</li>`)}
        </ul>`;
  return html`<section class="card" aria-labelledby="ingredients">
    <h2 id="ingredients">${l.ingredients}</h2>
    <p class="lead small">${stats.enabled ? l.ingredientsLead : l.ingredientsOff}</p>
    <div class="two-col">
      <div>
        <h3>${l.resolved(resolved.length)}</h3>
        ${list(resolved, l.noneResolved)}
      </div>
      <div>
        <h3>${l.withoutId(stats.unresolvedNames.length)}</h3>
        ${list(stats.unresolvedNames, l.noneUnresolved)}
      </div>
    </div>
  </section>`;
}

// Where the systemIngredientIds of the draft came from.
function ingredientStats(job: Job, t: AdminMessages): string {
  const stats = job.ingredients;
  if (!stats) return "–";
  if (!stats.enabled) return t.jobDetail.resolutionOff(stats.unresolved);
  return t.jobDetail.resolution(
    stats.catalog,
    stats.catalogRelaxed ?? 0,
    stats.cache,
    stats.search,
    stats.unresolved,
  );
}

// The dry-run form. The form token goes along so "convert right away" works in one step;
// the URL redaction keeps it out of the request log.
export function dryRunForm(
  values: { recipe: string; scale: number; formToken: string },
  t: AdminMessages,
): SafeHtml {
  const { recipe, scale } = values;
  const l = t.dryRun;
  return html`<form method="get" action="/admin/dry-run">
    <label class="field"
      ><span class="label">${l.recipe}</span>
      <input
        type="text"
        name="recipe"
        value="${recipe}"
        placeholder="${l.recipePlaceholder}"
        required
      />
      <span class="help">${withCode(l.recipeHelp)}</span></label
    >
    <label class="field"
      ><span class="label">${l.scale}</span>
      <input type="number" name="scale" value="${scale}" min="0.1" max="100" step="any" />
      <span class="help">${l.scaleHelp}</span></label
    >
    <label class="field check"
      ><input type="checkbox" name="convert" value="1" />
      <span>${l.alsoConvert}<span class="help">${l.alsoConvertHelp}</span></span></label
    >
    ${csrfField(values.formToken)}
    <button type="submit" class="primary">${l.preview}</button>
  </form>`;
}

export interface DryRunData {
  recipeStatus: SavedStatus;
  recipeParam: string;
  scale: number;
  formToken: string;
  title?: string;
  prepared?: PreparedRecipe;
  sent?: SentRecipe | null;
  conversion?: {
    plan: CategoryPlan;
    result: ConversionResult;
    checked: CheckedRecipe;
  };
  conversionError?: string;
  loadError?: string;
}

export function dryRunView(data: DryRunData, t: AdminMessages): SafeHtml {
  const l = t.dryRun;
  const body: SafeHtml[] = [
    html`${pageHead(t.titles.dryRun, l.lead)}
      <section class="card no-print" aria-labelledby="dry-form">
        <h2 id="dry-form">${l.formTitle}</h2>
        ${dryRunForm({ recipe: data.recipeParam, scale: data.scale, formToken: data.formToken }, t)}
      </section>`,
  ];
  if (data.loadError) {
    body.push(html`<section class="card"><p class="bad">${data.loadError}</p></section>`);
  }
  const prepared = data.prepared;
  if (prepared) {
    body.push(
      html`<section class="card" aria-labelledby="dry-recipe">
        <h2 id="dry-recipe">${data.title ?? ""}</h2>
        <dl class="facts">
          <dt>${l.servings}</dt>
          <dd>
            ${formatServingSize(prepared.servingSize)}
            ${
              prepared.servingSize.source === "estimate"
                ? html`<span class="muted">(${l.servingsEstimated})</span>`
                : ""
            }
          </dd>
          <dt>${l.sourceHash}</dt>
          <dd><code>${prepared.hash.slice(0, 16)}</code></dd>
          <dt>${l.alreadySent}</dt>
          <dd>
            ${
              data.sent
                ? html`${l.sentAt(formatTime(data.sent.createdAt))}
                    <a href="${safeHref(data.sent.mcRecipeUrl)}" rel="noreferrer"
                      >${t.jobsTable.recipeLink(data.sent.mcRecipeId, data.recipeStatus)}</a
                    >
                    ${l.wouldSkip}`
                : l.no
            }
          </dd>
        </dl>
        ${
          data.conversion
            ? ""
            : html`<form class="no-print" method="get" action="/admin/dry-run">
                <input type="hidden" name="recipe" value="${data.recipeParam}" />
                <input type="hidden" name="scale" value="${data.scale}" />
                <input type="hidden" name="convert" value="1" />
                ${csrfField(data.formToken)}
                <p class="buttons">
                  <button type="submit" class="primary">${l.convert}</button>
                  <span class="muted small">${l.costsMoney}</span>
                </p>
              </form>`
        }
      </section>`,
    );
    body.push(ingredientsSection(prepared.scaled, t));
    body.push(
      html`<section class="card" aria-labelledby="dry-input">
        <h2 id="dry-input">${l.converterInput}</h2>
        <p class="lead small">${l.converterInputLead}</p>
        <pre>${prepared.rendered}</pre>
      </section>`,
    );
  }
  if (data.conversionError) {
    body.push(
      html`<section class="card">
        <h2>${l.conversion}</h2>
        <p class="bad">${data.conversionError}</p>
      </section>`,
    );
  }
  if (data.conversion) body.push(conversionSection(data.conversion, t));
  return html`${body}`;
}

function ingredientsSection(items: readonly ScaledIngredient[], t: AdminMessages): SafeHtml {
  const l = t.dryRun;
  return html`<section class="card" aria-labelledby="dry-ingredients">
    <h2 id="dry-ingredients">${l.ingredients}</h2>
    <p class="lead small">${l.ingredientsLead}</p>
    ${
      items.length === 0
        ? emptyState(l.noIngredients)
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>${l.section}</th>
                  <th class="num">${l.amount}</th>
                  <th>${l.unit}</th>
                  <th>${l.food}</th>
                  <th>${l.note}</th>
                  <th>${l.source}</th>
                  <th>${l.original}</th>
                </tr>
              </thead>
              <tbody>
                ${items.map(
                  (item) =>
                    html`<tr>
                      <td>${item.section ?? ""}</td>
                      <td class="num">
                        ${item.quantity ?? ""}${
                          item.quantityMax === null ? "" : `–${item.quantityMax}`
                        }
                      </td>
                      <td>${item.unit ?? ""}</td>
                      <td>${item.food}</td>
                      <td>${item.note}${item.optional ? ` ${l.optional}` : ""}</td>
                      <td class="${item.source === "unparsed" ? "warn" : "muted"}">
                        ${item.source}${item.flags.length > 0 ? ` · ${item.flags.join(", ")}` : ""}
                      </td>
                      <td class="muted">${item.original}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
    }
  </section>`;
}

const HIDDEN_STEP_FIELDS = new Set(["kind", "title", "description"]);

export function stepSettings(step: RecipeStep): string {
  const entries = Object.entries(step).filter(([key]) => !HIDDEN_STEP_FIELDS.has(key));
  const parts: string[] = [];
  const record = step as Record<string, unknown>;
  if ("minutes" in step || "seconds" in step) {
    const minutes = typeof record.minutes === "number" ? record.minutes : 0;
    const seconds = typeof record.seconds === "number" ? record.seconds : 0;
    parts.push(`${minutes} min ${seconds} s`);
  }
  for (const [key, value] of entries) {
    if (key === "minutes" || key === "seconds") continue;
    if (key === "temperature") parts.push(`${String(value)} °C`);
    else if (key === "grams") parts.push(`${String(value)} g`);
    else parts.push(`${key} ${String(value)}`);
  }
  return parts.join(", ");
}

function conversionSection(
  conversion: NonNullable<DryRunData["conversion"]>,
  t: AdminMessages,
): SafeHtml {
  const l = t.dryRun;
  const { result, checked, plan } = conversion;
  const names = new Map(plan.catalog.categories.map((category) => [category.id, category.name]));
  const usage = result.usage;
  const recipe = checked.recipe;
  return html`<section class="card" aria-labelledby="dry-conversion">
      <h2 id="dry-conversion">${l.conversion}</h2>
      <p class="lead small">${l.conversionLead}</p>
      <dl class="facts">
        <dt>${l.model}</dt>
        <dd>${result.provider} / ${result.model}, ${l.attempts(result.attempts)}</dd>
        <dt>${l.usage}</dt>
        <dd>
          ${l.tokens(usage.inputTokens, usage.outputTokens)}${
            usage.costUsd === undefined ? "" : ` · ${formatCost(usage.costUsd)}`
          }
        </dd>
        <dt>${l.title}</dt>
        <dd>${recipe.title}</dd>
        <dt>${l.servings}</dt>
        <dd>${recipe.servingSize.amount} ${recipe.servingSize.unit}</dd>
        <dt>${l.times}</dt>
        <dd>${l.timesValue(recipe.servingSize.preparationTime, recipe.servingSize.readyInTime)}</dd>
        <dt>${l.categories}</dt>
        <dd>
          ${checked.categories.ids.map((id) => `${id} ${names.get(id) ?? "?"}`).join(", ") || l.none}
          ${
            checked.categories.dropped.length > 0
              ? html`<span class="warn">
                  ${l.droppedIds(checked.categories.dropped.join(", "))}</span
                >`
              : ""
          }
        </dd>
        <dt>${l.validation}</dt>
        <dd>
          ${
            checked.validation.ok
              ? html`<span class="ok">${l.passed}</span>`
              : html`<span class="bad">${l.errors(checked.validation.errors.length)}</span>`
          }
        </dd>
      </dl>
      ${
        checked.validation.ok
          ? ""
          : html`<div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>${l.field}</th>
                    <th>${l.problem}</th>
                  </tr>
                </thead>
                <tbody>
                  ${checked.validation.errors.map(
                    (issue) =>
                      html`<tr>
                        <td><code>${issue.path}</code></td>
                        <td>${issue.message}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
    </section>
    <section class="callout" aria-labelledby="dry-check">
      <h2 id="dry-check">${t.jobDetail.checkTitle}</h2>
      ${
        checked.reviewHints.length === 0
          ? html`<p class="small">${l.noHints}</p>`
          : html`<h3>${l.reviewHints}</h3>
              <ul>
                ${checked.reviewHints.map((hint) => html`<li>${hint}</li>`)}
              </ul>`
      }
      ${
        result.warnings.length === 0
          ? ""
          : html`<h3>${l.warnings}</h3>
              <ul>
                ${result.warnings.map((warning) => html`<li class="warn">${warning}</li>`)}
              </ul>`
      }
    </section>
    <section class="card" aria-labelledby="dry-steps">
      <h2 id="dry-steps">${l.steps}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="num">#</th>
              <th>${l.kind}</th>
              <th>${l.title}</th>
              <th>${l.settings}</th>
              <th>${l.text}</th>
            </tr>
          </thead>
          <tbody>
            ${recipe.servingSize.steps.map(
              (step, index) =>
                html`<tr>
                  <td class="num">${index + 1}</td>
                  <td>${step.kind}</td>
                  <td>${step.title}</td>
                  <td>${stepSettings(step)}</td>
                  <td>${"description" in step ? step.description : ""}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </section>
    <section class="card" aria-labelledby="dry-groups">
      <h2 id="dry-groups">${l.ingredientGroups}</h2>
      ${recipe.servingSize.ingredientGroups.map(
        (group) =>
          html`<h3>${group.name || "–"}</h3>
            <ul>
              ${group.ingredients.map(
                (item) =>
                  html`<li>
                    ${item.amount} ${item.unit}
                    ${item.name}${item.isOptional ? ` ${l.optional}` : ""}
                  </li>`,
              )}
            </ul>`,
      )}
    </section>`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
