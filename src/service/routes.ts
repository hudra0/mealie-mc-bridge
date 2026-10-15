// Public routes: the webhook Mealie's recipe action posts to, and job lookup by id.
//
// Mealie sends no credentials; the secret is the token in the path. A wrong token gets the
// same 404 as an unknown route, checked before the body is parsed. Mealie ignores the
// answer and gives up after 15 seconds, so the hook only queues the job and answers 202.
//
// Every member of the Mealie household can see the action URL and click it, so the hook
// enforces two daily limits before it queues a new job: the number of jobs and the
// estimated LLM cost of the last 24 hours (JOB_DAILY_LIMIT, JOB_DAILY_COST_LIMIT_USD). Over
// a limit it answers 429 and onLimited explains it in the recipe's Mealie timeline.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InvalidRecipeActionError, parseRecipeActionBody } from "../mealie/index.js";
import { NOT_FOUND_BODY } from "../server.js";
import type { Job, JobEvent, JobStore } from "../store/jobs.js";
import { safeEqual } from "./security.js";

export const WEBHOOK_BODY_LIMIT = 2 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;

export interface DailyLimits {
  // Jobs in 24 hours; 0 for no limit.
  jobs: number;
  // Estimated LLM cost in USD in 24 hours; 0 for no limit.
  costUsd: number;
}

export interface LimitHit {
  kind: "jobs" | "cost";
  limit: number;
}

export interface RoutesOptions {
  webhookToken: string;
  jobs: Pick<JobStore, "enqueue" | "getWithEvents" | "activeForRecipe" | "usageSince">;
  // Called after a job was queued, so the worker does not wait for its next poll.
  onEnqueued?: () => void;
  // Without them, the hook queues every click.
  limits?: DailyLimits;
  // Called when a click was refused over a limit; must not throw.
  onLimited?: (recipeId: string, hit: LimitHit) => void;
  now?: () => Date;
}

// The limit a new job would break, or null.
export function limitHit(
  usage: { jobs: number; costUsd: number },
  limits: DailyLimits,
): LimitHit | null {
  if (limits.jobs > 0 && usage.jobs >= limits.jobs) return { kind: "jobs", limit: limits.jobs };
  if (limits.costUsd > 0 && usage.costUsd >= limits.costUsd) {
    return { kind: "cost", limit: limits.costUsd };
  }
  return null;
}

// The job as /jobs/:id shows it, without a login: its state and its log, as the README
// lists them. The Monsieur Cuisine recipe and its editor link are on the admin pages only.
export interface PublicJob {
  id: string;
  status: Job["status"];
  recipeId: string;
  scale: number;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  events: Array<Pick<JobEvent, "ts" | "level" | "message">>;
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send(NOT_FOUND_BODY);
}

export function routes(
  app: FastifyInstance,
  options: RoutesOptions,
  done: (error?: Error) => void,
): void {
  app.post<{ Params: { token: string } }>(
    "/hooks/mealie/:token",
    {
      bodyLimit: WEBHOOK_BODY_LIMIT,
      onRequest: (request: FastifyRequest<{ Params: { token: string } }>, reply, next) => {
        if (!safeEqual(request.params.token, options.webhookToken)) {
          request.log.warn({}, "webhook call with a wrong token");
          void notFound(reply);
          return;
        }
        next();
      },
    },
    (request, reply) => {
      let action;
      try {
        action = parseRecipeActionBody(request.body);
      } catch (error) {
        if (error instanceof InvalidRecipeActionError) {
          return reply
            .code(400)
            .send({ error: "Bad Request", message: error.message, issues: error.issues });
        }
        throw error;
      }
      // A double click is answered with the active job and counts toward no limit.
      const active = options.jobs.activeForRecipe(action.recipeId, action.scale);
      if (!active && options.limits) {
        const since = new Date((options.now?.() ?? new Date()).getTime() - DAY_MS);
        const hit = limitHit(options.jobs.usageSince(since), options.limits);
        if (hit) {
          request.log.warn(
            { recipeId: action.recipeId, limit: hit.kind, value: hit.limit },
            "webhook call refused: daily limit reached",
          );
          options.onLimited?.(action.recipeId, hit);
          const message =
            hit.kind === "jobs"
              ? `Daily limit reached: at most ${hit.limit} jobs in 24 hours (JOB_DAILY_LIMIT).`
              : `Daily cost limit reached: ${hit.limit} USD in 24 hours (JOB_DAILY_COST_LIMIT_USD).`;
          return reply.code(429).send({ error: "Too Many Requests", message });
        }
      }
      const { job, created } = options.jobs.enqueue({
        recipeId: action.recipeId,
        scale: action.scale,
      });
      request.log.info(
        { jobId: job.id, recipeId: action.recipeId, scale: action.scale, created },
        created ? "job queued" : "job already active for this recipe",
      );
      if (created) options.onEnqueued?.();
      return reply.code(202).send({ jobId: job.id });
    },
  );

  app.get<{ Params: { id: string } }>("/jobs/:id", (request, reply) => {
    const found = options.jobs.getWithEvents(request.params.id);
    if (!found) return notFound(reply);
    return reply.send(publicJob(found.job, found.events));
  });

  done();
}

export function publicJob(job: Job, events: readonly JobEvent[]): PublicJob {
  return {
    id: job.id,
    status: job.status,
    recipeId: job.mealieRecipeId,
    scale: job.scale,
    attempts: job.attempts,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    events: events.map((event) => ({ ts: event.ts, level: event.level, message: event.message })),
  };
}
