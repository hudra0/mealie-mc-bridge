import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McApiError,
  McCategoriesUnavailableError,
  McMediaTimeoutError,
  McNetworkError,
  McSessionError,
  UnsupportedImageError,
  mcEditorUrl,
} from "../mc/index.js";
import { MealieApiError } from "../mealie/index.js";
import {
  CATEGORIES,
  RECIPE_ID,
  TAG,
  conversionResult,
  convertedRecipe,
  fakeConverter,
  fakeMc,
  fakeMealie,
  fakeNotifier,
  fakePrepareImage,
  limits,
  silentLogger,
  type FakeConverter,
  type FakeMc,
  type FakeMealie,
  type FakeMealieOptions,
  type FakeMcOptions,
  type FakeNotifier,
} from "../testing/fakes.js";
import { deLocale, enLocale } from "../testing/locale.js";
import { steppingClock, tempStore, type TempStore } from "../testing/temp.js";
import type { Job } from "../store/jobs.js";
import { createIngredientCatalog } from "../ingredients/catalog.js";
import type { McIngredientSuggestion } from "../mc/index.js";
import { CATEGORY_CACHE_KEY, categoryCacheKey } from "./categories.js";
import { ConverterNotConfiguredError, type Converter } from "./converter-port.js";
import { IngredientResolver, cacheKey, type ResolveMode } from "./ingredient-resolver.js";
import type { PipelineLocale } from "./locale.js";
import { prepareRecipe } from "./prepare.js";
import { isTransient, runJob, type PipelineConfig, type RunJobDeps } from "./run-job.js";

const sessionExpired = () =>
  new McSessionError({
    kind: "expired",
    status: 401,
    code: 110002,
    serverMessage: "ExpiredAuthCookieException",
    endpoint: "POST api/v3/auth/user/recipes/",
  });
const networkError = () =>
  new McNetworkError({ endpoint: "POST proxy", timedOut: false, reason: "TypeError ECONNRESET" });

interface Setup {
  store: TempStore;
  mealie: FakeMealie;
  mc: FakeMc;
  converter: FakeConverter;
  notifier: FakeNotifier;
  session: { onSessionError: ReturnType<typeof vi.fn> };
  deps: RunJobDeps;
  calls: string[];
  claim(options?: { force?: boolean; scale?: number }): Job;
}

let current: Setup | null = null;
afterEach(() => {
  current?.store.dispose();
  current = null;
  fakePrepareImage.mockClear();
});

function setup(
  options: {
    mealie?: FakeMealieOptions;
    mc?: FakeMcOptions;
    converter?: Converter;
    config?: Partial<PipelineConfig>;
    prepareImage?: RunJobDeps["prepareImage"];
    ingredients?: RunJobDeps["ingredients"];
    locale?: PipelineLocale;
  } = {},
): Setup {
  const clock = steppingClock();
  const store = tempStore({ now: clock.now });
  const calls: string[] = [];
  const mealie = fakeMealie({ calls, ...options.mealie });
  const mc = fakeMc({ calls, ...options.mc });
  const converter = (options.converter as FakeConverter | undefined) ?? fakeConverter();
  const notifier = fakeNotifier();
  const session = { onSessionError: vi.fn(() => Promise.resolve()) };
  const deps: RunJobDeps = {
    mealie,
    mc,
    converter,
    limits,
    locale: options.locale ?? deLocale,
    config: {
      MC_RECIPE_STATUS: "private-publish",
      TAG_NAME: "Monsieur Cuisine",
      UI_LANGUAGE: "de",
      ...options.config,
    },
    logger: silentLogger(),
    notifier,
    store,
    session,
    prepareImage: options.prepareImage ?? fakePrepareImage,
    ...(options.ingredients ? { ingredients: options.ingredients } : {}),
    now: clock.now,
  };
  const claim = (claimOptions: { force?: boolean; scale?: number } = {}) => {
    store.jobs.enqueue({
      recipeId: RECIPE_ID,
      scale: claimOptions.scale ?? 1,
      force: claimOptions.force ?? false,
    });
    const job = store.jobs.claimNext();
    if (!job) throw new Error("nothing to claim");
    return job;
  };
  current = { store, mealie, mc, converter, notifier, session, deps, calls, claim };
  return current;
}

const messages = (s: Setup, job: Job) => s.store.jobs.events(job.id).map((event) => event.message);

