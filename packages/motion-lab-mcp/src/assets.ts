/**
 * Assets, artifacts, and technique index — the durable media registry.
 *
 * - assets: inputs entering the pipeline (voiceover audio, reference docs,
 *   images, scripts, data). Exactly one of path/inline bytes; paths stay
 *   repo-relative so rows never escape the lab directory.
 * - artifacts: outputs jobs produce (render manifests today, encoded video
 *   tomorrow), linked to the producing job and source revision.
 * - techniques: queryable index of the technique ledger. record_technique
 *   license-gates first, writes the DB row, then appends the human-readable
 *   JSON ledger — the DB is the query surface, the ledger the audit log.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const ASSET_KINDS = ["voiceover", "reference", "image", "video", "script", "data"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface AssetRow {
  id: string;
  project_id: string;
  kind: AssetKind;
  label: string;
  path: string | null;
  bytes: number;
  meta: Record<string, unknown>;
  created_at: number;
}

export interface ArtifactRow {
  id: string;
  project_id: string;
  job_id: string | null;
  rev: number | null;
  kind: string;
  path: string;
  meta: Record<string, unknown>;
  created_at: number;
}

export interface TechniqueRow {
  id: string;
  project_id: string;
  source_kind: string;
  source_ref: string;
  license: string;
  what: string;
  adapted_to: string;
  compatibility: string;
  ledger_id: string | null;
  created_at: number;
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Register an input asset. label and a known kind are required; exactly one
 * of path (repo-relative) or byte size must be given. Absolute paths and
 * parent-directory escapes are refused loudly.
 */
