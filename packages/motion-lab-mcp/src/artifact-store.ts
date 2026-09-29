/**
 * ArtifactStore — storage abstraction for large files and binary artifacts.
 *
 * Structured state lives in the database.
 * Large files live in the artifact store.
 *
 * First implementation: local filesystem.
 * Interface is designed to be replaceable with S3/R2/cloud storage later.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface ArtifactMetadata {
  id: string;
  projectId: string;
  jobId?: string;
  rev?: number;
  kind: string;
  path: string;
  bytes: number;
  hash?: string;
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface StoreOptions {
  basePath: string;
}

export interface WriteArtifactRequest {
  projectId: string;
  jobId?: string;
  rev?: number;
  kind: string;
  data: Buffer | string;
  extension?: string;
  meta?: Record<string, unknown>;
}

export class ArtifactStore {
  private readonly basePath: string;

  constructor(options: StoreOptions) {
    this.basePath = options.basePath;
    mkdirSync(this.basePath, { recursive: true });
  }

  /**
   * Write artifact to storage and register in database.
   * Returns metadata with final path and ID.
   */
  write(db: DatabaseSync, request: WriteArtifactRequest): ArtifactMetadata {
    const id = `artifact-${randomUUID()}`;
    const ext = request.extension ?? "bin";
    const filename = `${id}.${ext}`;
    const relativePath = join(request.projectId, request.kind, filename);
    const absolutePath = join(this.basePath, relativePath);

    // Ensure directory exists
    mkdirSync(dirname(absolutePath), { recursive: true });

    // Write to disk
    const data = typeof request.data === "string" ? Buffer.from(request.data, "utf8") : request.data;
    writeFileSync(absolutePath, data);

    // Get final size
    const bytes = statSync(absolutePath).size;

    // Register in database
    const now = Date.now();
    db.prepare(
      `INSERT INTO artifacts (id, project_id, job_id, rev, kind, path, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      request.projectId,
      request.jobId ?? null,
      request.rev ?? null,
      request.kind,
      relativePath,
      JSON.stringify(request.meta ?? {}),
      now
    );

    return {
      id,
      projectId: request.projectId,
      jobId: request.jobId,
      rev: request.rev,
      kind: request.kind,
      path: relativePath,
      bytes,
      meta: request.meta ?? {},
      createdAt: now
    };
  }

  /**
   * Read artifact from storage.
   */
  read(artifactPath: string): Buffer {
    const absolutePath = join(this.basePath, artifactPath);
    if (!existsSync(absolutePath)) {
      throw new Error(`Artifact not found: ${artifactPath}`);
    }
    return readFileSync(absolutePath);
  }

  /**
   * Check if artifact exists.
   */
  exists(artifactPath: string): boolean {
    return existsSync(join(this.basePath, artifactPath));
  }

  /**
   * Get artifact size in bytes.
   */
  size(artifactPath: string): number {
    const absolutePath = join(this.basePath, artifactPath);
    if (!existsSync(absolutePath)) return 0;
    return statSync(absolutePath).size;
  }

  /**
   * Get absolute path for artifact (for direct file operations).
   */
  absolutePath(artifactPath: string): string {
    return join(this.basePath, artifactPath);
  }
}

/**
 * Query artifacts from database.
 */
export function listArtifacts(
  db: DatabaseSync,
  projectId: string,
  options: { kind?: string; jobId?: string; rev?: number; limit?: number } = {}
): ArtifactMetadata[] {
  let query = "SELECT * FROM artifacts WHERE project_id = ?";
  const params: Array<string | number> = [projectId];

  if (options.kind) {
    query += " AND kind = ?";
    params.push(options.kind);
  }

  if (options.jobId) {
    query += " AND job_id = ?";
    params.push(options.jobId);
  }

  if (options.rev !== undefined) {
    query += " AND rev = ?";
    params.push(options.rev);
  }

  query += " ORDER BY created_at DESC";

  if (options.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    jobId: row.job_id ? String(row.job_id) : undefined,
    rev: row.rev ? Number(row.rev) : undefined,
    kind: String(row.kind),
    path: String(row.path),
    bytes: Number(row.bytes ?? 0),
    meta: typeof row.meta === "string" ? JSON.parse(row.meta) : {},
    createdAt: Number(row.created_at)
  }));
}

/**
 * Get artifact metadata by ID.
 */
export function getArtifact(db: DatabaseSync, artifactId: string): ArtifactMetadata | null {
  const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: String(row.id),
    projectId: String(row.project_id),
    jobId: row.job_id ? String(row.job_id) : undefined,
    rev: row.rev ? Number(row.rev) : undefined,
    kind: String(row.kind),
    path: String(row.path),
    bytes: Number(row.bytes ?? 0),
    meta: typeof row.meta === "string" ? JSON.parse(row.meta) : {},
    createdAt: Number(row.created_at)
  };
}