describe("runJob happy path", () => {
  it("converts, uploads, sets the status and writes back in this order", async () => {
    const s = setup();
    const job = s.claim();
    const outcome = await runJob(job, s.deps);

    expect(outcome.status).toBe("done");
    expect(s.calls).toEqual([
      "mealie.getRecipe",
      "mealie.getRecipeImage",
      "mc.getCategories",
      "mc.uploadImage",
      "mc.createRecipe",
      "mc.setStatus:private-publish",
      "mealie.ensureTag",
      "mealie.patchRecipeMerged",
      "mealie.addTimelineEvent",
    ]);

    // The converter got the scaled recipe and the categories, matched ones first.
    const request = s.converter.requests[0];
    expect(request).toMatchObject({ title: "Kürbis-Linsen-Suppe", servings: 4, locale: "de-DE" });
    expect(request?.rendered).toContain("# Kürbis-Linsen-Suppe");
    expect(request?.ingredients.length).toBeGreaterThan(0);
    expect(request?.categoryHints?.slice(0, 2)).toEqual([
      "228: Suppen & Eintöpfe",
      "588: Vegetarisch",
    ]);

    // The payload is a draft with the merged categories and the uploaded image.
    const payload = s.mc.payloads[0];
    expect(payload?.status).toBe("draft");
    expect(payload?.categoryIds).toEqual([228, 588, 260]);
    expect(payload?.thumbnail.landscapeMediaId).toBe(12);
    expect(payload?.detailsImage.landscapeMediaId).toBe(11);
    expect(fakePrepareImage).toHaveBeenCalledWith(Buffer.from("image-bytes"), {
      width: 16,
      height: 9,
    });

    // Write-back: tag and extras in one merged PATCH.
    const url = mcEditorUrl(4242);
    expect(s.mealie.patches).toEqual([
      {
        id: RECIPE_ID,
        patch: {
          extras: {
            mc_recipe_id: "4242",
            mc_recipe_url: url,
            mc_source_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
            mc_synced_at: expect.stringMatching(/^2026-10-13T/) as string,
            mc_servings: "4",
          },
          addTags: [TAG],
        },
      },
    ]);
    expect(s.mealie.ensureTag).toHaveBeenCalledWith("Monsieur Cuisine");

    // The timeline entry carries the link, servings, model and review hints.
    const entry = s.mealie.timeline[0];
    expect(entry?.recipeId).toBe(RECIPE_ID);
    expect(entry?.event.subject).toBe("Monsieur Cuisine: Rezept privat gespeichert");
    expect(entry?.event.eventType).toBe("info");
    const message = entry?.event.eventMessage ?? "";
    expect(message).toContain(`[Im Editor öffnen](${url})`);
    expect(message).toContain("- Portionen: 4");
    expect(message).toContain("Privat gespeichert");
    expect(message).toContain("- Umgewandelt mit: fake, fake-model");
    expect(message).toContain("**Bitte prüfen:**\n- Garzeit der Linsen prüfen");
    expect(message).toContain("bevor du mit dem Rezept kochst");

    // The job and the sent-recipe record.
    const stored = s.store.jobs.get(job.id);
    expect(stored).toMatchObject({
      status: "done",
      title: "Kürbis-Linsen-Suppe",
      mealieSlug: "kurbis-linsen-suppe",
      servings: 4,
      mcRecipeId: 4242,
      mcRecipeUrl: url,
      provider: "fake",
      model: "fake-model",
      usage: { inputTokens: 1200, outputTokens: 800, costUsd: 0.0123 },
      costUsd: 0.0123,
      error: null,
    });
    expect(stored?.finishedAt).not.toBeNull();
    const hash = s.mealie.patches[0]?.patch.extras?.mc_source_hash ?? "";
    expect(s.store.mcRecipes.find(RECIPE_ID, 1, hash)?.mcRecipeId).toBe(4242);
    expect(messages(s, job)).toEqual(
      expect.arrayContaining([
        "Attempt 1 started",
        'Loaded recipe "Kürbis-Linsen-Suppe" (kurbis-linsen-suppe)',
        "Validation passed",
        `Created draft 4242: ${url}`,
        "Saved on the device only (private-publish)",
        "Done",
      ]),
    );
    expect(s.notifier.sent).toEqual([]);
  });

  it("keeps the draft status without a status call when configured so", async () => {
    const s = setup({ config: { MC_RECIPE_STATUS: "draft" } });
    const outcome = await runJob(s.claim(), s.deps);
    expect(outcome.status).toBe("done");
    expect(s.calls.some((call) => call.startsWith("mc.setStatus"))).toBe(false);
    expect(s.mealie.timeline[0]?.event.eventMessage).toContain("Status: Entwurf");
    expect(s.mealie.timeline[0]?.event.subject).toBe("Monsieur Cuisine: Entwurf erstellt");
  });

  it("scales servings and records them", async () => {
    const s = setup({
      converter: fakeConverter(
        conversionResult({
          recipe: convertedRecipe({
            servingSize: { ...convertedRecipe().servingSize, amount: 6 },
          }),
        }),
      ),
    });
    const job = s.claim({ scale: 1.5 });
    await runJob(job, s.deps);
    expect(s.converter.requests[0]?.servings).toBe(6);
    expect(s.store.jobs.get(job.id)?.servings).toBe(6);
    expect(s.mealie.patches[0]?.patch.extras?.mc_servings).toBe("6");
  });

  it("works without an image", async () => {
    const s = setup({ mealie: { image: null } });
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(s.calls).not.toContain("mc.uploadImage");
    expect(s.mc.payloads[0]?.thumbnail.landscapeMediaId).toBeNull();
    expect(messages(s, job)).toContain("The recipe has no image");
  });

  it("continues without the image when loading it fails", async () => {
    const s = setup({ mealie: { image: new Error("socket hang up") } });
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(s.calls).not.toContain("mc.uploadImage");
    expect(messages(s, job)).toContain("Image not loaded, continuing without: socket hang up");
  });

  it("skips an image it cannot decode and says so in the timeline", async () => {
    const s = setup({
      prepareImage: () => Promise.reject(new UnsupportedImageError("Unsupported image format gif")),
    });
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(s.calls).not.toContain("mc.uploadImage");
    expect(s.mealie.timeline[0]?.event.eventMessage).toContain("Bild: nicht übernommen");
  });

  it("drops category ids the catalog does not know", async () => {
    const s = setup({
      converter: fakeConverter(
        conversionResult({ recipe: convertedRecipe({ categoryIds: [260, 9999] }) }),
      ),
    });
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(s.mc.payloads[0]?.categoryIds).toEqual([228, 588, 260]);
    expect(messages(s, job)).toContain("Dropped category ids the catalog does not know: 9999");
  });

  it("logs converter warnings and a servings mismatch", async () => {
    const s = setup({
      converter: fakeConverter(
        conversionResult({
          warnings: ["Fill level close to the limit"],
          recipe: convertedRecipe({ servingSize: { ...convertedRecipe().servingSize, amount: 3 } }),
        }),
      ),
    });
    const job = s.claim();
    await runJob(job, s.deps);
    expect(messages(s, job)).toEqual(
      expect.arrayContaining([
        "Converter: Fill level close to the limit",
        "The converter set 3 servings instead of 4",
      ]),
    );
    // Mealie records what the draft carries, like the timeline entry.
    expect(s.mealie.patches[0]?.patch.extras?.mc_servings).toBe("3");
    expect(s.store.jobs.get(job.id)?.servings).toBe(3);
  });

  it("uses the cached category catalog on the next run", async () => {
    const s = setup();
    await runJob(s.claim(), s.deps);
    await runJob(s.claim({ force: true }), s.deps);
    expect(s.calls.filter((call) => call === "mc.getCategories")).toHaveLength(1);
    expect(s.store.settings.getJson(CATEGORY_CACHE_KEY)).toMatchObject({ categories: CATEGORIES });
  });
});

