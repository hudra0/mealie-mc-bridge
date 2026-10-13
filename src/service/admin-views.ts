// Page bodies of the admin UI. Pure functions from data to SafeHtml; admin.ts wires them to
// routes. Every value from a recipe, a job or an error passes through html``, which
// escapes it.

import type { ScaledIngredient } from "../ingredients/index.js";
import type { CheckedRecipe, CategoryPlan, PreparedRecipe } from "../pipeline/prepare.js";
import type { ConversionResult } from "../pipeline/converter-port.js";
import type { WorkerStatus } from "../pipeline/worker.js";
import type { RecipeStep } from "../recipe/schema.js";
import type { SessionStatus } from "../session/manager.js";
import type { Job, JobEvent, JobStats, JobStatus } from "../store/jobs.js";
import { JOB_STATUSES } from "../store/jobs.js";
import type { SentRecipe } from "../store/mc-recipes.js";
import { html, safeHref, type SafeHtml } from "./html.js";

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
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

export function statusBadge(status: JobStatus): SafeHtml {
  return html`<span class="badge ${STATUS_CLASS[status]}">${status.replace("_", " ")}</span>`;
}

const SESSION_CLASS: Readonly<Record<SessionStatus["state"], string>> = {
  valid: "ok",
  invalid: "bad",
  expired: "bad",
  unknown: "muted",
};

function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${token}" />`;
}

function jobTitle(job: Job): string {
  return job.title ?? job.mealieSlug ?? job.mealieRecipeId;
}

