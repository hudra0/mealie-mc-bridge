import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  ImageTooLargeError,
  MAX_IMAGE_BYTES,
  MealieApiError,
  MealieClient,
  slugify,
} from "./client.js";

const TOKEN = "test-token-not-a-secret";
const BASE = "https://mealie.example.com";
const RECIPE_ID = "00000000-0000-4000-8000-000000000001";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/mealie/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fetch stand-in that answers by "METHOD /path" and records every request.
function mockFetch(handlers: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const queues = new Map(
    Object.entries(handlers).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    const entry = queues.get(`${call.method} ${call.path}`);
    const handler = Array.isArray(entry) ? entry.shift() : entry;
    if (!handler)
      return Promise.resolve(json(500, { detail: `unexpected ${call.method} ${call.path}` }));
    return Promise.resolve(handler(call));
  };
  return { fetchImpl, calls };
}

function client(handlers: Record<string, Handler | Handler[]>, logger?: { debug: () => void }) {
  const mock = mockFetch(handlers);
  const instance = new MealieClient(`${BASE}/`, TOKEN, mock.fetchImpl, logger ? { logger } : {});
  return { client: instance, calls: mock.calls };
}

async function caught(promise: Promise<unknown>): Promise<MealieApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MealieApiError) return error;
    throw error;
  }
  throw new Error("expected a MealieApiError");
}

const recipePath = `/api/recipes/${RECIPE_ID}`;
const tagsPath = "/api/organizers/tags";
const mcTag = {
  id: "00000000-0000-4000-8000-000000000399",
  name: "Monsieur Cuisine",
  slug: "monsieur-cuisine",
};

