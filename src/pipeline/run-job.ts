// One run of a job, from the Mealie recipe to the draft and the report back into Mealie.
//
// Stages: load the recipe, normalize, scale, render and fingerprint it, skip it when it is
// unchanged and its Monsieur Cuisine recipe still exists, load the image, pick categories,
// convert, validate, resolve the ingredient ids, prepare and upload the image, create the
// draft, set its status, write back to Mealie. Every stage appends a job event.
//
// A conversion that passed validation is stored on the job, so a retry after a later
// temporary failure (an image upload, say) reuses it instead of paying for it again.
//
// Creating the draft is the point of no return. The job is marked before the request goes
// out; a job interrupted from there on fails instead of going back to the queue, and a
// restart fails it too (JobStore.recoverInterrupted). Once the draft exists, the job ends
// as done, and problems in the status change or the write-back become warnings, so a
// retry can never leave a second draft behind.

import { errorMessage, type AppLogger } from "../app-logger.js";
import {
  McApiError,
  McCategoriesUnavailableError,
  McMediaTimeoutError,
  McNetworkError,
  McSessionError,
  prepareRecipeImage,
  type ImageAspect,
  type McRecipeSink,
  type McUploadedImage,
  type PreparedRecipeImage,
  type SessionProvider,
} from "../mc/index.js";
import {
  MealieApiError,
  type MealieClient,
  type MealieRecipe,
  type MealieTagRef,
} from "../mealie/index.js";
import { messages, type JobEventMessages } from "../i18n/index.js";
import type { Notifier } from "../notify/email.js";
import { buildMcPayload } from "../recipe/payload.js";
import type { DeviceLimits } from "../recipe/limits.js";
import type { RecipeInput } from "../recipe/schema.js";
import { INTERRUPTED_CREATE, type Job, type JobStore, type EventLevel } from "../store/jobs.js";
import type { McRecipeStore, SentRecipe } from "../store/mc-recipes.js";
import type { SettingsStore } from "../store/settings.js";
import type { ConversionResult, Converter } from "./converter-port.js";
import { describeResolution, type IngredientResolverPort } from "./ingredient-resolver.js";
import { formatServingSize } from "./serving-size.js";
import type { PipelineLocale } from "./locale.js";
import {
  timelineTexts,
  type FailureStage,
  type TimelineTexts,
  type UiLanguage,
} from "./messages.js";
import {
  checkConverted,
  conversionRequest,
  planCategories,
  prepareRecipe,
  summarizeValidation,
} from "./prepare.js";

export type MealiePort = Pick<
  MealieClient,
  "getRecipe" | "getRecipeImage" | "ensureTag" | "patchRecipeMerged" | "addTimelineEvent"
>;

export interface PipelineConfig {
  MC_RECIPE_STATUS: "draft" | "private-publish";
  TAG_NAME: string;
  // The language of the timeline entries.
  UI_LANGUAGE: UiLanguage;
}

export interface PipelineStore {
  jobs: JobStore;
  mcRecipes: McRecipeStore;
  settings: SettingsStore;
}

export interface RunJobDeps {
  mealie: MealiePort;
  mc: McRecipeSink;
  converter: Converter;
  limits: DeviceLimits;
  // The pack of MC_LOCALE and the category words of every pack.
  locale: PipelineLocale;
  config: PipelineConfig;
  logger: AppLogger;
  notifier: Notifier;
  store: PipelineStore;
  // Told about a rejected session, for sinks that do not report it themselves. Leave it
  // out with McClient: it reports to its provider along with the cookie it used, and a
  // report without the cookie could mark a freshly replaced cookie as dead.
  session?: Pick<SessionProvider, "onSessionError">;
  prepareImage?: (bytes: Uint8Array, aspect: ImageAspect) => Promise<PreparedRecipeImage>;
  // Finds the systemIngredientId per ingredient. Without it, every ingredient goes out
  // without an id.
  ingredients?: IngredientResolverPort;
  // How often a running conversion adds a progress event; CONVERT_HEARTBEAT_MS by default.
  heartbeatMs?: number;
  now?: () => Date;
}

export const CONVERT_HEARTBEAT_MS = 30_000;

export interface RunJobOptions {
  signal?: AbortSignal;
  // False while the worker may still retry a transient failure. Defaults to true.
  finalAttempt?: boolean;
}

