// Builds the whole service from its parts: HTTP server, store, session manager, clients,
// converter, worker. main.ts adds configuration, signals and listen; tests build the same
// graph with fakes in place of the network clients.

import type { FastifyInstance, FastifyServerOptions } from "fastify";
import type { AppLogger } from "../app-logger.js";
import type { McRecipeSink } from "../mc/index.js";
import type { Notifier } from "../notify/email.js";
import type { Converter } from "../pipeline/converter-port.js";
import type { IngredientResolverPort } from "../pipeline/ingredient-resolver.js";
import type { PipelineLocale } from "../pipeline/locale.js";
import { runJob, type MealiePort, type PipelineConfig } from "../pipeline/run-job.js";
import { Worker } from "../pipeline/worker.js";
import type { DeviceLimits } from "../recipe/limits.js";
import { buildServer } from "../server.js";
import type { SessionManager } from "../session/manager.js";
import type { Store } from "../store/index.js";
import type { AutoLogin } from "../session/auto-login.js";
import { admin } from "./admin.js";
import type { LoginThrottle } from "./admin-auth.js";
import type { ConfigEntry } from "../config-reference.js";
import { healthReport } from "./health.js";
import { routes } from "./routes.js";

export interface ServiceConfig extends PipelineConfig {
  WEBHOOK_TOKEN: string;
  PORT?: number | undefined;
  ADMIN_USER?: string | undefined;
  ADMIN_PASSWORD?: string | undefined;
  ADMIN_HOSTS?: string[] | undefined;
  WORKER_POLL_SECONDS: number;
  MEALIE_URL: string;
  MEALIE_PUBLIC_URL?: string | undefined;
  MEALIE_GROUP_SLUG: string;
}

export interface ServiceParts {
  config: ServiceConfig;
  store: Store;
  session: SessionManager;
  mealie: MealiePort;
  mc: McRecipeSink;
  converter: Converter;
  limits: DeviceLimits;
  // The locale pack of MC_LOCALE and the category words of every pack.
  locale: PipelineLocale;
  notifier: Notifier;
  // Resolves the systemIngredientId of each ingredient; without it, none is set.
  ingredients?: IngredientResolverPort;
  // The app logger is taken from Fastify once the server exists.
  logger?: AppLogger;
  server?: FastifyServerOptions;
  workerBackoffMs?: (retry: number) => number;
  formToken?: string;
  // Signs the admin login cookie: SETTINGS_KEY. Random when left out.
  adminSessionKey?: Buffer;
  // Counts failed admin logins; tests pass one with their own clock.
  adminThrottle?: LoginThrottle;
  // The automatic login; without it the settings page says it is not available.
  autoLogin?: AutoLogin;
  // The effective configuration the settings page lists, secrets reduced to set or unset.
  configEntries?: readonly ConfigEntry[];
  // Asks Mealie who the API token belongs to, for the overview's setup checklist.
  mealieCheck?: () => Promise<unknown>;
}

// The port of the recipe action URL when the configuration does not name one.
const DEFAULT_PORT = 3000;

export interface Service {
  app: FastifyInstance;
  worker: Worker;
  // Starts the session check and the worker. Call after listen.
  start(): void;
  // Stops the worker (the current job goes back to the queue), the checks and the server.
  stop(): Promise<void>;
}

// The browser link to a recipe in Mealie.
export function mealieRecipeLink(config: ServiceConfig, slug: string): string {
  const base = (config.MEALIE_PUBLIC_URL ?? config.MEALIE_URL).replace(/\/+$/, "");
  return `${base}/g/${encodeURIComponent(config.MEALIE_GROUP_SLUG)}/r/${encodeURIComponent(slug)}`;
}

export function buildService(parts: ServiceParts): Service {
  const { config, store } = parts;
  let worker: Worker | null = null;
  const app = buildServer(parts.server ?? {}, {
    health: () => {
      // Throws when the database or DATA_DIR is unusable; /health then answers 503.
      store.check();
      return healthReport({
        session: parts.session,
        jobs: store.jobs,
        worker: worker ?? {
          status: () => ({
            running: false,
            paused: false,
            currentJobId: null,
            lastError: null,
            lastErrorAt: null,
          }),
        },
      });
    },
  });
  const logger = parts.logger ?? app.log;

  worker = new Worker({
    jobs: store.jobs,
    gate: parts.session,
    logger,
    pollMs: config.WORKER_POLL_SECONDS * 1000,
    ...(parts.workerBackoffMs ? { backoffMs: parts.workerBackoffMs } : {}),
    run: (job, options) =>
      runJob(
        job,
        {
          mealie: parts.mealie,
          mc: parts.mc,
          converter: parts.converter,
          limits: parts.limits,
          locale: parts.locale,
          config,
          logger,
          notifier: parts.notifier,
          // No `session` here: McClient reports a rejected cookie to the session manager
          // itself, together with the cookie it used.
          store,
          ...(parts.ingredients ? { ingredients: parts.ingredients } : {}),
        },
        options,
      ),
  });
  const activeWorker = worker;

  void app.register(routes, {
    webhookToken: config.WEBHOOK_TOKEN,
    jobs: store.jobs,
    onEnqueued: () => activeWorker.nudge(),
  });
  void app.register(admin, {
    auth:
      config.ADMIN_USER && config.ADMIN_PASSWORD
        ? { user: config.ADMIN_USER, password: config.ADMIN_PASSWORD }
        : null,
    ...(config.ADMIN_HOSTS ? { allowedHosts: config.ADMIN_HOSTS } : {}),
    ...(parts.adminSessionKey ? { sessionKey: parts.adminSessionKey } : {}),
    ...(parts.adminThrottle ? { throttle: parts.adminThrottle } : {}),
    store,
    session: parts.session,
    mealie: parts.mealie,
    mc: parts.mc,
    converter: parts.converter,
    limits: parts.limits,
    locale: parts.locale,
    language: config.UI_LANGUAGE,
    logger,
    recipeStatus: config.MC_RECIPE_STATUS,
    tagName: config.TAG_NAME,
    ...(parts.ingredients ? { ingredients: parts.ingredients } : {}),
    worker: activeWorker,
    mealieRecipeUrl: (slug) => mealieRecipeLink(config, slug),
    ...(parts.formToken ? { formToken: parts.formToken } : {}),
    ...(parts.autoLogin ? { autoLogin: parts.autoLogin } : {}),
    ...(parts.configEntries ? { config: parts.configEntries } : {}),
    ...(parts.mealieCheck ? { mealieCheck: parts.mealieCheck } : {}),
    mealieUrl: config.MEALIE_URL,
    webhook: { token: config.WEBHOOK_TOKEN, port: config.PORT ?? DEFAULT_PORT },
  });

  return {
    app,
    worker: activeWorker,
    start: () => {
      parts.session.start();
      activeWorker.start();
    },
    stop: async () => {
      await activeWorker.stop();
      parts.session.stop();
      await app.close();
    },
  };
}
