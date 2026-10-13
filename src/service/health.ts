// The /health report. The HTTP status stays 200 while the process works, so a container
// orchestrator does not restart the bridge over an expired session, which a restart cannot
// fix; "status" says "degraded" instead.

import type { WorkerStatus } from "../pipeline/worker.js";
import type { SessionState, SessionStatus } from "../session/manager.js";
import type { JobStats } from "../store/jobs.js";
import { version } from "../version.js";

export interface HealthDeps {
  session: { status(): SessionStatus };
  jobs: { stats(): JobStats };
  worker: { status(): WorkerStatus };
}

export interface HealthReport {
  status: "ok" | "degraded";
  version: string;
  session: { state: SessionState; checkedAt: string | null };
  queue: { depth: number; running: number; waitingForSession: number };
  worker: { running: boolean; paused: boolean };
  lastError: { message: string; at: string | null } | null;
}

export function healthReport(deps: HealthDeps): HealthReport {
  const session = deps.session.status();
  const stats = deps.jobs.stats();
  const worker = deps.worker.status();
  const sessionBad = session.state === "invalid" || session.state === "expired";
  return {
    status: sessionBad || !worker.running ? "degraded" : "ok",
    version,
    session: { state: session.state, checkedAt: session.checkedAt },
    queue: {
      depth: stats.queued,
      running: stats.running,
      waitingForSession: stats.session_expired,
    },
    worker: { running: worker.running, paused: worker.paused },
    lastError: worker.lastError ? { message: worker.lastError, at: worker.lastErrorAt } : null,
  };
}