describe("MealieClient reads", () => {
  it("gets a recipe with a Bearer token and parses it", async () => {
    const { client: mealie, calls } = client({
      [`GET ${recipePath}`]: () => json(200, fixture("recipe-structured-v3.28.json")),
    });
    const recipe = await mealie.getRecipe(RECIPE_ID);
    expect(recipe.name).toBe("Kürbis-Linsen-Suppe");
    expect(recipe.tags.map((tag) => tag.slug)).toEqual(["vegetarisch", "herbst"]);
    expect(calls[0]?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("encodes a slug in the path", async () => {
    const { client: mealie, calls } = client({
      "GET /api/recipes/a%20b": () => json(200, { id: RECIPE_ID, slug: "a b" }),
    });
    await mealie.getRecipe("a b");
    expect(calls[0]?.path).toBe("/api/recipes/a%20b");
  });

  it("gets the token user", async () => {
    const { client: mealie } = client({
      "GET /api/users/self": () =>
        json(200, { id: "u1", username: "mc-bridge", canOrganize: true }),
    });
    await expect(mealie.getSelf()).resolves.toMatchObject({
      username: "mc-bridge",
      canOrganize: true,
    });
  });

  it("gets the original image as bytes, or null when there is none", async () => {
    const imagePath = `/api/media/recipes/${RECIPE_ID}/images/original.webp`;
    const { client: mealie } = client({
      [`GET ${imagePath}`]: [
        () => new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 }),
        () => json(404, { detail: "Not Found" }),
        () => json(500, { detail: "boom" }),
      ],
    });
    const image = await mealie.getRecipeImage(RECIPE_ID);
    expect(image).toEqual(Buffer.from("RIFF"));
    await expect(mealie.getRecipeImage(RECIPE_ID)).resolves.toBeNull();
    const error = await caught(mealie.getRecipeImage(RECIPE_ID));
    expect(error).toMatchObject({ status: 500, kind: "server", detail: "boom" });
  });

  it("refuses an image above the size limit, by its header or while reading", async () => {
    const imagePath = `/api/media/recipes/${RECIPE_ID}/images/original.webp`;
    const mock = mockFetch({
      [`GET ${imagePath}`]: [
        () =>
          new Response(new Uint8Array(8), { status: 200, headers: { "content-length": "999" } }),
        () => new Response(new Uint8Array(20), { status: 200 }),
        () => new Response(new Uint8Array(10), { status: 200 }),
      ],
    });
    const mealie = new MealieClient(`${BASE}/`, TOKEN, mock.fetchImpl, { maxImageBytes: 10 });
    await expect(mealie.getRecipeImage(RECIPE_ID)).rejects.toBeInstanceOf(ImageTooLargeError);
    await expect(mealie.getRecipeImage(RECIPE_ID)).rejects.toThrow(
      "The recipe image is larger than 0 MB",
    );
    expect((await mealie.getRecipeImage(RECIPE_ID))?.length).toBe(10);
    expect(MAX_IMAGE_BYTES).toBe(15 * 1024 * 1024);
  });
});

describe("MealieClient.ensureTag", () => {
  it("returns an existing tag found by name", async () => {
    const { client: mealie, calls } = client({
      [`GET ${tagsPath}`]: () =>
        json(200, { page: 1, per_page: -1, total: 1, total_pages: 1, items: [mcTag] }),
    });
    await expect(mealie.ensureTag(" Monsieur Cuisine ")).resolves.toEqual(mcTag);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("search")).toBe("Monsieur Cuisine");
    expect(calls[0]?.query.get("perPage")).toBe("-1");
  });

  it("finds a tag whose server slug differs from the local one", async () => {
    // python-slugify with unidecode turns ø into o; the local slugify drops it.
    const tag = {
      id: "00000000-0000-4000-8000-000000000399",
      name: "Smørrebrød",
      slug: "smorrebrod",
    };
    const { client: mealie, calls } = client({
      [`GET ${tagsPath}`]: () =>
        json(200, { items: [{ id: "x", name: "Smørrebrød-Variante", slug: "sm-rrebr-d" }, tag] }),
    });
    await expect(mealie.ensureTag("smørrebrød")).resolves.toEqual(tag);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the slug when no name matches", async () => {
    const { client: mealie } = client({
      [`GET ${tagsPath}`]: () => json(200, { items: [{ ...mcTag, name: "Monsieur-Cuisine" }] }),
    });
    await expect(mealie.ensureTag("Monsieur Cuisine")).resolves.toMatchObject({ id: mcTag.id });
  });

  it("creates the tag when it does not exist", async () => {
    const { client: mealie, calls } = client({
      [`GET ${tagsPath}`]: () => json(200, { items: [] }),
      [`POST ${tagsPath}`]: () => json(201, { ...mcTag, groupId: "g1", recipeCount: 0 }),
    });
    await expect(mealie.ensureTag("Monsieur Cuisine")).resolves.toEqual(mcTag);
    expect(calls[1]).toMatchObject({ method: "POST", body: { name: "Monsieur Cuisine" } });
    expect(calls[1]?.headers["Content-Type"]).toBe("application/json");
  });

  it("finds the tag again when another request created it first", async () => {
    const { client: mealie } = client({
      [`GET ${tagsPath}`]: [() => json(200, { items: [] }), () => json(200, { items: [mcTag] })],
      [`POST ${tagsPath}`]: () => json(400, { detail: { message: "Tag already exists" } }),
    });
    await expect(mealie.ensureTag("Monsieur Cuisine")).resolves.toEqual(mcTag);
  });

  it("reports a missing canOrganize permission", async () => {
    const { client: mealie } = client({
      [`GET ${tagsPath}`]: () => json(200, { items: [] }),
      [`POST ${tagsPath}`]: () => json(403, { detail: { message: "Permission Denied" } }),
    });
    const error = await caught(mealie.ensureTag("Monsieur Cuisine"));
    expect(error).toMatchObject({ status: 403, kind: "forbidden", path: tagsPath });
  });

  it("rethrows a refused create when the tag still cannot be found", async () => {
    const { client: mealie } = client({
      [`GET ${tagsPath}`]: () => json(200, { items: [] }),
      [`POST ${tagsPath}`]: () => json(400, { detail: "bad" }),
    });
    expect(await caught(mealie.ensureTag("X"))).toMatchObject({ status: 400, kind: "bad_request" });
  });

  it("rejects an empty name", async () => {
    const { client: mealie } = client({});
    await expect(mealie.ensureTag("  ")).rejects.toThrow("Tag name is empty");
  });
});

