/**
 * Project System — real project entities with ownership and versioning.
 *
 * A project owns:
 * - voiceovers
 * - beats
 * - briefs
 * - plans
 * - assets
 * - techniques
 * - revisions
 * - jobs
 * - renders
 * - exports
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  current_revision: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface CreateProjectOptions {
  orgId?: string;
  name: string;
  description?: string;
}

export interface UpdateProjectOptions {
  name?: string;
  description?: string;
  currentRevision?: number;
  status?: string;
}

function toRow(raw: Record<string, unknown>): ProjectRow {
  return {
    id: String(raw.id),
    org_id: String(raw.org_id),
    name: String(raw.name),
    description: raw.description === null || raw.description === undefined ? null : String(raw.description),
    current_revision: Number(raw.current_revision ?? 0),
    status: String(raw.status ?? "active"),
    created_at: Number(raw.created_at),
    updated_at: Number(raw.updated_at)
  };
}

/**
 * Create a new project.
 */
export function createProject(db: DatabaseSync, options: CreateProjectOptions): ProjectRow {
  const now = Date.now();
  const id = `proj-${randomUUID()}`;
  const orgId = options.orgId ?? "org_default";

  const inserted = db
    .prepare(
      `INSERT INTO projects (id, org_id, name, description, current_revision, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'active', ?, ?)
       RETURNING *`
    )
    .get(id, orgId, options.name, options.description ?? null, now, now) as Record<string, unknown>;

  return toRow(inserted);
}

/**
 * Get project by ID.
 */
export function getProject(db: DatabaseSync, projectId: string): ProjectRow | null {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
  return row ? toRow(row) : null;
}

/**
 * List projects for an organization.
 */
export function listProjects(db: DatabaseSync, orgId: string, limit = 50): ProjectRow[] {
  const rows = db
    .prepare("SELECT * FROM projects WHERE org_id = ? ORDER BY updated_at DESC LIMIT ?")
    .all(orgId, limit) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/**
 * Update project metadata.
 */
export function updateProject(db: DatabaseSync, projectId: string, options: UpdateProjectOptions): ProjectRow {
  const now = Date.now();
  const current = getProject(db, projectId);
  if (!current) throw new Error(`Project "${projectId}" not found.`);

  const updates: Array<{ key: string; value: string | number | null }> = [{ key: "updated_at", value: now }];

  if (options.name !== undefined) updates.push({ key: "name", value: options.name });
  if (options.description !== undefined) updates.push({ key: "description", value: options.description });
  if (options.currentRevision !== undefined) updates.push({ key: "current_revision", value: options.currentRevision });
  if (options.status !== undefined) updates.push({ key: "status", value: options.status });

  const setClause = updates.map((u) => `${u.key} = ?`).join(", ");
  const values = [...updates.map((u) => u.value), projectId];

  const updated = db
    .prepare(`UPDATE projects SET ${setClause} WHERE id = ? RETURNING *`)
    .get(...values) as Record<string, unknown>;

  return toRow(updated);
}

/**
 * Delete project (soft delete by setting status).
 */
export function deleteProject(db: DatabaseSync, projectId: string): void {
  updateProject(db, projectId, { status: "deleted" });
}

/**
 * Touch project (update timestamp).
 */
export function touchProject(db: DatabaseSync, projectId: string): void {
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(Date.now(), projectId);
}
