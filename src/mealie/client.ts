// REST client for the parts of the Mealie API the bridge uses: read a recipe and its
// image, attach tags, merge extras and notes, and report back through timeline events and
// comments. Every request authenticates with a long-lived API token as a Bearer header.
// The token is kept in a private field and never logged.

import type { Logger } from "pino";
import type { z } from "zod";
import {
  mealieCommentSchema,
  mealieRecipeSchema,
  mealieTagSchema,
  mealieTimelineEventSchema,
  mealieUserSchema,
  paginated,
  type MealieComment,
  type MealieNote,
  type MealieRecipe,
  type MealieTag,
  type MealieTagRef,
  type MealieTimelineEvent,
  type MealieUser,
  type TimelineEventType,
} from "./types.js";

export type MealieErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "bad_request"
  | "server"
  | "network"
  | "invalid_response"
  | "other";

const STATUS_KINDS: Readonly<Record<number, { kind: MealieErrorKind; hint: string }>> = {
  400: { kind: "bad_request", hint: "Mealie refused the request" },
  401: { kind: "unauthorized", hint: "the API token is missing, invalid or revoked" },
  403: {
    kind: "forbidden",
    hint: "the token user lacks the permission (edit rights on the recipe, or canOrganize for tags)",
  },
  404: { kind: "not_found", hint: "the recipe or resource does not exist" },
  422: { kind: "validation", hint: "Mealie rejected the request body" },
};

export class MealieApiError extends Error {
  // HTTP status, or 0 when no response arrived.
  readonly status: number;
  readonly path: string;
  readonly detail: string;
  readonly kind: MealieErrorKind;

  constructor(options: {
    method: string;
    status: number;
    path: string;
    detail: string;
    kind?: MealieErrorKind;
    hint?: string;
  }) {
    const known = STATUS_KINDS[options.status];
    const kind = options.kind ?? known?.kind ?? (options.status >= 500 ? "server" : "other");
    const hint = options.hint ?? known?.hint ?? "unexpected response";
    const status = options.status > 0 ? ` failed with ${options.status}` : " failed";
    const detail = options.detail ? ` (${options.detail})` : "";
    super(`Mealie ${options.method} ${options.path}${status}: ${hint}${detail}`);
    this.name = "MealieApiError";
    this.status = options.status;
    this.path = options.path;
    this.detail = options.detail;
    this.kind = kind;
  }
}

export interface MealieClientOptions {
  logger?: Pick<Logger, "debug">;
  timeoutMs?: number;
}

export interface RecipePatch {
  // Merged key by key into the existing extras.
  extras?: Record<string, string>;
  // Appended when the recipe does not carry them yet.
  addTags?: readonly MealieTagRef[];
  // Appended after the existing notes. A note with the same title and text is not added
  // again. With replaceSameTitle, the first note with that title gets the new text instead,
  // so a rerun updates the bridge's status note rather than stacking another one.
  notes?: ReadonlyArray<NotePatch>;
}

export interface NotePatch {
  title: string;
  text: string;
  replaceSameTitle?: boolean;
}

export interface TimelineEventInput {
  subject: string;
  eventMessage: string;
  eventType?: TimelineEventType;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string>;
  allowNotFound?: boolean;
}

const MAX_DETAIL = 300;

// Mealie slugs come from python-slugify: ASCII, lower case, words joined by hyphens.
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/ß/g, "ss")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function tagRef(tag: MealieTagRef): MealieTagRef {
  return { id: tag.id, name: tag.name, slug: tag.slug };
}

function noteForPatch(note: MealieNote): { title: string; text: string; referenceId?: string } {
  const kept: { title: string; text: string; referenceId?: string } = {
    title: note.title,
    text: note.text,
  };
  if (note.referenceId) kept.referenceId = note.referenceId;
  return kept;
}

