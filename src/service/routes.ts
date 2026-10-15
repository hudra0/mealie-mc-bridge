// Public routes: the webhook Mealie's recipe action posts to, and job lookup by id.
//
// Mealie sends no credentials; the secret is the token in the path. A wrong token gets the
// same 404 as an unknown route, checked before the body is parsed. Mealie ignores the
// answer and gives up after 15 seconds, so the hook only queues the job and answers 202.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InvalidRecipeActionError, parseRecipeActionBody } from "../mealie/index.js";
import { NOT_FOUND_BODY } from "../server.js";
import type { Job, JobEvent, JobStore } from "../store/jobs.js";
import { safeEqual } from "./security.js";

export const WEBHOOK_BODY_LIMIT = 2 * 1024 * 1024;

export interface RoutesOptions {
  webhookToken: string;
  jobs: Pick<JobStore, "enqueue" | "getWithEvents">;
  // Called after a job was queued, so the worker does not wait for its next poll.
  onEnqueued?: () => void;
}

// The job as /jobs/:id shows it.
export interface PublicJob {
  id: string;
  status: Job["status"];
  recipeId: string;
  slug: string | null;
  title: string | null;
  scale: number;
  servings: number | null;
  servingUnit: string | null;
  attempts: number;
  error: string | null;
  mcRecipeId: number | null;
  mcRecipeUrl: string | null;
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
    slug: job.mealieSlug,
    title: job.title,
    scale: job.scale,
    servings: job.servings,
    servingUnit: job.servingUnit,
    attempts: job.attempts,
    error: job.error,
    mcRecipeId: job.mcRecipeId,
    mcRecipeUrl: job.mcRecipeUrl,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    events: events.map((event) => ({ ts: event.ts, level: event.level, message: event.message })),
  };
}
