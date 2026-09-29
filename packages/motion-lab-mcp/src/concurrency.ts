/**
 * Concurrency Control — job supersession and generation ownership.
 *
 * Prevents the bug where concurrent generations clobber newer state.
 * Uses project version + revision expectation + job ownership + supersession.
 *
 * Example scenario:
 * - Generation A starts at revision 10
 * - Generation B starts at revision 10
 * - Generation B finishes first (publishes rev 11)
 * - Generation A MUST NOT overwrite generation B
 *
 * Solution: expectedRev check + supersession tracking.
 */

import type { DatabaseSync } from "node:sqlite";
import { currentRev } from "./revisions.js";

export interface SupersessionContext {
  db: DatabaseSync;
  projectId: string;
  generationId: string;
}

export interface GenerationOwnership {
  generationId: string;
  projectId: string;
  startRevision: number;
  createdAt: number;
}

/**
 * Start a new generation, recording its start revision.
 * Returns generation context to check supersession later.
 */
export function startGeneration(db: DatabaseSync, projectId: string): GenerationOwnership {
  const generationId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startRevision = currentRev(db, projectId);
  const createdAt = Date.now();

  return {
    generationId,
    projectId,
    startRevision,
    createdAt
  };
}

/**
 * Check if this generation has been superseded by newer work.
 * Returns true if another generation published a newer revision.
 */
export function isSuperseded(db: DatabaseSync, generation: GenerationOwnership): boolean {
  const current = currentRev(db, generation.projectId);
  return current !== generation.startRevision;
}

/**
 * Validate generation can publish.
 * Throws if superseded.
 */
export function validateCanPublish(db: DatabaseSync, generation: GenerationOwnership): void {
  if (isSuperseded(db, generation)) {
    const current = currentRev(db, generation.projectId);
    throw new SupersessionError(
      `Generation ${generation.generationId} superseded: started at rev ${generation.startRevision}, current is rev ${current}`
    );
  }
}

export class SupersessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupersessionError";
  }
}

/**
 * Idempotency key generation for jobs.
 * Same inputs always produce the same key.
 */
export function generateIdempotencyKey(type: string, projectId: string, contentHash: string): string {
  return `${type}:${projectId}:${contentHash}`;
}

/**
 * Content hash for deterministic key generation.
 */
export function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
