// Job queue and job history in bridge.db.
//
// A job is one click on the recipe action. Its status follows the state machine in
// docs/ARCHITECTURE.md: queued -> running -> done | skipped | failed | session_expired,
// with cancelled for jobs an admin stops before they run. Every stage of a run appends an
// event, which the admin page shows as the job's log.

import { randomUUID } from "node:crypto";
import { jobEventMessage } from "../i18n/index.js";
import type { Db } from "./db.js";
import {
  isJobEventCode,
  storedParams,
  type JobEventCode,
  type JobEventInput,
} from "./job-events.js";
import { JOB_STATUSES } from "./migrations.js";

export type JobStatus = (typeof JOB_STATUSES)[number];
export { JOB_STATUSES };

// Waiting for or holding the worker. A recipe has at most one such job per scale.
export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "running", "session_expired"];
export const FINAL_STATUSES: readonly JobStatus[] = ["done", "skipped", "failed", "cancelled"];

export type EventLevel = "info" | "warn" | "error";

export interface JobUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

// A converted recipe that passed validation, kept so a retry does not pay for the
// conversion again. Valid only while the recipe's source hash is unchanged.
export interface StoredConversion {
  sourceHash: string;
  // The converter's result (ConversionResult in src/pipeline/converter-port.ts).
  result: unknown;
}

// How the ingredient names of the converted recipe got their systemIngredientId, counted
// per distinct name. unresolvedNames go out without an id.
export interface JobIngredientStats {
  // Catalog hits, the relaxed ones included.
  catalog: number;
  // Catalog hits found under a relaxed form of the name; absent on older jobs.
  catalogRelaxed?: number;
  cache: number;
  search: number;
  unresolved: number;
  unresolvedNames: string[];
  // False when MC_RESOLVE_INGREDIENTS=off.
  enabled: boolean;
}

export interface Job {
  id: string;
  mealieRecipeId: string;
  mealieSlug: string | null;
  title: string | null;
  scale: number;
  servings: number | null;
  // The unit of the serving size ("Portionen", "Scheiben"); null on jobs from before it was stored.
  servingUnit: string | null;
  status: JobStatus;
  attempts: number;
  error: string | null;
  mcRecipeId: number | null;
  mcRecipeUrl: string | null;
  provider: string | null;
  model: string | null;
  usage: JobUsage | null;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  force: boolean;
  conversion: StoredConversion | null;
  // Set right before the draft creation request goes out. A job interrupted after this
  // point may have left a draft behind and is never run again on its own.
  createStartedAt: string | null;
  ingredients: JobIngredientStats | null;
}

export interface JobEvent {
  id: number;
  jobId: string;
  ts: string;
  level: EventLevel;
  // English; the only text of rows written before event codes existed.
  message: string;
  // Null on older rows and on codes this release does not know.
  code: JobEventCode | null;
  params: Record<string, unknown> | null;
}

export interface EnqueueInput {
  recipeId: string;
  scale: number;
  force?: boolean;
  slug?: string | null;
  title?: string | null;
}

export interface EnqueueResult {
  job: Job;
  // False when an active job for the recipe already existed and was returned instead.
  created: boolean;
}

// The fields a run may change. Undefined leaves a field as it is; null clears it.
export interface JobPatch {
  status?: JobStatus;
  mealieSlug?: string | null;
  title?: string | null;
  servings?: number | null;
  servingUnit?: string | null;
  attempts?: number;
  error?: string | null;
  mcRecipeId?: number | null;
  mcRecipeUrl?: string | null;
  provider?: string | null;
  model?: string | null;
  usage?: JobUsage | null;
  costUsd?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  force?: boolean;
  conversion?: StoredConversion | null;
  createStartedAt?: string | null;
  ingredients?: JobIngredientStats | null;
}

export interface ListJobsOptions {
  limit?: number;
  offset?: number;
  // One status, or any of several.
  status?: JobStatus | readonly JobStatus[];
  // Matches the recipe id or slug exactly, or the title in part.
  search?: string;
}

export type JobStats = Record<JobStatus, number>;

// What the jobs created since a point in time came to, for the overview.
export interface JobSummary {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  // Mean run time of the done jobs; null without one.
  avgDurationMs: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobConflictError";
  }
}

export interface JobStoreOptions {
  now?: () => Date;
  newId?: () => string;
}

interface JobRow {
  id: string;
  mealie_recipe_id: string;
  mealie_slug: string | null;
  title: string | null;
  scale: number;
  servings: number | null;
  serving_unit: string | null;
  status: JobStatus;
  attempts: number;
  error: string | null;
  mc_recipe_id: number | null;
  mc_recipe_url: string | null;
  provider: string | null;
  model: string | null;
  usage_json: string | null;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  force: number;
  conversion_json: string | null;
  create_started_at: string | null;
  ingredients_json: string | null;
}

