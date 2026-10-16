// The admin pages: overview, jobs with retry and cancel, a dry run, and the settings
// (admin-settings.ts), on server-rendered HTML with self-hosted assets.
//
// Protection, in layers:
// - A login form for ADMIN_USER and ADMIN_PASSWORD, compared in constant time. A correct
//   login sets a signed, HttpOnly, SameSite=Lax session cookie for 12 hours
//   (admin-auth.ts). The service does not start without both settings unless ADMIN_AUTH=off;
//   then the pages are open (a warning is logged and every page shows a banner).
// - Over HTTPS (directly, or behind a proxy in TRUST_PROXY) every page sends HSTS.
// - The JSON endpoints under /admin/api/ also take HTTP Basic Auth with the same
//   credentials, for scripts such as `npm run mc:login`. They need a JSON body, which a
//   form on another site cannot send.
// - Forms carry a token: an HMAC of the login session's nonce under a secret created when
//   the process starts (admin-auth.ts), or that secret itself while the pages have no
//   password. A page on another site cannot read it (same-origin policy), so it cannot forge
//   a POST, and a token is worth nothing without its session cookie. The login form has a
//   token of its own. The dry-run conversion, which costs money, needs the token as well.
//   After a restart, reload the page before submitting a form.
// - Five failed logins from one address within 15 minutes lock that address out for the
//   rest of the window, on the form and on Basic Auth alike.
// - Logging out (POST only) ends every session issued before it, not just the cookie in the
//   browser.
// - A POST whose Origin header names another host is refused.
// - Without credentials, only requests for an IP address, localhost or a name in
//   ADMIN_HOSTS get through. A malicious site could otherwise rebind its own name to the
//   bridge's address and use the pages as same-origin. With a login, the session cookie is
//   bound to the name it was set for, so the list applies only when set.
// - The pages allow scripts, styles, fonts and images from the bridge itself only (CSP):
//   no inline script, style or event handler. The static assets under /admin/assets/ are
//   the only thing served without a login; they hold no data.

import { randomBytes } from "node:crypto";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorMessage, type AppLogger } from "../app-logger.js";
import { messages, type AdminMessages, type UiLanguage } from "../i18n/index.js";
import { McSessionError, type McRecipeSink } from "../mc/index.js";
import { quantizeScale, type MealieClient } from "../mealie/index.js";
import type { MailPort } from "../notify/mailer.js";
import type { Converter } from "../pipeline/converter-port.js";
import {
  checkConverted,
  conversionRequest,
  planCategories,
  prepareRecipe,
} from "../pipeline/prepare.js";
import type { IngredientResolverPort } from "../pipeline/ingredient-resolver.js";
import type { PipelineLocale } from "../pipeline/locale.js";
import type { MealiePort } from "../pipeline/run-job.js";
import type { WorkerStatus } from "../pipeline/worker.js";
import type { DeviceLimits } from "../recipe/limits.js";
import {
  InvalidCookieError,
  SessionRejectedError,
  type SessionManager,
  type SessionStatus,
} from "../session/manager.js";
import { JOB_STATUSES, JobConflictError, type JobStatus, type JobStore } from "../store/jobs.js";
import type { McRecipeStore } from "../store/mc-recipes.js";
import type { SettingsStore } from "../store/settings.js";
import { version } from "../version.js";
import {
  ADMIN_COOKIE,
  ADMIN_COOKIE_PATH,
  HSTS_VALUE,
  LoginThrottle,
  SESSIONS_VALID_AFTER_KEY,
  adminSessions,
  formTokenFor,
  loginTokenFor,
  clearedSessionCookie,
  isHttps,
  parseCookieHeader,
  safeNext,
  sessionCookie,
} from "./admin-auth.js";
import type { ConfigEntry } from "../config-reference.js";
import { registerSettings, type AutoLoginPort } from "./admin-settings.js";
import type { SafeHtml } from "./html.js";
import { credentialsMatch, parseBasicAuth, safeEqual, type Credentials } from "./security.js";
import { isAssetPath, loadAssets, type AssetCatalog } from "./ui/assets.js";
import type { Notice, Tone } from "./ui/components.js";
import { adminTimeZone } from "./ui/format.js";
import { parseTheme, renderPage, THEME_COOKIE, type NavKey } from "./ui/shell.js";
import { isActive, type ViewContext } from "./views/context.js";
import { dashboardView, type AiInfo, type MealieCheck } from "./views/dashboard.js";
import { dryRunView, type DryRunData } from "./views/dry-run.js";
import { JOB_TABS, jobDetailView, type JobTab } from "./views/job-detail.js";
import { FILTER_STATUSES, JOB_FILTERS, jobListView, type JobFilter } from "./views/jobs.js";
import { errorView, loginView } from "./views/login.js";
import type { WebhookInfo } from "./views/settings.js";

