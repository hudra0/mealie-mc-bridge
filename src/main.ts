import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pino } from "pino";
import { loadServiceConfig } from "./config.js";
import { effectiveConfig } from "./config-reference.js";
import { loadConfiguredCatalog } from "./ingredients/catalog.js";
import { catalogMatchRules } from "./ingredients/catalog-match.js";
import { loggerOptions } from "./logger.js";
import { McClient, McTransport, StaticSessionProvider } from "./mc/index.js";
import { MealieClient } from "./mealie/index.js";
import { createNotifier } from "./notify/email.js";
import { loadConverter } from "./pipeline/converter-port.js";
import { IngredientResolver } from "./pipeline/ingredient-resolver.js";
import { loadPipelineLocale } from "./pipeline/locale.js";
import { loadDeviceLimits } from "./recipe/limits.js";
import { buildService, mealieRecipeLink } from "./service/app.js";
import { requestLogSerializers } from "./service/security.js";
import { AutoLogin } from "./session/auto-login.js";
import { SessionManager } from "./session/manager.js";
import { PlaywrightBrowser } from "./session/playwright-browser.js";
import {
  checkDataDir,
  generateSettingsKey,
  openStore,
  parseSettingsKey,
  processIds,
  storeStartupMessage,
  type Store,
} from "./store/index.js";

// A stuck job or converter must not keep the container from stopping.
const SHUTDOWN_TIMEOUT_MS = 40_000;

async function main(): Promise<void> {
  // `node dist/main.js generate-secrets` prints fresh values for .env and exits.
  if (process.argv[2] === "generate-secrets") {
    process.stdout.write(
      `SETTINGS_KEY=${generateSettingsKey()}\nWEBHOOK_TOKEN=${randomBytes(32).toString("hex")}\n`,
    );
    return;
  }

  // Local runs read .env from the working directory. Variables that are already set win.
  // Containers set NODE_ENV=production and get their settings from the environment.
  if (process.env.NODE_ENV !== "production" && existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const config = loadServiceConfig();
  const base = loggerOptions(config.LOG_LEVEL);
  const logger = pino({ ...base, serializers: { ...base.serializers, ...requestLogSerializers } });

  const settingsKey = parseSettingsKey(config.SETTINGS_KEY);
  let store: Store;
  let recovered: number;
  try {
    checkDataDir(config.DATA_DIR);
    store = openStore({ dataDir: config.DATA_DIR, key: settingsKey });
    // The first write: it fails here, not in the first job, on a read-only database.
    recovered = store.jobs.recoverInterrupted();
  } catch (error) {
    // One line that says what to do, then a non-zero exit so the orchestrator shows it.
    logger.fatal(
      { dataDir: config.DATA_DIR, ...processIds() },
      storeStartupMessage(error, config.DATA_DIR),
    );
    process.exitCode = 1;
    return;
  }
  if (recovered > 0) {
    logger.warn({ recovered }, "jobs interrupted by the last stop are queued again");
  }

  const limits = await loadDeviceLimits(config.DEVICE_PROGRAMS_PATH);
  const locale = await loadPipelineLocale(config.KNOWLEDGE_DIR, config.MC_LOCALE);
  const mcLocale = locale.pack.mc;
  if (!mcLocale.verifiedOnDevice) {
    logger.warn(
      { locale: mcLocale.locale },
      "the locale pack is not verified on a device; check the first recipes in the web editor",
    );
  }
  const mealie = new MealieClient(config.MEALIE_URL, config.MEALIE_API_TOKEN, fetch, { logger });
  const notifier = createNotifier(config, logger, {
    recipeUrl: (job) => (job.mealieSlug ? mealieRecipeLink(config, job.mealieSlug) : null),
  });
  const transport = new McTransport({
    logger,
    locale: mcLocale,
    uploadHosts: config.MC_UPLOAD_HOSTS,
  });
  // Logs in with the Lidl account from the settings page when the session expires. Without
  // Playwright and its Chromium the page says the browser is missing; the rest works. Each
  // attempt runs in a fresh profile under DATA_DIR/tmp; cleanUp removes what a crash left
  // behind and the persistent profile of 0.2.0.
  const autoLogin = new AutoLogin({
    settings: store.settings,
    browser: new PlaywrightBrowser(),
    tempDir: join(config.DATA_DIR, "tmp"),
    legacyProfileDir: join(config.DATA_DIR, "browser-profile"),
    screenshotDir: join(config.DATA_DIR, "login-screenshots"),
    editorPath: mcLocale.editorPath,
    loginHosts: config.LIDL_LOGIN_HOSTS,
    logger,
  });
  autoLogin.cleanUp();
  const session = new SessionManager({
    settings: store.settings,
    jobs: store.jobs,
    // A separate client with just this cookie, so a check never touches the stored one.
    validate: (cookie) =>
      new McClient(transport, new StaticSessionProvider(cookie), {
        editorPath: mcLocale.editorPath,
      }).getCurrentUser(),
    notifier,
    logger,
    seedCookie: config.MC_COOKIE,
    checkIntervalMs: config.SESSION_CHECK_MINUTES * 60_000,
    autoLogin,
  });
  const mc = new McClient(transport, session, { editorPath: mcLocale.editorPath });
  const converter = await loadConverter({ env: process.env, limits, logger });
  const catalog = await loadConfiguredCatalog(config);
  const ingredients = new IngredientResolver({
    mode: config.MC_RESOLVE_INGREDIENTS,
    catalog,
    rules: catalogMatchRules(locale.pack),
    cache: store.ingredientCache,
    search: mc,
    logger,
  });

  const service = buildService({
    config,
    store,
    session,
    mealie,
    mc,
    converter,
    limits,
    locale,
    notifier,
    ingredients,
    logger,
    adminSessionKey: settingsKey,
    configEntries: effectiveConfig(config, process.env),
    mealieCheck: () => mealie.getSelf(),
    autoLogin,
    // TRUST_PROXY decides whose X-Forwarded-For and X-Forwarded-Proto count: the client
    // address of the login throttle and the https detection behind a reverse proxy.
    server: { loggerInstance: logger, trustProxy: config.TRUST_PROXY },
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    setTimeout(() => {
      logger.error({}, "shutdown timed out");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    service.stop().then(
      () => {
        store.close();
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await service.app.listen({ port: config.PORT, host: config.HOST });
  service.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
