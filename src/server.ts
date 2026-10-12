import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { version } from "./version.js";

export function buildServer(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get("/health", () => ({ status: "ok", version }));

  return app;
}
