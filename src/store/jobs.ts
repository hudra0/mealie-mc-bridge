// Job queue and job history in bridge.db.
//
// A job is one click on the recipe action. Its status follows the state machine in
// docs/ARCHITECTURE.md: queued -> running -> done | skipped | failed | session_expired,
// with cancelled for jobs an admin stops before they run. Every stage of a run appends an
// event, which the admin page shows as the job's log.

import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { JOB_STATUSES } from "./migrations.js";

export type JobStatus = (typeof JOB_STATUSES)[number];
export { JOB_STATUSES };

// Waiting for or holding the worker. A recipe has at most one such job.
export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "running", "session_expired"];
export const FINAL_STATUSES: readonly JobStatus[] = ["done", "skipped", "failed", "cancelled"];

export type EventLevel = "info" | "warn" | "error";

export interface JobUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface Job {
  id: string;
  mealieRecipeId: string;
  mealieSlug: string | null;
  title: string | null;
  scale: number;
  servings: number | null;
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
}

export interface JobEvent {
  id: number;
  jobId: string;
  ts: string;
  level: EventLevel;
  message: string;
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
}

export interface ListJobsOptions {
  limit?: number;
  offset?: number;
  status?: JobStatus;
  // Matches the recipe id or slug exactly, or the title in part.
  search?: string;
}

export type JobStats = Record<JobStatus, number>;

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
}

interface EventRow {
  id: number;
  job_id: string;
  ts: string;
  level: EventLevel;
  message: string;
}

const COLUMNS: Readonly<Record<keyof JobPatch, string>> = {
  status: "status",
  mealieSlug: "mealie_slug",
  title: "title",
  servings: "servings",
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
};

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
  // a session), which is then returned. Protects against double clicks.
  enqueue(input: EnqueueInput): EnqueueResult {
    return this.#db
      .transaction((): EnqueueResult => {
        const existing = this.activeForRecipe(input.recipeId);
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
        this.#event(id, "info", `Queued with scale ${input.scale}${input.force ? ", forced" : ""}`);
        return { job: this.#require(id), created: true };
      })
      .immediate();
  }

  activeForRecipe(recipeId: string): Job | null {
    const row = this.#db
      .prepare<[string], JobRow>(
        `SELECT * FROM jobs WHERE mealie_recipe_id = ? AND status IN (${activeList})
         ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(recipeId);
    return row ? toJob(row) : null;
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
               finished_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`,
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

  appendEvent(jobId: string, level: EventLevel, message: string): void {
    this.#event(jobId, level, message);
  }

  listRecent(options: ListJobsOptions = {}): Job[] {
    const limit = clamp(options.limit ?? 20, 1, MAX_LIST);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const where: string[] = [];
    const values: unknown[] = [];
    if (options.status) {
      where.push("status = ?");
      values.push(options.status);
    }
    const search = options.search?.trim();
    if (search) {
      where.push("(mealie_recipe_id = ? OR mealie_slug = ? OR title LIKE ? ESCAPE '\\')");
      values.push(search, search, `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.#db
      .prepare<unknown[], JobRow>(
        `SELECT * FROM jobs ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset)
      .map(toJob);
  }

  stats(): JobStats {
    const stats = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as JobStats;
    const rows = this.#db
      .prepare<[], { status: JobStatus; count: number }>(
        "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status",
      )
      .all();
    for (const row of rows) stats[row.status] = row.count;
    return stats;
  }

  // Puts a finished or waiting job back into the queue. With force, the next run ignores
  // the "already sent" check.
  requeue(id: string, options: { force?: boolean } = {}): Job {
    return this.#db
      .transaction((): Job => {
        const job = this.get(id);
        if (!job) throw new JobConflictError(`Job ${id} does not exist`);
        if (job.status === "running") throw new JobConflictError("The job is running");
        if (job.status === "queued" && options.force === undefined) return job;
        const other = this.activeForRecipe(job.mealieRecipeId);
        if (other && other.id !== id) {
          throw new JobConflictError(`Job ${other.id} for the same recipe is ${other.status}`);
        }
        const force = options.force ?? false;
        const updated = this.update(id, {
          status: "queued",
          error: null,
          finishedAt: null,
          force,
        });
        this.#event(id, "info", force ? "Queued again, forced" : "Queued again");
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
        this.#event(id, "info", "Cancelled");
        return updated;
      })
      .immediate();
  }

  // The session is gone: queued jobs wait for a new one. Returns the number of jobs.
  pauseQueued(): number {
    return this.#move("queued", "session_expired", "Waiting for a valid Monsieur Cuisine session");
  }

  // A new session is in place: waiting jobs run again.
  resumePaused(): number {
    return this.#move("session_expired", "queued", "Session renewed, queued again");
  }

  // Jobs left running by a crash or a hard stop go back to the queue on start.
  recoverInterrupted(): number {
    return this.#move("running", "queued", "Interrupted by a restart, queued again");
  }

  #move(from: JobStatus, to: JobStatus, message: string): number {
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
          this.#event(id, "info", message);
        }
        return ids.length;
      })
      .immediate();
  }

  #event(jobId: string, level: EventLevel, message: string): void {
    const text =
      message.length > MAX_EVENT_LENGTH ? `${message.slice(0, MAX_EVENT_LENGTH)}...` : message;
    this.#db
      .prepare("INSERT INTO job_events (job_id, ts, level, message) VALUES (?, ?, ?, ?)")
      .run(jobId, this.#ts(), level, text);
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
  if (key === "usage") return JSON.stringify(value);
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
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    mcRecipeId: row.mc_recipe_id,
    mcRecipeUrl: row.mc_recipe_url,
    provider: row.provider,
    model: row.model,
    usage: parseUsage(row.usage_json),
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    force: row.force === 1,
  };
}

function parseUsage(json: string | null): JobUsage | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as JobUsage;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
