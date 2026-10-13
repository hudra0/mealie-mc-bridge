import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  McCategoriesUnavailableError,
  McClient,
  McMediaTimeoutError,
  McResponseShapeError,
  mcEditorUrl,
  type McClientOptions,
  type McRecipeSink,
} from "./client.js";
import { StaticSessionProvider, type SessionProvider } from "./session.js";
import {
  McApiError,
  McSessionError,
  McTransport,
  type FetchLike,
  type McHttp,
  type ProxyRequest,
} from "./transport.js";
import type { McRecipePayload } from "./types.js";

const COOKIE = "wordpress_logged_in_0123=synthetic; lidl_sso_id_token=synthetic";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/mc/${name}`, import.meta.url), "utf8"));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function setup(responses: Response[], options: McClientOptions = {}, session?: SessionProvider) {
  const calls: Call[] = [];
  const fetch = vi.fn<FetchLike>((url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : init.body,
    });
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("unexpected fetch call"));
  });
  const provider = session ?? new StaticSessionProvider(COOKIE);
  const client = new McClient(new McTransport({ fetch }), provider, "de-DE", options);
  return { client, calls, fetch, provider };
}

// The proxy envelope of the n-th call.
const proxied = (calls: Call[], index: number) =>
  calls[index]?.body as { endpoint: string; method: string; payload?: unknown };

const minimalPayload = { title: "x" } as unknown as McRecipePayload;

describe("McClient with a fake transport", () => {
  it("needs only the McHttp interface", async () => {
    const requests: ProxyRequest[] = [];
    const http: McHttp = {
      proxy: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: 200,
          code: 0,
          message: "",
          data: { user: { id: 42, displayName: null } },
        });
      },
      publicGet: () => Promise.reject(new Error("not used")),
      putSignedUrl: () => Promise.reject(new Error("not used")),
    };
    const sink: McRecipeSink = new McClient(http, new StaticSessionProvider(COOKIE));
    await expect(sink.getCurrentUser()).resolves.toEqual({ id: 42, displayName: null });
    expect(requests).toEqual([
      {
        endpoint: "api/v1/users",
        method: "GET",
        payload: undefined,
        cookie: COOKIE,
        lang: "de-DE",
      },
    ]);
  });
});

describe("McClient session handling", () => {
  it("refuses to call without a cookie and reports an invalid session", async () => {
    const listener = vi.fn();
    const { client, fetch } = setup([], {}, new StaticSessionProvider(null, listener));
    const error = await client.getCurrentUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McSessionError);
    expect(error).toMatchObject({ kind: "invalid", status: 0, endpoint: "GET api/v1/users" });
    expect(listener).toHaveBeenCalledWith("invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tells the session provider when the server rejects the cookie", async () => {
    const listener = vi.fn();
    const { client } = setup(
      [json(401, fixture("error-expired-cookie.json"))],
      {},
      new StaticSessionProvider(COOKIE, listener),
    );
    await expect(client.getCurrentUser()).rejects.toMatchObject({ kind: "expired" });
    expect(listener).toHaveBeenCalledWith("expired");
  });

  it("does not report other API errors as session errors", async () => {
    const listener = vi.fn();
    const { client } = setup(
      [json(400, fixture("error-validation.json"))],
      {},
      new StaticSessionProvider(COOKIE, listener),
    );
    await expect(client.createRecipe(minimalPayload)).rejects.toMatchObject({ code: 40004 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("McClient.getCurrentUser", () => {
  it("returns id and display name", async () => {
    const { client, calls } = setup([json(200, fixture("users.json"))]);
    await expect(client.getCurrentUser()).resolves.toEqual({
      id: 1000001,
      displayName: "test-user",
    });
    expect(proxied(calls, 0)).toEqual({ endpoint: "api/v1/users", method: "GET", lang: "de-DE" });
    expect(calls[0]?.headers.Cookie).toBe(COOKIE);
  });

  it("accepts a bare user object", async () => {
    const { client } = setup([json(200, { code: 0, data: { id: 5 } })]);
    await expect(client.getCurrentUser()).resolves.toEqual({ id: 5, displayName: null });
  });

  it("raises a shape error for an unexpected answer", async () => {
    const { client } = setup([json(200, { code: 0, data: { user: { name: "x" } } })]);
    const error = await client.getCurrentUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McResponseShapeError);
    expect((error as Error).message).toMatch(/^api\/v1\/users: unexpected response shape/);
  });
});

describe("McClient recipes", () => {
  it("lists recipes with status filters", async () => {
    const { client, calls } = setup([json(200, fixture("recipes-list.json"))]);
    const list = await client.listRecipes({
      statuses: ["draft", "private-publish"],
      page: 2,
      size: 10,
    });
    expect(proxied(calls, 0).endpoint).toBe(
      "api/v3/auth/user/recipes?size=10&page=2&filters[status][]=draft&filters[status][]=private-publish",
    );
    expect(list.total).toBe(3);
    expect(list.totalPages).toBe(1);
    expect(list.page).toBe(1);
    expect(list.recipes).toHaveLength(3);
    expect(list.recipes[0]).toEqual({
      id: 900001,
      title: "Bridge Test Alle Modi",
      status: "draft",
      updatedAt: expect.any(String) as unknown,
    });
  });

  it("lists drafts by default and fills missing totals", async () => {
    const { client, calls } = setup([
      json(200, { code: 0, data: { recipes: [{ id: 1, status: "draft" }] } }),
    ]);
    const list = await client.listRecipes();
    expect(proxied(calls, 0).endpoint).toBe(
      "api/v3/auth/user/recipes?size=20&page=1&filters[status][]=draft",
    );
    expect(list).toEqual({
      recipes: [{ id: 1, title: "", status: "draft", updatedAt: null }],
      total: 1,
      totalPages: 1,
      page: 1,
    });
  });

  it("gets a recipe", async () => {
    const { client, calls } = setup([json(200, fixture("recipe-get.json"))]);
    const recipe = await client.getRecipe(900002);
    expect(proxied(calls, 0)).toMatchObject({
      endpoint: "api/v3/auth/user/recipes/900002",
      method: "GET",
    });
    expect(recipe).toMatchObject({ id: 900002, title: "Bridge Test Editor", status: "draft" });
    expect(recipe.servingSizes).toBeInstanceOf(Array);
  });

  it("rejects ids that are not positive integers", async () => {
    const { client, fetch } = setup([]);
    await expect(client.getRecipe(0)).rejects.toThrow(TypeError);
    await expect(client.getRecipe(1.5)).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates a recipe and returns id, status and editor link", async () => {
    const { client, calls } = setup([json(201, fixture("recipe-create.json"))]);
    const created = await client.createRecipe(minimalPayload);
    expect(proxied(calls, 0)).toEqual({
      endpoint: "api/v3/auth/user/recipes/",
      method: "POST",
      lang: "de-DE",
      payload: minimalPayload,
    });
    expect(created).toEqual({
      id: 900002,
      status: "draft",
      editorUrl:
        "https://www.monsieur-cuisine.com/de/create-recipe?devices=mc-smart&recipe-id=900002",
    });
  });

  it("accepts a bare recipe in the create answer", async () => {
    const { client } = setup([json(201, { code: 0, data: { id: 7, status: "draft" } })]);
    await expect(client.createRecipe(minimalPayload)).resolves.toMatchObject({ id: 7 });
  });

  it("updates a recipe with PUT", async () => {
    const { client, calls } = setup([json(200, fixture("recipe-update.json"))]);
    const updated = await client.updateRecipe(900002, minimalPayload);
    expect(proxied(calls, 0)).toMatchObject({
      endpoint: "api/v3/auth/user/recipes/900002",
      method: "PUT",
      payload: minimalPayload,
    });
    expect(updated).toMatchObject({ id: 900002, status: "draft" });
  });

  it("sets the status with PATCH", async () => {
    const { client, calls } = setup([json(200, fixture("recipe-status.json"))]);
    const result = await client.setStatus(900002, "private-publish");
    expect(proxied(calls, 0)).toEqual({
      endpoint: "api/v3/auth/user/recipes/900002",
      method: "PATCH",
      lang: "de-DE",
      payload: { status: "private-publish" },
    });
    expect(result).toEqual({
      id: 900002,
      status: "private-publish",
      editorUrl: mcEditorUrl(900002),
    });
  });

  it("falls back to the requested status when the answer does not echo it", async () => {
    const { client } = setup([json(200, { code: 0, message: "ok", data: null })]);
    await expect(client.setStatus(3, "draft")).resolves.toMatchObject({ id: 3, status: "draft" });
  });

  it("refuses to submit a recipe for publication", async () => {
    const { client, fetch } = setup([]);
    await expect(client.setStatus(3, "pending" as "draft")).rejects.toThrow(
      'Refusing to set recipe status "pending"',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds editor links", () => {
    const { client } = setup([]);
    expect(client.editorUrl(42)).toBe(
      "https://www.monsieur-cuisine.com/de/create-recipe?devices=mc-smart&recipe-id=42",
    );
  });
});

describe("McClient.getCategories", () => {
  it("reads the live list through the proxy", async () => {
    const { client, calls } = setup([json(200, fixture("categories.json"))]);
    const result = await client.getCategories();
    expect(proxied(calls, 0).endpoint).toBe("api/v1/categories");
    expect(result.source).toBe("proxy");
    expect(result.categories).toHaveLength(25);
    expect(result.categories).toContainEqual({ id: 588, name: "Vegetarisch", order: 0 });
  });

  it("falls back to the public API and decodes HTML entities", async () => {
    const { client, calls } = setup([
      json(500, { code: 1, message: "Internal", data: null }),
      json(200, {
        code: 0,
        data: {
          categories: [
            { id: 228, name: "Suppen &amp; Eintöpfe", order: 3 },
            { id: 1, name: "&lt;A&gt; &quot;B&quot; &#39;C&#x27; &unknown;" },
          ],
        },
      }),
    ]);
    const result = await client.getCategories();
    expect(calls[1]?.url).toBe("https://mc-api.tecpal.com/api/v1/categories");
    expect(calls[1]?.headers).not.toHaveProperty("Cookie");
    expect(result).toEqual({
      source: "public",
      categories: [
        { id: 228, name: "Suppen & Eintöpfe", order: 3 },
        { id: 1, name: "<A> \"B\" 'C' &unknown;", order: null },
      ],
    });
  });

  it("uses the public API when no session is configured", async () => {
    const { client, calls } = setup(
      [json(200, fixture("categories.json"))],
      {},
      new StaticSessionProvider(null),
    );
    await expect(client.getCategories()).resolves.toMatchObject({ source: "public" });
    expect(calls).toHaveLength(1);
  });

  it("keeps both failures when neither source answers", async () => {
    const { client } = setup([
      json(500, { code: 1, message: "Internal", data: null }),
      json(503, { code: 1, message: "Unavailable", data: null }),
    ]);
    const error = await client.getCategories().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McCategoriesUnavailableError);
    expect(error).toBeInstanceOf(McApiError);
    expect((error as Error).message).toMatch(
      /^Categories are unavailable\. Proxy: GET api\/v1\/categories: HTTP 500.*Public API: public GET \/api\/v1\/categories: HTTP 503/,
    );
    const { proxyError, publicError } = error as McCategoriesUnavailableError;
    expect(proxyError).toMatchObject({ name: "McApiError", status: 500 });
    expect(publicError).toMatchObject({ name: "McApiError", status: 503 });
    expect(error).toMatchObject({ status: 503, code: 1 });
  });

  it("rethrows a dead session when the public API fails as well", async () => {
    const listener = vi.fn();
    const { client } = setup(
      [
        json(401, fixture("error-invalid-cookie.json")),
        json(503, { code: 1, message: "Unavailable", data: null }),
      ],
      {},
      new StaticSessionProvider(COOKIE, listener),
    );
    const error = await client.getCategories().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McSessionError);
    expect(error).toMatchObject({ kind: "invalid", endpoint: "GET api/v1/categories" });
    expect(listener).toHaveBeenCalledWith("invalid");
  });
});

describe("McClient.searchIngredients", () => {
  it("queries the ingredient catalog", async () => {
    const { client, calls } = setup([json(200, fixture("ingredients-quick-search.json"))]);
    const suggestions = await client.searchIngredients(" Mehl & Salz ");
    expect(proxied(calls, 0).endpoint).toBe(
      "api/v1/ingredients/quick-search?q=Mehl%20%26%20Salz&count=20",
    );
    expect(suggestions).toHaveLength(20);
    expect(suggestions[0]).toEqual({ name: "Mehl", systemIngredientId: 242292 });
  });

  it("skips the call for an empty query", async () => {
    const { client, fetch } = setup([]);
    await expect(client.searchIngredients("   ")).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("McClient.uploadImage", () => {
  const ok = () => new Response(null, { status: 200 });

  function clock() {
    let now = 0;
    const sleep = vi.fn((ms: number) => {
      now += ms;
      return Promise.resolve();
    });
    return { now: () => now, sleep };
  }

  it("requests two upload URLs, puts the bytes and waits for processing", async () => {
    const { now, sleep } = clock();
    const { client, calls } = setup(
      [
        json(201, fixture("media-upload-url-details.json")),
        ok(),
        json(201, fixture("media-upload-url-thumbnail.json")),
        ok(),
        json(200, fixture("media-pending.json")),
        json(200, fixture("media-ready.json")),
      ],
      { now, sleep, uuid: () => "11111111-2222-4333-8444-555555555555" },
    );
    const details = new Uint8Array([1, 2, 3]);
    const thumbnail = new Uint8Array([4, 5]);

    const result = await client.uploadImage({ details, thumbnail });

    expect(result).toEqual({ detailsMediaId: 700002, thumbnailMediaId: 700001 });
    expect(proxied(calls, 0)).toEqual({
      endpoint: "api/v1/media/image/upload-url",
      method: "POST",
      lang: "de-DE",
      payload: {
        fileName: "11111111-2222-4333-8444-555555555555_details.jpeg",
        mimeType: "image/jpeg",
      },
    });
    expect(calls[1]).toMatchObject({
      url: "https://storage.example.com/upload/sample-details.jpeg?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=synthetic",
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: details,
    });
    expect(calls[1]?.headers).not.toHaveProperty("Cookie");
    expect(proxied(calls, 2).payload).toEqual({
      fileName: "11111111-2222-4333-8444-555555555555_thumbnail.jpeg",
      mimeType: "image/jpeg",
    });
    expect(calls[3]).toMatchObject({ method: "PUT", body: thumbnail });
    expect(proxied(calls, 4).endpoint).toBe("api/v1/media?ids[]=700002&ids[]=700001");
    expect(proxied(calls, 5).endpoint).toBe("api/v1/media?ids[]=700002&ids[]=700001");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("uses one buffer for both variants", async () => {
    const { now, sleep } = clock();
    const { client, calls } = setup(
      [
        json(201, fixture("media-upload-url-details.json")),
        ok(),
        json(201, fixture("media-upload-url-thumbnail.json")),
        ok(),
        json(200, fixture("media-ready.json")),
      ],
      { now, sleep },
    );
    const bytes = new Uint8Array([9]);
    await client.uploadImage(bytes);
    expect(calls[1]?.body).toBe(bytes);
    expect(calls[3]?.body).toBe(bytes);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after 30 seconds of polling", async () => {
    const { now, sleep } = clock();
    const pending = () =>
      json(200, { code: 0, data: { media: [{ id: 700002, uploadStatus: "1" }] } });
    const { client } = setup(
      [
        json(201, fixture("media-upload-url-details.json")),
        ok(),
        json(201, fixture("media-upload-url-thumbnail.json")),
        ok(),
        ...Array.from({ length: 31 }, pending),
      ],
      { now, sleep },
    );
    const error = await client.uploadImage(new Uint8Array([1])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McMediaTimeoutError);
    expect(error).toMatchObject({
      mediaIds: [700002, 700001],
      statuses: { 700002: "1" },
      message: "Image processing did not finish within 30000 ms (700002: 1, 700001: not listed)",
    });
    expect(sleep).toHaveBeenCalledTimes(30);
  });

  it("accepts a numeric upload status", async () => {
    const { now, sleep } = clock();
    const { client } = setup(
      [
        json(201, fixture("media-upload-url-details.json")),
        ok(),
        json(201, fixture("media-upload-url-thumbnail.json")),
        ok(),
        json(200, {
          code: 0,
          data: {
            media: [
              { id: 700002, uploadStatus: 3 },
              { id: 700001, uploadStatus: 3 },
            ],
          },
        }),
      ],
      { now, sleep },
    );
    await expect(client.uploadImage(new Uint8Array([1]))).resolves.toEqual({
      detailsMediaId: 700002,
      thumbnailMediaId: 700001,
    });
  });

  it("refuses an upload URL that is not https", async () => {
    const { client, calls } = setup([
      json(201, { code: 0, data: { url: "http://storage.example.com/x", mediaId: 1 } }),
    ]);
    await expect(client.uploadImage(new Uint8Array([1]))).rejects.toBeInstanceOf(
      McResponseShapeError,
    );
    expect(calls).toHaveLength(1);
  });

  it("uses real timers by default", async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup([
        json(201, fixture("media-upload-url-details.json")),
        ok(),
        json(201, fixture("media-upload-url-thumbnail.json")),
        ok(),
        json(200, fixture("media-pending.json")),
        json(200, fixture("media-ready.json")),
      ]);
      const upload = client.uploadImage(new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(1000);
      await expect(upload).resolves.toEqual({ detailsMediaId: 700002, thumbnailMediaId: 700001 });
    } finally {
      vi.useRealTimers();
    }
  });
});
