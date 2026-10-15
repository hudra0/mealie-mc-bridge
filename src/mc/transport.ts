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
// What the website needs per language: the proxy envelope's lang, the Accept-Language header
// and the editor path, which is also the Referer of every proxy call. A locale pack's
// mc.json carries them (src/locale/pack.ts); the default is the verified de-DE setting.
export interface McLocaleSettings {
  proxyLang: string;
  acceptLanguage: string;
  editorPath: string;
}
export const DEFAULT_MC_LOCALE: McLocaleSettings = {
  proxyLang: "de-DE",
  acceptLanguage: "de-DE",
  editorPath: "/de/create-recipe?devices=mc-smart",
};
export const MC_EDITOR_REFERER = `${MC_BASE_URL}${DEFAULT_MC_LOCALE.editorPath}`;
export const DEFAULT_TIMEOUT_MS = 30_000;
// Where a signed image upload URL may point: Google Cloud Storage and the Tecpal hosts.
// "*.example.com" covers the subdomains of example.com, not example.com itself.
export const DEFAULT_UPLOAD_HOSTS: readonly string[] = ["*.googleapis.com", "*.tecpal.com"];

export function uploadHostAllowed(host: string, patterns: readonly string[]): boolean {
  const name = host.toLowerCase();
  return patterns.some((pattern) => {
    const entry = pattern.trim().toLowerCase();
    if (entry.startsWith("*."))
      return name.endsWith(entry.slice(1)) && name.length > entry.length - 1;
    return entry !== "" && name === entry;
  });
}

// The signed upload URL names a host that is not on MC_UPLOAD_HOSTS, or is not https. The
// image is not sent; retrying does not help.
export class McUploadHostError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(
      `The image upload URL (${host}) is not an https URL on MC_UPLOAD_HOSTS; the image was not sent`,
    );
    this.name = "McUploadHostError";
    this.host = host;
  }
}

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

// The exchange broke off: DNS, connection or TLS failure, the timeout fired, or the
// connection dropped while the response body was being read. In the last case responded
// is true and status holds the HTTP status: the server has answered, so it has handled
// the request.
export class McNetworkError extends McApiError {
  readonly timedOut: boolean;
  readonly responded: boolean;

  constructor(init: { endpoint: string; timedOut: boolean; reason: string; status?: number }) {
    const status = init.status ?? 0;
    const what = init.timedOut
      ? "timed out"
      : status > 0
        ? `network error while reading the HTTP ${status} response`
        : "network error";
    super({
      status,
      code: null,
      serverMessage: null,
      endpoint: init.endpoint,
      message: `${init.endpoint}: ${what} (${init.reason})`,
    });
    this.name = "McNetworkError";
    this.timedOut = init.timedOut;
    this.responded = status > 0;
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
  locale?: McLocaleSettings;
  timeoutMs?: number;
  proxyBypass?: string;
  referer?: string;
  userAgent?: string;
  requestId?: () => string;
  logger?: TransportLogger;
  // MC_UPLOAD_HOSTS; DEFAULT_UPLOAD_HOSTS when left out.
  uploadHosts?: readonly string[];
}

export interface ProxyRequest {
  endpoint: string;
  method?: HttpMethod;
  payload?: unknown;
  cookie?: string | null;
  // Overrides the transport's language for this call (envelope and Accept-Language).
  lang?: string;
  // Whether sending the call twice has the same effect as sending it once. Only such calls
  // are retried after a network error. Defaults to true for every method but POST.
  idempotent?: boolean;
}

// What McClient needs from a transport. McTransport implements it; tests can pass a fake.
export interface McHttp {
  proxy(request: ProxyRequest): Promise<McResponse>;
  publicGet(path: string, lang?: string): Promise<McResponse>;
  putSignedUrl(
    url: string,
    bytes: Uint8Array,
    contentType: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void>;
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

export class McTransport implements McHttp {
  // The proxy envelope's lang and the Accept-Language header of every call.
  readonly lang: string;
  readonly acceptLanguage: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly publicApiUrl: string;
  private readonly timeoutMs: number;
  private readonly proxyBypass: string;
  private readonly referer: string;
  private readonly userAgent: string;
  private readonly requestId: () => string;
  private readonly logger: TransportLogger | undefined;
  private readonly uploadHosts: readonly string[];

  constructor(options: McTransportOptions = {}) {
    this.uploadHosts = options.uploadHosts ?? DEFAULT_UPLOAD_HOSTS;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? MC_BASE_URL).replace(/\/+$/, "");
    this.publicApiUrl = (options.publicApiUrl ?? MC_PUBLIC_API_URL).replace(/\/+$/, "");
    const locale = options.locale ?? DEFAULT_MC_LOCALE;
    this.lang = locale.proxyLang;
    this.acceptLanguage = locale.acceptLanguage;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.proxyBypass = options.proxyBypass ?? MC_PROXY_BYPASS;
    this.referer = options.referer ?? `${this.baseUrl}${locale.editorPath}`;
    this.userAgent = options.userAgent ?? "Mozilla/5.0";
    this.requestId = options.requestId ?? randomUUID;
    this.logger = options.logger;
  }

  // One call through the website proxy. Resolves with the envelope on HTTP 2xx and code 0,
  // throws McSessionError, McNetworkError or McApiError otherwise.
  async proxy(request: ProxyRequest): Promise<McResponse> {
    const method = request.method ?? "GET";
    const lang = request.lang ?? this.lang;
    const acceptLanguage = request.lang ?? this.acceptLanguage;
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
    const exchange = await this.exchange(
      label,
      `${this.baseUrl}/proxy-api`,
      () => ({
        method: "POST",
        headers: this.proxyHeaders(acceptLanguage, cookie),
        body: JSON.stringify(body),
      }),
      request.idempotent ?? method !== "POST",
    );
    return this.unwrap(label, exchange);
  }

  // GET on the public read API, which needs no login.
  async publicGet(path: string, lang: string = this.acceptLanguage): Promise<McResponse> {
    const label = `public GET ${path}`;
    const exchange = await this.exchange(
      label,
      `${this.publicApiUrl}${path}`,
      () => ({
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Language": lang,
          "User-Agent": this.userAgent,
          "X-Request-ID": this.requestId(),
          "x-bypass-cdn": this.proxyBypass,
          "device-type": "web",
        },
      }),
      true,
    );
    return this.unwrap(label, exchange);
  }