// FastAPI answers {"detail": "..."}, {"detail": {"message": "..."}} or, for validation
// errors, {"detail": [{"loc": [...], "msg": "..."}]}.
function detailOf(body: unknown): string {
  if (typeof body !== "object" || body === null || !("detail" in body)) return "";
  const detail: unknown = body.detail;
  let text = "";
  if (typeof detail === "string") {
    text = detail;
  } else if (Array.isArray(detail)) {
    text = detail
      .map((item: unknown) => {
        if (typeof item !== "object" || item === null) return String(item);
        const loc = "loc" in item && Array.isArray(item.loc) ? item.loc.join(".") : "";
        const msg = "msg" in item && typeof item.msg === "string" ? item.msg : "";
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join("; ");
  } else if (typeof detail === "object" && detail !== null && "message" in detail) {
    text = typeof detail.message === "string" ? detail.message : "";
  }
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;
}

export class MealieClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #logger: Pick<Logger, "debug"> | undefined;
  readonly #timeoutMs: number;

  constructor(
    baseUrl: string,
    token: string,
    fetchImpl: FetchLike = fetch,
    options: MealieClientOptions = {},
  ) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Mealie URL must use http or https");
    }
    if (token.trim() === "") throw new Error("Mealie API token is empty");
    this.baseUrl = url.href.replace(/\/+$/, "");
    this.#token = token.trim();
    this.#fetch = fetchImpl;
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  getSelf(): Promise<MealieUser> {
    return this.#json("GET", "/api/users/self", mealieUserSchema);
  }

  // Accepts a recipe id or slug.
  getRecipe(idOrSlug: string): Promise<MealieRecipe> {
    return this.#json("GET", `/api/recipes/${encodeURIComponent(idOrSlug)}`, mealieRecipeSchema);
  }

  // The full-size image, or null when the recipe has none.
  async getRecipeImage(recipeId: string): Promise<Buffer | null> {
    const path = `/api/media/recipes/${encodeURIComponent(recipeId)}/images/original.webp`;
    const response = await this.#request("GET", path, { allowNotFound: true });
    if (response.status === 404) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  // Returns the tag with this name, creating it when it does not exist yet.
  // Creating a tag needs canOrganize; finding one does not.
  async ensureTag(name: string): Promise<MealieTagRef> {
    const wanted = name.trim();
    if (wanted === "") throw new Error("Tag name is empty");
    const existing = await this.#findTag(wanted);
    if (existing) return existing;
    try {
      const created = await this.#json("POST", "/api/organizers/tags", mealieTagSchema, {
        body: { name: wanted },
      });
      return tagRef(created);
    } catch (error) {
      // Another request may have created the tag in the meantime.
      if (error instanceof MealieApiError && (error.status === 400 || error.status === 409)) {
        const raced = await this.#findTag(wanted);
        if (raced) return raced;
      }
      throw error;
    }
  }

  // PATCH replaces every key it receives, so this reads the recipe, merges locally and
  // sends back only the keys that change. Returns the recipe as Mealie stored it.
  async patchRecipeMerged(idOrSlug: string, patch: RecipePatch): Promise<MealieRecipe> {
    const current = await this.getRecipe(idOrSlug);
    const body: Record<string, unknown> = {};

    if (patch.extras && Object.keys(patch.extras).length > 0) {
      const extras = { ...current.extras, ...patch.extras };
      const changed = Object.entries(patch.extras).some(
        ([key, value]) => current.extras[key] !== value,
      );
      if (changed) body.extras = extras;
    }

    if (patch.addTags && patch.addTags.length > 0) {
      const tags = current.tags.map(tagRef);
      const ids = new Set(tags.map((tag) => tag.id));
      for (const tag of patch.addTags) {
        if (ids.has(tag.id)) continue;
        tags.push(tagRef(tag));
        ids.add(tag.id);
      }
      if (tags.length > current.tags.length) body.tags = tags;
    }

    if (patch.notes && patch.notes.length > 0) {
      const notes = current.notes.map(noteForPatch);
      let changed = false;
      for (const note of patch.notes) {
        if (notes.some((kept) => kept.title === note.title && kept.text === note.text)) continue;
        const same = note.replaceSameTitle
          ? notes.findIndex((kept) => kept.title === note.title)
          : -1;
        const existing = notes[same];
        if (existing) notes[same] = { ...existing, text: note.text };
        else notes.push({ title: note.title, text: note.text });
        changed = true;
      }
      if (changed) body.notes = notes;
    }

    if (Object.keys(body).length === 0) return current;
    return this.#json(
      "PATCH",
      `/api/recipes/${encodeURIComponent(current.id)}`,
      mealieRecipeSchema,
      {
        body,
      },
    );
  }

  // Timeline events need no edit rights and survive a stale save of the recipe page.
  addTimelineEvent(recipeId: string, event: TimelineEventInput): Promise<MealieTimelineEvent> {
    return this.#json("POST", "/api/recipes/timeline/events", mealieTimelineEventSchema, {
      body: {
        recipeId,
        subject: event.subject,
        eventType: event.eventType ?? "info",
        eventMessage: event.eventMessage,
      },
    });
  }

  addComment(recipeId: string, text: string): Promise<MealieComment> {
    if (text.trim() === "") return Promise.reject(new Error("Comment text is empty"));
    return this.#json("POST", "/api/comments", mealieCommentSchema, { body: { recipeId, text } });
  }

  // Searches by name, because Mealie's slugs come from python-slugify with unidecode and a
  // local slug can differ for letters such as ø or æ. The local slug is only a fallback.
  async #findTag(name: string): Promise<MealieTagRef | null> {
    const page = await this.#json("GET", "/api/organizers/tags", paginated(mealieTagSchema), {
      query: { search: name, perPage: "-1" },
    });
    const lower = name.toLowerCase();
    const slug = slugify(name);
    const match =
      page.items.find((tag: MealieTag) => tag.name.toLowerCase() === lower) ??
      page.items.find((tag: MealieTag) => tag.slug === slug);
    return match ? tagRef(match) : null;
  }

  async #json<T extends z.ZodType>(
    method: string,
    path: string,
    schema: T,
    options: RequestOptions = {},
  ): Promise<z.infer<T>> {
    const response = await this.#request(method, path, options);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MealieApiError({
        method,
        status: response.status,
        path,
        detail: "",
        kind: "invalid_response",
        hint: "the response is not JSON",
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new MealieApiError({
        method,
        status: response.status,
        path,
        detail: issues,
        kind: "invalid_response",
        hint: "the response does not have the expected shape",
      });
    }
    return parsed.data;
  }

  async #request(method: string, path: string, options: RequestOptions): Promise<Response> {
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const started = Date.now();
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}${query}`, init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MealieApiError({
        method,
        status: 0,
        path,
        detail: reason,
        kind: "network",
        hint: "no response from Mealie",
      });
    }
    this.#logger?.debug(
      { method, path, status: response.status, ms: Date.now() - started },
      "mealie request",
    );
    if (response.ok || (options.allowNotFound && response.status === 404)) return response;
    let errorBody: unknown = null;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = null;
    }
    throw new MealieApiError({
      method,
      status: response.status,
      path,
      detail: detailOf(errorBody),
    });
  }
}
