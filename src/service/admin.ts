// The admin pages: session status and renewal, the queue, job details with retry and
// cancel, and a dry run that shows what the converter would get and make.
//
// Protection, in layers:
// - A login form for ADMIN_USER and ADMIN_PASSWORD, compared in constant time. A correct
//   login sets a signed, HttpOnly, SameSite=Lax session cookie for 12 hours
//   (admin-auth.ts). Without both settings, the pages are open (a warning is logged and
//   every page shows a banner); bind the port to localhost or the LAN only.
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

import { randomBytes } from "node:crypto";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorMessage, type AppLogger } from "../app-logger.js";
import { messages, type AdminMessages, type UiLanguage } from "../i18n/index.js";
import { McSessionError, type McRecipeSink } from "../mc/index.js";
import { MAX_SCALE } from "../mealie/index.js";
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
import {
  ADMIN_COOKIE,
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
import {
  REFRESH_SECONDS,
  SESSION_CLASS,
  dashboardView,
  dryRunView,
  jobDetailView,
  jobListView,
  loginView,
  pageHead,
  type DryRunData,
  type MealieCheck,
  type WebhookInfo,
} from "./admin-views.js";
import { html, page, type NavKey, type SafeHtml } from "./html.js";
import { credentialsMatch, parseBasicAuth, safeEqual, type Credentials } from "./security.js";

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
  mealie: Pick<MealiePort, "getRecipe">;
  // Asks Mealie who the API token belongs to; the overview shows whether it answers.
  mealieCheck?: () => Promise<unknown>;
  // MEALIE_URL, shown next to that check.
  mealieUrl?: string;
  // WEBHOOK_TOKEN and PORT, for the recipe action URL on the overview.
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
export { REFRESH_SECONDS };
// The overview asks Mealie at most this often, and waits this long for an answer.
const MEALIE_CHECK_TTL_MS = 30_000;
const MEALIE_CHECK_TIMEOUT_MS = 4_000;
// The compose service name of the bridge in compose.example.yml.
const COMPOSE_SERVICE = "mc-bridge";

interface FormBody {
  _csrf?: string;
  cookie?: string;
  force?: string;
  user?: string;
  password?: string;
  next?: string;
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
  render: (reply: FastifyReply, title: string, body: SafeHtml, extra?: RenderExtra) => FastifyReply;
  notice: (request: FastifyRequest) => string | null;
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

function requestPath(request: FastifyRequest): string {
  return request.url.split("?")[0] ?? "";
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
  const t: AdminMessages = messages(options.language ?? "en").admin;
  const now = () => options.now?.() ?? new Date();
  if (authDisabled) {
    options.logger.warn(
      {},
      "ADMIN_USER and ADMIN_PASSWORD are not set: the admin pages have no password",
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

  const securityHeaders = (reply: FastifyReply) =>
    reply
      .header("cache-control", "no-store")
      .header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "same-origin");

  const render = (
    reply: FastifyReply,
    title: string,
    body: SafeHtml,
    extra: RenderExtra & { bare?: boolean } = {},
  ) => {
    const state = options.session.status().state;
    return securityHeaders(reply)
      .code(extra.status ?? 200)
      .header("content-type", "text/html; charset=utf-8")
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .send(
        page({
          title,
          labels: t,
          body,
          authDisabled,
          notice: extra.notice ?? null,
          error: extra.error ?? null,
          refresh: extra.refresh ?? null,
          active: extra.active ?? null,
          header: extra.bare
            ? null
            : {
                session: { label: t.sessionState[state], className: SESSION_CLASS[state] },
                user: auth?.user ?? null,
                formToken: csrf(reply.request),
              },
        }),
      );
  };

  const notice = (request: FastifyRequest): string | null => {
    const key = (request.query as Record<string, unknown>).notice;
    return typeof key === "string" ? (t.notices[key] ?? null) : null;
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
    if (auth && path !== "/admin/login" && !signedIn(request)) {
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
    const expected = requestPath(request) === "/admin/login" ? loginToken : csrf(request);
    if (!tokenValid(body._csrf, expected)) {
      void render(
        reply,
        t.titles.formExpired,
        html`<p><a href="/admin">${t.links.backToDashboard}</a></p>`,
        { status: 403, error: t.errors.formExpired, bare: requestPath(request) === "/admin/login" },
      );
      return;
    }
    next();
  });

  app.get("/admin/login", (request, reply) => {
    if (authDisabled || signedIn(request)) return reply.redirect("/admin", 303);
    const query = request.query as Record<string, unknown>;
    return render(
      reply,
      t.login.title,
      loginView({ formToken: loginToken, next: safeNext(query.next), user: "" }, t),
      { bare: true, notice: notice(request) },
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
    if (wait > 0) {
      options.logger.warn({ ip: request.ip }, "admin login refused: too many failures");
      return render(
        reply,
        t.login.title,
        loginView({ formToken: loginToken, next, user: given.user.slice(0, 200) }, t),
        { status: 429, bare: true, error: t.login.tooMany(Math.ceil(wait / 60_000)) },
      );
    }
    if (!credentialsMatch(given, auth)) {
      throttle.fail(request.ip);
      options.logger.warn({ ip: request.ip }, "admin login with wrong credentials");
      return render(
        reply,
        t.login.title,
        loginView({ formToken: loginToken, next, user: given.user.slice(0, 200) }, t),
        { status: 401, bare: true, error: t.login.wrongCredentials },
      );
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

  const context: AdminContext = { app, t, csrf, render, notice };
  const settingsPage = registerSettings(context, {
    autoLogin: options.autoLogin ?? null,
    session: options.session,
    config: options.config ?? null,
    locale: {
      mcLocale: options.locale.pack.locale,
      verified: options.locale.pack.mc.verifiedOnDevice,
      uiLanguage: options.language ?? "en",
      recipeStatus: options.recipeStatus,
    },
    now,
  });

  // Whether Mealie answers with the API token, asked at most every MEALIE_CHECK_TTL_MS so
  // the overview stays fast; an unreachable Mealie costs at most MEALIE_CHECK_TIMEOUT_MS.
  let mealieChecked: { at: number; result: MealieCheck } | null = null;
  let mealiePending: Promise<MealieCheck> | null = null;
  const checkMealie = async (): Promise<MealieCheck> => {
    const probe = options.mealieCheck;
    if (!probe) return { state: "unchecked", error: null, checkedAt: null };
    const started = now();
    if (mealieChecked && started.getTime() - mealieChecked.at < MEALIE_CHECK_TTL_MS) {
      return mealieChecked.result;
    }
    mealiePending ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(t.setup.mealie.timeout(MEALIE_CHECK_TIMEOUT_MS / 1000))),
          MEALIE_CHECK_TIMEOUT_MS,
        );
      });
      let result: MealieCheck;
      try {
        await Promise.race([probe(), timeout]);
        result = { state: "ok", error: null, checkedAt: started.toISOString() };
      } catch (error) {
        result = { state: "failed", error: errorMessage(error), checkedAt: started.toISOString() };
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

  const dashboard = async (reply: FastifyReply, extra: RenderExtra = {}) => {
    const autoLogin = options.autoLogin?.status() ?? null;
    return render(
      reply,
      t.titles.dashboard,
      dashboardView(
        {
          session: options.session.status(),
          stats: options.store.jobs.stats(),
          worker: options.worker?.status() ?? null,
          jobs: options.store.jobs.listRecent({ limit: 10 }),
          recipeStatus: options.recipeStatus,
          now: now(),
          mealie: { url: options.mealieUrl ?? null, check: await checkMealie() },
          autoLogin: autoLogin
            ? { configured: autoLogin.configured, email: autoLogin.email }
            : null,
          webhook: webhookInfo(reply.request),
          lastFailedJob: options.store.jobs.listRecent({ limit: 1, status: "failed" })[0] ?? null,
        },
        t,
      ),
      { ...extra, active: "dashboard" },
    );
  };

  app.get("/admin", (request, reply) => dashboard(reply, { notice: notice(request) }));

  app.post("/admin/session", async (request, reply) => {
    const body = request.body as FormBody;
    try {
      await options.session.setCookie(typeof body.cookie === "string" ? body.cookie : "");
      options.worker?.nudge?.();
      return reply.redirect("/admin/settings?notice=session-saved", 303);
    } catch (error) {
      if (error instanceof InvalidCookieError) {
        return settingsPage(reply, { status: 400, error: t.errors.cookieEmpty });
      }
      if (error instanceof SessionRejectedError) {
        return settingsPage(reply, {
          status: 422,
          error: t.errors.cookieRejected(error.message),
        });
      }
      options.logger.warn({ err: errorMessage(error) }, "could not verify a new session cookie");
      return settingsPage(reply, {
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
    const status = JOB_STATUSES.includes(query.status as JobStatus)
      ? (query.status as JobStatus)
      : null;
    const search = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
    const offsetRaw = typeof query.offset === "string" ? Number.parseInt(query.offset, 10) : 0;
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    const limit = 50;
    const jobs = options.store.jobs.listRecent({
      limit,
      offset,
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
    });
    const refreshing = jobs.some((job) => job.status === "queued" || job.status === "running");
    return render(
      reply,
      t.titles.jobs,
      jobListView(
        {
          jobs,
          status,
          search,
          offset,
          limit,
          recipeStatus: options.recipeStatus,
          refreshing,
          now: now(),
        },
        t,
      ),
      {
        notice: notice(request),
        active: "jobs",
        refresh: refreshing ? { seconds: REFRESH_SECONDS, url: refreshUrl(request) } : null,
      },
    );
  });

  app.get<{ Params: { id: string } }>("/admin/jobs/:id", (request, reply) => {
    const found = options.store.jobs.getWithEvents(request.params.id);
    if (!found) {
      return render(
        reply,
        t.titles.notFound,
        html`${pageHead(t.titles.notFound, t.errors.noSuchJob)}
          <p><a href="/admin/jobs">${t.links.backToJobs}</a></p>`,
        { status: 404, active: "jobs" },
      );
    }
    const slug = found.job.mealieSlug;
    const refreshing = found.job.status === "queued" || found.job.status === "running";
    return render(
      reply,
      found.job.title ?? t.titles.job,
      jobDetailView(
        {
          job: found.job,
          events: found.events,
          formToken: csrf(request),
          mealieUrl: slug && options.mealieRecipeUrl ? options.mealieRecipeUrl(slug) : null,
          recipeStatus: options.recipeStatus,
          now: now(),
          refreshing,
        },
        t,
      ),
      {
        notice: notice(request),
        active: "jobs",
        refresh: refreshing ? { seconds: REFRESH_SECONDS, url: refreshUrl(request) } : null,
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
        html`<p><a href="/admin/jobs">${t.links.backToJobs}</a></p>`,
        {
          status: missing ? 404 : 409,
          error: error.message,
        },
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

  app.get("/admin/dry-run", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const recipeParam = typeof query.recipe === "string" ? query.recipe.trim().slice(0, 200) : "";
    const scaleRaw = typeof query.scale === "string" ? Number(query.scale) : 1;
    const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 && scaleRaw <= MAX_SCALE ? scaleRaw : 1;
    const formToken = csrf(request);
    const data: DryRunData = { recipeParam, scale, formToken, recipeStatus: options.recipeStatus };
    if (!recipeParam)
      return render(reply, t.titles.dryRun, dryRunView(data, t), { active: "dryRun" });

    let recipe;
    try {
      recipe = await options.mealie.getRecipe(recipeParam);
    } catch (error) {
      data.loadError = t.errors.recipeNotLoaded(errorMessage(error));
      return render(reply, t.titles.dryRun, dryRunView(data, t), {
        status: 502,
        active: "dryRun",
      });
    }
    const prepared = prepareRecipe(recipe, scale, options.limits, options.locale, {
      ...(options.tagName ? { excludeTags: [options.tagName] } : {}),
    });
    data.title = recipe.name;
    data.prepared = prepared;
    data.sent = options.store.mcRecipes.find(recipe.id, scale, prepared.hash);

    if (query.convert === "1") {
      if (!tokenValid(query._csrf, formToken)) {
        data.conversionError = t.errors.conversionLinkExpired;
      } else {
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
    }
    return render(reply, t.titles.dryRun, dryRunView(data, t), { active: "dryRun" });
  });

  options.extend?.(context);

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
