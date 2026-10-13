import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { pino } from "pino";
import { loadServiceConfig } from "./config.js";
import { loggerOptions } from "./logger.js";
import { McClient, McTransport, StaticSessionProvider } from "./mc/index.js";
import { MealieClient } from "./mealie/index.js";
import { createNotifier } from "./notify/email.js";
import { loadConverter } from "./pipeline/converter-port.js";
import { loadDeviceLimits } from "./recipe/limits.js";
import { buildService, mealieRecipeLink } from "./service/app.js";
import { requestLogSerializers } from "./service/security.js";
import { SessionManager } from "./session/manager.js";
import { generateSettingsKey, openStore, parseSettingsKey } from "./store/index.js";

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

  const store = openStore({ dataDir: config.DATA_DIR, key: parseSettingsKey(config.SETTINGS_KEY) });
  const recovered = store.jobs.recoverInterrupted();
  if (recovered > 0) {
    logger.warn({ recovered }, "jobs interrupted by the last stop are queued again");
  }

  const limits = await loadDeviceLimits(config.DEVICE_PROGRAMS_PATH);
  const mealie = new MealieClient(config.MEALIE_URL, config.MEALIE_API_TOKEN, fetch, { logger });
  const notifier = createNotifier(config, logger, {
    recipeUrl: (job) => (job.mealieSlug ? mealieRecipeLink(config, job.mealieSlug) : null),
  });
  const transport = new McTransport({ logger });
  const session = new SessionManager({
    settings: store.settings,
    jobs: store.jobs,
    // A separate client with just this cookie, so a check never touches the stored one.
    validate: (cookie) =>
      new McClient(transport, new StaticSessionProvider(cookie)).getCurrentUser(),
    notifier,
    logger,
    seedCookie: config.MC_COOKIE,
    checkIntervalMs: config.SESSION_CHECK_MINUTES * 60_000,
  });
  const mc = new McClient(transport, session);
  const converter = await loadConverter({ env: process.env, limits, logger });

  const service = buildService({
    config,
    store,
    session,
    mealie,
    mc,
    converter,
    limits,
    notifier,
    logger,
    server: { loggerInstance: logger },
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
