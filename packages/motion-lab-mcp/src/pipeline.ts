/**
 * Voiceover-to-render pipeline — the whole backend chain in one call.
 *
 * voiceover asset → story → plan → published revision → render job →
 * manifest artifact, with provenance links at every step (asset id, rev,
 * job id, artifact id). Deterministic end to end: the only external call
 * is transcription, injected as a dependency so tests run key-free.
 * Without a transcript/segments AND without a transcriber, the pipeline
 * fails loudly instead of hallucinating narration.
 */

import type { DatabaseSync } from "node:sqlite";
import { findAssetByPath, registerAsset, type AssetRow } from "./assets.js";
import { enqueue, getJob } from "./jobs.js";
import { defaultHandlers } from "./orchestrator.js";
import { buildStory, validateStory, type Story } from "./story.js";
import { planStory } from "./planner.js";
import type { ValidationReport } from "./validate.js";
import { publishRevision } from "./revisions.js";
import { createRenderHandler, failFast, type RenderFormat } from "./render.js";
import { readVoiceoverAudio } from "./voiceover.js";
import { createWorker } from "./worker.js";
import { commit, type StorePaths } from "./store.js";
import { dirname, join } from "node:path";
import type { MotionOp } from "./ops.js";

export interface PipelineSegment {
  startMs: number;
  endMs?: number;
  text?: string;
}

export interface VoiceoverPipelineInput {
  projectId?: string;
  voiceoverId?: string;
  transcript?: string;
  segments?: PipelineSegment[];
  durationMs?: number;
  orientation?: string;
  format?: RenderFormat;
  message?: string;
}

export interface VoiceoverPipelineDeps {
  labDir: string;
  artifactsDir: string;
  transcribe?: (audio: Buffer, voiceoverId: string) => string | Promise<string>;
}

export interface VoiceoverPipelineResult {
  asset: AssetRow | null;
  story: Story;
  ops: MotionOp[];
  /** Resolved narration: transcript arg, transcriber output, or segment text. */
  transcript: string;
  /** Creative brief that directed the story (the narration itself). */
  brief: string;
  /** Motion validation report that gated publication. */
  validation: ValidationReport;
  rev: number;
  revisionId: string;
  /** Live file revision the preview and export actually render. */
  fileRevision: number;
  jobId: string;
  artifactId: string | null;
  artifact: string | null;
  durationMs: number;
  orientation: string;
}