describe("runJob progress and logs", () => {
  it("says when the conversion starts and that it is still running", async () => {
    let finish: () => void = () => undefined;
    const converter = fakeConverter(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(conversionResult());
        }),
    );
    const s = setup({ converter });
    s.deps.heartbeatMs = 20;
    const job = s.claim();
    const running = runJob(job, s.deps);
    await vi.waitFor(() => {
      expect(messages(s, job)).toContain("Konvertierung läuft noch, 0 s");
    });
    finish();
    expect((await running).status).toBe("done");
    const lines = messages(s, job);
    const started = lines.indexOf("Konvertierung gestartet");
    expect(started).toBeGreaterThan(lines.findIndex((line) => line.startsWith("Categories:")));
    expect(lines[started + 1]).toBe("Konvertierung läuft noch, 0 s");
    // The heartbeat stops with the conversion.
    const count = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(messages(s, job)).toHaveLength(count);
    expect(converter.requests).toHaveLength(1);
  });

  it("counts the heartbeat in seconds and stops it when the conversion fails", async () => {
    vi.useFakeTimers();
    try {
      let fail: (error: Error) => void = () => undefined;
      const converter = fakeConverter(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      );
      const s = setup({ converter, config: { UI_LANGUAGE: "en" } });
      const job = s.claim();
      const running = runJob(job, s.deps);
      await vi.advanceTimersByTimeAsync(65_000);
      fail(new Error("provider down"));
      await vi.advanceTimersByTimeAsync(0);
      expect((await running).status).toBe("failed");
      const lines = messages(s, job);
      expect(lines).toContain("Conversion started");
      expect(lines.filter((line) => line.startsWith("Still converting"))).toEqual([
        "Still converting, 30 s",
        "Still converting, 60 s",
      ]);
      const count = lines.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(messages(s, job)).toHaveLength(count);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the job id to the converter and logs the finished job", async () => {
    const s = setup();
    const info = vi.spyOn(s.deps.logger, "info");
    const job = s.claim();
    await runJob(job, s.deps);
    expect(s.converter.requests).toHaveLength(1);
    expect(messages(s, job)).toContain(
      "Converted with fake/fake-model in 1 attempt (1200 input, 800 output tokens, $0.0123)",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        status: "done",
        mcRecipeId: 4242,
        costUsd: 0.0123,
        durationMs: expect.any(Number) as number,
      }),
      "job finished",
    );
  });

  it("logs a skipped job with its id", async () => {
    const s = setup();
    await runJob(s.claim(), s.deps);
    const info = vi.spyOn(s.deps.logger, "info");
    const second = s.claim();
    await runJob(second, s.deps);
    expect(info).toHaveBeenCalledWith(
      { jobId: second.id, mcRecipeId: 4242 },
      "job skipped, recipe unchanged",
    );
  });

  it("writes attempts in the plural from two on", async () => {
    const s = setup({ converter: fakeConverter(conversionResult({ attempts: 2 })) });
    const job = s.claim();
    await runJob(job, s.deps);
    expect(messages(s, job).some((line) => line.includes(" in 2 attempts ("))).toBe(true);
  });
});

