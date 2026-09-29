/**
 * Creative Director (Phase 1 slice): orchestrated validation pipelines.
 *
 * The orchestrator creates no animation logic of its own — it composes
 * jobs out of the existing validate/test simulation and chains them with
 * parent_job_id links. Deterministic failures (bad ops) complete as
 * reports and never retry; only exceptional failures do.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MotionOp } from "./ops.js";
import { testOps, validateAll } from "./validate.js";
import { createWorker, type JobContext } from "./worker.js";
import { enqueue, getJob, type JobRow } from "./jobs.js";

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function validateHandler(ctx: JobContext): unknown {
  const ops = (ctx.job.payload as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) throw new Error("validate job needs payload.ops array.");
  return validateAll(ops as MotionOp[]);
}

export function simulateHandler(ctx: JobContext): unknown {
  const ops = (ctx.job.payload as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) throw new Error("simulate job needs payload.ops array.");
  return testOps(ops as MotionOp[]);
}

export function defaultHandlers(): Record<string, (ctx: JobContext) => unknown> {
  return { validate: validateHandler, simulate: simulateHandler };
}

export interface PipelineResult {
  validateJob: JobRow;
  simulateJob: JobRow | null;
  validation: { ok: boolean; errors: unknown[]; warnings: unknown[] } | null;
  executedNewWork: boolean;
}

export interface ValidationPipelineOptions {
  idempotencyKey?: string;
  maxTicks?: number;
}

/**
 * Validate ops, then simulate — as jobs, with an idempotent chain key so a
 * retry never duplicates work. Returns live rows plus the reports.
 */
export async function runValidationPipeline(
  db: DatabaseSync,
  projectId: string,
  ops: MotionOp[],
  options: ValidationPipelineOptions = {}
): Promise<PipelineResult> {
  const worker = createWorker(db, defaultHandlers());
  const key = options.idempotencyKey ?? `validate:${projectId}:${fnv1a(JSON.stringify(ops))}`;
  const maxTicks = options.maxTicks ?? 50;
  let executedNewWork = false;

  const first = enqueue(db, { projectId, type: "validate", payload: { ops }, maxAttempts: 1, idempotencyKey: key });
  executedNewWork = executedNewWork || !first.duplicate;
  let validateJob = first.job;
  for (let guard = 0; guard < maxTicks; guard++) {
    validateJob = getJob(db, validateJob.id) ?? validateJob;
    if (validateJob.status !== "QUEUED" && validateJob.status !== "RUNNING") break;
    await worker.tick();
    validateJob = getJob(db, validateJob.id) ?? validateJob;
  }
  const validation = (validateJob.result ?? null) as PipelineResult["validation"];
  if (validateJob.status !== "COMPLETED" || !validation || !validation.ok) {
    return { validateJob, simulateJob: null, validation, executedNewWork };
  }
  const second = enqueue(db, {
    projectId,
    type: "simulate",
    payload: { ops },
    maxAttempts: 1,
    idempotencyKey: `${key}:simulate`,
    parentJobId: validateJob.id
  });
  executedNewWork = executedNewWork || !second.duplicate;
  let simulateJob: JobRow | null = second.job;
  for (let guard = 0; guard < maxTicks; guard++) {
    const current = simulateJob ? (getJob(db, simulateJob.id) ?? simulateJob) : null;
    if (!current || (current.status !== "QUEUED" && current.status !== "RUNNING")) {
      simulateJob = current;
      break;
    }
    await worker.tick();
    simulateJob = getJob(db, simulateJob.id) ?? simulateJob;
  }
  return { validateJob, simulateJob, validation, executedNewWork };
}
