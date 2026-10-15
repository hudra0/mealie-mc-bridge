import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECIPE_ID } from "../testing/fakes.js";
import { WEBHOOK_TOKEN, testService, type TestService } from "../testing/service.js";
import { version } from "../version.js";
import { healthReport } from "./health.js";
import { WEBHOOK_BODY_LIMIT } from "./routes.js";
import { requestLogSerializers, safeEqual } from "./security.js";

// The route must compare through the constant-time helper.
vi.mock("./security.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./security.js")>();
  return { ...actual, safeEqual: vi.fn(actual.safeEqual) };
});

const actionBody = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/mealie/action-body-v3.28.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

let svc: TestService | null = null;
afterEach(async () => {
  await svc?.dispose();
  svc = null;
  vi.mocked(safeEqual).mockClear();
});

const hook = (token = WEBHOOK_TOKEN) => `/hooks/mealie/${token}`;

describe("POST /hooks/mealie/:token", () => {
  it("queues a job and answers 202 with its id", async () => {
    svc = testService();
    const response = await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    expect(response.statusCode).toBe(202);
    const { jobId } = response.json<{ jobId: string }>();
    expect(svc.store.jobs.get(jobId)).toMatchObject({
      mealieRecipeId: RECIPE_ID,
      scale: 1.5,
      status: "queued",
    });
  });

  it("refuses new jobs over the daily job limit and says so in the timeline", async () => {
    svc = testService({ config: { JOB_DAILY_LIMIT: 2, JOB_DAILY_COST_LIMIT_USD: 0 } });
    const other = "00000000-0000-4000-8000-0000000000aa";
    svc.store.jobs.enqueue({ recipeId: other, scale: 1 });
    const first = await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    expect(first.statusCode).toBe(202);
    // A double click of an active job counts toward no limit.
    const again = await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    const third = await svc.app.inject({
      method: "POST",
      url: hook(),
      payload: { ...actionBody, recipe_scale: 3 },
    });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({
      error: "Too Many Requests",
      message: "Daily limit reached: at most 2 jobs in 24 hours (JOB_DAILY_LIMIT).",
    });
    expect(svc.store.jobs.stats().queued).toBe(2);
    await vi.waitFor(() => expect(svc?.mealie.timeline).toHaveLength(1));
    expect(svc.mealie.timeline[0]).toMatchObject({
      recipeId: RECIPE_ID,
      event: { subject: "Monsieur Cuisine: not sent, daily limit reached" },
    });
  });

  it("refuses new jobs once the cost of the last 24 hours reaches the limit", async () => {
    svc = testService({ config: { JOB_DAILY_LIMIT: 0, JOB_DAILY_COST_LIMIT_USD: 1 } });
    const { job } = svc.store.jobs.enqueue({
      recipeId: "00000000-0000-4000-8000-0000000000aa",
      scale: 1,
    });
    svc.store.jobs.update(job.id, { costUsd: 1.2 });
    const response = await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    expect(response.statusCode).toBe(429);
    expect(response.json<{ message: string }>().message).toMatch(/JOB_DAILY_COST_LIMIT_USD/);
  });

  it("answers a double click with the same job", async () => {
    svc = testService();
    const first = await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    const second = await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    expect(second.json()).toEqual(first.json());
    expect(svc.store.jobs.stats().queued).toBe(1);
  });

  it("compares the token in constant time and answers 404 for a wrong one", async () => {
    svc = testService();
    const wrong = await svc.app.inject({
      method: "POST",
      url: hook("x".repeat(48)),
      payload: actionBody,
    });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toEqual({ message: "Not Found", error: "Not Found", statusCode: 404 });
    const short = await svc.app.inject({ method: "POST", url: hook("short"), payload: actionBody });
    expect(short.statusCode).toBe(404);
    expect(svc.store.jobs.stats().queued).toBe(0);
    expect(vi.mocked(safeEqual)).toHaveBeenCalledWith("x".repeat(48), WEBHOOK_TOKEN);
    expect(vi.mocked(safeEqual)).toHaveBeenCalledWith("short", WEBHOOK_TOKEN);
  });

  it("checks the token before it parses the body", async () => {
    svc = testService();
    const response = await svc.app.inject({
      method: "POST",
      url: hook("x".repeat(48)),
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(404);
  });

  it("answers 400 for a body that is not a recipe action", async () => {
    svc = testService();
    const response = await svc.app.inject({
      method: "POST",
      url: hook(),
      payload: { content: { id: "nope" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Bad Request",
      issues: ["content.id: must be a UUID"],
    });
    const broken = await svc.app.inject({
      method: "POST",
      url: hook(),
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(broken.statusCode).toBe(400);
  });

  it("refuses bodies over 2 MB", async () => {
    svc = testService();
    const big = { ...actionBody, padding: "x".repeat(WEBHOOK_BODY_LIMIT) };
    const response = await svc.app.inject({ method: "POST", url: hook(), payload: big });
    expect(response.statusCode).toBe(413);
  });

  it("keeps the token out of the request log", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ level: "info", serializers: requestLogSerializers }, stream);
    svc = testService({ logger: { loggerInstance: logger } });
    await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    await svc.app.inject({ method: "POST", url: hook("x".repeat(48)), payload: actionBody });
    const log = lines.join("");
    expect(log).toContain("/hooks/mealie/[redacted]");
    expect(log).not.toContain(WEBHOOK_TOKEN);
    expect(log).not.toContain("x".repeat(48));
  });

  it("keeps the token out of the log when the right token misses the route", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ level: "trace", serializers: requestLogSerializers }, stream);
    svc = testService({ logger: { loggerInstance: logger } });
    const get = await svc.app.inject({ method: "GET", url: hook() });
    const slash = await svc.app.inject({ method: "POST", url: `${hook()}/`, payload: actionBody });
    const csrf = await svc.app.inject({
      method: "GET",
      url: "/admin/typo?_csrf=secret-form-token",
    });
    for (const response of [get, slash, csrf]) expect(response.statusCode).toBe(404);
    const log = lines.join("");
    expect(log).toContain("/hooks/mealie/[redacted]");
    expect(log).not.toContain(WEBHOOK_TOKEN);
    expect(log).not.toContain("secret-form-token");
  });

  it("answers a wrong token exactly like an unknown route", async () => {
    svc = testService();
    const wrong = await svc.app.inject({ method: "POST", url: hook("x".repeat(48)), payload: {} });
    const unknown = await svc.app.inject({ method: "POST", url: "/nothing/here", payload: {} });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toBe(wrong.body);
  });
});

