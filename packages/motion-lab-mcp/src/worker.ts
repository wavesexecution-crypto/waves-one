/**
 * Worker boundary — claims jobs and runs handlers.
 *
 * Phase 1 runs workers in-process, but the interface is process-shaped on
 * purpose: a worker only needs an opened database (same file) plus a handler
 * table, so a future remote worker can reuse createWorker unchanged against
 * shared storage. Heartbeats flow while a handler runs; a crashed worker
 * simply stops heartbeating and recoverStale() rescues its jobs.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { cancel, claimNext, complete, fail, getJob, heartbeat, type JobRow } from "./jobs.js";

export interface JobContext {
  db: DatabaseSync;
  job: JobRow;
  workerId: string;
  heartbeat: () => void;
}

/**
 * Handler contract: return the JSON-serializable result, or throw.
 * Thrown errors retry when `retryable !== false` and attempts remain;
 * domain failures (e.g. a validation report with errors) must be
 * RETURNED, not thrown — only exceptional failures retry.
 */
export type JobHandler = (ctx: JobContext) => unknown | Promise<unknown>;

export interface WorkerOptions {
  workerId?: string;
  types?: string[];
  heartbeatMs?: number;
}

export interface TickResult {
  job: JobRow;
  outcome: "completed" | "failed" | "retry_queued";
}

export function createWorker(db: DatabaseSync, handlers: Record<string, JobHandler>, options: WorkerOptions = {}) {
  const id = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const heartbeatMs = options.heartbeatMs ?? 5000;

  async function tick(): Promise<TickResult | null> {
    const job = claimNext(db, id, options.types);
    if (!job) return null;
    const handler = handlers[job.type];
    if (!handler) {
      fail(db, job.id, id, `No handler for job type "${job.type}".`, false);
      return { job: getJob(db, job.id) ?? job, outcome: "failed" };
    }
    const timer = setInterval(() => {
      heartbeat(db, job.id, id);
    }, heartbeatMs);
    try {
      const result = await handler({
        db,
        job,
        workerId: id,
        heartbeat: () => {
          heartbeat(db, job.id, id);
        }
      });
      complete(db, job.id, id, result);
      return { job: getJob(db, job.id) ?? job, outcome: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = (error as { retryable?: unknown })?.retryable !== false;
      const { status } = fail(db, job.id, id, message, retryable);
      return { job: getJob(db, job.id) ?? job, outcome: status === "QUEUED" ? "retry_queued" : "failed" };
    } finally {
      clearInterval(timer);
    }
  }

  return { id, tick };
}