describe("runJob idempotency", () => {
  it("skips an unchanged recipe and points to the existing draft", async () => {
    const s = setup();
    await runJob(s.claim(), s.deps);
    s.calls.length = 0;

    const second = s.claim();
    const outcome = await runJob(second, s.deps);
    expect(outcome.status).toBe("skipped");
    // No image download: the skip check comes first and only asks Monsieur Cuisine.
    expect(s.calls).toEqual(["mealie.getRecipe", "mc.getRecipe", "mealie.addTimelineEvent"]);
    expect(messages(s, second)).toContain(
      `Unchanged since ${s.store.mcRecipes.find(RECIPE_ID, 1, s.mealie.patches[0]?.patch.extras?.mc_source_hash ?? "")?.createdAt}; recipe 4242 still exists on Monsieur Cuisine (private-publish), skipping`,
    );
    expect(s.converter.requests).toHaveLength(1);
    const entry = s.mealie.timeline.at(-1)?.event;
    expect(entry?.subject).toBe("Monsieur Cuisine: unverändert");
    expect(entry?.eventMessage).toMatch(
      new RegExp(
        `^Unverändert, bereits gesendet am .+: \\[Rezept öffnen\\]\\(${escapeRegExp(mcEditorUrl(4242))}\\)$`,
      ),
    );
    expect(s.store.jobs.get(second.id)).toMatchObject({ status: "skipped", mcRecipeId: 4242 });
  });

  it("converts again when the recipe was deleted on Monsieur Cuisine", async () => {
    const s = setup();
    await runJob(s.claim(), s.deps);
    (s.mc.getRecipe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new McApiError({
        status: 404,
        code: null,
        serverMessage: "Not found",
        endpoint: "GET api/v3/auth/user/recipes/4242",
        data: null,
      }),
    );
    s.calls.length = 0;
    const second = s.claim();
    const outcome = await runJob(second, s.deps);
    expect(outcome.status).toBe("done");
    expect(vi.mocked(s.mc).getRecipe.mock.lastCall).toEqual([4242]);
    expect(s.calls.slice(0, 2)).toEqual(["mealie.getRecipe", "mealie.getRecipeImage"]);
    expect(s.converter.requests).toHaveLength(2);
    const lines = messages(s, second);
    expect(lines.filter((line) => line.includes("no longer exists"))).toEqual([
      expect.stringMatching(
        /, but recipe 4242 no longer exists on Monsieur Cuisine; converting again$/,
      ),
    ]);
  });

  it("skips anyway when Monsieur Cuisine cannot be asked, and says so", async () => {
    const s = setup({ mc: { existing: networkError() } });
    await runJob(s.claim(), s.deps);
    const second = s.claim();
    expect((await runJob(second, s.deps)).status).toBe("skipped");
    expect(messages(s, second).some((line) => line.includes("could not check recipe 4242"))).toBe(
      true,
    );
    expect(s.converter.requests).toHaveLength(1);
  });

  it("links a draft as a draft when Monsieur Cuisine still has it as one", async () => {
    const s = setup({ mc: { existing: "draft" } });
    await runJob(s.claim(), s.deps);
    await runJob(s.claim(), s.deps);
    expect(s.mealie.timeline.at(-1)?.event.eventMessage).toContain("[Entwurf öffnen]");
  });

  it("sends again when forced and remembers the new draft", async () => {
    const s = setup();
    await runJob(s.claim(), s.deps);
    const hash = s.mealie.patches[0]?.patch.extras?.mc_source_hash ?? "";
    (s.mc.createRecipe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 5000,
      status: "draft",
      editorUrl: mcEditorUrl(5000),
    });

    const forced = s.claim({ force: true });
    const outcome = await runJob(forced, s.deps);
    expect(outcome.status).toBe("done");
    expect(s.converter.requests).toHaveLength(2);
    expect(s.store.mcRecipes.find(RECIPE_ID, 1, hash)?.mcRecipeId).toBe(5000);
    expect(messages(s, forced)).toContain("Forced: sending again although the recipe is unchanged");
  });

  it("treats another scale as a different recipe", async () => {
    const s = setup();
    await runJob(s.claim(), s.deps);
    const outcome = await runJob(s.claim({ scale: 2 }), s.deps);
    expect(outcome.status).toBe("done");
    expect(s.converter.requests).toHaveLength(2);
  });
});

