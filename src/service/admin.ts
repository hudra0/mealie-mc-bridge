// The admin pages: session status and renewal, the queue, job details with retry and
// cancel, and a dry run that shows what the converter would get and make.
//
// Protection, in layers:
// - Basic Auth with ADMIN_USER and ADMIN_PASSWORD, compared in constant time. Without both,
//   the pages are open (a warning is logged and every page shows a banner); bind the port
//   to localhost or the LAN only.
// - Forms carry a random token created when the process starts. A page on another site
//   cannot read it (same-origin policy), so it cannot forge a POST, even though the browser
//   would attach the Basic Auth credentials. The dry-run conversion, which costs money,
//   needs the token as well. After a restart, reload the page before submitting a form.
// - A POST whose Origin header names another host is refused.
// - Without Basic Auth, only requests for an IP address, localhost or a name in
//   ADMIN_HOSTS get through. A malicious site could otherwise rebind its own name to the
//   bridge's address and use the pages as same-origin. With Basic Auth, the browser does
//   not send the credentials to the rebound name, so the list applies only when set.

import { randomBytes } from "node:crypto";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorMessage, type AppLogger } from "../app-logger.js";
import { McSessionError, type McRecipeSink } from "../mc/index.js";
import { MAX_SCALE } from "../mealie/index.js";
import type { Converter } from "../pipeline/converter-port.js";
import {
  checkConverted,
  conversionRequest,
  planCategories,
  prepareRecipe,
} from "../pipeline/prepare.js";
import type { MealiePort } from "../pipeline/run-job.js";
import type { WorkerStatus } from "../pipeline/worker.js";
import type { DeviceLimits } from "../recipe/limits.js";
import {
  InvalidCookieError,
  SessionRejectedError,
  type SessionManager,
} from "../session/manager.js";
import { JOB_STATUSES, JobConflictError, type JobStatus, type JobStore } from "../store/jobs.js";
import type { McRecipeStore } from "../store/mc-recipes.js";
import type { SettingsStore } from "../store/settings.js";
import {
  dashboardView,
  dryRunView,
  jobDetailView,
  jobListView,
  type DryRunData,
} from "./admin-views.js";
import { html, page, type SafeHtml } from "./html.js";
import { credentialsMatch, parseBasicAuth, safeEqual, type Credentials } from "./security.js";

export interface AdminOptions {
  // Null turns Basic Auth off.
  auth: Credentials | null;
  // ADMIN_HOSTS: host names, lower case, without ports.
  allowedHosts?: readonly string[];
  store: { jobs: JobStore; mcRecipes: McRecipeStore; settings: SettingsStore };
  session: Pick<SessionManager, "status" | "setCookie" | "check">;
  mealie: Pick<MealiePort, "getRecipe">;
  mc: Pick<McRecipeSink, "getCategories">;
  converter: Converter;
  limits: DeviceLimits;
  logger: AppLogger;
  recipeStatus: "draft" | "private-publish";
  worker?: { status(): WorkerStatus; nudge?(): void };
  // The link to a recipe in Mealie, or null when the public URL is unknown.
  mealieRecipeUrl?: (slug: string) => string | null;
  // Fixed in tests; random otherwise.
  formToken?: string;
  now?: () => Date;
}

const FORM_BODY_LIMIT = 64 * 1024;
const NOTICES: Readonly<Record<string, string>> = {
  "session-saved": "Session saved. Jobs that were waiting for it are queued again.",
  "session-checked": "Session checked.",
  "job-queued": "Job queued again.",
  "job-forced": "Job queued again; it will be sent even if the recipe is unchanged.",
  "job-cancelled": "Job cancelled.",
};

interface FormBody {
  _csrf?: string;
  cookie?: string;
  force?: string;
}

