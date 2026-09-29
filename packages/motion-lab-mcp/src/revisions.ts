/**
 * Revision store — immutable published revisions.
 *
 * Rows are never mutated: a new AI edit is a candidate that validates
 * first and publishes as rev+1 only on success. publishRevision() takes an
 * optional expectedRev — a stale generation (expected 9, current 10)
 * is rejected instead of silently overwriting newer work. Failed
 * validation never creates a row and never touches the current revision.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MotionOp } from "./ops.js";
import { validateAll, type ValidationReport } from "./validate.js";

export interface RevisionRow {
  id: string;
  project_id: string;
  rev: number;
  ops: MotionOp[];
  parent_rev: number | null;
  message: string;
  actor: string;
  created_at: number;
}

export class RevisionConflict extends Error {
  readonly expected: number;
  readonly current: number;
  constructor(expected: number, current: number) {
    super(`Revision conflict: expected rev ${expected}, current is rev ${current}. Reload and rebase the change.`);
    this.name = "RevisionConflict";
    this.expected = expected;
    this.current = current;
  }
}

export class RevisionInvalid extends Error {
  readonly report: ValidationReport;
  constructor(report: ValidationReport) {
    super(`Revision rejected by validation: ${report.errors.map((issue) => issue.code).join(", ") || "unknown"}.`);
    this.name = "RevisionInvalid";
    this.report = report;
  }
}

function toRow(raw: Record<string, unknown>): RevisionRow {
  let ops: MotionOp[] = [];
  try {
    const parsed: unknown = JSON.parse(String(raw.ops ?? "[]"));
    if (Array.isArray(parsed)) ops = parsed as MotionOp[];
  } catch {
    ops = [];
  }
  return {
    id: String(raw.id),
    project_id: String(raw.project_id),
    rev: Number(raw.rev),
    ops,
    parent_rev: raw.parent_rev === null || raw.parent_rev === undefined ? null : Number(raw.parent_rev),
    message: String(raw.message ?? ""),
    actor: String(raw.actor ?? ""),
    created_at: Number(raw.created_at)
  };
}

/** Highest published rev for a project (0 when nothing published). */
export function currentRev(db: DatabaseSync, projectId: string): number {
  const row = db.prepare("SELECT MAX(rev) AS rev FROM revisions WHERE project_id = ?").get(projectId) as { rev: number | null };
  return row?.rev ?? 0;
}

export function getRevision(db: DatabaseSync, projectId: string, rev: number): RevisionRow | null {
  const row = db.prepare("SELECT * FROM revisions WHERE project_id = ? AND rev = ?").get(projectId, rev) as Record<string, unknown> | undefined;
  return row ? toRow(row) : null;
}

export function listRevisions(db: DatabaseSync, projectId: string, limit = 50): RevisionRow[] {
  const rows = db.prepare("SELECT * FROM revisions WHERE project_id = ? ORDER BY rev DESC LIMIT ?").all(projectId, limit) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/**
 * Validate ops, then publish immutably as current+1. Throws
 * RevisionConflict on stale expectedRev, RevisionInvalid on bad ops —
 * neither touches stored revisions.
 */
export function publishRevision(
  db: DatabaseSync,
  projectId: string,
  ops: MotionOp[],
  options: { expectedRev?: number; message?: string; actor?: string } = {}
): RevisionRow {
  const report = validateAll(ops);
  if (!report.ok) throw new RevisionInvalid(report);
  const current = currentRev(db, projectId);
  if (options.expectedRev !== undefined && options.expectedRev !== current) {
    throw new RevisionConflict(options.expectedRev, current);
  }
  const row: RevisionRow = {
    id: `rev-${randomUUID()}`,
    project_id: projectId,
    rev: current + 1,
    ops,
    parent_rev: current === 0 ? null : current,
    message: options.message ?? "",
    actor: options.actor ?? "mcp",
    created_at: Date.now()
  };
  db.prepare("INSERT INTO revisions (id, project_id, rev, ops, parent_rev, message, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.project_id,
    row.rev,
    JSON.stringify(row.ops),
    row.parent_rev,
    row.message,
    row.actor,
    row.created_at
  );
  return row;
}