// The content security policy of every page: the bridge's own scripts, styles, fonts and
// images, fetches to itself, forms to itself, no framing.
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export interface AdminOptions {
  // Null turns the login off.
  auth: Credentials | null;
  // Signs the login cookie; derived from SETTINGS_KEY. Random when left out, which ends
  // every login at a restart.
  sessionKey?: Buffer;
  // ADMIN_HOSTS: host names, lower case, without ports.
  allowedHosts?: readonly string[];
  store: { jobs: JobStore; mcRecipes: McRecipeStore; settings: SettingsStore };
  session: Pick<SessionManager, "status" | "setCookie" | "check" | "loginNow">;
  mealie: Pick<MealiePort, "getRecipe"> &
    Partial<Pick<MealieClient, "getRecipeThumbnail" | "searchRecipes">>;
  // Asks Mealie who the API token belongs to; the overview shows whether it answers.
  mealieCheck?: () => Promise<unknown>;
  // MEALIE_URL, shown next to that check.
  mealieUrl?: string;
  // WEBHOOK_TOKEN and PORT, for the recipe action URL on the settings page.
  webhook?: { token: string; port: number };
  // The automatic login and its part of the settings page; left out, that part says so.
  autoLogin?: AutoLoginPort;
  // The effective configuration for the settings page (src/config-reference.ts).
  config?: readonly ConfigEntry[];
  mc: Pick<McRecipeSink, "getCategories">;
  converter: Converter;
  limits: DeviceLimits;
  // The pack of MC_LOCALE, for the dry run.
  locale: PipelineLocale;
  // The language of the pages; English by default.
  language?: UiLanguage;
  logger: AppLogger;
  recipeStatus: "draft" | "private-publish";
  // TAG_NAME, left out of the dry run's converter input as the job leaves it out.
  tagName?: string;
  // Offers the converter catalog names in the dry run, as the job does.
  ingredients?: Pick<IngredientResolverPort, "suggest">;
  worker?: { status(): WorkerStatus; nudge?(): void };
  // The link to a recipe in Mealie, or null when the public URL is unknown.
  mealieRecipeUrl?: (slug: string) => string | null;
  // The language model of the converter, for the overview and the settings page.
  ai?: AiInfo;
  // JOB_DAILY_LIMIT and JOB_DAILY_COST_LIMIT_USD; 0 is no limit.
  dailyLimits?: { jobs: number; costUsd: number };
  // The mail settings and the test mail of the settings page; left out, that part says so.
  mail?: MailPort;
  // DATA_DIR, shown on the settings page.
  dataDir?: string;
  // The built stylesheet, script, font and icons; read from dist/assets when left out.
  assets?: AssetCatalog;
  // More pages inside the same protection (login, form token, host check).
  extend?: (context: AdminContext) => void;
  // The secret behind the form tokens. Fixed in tests; random otherwise.
  formToken?: string;
  // Failed-login counter; tests pass one with their own clock.
  throttle?: LoginThrottle;
  now?: () => Date;
}

const FORM_BODY_LIMIT = 64 * 1024;
const API_BODY_LIMIT = 64 * 1024;
// Pages that follow a queued or running job reload after this many seconds.
export const REFRESH_SECONDS = 5;
// The overview asks Mealie at most this often, and waits this long for an answer.
const MEALIE_CHECK_TTL_MS = 30_000;
const MEALIE_CHECK_TIMEOUT_MS = 4_000;
// The compose service name of the bridge in compose.example.yml.
const COMPOSE_SERVICE = "mc-bridge";
// Thumbnails are kept this long: a hit an hour, a miss five minutes, at most 300 recipes.
const THUMBNAIL_TTL_MS = 60 * 60_000;
const THUMBNAIL_MISS_TTL_MS = 5 * 60_000;
const THUMBNAIL_CACHE_SIZE = 300;
const RECIPE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60_000;
// The setup card of the overview stays away once dismissed.
export const SETUP_DISMISSED_KEY = "ui.setup_dismissed_at";
// Notices that report a state rather than a success.
const INFO_NOTICES = new Set(["login-running", "login-cooldown", "login-no-credentials"]);

