import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MC_LOCALE,
  MC_PROXY_BYPASS,
  McApiError,
  McNetworkError,
  McSessionError,
  McTransport,
  classifySessionError,
  type FetchLike,
} from "./transport.js";

const COOKIE =
  "wordpress_logged_in_0123456789abcdef=synthetic-session-value; lidl_sso_id_token=synthetic-id-token";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/mc/${name}`, import.meta.url), "utf8"));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  ...responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[]
) {
  const calls: Call[] = [];
  const fetch = vi.fn<FetchLike>((url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : init.body;
    calls.push({ url, init, headers, body });
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error("unexpected fetch call"));
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === "function") return next(init);
    return Promise.resolve(next);
  });
  return { fetch, calls };
}

function expectNoCookie(error: unknown) {
  const text = [
    String(error),
    error instanceof Error ? (error.stack ?? "") : "",
    JSON.stringify(error),
    JSON.stringify(error instanceof McApiError ? error.data : null),
  ].join("\n");
  expect(text).not.toContain("synthetic-session-value");
  expect(text).not.toContain("synthetic-id-token");
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("McTransport.proxy", () => {
  it("posts the envelope with the website header set", async () => {
    const { fetch, calls } = mockFetch(json(200, fixture("users.json")));
    const transport = new McTransport({ fetch });

    await transport.proxy({ endpoint: "api/v1/users", cookie: COOKIE });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://www.monsieur-cuisine.com/proxy-api");
    expect(call?.init.method).toBe("POST");
    expect(call?.body).toEqual({ endpoint: "api/v1/users", method: "GET", lang: "de-DE" });
    expect(call?.headers).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      "X-Request-ID": expect.stringMatching(UUID_V4) as unknown,
      "x-bypass-cdn": MC_PROXY_BYPASS,
      "device-type": "web",
      "Accept-Language": "de-DE",
      Referer: "https://www.monsieur-cuisine.com/de/create-recipe?devices=mc-smart",
      Cookie: COOKIE,
    });
  });

  it("uses a fresh request id per call", async () => {
    const { fetch, calls } = mockFetch(
      json(200, { code: 0, data: {} }),
      json(200, { code: 0, data: {} }),
    );
    const transport = new McTransport({ fetch });
    await transport.proxy({ endpoint: "a", cookie: COOKIE });
    await transport.proxy({ endpoint: "b", cookie: COOKIE });
    expect(calls[0]?.headers["X-Request-ID"]).not.toBe(calls[1]?.headers["X-Request-ID"]);
  });

  it("sends the payload for writes and leaves it out for reads", async () => {
    const { fetch, calls } = mockFetch(
      json(201, { code: 0, data: {} }),
      json(200, { code: 0, data: {} }),
    );
    const transport = new McTransport({ fetch, locale: DEFAULT_MC_LOCALE });
    await transport.proxy({ endpoint: "x", method: "POST", payload: { a: 1 }, cookie: COOKIE });
    await transport.proxy({
      endpoint: "y",
      method: "GET",
      payload: { ignored: true },
      cookie: COOKIE,
    });
    expect(calls[0]?.body).toEqual({
      endpoint: "x",
      method: "POST",
      lang: "de-DE",
      payload: { a: 1 },
    });
    expect(calls[1]?.body).toEqual({ endpoint: "y", method: "GET", lang: "de-DE" });
  });

  it("takes the language, Accept-Language and Referer from the locale settings", async () => {
    const { fetch, calls } = mockFetch(json(200, { code: 0, data: null }));
    const transport = new McTransport({
      fetch,
      locale: {
        proxyLang: "en-US",
        acceptLanguage: "en-US,en",
        editorPath: "/en/create-recipe?devices=mc-smart",
      },
    });
    await transport.proxy({ endpoint: "x", cookie: COOKIE });
    expect(calls[0]?.body).toMatchObject({ lang: "en-US" });
    expect(calls[0]?.headers["Accept-Language"]).toBe("en-US,en");
    expect(calls[0]?.headers.Referer).toBe(
      "https://www.monsieur-cuisine.com/en/create-recipe?devices=mc-smart",
    );
  });

  it("sends no Cookie header without a cookie and honours the language override", async () => {
    const { fetch, calls } = mockFetch(json(200, { code: 0, data: null }));
    await new McTransport({ fetch }).proxy({ endpoint: "x", lang: "fr-FR" });
    expect(calls[0]?.headers).not.toHaveProperty("Cookie");
    expect(calls[0]?.headers["Accept-Language"]).toBe("fr-FR");
    expect(calls[0]?.body).toMatchObject({ lang: "fr-FR" });
  });

  it("returns the envelope for 200 and 201", async () => {
    const { fetch } = mockFetch(json(201, fixture("recipe-create.json")));
    const response = await new McTransport({ fetch }).proxy({
      endpoint: "api/v3/auth/user/recipes/",
      method: "POST",
      payload: {},
      cookie: COOKIE,
    });
    expect(response.status).toBe(201);
    expect(response.code).toBe(0);
    expect(response.message).toBe("Recipe successfully created");
    expect(response.data).toMatchObject({ recipe: { id: 900002, status: "draft" } });
  });

  it("accepts an envelope without code on success", async () => {
    const { fetch } = mockFetch(json(200, { data: [1] }));
    const response = await new McTransport({ fetch }).proxy({ endpoint: "x", cookie: COOKIE });
    expect(response).toEqual({ status: 200, code: 0, message: "", data: [1] });
  });

  it("maps HTTP 401 with code 110001 to an invalid session", async () => {
    const { fetch } = mockFetch(json(401, fixture("error-invalid-cookie.json")));
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "api/v1/users", cookie: COOKIE }),
    );
    expect(error).toBeInstanceOf(McSessionError);
    expect(error).toMatchObject({
      kind: "invalid",
      status: 401,
      code: 110001,
      serverMessage: "InvalidAuthCookieException",
      endpoint: "GET api/v1/users",
      data: "Invalid auth cookie.",
    });
    expect((error as Error).message).toContain("HTTP 401, code 110001, InvalidAuthCookieException");
    expectNoCookie(error);
  });

  it("maps HTTP 401 with code 110002 to an expired session", async () => {
    const { fetch } = mockFetch(json(401, fixture("error-expired-cookie.json")));
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "x", cookie: COOKIE }),
    );
    expect(error).toMatchObject({ name: "McSessionError", kind: "expired", code: 110002 });
    expectNoCookie(error);
  });

  it("recognizes the session exceptions by message alone", async () => {
    const { fetch } = mockFetch(
      json(401, { message: "ExpiredAuthCookieException" }),
      json(401, { message: "InvalidAuthCookieException" }),
    );
    const transport = new McTransport({ fetch });
    await expect(transport.proxy({ endpoint: "x", cookie: COOKIE })).rejects.toMatchObject({
      kind: "expired",
      code: null,
    });
    await expect(transport.proxy({ endpoint: "x", cookie: COOKIE })).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("maps any other 401 to unauthorized", async () => {
    const { fetch } = mockFetch(json(401, { code: 123, message: "Nope", data: null }));
    await expect(
      new McTransport({ fetch }).proxy({ endpoint: "x", cookie: COOKIE }),
    ).rejects.toMatchObject({
      name: "McSessionError",
      kind: "unauthorized",
      code: 123,
    });
  });

  it("raises McApiError with the server detail for other failures", async () => {
    const { fetch } = mockFetch(json(400, fixture("error-bad-request.json")));
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "api/v1/users", cookie: COOKIE }),
    );
    expect(error).toBeInstanceOf(McApiError);
    expect(error).not.toBeInstanceOf(McSessionError);
    expect(error).toMatchObject({
      status: 400,
      code: 110000,
      serverMessage: "BadRequestException",
    });
    expect((error as Error).message).toBe(
      "GET api/v1/users: HTTP 400, code 110000, BadRequestException (xRequestId should not be empty)",
    );
  });

  it("raises McApiError for a non-zero code on HTTP 200", async () => {
    const { fetch } = mockFetch(
      json(200, { code: 40008, message: "Invalid category", data: null }),
    );
    await expect(
      new McTransport({ fetch }).proxy({ endpoint: "x", cookie: COOKIE }),
    ).rejects.toMatchObject({
      name: "McApiError",
      status: 200,
      code: 40008,
    });
  });

  it("keeps the validation message of a rejected recipe", async () => {
    const { fetch } = mockFetch(json(400, fixture("error-validation.json")));
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "x", method: "PUT", cookie: COOKIE }),
    );
    expect((error as Error).message).toContain("modeSetting.size: size must be a valid enum value");
  });

  it("shortens long detail lists", async () => {
    const { fetch } = mockFetch(json(400, { code: 1, message: "Bad", data: ["x".repeat(400)] }));
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "x", cookie: COOKIE }),
    );
    expect((error as Error).message).toMatch(/x{300}\.\.\.\)$/);
  });

  it("raises McApiError for a response that is not a JSON envelope", async () => {
    const { fetch } = mockFetch(
      new Response("<html><body>Bad gateway</body></html>", { status: 502 }),
      json(200, [1, 2, 3]),
    );
    const transport = new McTransport({ fetch });
    await expect(transport.proxy({ endpoint: "x", cookie: COOKIE })).rejects.toMatchObject({
      name: "McApiError",
      status: 502,
      code: null,
      data: "<html><body>Bad gateway</body></html>",
      message: "GET x: HTTP 502, the response is not a JSON envelope",
    });
    await expect(transport.proxy({ endpoint: "x", cookie: COOKIE })).rejects.toMatchObject({
      status: 200,
    });
  });

  it.each([
    ["an HTML page", "<html><body>401 Unauthorized</body></html>"],
    ["an empty body", ""],
  ])("maps a 401 with %s to an unauthorized session", async (_name, body) => {
    const { fetch } = mockFetch(new Response(body, { status: 401 }));
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "api/v1/users", cookie: COOKIE }),
    );
    expect(error).toBeInstanceOf(McSessionError);
    expect(error).toMatchObject({
      kind: "unauthorized",
      status: 401,
      code: null,
      data: body,
      message:
        "GET api/v1/users: HTTP 401, the response is not a JSON envelope (session unauthorized)",
    });
  });

  it("retries once after a network error", async () => {
    const failure = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    const { fetch, calls } = mockFetch(failure, json(200, { code: 0, data: "ok" }));
    const warn = vi.fn();
    const transport = new McTransport({ fetch, logger: { debug: vi.fn(), warn } });
    const response = await transport.proxy({ endpoint: "x", cookie: COOKIE });
    expect(response.data).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["X-Request-ID"]).not.toBe(calls[1]?.headers["X-Request-ID"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-session-value");
  });

  it("gives up after the second network error", async () => {
    const { fetch, calls } = mockFetch(
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    );
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "x", cookie: COOKIE }),
    );
    expect(calls).toHaveLength(2);
    expect(error).toBeInstanceOf(McNetworkError);
    expect(error).toMatchObject({
      status: 0,
      timedOut: false,
      message: "GET x: network error (TypeError)",
    });
  });

  it("names the system error code of a network failure", async () => {
    const failure = () => new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    const { fetch } = mockFetch(failure(), failure());
    await expect(
      new McTransport({ fetch }).proxy({ endpoint: "x", cookie: COOKIE }),
    ).rejects.toThrow("GET x: network error (TypeError ENOTFOUND)");
  });

  it("times out without retrying", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { fetch, calls } = mockFetch(hang);
    const error = await rejectionOf(
      new McTransport({ fetch, timeoutMs: 20 }).proxy({ endpoint: "x", cookie: COOKIE }),
    );
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({
      name: "McNetworkError",
      timedOut: true,
      message: "GET x: timed out (no response within 20 ms)",
    });
    expectNoCookie(error);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE"] as const)(
    "retries an idempotent %s after a network error",
    async (method) => {
      const failure = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      const { fetch, calls } = mockFetch(failure, json(200, { code: 0, data: "ok" }));
      await new McTransport({ fetch }).proxy({ endpoint: "x", method, cookie: COOKIE });
      expect(calls).toHaveLength(2);
    },
  );

  // A create that reached the server before the connection dropped would leave a second
  // draft behind if it were sent again.
  it("does not retry a POST create after a connection reset", async () => {
    const failure = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    const { fetch, calls } = mockFetch(failure, json(201, fixture("recipe-create.json")));
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({
        endpoint: "api/v3/auth/user/recipes/",
        method: "POST",
        cookie: COOKIE,
        payload: {},
      }),
    );
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({
      name: "McNetworkError",
      responded: false,
      message: "POST api/v3/auth/user/recipes/: network error (TypeError ECONNRESET)",
    });
  });

  it("retries a POST the caller marks as idempotent", async () => {
    const { fetch, calls } = mockFetch(
      new TypeError("fetch failed"),
      json(200, { code: 0, data: [] }),
    );
    await new McTransport({ fetch }).proxy({
      endpoint: "x",
      method: "POST",
      idempotent: true,
      cookie: COOKIE,
    });
    expect(calls).toHaveLength(2);
  });

  it.each(["POST", "GET"] as const)(
    "does not retry a %s whose response body breaks off",
    async (method) => {
      const broken = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
            },
          }),
          { status: 201 },
        );
      const { fetch, calls } = mockFetch(broken(), json(201, fixture("recipe-create.json")));
      const error = await rejectionOf(
        new McTransport({ fetch }).proxy({
          endpoint: "api/v3/auth/user/recipes/",
          method,
          cookie: COOKIE,
        }),
      );
      expect(calls).toHaveLength(1);
      expect(error).toBeInstanceOf(McNetworkError);
      expect(error).toMatchObject({
        status: 201,
        responded: true,
        timedOut: false,
        message: `${method} api/v3/auth/user/recipes/: network error while reading the HTTP 201 response (TypeError UND_ERR_SOCKET)`,
      });
    },
  );

  it("never puts the cookie into error messages", async () => {
    // A fetch implementation that quotes the request headers in its error text.
    const leaky = new TypeError(`Headers.append: "${COOKIE}" is an invalid header value.`);
    const { fetch } = mockFetch(leaky, leaky);
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "x", cookie: COOKIE }),
    );
    expect(error).toBeInstanceOf(McNetworkError);
    expectNoCookie(error);
  });

  it("rejects a cookie with characters that cannot go into a header, without quoting it", async () => {
    const { fetch } = mockFetch();
    const error = await rejectionOf(
      new McTransport({ fetch }).proxy({ endpoint: "x", cookie: `${COOKIE}\r\nX-Injected: 1` }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(error).toMatchObject({ name: "McSessionError", kind: "invalid", status: 0 });
    expectNoCookie(error);
  });

  it("logs requests without the cookie", async () => {
    const debug = vi.fn();
    const { fetch } = mockFetch(json(200, { code: 0, data: null }));
    await new McTransport({ fetch, logger: { debug, warn: vi.fn() } }).proxy({
      endpoint: "x",
      cookie: COOKIE,
    });
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "GET x", status: 200 }),
      "MC request",
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain("synthetic");
  });

  it("uses the global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, { code: 0, data: 1 }));
    try {
      const response = await new McTransport().proxy({ endpoint: "x", cookie: COOKIE });
      expect(response.data).toBe(1);
      expect(spy).toHaveBeenCalledWith(
        "https://www.monsieur-cuisine.com/proxy-api",
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("McTransport.publicGet", () => {
  it("calls the public API without cookie and referer", async () => {
    const { fetch, calls } = mockFetch(json(200, fixture("categories.json")));
    const response = await new McTransport({ fetch }).publicGet("/api/v1/categories");
    expect(calls[0]?.url).toBe("https://mc-api.tecpal.com/api/v1/categories");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.headers).not.toHaveProperty("Cookie");
    expect(calls[0]?.headers).not.toHaveProperty("Referer");
    expect(calls[0]?.headers).toMatchObject({ "Accept-Language": "de-DE", "device-type": "web" });
    expect(response.data).toMatchObject({ categories: expect.any(Array) as unknown });
  });
});

describe("McTransport.putSignedUrl", () => {
  const signedUrl = "https://storage.example.com/upload/a.jpeg?X-Goog-Signature=secret-signature";

  it("puts the bytes without cookie or proxy headers", async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);
    await new McTransport({ fetch }).putSignedUrl(signedUrl, bytes, "image/jpeg", {
      "x-goog-meta": "1",
    });
    expect(calls[0]?.url).toBe(signedUrl);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.headers).toEqual({ "x-goog-meta": "1", "Content-Type": "image/jpeg" });
    expect(calls[0]?.init.body).toBe(bytes);
  });

  it("reports a failed upload without the signed URL or the storage response", async () => {
    const { fetch } = mockFetch(
      new Response("<Error><StringToSign>secret-signature</StringToSign></Error>", { status: 403 }),
    );
    const error = await rejectionOf(
      new McTransport({ fetch }).putSignedUrl(signedUrl, new Uint8Array([1]), "image/jpeg"),
    );
    expect(error).toMatchObject({
      name: "McApiError",
      status: 403,
      endpoint: "PUT signed upload URL on storage.example.com",
    });
    expect(JSON.stringify(error) + String(error)).not.toContain("secret-signature");
  });

  it("describes an unparsable URL without echoing it", async () => {
    const { fetch } = mockFetch(
      new TypeError("Failed to parse URL"),
      new TypeError("Failed to parse URL"),
    );
    await expect(
      new McTransport({ fetch }).putSignedUrl("not a url", new Uint8Array([1]), "image/jpeg"),
    ).rejects.toThrow("PUT signed upload URL on an invalid URL: network error (TypeError)");
  });
});

describe("classifySessionError", () => {
  it.each([
    [401, 110001, "InvalidAuthCookieException", "invalid"],
    [401, null, "InvalidAuthCookieException", "invalid"],
    [401, 110002, "ExpiredAuthCookieException", "expired"],
    [401, null, "ExpiredAuthCookieException", "expired"],
    [200, 110002, null, "expired"],
    [401, 999, null, "unauthorized"],
    [403, 40008, "Invalid category", null],
    [500, null, null, null],
  ] as const)("status %s, code %s, message %s -> %s", (status, code, message, kind) => {
    expect(classifySessionError(status, code, message)).toBe(kind);
  });
});