  // PUT raw bytes to a pre-signed storage URL. No cookie and no proxy headers: the
  // signature in the URL is the authorization. The URL never appears in errors or logs.
  // Only https hosts on MC_UPLOAD_HOSTS get the bytes, and a redirect is an error: the URL
  // comes from monsieur-cuisine.com and must not point the bridge anywhere else.
  async putSignedUrl(
    url: string,
    bytes: Uint8Array,
    contentType: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    const label = `PUT signed upload URL on ${safeHost(url)}`;
    let target: URL | null = null;
    try {
      target = new URL(url);
    } catch {
      // Reported below like any host that is not allowed.
    }
    if (
      target === null ||
      target.protocol !== "https:" ||
      !uploadHostAllowed(target.hostname, this.uploadHosts)
    ) {
      throw new McUploadHostError(target?.hostname || safeHost(url));
    }
    // The same bytes to the same URL: safe to send twice.
    const exchange = await this.exchange(
      label,
      url,
      () => ({
        method: "PUT",
        headers: { ...extraHeaders, "Content-Type": contentType },
        body: bytes,
        redirect: "error",
      }),
      true,
    );
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

  private proxyHeaders(acceptLanguage: string, cookie: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
      "X-Request-ID": this.requestId(),
      "x-bypass-cdn": this.proxyBypass,
      "device-type": "web",
      "Accept-Language": acceptLanguage,
      Referer: this.referer,
    };
    if (cookie !== null) headers.Cookie = cookie;
    return headers;
  }

  // Sends the request. An idempotent call is retried once when it failed before any
  // response arrived. Nothing else is retried: after a timeout the server may still be
  // working on the first request, and once a status line has arrived the server has
  // handled it. Retrying a create in either case could leave two drafts in the account.
  private async exchange(
    label: string,
    url: string,
    init: () => RequestInit,
    idempotent: boolean,
  ): Promise<Exchange> {
    try {
      return await this.once(label, url, init());
    } catch (error) {
      if (!idempotent || !(error instanceof McNetworkError) || error.timedOut || error.responded) {
        throw error;
      }
      this.logger?.warn({ endpoint: label, reason: error.message }, "MC request failed, retrying");
      return await this.once(label, url, init());
    }
  }

  private async once(label: string, url: string, init: RequestInit): Promise<Exchange> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    const failure = (error: unknown, status?: number) => {
      const timedOut = controller.signal.aborted;
      return new McNetworkError({
        endpoint: label,
        timedOut,
        reason: timedOut ? `no response within ${this.timeoutMs} ms` : describeCause(error),
        ...(status === undefined ? {} : { status }),
      });
    };
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch (error) {
        throw failure(error);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        // The status line has arrived: the server has handled the request.
        throw failure(error, response.status);
      }
      this.logger?.debug(
        { endpoint: label, status: response.status, ms: Date.now() - started },
        "MC request",
      );
      return { status: response.status, text };
    } finally {
      clearTimeout(timer);
    }
  }

  private unwrap(label: string, exchange: Exchange): McResponse {
    const { status, text } = exchange;
    const parsed = envelopeSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      // A 401 is about the session whatever the body: WordPress or the load balancer may
      // answer with an HTML page or with nothing at all.
      if (status === 401) {
        throw new McSessionError({
          kind: "unauthorized",
          status,
          code: null,
          serverMessage: null,
          endpoint: label,
          data: snippet(text),
          message: `${label}: HTTP 401, the response is not a JSON envelope (session unauthorized)`,
        });
      }
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
