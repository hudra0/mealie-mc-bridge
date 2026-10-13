import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../store/jobs.js";
import { RECIPE_ID, silentLogger } from "../testing/fakes.js";
import { tempStore, type TempStore } from "../testing/temp.js";
import type { RunJobOptions, RunJobOutcome } from "./run-job.js";
import { Worker, defaultBackoff, type JobRunner } from "./worker.js";

let store: TempStore;
let worker: Worker | null = null;
afterEach(async () => {
  await worker?.stop();
  worker = null;
  store?.dispose();
});

type Step = RunJobOutcome["status"] | "throw";

// A runner that answers with the given outcomes in turn and marks the job like runJob.
function scripted(steps: Step[]): JobRunner & { options: RunJobOptions[] } {
  const options: RunJobOptions[] = [];
  const runner = (job: Job, opts: RunJobOptions): Promise<RunJobOutcome> => {
    options.push(opts);
    const step = steps.shift() ?? "done";
    if (step === "throw") return Promise.reject(new Error("bug in the pipeline"));
    if (step === "retry") {
      return Promise.resolve({ status: "retry", job, error: "socket hang up", stage: "load" });
    }
    if (step === "failed") {
      const failed = store.jobs.finish(job.id, "failed", { error: "validation failed" });
      return Promise.resolve({
        status: "failed",
        job: failed,
        error: "validation failed",
        stage: "validate",
      });
    }
    const final = store.jobs.finish(job.id, step === "interrupted" ? "queued" : step);
    return Promise.resolve({ status: step, job: final } as RunJobOutcome);
  };
  return Object.assign(runner, { options });
}

function makeWorker(run: JobRunner, extra: Partial<ConstructorParameters<typeof Worker>[0]> = {}) {
  worker = new Worker({
    jobs: store.jobs,
    run,
    logger: silentLogger(),
    pollMs: 5,
    backoffMs: () => 1,
    ...extra,
  });
  return worker;
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Worker.tick", () => {
  it("does nothing without queued jobs", async () => {
    store = tempStore();
    const run = scripted([]);
    expect(await makeWorker(run).tick()).toBe(false);
    expect(run.options).toEqual([]);
  });

  it("runs the oldest queued job once when it succeeds", async () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const run = scripted(["done"]);
    expect(await makeWorker(run).tick()).toBe(true);
    expect(run.options).toHaveLength(1);
    expect(run.options[0]?.finalAttempt).toBe(false);
    expect(store.jobs.get(job.id)?.status).toBe("done");
  });

  it("retries a temporary failure with a pause and counts the attempts", async () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const backoff = vi.fn(() => 1);
    const run = scripted(["retry", "retry", "done"]);
    await makeWorker(run, { backoffMs: backoff }).tick();
    expect(run.options.map((option) => option.finalAttempt)).toEqual([false, false, false]);
    expect(backoff.mock.calls).toEqual([[1], [2]]);
    const stored = store.jobs.get(job.id);
    expect(stored).toMatchObject({ status: "done", attempts: 3 });
    expect(store.jobs.events(job.id).map((event) => event.message)).toEqual(
      expect.arrayContaining(["Retry 1 of 3 in 0 s", "Retry 2 of 3 in 0 s"]),
    );
  });

  it("gives up after three retries: the fourth run is the final attempt", async () => {
    store = tempStore();
    store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const run = scripted(["retry", "retry", "retry", "failed"]);
    const w = makeWorker(run);
    await w.tick();
    expect(run.options.map((option) => option.finalAttempt)).toEqual([false, false, false, true]);
    expect(w.status().lastError).toBe("validation failed");
  });

  it("does not retry a failure", async () => {
    store = tempStore();
    store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const run = scripted(["failed"]);
    await makeWorker(run).tick();
    expect(run.options).toHaveLength(1);
  });

  it("marks a job failed when the run crashes", async () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const w = makeWorker(scripted(["throw"]));
    await w.tick();
    expect(store.jobs.get(job.id)).toMatchObject({
      status: "failed",
      error: "bug in the pipeline",
    });
    expect(store.jobs.events(job.id).at(-1)?.message).toBe("Crashed: bug in the pipeline");
    expect(w.status().lastError).toBe("bug in the pipeline");
  });

  it("waits while the session gate is closed and marks queued jobs as waiting", async () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const run = scripted(["done"]);
    const w = makeWorker(run, { gate: { isPaused: () => true } });
    expect(await w.tick()).toBe(false);
    expect(run.options).toEqual([]);
    expect(store.jobs.get(job.id)?.status).toBe("session_expired");
    expect(w.status().paused).toBe(true);
  });
});