export function admin(
  app: FastifyInstance,
  options: AdminOptions,
  done: (error?: Error) => void,
): void {
  const formToken = options.formToken ?? randomBytes(32).toString("hex");
  const authDisabled = options.auth === null;
  if (authDisabled) {
    options.logger.warn(
      {},
      "ADMIN_USER and ADMIN_PASSWORD are not set: the admin pages have no password",
    );
  }

  const render = (
    reply: FastifyReply,
    title: string,
    body: SafeHtml,
    extra: { status?: number; notice?: string | null; error?: string | null } = {},
  ) =>
    reply
      .code(extra.status ?? 200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "same-origin")
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .send(
        page({
          title,
          body,
          authDisabled,
          notice: extra.notice ?? null,
          error: extra.error ?? null,
        }),
      );

  const notice = (request: FastifyRequest): string | null => {
    const key = (request.query as Record<string, unknown>).notice;
    return typeof key === "string" ? (NOTICES[key] ?? null) : null;
  };

  const tokenValid = (value: unknown): boolean =>
    typeof value === "string" && safeEqual(value, formToken);

  void app.register(formbody, { bodyLimit: FORM_BODY_LIMIT });

  const checkHost = authDisabled || options.allowedHosts !== undefined;
  const allowedHosts = new Set(options.allowedHosts ?? []);

  app.addHook("onRequest", (request, reply, next) => {
    if (checkHost && !hostAllowed(request.headers.host, allowedHosts)) {
      void reply
        .code(403)
        .header("content-type", "text/plain; charset=utf-8")
        .send("Unknown host name. Add it to ADMIN_HOSTS or use the IP address.");
      return;
    }
    if (
      options.auth &&
      !credentialsMatch(parseBasicAuth(request.headers.authorization), options.auth)
    ) {
      void reply
        .code(401)
        .header("www-authenticate", 'Basic realm="mc-bridge admin", charset="UTF-8"')
        .header("content-type", "text/plain; charset=utf-8")
        .send("Authentication required");
      return;
    }
    if (request.method === "POST" && !sameOrigin(request)) {
      void reply
        .code(403)
        .header("content-type", "text/plain; charset=utf-8")
        .send("Cross-origin request refused");
      return;
    }
    next();
  });

  app.addHook("preHandler", (request, reply, next) => {
    if (request.method !== "POST") return next();
    const body = (request.body ?? {}) as FormBody;
    if (!tokenValid(body._csrf)) {
      void render(reply, "Form expired", html`<p><a href="/admin">Back to the dashboard</a></p>`, {
        status: 403,
        error:
          "The form has expired (the bridge restarted, or the page came from elsewhere). Reload the page and try again.",
      });
      return;
    }
    next();
  });

  const dashboard = (
    reply: FastifyReply,
    extra: { status?: number; notice?: string | null; error?: string | null } = {},
  ) =>
    render(
      reply,
      "Dashboard",
      dashboardView({
        session: options.session.status(),
        stats: options.store.jobs.stats(),
        worker: options.worker?.status() ?? null,
        jobs: options.store.jobs.listRecent({ limit: 20 }),
        formToken,
        recipeStatus: options.recipeStatus,
      }),
      extra,
    );

  app.get("/admin", (request, reply) => dashboard(reply, { notice: notice(request) }));

  app.post("/admin/session", async (request, reply) => {
    const body = request.body as FormBody;
    try {
      await options.session.setCookie(typeof body.cookie === "string" ? body.cookie : "");
      options.worker?.nudge?.();
      return reply.redirect("/admin?notice=session-saved", 303);
    } catch (error) {
      if (error instanceof InvalidCookieError) {
        return dashboard(reply, { status: 400, error: "The cookie field is empty." });
      }
      if (error instanceof SessionRejectedError) {
        return dashboard(reply, {
          status: 422,
          error: `${error.message}. The cookie was not stored. Log in again and copy a fresh one.`,
        });
      }
      options.logger.warn({ err: errorMessage(error) }, "could not verify a new session cookie");
      return dashboard(reply, {
        status: 502,
        error: `The cookie could not be checked, so it was not stored: ${errorMessage(error)}`,
      });
    }
  });

  app.post("/admin/session/check", async (_request, reply) => {
    await options.session.check();
    options.worker?.nudge?.();
    return reply.redirect("/admin?notice=session-checked", 303);
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
    return render(reply, "Jobs", jobListView({ jobs, status, search, offset, limit }), {
      notice: notice(request),
    });
  });

  app.get<{ Params: { id: string } }>("/admin/jobs/:id", (request, reply) => {
    const found = options.store.jobs.getWithEvents(request.params.id);
    if (!found) return render(reply, "Not found", html`<p>No such job.</p>`, { status: 404 });
    const slug = found.job.mealieSlug;
    return render(
      reply,
      found.job.title ?? "Job",
      jobDetailView({
        job: found.job,
        events: found.events,
        formToken,
        mealieUrl: slug && options.mealieRecipeUrl ? options.mealieRecipeUrl(slug) : null,
      }),
      { notice: notice(request) },
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
        "Not possible",
        html`<p><a href="/admin/jobs">Back to the jobs</a></p>`,
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
    const data: DryRunData = { recipeParam, scale, formToken };
    if (!recipeParam) return render(reply, "Dry run", dryRunView(data));

    let recipe;
    try {
      recipe = await options.mealie.getRecipe(recipeParam);
    } catch (error) {
      data.loadError = `The recipe could not be loaded: ${errorMessage(error)}`;
      return render(reply, "Dry run", dryRunView(data), { status: 502 });
    }
    const prepared = prepareRecipe(recipe, scale, options.limits);
    data.title = recipe.name;
    data.prepared = prepared;
    data.sent = options.store.mcRecipes.find(recipe.id, scale, prepared.hash);

    if (query.convert === "1") {
      if (!tokenValid(query._csrf)) {
        data.conversionError =
          "The conversion link has expired (the bridge restarted, or the link came from elsewhere). Use the button below.";
      } else {
        try {
          const plan = await planCategories(recipe, options.mc, options.store.settings, {
            ...(options.now ? { now: options.now } : {}),
            isSessionError: (error) => error instanceof McSessionError,
          });
          const result = await options.converter.convert(conversionRequest(recipe, prepared, plan));
          data.conversion = { plan, result, checked: checkConverted(result, plan, options.limits) };
        } catch (error) {
          data.conversionError = `The conversion failed: ${errorMessage(error)}`;
        }
      }
    }
    return render(reply, "Dry run", dryRunView(data));
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
