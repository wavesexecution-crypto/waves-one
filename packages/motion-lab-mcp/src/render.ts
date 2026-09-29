/**
 * Render service — durable render/export jobs over published revisions.
 *
 * A render job re-validates the published revision, re-audits the
 * single-writer invariant, derives a render manifest (timing, elements,
 * requested export format), and writes it as an artifact other stages
 * consume. Browser frame capture stays where it must live (the preview
 * page); everything up to the encode is durable, recoverable, and
 * audited here.
 *
 * Deterministic failures (missing revision, invalid stored ops, writer
 * overlaps) fail fast with retryable=false — re-running the same bytes
 * would fail the same way. Crashes mid-render stop the heartbeat and
 * recoverStale() requeues the job, so nobody loses a render.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { recordArtifact } from "./assets.js";
import { recordEvent } from "./jobs.js";
import { auditSingleWriter, opSpan } from "./planner.js";
import { getRevision } from "./revisions.js";
import { validateAll } from "./validate.js";
import type { JobContext } from "./worker.js";

export type RenderFormat = "mp4" | "webm";

export interface RenderManifest {
  rev: number;
  projectId: string;
  format: RenderFormat;
  orientation: "landscape" | "vertical";
  opCount: number;
  elementCount: number;
  durationMs: number;
  overlaps: Array<{ key: string; first: string; second: string }>;
  validation: { ok: boolean; errorCount: number; warningCount: number };
  artifact: string;
  completedAt: string;
}

/** Deterministic failure marker the worker honors (no retry). */
export function failFast(message: string): Error {
  return Object.assign(new Error(message), { retryable: false });
}

/** Audit-visible progress: appends a progress event (0..1, clamped). */
export function reportProgress(db: DatabaseSync, jobId: string, progress: number, message: string): void {
  const clamped = Math.max(0, Math.min(1, progress));
  recordEvent(db, jobId, "progress", { progress: Math.round(clamped * 100) / 100, message });
}

export function renderRevision(
  db: DatabaseSync,
  projectId: string,
  rev: number,
  format: RenderFormat,
  artifactsDir: string,
  onProgress?: (progress: number, message: string) => void
): RenderManifest {
  const emit = (progress: number, message: string): void => {
    if (onProgress) onProgress(progress, message);
  };
  emit(0, "loading revision");
  const revision = getRevision(db, projectId, rev);
  if (!revision) throw failFast(`render: revision ${rev} of project "${projectId}" does not exist.`);
  emit(0.25, "validating ops");
  const validation = validateAll(revision.ops);
  if (!validation.ok) throw failFast(`render: stored rev ${rev} fails validation (${validation.errors.length} errors) — republish first.`);
  emit(0.5, "auditing single-writer");
  const overlaps = auditSingleWriter(revision.ops);
  if (overlaps.length > 0) throw failFast(`render: rev ${rev} has ${overlaps.length} overlapping writer(s) — republish first.`);
  emit(0.75, "deriving manifest");
  let durationMs = 0;
  for (const op of revision.ops) {
    const span = opSpan(op);
    if (span) durationMs = Math.max(durationMs, span.end);
  }
  const scene = revision.ops.find((op) => op.kind === "scene");
  const elements = scene?.kind === "scene" ? scene.scene.elements : [];
  const orientation = elements.some((element) => (element as { layout?: unknown }).layout === "reel") ? "vertical" : "landscape";
  const manifest: RenderManifest = {
    rev,
    projectId,
    format,
    orientation,
    opCount: revision.ops.length,
    elementCount: elements.length,
    durationMs: Math.round(durationMs),
    overlaps: [],
    validation: { ok: true, errorCount: 0, warningCount: validation.warnings.length },
    artifact: join(artifactsDir, `render-rev-${rev}.json`),
    completedAt: new Date().toISOString()
  };
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(manifest.artifact, JSON.stringify(manifest, null, 2));
  emit(1, "manifest written");
  return manifest;
}

export interface RenderPayload {
  projectId?: unknown;
  rev?: unknown;
  format?: unknown;
}

/** Worker handler factory: needs an artifacts directory, so callers build it. */
export function createRenderHandler(artifactsDir: string) {
  return (ctx: JobContext): unknown => {
    const payload = (ctx.job.payload ?? {}) as RenderPayload;
    const rev = Math.round(Number(payload.rev));
    if (!Number.isFinite(rev) || rev < 1) throw failFast("render job needs payload.rev >= 1.");
    const projectId = typeof payload.projectId === "string" && payload.projectId ? payload.projectId : "project_default";
    const format: RenderFormat = payload.format === "webm" ? "webm" : "mp4";
    reportProgress(ctx.db, ctx.job.id, 0, "render started");
    const manifest = renderRevision(ctx.db, projectId, rev, format, artifactsDir, (progress, message) => {
      reportProgress(ctx.db, ctx.job.id, progress, message);
      ctx.heartbeat();
    });
    const artifact = recordArtifact(ctx.db, {
      projectId,
      kind: "render-manifest",
      path: manifest.artifact,
      jobId: ctx.job.id,
      rev,
      meta: { format: manifest.format, orientation: manifest.orientation, durationMs: manifest.durationMs, opCount: manifest.opCount }
    });
    return { rev: manifest.rev, format: manifest.format, orientation: manifest.orientation, opCount: manifest.opCount, durationMs: manifest.durationMs, artifact: manifest.artifact, artifactId: artifact.id };
  };
}
