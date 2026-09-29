/**
 * Durable database-backed job queue.
 *
 * No Redis/Kafka/Temporal — the SQLite database from db.ts is the source of
 * truth, so jobs survive process restarts and a future second process can
 * open the same file. All state changes go through here; every transition
 * appends a job_events row (durable history, no separate bus yet).
 *
 * Concurrency model: claimNext runs in BEGIN IMMEDIATE, so concurrent
 * workers serialize and exactly one wins each job. Leases (heartbeat_at)
 * let recoverStale() rescue jobs from crashed workers. Idempotency keys
 * are UNIQUE: re-enqueue with the same key returns the existing job.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface JobRow {
  id: string;
  project_id: string;
  type: string;
  status: JobStatus;
  priority: number;
  payload: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  parent_job_id: string | null;
  worker_id: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
  heartbeat_at: number | null;
  run_after: number;
}

export interface EnqueueOptions {
  projectId: string;
  type: string;
  payload?: unknown;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  parentJobId?: string;
  runAfter?: number;
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toRow(raw: Record<string, unknown>): JobRow {
  return {
    id: String(raw.id),
    project_id: String(raw.project_id),
    type: String(raw.type),
    status: raw.status as JobStatus,
    priority: Number(raw.priority ?? 0),
    payload: parseJson(raw.payload ?? {}),
    result: parseJson(raw.result ?? null),
    error: raw.error === null || raw.error === undefined ? null : String(raw.error),
    attempts: Number(raw.attempts ?? 0),
    max_attempts: Number(raw.max_attempts ?? 1),
    idempotency_key: raw.idempotency_key === null || raw.idempotency_key === undefined ? null : String(raw.idempotency_key),
    parent_job_id: raw.parent_job_id === null || raw.parent_job_id === undefined ? null : String(raw.parent_job_id),
    worker_id: raw.worker_id === null || raw.worker_id === undefined ? null : String(raw.worker_id),
    created_at: Number(raw.created_at),
    started_at: raw.started_at === null || raw.started_at === undefined ? null : Number(raw.started_at),
    completed_at: raw.completed_at === null || raw.completed_at === undefined ? null : Number(raw.completed_at),
    updated_at: Number(raw.updated_at),
    heartbeat_at: raw.heartbeat_at === null || raw.heartbeat_at === undefined ? null : Number(raw.heartbeat_at),
    run_after: Number(raw.run_after ?? 0)
  };
}

export function recordEvent(db: DatabaseSync, jobId: string, event: string, detail?: unknown): void {
  db.prepare("INSERT INTO job_events (job_id, event, detail, created_at) VALUES (?, ?, ?, ?)").run(
    jobId,
    event,
    detail === undefined ? null : JSON.stringify(detail),
    Date.now()
  );
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempts));
}

export function newJobId(): string {
  return `job-${randomUUID()}`;
}

/**
 * Enqueue a job. With an idempotency key, a duplicate enqueue returns the
 * existing job instead of creating a second one ({ duplicate: true }).
 */
export function enqueue(db: DatabaseSync, options: EnqueueOptions): { job: JobRow; duplicate: boolean } {
  const now = Date.now();
  const id = newJobId();
  const key = options.idempotencyKey ?? null;
  const inserted = db
    .prepare(
      `INSERT INTO jobs (id, project_id, type, status, priority, payload, attempts, max_attempts, idempotency_key, parent_job_id, created_at, updated_at, run_after)
       VALUES (?, ?, ?, 'QUEUED', ?, ?, 0, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`
    )
    .get(
      id,
      options.projectId,
      options.type,
      options.priority ?? 0,
      JSON.stringify(options.payload ?? {}),
      Math.max(1, options.maxAttempts ?? 1),
      key,
      options.parentJobId ?? null,
      now,
      now,
      options.runAfter ?? 0
    ) as Record<string, unknown> | undefined;
  if (inserted) {
    recordEvent(db, id, "enqueued", { type: options.type });
    return { job: toRow(inserted), duplicate: false };
  }
  if (key === null) throw new Error("enqueue: concurrent insert without idempotency key should not dedupe.");
  const existing = db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key) as Record<string, unknown>;
  return { job: toRow(existing), duplicate: true };
}

/**
 * Atomically claim the next due job (highest priority, oldest first).
 * Returns null when nothing is claimable. Attempts increment on claim —
 * starting work consumes an attempt.
 */
