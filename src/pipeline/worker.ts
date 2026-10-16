// The single worker: polls the queue, runs one job at a time, retries temporary failures
// with a growing pause and stops cleanly on shutdown. It waits while the session gate is
// closed (Monsieur Cuisine rejects the cookie), so jobs are not burned on a dead session.

import { errorMessage, type AppLogger } from "../app-logger.js";
import type { Job, JobStore } from "../store/jobs.js";
import type { RunJobOptions, RunJobOutcome } from "./run-job.js";

export type JobRunner = (job: Job, options: RunJobOptions) => Promise<RunJobOutcome>;

export interface WorkerOptions {
  jobs: Pick<JobStore, "claimNext" | "get" | "update" | "appendEvent" | "finish" | "pauseQueued">;
  run: JobRunner;
  gate?: { isPaused(): boolean };
  logger: AppLogger;
  pollMs?: number;
  maxRetries?: number;
  // The pause before retry n (1-based).
  backoffMs?: (retry: number) => number;
}

export interface WorkerStatus {
  running: boolean;
  paused: boolean;
  currentJobId: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export const DEFAULT_MAX_RETRIES = 3;
export const defaultBackoff = (retry: number): number => Math.min(60_000, 2_000 * 2 ** (retry - 1));

export class Worker {
  readonly #jobs: WorkerOptions["jobs"];
  readonly #run: JobRunner;
  readonly #gate: { isPaused(): boolean };
  readonly #logger: AppLogger;
  readonly #pollMs: number;
  readonly #maxRetries: number;
  readonly #backoff: (retry: number) => number;
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #currentJobId: string | null = null;
  #lastError: string | null = null;
  #lastErrorAt: string | null = null;

  constructor(options: WorkerOptions) {
    this.#jobs = options.jobs;
    this.#run = options.run;
    this.#gate = options.gate ?? { isPaused: () => false };
    this.#logger = options.logger;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#backoff = options.backoffMs ?? defaultBackoff;
  }

  get running(): boolean {
    return this.#loop !== null;
  }

  status(): WorkerStatus {
    return {
      running: this.running,
      paused: this.#gate.isPaused(),
      currentJobId: this.#currentJobId,
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt,
    };
  }

  start(): void {
    if (this.#loop) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.#loop = this.#runLoop(controller.signal).finally(() => {
      this.#loop = null;
    });
  }

  // Ends the poll, interrupts the current job (it goes back to the queue) and waits for it.
  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#loop;
    this.#controller = null;
  }

  // Ends the current pause between polls, for example right after a webhook queued a job.
  nudge(): void {
    this.#wake?.();
  }

  // Runs the next queued job, if any. Returns whether there was one.
  async tick(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.#gate.isPaused()) {
      // Jobs queued after the session failed wait with the others, visibly.
      this.#jobs.pauseQueued();
      return false;
    }
    const job = this.#jobs.claimNext();
    if (!job) return false;
    this.#currentJobId = job.id;
    try {
      await this.#process(job, signal);
    } finally {
      this.#currentJobId = null;
    }
    return true;
  }

  async #runLoop(signal: AbortSignal): Promise<void> {
    this.#logger.info({ pollMs: this.#pollMs }, "worker started");
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await this.tick(signal);
      } catch (error) {
        // The store itself failed. Keep polling; the next tick may work again.
        this.#recordError(errorMessage(error));
        this.#logger.error({ err: errorMessage(error) }, "worker tick failed");
      }
      if (!worked) await this.#sleep(this.#pollMs, signal, true);
    }
    this.#logger.info({}, "worker stopped");
  }

  async #process(claimed: Job, signal: AbortSignal): Promise<void> {
    let job = claimed;
    for (let retry = 0; ; retry++) {
      let outcome: RunJobOutcome;
      try {
        outcome = await this.#run(job, { signal, finalAttempt: retry >= this.#maxRetries });
      } catch (error) {
        // runJob handles its own failures; this is a bug or a broken store.
        const message = errorMessage(error);
        this.#recordError(message);
        this.#logger.error({ jobId: job.id, err: message }, "job run crashed");
        this.#jobs.finish(job.id, "failed", { error: message });
        this.#jobs.appendEvent(job.id, "error", { code: "crashed", params: { error: message } });
        return;
      }
      if (outcome.status === "failed") this.#recordError(outcome.error);
      if (outcome.status !== "retry") return;

      const pause = this.#backoff(retry + 1);
      this.#jobs.appendEvent(job.id, "info", {
        code: "retry_scheduled",
        params: { retry: retry + 1, max: this.#maxRetries, seconds: Math.round(pause / 1000) },
      });
      await this.#sleep(pause, signal, false);
      if (signal.aborted) {
        this.#jobs.update(job.id, { status: "queued", startedAt: null });
        this.#jobs.appendEvent(job.id, "warn", { code: "interrupted" });
        return;
      }
      job = this.#jobs.update(job.id, { attempts: outcome.job.attempts + 1 });
    }
  }

  #recordError(message: string): void {
    this.#lastError = message;
    this.#lastErrorAt = new Date().toISOString();
  }

  // A poll pause can be cut short by nudge(); a retry pause only by stop().
  #sleep(ms: number, signal: AbortSignal, wakeable: boolean): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (this.#wake === done) this.#wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (wakeable) this.#wake = done;
    });
  }
}