describe("Worker loop", () => {
  it("polls, processes jobs and stops", async () => {
    store = tempStore();
    const w = makeWorker(scripted(["done", "done"]));
    w.start();
    w.start();
    expect(w.running).toBe(true);
    const a = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 }).job;
    const b = store.jobs.enqueue({
      recipeId: "00000000-0000-4000-8000-000000000002",
      scale: 1,
    }).job;
    await until(() => store.jobs.get(b.id)?.status === "done");
    expect(store.jobs.get(a.id)?.status).toBe("done");
    await w.stop();
    expect(w.running).toBe(false);
    expect(w.status().running).toBe(false);
  });

  it("starts a queued job right away when nudged", async () => {
    store = tempStore();
    const w = makeWorker(scripted(["done"]), { pollMs: 60_000 });
    w.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    w.nudge();
    await until(() => store.jobs.get(job.id)?.status === "done", 1000);
  });

  it("puts a job waiting for a retry back into the queue on stop", async () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const w = makeWorker(scripted(["retry"]), { backoffMs: () => 60_000 });
    w.start();
    await until(() =>
      store.jobs.events(job.id).some((event) => event.message.startsWith("Retry 1")),
    );
    expect(w.status().currentJobId).toBe(job.id);
    await w.stop();
    expect(store.jobs.get(job.id)?.status).toBe("queued");
    expect(store.jobs.events(job.id).at(-1)?.message).toBe(
      "Interrupted by shutdown; the job runs again after the restart",
    );
  });

  it("aborts the running job through the signal on stop", async () => {
    store = tempStore();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    let seen: AbortSignal | undefined;
    const run: JobRunner = (claimed, options) => {
      seen = options.signal;
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => {
          const queued = store.jobs.update(claimed.id, { status: "queued" });
          resolve({ status: "interrupted", job: queued });
        });
      });
    };
    const w = makeWorker(run);
    w.start();
    await until(() => seen !== undefined);
    await w.stop();
    expect(seen?.aborted).toBe(true);
    expect(store.jobs.get(job.id)?.status).toBe("queued");
  });

  it("keeps polling when the store fails", async () => {
    store = tempStore();
    const claimNext = vi
      .fn<() => Job | null>()
      .mockImplementationOnce(() => {
        throw new Error("database is locked");
      })
      .mockImplementation(() => null);
    const w = new Worker({
      jobs: {
        claimNext,
        pauseQueued: store.jobs.pauseQueued.bind(store.jobs),
        get: store.jobs.get.bind(store.jobs),
        update: store.jobs.update.bind(store.jobs),
        appendEvent: store.jobs.appendEvent.bind(store.jobs),
        finish: store.jobs.finish.bind(store.jobs),
      },
      run: scripted([]),
      logger: silentLogger(),
      pollMs: 5,
    });
    worker = w;
    w.start();
    await until(() => claimNext.mock.calls.length >= 2);
    expect(w.status().lastError).toBe("database is locked");
  });
});

describe("defaultBackoff", () => {
  it("doubles from two seconds and stops at a minute", () => {
    expect([1, 2, 3, 10].map(defaultBackoff)).toEqual([2000, 4000, 8000, 60_000]);
  });
});