describe("GET /jobs/:id", () => {
  it("shows a job with its events", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 2 });
    const response = await svc.app.inject({ method: "GET", url: `/jobs/${job.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: job.id,
      status: "queued",
      recipeId: RECIPE_ID,
      scale: 2,
      events: [{ level: "info", message: "Queued with scale 2" }],
    });
  });

  it("answers 404 for an unknown job", async () => {
    svc = testService();
    expect((await svc.app.inject({ method: "GET", url: "/jobs/unknown" })).statusCode).toBe(404);
  });
});

describe("GET /health", () => {
  it("reports version, session, queue and worker", async () => {
    svc = testService();
    svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const response = await svc.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "degraded",
      version,
      session: { state: "unknown", checkedAt: null },
      queue: { depth: 1, running: 0, waitingForSession: 0 },
      worker: { running: false, paused: false },
      lastError: null,
    });
  });

  it("is ok with a valid session and a running worker", async () => {
    svc = testService({ seedCookie: "a=1" });
    await svc.session.check();
    svc.worker.start();
    const body = (await svc.app.inject({ method: "GET", url: "/health" })).json<{
      status: string;
    }>();
    expect(body).toMatchObject({
      status: "ok",
      session: { state: "valid" },
      worker: { running: true },
    });
  });

  it("says when the worker last failed, but not what the error said", () => {
    svc = testService();
    const report = healthReport({
      session: svc.session,
      jobs: svc.store.jobs,
      worker: {
        status: () => ({
          running: true,
          paused: false,
          currentJobId: null,
          lastError: "GET http://mealie.internal:9000/api/recipes/Secret-Soup failed",
          lastErrorAt: "2026-10-13T10:00:00.000Z",
        }),
      },
    });
    expect(report.lastError).toEqual({ at: "2026-10-13T10:00:00.000Z" });
    expect(JSON.stringify(report)).not.toContain("Secret-Soup");
  });

  it("answers 503 when the store is gone", async () => {
    svc = testService();
    svc.store.close();
    const response = await svc.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "error", version });
  });

  it("answers 503 when the data directory is no longer writable", async () => {
    svc = testService();
    svc.store.check = () => {
      throw Object.assign(new Error("EACCES: permission denied, access '/data'"), {
        code: "EACCES",
      });
    };
    const response = await svc.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "error", version });
  });
});

describe("Docker healthcheck", () => {
  // The command of the Dockerfile's HEALTHCHECK, run against a server answering `status`.
  async function healthcheckExit(status: number): Promise<number | null> {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const command = /HEALTHCHECK[^\n]*\\\n\s*CMD (\[.*\])/.exec(dockerfile)?.[1];
    expect(command).toBeDefined();
    const [node, flag, script] = JSON.parse(command ?? "[]") as string[];
    expect([node, flag]).toEqual(["node", "-e"]);
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const child = spawn(process.execPath, ["-e", script ?? ""], {
        env: { ...process.env, PORT: String(port) },
        stdio: "ignore",
      });
      return await new Promise((resolve) => child.on("exit", resolve));
    } finally {
      server.close();
    }
  }

  it("passes on 200 and fails on 503", async () => {
    expect(await healthcheckExit(200)).toBe(0);
    expect(await healthcheckExit(503)).toBe(1);
  });

  it("starts the bridge under tini and binds every interface inside the container", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
    expect(runtime).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(runtime).toMatch(/apt-get install -y --no-install-recommends tini/);
    expect(runtime).toContain("ENV BRIDGE_IN_CONTAINER=1");
    expect(runtime).toContain("USER bridge");
  });

  it("hardens the container in the compose example", () => {
    const compose = readFileSync(new URL("../../compose.example.yml", import.meta.url), "utf8");
    for (const line of [
      "init: true",
      "read_only: true",
      "cap_drop:\n      - ALL",
      "no-new-privileges:true",
      "pids_limit:",
      "mem_limit:",
      "- /tmp",
      '"127.0.0.1:3000:3000"',
    ]) {
      expect(compose, line).toContain(line);
    }
  });

  it("installs the browser libraries of the Playwright version the lock file pins", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const lock = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    ) as { packages: Record<string, { version?: string }> };
    const pinned = /playwright@(\d+\.\d+\.\d+) install-deps/.exec(dockerfile)?.[1];
    expect(pinned).toBe(lock.packages["node_modules/playwright"]?.version);
  });
});

describe("end to end with fake clients", () => {
  it("turns a click into a draft, a tag and a timeline entry", async () => {
    svc = testService({ seedCookie: "a=1" });
    svc.start();
    const response = await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    const { jobId } = response.json<{ jobId: string }>();
    const started = Date.now();
    while (svc.store.jobs.get(jobId)?.status !== "done") {
      if (Date.now() - started > 3000)
        throw new Error(`job stuck: ${JSON.stringify(svc.store.jobs.events(jobId))}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(svc.mc.payloads).toHaveLength(1);
    expect(svc.mealie.patches[0]?.patch.addTags?.[0]?.name).toBe("Monsieur Cuisine");
    expect(svc.mealie.timeline[0]?.event.subject).toBe(
      "Monsieur Cuisine: recipe saved to the device",
    );
    const health = (await svc.app.inject({ method: "GET", url: "/health" })).json<{
      status: string;
    }>();
    expect(health.status).toBe("ok");
  });

  it("hands the ingredient resolver to the worker", async () => {
    const resolveAll = vi.fn(() =>
      Promise.resolve({
        ids: new Map<string, number | null>([["kürbis", 9001]]),
        stats: { catalog: 1, catalogRelaxed: 0, cache: 0, search: 0, unresolved: 1 },
        unresolvedNames: ["Rote Linsen"],
        enabled: true,
      }),
    );
    svc = testService({ seedCookie: "a=1", ingredients: { resolveAll } });
    svc.start();
    const response = await svc.app.inject({ method: "POST", url: hook(), payload: actionBody });
    const { jobId } = response.json<{ jobId: string }>();
    const started = Date.now();
    while (svc.store.jobs.get(jobId)?.status !== "done") {
      if (Date.now() - started > 3000)
        throw new Error(`job stuck: ${JSON.stringify(svc.store.jobs.events(jobId))}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(resolveAll).toHaveBeenCalledWith(["Kürbis", "Rote Linsen"], expect.anything());
    const ingredients = svc.mc.payloads[0]?.servingSizes[0]?.ingredientGroups[0]?.ingredients;
    expect(ingredients?.map((item) => item.systemIngredientId)).toEqual([9001, null]);
  });
});
