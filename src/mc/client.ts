// Monsieur Cuisine account client: session check, recipe drafts, catalogs and image upload.
//
// Endpoints follow SmartRecipe src/mc/client.ts (MIT, https://github.com/gerkensm/smart-recipe)
// and the recording of the web editor on 2026-10-13: status change by PATCH, update by PUT,
// image upload through a signed storage URL with polling until processing has finished.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionProvider } from "./session.js";
import {
  DEFAULT_LOCALE,
  MC_BASE_URL,
  McApiError,
  McSessionError,
  type HttpMethod,
  type McHttp,
  type McResponse,
} from "./transport.js";
import { isWritableStatus, type McRecipePayload, type McWritableStatus } from "./types.js";

export const MEDIA_READY_STATUS = "3";
export const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;
export const DEFAULT_MEDIA_POLL_INTERVAL_MS = 1_000;

export function mcEditorUrl(id: number): string {
  return `${MC_BASE_URL}/de/create-recipe?devices=mc-smart&recipe-id=${encodeURIComponent(id)}`;
}

export interface McUser {
  id: number;
  displayName: string | null;
}

export interface McRecipeSummary {
  id: number;
  title: string;
  status: string;
  updatedAt: string | null;
}

export interface McRecipeList {
  recipes: McRecipeSummary[];
  total: number;
  totalPages: number;
  page: number;
}

export interface McRecipeRef {
  id: number;
  status: string;
  editorUrl: string;
}

export interface McCategory {
  id: number;
  name: string;
  order: number | null;
}

export interface McCategoryList {
  source: "proxy" | "public";
  categories: McCategory[];
}

export interface McIngredientSuggestion {
  name: string;
  systemIngredientId: number;
}

export interface McUploadedImage {
  detailsMediaId: number;
  thumbnailMediaId: number;
}

export type McImageInput = Uint8Array | { details: Uint8Array; thumbnail: Uint8Array };

export interface ListRecipesOptions {
  statuses?: readonly string[];
  page?: number;
  size?: number;
}

export interface McClientOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  uuid?: () => string;
  mediaTimeoutMs?: number;
  mediaPollIntervalMs?: number;
}

// The server answered, but not in the shape the client expects.
export class McResponseShapeError extends McApiError {
  constructor(endpoint: string, response: McResponse, issues: string) {
    super({
      status: response.status,
      code: response.code,
      serverMessage: response.message || null,
      endpoint,
      message: `${endpoint}: unexpected response shape (${issues})`,
    });
    this.name = "McResponseShapeError";
  }
}

// Neither the proxy nor the public API returned the categories. Both errors are kept, so
// a caller can still tell a network problem from an API failure. A dead session is not
// reported this way: getCategories rethrows the McSessionError instead.
export class McCategoriesUnavailableError extends McApiError {
  readonly proxyError: unknown;
  readonly publicError: unknown;

  constructor(proxyError: unknown, publicError: unknown) {
    const fromPublic = publicError instanceof McApiError ? publicError : null;
    super({
      status: fromPublic?.status ?? 0,
      code: fromPublic?.code ?? null,
      serverMessage: fromPublic?.serverMessage ?? null,
      endpoint: "categories",
      message: `Categories are unavailable. Proxy: ${messageOf(proxyError)}. Public API: ${messageOf(publicError)}`,
    });
    this.name = "McCategoriesUnavailableError";
    this.proxyError = proxyError;
    this.publicError = publicError;
  }
}

// Uploaded images were not processed in time.
export class McMediaTimeoutError extends Error {
  readonly mediaIds: readonly number[];
  readonly statuses: Readonly<Record<number, string | null>>;

  constructor(mediaIds: number[], statuses: Record<number, string | null>, timeoutMs: number) {
    const states = mediaIds.map((id) => `${id}: ${statuses[id] ?? "not listed"}`).join(", ");
    super(`Image processing did not finish within ${timeoutMs} ms (${states})`);
    this.name = "McMediaTimeoutError";
    this.mediaIds = mediaIds;
    this.statuses = statuses;
  }
}

const id = z.number().int().positive();

const userSchema = z.object({ id, displayName: z.string().nullish() });
const usersDataSchema = z.union([z.object({ user: userSchema }), userSchema]);

const recipeListSchema = z.object({
  recipes: z.array(
    z.object({
      id,
      title: z.string().nullish(),
      status: z.string(),
      updatedAt: z.string().nullish(),
    }),
  ),
  total: z.number().int().optional(),
  totalPage: z.number().int().optional(),
  currentPage: z.number().int().optional(),
});

const recipeRecordSchema = z.looseObject({ id, title: z.string(), status: z.string() });
export type McRecipeRecord = z.infer<typeof recipeRecordSchema>;

