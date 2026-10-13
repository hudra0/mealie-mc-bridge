// HTTP transport for the Monsieur Cuisine website proxy.
//
// Proxy envelope, header set and the session error codes follow SmartRecipe
// src/mc/client.ts (MIT, https://github.com/gerkensm/smart-recipe), checked against the
// live site on 2026-10-13. Every account call is a POST to /proxy-api that names the real
// endpoint and method in the JSON body. The response is an envelope { code, message, data };
// code 0 means success.

import { randomUUID } from "node:crypto";
import { z } from "zod";

export const MC_BASE_URL = "https://www.monsieur-cuisine.com";
export const MC_PUBLIC_API_URL = "https://mc-api.tecpal.com";
// The website sends this fixed value with every API call.
export const MC_PROXY_BYPASS = "cd844315-77c4-46ba-83fe-7702d13b12b2";
export const MC_EDITOR_REFERER = `${MC_BASE_URL}/de/create-recipe?devices=mc-smart`;
export const DEFAULT_LOCALE = "de-DE";
export const DEFAULT_TIMEOUT_MS = 30_000;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// The subset of fetch the transport uses. The global fetch satisfies it.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// The subset of a pino logger the transport uses.
export interface TransportLogger {
  debug(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export type SessionErrorKind = "invalid" | "expired" | "unauthorized";

export interface McApiErrorInit {
  status: number;
  code: number | null;
  serverMessage: string | null;
  endpoint: string;
  data?: unknown;
  message?: string;
}

// A failed call. status is the HTTP status (0 when no response arrived), code and
// serverMessage come from the envelope. Neither the message nor any field ever contains
// the session cookie.
export class McApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly serverMessage: string | null;
  readonly endpoint: string;
  readonly data: unknown;

  constructor(init: McApiErrorInit) {
    super(init.message ?? describeFailure(init));
    this.name = "McApiError";
    this.status = init.status;
    this.code = init.code;
    this.serverMessage = init.serverMessage;
    this.endpoint = init.endpoint;
    this.data = init.data;
  }
}

// The session cookie is missing, invalid or expired. The caller has to renew the session;
// retrying does not help.
export class McSessionError extends McApiError {
  readonly kind: SessionErrorKind;

  constructor(init: McApiErrorInit & { kind: SessionErrorKind }) {
    super({ ...init, message: init.message ?? `${describeFailure(init)} (session ${init.kind})` });
    this.name = "McSessionError";
    this.kind = init.kind;
  }
}

// No response: DNS, connection or TLS failure, or the timeout fired.
export class McNetworkError extends McApiError {
  readonly timedOut: boolean;

  constructor(init: { endpoint: string; timedOut: boolean; reason: string }) {
    super({
      status: 0,
      code: null,
      serverMessage: null,
      endpoint: init.endpoint,
      message: `${init.endpoint}: ${init.timedOut ? "timed out" : "network error"} (${init.reason})`,
    });
    this.name = "McNetworkError";
    this.timedOut = init.timedOut;
  }
}

// HTTP 401 with code 110001 / InvalidAuthCookieException: no cookie or an unusable one.
// HTTP 401 with code 110002 / ExpiredAuthCookieException: the session existed and expired.
// The codes are trusted with any status, because they only ever describe the session.
export function classifySessionError(
  status: number,
  code: number | null,
  serverMessage: string | null,
): SessionErrorKind | null {
  if (code === 110002 || serverMessage === "ExpiredAuthCookieException") return "expired";
  if (code === 110001 || serverMessage === "InvalidAuthCookieException") return "invalid";
  if (status === 401) return "unauthorized";
  return null;
}

export interface McTransportOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  publicApiUrl?: string;
  locale?: string;
  timeoutMs?: number;
  proxyBypass?: string;
  referer?: string;
  userAgent?: string;
  requestId?: () => string;
  logger?: TransportLogger;
}

export interface ProxyRequest {
  endpoint: string;
  method?: HttpMethod;
  payload?: unknown;
  cookie?: string | null;
  lang?: string;
}

export interface McResponse {
  status: number;
  code: number;
  message: string;
  data: unknown;
}

const envelopeSchema = z.object({
  code: z.number().optional(),
  message: z.unknown().optional(),
  data: z.unknown().optional(),
});

// Cookie header values are visible ASCII. Anything else would make fetch throw an error
// whose text may quote the header value.
const cookiePattern = /^[\x20-\x7e]+$/;

interface Exchange {
  status: number;
  text: string;
}

export class McTransport {
  readonly locale: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly publicApiUrl: string;
  private readonly timeoutMs: number;
  private readonly proxyBypass: string;
  private readonly referer: string;
  private readonly userAgent: string;
  private readonly requestId: () => string;
  private readonly logger: TransportLogger | undefined;