// What the overview shows while Mealie has no image for a recipe: a neutral plate.
export const THUMBNAIL_PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><g fill="none" stroke="#a1a1aa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(20 20)"><path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8"/><path d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7"/><path d="m2.1 21.8 6.4-6.3"/><path d="m19 5-7 7"/></g></svg>`;

interface FormBody {
  _csrf?: string;
  cookie?: string;
  force?: string;
  user?: string;
  password?: string;
  next?: string;
  theme?: string;
}

export interface RenderExtra {
  status?: number;
  notice?: string | null;
  error?: string | null;
  refresh?: { seconds: number; url: string } | null;
  // The navigation entry to mark as the current page.
  active?: NavKey | null;
}

// What a page added through AdminOptions.extend gets: the shared rendering, the texts and
// the form token.
export interface AdminContext {
  app: FastifyInstance;
  t: AdminMessages;
  // The form token for the session of a request.
  csrf: (request: FastifyRequest) => string;
  // The texts, clock, time zone and form token a page body needs.
  view: (request: FastifyRequest) => ViewContext;
  render: (reply: FastifyReply, title: string, body: SafeHtml, extra?: RenderExtra) => FastifyReply;
  notice: (request: FastifyRequest) => string | null;
  // Whether Mealie answers with the API token, cached for a while.
  checkMealie: () => Promise<MealieCheck>;
  webhookInfo: (request: FastifyRequest) => WebhookInfo | null;
  now: () => Date;
}

// The session state as the JSON endpoints report it. The cookie itself never leaves.
export function sessionJson(status: SessionStatus) {
  return {
    state: status.state,
    checkedAt: status.checkedAt,
    cookieSetAt: status.cookieSetAt,
    cookieExpiresAt: status.cookieExpiresAt,
    cookieAgeHours: status.cookieAgeHours,
    lastError: status.lastError,
  };
}

export const SESSION_TONE: Readonly<Record<SessionStatus["state"], Tone>> = {
  valid: "ok",
  invalid: "danger",
  expired: "danger",
  unknown: "neutral",
};

function requestPath(request: FastifyRequest): string {
  return request.url.split("?")[0] ?? "";
}

// The user name of a Mealie getSelf answer, if it has one.
function mealieUser(answer: unknown): string | null {
  if (answer === null || typeof answer !== "object") return null;
  const record = answer as { username?: unknown; fullName?: unknown };
  if (typeof record.username === "string" && record.username !== "") return record.username;
  return typeof record.fullName === "string" && record.fullName !== "" ? record.fullName : null;
}

function isWebp(bytes: Buffer): boolean {
  return (
    bytes.length > 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}

export function admin(
  app: FastifyInstance,
  options: AdminOptions,
  done: (error?: Error) => void,
): void {
  const secret = options.formToken ?? randomBytes(32).toString("hex");
  const loginToken = loginTokenFor(secret);
  const auth = options.auth;
  const authDisabled = auth === null;
  const settings = options.store.settings;
  const sessions = auth
    ? adminSessions(options.sessionKey ?? randomBytes(32), auth, {
        validAfter: () => Number(settings.get(SESSIONS_VALID_AFTER_KEY) ?? "0") || 0,
      })
    : null;
  const catalog = messages(options.language ?? "en");
  const t: AdminMessages = catalog.admin;
  const now = () => options.now?.() ?? new Date();
  const timeZone = adminTimeZone();
  const assets = options.assets ?? loadAssets();
  if (assets.empty) {
    options.logger.warn({}, "admin assets not built (npm run build): the pages have no styles");
  }
  if (authDisabled) {
    options.logger.warn(
      {},
      "ADMIN_AUTH=off and no ADMIN_USER and ADMIN_PASSWORD: the admin pages have no password",
    );
  }

  const throttle = options.throttle ?? new LoginThrottle({ now: () => now().getTime() });

  const sessionNonce = (request: FastifyRequest): string | null =>
    sessions?.verify(parseCookieHeader(request.headers.cookie)[ADMIN_COOKIE], now()) ?? null;
  const signedIn = (request: FastifyRequest): boolean => sessionNonce(request) !== null;
  // The form token of a request: bound to its login session, or the secret itself while the
  // pages have no password. Empty without a session, which no form token matches.
  const csrf = (request: FastifyRequest): string => {
    if (authDisabled) return secret;
    const nonce = sessionNonce(request);
    return nonce === null ? "" : formTokenFor(secret, nonce);
  };
  const view = (request: FastifyRequest): ViewContext => ({
    m: catalog,
    t,
    now: now(),
    timeZone,
    csrf: csrf(request),
  });
  const theme = (request: FastifyRequest) =>
    parseTheme(parseCookieHeader(request.headers.cookie)[THEME_COOKIE]);

  const securityHeaders = (reply: FastifyReply) => {
    if (isHttps(reply.request)) reply.header("strict-transport-security", HSTS_VALUE);
    return reply
      .header("cache-control", "no-store")
      .header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "same-origin");
  };

  const render = (
    reply: FastifyReply,
    title: string,
    body: SafeHtml,
    extra: RenderExtra & { bare?: boolean } = {},
  ) => {
    const request = reply.request;
    const state = options.session.status().state;
    const notices: Notice[] = extra.notice
      ? [{ tone: INFO_NOTICES.has(noticeKey(request) ?? "") ? "info" : "ok", text: extra.notice }]
      : [];
    return securityHeaders(reply)
      .code(extra.status ?? 200)
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", CONTENT_SECURITY_POLICY)
      .send(
        renderPage({
          title,
          t,
          body,
          theme: theme(request),
          assets,
          notices,
          authDisabled,
          error: extra.error ?? null,
          // A response to a POST never reloads: a reload would send the form again.
          refresh: request.method === "GET" ? (extra.refresh ?? null) : null,
          nav: extra.bare
            ? null
            : {
                active: extra.active ?? null,
                user: auth?.user ?? null,
                formToken: csrf(request),
                session: { tone: SESSION_TONE[state], label: t.sessionState[state] },
                version,
                path: request.url,
              },
        }),
      );
  };

  const noticeKey = (request: FastifyRequest): string | null => {
    const key = (request.query as Record<string, unknown> | undefined)?.notice;
    return typeof key === "string" ? key : null;
  };
  const notice = (request: FastifyRequest): string | null => {
    const key = noticeKey(request);
    return key !== null && Object.hasOwn(t.notices, key) ? (t.notices[key] ?? null) : null;
  };

  const tokenValid = (value: unknown, expected: string): boolean =>
    typeof value === "string" && expected !== "" && safeEqual(value, expected);

  const tooMany = (reply: FastifyReply, waitMs: number) =>
    void securityHeaders(reply)
      .code(429)
      .header("retry-after", String(Math.ceil(waitMs / 1000)))
      .header("content-type", "text/plain; charset=utf-8")
      .send(t.login.tooMany(Math.ceil(waitMs / 60_000)));

  // The page itself without the notice, for the automatic reload.
  const refreshUrl = (request: FastifyRequest): string => {
    const [path, query = ""] = request.url.split("?");
    const params = new URLSearchParams(query);
    params.delete("notice");
    const rest = params.toString();
    return `${path ?? "/admin"}${rest ? `?${rest}` : ""}`;
  };
  const refresh = (request: FastifyRequest) => ({
    seconds: REFRESH_SECONDS,
    url: refreshUrl(request),
  });

  void app.register(formbody, { bodyLimit: FORM_BODY_LIMIT });

  const checkHost = authDisabled || options.allowedHosts !== undefined;
  const allowedHosts = new Set(options.allowedHosts ?? []);

  const plain = (reply: FastifyReply, status: number, text: string) =>
    void securityHeaders(reply)
      .code(status)
      .header("content-type", "text/plain; charset=utf-8")
      .send(text);

  app.addHook("onRequest", (request, reply, next) => {
    if (checkHost && !hostAllowed(request.headers.host, allowedHosts)) {
      plain(reply, 403, t.plain.unknownHost);
      return;
    }
    const path = requestPath(request);
    // The stylesheet, script, font and icons carry no data; the login page needs them. Only
    // one plain file name below the prefix: anything longer would reach other routes.
    const publicAsset = request.method === "GET" && isAssetPath(path);
    if (auth && path !== "/admin/login" && !publicAsset && !signedIn(request)) {
      if (path.startsWith("/admin/api/")) {
        const wait = throttle.blockedFor(request.ip);
        if (wait > 0) {
          tooMany(reply, wait);
          return;
        }
        const given = parseBasicAuth(request.headers.authorization);
        if (!credentialsMatch(given, auth)) {
          // A request without credentials is a question, not a guess.
          if (given !== null) throttle.fail(request.ip);
          void securityHeaders(reply)
            .code(401)
            .header("www-authenticate", 'Basic realm="mc-bridge admin", charset="UTF-8"')
            .send({ error: "Unauthorized", message: t.plain.authRequired });
          return;
        }
      } else {
        const target =
          request.method === "GET"
            ? `/admin/login?next=${encodeURIComponent(request.url)}`
            : "/admin/login";
        void securityHeaders(reply).redirect(target, 303);
        return;
      }
    }
    if (request.method === "POST" && !sameOrigin(request)) {
      plain(reply, 403, t.plain.crossOrigin);
      return;
    }
    next();
  });

  // Forms need the form token. The JSON endpoints need a JSON body instead.
  app.addHook("preHandler", (request, reply, next) => {
    if (request.method !== "POST") return next();
    if (requestPath(request).startsWith("/admin/api/")) {
      const type = request.headers["content-type"] ?? "";
      if (!/^application\/json\b/i.test(type)) {
        void securityHeaders(reply)
          .code(415)
          .send({ error: "Unsupported Media Type", message: "Send a JSON body." });
        return;
      }
      return next();
    }
    const body = (request.body ?? {}) as FormBody;
    const login = requestPath(request) === "/admin/login";
    const expected = login ? loginToken : csrf(request);
    if (!tokenValid(body._csrf, expected)) {
      void render(
        reply,
        t.titles.formExpired,
        errorView({
          icon: "clock",
          code: "403",
          title: t.titles.formExpired,
          text: t.errors.formExpired,
          back: login
            ? { href: "/admin/login", label: t.login.title }
            : { href: "/admin", label: t.links.backToDashboard },
        }),
        { status: 403, bare: login || !signedIn(request) },
      );
      return;
    }
    next();
  });

  // Hashed file names: a file never changes under its name, so browsers keep it for a year.
  app.get<{ Params: { file: string } }>("/admin/assets/:file", (request, reply) => {
    const file = assets.get(request.params.file);
    if (!file) {
      return reply
        .code(404)
        .header("cache-control", "no-store")
        .header("content-type", "text/plain; charset=utf-8")
        .send("Not Found");
    }
    return reply
      .header("content-type", file.type)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("cross-origin-resource-policy", "same-origin")
      .send(file.body);
  });

  app.get("/admin/login", (request, reply) => {
    if (authDisabled || signedIn(request)) return reply.redirect("/admin", 303);
    const query = request.query as Record<string, unknown>;
    return render(
      reply,
      t.login.title,
      loginView(
        { formToken: loginToken, next: safeNext(query.next), user: "", notice: notice(request) },
        t,
      ),
      { bare: true },
    );
  });

  app.post("/admin/login", (request, reply) => {
    if (!auth || !sessions) return reply.redirect("/admin", 303);
    const body = request.body as FormBody;
    const given = {
      user: typeof body.user === "string" ? body.user : "",
      password: typeof body.password === "string" ? body.password : "",
    };
    const next = safeNext(body.next);
    const wait = throttle.blockedFor(request.ip);
    const form = (error: string) =>
      loginView({ formToken: loginToken, next, user: given.user.slice(0, 200), error }, t);
    if (wait > 0) {
      options.logger.warn({ ip: request.ip }, "admin login refused: too many failures");
      return render(reply, t.login.title, form(t.login.tooMany(Math.ceil(wait / 60_000))), {
        status: 429,
        bare: true,
      });
    }
    if (!credentialsMatch(given, auth)) {
      throttle.fail(request.ip);
      options.logger.warn({ ip: request.ip }, "admin login with wrong credentials");
      return render(reply, t.login.title, form(t.login.wrongCredentials), {
        status: 401,
        bare: true,
      });
    }
    throttle.succeed(request.ip);
    options.logger.info({ ip: request.ip }, "admin logged in");
    return securityHeaders(reply)
      .header("set-cookie", sessionCookie(sessions.issue(now()), isHttps(request)))
      .redirect(next, 303);
  });

  // Ends every session issued so far, on every device: the cookie alone could be copied.
  app.post("/admin/logout", (request, reply) => {
    if (!authDisabled) {
      settings.set(SESSIONS_VALID_AFTER_KEY, String(now().getTime()));
      options.logger.info({ ip: request.ip }, "admin logged out");
    }
    return securityHeaders(reply)
      .header("set-cookie", clearedSessionCookie(isHttps(request)))
      .redirect(authDisabled ? "/admin" : "/admin/login?notice=logged-out", 303);
  });

  // The theme switch without the script; with it, the script sets the same cookie. The
  // cookie holds only "system", "light" or "dark".
  app.post("/admin/theme", (request, reply) => {
    const body = request.body as FormBody;
    const value = parseTheme(body.theme);
    const cookie = [
      `${THEME_COOKIE}=${value}`,
      `Path=${ADMIN_COOKIE_PATH}`,
      "Max-Age=31536000",
      "SameSite=Lax",
      ...(isHttps(request) ? ["Secure"] : []),
    ].join("; ");
    return securityHeaders(reply).header("set-cookie", cookie).redirect(safeNext(body.next), 303);
  });

  app.post("/admin/setup/dismiss", (_request, reply) => {
    settings.set(SETUP_DISMISSED_KEY, now().toISOString());
    return reply.redirect("/admin", 303);
  });

  // Whether Mealie answers with the API token, asked at most every MEALIE_CHECK_TTL_MS so
  // the overview stays fast; an unreachable Mealie costs at most MEALIE_CHECK_TIMEOUT_MS.
  let mealieChecked: { at: number; result: MealieCheck } | null = null;
  let mealiePending: Promise<MealieCheck> | null = null;
  const checkMealie = async (): Promise<MealieCheck> => {
    const probe = options.mealieCheck;
    if (!probe) return { state: "unchecked", error: null, checkedAt: null, user: null };
    const started = now();
    if (mealieChecked && started.getTime() - mealieChecked.at < MEALIE_CHECK_TTL_MS) {
      return mealieChecked.result;
    }
    mealiePending ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(t.mealieTimeout(MEALIE_CHECK_TIMEOUT_MS / 1000))),
          MEALIE_CHECK_TIMEOUT_MS,
        );
      });
      let result: MealieCheck;
      try {
        const answer = await Promise.race([probe(), timeout]);
        result = {
          state: "ok",
          error: null,
          checkedAt: started.toISOString(),
          user: mealieUser(answer),
        };
      } catch (error) {
        result = {
          state: "failed",
          error: errorMessage(error),
          checkedAt: started.toISOString(),
          user: null,
        };
      } finally {
        clearTimeout(timer);
      }
      mealieChecked = { at: started.getTime(), result };
      mealiePending = null;
      return result;
    })();
    return mealiePending;
  };

  const webhookInfo = (request: FastifyRequest): WebhookInfo | null => {
    const hook = options.webhook;
    if (!hook) return null;
    const host = request.headers.host;
    return {
      dockerBase: `http://${COMPOSE_SERVICE}:${hook.port}/hooks/mealie/`,
      pageBase: host ? `${isHttps(request) ? "https" : "http"}://${host}/hooks/mealie/` : null,
      token: hook.token,
    };
  };

  const context: AdminContext = {
    app,
    t,
    csrf,
    view,
    render,
    notice,
    checkMealie,
    webhookInfo,
    now,
  };
  const settingsPage = registerSettings(context, {
    autoLogin: options.autoLogin ?? null,
    session: options.session,
    config: options.config ?? null,
    jobs: options.store.jobs,
    locale: {
      mcLocale: options.locale.pack.locale,
      verified: options.locale.pack.mc.verifiedOnDevice,
      uiLanguage: options.language ?? "en",
      recipeStatus: options.recipeStatus,
    },
    mealieUrl: options.mealieUrl ?? null,
    ai: options.ai ?? null,
    limits: options.dailyLimits ?? { jobs: 0, costUsd: 0 },
    mail: options.mail ?? null,
    dataDir: options.dataDir ?? null,
  });

  app.get("/admin", async (request, reply) => {
    const ctx = view(request);
    const at = ctx.now.getTime();
    const autoLogin = options.autoLogin?.status() ?? null;
    const recent = options.store.jobs.listRecent({ limit: 8 });
    const lastFailedJob = options.store.jobs.listRecent({ limit: 1, status: "failed" })[0] ?? null;
    return render(
      reply,
      t.titles.dashboard,
      dashboardView(
        {
          session: options.session.status(),
          worker: options.worker?.status() ?? null,
          stats: options.store.jobs.stats(),
          summary: options.store.jobs.summarySince(new Date(at - 30 * DAY_MS)),
          today: options.store.jobs.usageSince(new Date(at - DAY_MS)),
          limits: options.dailyLimits ?? { jobs: 0, costUsd: 0 },
          jobs: recent,
          mealie: { url: options.mealieUrl ?? null, check: await checkMealie() },
          autoLogin: autoLogin
            ? {
                configured: autoLogin.configured,
                email: autoLogin.email,
                last: autoLogin.last ? { ok: autoLogin.last.ok, at: autoLogin.last.at } : null,
              }
            : null,
          ai: options.ai ?? null,
          lastFailedJob,
          stages: options.store.jobs.failureStages(
            [...recent, ...(lastFailedJob ? [lastFailedJob] : [])].map((job) => job.id),
          ),
          setupDismissed: settings.get(SETUP_DISMISSED_KEY) !== null,
        },
        ctx,
      ),
      {
        notice: notice(request),
        active: "dashboard",
        refresh: recent.some((job) => isActive(job.status)) ? refresh(request) : null,
      },
    );
  });

  app.post("/admin/session", async (request, reply) => {
    const body = request.body as FormBody;
    try {
      await options.session.setCookie(typeof body.cookie === "string" ? body.cookie : "");
      options.worker?.nudge?.();
      return reply.redirect("/admin/settings?notice=session-saved", 303);
    } catch (error) {
      if (error instanceof InvalidCookieError) {
        return settingsPage(request, reply, { status: 400, error: t.errors.cookieEmpty });
      }
      if (error instanceof SessionRejectedError) {
        return settingsPage(request, reply, {
          status: 422,
          error: t.errors.cookieRejected(error.message),
        });
      }
      options.logger.warn({ err: errorMessage(error) }, "could not verify a new session cookie");
      return settingsPage(request, reply, {
        status: 502,
        error: t.errors.cookieUnchecked(errorMessage(error)),
      });
    }
  });

  // The same as the cookie form, for scripts: {"cookie": "..."} in, the session state out.
  app.post("/admin/api/session", { bodyLimit: API_BODY_LIMIT }, async (request, reply) => {
    const body = request.body as { cookie?: unknown } | null;
    const cookie = typeof body?.cookie === "string" ? body.cookie : "";
    const answer = (status: number, extra: Record<string, unknown>) =>
      securityHeaders(reply)
        .code(status)
        .send({ ...extra, session: sessionJson(options.session.status()) });
    try {
      await options.session.setCookie(cookie);
      options.worker?.nudge?.();
      options.logger.info({}, "session cookie saved through the admin API");
      return answer(200, { saved: true });
    } catch (error) {
      if (error instanceof InvalidCookieError) {
        return answer(400, { saved: false, error: "Bad Request", message: "cookie is empty" });
      }
      if (error instanceof SessionRejectedError) {
        return answer(422, { saved: false, error: "Rejected", message: error.message });
      }
      options.logger.warn({ err: errorMessage(error) }, "could not verify a new session cookie");
      return answer(502, {
        saved: false,
        error: "Not Checked",
        message: `the cookie could not be checked: ${errorMessage(error)}`,
      });
    }
  });

  app.get("/admin/api/session", (_request, reply) =>
    securityHeaders(reply).send({ session: sessionJson(options.session.status()) }),
  );

  app.post("/admin/session/check", async (_request, reply) => {
    await options.session.check();
    options.worker?.nudge?.();
    return reply.redirect("/admin/settings?notice=session-checked", 303);
  });

  app.get("/admin/jobs", (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const raw = typeof query.status === "string" ? query.status : "";
    const filter: JobFilter = (JOB_FILTERS as readonly string[]).includes(raw)
      ? (raw as JobFilter)
      : "all";
    // A single status, as older links and the overview's old tiles carry it.
    const status =
      filter === "all" && JOB_STATUSES.includes(raw as JobStatus) ? (raw as JobStatus) : null;
    const search = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
    const offsetRaw = typeof query.offset === "string" ? Number.parseInt(query.offset, 10) : 0;
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    const limit = 50;
    const statuses = status ? [status] : FILTER_STATUSES[filter];
    const jobs = options.store.jobs.listRecent({
      limit,
      offset,
      ...(statuses ? { status: statuses } : {}),
      ...(search ? { search } : {}),
    });
    const refreshing = jobs.some((job) => isActive(job.status));
    return render(
      reply,
      t.titles.jobs,
      jobListView(
        {
          jobs,
          stats: options.store.jobs.stats(search ? { search } : {}),
          filter,
          status,
          search,
          offset,
          limit,
          recipeStatus: options.recipeStatus,
          stages: options.store.jobs.failureStages(jobs.map((job) => job.id)),
        },
        view(request),
      ),
      {
        notice: notice(request),
        active: "jobs",
        refresh: refreshing ? refresh(request) : null,
      },
    );
  });

  const notFound = (reply: FastifyReply, text: string, back = "/admin") =>
    render(
      reply,
      t.titles.notFound,
      errorView({
        icon: "search",
        code: "404",
        title: t.titles.notFound,
        text,
        back:
          back === "/admin/jobs"
            ? { href: back, label: t.links.backToJobs }
            : { href: "/admin", label: t.links.backToDashboard },
      }),
      { status: 404, active: back === "/admin/jobs" ? "jobs" : null },
    );

  app.get<{ Params: { id: string } }>("/admin/jobs/:id", (request, reply) => {
    const found = options.store.jobs.getWithEvents(request.params.id);
    if (!found) return notFound(reply, t.errors.noSuchJob, "/admin/jobs");
    const query = request.query as Record<string, unknown>;
    const tab: JobTab = (JOB_TABS as readonly string[]).includes(query.tab as string)
      ? (query.tab as JobTab)
      : "overview";
    const slug = found.job.mealieSlug;
    return render(
      reply,
      found.job.title ?? t.titles.job,
      jobDetailView(
        {
          job: found.job,
          events: found.events,
          mealieUrl: slug && options.mealieRecipeUrl ? options.mealieRecipeUrl(slug) : null,
          recipeStatus: options.recipeStatus,
          tab,
        },
        view(request),
      ),
      {
        notice: notice(request),
        active: "jobs",
        refresh: isActive(found.job.status) ? refresh(request) : null,
      },
    );
  });

  const jobAction = (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    action: () => string,
  ) => {
    const id = request.params.id;
    try {
      const key = action();
      return reply.redirect(`/admin/jobs/${encodeURIComponent(id)}?notice=${key}`, 303);
    } catch (error) {
      if (!(error instanceof JobConflictError)) throw error;
      const missing = options.store.jobs.get(id) === null;
      return render(
        reply,
        t.titles.notPossible,
        errorView({
          icon: "ban",
          code: missing ? "404" : "409",
          title: t.titles.notPossible,
          text: error.message,
          back: missing
            ? { href: "/admin/jobs", label: t.links.backToJobs }
            : { href: `/admin/jobs/${encodeURIComponent(id)}`, label: t.links.backToJob },
        }),
        { status: missing ? 404 : 409, active: "jobs", error: error.message },
      );
    }
  };

  app.post<{ Params: { id: string } }>("/admin/jobs/:id/retry", (request, reply) =>
    jobAction(request, reply, () => {
      const force = (request.body as FormBody).force === "1";
      options.store.jobs.requeue(request.params.id, { force });
      options.worker?.nudge?.();
      return force ? "job-forced" : "job-queued";
    }),
  );

  app.post<{ Params: { id: string } }>("/admin/jobs/:id/cancel", (request, reply) =>
    jobAction(request, reply, () => {
      options.store.jobs.cancel(request.params.id);
      return "job-cancelled";
    }),
  );

  // The small Mealie image of a recipe, through the bridge, so the pages need no other
  // origin and Mealie needs no login in the browser. Only WebP from Mealie passes; anything
  // else, a missing image or an error gives the placeholder.
  const thumbnails = new Map<string, { at: number; body: Buffer | null }>();
  const loadThumbnail = async (recipeId: string): Promise<Buffer | null> => {
    const at = now().getTime();
    const cached = thumbnails.get(recipeId);
    if (cached) {
      const ttl = cached.body ? THUMBNAIL_TTL_MS : THUMBNAIL_MISS_TTL_MS;
      if (at - cached.at < ttl) return cached.body;
      thumbnails.delete(recipeId);
    }
    let body: Buffer | null = null;
    try {
      const bytes = (await options.mealie.getRecipeThumbnail?.(recipeId)) ?? null;
      body = bytes && isWebp(bytes) ? bytes : null;
    } catch (error) {
      options.logger.debug({ recipeId, err: errorMessage(error) }, "thumbnail not loaded");
    }
    if (thumbnails.size >= THUMBNAIL_CACHE_SIZE) {
      const oldest = thumbnails.keys().next().value;
      if (oldest !== undefined) thumbnails.delete(oldest);
    }
    thumbnails.set(recipeId, { at, body });
    return body;
  };

  app.get<{ Params: { id: string } }>("/admin/recipes/:id/thumbnail", async (request, reply) => {
    const id = request.params.id;
    const body = RECIPE_ID.test(id) ? await loadThumbnail(id) : null;
    void reply
      .header("cache-control", "private, max-age=3600")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cross-origin-resource-policy", "same-origin");
    return body
      ? reply.header("content-type", "image/webp").send(body)
      : reply.header("content-type", "image/svg+xml").send(THUMBNAIL_PLACEHOLDER);
  });

  // The recipe picker of the dry run: recipes whose name matches, as JSON.
  app.get("/admin/dry-run/recipes", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
    securityHeaders(reply).header("content-type", "application/json; charset=utf-8");
    if (q.length < 2 || !options.mealie.searchRecipes) return reply.send({ recipes: [] });
    try {
      return reply.send({ recipes: await options.mealie.searchRecipes(q, 10) });
    } catch (error) {
      return reply.code(502).send({ recipes: [], error: errorMessage(error, 200) });
    }
  });

  // The preview is a GET and costs nothing. The conversion, which is a paid model call, is
  // a POST: the form token travels in the body, never in a URL that proxies and browser
  // histories keep, and the preHandler has checked it before this runs.
  const dryRun = async (
    request: FastifyRequest,
    reply: FastifyReply,
    input: Record<string, unknown>,
    convert: boolean,
  ) => {
    const recipeParam = typeof input.recipe === "string" ? input.recipe.trim().slice(0, 200) : "";
    const scaleRaw = typeof input.scale === "string" ? Number(input.scale) : 1;
    const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? quantizeScale(scaleRaw) : 1;
    const ctx = view(request);
    const data: DryRunData = { recipeParam, scale, recipeStatus: options.recipeStatus };
    const show = (status = 200) =>
      render(reply, t.titles.dryRun, dryRunView(data, ctx), { status, active: "dryRun" });
    if (!recipeParam) return show();

    let recipe;
    try {
      recipe = await options.mealie.getRecipe(recipeParam);
    } catch (error) {
      // Not an id or a slug: perhaps part of a name.
      const matches = options.mealie.searchRecipes
        ? await options.mealie.searchRecipes(recipeParam, 10).catch(() => [])
        : [];
      if (matches.length > 0) {
        data.matches = matches;
        return show();
      }
      data.loadError = t.errors.recipeNotLoaded(errorMessage(error));
      return show(502);
    }
    const prepared = prepareRecipe(recipe, scale, options.limits, options.locale, {
      ...(options.tagName ? { excludeTags: [options.tagName] } : {}),
    });
    data.title = recipe.name;
    data.recipeParam = recipe.slug || recipeParam;
    data.prepared = prepared;
    data.sent = options.store.mcRecipes.find(recipe.id, scale, prepared.hash);

    if (convert) {
      try {
        const plan = await planCategories(
          recipe,
          options.mc,
          options.store.settings,
          options.locale,
          {
            ...(options.now ? { now: options.now } : {}),
            isSessionError: (error) => error instanceof McSessionError,
          },
        );
        const result = await options.converter.convert(
          conversionRequest(recipe, prepared, plan, options.locale.pack.locale, {
            ingredients: options.ingredients,
          }),
        );
        data.conversion = { plan, result, checked: checkConverted(result, plan, options.limits) };
      } catch (error) {
        data.conversionError = t.errors.conversionFailed(errorMessage(error));
      }
    }
    return show();
  };

  app.get("/admin/dry-run", (request, reply) =>
    dryRun(request, reply, request.query as Record<string, unknown>, false),
  );

  app.post("/admin/dry-run", (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return dryRun(request, reply, body, body.convert === "1");
  });

  options.extend?.(context);

  // Any other address under /admin, with any method, after the login: a 404 in the frame of
  // the pages. Registered here, the login hook runs first, so an unknown address and a
  // known one answer a visitor without a login alike.
  app.all("/admin/*", (_request, reply) => notFound(reply, t.errors.noSuchPage));

  // An unexpected error answers with the error page; the message stays in the log. The JSON
  // endpoints keep the generic body of the server.
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: errorMessage(error) }, "request failed");
    if (requestPath(request).startsWith("/admin/api/")) {
      return reply.code(status >= 500 ? 500 : status).send({
        statusCode: status >= 500 ? 500 : status,
        error: status >= 500 ? "Internal Server Error" : "Bad Request",
        message: status >= 500 ? "Internal Server Error" : errorMessage(error, 200),
      });
    }
    const server = status >= 500;
    return render(
      reply,
      server ? t.titles.error : t.titles.badRequest,
      errorView({
        icon: server ? "octagon-alert" : "circle-alert",
        code: String(server ? 500 : status),
        title: server ? t.titles.error : t.titles.badRequest,
        text: server ? t.errors.server : t.errors.badRequest,
        back: { href: "/admin", label: t.links.backToDashboard },
      }),
      { status: server ? 500 : status, bare: !signedIn(request) && !authDisabled },
    );
  });

  done();
}

// IP addresses cannot be rebound and localhost resolves locally, so both are safe without
// a list. Any other name must be on it.
export function hostAllowed(header: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!header) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.startsWith("[")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return allowed.has(hostname);
}

// A POST from a form on this host carries no Origin (older browsers) or our own host.
function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  if (!host) return false;
  try {
    const from = new URL(origin);
    // Parsed with the same scheme, so a default port in the Host header compares equal.
    return from.host === new URL(`${from.protocol}//${host}`).host;
  } catch {
    return false;
  }
}