describe("runJob failures", () => {
  it("fails a recipe the converter got wrong, posts the error and notifies", async () => {
    const broken = convertedRecipe({
      servingSize: {
        ...convertedRecipe().servingSize,
        steps: [
          { kind: "text", title: "Los", description: "Alles einfüllen." },
          {
            kind: "customized",
            title: "Zu heiß",
            temperature: 999,
            minutes: 5,
            seconds: 0,
            speed: 1,
            rotation: "right",
          },
        ],
      },
    });
    const s = setup({ converter: fakeConverter(conversionResult({ recipe: broken })) });
    const job = s.claim();
    const outcome = await runJob(job, s.deps, { finalAttempt: false });

    expect(outcome).toMatchObject({ status: "failed", stage: "validate" });
    expect(s.calls).not.toContain("mc.createRecipe");
    expect(s.calls).not.toContain("mc.uploadImage");
    const stored = s.store.jobs.get(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toMatch(
      /^The converted recipe failed validation: servingSize\.steps\[1\]/,
    );
    const entry = s.mealie.timeline[0]?.event;
    expect(entry?.subject).toBe("Monsieur Cuisine: Fehler – Prüfung nicht bestanden");
    expect(entry?.eventMessage).toMatch(
      /^Prüfung nicht bestanden: The converted recipe failed validation/,
    );
    expect(entry?.eventMessage).not.toMatch(/\n\s+at /);
    expect(s.notifier.sent).toEqual([
      { kind: "job", detail: { id: job.id, error: stored?.error } },
    ]);
  });

  it("does not retry a converter failure", async () => {
    const s = setup({ converter: fakeConverter(new ConverterNotConfiguredError()) });
    const job = s.claim();
    const outcome = await runJob(job, s.deps, { finalAttempt: false });
    expect(outcome).toMatchObject({
      status: "failed",
      stage: "convert",
      error: "converter not configured",
    });
    expect(s.mealie.timeline[0]?.event.subject).toBe(
      "Monsieur Cuisine: Fehler – Umwandlung fehlgeschlagen",
    );
  });

  it("pauses the job when the session is gone", async () => {
    const s = setup({ mc: { create: sessionExpired() } });
    const job = s.claim();
    const outcome = await runJob(job, s.deps, { finalAttempt: false });
    expect(outcome.status).toBe("session_expired");
    expect(s.store.jobs.get(job.id)?.status).toBe("session_expired");
    expect(s.session.onSessionError).toHaveBeenCalledWith("expired");
    expect(s.mealie.timeline[0]?.event.subject).toBe("Monsieur Cuisine: Sitzung abgelaufen");
    expect(s.notifier.sent).toEqual([]);
  });

  it("pauses on a session error while loading categories", async () => {
    const s = setup({ mc: { categories: sessionExpired() } });
    const outcome = await runJob(s.claim(), s.deps);
    expect(outcome.status).toBe("session_expired");
    expect(s.calls).not.toContain("mc.createRecipe");
  });

  it("asks for a retry on a temporary Mealie failure, and fails on the last attempt", async () => {
    const outage = new MealieApiError({
      method: "GET",
      status: 502,
      path: "/api/recipes/x",
      detail: "",
    });
    const s = setup({ mealie: { getRecipe: [outage, outage] } });
    const job = s.claim();
    const first = await runJob(job, s.deps, { finalAttempt: false });
    expect(first).toMatchObject({ status: "retry", stage: "load" });
    expect(s.store.jobs.get(job.id)?.status).toBe("running");
    expect(s.mealie.timeline).toEqual([]);

    const last = await runJob(job, s.deps, { finalAttempt: true });
    expect(last).toMatchObject({ status: "failed", stage: "load" });
    expect(s.mealie.timeline[0]?.event.subject).toBe(
      "Monsieur Cuisine: Fehler – Rezept nicht lesbar",
    );
  });

  it("fails at once when the recipe does not exist", async () => {
    const missing = new MealieApiError({
      method: "GET",
      status: 404,
      path: "/api/recipes/x",
      detail: "",
    });
    const s = setup({ mealie: { getRecipe: missing } });
    const outcome = await runJob(s.claim(), s.deps, { finalAttempt: false });
    expect(outcome).toMatchObject({ status: "failed", stage: "load" });
  });

  it("retries a temporary image upload failure", async () => {
    const s = setup({ mc: { upload: networkError() } });
    const outcome = await runJob(s.claim(), s.deps, { finalAttempt: false });
    expect(outcome).toMatchObject({ status: "retry", stage: "upload" });
    expect(s.calls).not.toContain("mc.createRecipe");
  });

  it("converts once across retries and reuses the stored conversion", async () => {
    const s = setup({ mc: { upload: [networkError(), networkError()] } });
    let job = s.claim();
    for (const expected of ["retry", "retry", "done"]) {
      const outcome = await runJob(job, s.deps, { finalAttempt: expected === "done" });
      expect(outcome.status).toBe(expected);
      job = s.store.jobs.update(job.id, { attempts: outcome.job.attempts + 1 });
    }
    expect(s.converter.requests).toHaveLength(1);
    expect(messages(s, job).filter((m) => m.startsWith("Reusing the conversion"))).toHaveLength(2);
    expect(s.mc.payloads).toHaveLength(1);
  });

  it("converts again when the recipe changed since the stored conversion", async () => {
    const s = setup({ mc: { upload: networkError() } });
    const job = s.claim();
    await runJob(job, s.deps, { finalAttempt: false });
    s.store.jobs.update(job.id, {
      conversion: { sourceHash: "an older fingerprint", result: conversionResult() },
    });
    const outcome = await runJob(s.store.jobs.get(job.id)!, s.deps);
    expect(outcome.status).toBe("done");
    expect(s.converter.requests).toHaveLength(2);
  });

  it("never retries creating the draft, so a timeout cannot leave two drafts", async () => {
    const s = setup({ mc: { create: networkError() } });
    const outcome = await runJob(s.claim(), s.deps, { finalAttempt: false });
    expect(outcome).toMatchObject({ status: "failed", stage: "upload" });
    expect(outcome).toMatchObject({ error: expect.stringMatching(/check your drafts/) as unknown });
    expect(s.mealie.timeline[0]?.event.subject).toBe(
      "Monsieur Cuisine: Fehler – Hochladen fehlgeschlagen",
    );
  });

  it("does not suggest a hidden draft when Monsieur Cuisine refused the draft", async () => {
    const refused = new McApiError({
      status: 422,
      code: null,
      serverMessage: "invalid",
      endpoint: "POST api/v3/auth/user/recipes/",
    });
    const s = setup({ mc: { create: refused } });
    const outcome = await runJob(s.claim(), s.deps, { finalAttempt: false });
    expect(outcome).toMatchObject({ status: "failed" });
    expect(outcome).not.toMatchObject({
      error: expect.stringMatching(/check your drafts/) as unknown,
    });
  });

  it("retries when no category catalog is available yet", async () => {
    const s = setup({
      mc: { categories: new McCategoriesUnavailableError(networkError(), networkError()) },
    });
    const outcome = await runJob(s.claim(), s.deps, { finalAttempt: false });
    expect(outcome).toMatchObject({ status: "retry", stage: "categories" });
  });

  it("falls back to an old catalog when the fetch fails", async () => {
    const s = setup({ mc: { categories: networkError() } });
    s.store.settings.setJson(CATEGORY_CACHE_KEY, {
      fetchedAt: "2026-01-01T00:00:00.000Z",
      categories: CATEGORIES,
    });
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(messages(s, job)).toContain(
      "Categories: 4 from stale-cache; matched: Suppen & Eintöpfe, Vegetarisch",
    );
  });

  it("marks an unexpected error as such", async () => {
    const s = setup({
      converter: fakeConverter(() => Promise.resolve(null as unknown as never)),
    });
    const outcome = await runJob(s.claim(), s.deps);
    expect(outcome).toMatchObject({ status: "failed", stage: "unexpected" });
    expect(s.mealie.timeline[0]?.event.subject).toBe(
      "Monsieur Cuisine: Fehler – Unerwarteter Fehler",
    );
  });

  it("survives a failing timeline post and a failing notifier", async () => {
    const s = setup({
      converter: fakeConverter(new Error("model refused")),
      mealie: { timeline: new Error("Mealie down") },
    });
    (s.notifier.jobFailed as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("smtp down"),
    );
    const job = s.claim();
    const outcome = await runJob(job, s.deps);
    expect(outcome.status).toBe("failed");
    expect(messages(s, job)).toContain("Timeline entry failed: Mealie down");
  });

  it("scrubs secrets from error texts", async () => {
    const s = setup({
      converter: fakeConverter(
        new Error("upstream said: Cookie: wordpress_logged_in_abc=secret123"),
      ),
    });
    const job = s.claim();
    await runJob(job, s.deps);
    const stored = s.store.jobs.get(job.id);
    expect(stored?.error).not.toContain("secret123");
    expect(s.mealie.timeline[0]?.event.eventMessage).not.toContain("secret123");
  });
});

describe("runJob after the draft exists", () => {
  it("still posts the timeline entry when Mealie refuses the PATCH with 403", async () => {
    const forbidden = new MealieApiError({
      method: "PATCH",
      status: 403,
      path: "/api/recipes/x",
      detail: "",
    });
    const s = setup({ mealie: { patch: forbidden } });
    const job = s.claim();
    const outcome = await runJob(job, s.deps);
    expect(outcome.status).toBe("done");
    expect(s.mealie.timeline[0]?.event.subject).toBe("Monsieur Cuisine: Rezept privat gespeichert");
    expect(messages(s, job)).toContain(
      "Mealie refused to update the recipe (403): the bridge user needs edit rights on it. The timeline entry is posted anyway.",
    );
  });

  it("stores the link without the tag when the tag cannot be created", async () => {
    const forbidden = new MealieApiError({
      method: "POST",
      status: 403,
      path: "/api/organizers/tags",
      detail: "",
    });
    const s = setup({ mealie: { ensureTag: forbidden } });
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(s.mealie.patches[0]?.patch.addTags).toBeUndefined();
    expect(s.mealie.patches[0]?.patch.extras?.mc_recipe_id).toBe("4242");
    expect(messages(s, job)).toContain("Stored the link");
  });

  it("reports other write-back failures as warnings", async () => {
    const s = setup({ mealie: { patch: new Error("connection reset") } });
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(messages(s, job)).toContain("Updating the Mealie recipe failed: connection reset");
  });

  it("finishes when the status change fails, and says the recipe is a draft", async () => {
    const s = setup({ mc: { setStatus: sessionExpired() } });
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(s.session.onSessionError).toHaveBeenCalledWith("expired");
    expect(s.mealie.timeline[0]?.event.eventMessage).toContain(
      "das private Speichern ist fehlgeschlagen",
    );
    expect(s.mealie.timeline[0]?.event.subject).toBe("Monsieur Cuisine: Entwurf erstellt");
  });
});

describe("runJob and shutdown", () => {
  it("puts the job back into the queue when aborted before it starts", async () => {
    const s = setup();
    const job = s.claim();
    const controller = new AbortController();
    controller.abort();
    const outcome = await runJob(job, s.deps, { signal: controller.signal });
    expect(outcome.status).toBe("interrupted");
    expect(s.store.jobs.get(job.id)).toMatchObject({ status: "queued", startedAt: null });
    expect(s.calls).toEqual([]);
  });

  it("passes the signal to the converter and requeues when it aborts", async () => {
    const controller = new AbortController();
    const s = setup({
      converter: fakeConverter(() => {
        controller.abort();
        return Promise.reject(new Error("aborted"));
      }),
    });
    const job = s.claim();
    const outcome = await runJob(job, s.deps, { signal: controller.signal });
    expect(outcome.status).toBe("interrupted");
    expect(s.converter.signals[0]).toBe(controller.signal);
    expect(s.mealie.timeline).toEqual([]);
  });

  it("marks the job before creating the draft", async () => {
    const s = setup();
    const job = s.claim();
    let marked: string | null = null;
    s.mc.createRecipe = vi.fn(() => {
      marked = s.store.jobs.get(job.id)?.createStartedAt ?? null;
      return Promise.resolve({ id: 4242, status: "draft", editorUrl: mcEditorUrl(4242) });
    });
    await runJob(job, s.deps);
    expect(marked).not.toBeNull();
  });

  it("fails instead of requeueing when a shutdown hits the draft creation", async () => {
    const controller = new AbortController();
    const s = setup();
    s.mc.createRecipe = vi.fn(() => {
      controller.abort();
      return Promise.reject(
        new McNetworkError({ endpoint: "POST proxy", timedOut: true, reason: "no response" }),
      );
    });
    const job = s.claim();
    const outcome = await runJob(job, s.deps, { signal: controller.signal });
    expect(outcome.status).toBe("failed");
    expect(s.store.jobs.get(job.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/check your drafts/) as unknown,
    });
  });

  it("finishes the job when the draft is created during a shutdown", async () => {
    const controller = new AbortController();
    const s = setup();
    s.mc.createRecipe = vi.fn(() => {
      controller.abort();
      return Promise.resolve({ id: 4242, status: "draft", editorUrl: mcEditorUrl(4242) });
    });
    const job = s.claim();
    const outcome = await runJob(job, s.deps, { signal: controller.signal });
    expect(outcome.status).toBe("done");
    expect(s.store.jobs.get(job.id)?.mcRecipeId).toBe(4242);
  });
});