describe("MealieClient.patchRecipeMerged", () => {
  it("sends merged extras, full tag objects and appended notes", async () => {
    const stored = fixture("recipe-structured-v3.28.json");
    const { client: mealie, calls } = client({
      "GET /api/recipes/kurbis-linsen-suppe": () => json(200, stored),
      [`PATCH ${recipePath}`]: (call) => json(200, { ...stored, ...(call.body as object) }),
    });
    const updated = await mealie.patchRecipeMerged("kurbis-linsen-suppe", {
      extras: { mc_recipe_id: "12345", mc_status: "uploaded" },
      addTags: [mcTag],
      notes: [{ title: "Monsieur Cuisine", text: "Entwurf angelegt." }],
    });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/recipes/kurbis-linsen-suppe",
      `PATCH ${recipePath}`,
    ]);
    const body = calls[1]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["extras", "notes", "tags"]);
    expect(body.extras).toEqual({ source: "family", mc_recipe_id: "12345", mc_status: "uploaded" });
    expect(body.tags).toEqual([
      { id: "00000000-0000-4000-8000-000000000301", name: "Vegetarisch", slug: "vegetarisch" },
      { id: "00000000-0000-4000-8000-000000000302", name: "Herbst", slug: "herbst" },
      mcTag,
    ]);
    expect(body.notes).toEqual([
      {
        title: "Tipp",
        text: "Statt Kokosmilch passt auch **Sahne**.",
        referenceId: "00000000-0000-4000-8000-000000000801",
      },
      { title: "Monsieur Cuisine", text: "Entwurf angelegt." },
    ]);
    expect(updated.extras.mc_status).toBe("uploaded");
  });

  it("keeps v3.25 notes without a referenceId", async () => {
    const stored = fixture("recipe-freetext-v3.25.json");
    const path = "/api/recipes/00000000-0000-4000-8000-000000000002";
    const { client: mealie, calls } = client({
      [`GET ${path}`]: () => json(200, stored),
      [`PATCH ${path}`]: () => json(200, stored),
    });
    await mealie.patchRecipeMerged("00000000-0000-4000-8000-000000000002", {
      notes: [{ title: "MC", text: "ok" }],
    });
    const notes = (calls[1]?.body as { notes: unknown[] }).notes;
    expect(notes[0]).toEqual({
      title: "Aufbewahrung",
      text: "Luftdicht verpackt zwei Tage frisch.",
    });
    expect(notes).toHaveLength(3);
  });

  it("does not stack a note that is sent twice", async () => {
    let stored = fixture("recipe-structured-v3.28.json");
    const { client: mealie, calls } = client({
      [`GET ${recipePath}`]: () => json(200, stored),
      [`PATCH ${recipePath}`]: (call) => {
        stored = { ...stored, ...(call.body as object) };
        return json(200, stored);
      },
    });
    const patch = { notes: [{ title: "Monsieur Cuisine", text: "Entwurf angelegt." }] };
    await mealie.patchRecipeMerged(RECIPE_ID, patch);
    await mealie.patchRecipeMerged(RECIPE_ID, patch);
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(stored.notes).toHaveLength(2);
  });

  it("replaces a note with the same title when asked to", async () => {
    let stored = fixture("recipe-structured-v3.28.json");
    const { client: mealie, calls } = client({
      [`GET ${recipePath}`]: () => json(200, stored),
      [`PATCH ${recipePath}`]: (call) => {
        stored = { ...stored, ...(call.body as object) };
        return json(200, stored);
      },
    });
    const note = (text: string) => ({ title: "Monsieur Cuisine", text, replaceSameTitle: true });
    await mealie.patchRecipeMerged(RECIPE_ID, { notes: [note("Entwurf angelegt.")] });
    await mealie.patchRecipeMerged(RECIPE_ID, { notes: [note("Entwurf erneuert.")] });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH", "GET", "PATCH"]);
    expect(stored.notes).toEqual([
      expect.objectContaining({ title: "Tipp" }),
      { title: "Monsieur Cuisine", text: "Entwurf erneuert." },
    ]);
  });

  it("skips the PATCH when nothing changes", async () => {
    const stored = fixture("recipe-structured-v3.28.json");
    const { client: mealie, calls } = client({ [`GET ${recipePath}`]: () => json(200, stored) });
    const herbst = { id: "00000000-0000-4000-8000-000000000302", name: "Herbst", slug: "herbst" };
    const recipe = await mealie.patchRecipeMerged(RECIPE_ID, {
      extras: { source: "family" },
      addTags: [herbst, herbst],
      notes: [],
    });
    expect(calls).toHaveLength(1);
    expect(recipe.id).toBe(RECIPE_ID);
  });

  it("adds a tag only once when it is requested twice", async () => {
    const stored = fixture("recipe-structured-v3.28.json");
    const { client: mealie, calls } = client({
      [`GET ${recipePath}`]: () => json(200, stored),
      [`PATCH ${recipePath}`]: () => json(200, stored),
    });
    await mealie.patchRecipeMerged(RECIPE_ID, { addTags: [mcTag, mcTag] });
    expect((calls[1]?.body as { tags: unknown[] }).tags).toHaveLength(3);
  });

  it("surfaces a 403 on a locked recipe as MealieApiError", async () => {
    const { client: mealie } = client({
      [`GET ${recipePath}`]: () => json(200, fixture("recipe-structured-v3.28.json")),
      [`PATCH ${recipePath}`]: () =>
        json(403, { detail: { message: "Permission Denied", error: true, exception: null } }),
    });
    const error = await caught(mealie.patchRecipeMerged(RECIPE_ID, { extras: { mc: "1" } }));
    expect(error).toBeInstanceOf(MealieApiError);
    expect(error).toMatchObject({
      status: 403,
      kind: "forbidden",
      path: recipePath,
      detail: "Permission Denied",
    });
    expect(error.message).toContain("PATCH");
  });
});