const recipeRefSchema = z.looseObject({ id, status: z.string() });
// Recipe endpoints answer with data.recipe; a bare recipe is accepted as well.
const recipeRecordData = z.union([
  z.object({ recipe: recipeRecordSchema }).transform((data) => data.recipe),
  recipeRecordSchema,
]);
const recipeRefData = z.union([
  z.object({ recipe: recipeRefSchema }).transform((data) => data.recipe),
  recipeRefSchema,
]);

const categoriesSchema = z.object({
  categories: z.array(
    z.object({ id, name: z.string(), order: z.number().int().nullish() }).loose(),
  ),
});

const ingredientsSchema = z.object({
  ingredients: z.array(z.object({ name: z.string(), systemIngredientId: id })),
});

const uploadUrlSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  mediaId: id,
  extraHeaders: z.record(z.string(), z.string()).nullish(),
});

const mediaSchema = z.object({
  media: z.array(
    z.object({ id, uploadStatus: z.union([z.string(), z.number()]).nullish() }).loose(),
  ),
});

// The part of the client the conversion pipeline uses. Depend on this, not on McClient,
// so pipeline tests can pass a plain fake instead of HTTP envelopes.
export interface McRecipeSink {
  getCurrentUser(): Promise<McUser>;
  getCategories(): Promise<McCategoryList>;
  createRecipe(payload: McRecipePayload): Promise<McRecipeRef>;
  setStatus(recipeId: number, status: McWritableStatus): Promise<McRecipeRef>;
  uploadImage(image: McImageInput): Promise<McUploadedImage>;
  editorUrl(recipeId: number): string;
}

export class McClient implements McRecipeSink {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly mediaTimeoutMs: number;
  private readonly mediaPollIntervalMs: number;

  constructor(
    private readonly transport: McHttp,
    private readonly session: SessionProvider,
    readonly locale: string = DEFAULT_LOCALE,
    options: McClientOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.mediaTimeoutMs = options.mediaTimeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
    this.mediaPollIntervalMs = options.mediaPollIntervalMs ?? DEFAULT_MEDIA_POLL_INTERVAL_MS;
  }

  editorUrl(recipeId: number): string {
    return mcEditorUrl(recipeId);
  }

  // Doubles as the session check: cheap, and it fails with McSessionError on a dead session.
  async getCurrentUser(): Promise<McUser> {
    const endpoint = "api/v1/users";
    const data = parse(usersDataSchema, endpoint, await this.call(endpoint));
    const user = "user" in data ? data.user : data;
    return { id: user.id, displayName: user.displayName ?? null };
  }

  async listRecipes(options: ListRecipesOptions = {}): Promise<McRecipeList> {
    const { statuses = ["draft"], page = 1, size = 20 } = options;
    const filters = statuses.map((status) => `&filters[status][]=${encodeURIComponent(status)}`);
    const endpoint = `api/v3/auth/user/recipes?size=${positive(size)}&page=${positive(page)}${filters.join("")}`;
    const data = parse(recipeListSchema, endpoint, await this.call(endpoint));
    return {
      recipes: data.recipes.map((recipe) => ({
        id: recipe.id,
        title: recipe.title ?? "",
        status: recipe.status,
        updatedAt: recipe.updatedAt ?? null,
      })),
      total: data.total ?? data.recipes.length,
      totalPages: data.totalPage ?? 1,
      page: data.currentPage ?? page,
    };
  }

  async getRecipe(recipeId: number): Promise<McRecipeRecord> {
    const endpoint = `api/v3/auth/user/recipes/${positive(recipeId)}`;
    return parse(recipeRecordData, endpoint, await this.call(endpoint));
  }

  // The server always creates a draft, whatever payload.status says. Use setStatus to make
  // the recipe visible on the device.
  async createRecipe(payload: McRecipePayload): Promise<McRecipeRef> {
    const endpoint = "api/v3/auth/user/recipes/";
    const response = await this.call(endpoint, "POST", payload);
    return this.toRef(parse(recipeRefData, endpoint, response));
  }

  // Replaces the recipe. Sub-objects without their server id are created anew.
  async updateRecipe(recipeId: number, payload: McRecipePayload): Promise<McRecipeRef> {
    const endpoint = `api/v3/auth/user/recipes/${positive(recipeId)}`;
    const response = await this.call(endpoint, "PUT", payload);
    return this.toRef(parse(recipeRefData, endpoint, response));
  }

  // "private-publish" is the editor's "save on my device only". Publishing for everyone
  // ("pending") is refused here on purpose.
  async setStatus(recipeId: number, status: McWritableStatus): Promise<McRecipeRef> {
    if (!isWritableStatus(status)) {
      throw new TypeError(`Refusing to set recipe status "${String(status)}"`);
    }
    const endpoint = `api/v3/auth/user/recipes/${positive(recipeId)}`;
    const response = await this.call(endpoint, "PATCH", { status });
    const echoed = recipeRefData.safeParse(response.data);
    return {
      id: recipeId,
      status: echoed.success ? echoed.data.status : status,
      editorUrl: mcEditorUrl(recipeId),
    };
  }

