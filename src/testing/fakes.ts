// Fakes for the network clients and the converter, shared by the service tests.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { vi } from "vitest";
import type { AppLogger } from "../app-logger.js";
import { mcEditorUrl, type McCategory, type McRecipeSink } from "../mc/index.js";
import type { McRecipePayload } from "../mc/types.js";
import {
  mealieRecipeSchema,
  type MealieClient,
  type MealieRecipe,
  type MealieRecipeSummary,
  type MealieTagRef,
  type MealieTimelineEvent,
  type RecipePatch,
  type TimelineEventInput,
} from "../mealie/index.js";
import type { Notifier, SessionMailDetails } from "../notify/email.js";
import type { SessionStatus } from "../session/manager.js";
import type { Job } from "../store/jobs.js";
import type { ConversionRequest, ConversionResult, Converter } from "../pipeline/converter-port.js";
import type { MealiePort } from "../pipeline/run-job.js";
import { loadDeviceLimits } from "../recipe/limits.js";
import type { RecipeInput } from "../recipe/schema.js";

export const RECIPE_ID = "00000000-0000-4000-8000-000000000001";

export const limits = await loadDeviceLimits(
  fileURLToPath(new URL("../../knowledge/device-programs.json", import.meta.url)),
);

export function silentLogger(): AppLogger {
  return pino({ level: "silent" });
}

