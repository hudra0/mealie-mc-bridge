import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { version } from "./version.js";

// The one 404 body: unknown routes and webhook calls with a wrong token look the same.
export const NOT_FOUND_BODY = { message: "Not Found", error: "Not Found", statusCode: 404 };

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

  // Fastify's default handler logs "Route <method>:<url> not found" with the raw URL, which
  // would put a webhook token or a form token into the log. The request log lines carry
  // the URL already, redacted by their serializer.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(NOT_FOUND_BODY));

  return app;
}