  constructor(options: McTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? MC_BASE_URL).replace(/\/+$/, "");
    this.publicApiUrl = (options.publicApiUrl ?? MC_PUBLIC_API_URL).replace(/\/+$/, "");
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.proxyBypass = options.proxyBypass ?? MC_PROXY_BYPASS;
    this.referer = options.referer ?? MC_EDITOR_REFERER;
    this.userAgent = options.userAgent ?? "Mozilla/5.0";
    this.requestId = options.requestId ?? randomUUID;
    this.logger = options.logger;
  }

  // One call through the website proxy. Resolves with the envelope on HTTP 2xx and code 0,
  // throws McSessionError, McNetworkError or McApiError otherwise.
  async proxy(request: ProxyRequest): Promise<McResponse> {
    const method = request.method ?? "GET";
    const lang = request.lang ?? this.locale;
    const label = `${method} ${request.endpoint}`;
    const cookie = request.cookie ?? null;
    if (cookie !== null && !cookiePattern.test(cookie)) {
      throw new McSessionError({
        kind: "invalid",
        status: 0,
        code: null,
        serverMessage: null,
        endpoint: label,
        message: `${label}: the session cookie contains characters that are not allowed in a header`,
      });
    }
    const body: Record<string, unknown> = { endpoint: request.endpoint, method, lang };
    if (method !== "GET" && request.payload !== undefined) body.payload = request.payload;
    const exchange = await this.exchange(label, `${this.baseUrl}/proxy-api`, () => ({
      method: "POST",
      headers: this.proxyHeaders(lang, cookie),
      body: JSON.stringify(body),
    }));
    return this.unwrap(label, exchange);
  }

  // GET on the public read API, which needs no login.
  async publicGet(path: string, lang: string = this.locale): Promise<McResponse> {
    const label = `public GET ${path}`;
    const exchange = await this.exchange(label, `${this.publicApiUrl}${path}`, () => ({
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Language": lang,
        "User-Agent": this.userAgent,
        "X-Request-ID": this.requestId(),
        "x-bypass-cdn": this.proxyBypass,
        "device-type": "web",
      },
    }));
    return this.unwrap(label, exchange);
  }

  // PUT raw bytes to a pre-signed storage URL. No cookie and no proxy headers: the
  // signature in the URL is the authorization. The URL never appears in errors or logs.
  async putSignedUrl(
    url: string,
    bytes: Uint8Array,
    contentType: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    const label = `PUT signed upload URL on ${safeHost(url)}`;
    const exchange = await this.exchange(label, url, () => ({
      method: "PUT",
      headers: { ...extraHeaders, "Content-Type": contentType },
      body: bytes,
    }));
    if (exchange.status < 200 || exchange.status >= 300) {
      // The storage error body can echo the signed request, so it is not kept.
      throw new McApiError({
        status: exchange.status,
        code: null,
        serverMessage: null,
        endpoint: label,
      });
    }
  }

  private proxyHeaders(lang: string, cookie: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
      "X-Request-ID": this.requestId(),
      "x-bypass-cdn": this.proxyBypass,
      "device-type": "web",
      "Accept-Language": lang,
      Referer: this.referer,
    };
    if (cookie !== null) headers.Cookie = cookie;
    return headers;
  }

  // Sends the request, retrying once when no response arrived. A timeout is not retried:
  // the server may still be working on the first request.
  private async exchange(label: string, url: string, init: () => RequestInit): Promise<Exchange> {
    try {
      return await this.once(label, url, init());
    } catch (error) {
      if (!(error instanceof McNetworkError) || error.timedOut) throw error;
      this.logger?.warn({ endpoint: label, reason: error.message }, "MC request failed, retrying");
      return await this.once(label, url, init());
    }
  }

  private async once(label: string, url: string, init: RequestInit): Promise<Exchange> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await response.text();
      this.logger?.debug(
        { endpoint: label, status: response.status, ms: Date.now() - started },
        "MC request",
      );
      return { status: response.status, text };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw new McNetworkError({
        endpoint: label,
        timedOut,
        reason: timedOut ? `no response within ${this.timeoutMs} ms` : describeCause(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private unwrap(label: string, exchange: Exchange): McResponse {
    const { status, text } = exchange;
    const parsed = envelopeSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw new McApiError({
        status,
        code: null,
        serverMessage: null,
        endpoint: label,
        data: snippet(text),
        message: `${label}: HTTP ${status}, the response is not a JSON envelope`,
      });
    }
    const { code, message, data } = parsed.data;
    const serverMessage = typeof message === "string" ? message : null;
    if (status >= 200 && status < 300 && (code === undefined || code === 0)) {
      return { status, code: code ?? 0, message: serverMessage ?? "", data };
    }
    const init = { status, code: code ?? null, serverMessage, endpoint: label, data };
    const kind = classifySessionError(status, init.code, serverMessage);
    if (kind !== null) throw new McSessionError({ ...init, kind });
    throw new McApiError(init);
  }
}

function describeFailure(init: McApiErrorInit): string {
  const parts = [`HTTP ${init.status}`];
  if (init.code !== null) parts.push(`code ${init.code}`);
  if (init.serverMessage) parts.push(init.serverMessage);
  const detail = detailOf(init.data);
  return `${init.endpoint}: ${parts.join(", ")}${detail ? ` (${detail})` : ""}`;
}

// Validation errors carry their explanation in data, as a string or a list of strings.
function detailOf(data: unknown): string | null {
  const text =
    typeof data === "string"
      ? data
      : Array.isArray(data) && data.every((item) => typeof item === "string")
        ? data.join("; ")
        : null;
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function describeCause(error: unknown): string {
  if (!(error instanceof Error)) return "request failed";
  const cause = error.cause;
  const code =
    cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : null;
  // Only the error class and the system error code: fetch errors about headers can quote
  // header values, so their text is not passed on.
  return code ? `${error.name} ${code}` : error.name;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an invalid URL";
  }
}
