import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { version } from "./version.js";

export interface ServerHooks {
  // The /health body. Without it, /health reports only status and version.
  health?: () => object | Promise<object>;
}

export function buildServer(
  options: FastifyServerOptions = {},
  hooks: ServerHooks = {},
): FastifyInstance {
  const app = Fastify(options);
  const health = hooks.health ?? (() => ({ status: "ok", version }));

  // Silent, so the Docker healthcheck does not write two log lines every 30 seconds.
  app.get("/health", { logLevel: "silent" }, async (_request, reply) => {
    try {
      return await health();
    } catch {
      // The store or another dependency broke: this is a reason to restart.
      return reply.code(503).send({ status: "error", version });
    }
  });

  return app;
}
