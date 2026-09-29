/**
 * Creative Director — the conductor service for voiceover-to-render pipeline.
 *
 * This is the top-level orchestrator that coordinates:
 * - Voice Engine (transcription, audio analysis, timing)
 * - Story Engine (narrative understanding, beat detection)
 * - Visual State Engine (semantic intent → visual states)
 * - Motion Planner (visual states → validated animation ops)
 * - Validation & Revision (immutable publish)
 * - Render Engine (manifest generation)
 * - Export System (artifact management)
 *
 * The Creative Director does NOT replace the animation engine.
 * It orchestrates the pipeline that PRODUCES animation operations
 * for the deterministic engine to execute.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MotionOp } from "./ops.js";
import type { Story } from "./story.js";
import { createFromVoiceover as runVoiceoverPipeline, type VoiceoverPipelineInput, type VoiceoverPipelineDeps } from "./pipeline.js";

export interface CreativeDirectorContext {
  db: DatabaseSync;
  labDir: string;
  artifactsDir: string;
  transcribe?: (audio: Buffer, voiceoverId: string) => string | Promise<string>;
}

export interface CreationRequest {
  projectId?: string;
  voiceoverId?: string;
  transcript?: string;
  segments?: Array<{ startMs: number; endMs?: number; text?: string }>;
  durationMs?: number;
  orientation?: "landscape" | "vertical";
  format?: "mp4" | "webm";
  message?: string;
}

export interface CreationResult {
  projectId: string;
  voiceoverId: string | null;
  story: Story;
  ops: MotionOp[];
  revision: number;
  revisionId: string;
  renderJobId: string;
  artifactId: string | null;
  artifact: string | null;
  durationMs: number;
  orientation: string;
}

/**
 * Creative Director main entry point: voiceover → final render artifact.
 *
 * This executes the complete pipeline:
 * 1. Voice analysis (transcribe + beats if needed)
 * 2. Story understanding (transcript → semantic beats)
 * 3. Visual language selection (intent → states)
 * 4. Motion planning (states → ops)
 * 5. Validation
 * 6. Publish as immutable revision
 * 7. Render manifest generation
 * 8. Return complete result
 */
export async function createFromVoiceover(
  ctx: CreativeDirectorContext,
  request: CreationRequest
): Promise<CreationResult> {
  const input: VoiceoverPipelineInput = {
    projectId: request.projectId,
    voiceoverId: request.voiceoverId,
    transcript: request.transcript,
    segments: request.segments,
    durationMs: request.durationMs,
    orientation: request.orientation,
    format: request.format,
    message: request.message
  };

  const deps: VoiceoverPipelineDeps = {
    labDir: ctx.labDir,
    artifactsDir: ctx.artifactsDir,
    transcribe: ctx.transcribe
  };

  const result = await runVoiceoverPipeline(ctx.db, input, deps);

  return {
    projectId: input.projectId ?? "project_default",
    voiceoverId: input.voiceoverId ?? null,
    story: result.story,
    ops: result.ops,
    revision: result.rev,
    revisionId: result.revisionId,
    renderJobId: result.jobId,
    artifactId: result.artifactId,
    artifact: result.artifact,
    durationMs: result.durationMs,
    orientation: result.orientation
  };
}