export async function createFromVoiceover(
  db: DatabaseSync,
  input: VoiceoverPipelineInput,
  deps: VoiceoverPipelineDeps
): Promise<VoiceoverPipelineResult> {
  const projectId = input.projectId && typeof input.projectId === "string" ? input.projectId : "project_default";
  const orientation = input.orientation === "vertical" ? "vertical" : "landscape";
  const format: RenderFormat = input.format === "webm" ? "webm" : "mp4";
  let transcript = typeof input.transcript === "string" ? input.transcript : "";
  let durationMs = Math.max(0, Math.round(Number(input.durationMs) || 0));
  let asset: AssetRow | null = null;

  if (input.voiceoverId) {
    let record: { file: string; bytes: number; durationMs: number };
    let audio: Buffer;
    try {
      ({ record, audio } = readVoiceoverAudio(deps.labDir, input.voiceoverId));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw failFast(`createFromVoiceover: unknown voiceover "${input.voiceoverId}" (${reason}).`);
    }
    if (!durationMs) durationMs = record.durationMs || 0;
    const assetPath = `.motion/voiceovers/${record.file}`;
    asset =
      findAssetByPath(db, projectId, assetPath) ??
      registerAsset(db, projectId, {
        kind: "voiceover",
        label: `voiceover ${input.voiceoverId}`,
        path: assetPath,
        meta: { size: record.bytes, durationMs: record.durationMs }
      });
    const hasSegments = Array.isArray(input.segments) && input.segments.length > 0;
    if (!transcript.trim() && !hasSegments) {
      if (!deps.transcribe) {
        throw failFast(
          `createFromVoiceover: voiceover "${input.voiceoverId}" has no transcript — pass transcript/segments or configure transcription (Scribe).`
        );
      }
      transcript = String(await deps.transcribe(audio, input.voiceoverId));
      if (!transcript.trim()) throw failFast("createFromVoiceover: transcription returned empty text.");
    }
  }

  const hasSegments = Array.isArray(input.segments) && input.segments.length > 0;
  if (!transcript.trim() && !hasSegments) {
    throw failFast("createFromVoiceover needs transcript text or timed segments (or a voiceoverId with transcription).");
  }
  if (!durationMs) durationMs = 20000;

  const story = buildStory(transcript, durationMs, hasSegments ? (input.segments as PipelineSegment[]) : undefined);
  const storyReport = validateStory(story);
  if (!storyReport.ok) throw failFast(`createFromVoiceover: story invalid (${storyReport.errors.join("; ")}).`);

  const planned = planStory(story.beats, orientation);
  if (!planned.validation.ok) {
    throw failFast(`createFromVoiceover: planner produced invalid ops (${planned.validation.errors.map((issue) => issue.code).join(", ")}).`);
  }
  if (planned.overlaps.length > 0) throw failFast("createFromVoiceover: planner produced overlapping writers.");

  const revision = publishRevision(db, projectId, planned.ops, {
    message: input.message ?? `from ${input.voiceoverId ?? "transcript"}`,
    actor: "pipeline"
  });
  // The DB revision is the durable record; the live files are what the
  // preview polls and the export renders. Commit both, or the film the
  // pipeline just made is invisible to the product. Paths derive from the
  // lab dir directly (never a workspace walk) so hermetic tests stay hermetic.
  const storePaths: StorePaths = {
    root: dirname(deps.labDir),
    labDir: deps.labDir,
    internalFile: join(deps.labDir, ".motion", "state.json"),
    publicFile: join(deps.labDir, "public", "motion-state.json"),
    historyFile: join(deps.labDir, ".motion", "history.jsonl")
  };
  const live = commit(storePaths, planned.ops);

  const { job } = enqueue(db, {
    projectId,
    type: "render",
    payload: { projectId, rev: revision.rev, format },
    maxAttempts: 3,
    idempotencyKey: `render:${projectId}:${revision.rev}:${format}`
  });
  const worker = createWorker(db, { ...defaultHandlers(), render: createRenderHandler(deps.artifactsDir) });
  let current = getJob(db, job.id) ?? job;
  for (let guard = 0; guard < 50; guard++) {
    if (current.status !== "QUEUED" && current.status !== "RUNNING") break;
    await worker.tick();
    current = getJob(db, job.id) ?? current;
  }
  if (current.status !== "COMPLETED") {
    throw failFast(`createFromVoiceover: render job ${current.status}${current.error ? ` — ${current.error}` : ""}.`);
  }
  const result = (current.result ?? {}) as { artifactId?: unknown; artifact?: unknown };
  // The creative brief is whatever narration directed the story: the resolved
  // transcript, or the segment texts when no transcript was given.
  const brief = transcript.trim()
    ? transcript
    : (Array.isArray(input.segments) ? input.segments : [])
        .map((segment) => (typeof segment.text === "string" ? segment.text : ""))
        .filter((text) => text.trim().length > 0)
        .join(". ");
  return {
    asset,
    story,
    ops: planned.ops,
    transcript,
    brief,
    validation: planned.validation,
    rev: revision.rev,
    revisionId: revision.id,
    fileRevision: live.revision,
    jobId: job.id,
    artifactId: typeof result.artifactId === "string" ? result.artifactId : null,
    artifact: typeof result.artifact === "string" ? result.artifact : null,
    durationMs: story.durationMs,
    orientation
  };
}
