/**
 * Export System — immutable export artifacts with format, resolution, and codec metadata.
 *
 * Exports are immutable artifacts.
 * Never overwrite a published export.
 *
 * Support formats:
 * - 9:16 (1080×1920, vertical)
 * - 16:9 (1920×1080, landscape)
 * - 60fps
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ExportFormat = "mp4" | "webm";
export type ExportOrientation = "landscape" | "vertical";

export interface ExportResolution {
  width: number;
  height: number;
  orientation: ExportOrientation;
}

export const EXPORT_PRESETS: Record<ExportOrientation, ExportResolution> = {
  landscape: { width: 1920, height: 1080, orientation: "landscape" },
  vertical: { width: 1080, height: 1920, orientation: "vertical" }
};

export interface ExportRow {
  id: string;
  projectId: string;
  revision: number;
  format: ExportFormat;
  orientation: ExportOrientation;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec: string;
  artifactPath: string;
  bytes: number;
  durationMs: number;
  createdAt: number;
}

export interface CreateExportOptions {
  projectId: string;
  revision: number;
  format: ExportFormat;
  orientation?: ExportOrientation;
  codec?: string;
  audioCodec?: string;
  artifactPath: string;
  bytes: number;
  durationMs: number;
}

function toRow(raw: Record<string, unknown>): ExportRow {
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    revision: Number(raw.rev),
    format: raw.format as ExportFormat,
    orientation: raw.orientation as ExportOrientation,
    width: Number(raw.width),
    height: Number(raw.height),
    fps: Number(raw.fps ?? 60),
    codec: String(raw.codec ?? "h264"),
    audioCodec: String(raw.audio_codec ?? "aac"),
    artifactPath: String(raw.artifact_path),
    bytes: Number(raw.bytes ?? 0),
    durationMs: Number(raw.duration_ms ?? 0),
    createdAt: Number(raw.created_at)
  };
}

/**
 * Create a new export record.
 */
export function createExport(
  db: DatabaseSync,
  options: CreateExportOptions
): ExportRow {
  const id = `export-${randomUUID()}`;
  const preset = EXPORT_PRESETS[options.orientation ?? "landscape"];
  const now = Date.now();

  const inserted = db
    .prepare(
      `INSERT INTO exports (id, project_id, rev, format, orientation, width, height, fps, codec, audio_codec, artifact_path, bytes, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      id,
      options.projectId,
      options.revision,
      options.format,
      options.orientation ?? "landscape",
      preset.width,
      preset.height,
      60,
      options.codec ?? "h264",
      options.audioCodec ?? "aac",
      options.artifactPath,
      options.bytes,
      options.durationMs,
      now
    ) as Record<string, unknown>;

  return toRow(inserted);
}

/**
 * Get export by ID.
 */
export function getExport(db: DatabaseSync, exportId: string): ExportRow | null {
  const row = db.prepare("SELECT * FROM exports WHERE id = ?").get(exportId) as Record<string, unknown> | undefined;
  return row ? toRow(row) : null;
}

/**
 * List exports for a project (latest first).
 */
export function listExports(
  db: DatabaseSync,
  projectId: string,
  limit = 50
): ExportRow[] {
  const rows = db
    .prepare("SELECT * FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(projectId, limit) as Array<Record<string, unknown>>;

  return rows.map(toRow);
}

/**
 * Get exports for a specific revision.
 */
export function getRevisionExports(
  db: DatabaseSync,
  projectId: string,
  revision: number
): ExportRow[] {
  return listExports(db, projectId).filter((e) => e.revision === revision);
}

/**
 * Delete export (soft delete by marking as removed).
 * In production, this would remove from artifact store too.
 */
export function deleteExport(db: DatabaseSync, exportId: string): void {
  db.prepare("UPDATE exports SET removed_at = ? WHERE id = ?").run(Date.now(), exportId);
}