export function registerAsset(
  db: DatabaseSync,
  projectId: string,
  input: { kind: string; label: string; path?: string | null; bytes?: number; meta?: Record<string, unknown> }
): AssetRow {
  const kind = String(input.kind ?? "").toLowerCase();
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown asset kind "${String(input.kind)}" — use ${ASSET_KINDS.join(", ")}.`);
  }
  const label = String(input.label ?? "").trim();
  if (!label) throw new Error("registerAsset requires a label.");
  const path = input.path === undefined || input.path === null ? null : String(input.path).replace(/\\/g, "/");
  const bytes = Math.max(0, Math.round(Number(input.bytes) || 0));
  if (path !== null) {
    if (path.length === 0) throw new Error("registerAsset: empty path.");
    if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..")) {
      throw new Error(`registerAsset: path "${path}" must stay repo-relative (no absolute paths, no "..").`);
    }
    if (bytes !== 0) throw new Error("registerAsset: give either path or bytes, not both.");
  } else if (bytes === 0) {
    throw new Error("registerAsset: give either a path or a byte size.");
  }
  const row: AssetRow = {
    id: `asset-${randomUUID()}`,
    project_id: projectId,
    kind: kind as AssetKind,
    label,
    path,
    bytes,
    meta: input.meta ?? {},
    created_at: Date.now()
  };
  db.prepare("INSERT INTO assets (id, project_id, kind, label, path, bytes, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.project_id,
    row.kind,
    row.label,
    row.path,
    row.bytes,
    JSON.stringify(row.meta),
    row.created_at
  );
  return row;
}

export function getAsset(db: DatabaseSync, id: string): AssetRow | null {
  const raw = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!raw) return null;
  return {
    id: String(raw.id),
    project_id: String(raw.project_id),
    kind: String(raw.kind) as AssetKind,
    label: String(raw.label),
    path: clean(raw.path),
    bytes: Number(raw.bytes ?? 0),
    meta: parseMeta(raw.meta),
    created_at: Number(raw.created_at)
  };
}

/** Find an asset by its repo-relative path (pipeline reuse: one row per file). */
export function findAssetByPath(db: DatabaseSync, projectId: string, path: string): AssetRow | null {
  const raw = db.prepare("SELECT * FROM assets WHERE project_id = ? AND path = ? ORDER BY created_at ASC LIMIT 1").get(projectId, path) as Record<string, unknown> | undefined;
  if (!raw) return null;
  return {
    id: String(raw.id),
    project_id: String(raw.project_id),
    kind: String(raw.kind) as AssetKind,
    label: String(raw.label),
    path: clean(raw.path),
    bytes: Number(raw.bytes ?? 0),
    meta: parseMeta(raw.meta),
    created_at: Number(raw.created_at)
  };
}

export function listAssets(db: DatabaseSync, projectId: string, limit = 100): AssetRow[] {
  const rows = db.prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as Array<Record<string, unknown>>;
  return rows.map((raw) => ({
    id: String(raw.id),
    project_id: String(raw.project_id),
    kind: String(raw.kind) as AssetKind,
    label: String(raw.label),
    path: clean(raw.path),
    bytes: Number(raw.bytes ?? 0),
    meta: parseMeta(raw.meta),
    created_at: Number(raw.created_at)
  }));
}

/** Record a job output. path is required; job/rev links optional but encouraged. */
export function recordArtifact(
  db: DatabaseSync,
  input: { projectId: string; kind: string; path: string; jobId?: string | null; rev?: number | null; meta?: Record<string, unknown> }
): ArtifactRow {
  if (!input.path || typeof input.path !== "string") throw new Error("recordArtifact requires a path.");
  const row: ArtifactRow = {
    id: `artifact-${randomUUID()}`,
    project_id: input.projectId,
    job_id: input.jobId ?? null,
    rev: input.rev === undefined || input.rev === null ? null : Math.round(Number(input.rev)),
    kind: String(input.kind ?? "render-manifest"),
    path: input.path,
    meta: input.meta ?? {},
    created_at: Date.now()
  };
  db.prepare("INSERT INTO artifacts (id, project_id, job_id, rev, kind, path, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.project_id,
    row.job_id,
    row.rev,
    row.kind,
    row.path,
    JSON.stringify(row.meta),
    row.created_at
  );
  return row;
}

export function listArtifacts(db: DatabaseSync, projectId: string, limit = 100): ArtifactRow[] {
  const rows = db.prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as Array<Record<string, unknown>>;
  return rows.map((raw) => ({
    id: String(raw.id),
    project_id: String(raw.project_id),
    job_id: clean(raw.job_id),
    rev: raw.rev === null || raw.rev === undefined ? null : Number(raw.rev),
    kind: String(raw.kind),
    path: String(raw.path),
    meta: parseMeta(raw.meta),
    created_at: Number(raw.created_at)
  }));
}

export function artifactsForJob(db: DatabaseSync, jobId: string): ArtifactRow[] {
  const rows = db.prepare("SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at ASC").all(jobId) as Array<Record<string, unknown>>;
  return rows.map((raw) => ({
    id: String(raw.id),
    project_id: String(raw.project_id),
    job_id: clean(raw.job_id),
    rev: raw.rev === null || raw.rev === undefined ? null : Number(raw.rev),
    kind: String(raw.kind),
    path: String(raw.path),
    meta: parseMeta(raw.meta),
    created_at: Number(raw.created_at)
  }));
}

/**
 * Index a license-cleared technique. Upsert on (project, source_ref,
 * adapted_to): re-recording the same adaptation returns the existing row
 * ({ created: false }) instead of duplicating it.
 */
export function recordTechnique(
  db: DatabaseSync,
  projectId: string,
  input: { sourceKind: string; sourceRef: string; license: string; what: string; adaptedTo: string; compatibility: string; ledgerId?: string | null }
): { row: TechniqueRow; created: boolean } {
  const existing = db
    .prepare("SELECT * FROM techniques WHERE project_id = ? AND source_ref = ? AND adapted_to = ?")
    .get(projectId, input.sourceRef, input.adaptedTo) as Record<string, unknown> | undefined;
  if (existing) {
    return {
      row: {
        id: String(existing.id),
        project_id: String(existing.project_id),
        source_kind: String(existing.source_kind),
        source_ref: String(existing.source_ref),
        license: String(existing.license),
        what: String(existing.what),
        adapted_to: String(existing.adapted_to),
        compatibility: String(existing.compatibility),
        ledger_id: clean(existing.ledger_id),
        created_at: Number(existing.created_at)
      },
      created: false
    };
  }
  const row: TechniqueRow = {
    id: `techdb-${randomUUID()}`,
    project_id: projectId,
    source_kind: input.sourceKind,
    source_ref: input.sourceRef,
    license: input.license,
    what: input.what,
    adapted_to: input.adaptedTo,
    compatibility: input.compatibility,
    ledger_id: input.ledgerId ?? null,
    created_at: Date.now()
  };
  db.prepare("INSERT INTO techniques (id, project_id, source_kind, source_ref, license, what, adapted_to, compatibility, ledger_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.project_id,
    row.source_kind,
    row.source_ref,
    row.license,
    row.what,
    row.adapted_to,
    row.compatibility,
    row.ledger_id,
    row.created_at
  );
  return { row, created: true };
}

export function listTechniques(db: DatabaseSync, projectId: string, limit = 100): TechniqueRow[] {
  const rows = db.prepare("SELECT * FROM techniques WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as Array<Record<string, unknown>>;
  return rows.map((raw) => ({
    id: String(raw.id),
    project_id: String(raw.project_id),
    source_kind: String(raw.source_kind),
    source_ref: String(raw.source_ref),
    license: String(raw.license),
    what: String(raw.what),
    adapted_to: String(raw.adapted_to),
    compatibility: String(raw.compatibility),
    ledger_id: clean(raw.ledger_id),
    created_at: Number(raw.created_at)
  }));
}