export function claimNext(db: DatabaseSync, workerId: string, types?: string[]): JobRow | null {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const filter = types && types.length > 0 ? `AND type IN (${types.map(() => "?").join(",")})` : "";
    const params: Array<string | number> = [now, ...(types && types.length > 0 ? types : [])];
    const row = db
      .prepare(`SELECT * FROM jobs WHERE status = 'QUEUED' AND run_after <= ? ${filter} ORDER BY priority DESC, created_at ASC LIMIT 1`)
      .get(...params) as Record<string, unknown> | undefined;
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare("UPDATE jobs SET status = 'RUNNING', worker_id = ?, started_at = ?, heartbeat_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'QUEUED'").run(
      workerId,
      now,
      now,
      now,
      String(row.id)
    );
    db.exec("COMMIT");
    const claimed = getJob(db, String(row.id));
    if (claimed) recordEvent(db, claimed.id, "claimed", { worker: workerId, attempt: claimed.attempts });
    return claimed;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

/** Refresh a running job's lease. False when the job is not yours/running. */
export function heartbeat(db: DatabaseSync, id: string, workerId: string): boolean {
  const changed = db
    .prepare("UPDATE jobs SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'RUNNING'")
    .run(Date.now(), Date.now(), id, workerId);
  return Number(changed.changes ?? 0) > 0;
}

export function complete(db: DatabaseSync, id: string, workerId: string, result: unknown): boolean {
  const now = Date.now();
  const changed = db
    .prepare("UPDATE jobs SET status = 'COMPLETED', result = ?, completed_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'RUNNING'")
    .run(JSON.stringify(result ?? null), now, now, id, workerId);
  if (Number(changed.changes ?? 0) === 0) return false;
  recordEvent(db, id, "completed", {});
  return true;
}

/**
 * Fail a job. Retryable failures with attempts left go back to QUEUED with
 * exponential backoff; anything else (or validation-style deterministic
 * failures, which callers mark retryable: false) lands FAILED.
 */
export function fail(db: DatabaseSync, id: string, workerId: string, error: string, retryable = true): { status: JobStatus } {
  const job = getJob(db, id);
  if (!job || job.worker_id !== workerId || job.status !== "RUNNING") return { status: job?.status ?? "FAILED" };
  const now = Date.now();
  if (retryable && job.attempts < job.max_attempts) {
    const runAfter = now + backoffMs(job.attempts);
    db.prepare("UPDATE jobs SET status = 'QUEUED', error = ?, worker_id = NULL, heartbeat_at = NULL, run_after = ?, updated_at = ? WHERE id = ?").run(
      error,
      runAfter,
      now,
      id
    );
    recordEvent(db, id, "retry_scheduled", { attempt: job.attempts, maxAttempts: job.max_attempts, runAfter });
    return { status: "QUEUED" };
  }
  db.prepare("UPDATE jobs SET status = 'FAILED', error = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(error, now, now, id);
  recordEvent(db, id, "failed", { attempt: job.attempts });
  return { status: "FAILED" };
}

export function cancel(db: DatabaseSync, id: string): boolean {
  const changed = db
    .prepare("UPDATE jobs SET status = 'CANCELLED', completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('QUEUED', 'RUNNING')")
    .run(Date.now(), Date.now(), id);
  if (Number(changed.changes ?? 0) === 0) return false;
  recordEvent(db, id, "cancelled", {});
  return true;
}

/**
 * Rescue jobs whose workers died: RUNNING with a heartbeat older than the
 * lease goes back to QUEUED (attempt already counted at claim time).
 * Returns the recovered ids.
 */
export function recoverStale(db: DatabaseSync, leaseMs: number, now = Date.now()): string[] {
  const stale = db.prepare("SELECT id FROM jobs WHERE status = 'RUNNING' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?").all(now - leaseMs) as Array<{
    id: string;
  }>;
  const ids = stale.map((row) => row.id);
  if (ids.length === 0) return ids;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE jobs SET status = 'QUEUED', worker_id = NULL, heartbeat_at = NULL, run_after = ?, updated_at = ? WHERE id IN (${placeholders})`).run(
    now,
    now,
    ...ids
  );
  for (const id of ids) recordEvent(db, id, "recovered", { leaseMs });
  return ids;
}

export function getJob(db: DatabaseSync, id: string): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toRow(row) : null;
}

export function listJobs(db: DatabaseSync, projectId: string, status?: JobStatus, limit = 100): JobRow[] {
  const rows = (
    status
      ? db.prepare("SELECT * FROM jobs WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?").all(projectId, status, limit)
      : db.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit)
  ) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

export interface JobEvent {
  id: number;
  job_id: string;
  event: string;
  detail: unknown;
  created_at: number;
}

export function getEvents(db: DatabaseSync, jobId: string): JobEvent[] {
  const rows = db.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC").all(jobId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    job_id: String(row.job_id),
    event: String(row.event),
    detail: parseJson(row.detail ?? null),
    created_at: Number(row.created_at)
  }));
}