describe("runJob ingredient ids", () => {
  const catalog = createIngredientCatalog({
    generatedFrom: "test",
    entries: [
      {
        name: "Kürbis",
        systemIngredientId: 9001,
        officialRecipes: 1,
        memberRecipes: 0,
        category: null,
        alternatives: [],
      },
    ],
  });

  // A resolver on the job's store, with a search that logs into the job's call log.
  function withResolver(
    answer: McIngredientSuggestion[] | Error,
    mode: ResolveMode = "exact",
  ): Setup {
    let resolver: IngredientResolver | null = null;
    const s = setup({
      ingredients: { resolveAll: (names, options) => resolver!.resolveAll(names, options) },
    });
    resolver = new IngredientResolver({
      mode,
      catalog: mode === "exact" ? catalog : null,
      cache: s.store.ingredientCache,
      search: {
        searchIngredients: vi.fn(() => {
          s.calls.push("mc.searchIngredients");
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        }),
      },
      logger: silentLogger(),
      limiter: { take: () => Promise.resolve() },
    });
    return s;
  }

  it("resolves the ids before the image upload and sends them with the draft", async () => {
    const s = withResolver([
      { name: "Rote Linsen, getrocknet", systemIngredientId: 1 },
      { name: "rote linsen", systemIngredientId: 9002 },
    ]);
    const job = s.claim();
    const outcome = await runJob(job, s.deps);

    expect(outcome.status).toBe("done");
    expect(s.calls.indexOf("mc.searchIngredients")).toBeLessThan(s.calls.indexOf("mc.uploadImage"));
    const ingredients = s.mc.payloads[0]?.servingSizes[0]?.ingredientGroups[0]?.ingredients;
    expect(ingredients?.map((item) => [item.name, item.systemIngredientId])).toEqual([
      ["Kürbis", 9001],
      ["Rote Linsen", 9002],
    ]);
    expect(messages(s, job)).toContain(
      "Ingredients resolved: 1 catalog, 0 cache, 1 search, 0 without id",
    );
    expect(s.store.jobs.get(job.id)?.ingredients).toEqual({
      catalog: 1,
      catalogRelaxed: 0,
      cache: 0,
      search: 1,
      unresolved: 0,
      unresolvedNames: [],
      enabled: true,
    });
    expect(s.store.ingredientCache.get(cacheKey("rote linsen"))?.systemIngredientId).toBe(9002);
  });

  it("offers the converter catalog names for the source ingredients", async () => {
    const suggest = vi.fn((names: readonly string[]) =>
      names.map((_, index) => (index === 1 ? ["Kürbis"] : [])),
    );
    const s = setup({
      ingredients: {
        resolveAll: (names) =>
          Promise.resolve({
            ids: new Map(names.map((name) => [name.toLowerCase(), null])),
            stats: { catalog: 0, catalogRelaxed: 0, cache: 0, search: 0, unresolved: names.length },
            unresolvedNames: [...names],
            enabled: true,
          }),
        suggest,
      },
    });
    await runJob(s.claim(), s.deps);
    const request = s.converter.requests[0];
    expect(suggest.mock.calls[0]?.[0]).toEqual(
      request?.ingredients.map((item) => item.food || item.original),
    );
    expect(request?.catalogNames).toEqual([{ index: 1, names: ["Kürbis"] }]);
  });

  it("sends unknown names without an id and keeps them out of the timeline", async () => {
    const s = withResolver([{ name: "Rote Linsen erhitzen", systemIngredientId: 1 }]);
    const job = s.claim();
    await runJob(job, s.deps);

    const ingredients = s.mc.payloads[0]?.servingSizes[0]?.ingredientGroups[0]?.ingredients;
    expect(ingredients?.map((item) => item.systemIngredientId)).toEqual([9001, null]);
    expect(s.store.jobs.get(job.id)?.ingredients).toMatchObject({
      unresolved: 1,
      unresolvedNames: ["Rote Linsen"],
    });
    expect(messages(s, job)).toContain(
      "Ingredients resolved: 1 catalog, 0 cache, 0 search, 1 without id",
    );
    expect(JSON.stringify(s.mealie.timeline)).not.toContain("Rote Linsen");
  });

  it("finishes without the id when the search fails for another reason", async () => {
    const s = withResolver(networkError());
    const job = s.claim();
    expect((await runJob(job, s.deps)).status).toBe("done");
    expect(s.store.jobs.get(job.id)?.ingredients?.unresolvedNames).toEqual(["Rote Linsen"]);
  });

  it("waits for a session when the search reports the session gone", async () => {
    const s = withResolver(sessionExpired());
    const job = s.claim();
    const outcome = await runJob(job, s.deps);
    expect(outcome.status).toBe("session_expired");
    expect(s.calls).not.toContain("mc.uploadImage");
    expect(s.calls).not.toContain("mc.createRecipe");
  });

  it("sends no ids and says so when resolution is off", async () => {
    const s = withResolver([], "off");
    const job = s.claim();
    await runJob(job, s.deps);
    expect(s.calls).not.toContain("mc.searchIngredients");
    const ingredients = s.mc.payloads[0]?.servingSizes[0]?.ingredientGroups[0]?.ingredients;
    expect(ingredients?.map((item) => item.systemIngredientId)).toEqual([null, null]);
    expect(messages(s, job)).toContain(
      "Ingredient ids not resolved (MC_RESOLVE_INGREDIENTS=off): 2 without id",
    );
    expect(s.store.jobs.get(job.id)?.ingredients?.enabled).toBe(false);
  });

  it("requeues without recording counts when a shutdown interrupts resolution", async () => {
    const controller = new AbortController();
    const s = setup({
      ingredients: {
        resolveAll: (names) => {
          controller.abort();
          return Promise.resolve({
            ids: new Map(names.map((name) => [name.toLowerCase(), null])),
            stats: { catalog: 0, catalogRelaxed: 0, cache: 0, search: 0, unresolved: names.length },
            unresolvedNames: [...names],
            enabled: true,
          });
        },
      },
    });
    const job = s.claim();
    const outcome = await runJob(job, s.deps, { signal: controller.signal });
    expect(outcome.status).toBe("interrupted");
    expect(s.store.jobs.get(job.id)).toMatchObject({ status: "queued", ingredients: null });
    expect(messages(s, job).some((message) => message.startsWith("Ingredients resolved"))).toBe(
      false,
    );
    expect(s.calls).not.toContain("mc.createRecipe");
  });

  it("sends no ids and records nothing without a resolver", async () => {
    const s = setup();
    const job = s.claim();
    await runJob(job, s.deps);
    const ingredients = s.mc.payloads[0]?.servingSizes[0]?.ingredientGroups[0]?.ingredients;
    expect(ingredients?.map((item) => item.systemIngredientId)).toEqual([null, null]);
    expect(s.store.jobs.get(job.id)?.ingredients).toBeNull();
  });
});