export function mealieRecipe(overrides: Record<string, unknown> = {}): MealieRecipe {
  const raw = JSON.parse(
    readFileSync(
      new URL("../../test/fixtures/mealie/recipe-structured-v3.28.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return mealieRecipeSchema.parse({ ...raw, ...overrides });
}

export const CATEGORIES: McCategory[] = [
  { id: 228, name: "Suppen & Eintöpfe", order: 2 },
  { id: 260, name: "Hauptgerichte", order: 9 },
  { id: 588, name: "Vegetarisch", order: 0 },
  { id: 308, name: "Desserts", order: 12 },
];

export function convertedRecipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    title: "Kürbis-Linsen-Suppe",
    description: "Cremige Suppe mit roten Linsen.",
    locale: "de-DE",
    complexity: "easy",
    categoryIds: [260],
    servingSize: {
      amount: 4,
      unit: "Portionen",
      preparationTime: 10,
      readyInTime: 35,
      ingredientGroups: [
        {
          name: "",
          ingredients: [
            { name: "Kürbis", amount: 800, unit: "g", isOptional: false },
            { name: "Rote Linsen", amount: 150, unit: "g", isOptional: false },
          ],
        },
      ],
      steps: [
        {
          kind: "text",
          title: "Zutaten einfüllen",
          description: "800 g Kürbis und 150 g Linsen in den Mixbehälter geben.",
        },
        {
          kind: "customized",
          title: "Garen",
          temperature: 100,
          minutes: 20,
          seconds: 0,
          speed: 1,
          rotation: "left",
        },
      ],
    },
    ...overrides,
  };
}

export function conversionResult(overrides: Partial<ConversionResult> = {}): ConversionResult {
  return {
    recipe: convertedRecipe(),
    attempts: 1,
    usage: { inputTokens: 1200, outputTokens: 800, costUsd: 0.0123 },
    warnings: [],
    reviewHints: ["Garzeit der Linsen prüfen"],
    provider: "fake",
    model: "fake-model",
    ...overrides,
  };
}

export interface FakeConverter extends Converter {
  requests: ConversionRequest[];
  signals: Array<AbortSignal | undefined>;
}

export function fakeConverter(
  answer:
    | ConversionResult
    | Error
    | ((req: ConversionRequest) => Promise<ConversionResult>) = conversionResult(),
): FakeConverter {
  const requests: ConversionRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  return {
    requests,
    signals,
    convert: (req, opts) => {
      requests.push(req);
      signals.push(opts?.signal);
      if (typeof answer === "function") return answer(req);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

// Records every call in order as "<client>.<method>".
export type CallLog = string[];

export interface FakeMealie
  extends MealiePort, Pick<MealieClient, "getRecipeThumbnail" | "searchRecipes"> {
  calls: CallLog;
  patches: Array<{ id: string; patch: RecipePatch }>;
  timeline: Array<{ recipeId: string; event: TimelineEventInput }>;
  recipe: MealieRecipe;
}

export interface FakeMealieOptions {
  recipe?: MealieRecipe;
  image?: Buffer | null | Error;
  getRecipe?: Error | Error[];
  ensureTag?: Error;
  patch?: Error;
  timeline?: Error;
  calls?: CallLog;
  // The small image the admin pages show; a WebP header by default.
  thumbnail?: Buffer | null | Error;
  // What the recipe search answers; the fixture recipe by default.
  search?: MealieRecipeSummary[] | Error;
}

// The first bytes of a WebP file, enough for the admin pages to pass the image on.
export const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBPVP8 fake"),
]);

export const TAG: MealieTagRef = {
  id: "tag-1",
  name: "Monsieur Cuisine",
  slug: "monsieur-cuisine",
};

export function fakeMealie(options: FakeMealieOptions = {}): FakeMealie {
  const calls = options.calls ?? [];
  const recipe = options.recipe ?? mealieRecipe();
  const recipeErrors = Array.isArray(options.getRecipe)
    ? [...options.getRecipe]
    : options.getRecipe
      ? [options.getRecipe]
      : [];
  const patches: FakeMealie["patches"] = [];
  const timeline: FakeMealie["timeline"] = [];
  const fail = <T>(error: Error | undefined, value: T): Promise<T> =>
    error ? Promise.reject(error) : Promise.resolve(value);
  return {
    calls,
    patches,
    timeline,
    recipe,
    getRecipe: vi.fn((idOrSlug: string) => {
      calls.push("mealie.getRecipe");
      const error = recipeErrors.shift();
      if (error) return Promise.reject(error);
      return idOrSlug === recipe.id || idOrSlug === recipe.slug
        ? Promise.resolve(recipe)
        : Promise.reject(new Error(`no recipe ${idOrSlug}`));
    }),
    getRecipeThumbnail: vi.fn(() => {
      calls.push("mealie.getRecipeThumbnail");
      const image = options.thumbnail === undefined ? WEBP : options.thumbnail;
      return image instanceof Error ? Promise.reject(image) : Promise.resolve(image);
    }),
    searchRecipes: vi.fn(() => {
      calls.push("mealie.searchRecipes");
      const found = options.search ?? [{ id: recipe.id, slug: recipe.slug, name: recipe.name }];
      return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
    }),
    getRecipeImage: vi.fn(() => {
      calls.push("mealie.getRecipeImage");
      const image = options.image === undefined ? Buffer.from("image-bytes") : options.image;
      return image instanceof Error ? Promise.reject(image) : Promise.resolve(image);
    }),
    ensureTag: vi.fn(() => {
      calls.push("mealie.ensureTag");
      return fail(options.ensureTag, TAG);
    }),
    patchRecipeMerged: vi.fn((id: string, patch: RecipePatch) => {
      calls.push("mealie.patchRecipeMerged");
      patches.push({ id, patch });
      return fail(options.patch, recipe);
    }),
    addTimelineEvent: vi.fn((recipeId: string, event: TimelineEventInput) => {
      calls.push("mealie.addTimelineEvent");
      timeline.push({ recipeId, event });
      const created: MealieTimelineEvent = {
        id: "event-1",
        recipeId,
        subject: event.subject,
        eventType: event.eventType ?? "info",
        eventMessage: event.eventMessage,
        timestamp: null,
        userId: null,
      };
      return fail(options.timeline, created);
    }),
  };
}

export interface FakeMc extends McRecipeSink {
  calls: CallLog;
  payloads: McRecipePayload[];
}

export interface FakeMcOptions {
  categories?: McCategory[] | Error;
  create?: Error;
  upload?: Error | Error[];
  setStatus?: Error;
  user?: Error;
  // What getRecipe answers: an error, or the status of the recipe (default private-publish).
  existing?: Error | string;
  recipeId?: number;
  calls?: CallLog;
}

export function fakeMc(options: FakeMcOptions = {}): FakeMc {
  const calls = options.calls ?? [];
  const payloads: McRecipePayload[] = [];
  const uploadErrors = Array.isArray(options.upload)
    ? [...options.upload]
    : options.upload
      ? [options.upload]
      : [];
  const id = options.recipeId ?? 4242;
  return {
    calls,
    payloads,
    getCurrentUser: vi.fn(() => {
      calls.push("mc.getCurrentUser");
      return options.user
        ? Promise.reject(options.user)
        : Promise.resolve({ id: 1, displayName: "test-user" });
    }),
    getCategories: vi.fn(() => {
      calls.push("mc.getCategories");
      const categories = options.categories ?? CATEGORIES;
      return categories instanceof Error
        ? Promise.reject(categories)
        : Promise.resolve({ source: "proxy" as const, categories });
    }),
    getRecipe: vi.fn((recipeId: number) => {
      calls.push("mc.getRecipe");
      const existing = options.existing ?? "private-publish";
      return existing instanceof Error
        ? Promise.reject(existing)
        : Promise.resolve({ id: recipeId, title: "Kürbis-Linsen-Suppe", status: existing });
    }),
    createRecipe: vi.fn((payload: McRecipePayload) => {
      calls.push("mc.createRecipe");
      payloads.push(payload);
      return options.create
        ? Promise.reject(options.create)
        : Promise.resolve({ id, status: "draft", editorUrl: mcEditorUrl(id) });
    }),
    setStatus: vi.fn((recipeId: number, status: "draft" | "private-publish") => {
      calls.push(`mc.setStatus:${status}`);
      return options.setStatus
        ? Promise.reject(options.setStatus)
        : Promise.resolve({ id: recipeId, status, editorUrl: mcEditorUrl(recipeId) });
    }),
    uploadImage: vi.fn(() => {
      calls.push("mc.uploadImage");
      const error = uploadErrors.shift();
      return error
        ? Promise.reject(error)
        : Promise.resolve({ detailsMediaId: 11, thumbnailMediaId: 12 });
    }),
    editorUrl: (recipeId: number) => mcEditorUrl(recipeId),
  };
}

export interface FakeNotifier extends Notifier {
  sent: Array<{ kind: string; detail: unknown; extra?: unknown }>;
}

export function fakeNotifier(options: { testMail?: Error } = {}): FakeNotifier {
  const sent: FakeNotifier["sent"] = [];
  return {
    sent,
    testMail: vi.fn(() => {
      sent.push({ kind: "test", detail: null });
      return options.testMail ? Promise.reject(options.testMail) : Promise.resolve();
    }),
    sessionExpired: vi.fn((status: SessionStatus, extra?: SessionMailDetails) => {
      sent.push({ kind: "session", detail: status, ...(extra ? { extra } : {}) });
      return Promise.resolve();
    }),
    jobFailed: vi.fn((job: Job, error: string) => {
      sent.push({ kind: "job", detail: { id: job.id, error } });
      return Promise.resolve();
    }),
    healthFailed: vi.fn((error: string) => {
      sent.push({ kind: "health", detail: error });
      return Promise.resolve();
    }),
  };
}

// Stands in for sharp in pipeline tests.
export const fakePrepareImage = vi.fn(() =>
  Promise.resolve({ details: Buffer.from("details"), thumbnail: Buffer.from("thumb") }),
);