function jobsTable(jobs: readonly Job[]): SafeHtml {
  if (jobs.length === 0) return html`<p class="muted">No jobs yet.</p>`;
  return html`<div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Created</th>
          <th>Recipe</th>
          <th>Scale</th>
          <th>Status</th>
          <th>Attempts</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map(
          (job) =>
            html`<tr>
              <td>${formatTime(job.createdAt)}</td>
              <td><a href="/admin/jobs/${encodeURIComponent(job.id)}">${jobTitle(job)}</a></td>
              <td class="num">${job.scale}</td>
              <td>${statusBadge(job.status)}</td>
              <td class="num">${job.attempts}</td>
              <td>
                ${
                  job.mcRecipeUrl
                    ? html`<a href="${safeHref(job.mcRecipeUrl)}" rel="noreferrer"
                        >draft ${job.mcRecipeId}</a
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
  recipeStatus: string;
}

export function dashboardView(data: DashboardData): SafeHtml {
  const { session } = data;
  return html`<h1>Dashboard</h1>
    <section>
      <h2>Monsieur Cuisine session</h2>
      <dl>
        <dt>State</dt>
        <dd><span class="badge ${SESSION_CLASS[session.state]}">${session.state}</span></dd>
        <dt>Last check</dt>
        <dd>${formatTime(session.checkedAt)}</dd>
        <dt>Cookie age</dt>
        <dd>${session.cookieAgeHours === null ? "no cookie" : `${session.cookieAgeHours} h`}</dd>
        <dt>Last error</dt>
        <dd>${session.lastError ?? "–"}</dd>
        <dt>New recipes</dt>
        <dd>
          ${data.recipeStatus === "private-publish" ? "saved on the device only" : "kept as drafts"}
        </dd>
      </dl>
      <form class="inline" method="post" action="/admin/session/check">
        ${csrfField(data.formToken)}
        <p><button type="submit">Check now</button></p>
      </form>
      <form method="post" action="/admin/session">
        ${csrfField(data.formToken)}
        <p>
          <label for="cookie"
            >Paste the <code>Cookie</code> request header of a logged-in www.monsieur-cuisine.com
            tab (DevTools, Network, any <code>proxy-api</code> request). It is checked against your
            account before it is stored, encrypted.</label
          >
        </p>
        <textarea
          id="cookie"
          name="cookie"
          rows="4"
          autocomplete="off"
          spellcheck="false"
          required
        ></textarea>
        <p><button type="submit">Save session</button></p>
      </form>
    </section>
    <section>
      <h2>Queue</h2>
      <p>
        Worker:
        ${
          data.worker === null
            ? "unknown"
            : data.worker.running
              ? data.worker.paused
                ? html`<span class="warn">paused until the session works</span>`
                : html`<span class="ok">running</span>`
              : html`<span class="bad">stopped</span>`
        }
      </p>
      ${
        data.worker?.lastError
          ? html`<p>
              Last worker error (${formatTime(data.worker.lastErrorAt)}):
              <span class="bad">${data.worker.lastError}</span>
            </p>`
          : ""
      }
      <div class="scroll">
        <table>
          <tr>
            ${JOB_STATUSES.map((status) => html`<th>${statusBadge(status)}</th>`)}
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
      <h2>Recent jobs</h2>
      ${jobsTable(data.jobs)}
      <p><a href="/admin/jobs">All jobs</a></p>
    </section>
    <section>
      <h2>Dry run</h2>
      ${dryRunForm("", 1)}
    </section>`;
}

export interface JobListData {
  jobs: Job[];
  status: JobStatus | null;
  search: string;
  offset: number;
  limit: number;
}

export function jobListView(data: JobListData): SafeHtml {
  const query = (offset: number) => {
    const params = new URLSearchParams();
    if (data.status) params.set("status", data.status);
    if (data.search) params.set("q", data.search);
    params.set("offset", String(offset));
    return `/admin/jobs?${params.toString()}`;
  };
  return html`<h1>Jobs</h1>
    <section>
      <form method="get" action="/admin/jobs">
        <label
          >Status
          <select name="status">
            <option value="">all</option>
            ${JOB_STATUSES.map(
              (status) =>
                html`<option value="${status}" ${status === data.status ? html`selected` : ""}>
                  ${status}
                </option>`,
            )}
          </select></label
        >
        <label
          >Recipe
          <input type="text" name="q" value="${data.search}" placeholder="title, slug or id"
        /></label>
        <button type="submit">Filter</button>
      </form>
    </section>
    <section>
      ${jobsTable(data.jobs)}
      <p>
        ${
          data.offset > 0
            ? html`<a href="${query(Math.max(0, data.offset - data.limit))}">Newer</a>`
            : ""
        }
        ${
          data.jobs.length === data.limit
            ? html`<a href="${query(data.offset + data.limit)}">Older</a>`
            : ""
        }
      </p>
    </section>`;
}

export interface JobDetailData {
  job: Job;
  events: JobEvent[];
  formToken: string;
  mealieUrl: string | null;
}

export function jobDetailView(data: JobDetailData): SafeHtml {
  const { job } = data;
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
        <dt>Status</dt>
        <dd>${statusBadge(job.status)}</dd>
        <dt>Job</dt>
        <dd><code>${job.id}</code></dd>
        <dt>Mealie recipe</dt>
        <dd>
          ${
            data.mealieUrl
              ? html`<a href="${safeHref(data.mealieUrl)}" rel="noreferrer"
                  >${job.mealieSlug ?? job.mealieRecipeId}</a
                >`
              : job.mealieRecipeId
          }
        </dd>
        <dt>Monsieur Cuisine</dt>
        <dd>
          ${
            job.mcRecipeUrl
              ? html`<a href="${safeHref(job.mcRecipeUrl)}" rel="noreferrer"
                  >open draft ${job.mcRecipeId} in the editor</a
                >`
              : "–"
          }
        </dd>
        <dt>Scale</dt>
        <dd>${job.scale}${job.servings === null ? "" : ` (${job.servings} servings)`}</dd>
        <dt>Attempts</dt>
        <dd>${job.attempts}${job.force ? " · forced" : ""}</dd>
        <dt>Created</dt>
        <dd>${formatTime(job.createdAt)}</dd>
        <dt>Started</dt>
        <dd>${formatTime(job.startedAt)}</dd>
        <dt>Finished</dt>
        <dd>${formatTime(job.finishedAt)}</dd>
        <dt>Model</dt>
        <dd>${job.provider ? `${job.provider} / ${job.model ?? "?"}` : "–"}</dd>
        <dt>Usage</dt>
        <dd>
          ${
            usage
              ? `${usage.inputTokens} input${usage.cachedInputTokens ? ` (${usage.cachedInputTokens} cached)` : ""}, ${usage.outputTokens} output tokens`
              : "–"
          }
          ${job.costUsd === null ? "" : ` · $${job.costUsd.toFixed(4)}`}
        </dd>
        <dt>Error</dt>
        <dd>${job.error ? html`<span class="bad">${job.error}</span>` : "–"}</dd>
      </dl>
      <p>
        ${
          job.status === "running"
            ? html`<span class="muted">Running jobs cannot be changed.</span>`
            : [
                action("retry", "Retry"),
                " ",
                action(
                  "retry",
                  "Force rebuild",
                  html`<input type="hidden" name="force" value="1" />`,
                ),
                " ",
                cancellable ? action("cancel", "Cancel") : "",
              ]
        }
      </p>
    </section>
    <section>
      <h2>Events</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Level</th>
              <th>Message</th>
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

export function dryRunForm(recipe: string, scale: number): SafeHtml {
  return html`<form method="get" action="/admin/dry-run">
    <label
      >Recipe <input type="text" name="recipe" value="${recipe}" placeholder="id or slug" required
    /></label>
    <label
      >Scale <input type="number" name="scale" value="${scale}" min="0.1" max="100" step="any"
    /></label>
    <button type="submit">Preview</button>
  </form>`;
}

export interface DryRunData {
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

export function dryRunView(data: DryRunData): SafeHtml {
  const body: SafeHtml[] = [
    html`<h1>Dry run</h1>
      <section>${dryRunForm(data.recipeParam, data.scale)}</section>`,
  ];
  if (data.loadError) body.push(html`<section><p class="bad">${data.loadError}</p></section>`);
  const prepared = data.prepared;
  if (prepared) {
    body.push(
      html`<section>
        <h2>${data.title ?? ""}</h2>
        <dl>
          <dt>Servings</dt>
          <dd>${prepared.servings}</dd>
          <dt>Source hash</dt>
          <dd><code>${prepared.hash.slice(0, 16)}</code></dd>
          <dt>Already sent</dt>
          <dd>
            ${
              data.sent
                ? html`yes, ${formatTime(data.sent.createdAt)}:
                    <a href="${safeHref(data.sent.mcRecipeUrl)}" rel="noreferrer"
                      >draft ${data.sent.mcRecipeId}</a
                    >
                    (a job would be skipped unless forced)`
                : "no"
            }
          </dd>
        </dl>
        <form method="get" action="/admin/dry-run">
          <input type="hidden" name="recipe" value="${data.recipeParam}" />
          <input type="hidden" name="scale" value="${data.scale}" />
          <input type="hidden" name="convert" value="1" />
          ${csrfField(data.formToken)}
          <p>
            <button type="submit">Convert without uploading</button>
            <span class="muted">Calls the language model; this costs money.</span>
          </p>
        </form>
      </section>`,
    );
    body.push(ingredientsSection(prepared.scaled));
    body.push(
      html`<section>
        <h2>Converter input (Markdown)</h2>
        <pre>${prepared.rendered}</pre>
      </section>`,
    );
  }
  if (data.conversionError) {
    body.push(
      html`<section>
        <h2>Conversion</h2>
        <p class="bad">${data.conversionError}</p>
      </section>`,
    );
  }
  if (data.conversion) body.push(conversionSection(data.conversion));
  return html`${body}`;
}

function ingredientsSection(items: readonly ScaledIngredient[]): SafeHtml {
  return html`<section>
    <h2>Ingredients</h2>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Section</th>
            <th>Amount</th>
            <th>Unit</th>
            <th>Food</th>
            <th>Note</th>
            <th>Source</th>
            <th>Original</th>
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
                <td>${item.note}${item.optional ? " (optional)" : ""}</td>
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

function conversionSection(conversion: NonNullable<DryRunData["conversion"]>): SafeHtml {
  const { result, checked, plan } = conversion;
  const names = new Map(plan.catalog.categories.map((category) => [category.id, category.name]));
  const usage = result.usage;
  const recipe = checked.recipe;
  return html`<section>
      <h2>Conversion</h2>
      <dl>
        <dt>Model</dt>
        <dd>${result.provider} / ${result.model}, ${result.attempts} attempt(s)</dd>
        <dt>Usage</dt>
        <dd>
          ${usage.inputTokens} input, ${usage.outputTokens} output
          tokens${usage.costUsd === undefined ? "" : ` · $${usage.costUsd.toFixed(4)}`}
        </dd>
        <dt>Title</dt>
        <dd>${recipe.title}</dd>
        <dt>Servings</dt>
        <dd>${recipe.servingSize.amount} ${recipe.servingSize.unit}</dd>
        <dt>Times</dt>
        <dd>
          ${recipe.servingSize.preparationTime} min preparation, ${recipe.servingSize.readyInTime}
          min until ready
        </dd>
        <dt>Categories</dt>
        <dd>
          ${checked.categories.ids.map((id) => `${id} ${names.get(id) ?? "?"}`).join(", ") || "none"}
          ${
            checked.categories.dropped.length > 0
              ? html`<span class="warn">
                  · dropped unknown ids ${checked.categories.dropped.join(", ")}</span
                >`
              : ""
          }
        </dd>
        <dt>Validation</dt>
        <dd>
          ${
            checked.validation.ok
              ? html`<span class="ok">passed</span>`
              : html`<span class="bad">${checked.validation.errors.length} error(s)</span>`
          }
        </dd>
      </dl>
      ${
        checked.validation.ok
          ? ""
          : html`<table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Problem</th>
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
      <h2>Review hints</h2>
      ${
        checked.reviewHints.length === 0
          ? html`<p class="muted">None.</p>`
          : html`<ul>
              ${checked.reviewHints.map((hint) => html`<li>${hint}</li>`)}
            </ul>`
      }
      ${
        result.warnings.length === 0
          ? ""
          : html`<h2>Converter warnings</h2>
              <ul>
                ${result.warnings.map((warning) => html`<li class="warn">${warning}</li>`)}
              </ul>`
      }
    </section>
    <section>
      <h2>Steps</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Kind</th>
              <th>Title</th>
              <th>Settings</th>
              <th>Text</th>
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
      <h2>Ingredient groups</h2>
      ${recipe.servingSize.ingredientGroups.map(
        (group) =>
          html`<h3>${group.name || "–"}</h3>
            <ul>
              ${group.ingredients.map(
                (item) =>
                  html`<li>
                    ${item.amount} ${item.unit} ${item.name}${item.isOptional ? " (optional)" : ""}
                  </li>`,
              )}
            </ul>`,
      )}
    </section>`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