interface EventRow {
  id: number;
  job_id: string;
  ts: string;
  level: EventLevel;
  message: string;
  code: string | null;
  params_json: string | null;
}

const COLUMNS: Readonly<Record<keyof JobPatch, string>> = {
  status: "status",
  mealieSlug: "mealie_slug",
  title: "title",
  servings: "servings",
  servingUnit: "serving_unit",
  attempts: "attempts",
  error: "error",
  mcRecipeId: "mc_recipe_id",
  mcRecipeUrl: "mc_recipe_url",
  provider: "provider",
  model: "model",
  usage: "usage_json",
  costUsd: "cost_usd",
  startedAt: "started_at",
  finishedAt: "finished_at",
  force: "force",
  conversion: "conversion_json",
  createStartedAt: "create_started_at",
  ingredients: "ingredients_json",
};

export const INTERRUPTED_CREATE =
  "Interrupted while the draft was being created. The draft may exist on monsieur-cuisine.com: check your drafts before you retry this job.";

const MAX_EVENT_LENGTH = 2000;
const MAX_LIST = 500;

const activeList = ACTIVE_STATUSES.map((status) => `'${status}'`).join(", ");

export class JobStore {
  readonly #db: Db;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(db: Db, options: JobStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  // Adds a job unless the recipe already has an active one (queued, running or waiting for
  // a session) at the same scale, which is then returned. Protects against double clicks;
  // a click at another scale is a new job, like the separate draft it leads to.
  enqueue(input: EnqueueInput): EnqueueResult {
    return this.#db
      .transaction((): EnqueueResult => {
        const existing = this.activeForRecipe(input.recipeId, input.scale);
        if (existing) return { job: existing, created: false };
        const id = this.#newId();
        const ts = this.#ts();
        this.#db
          .prepare(
            `INSERT INTO jobs (id, mealie_recipe_id, mealie_slug, title, scale, status, attempts,
               created_at, updated_at, force)
             VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
          )
          .run(
            id,
            input.recipeId,
            input.slug ?? null,
            input.title ?? null,
            input.scale,
            ts,
            ts,
            input.force ? 1 : 0,
          );
        this.#event(id, "info", {
          code: "queued",
          params: { scale: input.scale, force: input.force === true },
        });
        return { job: this.#require(id), created: true };
      })
      .immediate();
  }

  activeForRecipe(recipeId: string, scale: number): Job | null {
    const row = this.#db
      .prepare<[string, number], JobRow>(
        `SELECT * FROM jobs WHERE mealie_recipe_id = ? AND scale = ? AND status IN (${activeList})
         ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(recipeId, scale);
    return row ? toJob(row) : null;
  }

  // How many jobs were queued since the given time, and the estimated LLM cost of those
  // jobs in USD. The daily limits of the webhook count with this.
  usageSince(since: Date): { jobs: number; costUsd: number } {
    const row = this.#db
      .prepare<[string], { jobs: number; cost: number }>(
        "SELECT COUNT(*) AS jobs, COALESCE(SUM(cost_usd), 0) AS cost FROM jobs WHERE created_at >= ?",
      )
      .get(since.toISOString());
    return { jobs: row?.jobs ?? 0, costUsd: row?.cost ?? 0 };
  }

  // Takes the oldest queued job and marks it running, in one transaction.
  claimNext(): Job | null {
    return this.#db
      .transaction((): Job | null => {
        const row = this.#db
          .prepare<[], { id: string }>(
            "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1",
          )
          .get();
        if (!row) return null;
        const ts = this.#ts();
        this.#db
          .prepare(
            `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?,
               finished_at = NULL, create_started_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(ts, ts, row.id);
        return this.#require(row.id);
      })
      .immediate();
  }

  get(id: string): Job | null {
    const row = this.#db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? toJob(row) : null;
  }

  getWithEvents(id: string): { job: Job; events: JobEvent[] } | null {
    const job = this.get(id);
    return job ? { job, events: this.events(id) } : null;
  }

  events(jobId: string): JobEvent[] {
    return this.#db
      .prepare<[string], EventRow>("SELECT * FROM job_events WHERE job_id = ? ORDER BY id")
      .all(jobId)
      .map((row) => ({
        id: row.id,
        jobId: row.job_id,
        ts: row.ts,
        level: row.level,
        message: row.message,
        code: isJobEventCode(row.code) ? row.code : null,
        params: isJobEventCode(row.code) ? parseParams(row.params_json) : null,
      }));
  }

  update(id: string, patch: JobPatch): Job {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof JobPatch, string]>) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(toColumn(key, value));
    }
    sets.push("updated_at = ?");
    values.push(this.#ts());
    const result = this.#db
      .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    if (result.changes === 0) throw new Error(`Job ${id} does not exist`);
    return this.#require(id);
  }

  // Sets a final or waiting status and stamps finished_at for final ones.
  finish(id: string, status: JobStatus, patch: Omit<JobPatch, "status"> = {}): Job {
    const finishedAt = FINAL_STATUSES.includes(status) ? this.#ts() : null;
    return this.update(id, { ...patch, status, finishedAt });
  }

  // An event with a code; a plain string is stored as a message without one.
  appendEvent(jobId: string, level: EventLevel, event: JobEventInput | string): void {
    this.#event(jobId, level, event);
  }

  listRecent(options: ListJobsOptions = {}): Job[] {
    const limit = clamp(options.limit ?? 20, 1, MAX_LIST);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const { clause, values } = filter(options);
    return this.#db
      .prepare<unknown[], JobRow>(
        `SELECT * FROM jobs ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset)
      .map(toJob);
  }

  // Jobs per status: all of them, or those a search matches as in listRecent.
  stats(options: Pick<ListJobsOptions, "search"> = {}): JobStats {
    const stats = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as JobStats;
    const { clause, values } = filter({ ...(options.search ? { search: options.search } : {}) });
    const rows = this.#db
      .prepare<unknown[], { status: JobStatus; count: number }>(
        `SELECT status, COUNT(*) AS count FROM jobs ${clause} GROUP BY status`,
      )
      .all(...values);
    for (const row of rows) stats[row.status] = row.count;
    return stats;
  }

  // Counts, mean run time, cost and tokens of the jobs created since the given time.
  summarySince(since: Date): JobSummary {
    const row = this.#db
      .prepare<[string], SummaryRow>(
        `SELECT COUNT(*) AS total,
           COALESCE(SUM(status = 'done'), 0) AS done,
           COALESCE(SUM(status = 'failed'), 0) AS failed,
           COALESCE(SUM(status = 'skipped'), 0) AS skipped,
           AVG(CASE WHEN status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL
               THEN (julianday(finished_at) - julianday(started_at)) * 86400000 END) AS avg_ms,
           COALESCE(SUM(cost_usd), 0) AS cost,
           COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) AS input,
           COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) AS output
         FROM jobs WHERE created_at >= ?`,
      )
      .get(since.toISOString());
    return {
      total: row?.total ?? 0,
      done: row?.done ?? 0,
      failed: row?.failed ?? 0,
      skipped: row?.skipped ?? 0,
      avgDurationMs: typeof row?.avg_ms === "number" ? Math.round(row.avg_ms) : null,
      costUsd: row?.cost ?? 0,
      inputTokens: row?.input ?? 0,
      outputTokens: row?.output ?? 0,
    };
  }

  // Puts a finished or waiting job back into the queue. A plain retry reuses a stored
  // conversion; with force, the next run converts again and ignores the "already sent"
  // check.
  requeue(id: string, options: { force?: boolean } = {}): Job {
    return this.#db
      .transaction((): Job => {
        const job = this.get(id);
        if (!job) throw new JobConflictError(`Job ${id} does not exist`);
        if (job.status === "running") throw new JobConflictError("The job is running");
        if (job.status === "queued" && options.force === undefined) return job;
        const other = this.activeForRecipe(job.mealieRecipeId, job.scale);
        if (other && other.id !== id) {
          throw new JobConflictError(
            `Job ${other.id} for the same recipe and scale is ${other.status}`,
          );
        }
        const force = options.force ?? false;
        const updated = this.update(id, {
          status: "queued",
          error: null,
          finishedAt: null,
          force,
          createStartedAt: null,
          ...(force ? { conversion: null } : {}),
        });
        this.#event(id, "info", { code: "requeued", params: { force } });
        return updated;
      })
      .immediate();
  }

  // Stops a job that has not started. A running job cannot be cancelled.
  cancel(id: string): Job {
    return this.#db
      .transaction((): Job => {
        const job = this.get(id);
        if (!job) throw new JobConflictError(`Job ${id} does not exist`);
        if (job.status !== "queued" && job.status !== "session_expired") {
          throw new JobConflictError(`A ${job.status} job cannot be cancelled`);
        }
        const updated = this.finish(id, "cancelled");
        this.#event(id, "info", { code: "cancelled" });
        return updated;
      })
      .immediate();
  }

  // The session is gone: queued jobs wait for a new one. Returns the number of jobs.
  pauseQueued(): number {
    return this.#move("queued", "session_expired", { code: "paused" });
  }

  // A new session is in place: waiting jobs run again.
  resumePaused(): number {
    return this.#move("session_expired", "queued", { code: "resumed" });
  }

  // Jobs left running by a crash or a hard stop, handled on start. Most go back to the
  // queue. A job stopped after it created its draft is done. A job stopped while the draft
  // creation request was out may have left a draft behind; it fails, so it is never sent
  // twice. Returns the number of jobs handled.
  recoverInterrupted(): number {
    return this.#db
      .transaction((): number => {
        const rows = this.#db
          .prepare<
            [],
            { id: string; create_started_at: string | null; mc_recipe_id: number | null }
          >("SELECT id, create_started_at, mc_recipe_id FROM jobs WHERE status = 'running'")
          .all();
        for (const row of rows) {
          if (row.mc_recipe_id !== null) {
            this.finish(row.id, "done");
            this.#event(row.id, "warn", { code: "recovered_done" });
          } else if (row.create_started_at !== null) {
            this.finish(row.id, "failed", { error: INTERRUPTED_CREATE });
            this.#event(row.id, "error", { code: "recovered_failed" });
          } else {
            this.update(row.id, { status: "queued", startedAt: null });
            this.#event(row.id, "info", { code: "recovered_queued" });
          }
        }
        return rows.length;
      })
      .immediate();
  }

  #move(from: JobStatus, to: JobStatus, event: JobEventInput): number {
    return this.#db
      .transaction((): number => {
        const ids = this.#db
          .prepare<[JobStatus], { id: string }>("SELECT id FROM jobs WHERE status = ?")
          .all(from)
          .map((row) => row.id);
        const ts = this.#ts();
        const update = this.#db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?");
        for (const id of ids) {
          update.run(to, ts, id);
          this.#event(id, "info", event);
        }
        return ids.length;
      })
      .immediate();
  }

  #event(jobId: string, level: EventLevel, event: JobEventInput | string): void {
    const coded = typeof event === "string" ? null : event;
    const params = coded ? storedParams(coded.params) : null;
    const message = coded ? jobEventMessage(coded.code, params ?? {}) : (event as string);
    const text =
      message.length > MAX_EVENT_LENGTH ? `${message.slice(0, MAX_EVENT_LENGTH)}...` : message;
    this.#db
      .prepare(
        "INSERT INTO job_events (job_id, ts, level, message, code, params_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        jobId,
        this.#ts(),
        level,
        text,
        coded?.code ?? null,
        params ? JSON.stringify(params) : null,
      );
  }

  #require(id: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`Job ${id} does not exist`);
    return job;
  }

  #ts(): string {
    return this.#now().toISOString();
  }
}

function toColumn(key: keyof JobPatch, value: unknown): unknown {
  if (value === null) return null;
  if (key === "usage" || key === "conversion" || key === "ingredients") {
    return JSON.stringify(value);
  }
  if (key === "force") return value ? 1 : 0;
  return value;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    mealieRecipeId: row.mealie_recipe_id,
    mealieSlug: row.mealie_slug,
    title: row.title,
    scale: row.scale,
    servings: row.servings,
    servingUnit: row.serving_unit,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    mcRecipeId: row.mc_recipe_id,
    mcRecipeUrl: row.mc_recipe_url,
    provider: row.provider,
    model: row.model,
    usage: parseJson<JobUsage>(row.usage_json),
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    force: row.force === 1,
    conversion: parseJson<StoredConversion>(row.conversion_json),
    createStartedAt: row.create_started_at,
    ingredients: parseJson<JobIngredientStats>(row.ingredients_json),
  };
}

function parseParams(json: string | null): Record<string, unknown> {
  const value = parseJson<unknown>(json);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

interface SummaryRow {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  avg_ms: number | null;
  cost: number;
  input: number;
  output: number;
}

// The WHERE clause of a list or a count: a status, and a search that matches the recipe id
// or slug exactly or the title in part.
function filter(options: Pick<ListJobsOptions, "status" | "search">): {
  clause: string;
  values: unknown[];
} {
  const where: string[] = [];
  const values: unknown[] = [];
  const statuses = typeof options.status === "string" ? [options.status] : (options.status ?? []);
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    values.push(...statuses);
  }
  const search = options.search?.trim();
  if (search) {
    where.push("(mealie_recipe_id = ? OR mealie_slug = ? OR title LIKE ? ESCAPE '\\')");
    values.push(search, search, `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  return { clause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", values };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
