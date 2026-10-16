// Job events as codes with parameters. The store keeps the code, the parameters as JSON
// and an English sentence (for logs, GET /jobs/:id and rows written before codes existed);
// the admin pages render the code in UI_LANGUAGE through src/i18n.
//
// Each code names its parameters here, so the compiler checks every place that appends an
// event and every catalog that renders one. An `error` parameter carries the raw error text
// of a failure; the pages show it below the sentence, the English message appends it.

import type { FailureStage } from "../i18n/index.js";

type Empty = Record<string, never>;

export interface JobEventParams {
  // Queue changes (src/store/jobs.ts).
  queued: { scale: number; force: boolean };
  requeued: { force: boolean };
  cancelled: Empty;
  paused: Empty;
  resumed: Empty;
  recovered_done: Empty;
  recovered_failed: Empty;
  recovered_queued: Empty;
  // A run (src/pipeline/run-job.ts).
  attempt_started: { attempt: number };
  recipe_loaded: { name: string; slug: string };
  prepared: {
    ingredients: number;
    unparsed: number;
    servings: string;
    estimated: boolean;
    scale: number;
    hash: string;
  };
  forced_unchanged: Empty;
  skip_exists: { since: string; recipeId: number; status: string };
  skip_gone: { since: string; recipeId: number };
  skip_unchecked: { since: string; recipeId: number; error: string };
  image_loaded: { kb: number };
  image_none: Empty;
  image_load_failed: { error: string };
  categories: { count: number; source: string; matched: string[] };
  conversion_reused: { provider: string; model: string };
  converting: Empty;
  still_converting: { seconds: number };
  converted: {
    provider: string;
    model: string;
    attempts: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  };
  converter_warning: { text: string };
  categories_dropped: { ids: number[] };
  servings_estimated: { servings: string };
  servings_changed: { requested: string; converted: string };
  validation_passed: Empty;
  ingredients_resolved: {
    catalog: number;
    relaxed: number;
    cache: number;
    search: number;
    unresolved: number;
  };
  ingredients_off: { unresolved: number };
  image_skipped: { error: string };
  image_uploaded: { details: string; thumbnail: string };
  draft_created: { recipeId: number; url: string };
  status_private: Empty;
  status_failed: { error: string };
  tag_unavailable: { tag: string; error: string };
  writeback_done: { tagged: boolean };
  writeback_forbidden: Empty;
  writeback_failed: { error: string };
  timeline_posted: { subject: string };
  timeline_failed: { error: string };
  done: Empty;
  interrupted: Empty;
  session_unusable: { kind: string };
  temporary_failure: { stage: FailureStage; error: string };
  failed: { stage: FailureStage; error: string };
  // The worker (src/pipeline/worker.ts).
  crashed: { error: string };
  retry_scheduled: { retry: number; max: number; seconds: number };
}

export type JobEventCode = keyof JobEventParams;

// One event as the callers append it: a code with its parameters.
export type JobEventInput = {
  [C in JobEventCode]: Empty extends JobEventParams[C]
    ? { code: C; params?: JobEventParams[C] }
    : { code: C; params: JobEventParams[C] };
}[JobEventCode];

// Every code, for reading rows back: a code this release does not know is shown as its
// stored message.
export const JOB_EVENT_CODES = [
  "queued",
  "requeued",
  "cancelled",
  "paused",
  "resumed",
  "recovered_done",
  "recovered_failed",
  "recovered_queued",
  "attempt_started",
  "recipe_loaded",
  "prepared",
  "forced_unchanged",
  "skip_exists",
  "skip_gone",
  "skip_unchecked",
  "image_loaded",
  "image_none",
  "image_load_failed",
  "categories",
  "conversion_reused",
  "converting",
  "still_converting",
  "converted",
  "converter_warning",
  "categories_dropped",
  "servings_estimated",
  "servings_changed",
  "validation_passed",
  "ingredients_resolved",
  "ingredients_off",
  "image_skipped",
  "image_uploaded",
  "draft_created",
  "status_private",
  "status_failed",
  "tag_unavailable",
  "writeback_done",
  "writeback_forbidden",
  "writeback_failed",
  "timeline_posted",
  "timeline_failed",
  "done",
  "interrupted",
  "session_unusable",
  "temporary_failure",
  "failed",
  "crashed",
  "retry_scheduled",
] as const satisfies readonly JobEventCode[];

// The compiler checks that the list above names every code exactly once.
type Missing = Exclude<JobEventCode, (typeof JOB_EVENT_CODES)[number]>;
const complete: Missing extends never ? true : Missing = true;
void complete;

export function isJobEventCode(value: unknown): value is JobEventCode {
  return typeof value === "string" && (JOB_EVENT_CODES as readonly string[]).includes(value);
}

// The longest stored text value of a parameter; longer values are cut.
export const MAX_PARAM_LENGTH = 2000;

// The parameters as they are stored: strings cut to MAX_PARAM_LENGTH, lists of strings or
// numbers kept, anything else left out.
export function storedParams(params: object | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === "string") {
      out[key] = value.length > MAX_PARAM_LENGTH ? `${value.slice(0, MAX_PARAM_LENGTH)}...` : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.filter((item) => typeof item === "string" || typeof item === "number");
    }
  }
  return out;
}
