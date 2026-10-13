// One run of a job, from the Mealie recipe to the draft and the report back into Mealie.
//
// Stages: load the recipe and its image, fingerprint it and skip unchanged recipes,
// normalize, scale and render, pick categories, convert, validate, resolve the ingredient
// ids, prepare and upload the image, create the draft, set its status, write back to
// Mealie. Every stage appends a job event.
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
import type { Notifier } from "../notify/email.js";
import { buildMcPayload } from "../recipe/payload.js";
import type { DeviceLimits } from "../recipe/limits.js";
import type { RecipeInput } from "../recipe/schema.js";
import { INTERRUPTED_CREATE, type Job, type JobStore, type EventLevel } from "../store/jobs.js";
import type { McRecipeStore } from "../store/mc-recipes.js";
import type { SettingsStore } from "../store/settings.js";
import type { ConversionResult, Converter } from "./converter-port.js";
import { describeResolution, type IngredientResolverPort } from "./ingredient-resolver.js";
import {
  timelineTexts,
  type FailureStage,
  type TimelineLanguage,
  type TimelineTexts,
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
  TIMELINE_LANGUAGE: TimelineLanguage;
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
  now?: () => Date;
}

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
  #recipe: MealieRecipe | null = null;
  // True from the moment the draft creation request may have reached the server.
  #creating = false;

  constructor(job: Job, deps: RunJobDeps, options: RunJobOptions) {
    this.#job = job;
    this.#deps = deps;
    this.#options = options;
    this.#texts = timelineTexts(deps.config.TIMELINE_LANGUAGE);
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

    const image = await this.#loadImage(recipe);

    const prepared = await this.#stage("prepare", () =>
      prepareRecipe(recipe, job.scale, deps.limits),
    );
    this.#jobs.update(job.id, { servings: prepared.servings });
    const unparsed = prepared.normalized.filter((item) => item.source === "unparsed").length;
    this.#event(
      "info",
      `Prepared ${prepared.normalized.length} ingredients (${unparsed} unparsed) for ${prepared.servings} servings at scale ${job.scale}; source hash ${prepared.hash.slice(0, 12)}`,
    );

    const sent = deps.store.mcRecipes.find(recipe.id, job.scale, prepared.hash);
    if (sent && !job.force) {
      this.#event("info", `Unchanged since ${sent.createdAt}; draft ${sent.mcRecipeId} exists`);
      await this.#timeline(
        this.#texts.unchangedSubject,
        this.#texts.unchanged({ sentAt: sent.createdAt, url: sent.mcRecipeUrl }),
      );
      const skipped = this.#jobs.finish(job.id, "skipped", {
        error: null,
        mcRecipeId: sent.mcRecipeId,
        mcRecipeUrl: sent.mcRecipeUrl,
      });
      return { status: "skipped", job: skipped };
    }
    if (sent) this.#event("info", "Forced: sending again although the recipe is unchanged");

    this.#checkAbort();
    const plan = await this.#stage("categories", () =>
      planCategories(recipe, deps.mc, deps.store.settings, {
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
    const stored = storedConversion(job, prepared.hash);
    let result: ConversionResult;
    if (stored) {
      result = stored;
      this.#event(
        "info",
        `Reusing the conversion from an earlier attempt (${result.provider}/${result.model}); no new LLM call`,
      );
    } else {
      const signal = this.#options.signal;
      result = await this.#stage(
        "convert",
        () =>
          deps.converter.convert(
            conversionRequest(recipe, prepared, plan),
            signal ? { signal } : {},
          ),
        false,
      );
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
        `Converted with ${result.provider}/${result.model} in ${result.attempts} attempt(s) (${usage.inputTokens} input, ${usage.outputTokens} output tokens${cost})`,
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
    if (checked.recipe.servingSize.amount !== prepared.servings) {
      this.#event(
        "warn",
        `The converter set ${checked.recipe.servingSize.amount} servings instead of ${prepared.servings}`,
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
    // The servings the draft carries, which may differ from the requested ones.
    const servings = checked.recipe.servingSize.amount;
    this.#jobs.update(job.id, {
      mcRecipeId: ref.id,
      mcRecipeUrl: ref.editorUrl,
      servings,
      error: null,
    });
    this.#event("info", `Created draft ${ref.id}: ${ref.editorUrl}`);
    deps.logger.info({ jobId: job.id, mcRecipeId: ref.id }, "draft created");

    // The draft exists. Nothing below fails the job.
    const statusFailed = await this.#setStatus(ref.id);
    await this.#writeBack(recipe, ref.id, ref.editorUrl, servings, prepared.hash);
    await this.#timeline(
      this.#texts.createdSubject,
      this.#texts.created({
        url: ref.editorUrl,
        servings,
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
    servings: number,
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
          mc_servings: String(servings),
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

// Monsieur Cuisine answered and turned the request down, so it created nothing.
function isRefusal(error: unknown): boolean {
  return error instanceof McApiError && error.status >= 400 && error.status < 500;
}

// The validated conversion from an earlier attempt of this job, when the recipe has not
// changed since. The stored value was written by this code; the checks only guard against
// a hand-edited or truncated row.
function storedConversion(job: Job, hash: string): ConversionResult | null {
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
    !Array.isArray(result.reviewHints)
  ) {
    return null;
  }
  return result as ConversionResult;
}