describe("MealieClient write-back channels", () => {
  it("posts a timeline event with eventMessage", async () => {
    const { client: mealie, calls } = client({
      "POST /api/recipes/timeline/events": (call) =>
        json(201, { id: "e1", ...(call.body as object), timestamp: "2026-10-13T10:00:00Z" }),
    });
    const event = await mealie.addTimelineEvent(RECIPE_ID, {
      subject: "Monsieur Cuisine: Entwurf angelegt",
      eventMessage: "[Entwurf öffnen](https://example.com/recipe/1)",
    });
    expect(calls[0]?.body).toEqual({
      recipeId: RECIPE_ID,
      subject: "Monsieur Cuisine: Entwurf angelegt",
      eventType: "info",
      eventMessage: "[Entwurf öffnen](https://example.com/recipe/1)",
    });
    expect(event).toMatchObject({ id: "e1", eventType: "info" });
  });

  it("passes another event type through", async () => {
    const { client: mealie, calls } = client({
      "POST /api/recipes/timeline/events": (call) =>
        json(201, { id: "e2", ...(call.body as object) }),
    });
    await mealie.addTimelineEvent(RECIPE_ID, {
      subject: "s",
      eventMessage: "m",
      eventType: "system",
    });
    expect(calls[0]?.body).toMatchObject({ eventType: "system" });
  });

  it("posts a comment", async () => {
    const { client: mealie, calls } = client({
      "POST /api/comments": (call) => json(201, { id: "c1", ...(call.body as object) }),
    });
    await expect(mealie.addComment(RECIPE_ID, "Gesendet")).resolves.toMatchObject({ id: "c1" });
    expect(calls[0]?.body).toEqual({ recipeId: RECIPE_ID, text: "Gesendet" });
    await expect(mealie.addComment(RECIPE_ID, " ")).rejects.toThrow("Comment text is empty");
  });
});