  // Live categories from the proxy; the public read API serves the same list without login.
  async getCategories(): Promise<McCategoryList> {
    const endpoint = "api/v1/categories";
    let proxyFailure: unknown;
    try {
      const data = parse(categoriesSchema, endpoint, await this.call(endpoint));
      return { source: "proxy", categories: data.categories.map(toCategory) };
    } catch (error) {
      proxyFailure = error;
    }
    const publicPath = "/api/v1/categories";
    try {
      const response = await this.transport.publicGet(publicPath, this.locale);
      const data = parse(categoriesSchema, `public GET ${publicPath}`, response);
      return { source: "public", categories: data.categories.map(toCategory) };
    } catch (error) {
      // A dead session needs a new cookie, whatever the public API did.
      if (proxyFailure instanceof McSessionError) throw proxyFailure;
      throw new McCategoriesUnavailableError(proxyFailure, error);
    }
  }

  // Suggestions from the ingredient catalog. A matching systemIngredientId lets the device
  // show the ingredient icon.
  async searchIngredients(query: string): Promise<McIngredientSuggestion[]> {
    const q = query.trim();
    if (q === "") return [];
    const endpoint = `api/v1/ingredients/quick-search?q=${encodeURIComponent(q)}&count=20`;
    return parse(ingredientsSchema, endpoint, await this.call(endpoint)).ingredients;
  }

  // Uploads the cover image in the two variants the recipe references and waits until the
  // server has processed both. A single buffer is used for both variants.
  async uploadImage(image: McImageInput): Promise<McUploadedImage> {
    const { details, thumbnail } =
      image instanceof Uint8Array ? { details: image, thumbnail: image } : image;
    const base = this.uuid();
    const detailsMediaId = await this.uploadOne(`${base}_details.jpeg`, details);
    const thumbnailMediaId = await this.uploadOne(`${base}_thumbnail.jpeg`, thumbnail);
    await this.waitForMedia([detailsMediaId, thumbnailMediaId]);
    return { detailsMediaId, thumbnailMediaId };
  }

  private async uploadOne(fileName: string, bytes: Uint8Array): Promise<number> {
    const endpoint = "api/v1/media/image/upload-url";
    const response = await this.call(endpoint, "POST", { fileName, mimeType: "image/jpeg" });
    const target = parse(uploadUrlSchema, endpoint, response);
    await this.transport.putSignedUrl(target.url, bytes, "image/jpeg", target.extraHeaders ?? {});
    return target.mediaId;
  }

  private async waitForMedia(mediaIds: number[]): Promise<void> {
    const endpoint = `api/v1/media?${mediaIds.map((mediaId) => `ids[]=${mediaId}`).join("&")}`;
    const deadline = this.now() + this.mediaTimeoutMs;
    for (;;) {
      const { media } = parse(mediaSchema, endpoint, await this.call(endpoint));
      const statuses: Record<number, string | null> = {};
      for (const entry of media) {
        statuses[entry.id] = entry.uploadStatus == null ? null : String(entry.uploadStatus);
      }
      if (mediaIds.every((mediaId) => statuses[mediaId] === MEDIA_READY_STATUS)) return;
      if (this.now() + this.mediaPollIntervalMs > deadline) {
        throw new McMediaTimeoutError(mediaIds, statuses, this.mediaTimeoutMs);
      }
      await this.sleep(this.mediaPollIntervalMs);
    }
  }

  private toRef(recipe: { id: number; status: string }): McRecipeRef {
    return { id: recipe.id, status: recipe.status, editorUrl: mcEditorUrl(recipe.id) };
  }

  // Every account call goes through here, so a rejected session always reaches the provider.
  private async call(endpoint: string, method: HttpMethod = "GET", payload?: unknown) {
    const cookie = await this.session.getCookie();
    if (cookie === null) {
      await this.session.onSessionError("invalid");
      throw new McSessionError({
        kind: "invalid",
        status: 0,
        code: null,
        serverMessage: null,
        endpoint: `${method} ${endpoint}`,
        message: `${method} ${endpoint}: no Monsieur Cuisine session cookie is configured`,
      });
    }
    try {
      return await this.transport.proxy({ endpoint, method, payload, cookie, lang: this.locale });
    } catch (error) {
      if (error instanceof McSessionError) await this.session.onSessionError(error.kind);
      throw error;
    }
  }
}

function parse<T extends z.ZodType>(
  schema: T,
  endpoint: string,
  response: McResponse,
): z.output<T> {
  const result = schema.safeParse(response.data);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "data"}: ${issue.message}`)
    .join("; ");
  throw new McResponseShapeError(endpoint, response, issues);
}

function toCategory(category: { id: number; name: string; order?: number | null | undefined }) {
  return { id: category.id, name: decodeEntities(category.name), order: category.order ?? null };
}

// Category names arrive HTML-encoded ("Suppen &amp; Eintöpfe").
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity: string, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return named[body.toLowerCase()] ?? entity;
  });
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Expected a positive integer, got ${String(value)}`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