export type RunJobOutcome =
  | { status: "done" | "skipped" | "session_expired" | "interrupted"; job: Job }
  | { status: "failed" | "retry"; job: Job; error: string; stage: FailureStage };

// The draft was not created because the converted recipe broke the rules.
export class ValidationFailedError extends Error {
  constructor(summary: string) {
    super(`The converted recipe failed validation: ${summary}`);
    this.name = "ValidationFailedError";
  }
}

class StageError extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly reason: unknown,
    readonly retryable: boolean,
  ) {
    super(errorMessage(reason));
    this.name = "StageError";
  }
}

class InterruptedError extends Error {
  constructor() {
    super("Interrupted by shutdown");
    this.name = "InterruptedError";
  }
}

// Failures that may pass on their own: no answer, or a server error. Session problems and
// refusals are not among them.
export function isTransient(error: unknown): boolean {
  if (error instanceof McSessionError) return false;
  if (error instanceof MealieApiError) return error.kind === "network" || error.kind === "server";
  if (error instanceof McNetworkError || error instanceof McMediaTimeoutError) return true;
  if (error instanceof McCategoriesUnavailableError) return true;
  if (error instanceof McApiError) return error.status === 0 || error.status >= 500;
  return false;
}

export async function runJob(
  job: Job,
  deps: RunJobDeps,
  options: RunJobOptions = {},
): Promise<RunJobOutcome> {
  const run = new JobRun(job, deps, options);
  try {
    return await run.execute();
  } catch (error) {
    return await run.fail(error);
  }
}

class JobRun {
  readonly #job: Job;
  readonly #deps: RunJobDeps;
  readonly #options: RunJobOptions;
  readonly #texts: TimelineTexts;
  readonly #progress: JobEventMessages;
  #recipe: MealieRecipe | null = null;
  // True from the moment the draft creation request may have reached the server.
  #creating = false;

  constructor(job: Job, deps: RunJobDeps, options: RunJobOptions) {
    this.#job = job;
    this.#deps = deps;
    this.#options = options;
    this.#texts = timelineTexts(deps.config.UI_LANGUAGE);
    this.#progress = messages(deps.config.UI_LANGUAGE).jobEvents;
  }

