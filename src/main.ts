import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { loggerOptions } from "./logger.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  // Local runs read .env from the working directory. Variables that are already set win.
  // Containers set NODE_ENV=production and get their settings from the environment.
  if (process.env.NODE_ENV !== "production" && existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const config = loadConfig();
  const app = buildServer({ logger: loggerOptions(config.LOG_LEVEL) });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, "error during shutdown");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
