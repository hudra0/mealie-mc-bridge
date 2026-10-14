// Page bodies of the admin UI. Pure functions from data to SafeHtml; admin.ts wires them to
// routes. Every value from a recipe, a job or an error passes through html``, which
// escapes it. The texts come from the message catalog of UI_LANGUAGE (src/i18n).

import type { AdminMessages, SavedStatus } from "../i18n/index.js";
import type { ScaledIngredient } from "../ingredients/index.js";
import type { CheckedRecipe, CategoryPlan, PreparedRecipe } from "../pipeline/prepare.js";
import type { ConversionResult } from "../pipeline/converter-port.js";
import type { WorkerStatus } from "../pipeline/worker.js";
import type { RecipeStep } from "../recipe/schema.js";
import type { SessionStatus } from "../session/manager.js";
import type { Job, JobEvent, JobStats, JobStatus } from "../store/jobs.js";
import { JOB_STATUSES } from "../store/jobs.js";
import type { SentRecipe } from "../store/mc-recipes.js";
import { escapeHtml, html, safeHref, SafeHtml } from "./html.js";

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// Catalog text with `code` spans, escaped, the spans as <code>.
export function withCode(text: string): SafeHtml {
  return new SafeHtml(escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>"));
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

const SESSION_CLASS: Readonly<Record<SessionStatus["state"], string>> = {
  valid: "ok",
  invalid: "bad",
  expired: "bad",
  unknown: "muted",
};

function sessionBadge(state: SessionStatus["state"], t: AdminMessages): SafeHtml {
  return html`<span class="badge ${SESSION_CLASS[state]}">${t.sessionState[state]}</span>`;
}

function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${token}" />`;
}

function jobTitle(job: Job): string {
  return job.title ?? job.mealieSlug ?? job.mealieRecipeId;
}

function jobsTable(jobs: readonly Job[], t: AdminMessages, status: SavedStatus): SafeHtml {
  const l = t.jobsTable;
  if (jobs.length === 0) return html`<p class="muted">${l.empty}</p>`;
  return html`<div class="scroll">
    <table>
      <thead>
        <tr>
          <th>${l.created}</th>
          <th>${l.recipe}</th>
          <th>${l.scale}</th>
          <th>${l.status}</th>
          <th>${l.attempts}</th>
          <th>${l.result}</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map(
          (job) =>
            html`<tr>
              <td>${formatTime(job.createdAt)}</td>
              <td><a href="/admin/jobs/${encodeURIComponent(job.id)}">${jobTitle(job)}</a></td>
              <td class="num">${job.scale}</td>
              <td>${statusBadge(job.status, t)}</td>
              <td class="num">${job.attempts}</td>
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

export interface DashboardData {
  session: SessionStatus;
  stats: JobStats;
  worker: WorkerStatus | null;
  jobs: Job[];
  formToken: string;
  recipeStatus: SavedStatus;
}

export function dashboardView(data: DashboardData, t: AdminMessages): SafeHtml {
  const { session } = data;
  const d = t.dashboard;
  return html`<h1>${t.titles.dashboard}</h1>
    <section>
      <h2>${d.session}</h2>
      <dl>
        <dt>${d.state}</dt>
        <dd>${sessionBadge(session.state, t)}</dd>
        <dt>${d.lastCheck}</dt>
        <dd>${formatTime(session.checkedAt)}</dd>
        <dt>${d.cookieAge}</dt>
        <dd>${session.cookieAgeHours === null ? d.noCookie : d.hours(session.cookieAgeHours)}</dd>
        <dt>${d.lastError}</dt>
        <dd>${session.lastError ?? "–"}</dd>
        <dt>${d.newRecipes}</dt>
        <dd>${data.recipeStatus === "private-publish" ? d.privatePublish : d.draftOnly}</dd>
      </dl>
      <form class="inline" method="post" action="/admin/session/check">
        ${csrfField(data.formToken)}
        <p><button type="submit">${d.checkNow}</button></p>
      </form>
      <form method="post" action="/admin/session">
        ${csrfField(data.formToken)}
        <p>
          <label for="cookie">${withCode(d.cookieLabel)}</label>
        </p>
        <textarea
          id="cookie"
          name="cookie"
          rows="4"
          autocomplete="off"
          spellcheck="false"
          required
        ></textarea>
        <p><button type="submit">${d.saveSession}</button></p>
      </form>
    </section>
    <section>
      <h2>${d.queue}</h2>
      <p>
        ${d.worker}
        ${
          data.worker === null
            ? d.unknown
            : data.worker.running
              ? data.worker.paused
                ? html`<span class="warn">${d.paused}</span>`
                : html`<span class="ok">${d.running}</span>`
              : html`<span class="bad">${d.stopped}</span>`
        }
      </p>
      ${
        data.worker?.lastError
          ? html`<p>
              ${d.lastWorkerError(formatTime(data.worker.lastErrorAt))}
              <span class="bad">${data.worker.lastError}</span>
            </p>`
          : ""
      }
      <div class="scroll">
        <table>
          <tr>
            ${JOB_STATUSES.map((status) => html`<th>${statusBadge(status, t)}</th>`)}
          </tr>
          <tr>
            ${JOB_STATUSES.map(
              (status) =>
                html`<td class="num">
                  <a href="/admin/jobs?status=${status}">${data.stats[status]}</a>
                </td>`,
            )}
          </tr>
        </table>
      </div>
    </section>
    <section>
      <h2>${d.recentJobs}</h2>
      ${jobsTable(data.jobs, t, data.recipeStatus)}
      <p><a href="/admin/jobs">${t.links.allJobs}</a></p>
    </section>
    <section>
      <h2>${d.dryRun}</h2>
      ${dryRunForm("", 1, t)}
    </section>`;
}

export interface JobListData {
  recipeStatus: SavedStatus;
  jobs: Job[];
  status: JobStatus | null;
  search: string;
  offset: number;
  limit: number;
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
  return html`<h1>${t.titles.jobs}</h1>
    <section>
      <form method="get" action="/admin/jobs">
        <label
          >${l.status}
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
        <label
          >${l.recipe}
          <input type="text" name="q" value="${data.search}" placeholder="${l.searchPlaceholder}"
        /></label>
        <button type="submit">${l.filter}</button>
      </form>
    </section>
    <section>
      ${jobsTable(data.jobs, t, data.recipeStatus)}
      <p>
        ${
          data.offset > 0
            ? html`<a href="${query(Math.max(0, data.offset - data.limit))}">${l.newer}</a>`
            : ""
        }
        ${
          data.jobs.length === data.limit
            ? html`<a href="${query(data.offset + data.limit)}">${l.older}</a>`
            : ""
        }
      </p>
    </section>`;
}

export interface JobDetailData {
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
  const action = (path: string, label: string, extra?: SafeHtml) =>
    html`<form
      class="inline"
      method="post"
      action="/admin/jobs/${encodeURIComponent(job.id)}/${path}"
    >
      ${csrfField(data.formToken)} ${extra ?? ""}
      <button type="submit">${label}</button>
    </form>`;
  return html`<h1>${jobTitle(job)}</h1>
    <section>
      <dl>
        <dt>${l.status}</dt>
        <dd>${statusBadge(job.status, t)}</dd>
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
        <dd>${job.scale}${job.servings === null ? "" : l.servings(job.servings)}</dd>
        <dt>${l.attempts}</dt>
        <dd>${job.attempts}${job.force ? l.forced : ""}</dd>
        <dt>${l.created}</dt>
        <dd>${formatTime(job.createdAt)}</dd>
        <dt>${l.started}</dt>
        <dd>${formatTime(job.startedAt)}</dd>
        <dt>${l.finished}</dt>
        <dd>${formatTime(job.finishedAt)}</dd>
        <dt>${l.model}</dt>
        <dd>${job.provider ? `${job.provider} / ${job.model ?? "?"}` : "–"}</dd>
        <dt>${l.usage}</dt>
        <dd>
          ${
            usage
              ? l.tokens(usage.inputTokens, usage.cachedInputTokens ?? null, usage.outputTokens)
              : "–"
          }
          ${job.costUsd === null ? "" : ` · $${job.costUsd.toFixed(4)}`}
        </dd>
        <dt>${l.ingredientIds}</dt>
        <dd>${ingredientStats(job, t)}</dd>
        ${
          job.ingredients && job.ingredients.unresolvedNames.length > 0
            ? html`<dt>${l.withoutId}</dt>
                <dd>${job.ingredients.unresolvedNames.join(", ")}</dd>`
            : ""
        }
        <dt>${l.error}</dt>
        <dd>${job.error ? html`<span class="bad">${job.error}</span>` : "–"}</dd>
      </dl>
      <p>
        ${
          job.status === "running"
            ? html`<span class="muted">${l.runningLocked}</span>`
            : [
                action("retry", l.retry),
                " ",
                action(
                  "retry",
                  l.forceRebuild,
                  html`<input type="hidden" name="force" value="1" />`,
                ),
                " ",
                cancellable ? action("cancel", l.cancel) : "",
              ]
        }
      </p>
    </section>
    <section>
      <h2>${l.events}</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>${l.time}</th>
              <th>${l.level}</th>
              <th>${l.message}</th>
            </tr>
          </thead>
          <tbody>
            ${data.events.map(
              (event) =>
                html`<tr>
                  <td>${formatTime(event.ts)}</td>
                  <td
                    class="${event.level === "error" ? "bad" : event.level === "warn" ? "warn" : "muted"}"
                  >
                    ${event.level}
                  </td>
                  <td>${event.message}</td>
                </tr>`,
            )}
          </tbody>
        </table>
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

export function dryRunForm(recipe: string, scale: number, t: AdminMessages): SafeHtml {
  const l = t.dryRun;
  return html`<form method="get" action="/admin/dry-run">
    <label
      >${l.recipe}
      <input
        type="text"
        name="recipe"
        value="${recipe}"
        placeholder="${l.recipePlaceholder}"
        required
    /></label>
    <label
      >${l.scale} <input type="number" name="scale" value="${scale}" min="0.1" max="100" step="any"
    /></label>
    <button type="submit">${l.preview}</button>
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
    html`<h1>${t.titles.dryRun}</h1>
      <section>${dryRunForm(data.recipeParam, data.scale, t)}</section>`,
  ];
  if (data.loadError) body.push(html`<section><p class="bad">${data.loadError}</p></section>`);
  const prepared = data.prepared;
  if (prepared) {
    body.push(
      html`<section>
        <h2>${data.title ?? ""}</h2>
        <dl>
          <dt>${l.servings}</dt>
          <dd>${prepared.servings}</dd>
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
        <form method="get" action="/admin/dry-run">
          <input type="hidden" name="recipe" value="${data.recipeParam}" />
          <input type="hidden" name="scale" value="${data.scale}" />
          <input type="hidden" name="convert" value="1" />
          ${csrfField(data.formToken)}
          <p>
            <button type="submit">${l.convert}</button>
            <span class="muted">${l.costsMoney}</span>
          </p>
        </form>
      </section>`,
    );
    body.push(ingredientsSection(prepared.scaled, t));
    body.push(
      html`<section>
        <h2>${l.converterInput}</h2>
        <pre>${prepared.rendered}</pre>
      </section>`,
    );
  }
  if (data.conversionError) {
    body.push(
      html`<section>
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
  return html`<section>
    <h2>${l.ingredients}</h2>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>${l.section}</th>
            <th>${l.amount}</th>
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
                  ${item.quantity ?? ""}${item.quantityMax === null ? "" : `–${item.quantityMax}`}
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
    </div>
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
  return html`<section>
      <h2>${l.conversion}</h2>
      <dl>
        <dt>${l.model}</dt>
        <dd>${result.provider} / ${result.model}, ${l.attempts(result.attempts)}</dd>
        <dt>${l.usage}</dt>
        <dd>
          ${l.tokens(usage.inputTokens, usage.outputTokens)}${
            usage.costUsd === undefined ? "" : ` · $${usage.costUsd.toFixed(4)}`
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
          : html`<table>
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
            </table>`
      }
    </section>
    <section>
      <h2>${l.reviewHints}</h2>
      ${
        checked.reviewHints.length === 0
          ? html`<p class="muted">${l.noHints}</p>`
          : html`<ul>
              ${checked.reviewHints.map((hint) => html`<li>${hint}</li>`)}
            </ul>`
      }
      ${
        result.warnings.length === 0
          ? ""
          : html`<h2>${l.warnings}</h2>
              <ul>
                ${result.warnings.map((warning) => html`<li class="warn">${warning}</li>`)}
              </ul>`
      }
    </section>
    <section>
      <h2>${l.steps}</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
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
    <section>
      <h2>${l.ingredientGroups}</h2>
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