describe("MealieClient errors", () => {
  it.each([
    [
      401,
      { detail: "Could not validate credentials" },
      "unauthorized",
      "Could not validate credentials",
    ],
    [404, { detail: { message: "No Entry Found", error: true } }, "not_found", "No Entry Found"],
    [
      422,
      {
        detail: [{ loc: ["body", "tags", 0, "slug"], msg: "Field required" }, { msg: "bad" }, "x"],
      },
      "validation",
      "body.tags.0.slug: Field required; bad; x",
    ],
    [500, "Internal Server Error", "server", ""],
    [418, { detail: 7 }, "other", ""],
  ])("maps status %i to %s", async (status, body, kind, detail) => {
    const { client: mealie } = client({ [`GET ${recipePath}`]: () => json(status, body) });
    expect(await caught(mealie.getRecipe(RECIPE_ID))).toMatchObject({ status, kind, detail });
  });

  it("truncates a long detail", async () => {
    const { client: mealie } = client({
      [`GET ${recipePath}`]: () => json(400, { detail: "x".repeat(400) }),
    });
    expect((await caught(mealie.getRecipe(RECIPE_ID))).detail).toHaveLength(303);
  });

  it("handles an error body that is not JSON", async () => {
    const { client: mealie } = client({
      [`GET ${recipePath}`]: () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    expect(await caught(mealie.getRecipe(RECIPE_ID))).toMatchObject({
      status: 502,
      kind: "server",
      detail: "",
    });
  });

  it("reports a network failure with status 0", async () => {
    const failing = () => Promise.reject(new TypeError("fetch failed"));
    const mealie = new MealieClient(BASE, TOKEN, failing);
    const error = await caught(mealie.getRecipe(RECIPE_ID));
    expect(error).toMatchObject({ status: 0, kind: "network", detail: "fetch failed" });
    const other = new MealieClient(BASE, TOKEN, () =>
      Promise.reject(new Error("x", { cause: "y" })),
    );
    expect((await caught(other.getSelf())).kind).toBe("network");
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const odd = new MealieClient(BASE, TOKEN, () => Promise.reject("socket hang up"));
    expect((await caught(odd.getSelf())).detail).toBe("socket hang up");
  });

  it("reports a response that is not JSON or has the wrong shape", async () => {
    const { client: mealie } = client({
      [`GET ${recipePath}`]: [
        () => new Response("not json", { status: 200 }),
        () => json(200, { slug: "no-id" }),
      ],
    });
    expect(await caught(mealie.getRecipe(RECIPE_ID))).toMatchObject({
      kind: "invalid_response",
      status: 200,
    });
    const shape = await caught(mealie.getRecipe(RECIPE_ID));
    expect(shape).toMatchObject({ kind: "invalid_response" });
    expect(shape.detail).toContain("id");
  });
});

describe("MealieClient token handling", () => {
  it("never puts the token into logs, errors or inspection output", async () => {
    const debug = vi.fn();
    const { client: mealie } = client(
      {
        [`GET ${recipePath}`]: [
          () => json(200, fixture("recipe-structured-v3.28.json")),
          () => json(401, { detail: "Could not validate credentials" }),
        ],
      },
      { debug },
    );
    await mealie.getRecipe(RECIPE_ID);
    const error = await caught(mealie.getRecipe(RECIPE_ID));
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: recipePath, status: 200 }),
      "mealie request",
    );
    const surfaces = [
      JSON.stringify(debug.mock.calls),
      error.message,
      JSON.stringify(error),
      inspect(mealie),
    ];
    for (const text of surfaces) expect(text).not.toContain(TOKEN);
    expect(JSON.stringify(mealie)).not.toContain(TOKEN);
  });

  it("validates the base URL and the token", () => {
    expect(() => new MealieClient("ftp://mealie.example.com", TOKEN)).toThrow("http or https");
    expect(() => new MealieClient(BASE, "  ")).toThrow("token is empty");
    expect(() => new MealieClient("not a url", TOKEN)).toThrow();
    expect(new MealieClient(`${BASE}/mealie//`, TOKEN).baseUrl).toBe(`${BASE}/mealie`);
  });
});

describe("slugify", () => {
  it.each([
    ["Monsieur Cuisine", "monsieur-cuisine"],
    ["Süße Grüße!", "susse-grusse"],
    ["  MC  exportiert  ", "mc-exportiert"],
    ["Crème brûlée", "creme-brulee"],
  ])("turns %j into %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});