describe("runJob in another language", () => {
  it("writes an en-US recipe and reports in English with UI_LANGUAGE en", async () => {
    const english = conversionResult({
      recipe: convertedRecipe({
        locale: "en-US",
        title: "Pumpkin lentil soup",
        complexity: "easy",
      }),
      reviewHints: ["Check the cooking time of the lentils"],
    });
    const s = setup({
      locale: enLocale,
      converter: fakeConverter(english),
      config: { UI_LANGUAGE: "en" },
    });
    const job = s.claim();
    const outcome = await runJob(job, s.deps);
    expect(outcome.status).toBe("done");

    // The converter is asked for an en-US recipe with English labels in its input.
    const request = s.converter.requests[0];
    expect(request?.locale).toBe("en-US");
    expect(request?.rendered).toContain("## Ingredients");
    expect(request?.rendered).toContain("- [0] ");

    // The payload carries the language and the complexity ids of the en-US pack.
    const payload = s.mc.payloads[0];
    expect(payload).toMatchObject({ languageLocale: "en-US", complexityId: 22 });

    // The categories are cached per locale.
    expect(s.store.settings.getJson(categoryCacheKey("en-US"))).toMatchObject({
      categories: CATEGORIES,
    });
    expect(s.store.settings.getJson(CATEGORY_CACHE_KEY)).toBeNull();

    // The timeline entry is English.
    const entry = s.mealie.timeline[0]?.event;
    expect(entry?.subject).toBe("Monsieur Cuisine: recipe saved to the device");
    expect(entry?.eventMessage).toContain(`[Open in the editor](${mcEditorUrl(4242)})`);
    expect(entry?.eventMessage).toContain("- Servings: 4");
    expect(entry?.eventMessage).toContain("saved privately, visible on your device only");
    expect(entry?.eventMessage).toContain(
      "**Please check:**\n- Check the cooking time of the lentils",
    );
  });

  it("sends a recipe again after MC_LOCALE changed instead of skipping it", async () => {
    const s = setup();
    await runJob(s.claim(), s.deps);
    const english = fakeConverter(
      conversionResult({ recipe: convertedRecipe({ locale: "en-US" }) }),
    );
    const enDeps: RunJobDeps = { ...s.deps, locale: enLocale, converter: english };

    const outcome = await runJob(s.claim(), enDeps);
    expect(outcome.status).toBe("done");
    expect(english.requests).toHaveLength(1);
    expect(s.mc.payloads.at(-1)).toMatchObject({ languageLocale: "en-US" });
  });

  it("does not reuse a stored conversion written in another locale", async () => {
    const s = setup({ mc: { upload: networkError() } });
    const job = s.claim();
    expect((await runJob(job, s.deps, { finalAttempt: false })).status).toBe("retry");
    const english = fakeConverter(
      conversionResult({ recipe: convertedRecipe({ locale: "en-US" }) }),
    );
    const enDeps: RunJobDeps = { ...s.deps, locale: enLocale, converter: english };
    const retried = s.store.jobs.get(job.id)!;
    // The stored de-DE conversion even carries the fingerprint of the en-US run.
    const hash = prepareRecipe(s.mealie.recipe, 1, limits, enLocale).hash;
    s.store.jobs.update(job.id, {
      conversion: { sourceHash: hash, result: retried.conversion!.result },
    });

    const outcome = await runJob(s.store.jobs.get(job.id)!, enDeps);
    expect(outcome.status).toBe("done");
    expect(english.requests).toHaveLength(1);
    expect(s.mc.payloads.at(-1)).toMatchObject({ languageLocale: "en-US" });
  });

  it("reports a failure and a waiting job in English", async () => {
    const failing = setup({
      locale: enLocale,
      converter: fakeConverter(new Error("model refused")),
      config: { UI_LANGUAGE: "en" },
    });
    await runJob(failing.claim(), failing.deps);
    expect(failing.mealie.timeline[0]?.event.subject).toBe(
      "Monsieur Cuisine: error – conversion failed",
    );
    expect(failing.mealie.timeline[0]?.event.eventMessage).toContain(
      "Conversion failed: model refused",
    );

    const waiting = setup({
      locale: enLocale,
      mc: { create: sessionExpired() },
      converter: fakeConverter(conversionResult({ recipe: convertedRecipe({ locale: "en-US" }) })),
      config: { UI_LANGUAGE: "en" },
    });
    await runJob(waiting.claim(), waiting.deps);
    expect(waiting.mealie.timeline[0]?.event.subject).toBe("Monsieur Cuisine: session expired");
    expect(waiting.mealie.timeline[0]?.event.eventMessage).toContain("The job waits");
  });
});

describe("isTransient", () => {
  it("retries network trouble and server errors only", () => {
    expect(isTransient(networkError())).toBe(true);
    expect(isTransient(new McMediaTimeoutError([1], {}, 10))).toBe(true);
    expect(
      isTransient(new McApiError({ status: 503, code: null, serverMessage: null, endpoint: "x" })),
    ).toBe(true);
    expect(
      isTransient(new McApiError({ status: 400, code: 1, serverMessage: null, endpoint: "x" })),
    ).toBe(false);
    expect(isTransient(sessionExpired())).toBe(false);
    expect(
      isTransient(
        new MealieApiError({ method: "GET", status: 0, path: "/x", detail: "", kind: "network" }),
      ),
    ).toBe(true);
    expect(
      isTransient(new MealieApiError({ method: "GET", status: 500, path: "/x", detail: "" })),
    ).toBe(true);
    expect(
      isTransient(new MealieApiError({ method: "GET", status: 401, path: "/x", detail: "" })),
    ).toBe(false);
    expect(isTransient(new Error("anything else"))).toBe(false);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
