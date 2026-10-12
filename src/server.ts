import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { version } from "./version.js";

export function buildServer(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  // Silent, so the Docker healthcheck does not write two log lines every 30 seconds.
  app.get("/health", { logLevel: "silent" }, () => ({ status: "ok", version }));

  return app;
}
