/**
 * Audit System — immutable operation history for compliance and debugging.
 *
 * Every important operation gets an audit record:
 * - timestamp
 * - actor
 * - project
 * - job
 * - revision
 * - action
 * - status
 * - metadata
 *
 * Never store secrets.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AuditEntry {
  id: string;
  timestamp: number;
  actor: string;
  projectId: string;
  jobId?: string;
  revision?: number;
  action: string;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface AuditOptions {
  actor: string;
  projectId: string;
  jobId?: string;
  revision?: number;
  action: string;
  status: string;
  metadata?: Record<string, unknown>;
}

function sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  if (!metadata) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    // Skip sensitive fields
    if (key.toLowerCase().includes("secret") ||
        key.toLowerCase().includes("key") ||
        key.toLowerCase().includes("token") ||
        key.toLowerCase().includes("password") ||
        key.toLowerCase().includes("credential")) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

/**
 * Record an audit entry.
 */
export function recordAudit(
  db: DatabaseSync,
  options: AuditOptions
): AuditEntry {
  const now = Date.now();
  const id = `audit-${randomUUID()}`;

  const sanitized = sanitizeMetadata(options.metadata);

  db.prepare(
    `INSERT INTO audits (id, timestamp, actor, project_id, job_id, revision, action, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    now,
    options.actor,
    options.projectId,
    options.jobId ?? null,
    options.revision ?? null,
    options.action,
    options.status,
    JSON.stringify(sanitized)
  );

  return {
    id,
    timestamp: now,
    actor: options.actor,
    projectId: options.projectId,
    jobId: options.jobId,
    revision: options.revision,
    action: options.action,
    status: options.status,
    metadata: sanitized
  };
}

/**
 * Query audit entries.
 */
export function queryAudits(
  db: DatabaseSync,
  options: {
    projectId: string;
    actor?: string;
    action?: string;
    since?: number;
    before?: number;
    limit?: number;
  }
): AuditEntry[] {
  let query = `SELECT * FROM audits WHERE project_id = ?`;
  const params: Array<string | number> = [options.projectId];

  if (options.actor) {
    query += " AND actor = ?";
    params.push(options.actor);
  }

  if (options.action) {
    query += " AND action = ?";
    params.push(options.action);
  }

  if (options.since) {
    query += " AND timestamp >= ?";
    params.push(options.since);
  }

  if (options.before) {
    query += " AND timestamp <= ?";
    params.push(options.before);
  }

  query += " ORDER BY timestamp DESC";

  if (options.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    timestamp: Number(row.timestamp),
    actor: String(row.actor),
    projectId: String(row.project_id),
    jobId: row.job_id ? String(row.job_id) : undefined,
    revision: row.revision ? Number(row.revision) : undefined,
    action: String(row.action),
    status: String(row.status),
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : {}
  }));
}

/**
 * Get audit trail for a specific revision.
 */
export function getRevisionAuditTrail(
  db: DatabaseSync,
  projectId: string,
  revision: number
): AuditEntry[] {
  return queryAudits(db, {
    projectId,
    action: "publish_revision",
    since: 0
  }).filter((entry) => entry.revision === revision);
}

/**
 * Get audit trail for a specific job.
 */
export function getJobAuditTrail(db: DatabaseSync, jobId: string): AuditEntry[] {
  return queryAudits(db, {
    projectId: "all",
    action: "job_state_change",
    since: 0
  }).filter((entry) => entry.jobId === jobId);
}