  get #jobs(): JobStore {
    return this.#deps.store.jobs;
  }

  async execute(): Promise<RunJobOutcome> {
    const deps = this.#deps;
    const job = this.#job;
    this.#event("info", `Attempt ${job.attempts} started`);

    this.#checkAbort();
    const recipe = await this.#stage("load", () => deps.mealie.getRecipe(job.mealieRecipeId));
    this.#recipe = recipe;
    this.#jobs.update(job.id, { title: recipe.name || null, mealieSlug: recipe.slug });
    this.#event("info", `Loaded recipe "${recipe.name}" (${recipe.slug})`);

    const prepared = await this.#stage("prepare", () =>
      prepareRecipe(recipe, job.scale, deps.limits, deps.locale, {
        excludeTags: [deps.config.TAG_NAME],
      }),
    );
    this.#jobs.update(job.id, {
      servings: prepared.servings,
      servingUnit: prepared.servingSize.unit,
    });
    const unparsed = prepared.normalized.filter((item) => item.source === "unparsed").length;
    const estimated = prepared.servingSize.source === "estimate";
    this.#event(
      "info",
      `Prepared ${prepared.normalized.length} ingredients (${unparsed} unparsed) for ${formatServingSize(prepared.servingSize)}${estimated ? " (not stated in the recipe; the converter may estimate)" : ""} at scale ${job.scale}; source hash ${prepared.hash.slice(0, 12)}`,
    );

    // The skip check comes before the image download, so a repeated click costs one
    // Monsieur Cuisine lookup and nothing else.
    const sent = deps.store.mcRecipes.find(recipe.id, job.scale, prepared.hash);
    if (sent && !job.force) {
      const skipped = await this.#skipIfStillThere(sent);
      if (skipped) return { status: "skipped", job: skipped };
    } else if (sent) {
      this.#event("info", "Forced: sending again although the recipe is unchanged");
    }

    this.#checkAbort();
    const image = await this.#loadImage(recipe);

    this.#checkAbort();
    const plan = await this.#stage("categories", () =>
      planCategories(recipe, deps.mc, deps.store.settings, deps.locale, {
        ...(deps.now ? { now: deps.now } : {}),
        isSessionError: (error) => error instanceof McSessionError,
      }),
    );
    const matched = plan.matches.map((match) => match.category.name).join(", ") || "none";
    this.#event(
      "info",
      `Categories: ${plan.catalog.categories.length} from ${plan.catalog.source}; matched: ${matched}`,
    );

    this.#checkAbort();
    const stored = storedConversion(job, prepared.hash, deps.locale.pack.locale);
    let result: ConversionResult;
    if (stored) {
      result = stored;
      this.#event(
        "info",
        `Reusing the conversion from an earlier attempt (${result.provider}/${result.model}); no new LLM call`,
      );
    } else {
      const signal = this.#options.signal;
      this.#event("info", this.#progress.converting);
      const stopHeartbeat = this.#startHeartbeat();
      try {
        result = await this.#stage(
          "convert",
          () =>
            deps.converter.convert(
              conversionRequest(recipe, prepared, plan, deps.locale.pack.locale, {
                ingredients: deps.ingredients,
              }),
              { jobId: job.id, ...(signal ? { signal } : {}) },
            ),
          false,
        );
      } finally {
        stopHeartbeat();
      }
      this.#jobs.update(job.id, {
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        costUsd: result.usage.costUsd ?? null,
      });
      const usage = result.usage;
      const cost = usage.costUsd === undefined ? "" : `, $${usage.costUsd.toFixed(4)}`;
      this.#event(
        "info",
        `Converted with ${result.provider}/${result.model} in ${plural(result.attempts, "attempt")} (${usage.inputTokens} input, ${usage.outputTokens} output tokens${cost})`,
      );
      for (const warning of result.warnings) this.#event("warn", `Converter: ${warning}`);
    }

    const checked = checkConverted(result, plan, deps.limits);
    if (checked.categories.dropped.length > 0) {
      this.#event(
        "warn",
        `Dropped category ids the catalog does not know: ${checked.categories.dropped.join(", ")}`,
      );
    }
    if (!checked.validation.ok) {
      if (stored) this.#jobs.update(job.id, { conversion: null });
      throw new StageError(
        "validate",
        new ValidationFailedError(summarizeValidation(checked.validation)),
        false,
      );
    }
    const converted = formatServingSize(checked.recipe.servingSize);
    if (estimated) {
      this.#event("info", `The converter estimated the serving size: ${converted}`);
    } else if (checked.recipe.servingSize.amount !== prepared.servings) {
      this.#event(
        "warn",
        `The converter set ${converted} instead of ${formatServingSize(prepared.servingSize)}`,
      );
    }
    this.#event("info", "Validation passed");
    if (!stored) this.#jobs.update(job.id, { conversion: { sourceHash: prepared.hash, result } });

    this.#checkAbort();
    const ingredientIds = await this.#resolveIngredients(checked.recipe);

    this.#checkAbort();
    const { media, imageSkipped } = await this.#uploadImage(image);

    this.#checkAbort();
    const payload = buildMcPayload(checked.recipe, deps.limits, {
      locale: deps.locale.pack.mc,
      status: "draft",
      categoryIds: checked.categories.ids,
      detailsMediaId: media?.detailsMediaId ?? null,
      thumbnailMediaId: media?.thumbnailMediaId ?? null,
      ...(ingredientIds ? { ingredientIds } : {}),
    });
    // The point of no return. Not retried: after a timeout the server may have created the
    // draft anyway. The signal is not passed on, so a shutdown waits for the answer.
    this.#jobs.update(job.id, { createStartedAt: this.#now().toISOString() });
    this.#creating = true;
    const ref = await this.#stage("upload", () => deps.mc.createRecipe(payload), false);
    deps.store.mcRecipes.record({
      mealieRecipeId: recipe.id,
      scale: job.scale,
      sourceHash: prepared.hash,
      mcRecipeId: ref.id,
      mcRecipeUrl: ref.editorUrl,
    });
    // The serving size the draft carries, which may differ from the requested one.
    const servings = checked.recipe.servingSize.amount;
    const servingUnit = checked.recipe.servingSize.unit;
    this.#jobs.update(job.id, {
      mcRecipeId: ref.id,
      mcRecipeUrl: ref.editorUrl,
      servings,
      servingUnit,
      error: null,
    });
    this.#event("info", `Created draft ${ref.id}: ${ref.editorUrl}`);
    deps.logger.info({ jobId: job.id, mcRecipeId: ref.id }, "draft created");

    // The draft exists. Nothing below fails the job.
    const statusFailed = await this.#setStatus(ref.id);
    await this.#writeBack(recipe, ref.id, ref.editorUrl, { servings, servingUnit }, prepared.hash);
    await this.#timeline(
      this.#texts.createdSubject(statusFailed ? "draft" : deps.config.MC_RECIPE_STATUS),
      this.#texts.created({
        url: ref.editorUrl,
        servings,
        servingUnit,
        status: deps.config.MC_RECIPE_STATUS,
        statusFailed,
        provider: result.provider,
        model: result.model,
        reviewHints: checked.reviewHints,
        imageSkipped,
      }),
    );
    const done = this.#jobs.finish(job.id, "done", { error: null });
    this.#event("info", "Done");
    deps.logger.info(
      {
        jobId: job.id,
        status: "done",
        mcRecipeId: ref.id,
        durationMs: this.#elapsedMs(),
        costUsd: done.costUsd,
      },
      "job finished",
    );
    return { status: "done", job: done };
  }

  async fail(error: unknown): Promise<RunJobOutcome> {
    const job = this.#job;
    const deps = this.#deps;
    const stage: FailureStage = error instanceof StageError ? error.stage : "unexpected";
    const reason = error instanceof StageError ? error.reason : error;

    // Once the draft creation request is out, a shutdown no longer sends the job back to
    // the queue: the failure below asks the operator to check the drafts instead.
    const interrupted = this.#options.signal?.aborted || reason instanceof InterruptedError;
    if (interrupted && !this.#creating) {
      const queued = this.#jobs.update(job.id, { status: "queued", startedAt: null });
      this.#event("warn", "Interrupted by shutdown; the job runs again after the restart");
      return { status: "interrupted", job: queued };
    }

    let message = errorMessage(reason);
    if (this.#creating && !(reason instanceof McSessionError) && !isRefusal(reason)) {
      message = `${message}. ${INTERRUPTED_CREATE}`;
    }
    if (reason instanceof McSessionError) {
      const waiting = this.#jobs.finish(job.id, "session_expired", { error: message });
      this.#event(
        "warn",
        `Monsieur Cuisine session not usable (${reason.kind}); waiting for a new one`,
      );
      await deps.session?.onSessionError(reason.kind);
      await this.#timeline(this.#texts.sessionSubject, this.#texts.session());
      return { status: "session_expired", job: waiting };
    }

    const retryable = error instanceof StageError && error.retryable && !this.#creating;
    if (retryable && this.#options.finalAttempt === false) {
      const pending = this.#jobs.update(job.id, { error: message });
      this.#event("warn", `Temporary failure at ${stage}: ${message}`);
      return { status: "retry", job: pending, error: message, stage };
    }

    const failed = this.#jobs.finish(job.id, "failed", { error: message });
    this.#event("error", `Failed at ${stage}: ${message}`);
    deps.logger.warn({ jobId: job.id, stage, err: message }, "job failed");
    await this.#timeline(
      this.#texts.failedSubject(stage),
      this.#texts.failed({ stage, detail: message }),
    );
    try {
      await deps.notifier.jobFailed(failed, message);
    } catch (notifyError) {
      deps.logger.warn({ err: errorMessage(notifyError) }, "failure notification failed");
    }
    return { status: "failed", job: failed, error: message, stage };
  }

  // An unchanged recipe was sent before. Skips the job when that Monsieur Cuisine recipe
  // still exists, or when the check itself fails (the local record is the best guess then).
  // Returns null when the recipe is gone, so the job converts it again.
  async #skipIfStillThere(sent: SentRecipe): Promise<Job | null> {
    const deps = this.#deps;
    const job = this.#job;
    let status = deps.config.MC_RECIPE_STATUS;
    const since = `Unchanged since ${sent.createdAt}`;
    this.#checkAbort();
    try {
      const record = await deps.mc.getRecipe(sent.mcRecipeId);
      status = record.status === "draft" ? "draft" : "private-publish";
      this.#event(
        "info",
        `${since}; recipe ${sent.mcRecipeId} still exists on Monsieur Cuisine (${record.status}), skipping`,
      );
    } catch (error) {
      if (isGone(error)) {
        this.#event(
          "warn",
          `${since}, but recipe ${sent.mcRecipeId} no longer exists on Monsieur Cuisine; converting again`,
        );
        return null;
      }
      this.#event(
        "warn",
        `${since}; could not check recipe ${sent.mcRecipeId} on Monsieur Cuisine (${errorMessage(error)}), skipping`,
      );
    }
    await this.#timeline(
      this.#texts.unchangedSubject,
      this.#texts.unchanged({ sentAt: sent.createdAt, url: sent.mcRecipeUrl, status }),
    );
    const skipped = this.#jobs.finish(job.id, "skipped", {
      error: null,
      mcRecipeId: sent.mcRecipeId,
      mcRecipeUrl: sent.mcRecipeUrl,
    });
    deps.logger.info(
      { jobId: job.id, mcRecipeId: sent.mcRecipeId },
      "job skipped, recipe unchanged",
    );
    return skipped;
  }

  // Looks up the systemIngredientId of every ingredient name and records the counts on the
  // job. A session error from the search fails the stage, so the job waits for a session.
  async #resolveIngredients(recipe: RecipeInput): Promise<Map<string, number | null> | null> {
    const resolver = this.#deps.ingredients;
    if (!resolver) return null;
    const names = recipe.servingSize.ingredientGroups.flatMap((group) =>
      group.ingredients.map((ingredient) => ingredient.name),
    );
    const signal = this.#options.signal;
    const resolution = await this.#stage("ingredients", () =>
      resolver.resolveAll(names, signal ? { signal } : {}),
    );
    // Names skipped for a shutdown were never looked up; record nothing and requeue.
    this.#checkAbort();
    this.#jobs.update(this.#job.id, {
      ingredients: {
        ...resolution.stats,
        unresolvedNames: resolution.unresolvedNames,
        enabled: resolution.enabled,
      },
    });
    this.#event("info", describeResolution(resolution));
    return resolution.ids;
  }

  async #loadImage(recipe: MealieRecipe): Promise<Buffer | null> {
    try {
      const image = await this.#deps.mealie.getRecipeImage(recipe.id);
      this.#event(
        "info",
        image ? `Loaded image (${Math.ceil(image.length / 1024)} KB)` : "The recipe has no image",
      );
      return image;
    } catch (error) {
      this.#event("warn", `Image not loaded, continuing without: ${errorMessage(error)}`);
      return null;
    }
  }

  async #uploadImage(
    image: Buffer | null,
  ): Promise<{ media: McUploadedImage | null; imageSkipped: boolean }> {
    if (!image) return { media: null, imageSkipped: false };
    const prepare = this.#deps.prepareImage ?? prepareRecipeImage;
    let prepared: PreparedRecipeImage;
    try {
      prepared = await prepare(image, this.#deps.limits.recipe.coverPhotoAspect);
    } catch (error) {
      this.#event("warn", `Image skipped: ${errorMessage(error)}`);
      return { media: null, imageSkipped: true };
    }
    const media = await this.#stage("upload", () => this.#deps.mc.uploadImage(prepared));
    this.#event(
      "info",
      `Uploaded image (media ${media.detailsMediaId} and ${media.thumbnailMediaId})`,
    );
    return { media, imageSkipped: false };
  }

  // Returns true when the status change was wanted and failed.
  async #setStatus(recipeId: number): Promise<boolean> {
    if (this.#deps.config.MC_RECIPE_STATUS !== "private-publish") return false;
    try {
      await this.#deps.mc.setStatus(recipeId, "private-publish");
      this.#event("info", "Saved on the device only (private-publish)");
      return false;
    } catch (error) {
      this.#event(
        "warn",
        `Status change failed, the recipe stays a draft and does not show up on the device: ${errorMessage(error)}`,
      );
      if (error instanceof McSessionError) await this.#deps.session?.onSessionError(error.kind);
      return true;
    }
  }

  async #writeBack(
    recipe: MealieRecipe,
    mcRecipeId: number,
    url: string,
    size: { servings: number; servingUnit: string },
    hash: string,
  ): Promise<void> {
    const deps = this.#deps;
    let tag: MealieTagRef | null = null;
    try {
      tag = await deps.mealie.ensureTag(deps.config.TAG_NAME);
    } catch (error) {
      this.#event("warn", `Tag "${deps.config.TAG_NAME}" not available: ${errorMessage(error)}`);
    }
    const now = this.#now();
    try {
      await deps.mealie.patchRecipeMerged(recipe.id, {
        extras: {
          mc_recipe_id: String(mcRecipeId),
          mc_recipe_url: url,
          mc_source_hash: hash,
          mc_synced_at: now.toISOString(),
          mc_servings: String(size.servings),
          mc_serving_unit: size.servingUnit,
        },
        ...(tag ? { addTags: [tag] } : {}),
      });
      this.#event("info", tag ? "Tagged the Mealie recipe and stored the link" : "Stored the link");
    } catch (error) {
      const message =
        error instanceof MealieApiError && error.status === 403
          ? "Mealie refused to update the recipe (403): the bridge user needs edit rights on it. The timeline entry is posted anyway."
          : `Updating the Mealie recipe failed: ${errorMessage(error)}`;
      this.#event("warn", message);
      deps.logger.warn(
        { jobId: this.#job.id, err: errorMessage(error) },
        "Mealie write-back failed",
      );
    }
  }

  async #timeline(subject: string, message: string): Promise<void> {
    const recipeId = this.#recipe?.id ?? this.#job.mealieRecipeId;
    try {
      await this.#deps.mealie.addTimelineEvent(recipeId, {
        subject,
        eventMessage: message,
        eventType: "info",
      });
      this.#event("info", `Timeline entry posted: ${subject}`);
    } catch (error) {
      this.#event("warn", `Timeline entry failed: ${errorMessage(error)}`);
      this.#deps.logger.warn(
        { jobId: this.#job.id, err: errorMessage(error) },
        "Mealie timeline entry failed",
      );
    }
  }

  async #stage<T>(
    stage: FailureStage,
    action: () => T | Promise<T>,
    retryable?: boolean,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new StageError(stage, error, retryable ?? isTransient(error));
    }
  }

  // Appends a progress event every heartbeat while the language model works. Returns the
  // function that stops it.
  #startHeartbeat(): () => void {
    const every = this.#deps.heartbeatMs ?? CONVERT_HEARTBEAT_MS;
    let beats = 0;
    const timer = setInterval(() => {
      beats++;
      this.#event("info", this.#progress.stillConverting(Math.round((beats * every) / 1000)));
    }, every);
    timer.unref();
    return () => clearInterval(timer);
  }

  #elapsedMs(): number | null {
    const started = Date.parse(this.#job.startedAt ?? "");
    return Number.isNaN(started) ? null : Math.max(0, this.#now().getTime() - started);
  }

  #now(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  #checkAbort(): void {
    if (this.#options.signal?.aborted) throw new InterruptedError();
  }

  #event(level: EventLevel, message: string): void {
    this.#jobs.appendEvent(this.#job.id, level, message);
  }
}

// "1 attempt", "3 attempts".
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Monsieur Cuisine says the recipe does not exist (any more).
function isGone(error: unknown): boolean {
  return error instanceof McApiError && (error.status === 404 || error.status === 410);
}

// Monsieur Cuisine answered and turned the request down, so it created nothing.
function isRefusal(error: unknown): boolean {
  return error instanceof McApiError && error.status >= 400 && error.status < 500;
}

// The validated conversion from an earlier attempt of this job, when the recipe has not
// changed since and it is written in the current locale. The stored value was written by
// this code; the checks only guard against a hand-edited or truncated row.
function storedConversion(job: Job, hash: string, locale: string): ConversionResult | null {
  const stored = job.conversion;
  if (!stored || stored.sourceHash !== hash) return null;
  const result = stored.result as Partial<ConversionResult> | null;
  if (
    !result ||
    typeof result !== "object" ||
    !result.recipe ||
    typeof result.recipe !== "object" ||
    typeof result.provider !== "string" ||
    typeof result.model !== "string" ||
    !result.usage ||
    !Array.isArray(result.warnings) ||
    !Array.isArray(result.reviewHints) ||
    result.recipe.locale !== locale
  ) {
    return null;
  }
  return result as ConversionResult;
}
