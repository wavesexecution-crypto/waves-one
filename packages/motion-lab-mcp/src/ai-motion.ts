/**
 * AI motion generation service — the single backend shared by the Motion Lab
 * UI (dev-server routes) and the agent tool layer (MCP tools).
 *
 * Flow: source image asset -> GenerationJob row (motion_generations) ->
 * MotionProvider (NVIDIA Cosmos3-Nano, or mock) -> MP4 bytes decoded
 * server-side -> stored under public/ai-motion -> artifact row -> video URL
 * back to the browser. Base64 video never crosses the browser boundary;
 * NVIDIA credentials never leave the server process.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  COSMOS_INPUT_BYTES_MAX,
  COSMOS_MODEL_ID,
  COSMOS_PROVIDER_ID,
  CosmosError,
  NvidiaCosmosProvider,
  isMp4Bytes,
  selectedMotionProviderId,
  validateCosmosSettings,
  type CosmosFetch,
  type CosmosSettings,
  type MotionContext,
  type MotionGenerationRequest,
  type MotionMode,
  type MotionProvider,
  type MotionProviderResult
} from "./cosmos.js";
import { getAsset, recordArtifact, registerAsset } from "./assets.js";
import { closeDb, openDb } from "./db.js";
import type { StorePaths } from "./store.js";

export type AiMotionStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface GenerationJob {
  id: string;
  projectId: string;
  provider: string;
  model: string;
  mode: MotionMode;
  prompt: string;
  negativePrompt: string | null;
  settings: Record<string, unknown>;
  sourceAssetId: string | null;
  outputPath: string | null;
  videoUrl: string | null;
  status: AiMotionStatus;
  errorCode: string | null;
  error: string | null;
  seed: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  durationMs: number | null;
  bytes: number | null;
  artifactId: string | null;
  selected: boolean;
  mock: boolean;
  createdAt: number;
  completedAt: number | null;
}

export interface SourceAsset {
  sourceId: string;
  url: string;
  fileName: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface GenerateInput {
  mode: MotionMode;
  prompt: string;
  negativePrompt?: string;
  settings?: CosmosSettings;
  /** Asset id from the upload step (required for image2video). */
  sourceId?: string;
  projectId?: string;
}

export interface GenerationResult {
  provider: string;
  model: string;
  generationId: string;
  status: AiMotionStatus;
  outputAssetId: string | null;
  videoUrl: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  durationMs: number | null;
  bytes: number | null;
  seed: number | null;
  mock: boolean;
  errorCode: string | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

/** Idempotent schema hook — runs on every service call, safe on old DBs. */
export function ensureAiMotionSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS motion_generations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      negative_prompt TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      source_asset_id TEXT,
      output_path TEXT,
      video_url TEXT,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      error_code TEXT,
      error TEXT,
      seed INTEGER,
      width INTEGER,
      height INTEGER,
      fps REAL,
      frames INTEGER,
      duration_ms INTEGER,
      bytes INTEGER,
      artifact_id TEXT,
      selected INTEGER NOT NULL DEFAULT 0,
      mock INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_motion_generations_project ON motion_generations(project_id, created_at)`);
}

function parseSettings(value: unknown): Record<string, unknown> {
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

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toJob(raw: Record<string, unknown>): GenerationJob {
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    provider: String(raw.provider),
    model: String(raw.model),
    mode: String(raw.mode) as MotionMode,
    prompt: String(raw.prompt ?? ""),
    negativePrompt: raw.negative_prompt === null || raw.negative_prompt === undefined ? null : String(raw.negative_prompt),
    settings: parseSettings(raw.settings_json),
    sourceAssetId: raw.source_asset_id === null || raw.source_asset_id === undefined ? null : String(raw.source_asset_id),
    outputPath: raw.output_path === null || raw.output_path === undefined ? null : String(raw.output_path),
    videoUrl: raw.video_url === null || raw.video_url === undefined ? null : String(raw.video_url),
    status: String(raw.status ?? "QUEUED") as AiMotionStatus,
    errorCode: raw.error_code === null || raw.error_code === undefined ? null : String(raw.error_code),
    error: raw.error === null || raw.error === undefined ? null : String(raw.error),
    seed: numOrNull(raw.seed),
    width: numOrNull(raw.width),
    height: numOrNull(raw.height),
    fps: numOrNull(raw.fps),
    frames: numOrNull(raw.frames),
    durationMs: numOrNull(raw.duration_ms),
    bytes: numOrNull(raw.bytes),
    artifactId: raw.artifact_id === null || raw.artifact_id === undefined ? null : String(raw.artifact_id),
    selected: Number(raw.selected ?? 0) === 1,
    mock: Number(raw.mock ?? 0) === 1,
    createdAt: Number(raw.created_at ?? Date.now()),
    completedAt: raw.completed_at === null || raw.completed_at === undefined ? null : Number(raw.completed_at)
  };
}

function toResult(job: GenerationJob): GenerationResult {
  return {
    provider: job.provider,
    model: job.model,
    generationId: job.id,
    status: job.status,
    outputAssetId: job.artifactId,
    videoUrl: job.videoUrl,
    width: job.width,
    height: job.height,
    fps: job.fps,
    frames: job.frames,
    durationMs: job.durationMs,
    bytes: job.bytes,
    seed: job.seed,
    mock: job.mock,
    errorCode: job.errorCode,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt
  };
}

export function aiMotionDirs(labDir: string): { publicDir: string; sourcesDir: string; exportsDir: string } {
  const publicDir = join(labDir, "public", "ai-motion");
  return { publicDir, sourcesDir: join(publicDir, "sources"), exportsDir: join(labDir, "public", "exports") };
}

/** Minimal image sniffing: mime + dimensions for PNG/JPEG/GIF. WebP: mime only. */
export function sniffImage(bytes: Buffer): { mime: string; ext: string; width: number | null; height: number | null } {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = bytes.length >= 24 ? bytes.readUInt32BE(16) : null;
    const height = bytes.length >= 24 ? bytes.readUInt32BE(20) : null;
    return { mime: "image/png", ext: "png", width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const size = bytes.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { mime: "image/jpeg", ext: "jpg", width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      if (size < 2) break;
      offset += 2 + size;
    }
    return { mime: "image/jpeg", ext: "jpg", width: null, height: null };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { mime: "image/gif", ext: "gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp", width: null, height: null };
  }
  throw new CosmosError("invalid_input", "Source must be a PNG, JPEG, GIF, or WebP image.");
}

function parseSourceDataUrl(dataUrl: string): { bytes: Buffer; claimedMime: string; family: "image" | "video" } {
  const match = /^data:((?:image|video)\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!match) throw new CosmosError("invalid_input", "Source must be a base64 media data URL (data:image/... or data:video/mp4;base64,...).");
  const claimedMime = match[1].toLowerCase();
  const family = claimedMime.startsWith("video/") ? "video" : "image";
  if (family === "image" && !["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"].includes(claimedMime)) {
    throw new CosmosError("invalid_input", `Unsupported source image type "${claimedMime}". Use PNG, JPEG, WebP, or GIF.`);
  }
  if (family === "video" && claimedMime !== "video/mp4") {
    throw new CosmosError("invalid_input", `Unsupported source video type "${claimedMime}". Use MP4.`);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  } catch {
    throw new CosmosError("invalid_input", "Source media is not valid base64.");
  }
  if (bytes.length === 0) throw new CosmosError("invalid_input", "Source media is empty.");
  if (bytes.length > COSMOS_INPUT_BYTES_MAX) {
    throw new CosmosError("invalid_input", `Source media is ${(bytes.length / 1_000_000).toFixed(1)} MB; the transport guardrail is 25 MB.`);
  }
  return { bytes, claimedMime, family };
}

/**
 * Store an uploaded source (image or MP4 video) and register it in the
 * existing assets registry (kinds "image"/"video"). Returns the source
 * handle the UI/MCP passes back as `sourceId` on generate.
 */
export function saveSourceMedia(
  db: DatabaseSync,
  labDir: string,
  projectId: string,
  input: { name: string; dataUrl: string; label?: string }
): SourceAsset {
  ensureAiMotionSchema(db);
  const safeName = (input.name || "source").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) || "source";
  const { bytes, family } = parseSourceDataUrl(input.dataUrl);
  let mime: string;
  let ext: string;
  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  if (family === "video") {
    if (!isMp4Bytes(bytes)) throw new CosmosError("invalid_input", "Source file is not an MP4 container.");
    mime = "video/mp4";
    ext = "mp4";
  } else {
    const sniffed = sniffImage(bytes);
    mime = sniffed.mime;
    ext = sniffed.ext;
    width = sniffed.width;
    height = sniffed.height;
  }
  const { sourcesDir } = aiMotionDirs(labDir);
  mkdirSync(sourcesDir, { recursive: true });
  const sourceId = `aisrc-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const fileName = `${sourceId}.${ext}`;
  const absolute = join(sourcesDir, fileName);
  writeFileSync(absolute, bytes);
  if (family === "video") {
    const probed = probeVideo(absolute);
    width = probed.width;
    height = probed.height;
    durationMs = probed.durationMs;
  }
  const relPath = `public/ai-motion/sources/${fileName}`;
  const asset = registerAsset(db, projectId, {
    kind: family === "video" ? "video" : "image",
    label: (input.label ?? safeName).slice(0, 120),
    path: relPath,
    meta: { sourceId, mime, width, height, ...(durationMs !== null ? { durationMs } : {}), origin: "ai-motion-upload" }
  });
  return {
    sourceId: asset.id,
    url: `/ai-motion/sources/${fileName}`,
    fileName: safeName,
    mime,
    bytes: bytes.length,
    width,
    height
  };
}

/** Back-compat alias (image-only callers). */
export const saveSourceImage = saveSourceMedia;

function loadSourceBytes(db: DatabaseSync, labDir: string, sourceId: string): { bytes: Buffer; mime: string } {
  const asset = getAsset(db, sourceId);
  if (!asset || !asset.path) throw new CosmosError("invalid_input", `Unknown source "${sourceId}". Upload the image first.`);
  const resolved = join(labDir, asset.path.replace(/\//g, "/"));
  const flatResolved = resolved.replace(/\\/g, "/");
  const flatLab = labDir.replace(/\\/g, "/");
  if (flatResolved !== flatLab && !flatResolved.startsWith(`${flatLab}/`)) {
    throw new CosmosError("invalid_input", `Source "${sourceId}" escapes the lab directory.`);
  }
  if (!existsSync(resolved)) throw new CosmosError("invalid_input", "Source image file is gone. Upload it again.");
  const bytes = readFileSync(resolved);
  const meta = asset.meta as Record<string, unknown>;
  const mime = typeof meta.mime === "string" ? meta.mime : "image/png";
  return { bytes, mime };
}

/** Mock provider: locally synthesized, genuinely playable MP4, labeled mock. */
export class MockMotionProvider implements MotionProvider {
  readonly id = "mock";
  readonly models = ["mock-cosmos"];
  status(_env?: Record<string, string | undefined>): { provider: string; model: string; displayName: string; configured: boolean; detail: string; endpointHost: string; modes: MotionMode[] } {
    return {
      provider: "mock",
      model: "mock-cosmos",
      displayName: "Mock (local synthesis)",
      configured: true,
      detail: "Ready — no NVIDIA calls; output is a locally synthesized stand-in",
      endpointHost: "localhost",
      modes: ["image2video", "text2video", "video2video"]
    };
  }
  async generate(request: MotionGenerationRequest, ctx: MotionContext = {}): Promise<MotionProviderResult> {
    const settings = validateCosmosSettings(request.settings);
    if (request.mode !== "text2video" && request.mode !== "image2video" && request.mode !== "video2video") {
      throw new CosmosError("unsupported_mode", `Mock provider supports all three modes, not "${String((request as { mode?: unknown }).mode)}".`);
    }
    if ((request.mode === "image2video" || request.mode === "video2video") && (!request.inputBytes || request.inputBytes.length === 0)) {
      throw new CosmosError("invalid_input", `${request.mode} needs a source ${request.mode === "image2video" ? "image" : "video"}.`);
    }
    if ((request.prompt ?? "").trim().length > 20000) throw new CosmosError("invalid_input", "Prompt exceeds the 20000-character limit.");
    const outPath = (ctx as { mockOutPath?: string }).mockOutPath;
    if (!outPath) throw new Error("MockMotionProvider needs ctx.mockOutPath.");
    // Cap mock renders at ~6s so local iteration stays fast; meta records it.
    const mockSeconds = Math.min(6, Math.max(2, settings.durationMs / 1000));
    const fpsInt = Math.max(1, Math.round(settings.fps));
    const runFfmpeg = (args: string[]): void => {
      try {
        execFileSync("ffmpeg", ["-y", "-v", "error", ...args, outPath], { timeout: 120_000 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CosmosError("server_error", `Mock render failed (needs a local ffmpeg): ${message.slice(0, 200)}`, message.slice(0, 300));
      }
    };
    if (request.mode === "image2video" && request.inputBytes) {
      const srcTmp = join(dirname(outPath), `.mock-src-${Date.now().toString(36)}.png`);
      writeFileSync(srcTmp, request.inputBytes);
      try {
        runFfmpeg([
          "-loop", "1", "-i", srcTmp,
          "-vf", `scale=${settings.width}:${settings.height},zoompan=z='1+0.06*on/${Math.round(fpsInt * mockSeconds)}':d=${Math.round(fpsInt * mockSeconds)}:s=${settings.width}x${settings.height}:fps=${fpsInt}`,
          "-t", String(mockSeconds),
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"
        ]);
      } finally {
        try {
          rmSync(srcTmp, { force: true });
        } catch {
          /* temp cleanup is best-effort */
        }
      }
    } else if (request.mode === "video2video" && request.inputBytes) {
      const srcTmp = join(dirname(outPath), `.mock-src-${Date.now().toString(36)}.mp4`);
      writeFileSync(srcTmp, request.inputBytes);
      try {
        runFfmpeg([
          "-i", srcTmp,
          "-vf", `scale=${settings.width}:${settings.height},zoompan=z='min(1.1,1+0.01*on)':d=1:s=${settings.width}x${settings.height}:fps=${fpsInt}`,
          "-t", String(mockSeconds),
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"
        ]);
      } finally {
        try {
          rmSync(srcTmp, { force: true });
        } catch {
          /* temp cleanup is best-effort */
        }
      }
    } else {
      runFfmpeg([
        "-f", "lavfi", "-i", `testsrc2=size=${settings.width}x${settings.height}:rate=${fpsInt}:duration=${mockSeconds}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"
      ]);
    }
    const videoBytes = readFileSync(outPath);
    if (!isMp4Bytes(videoBytes)) throw new CosmosError("invalid_video", "Mock render did not produce an MP4.");
    return {
      provider: "mock",
      model: "mock-cosmos",
      videoBytes,
      contentType: "video/mp4",
      byteLength: videoBytes.length,
      seed: settings.seed,
      upsampledPrompt: null,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      frames: Math.round(settings.fps * mockSeconds),
      durationMs: Math.round(mockSeconds * 1000)
    };
  }
}

function resolveProvider(id: string): MotionProvider {
  if (id === "mock") return new MockMotionProvider();
  if (id === COSMOS_PROVIDER_ID) return new NvidiaCosmosProvider();
  throw new CosmosError("invalid_input", `Unknown motion provider "${id}". Use "cosmos" or "mock".`);
}

export function createGeneration(db: DatabaseSync, input: GenerateInput & { providerId: string }): GenerationJob {
  ensureAiMotionSchema(db);
  const projectId = input.projectId?.trim() || "project_default";
  if (input.mode !== "text2video" && input.mode !== "image2video" && input.mode !== "video2video") {
    throw new CosmosError("unsupported_mode", `Unsupported mode "${String(input.mode)}". Use "text2video", "image2video", or "video2video".`);
  }
  const prompt = (input.prompt ?? "").trim();
  if (input.mode === "text2video" && !prompt) throw new CosmosError("invalid_input", "Text-to-video needs a nonempty prompt.");
  if (prompt.length > 20000) throw new CosmosError("invalid_input", `Prompt exceeds the 20000-character limit (${prompt.length}).`);
  if (input.negativePrompt !== undefined && input.negativePrompt.length > 20000) {
    throw new CosmosError("invalid_input", "Negative prompt exceeds the 20000-character limit.");
  }
  // Early settings validation so typos fail before QUEUED.
  const normalized = validateCosmosSettings(input.settings ?? {});
  const providerId = input.providerId === "mock" ? "mock" : COSMOS_PROVIDER_ID;
  const model = providerId === "mock" ? "mock-cosmos" : COSMOS_MODEL_ID;
  if (input.mode === "image2video" || input.mode === "video2video") {
    const need = input.mode === "image2video" ? "a source image" : "a source video";
    if (!input.sourceId) throw new CosmosError("invalid_input", `${input.mode} needs ${need} (upload first, then pass sourceId).`);
    const asset = getAsset(db, input.sourceId);
    if (!asset) throw new CosmosError("invalid_input", `Unknown source "${input.sourceId}". Upload ${need} first.`);
  }
  const id = `aimo-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO motion_generations
      (id, project_id, provider, model, mode, prompt, negative_prompt, settings_json, source_asset_id, status, seed, width, height, fps, frames, duration_ms, mock, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    projectId,
    providerId,
    model,
    input.mode,
    prompt,
    input.negativePrompt ?? null,
    JSON.stringify({ ...input.settings, resolution: normalized.resolution, seed: normalized.seed }),
    input.sourceId ?? null,
    normalized.seed,
    normalized.width,
    normalized.height,
    normalized.fps,
    normalized.numFrames,
    normalized.durationMs,
    providerId === "mock" ? 1 : 0,
    now
  );
  const row = getGeneration(db, id);
  if (!row) throw new Error("createGeneration: row vanished after insert.");
  return row;
}

export function getGeneration(db: DatabaseSync, id: string): GenerationJob | null {
  ensureAiMotionSchema(db);
  const raw = db.prepare("SELECT * FROM motion_generations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return raw ? toJob(raw) : null;
}

export function listGenerations(db: DatabaseSync, projectId = "project_default", limit = 50): GenerationJob[] {
  ensureAiMotionSchema(db);
  const rows = db
    .prepare("SELECT * FROM motion_generations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(projectId, Math.max(1, Math.min(200, Math.round(limit)))) as Array<Record<string, unknown>>;
  return rows.map(toJob);
}

export function deleteGeneration(db: DatabaseSync, labDir: string, id: string): boolean {
  const job = getGeneration(db, id);
  if (!job) return false;
  if (job.outputPath) {
    const resolved = join(labDir, job.outputPath);
    // Normalize separators: on Windows join() yields backslashes while
    // labDir may carry forward slashes — compare flat or containment fails.
    const flatResolved = resolved.replace(/\\/g, "/");
    const flatLab = labDir.replace(/\\/g, "/");
    if (flatResolved === flatLab || flatResolved.startsWith(`${flatLab}/`)) {
      try {
        rmSync(resolved, { force: true });
      } catch {
        /* file cleanup is best-effort */
      }
    }
  }
  // Generation artifacts link via meta.generationId (artifact job_id is
  // reserved for the durable jobs queue, which generations don't enter).
  db.prepare("DELETE FROM artifacts WHERE json_extract(meta, '$.generationId') = ?").run(id);
  db.prepare("DELETE FROM motion_generations WHERE id = ?").run(id);
  return true;
}

/** Probe video metadata with ffprobe. Nulls when ffprobe is unavailable. */
export function probeVideo(filePath: string): { width: number | null; height: number | null; fps: number | null; durationMs: number | null; frames: number | null } {
  const empty = { width: null, height: null, fps: null, durationMs: null, frames: null };
  try {
    const raw = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,duration", "-of", "json", filePath],
      { timeout: 30_000, encoding: "utf8" }
    ) as string;
    const stream = (JSON.parse(raw) as { streams?: Array<{ width?: unknown; height?: unknown; avg_frame_rate?: unknown; duration?: unknown }> }).streams?.[0];
    if (!stream) return empty;
    const width = Number(stream.width);
    const height = Number(stream.height);
    const fpsParts = String(stream.avg_frame_rate ?? "0/1").split("/");
    const fps = fpsParts.length === 2 && Number(fpsParts[1]) !== 0 ? Number(fpsParts[0]) / Number(fpsParts[1]) : Number(fpsParts[0]);
    const durationMs = Number(stream.duration) > 0 ? Math.round(Number(stream.duration) * 1000) : null;
    return {
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : null,
      durationMs,
      frames: durationMs !== null && fps > 0 ? Math.round((durationMs / 1000) * fps) : null
    };
  } catch {
    return empty;
  }
}

export interface ImportRenderInput {
  /** Absolute or lab-relative path to an existing MP4. */
  filePath: string;
  prompt: string;
  negativePrompt?: string;
  mode?: MotionMode;
  /** Display name for the file, e.g. "waves-letters-burst". */
  label?: string;
  projectId?: string;
}

/**
 * Ingest an externally rendered MP4 (engine export, hand edit, …) as a
 * COMPLETED generation so it lives in history, the viewer, and artifacts
 * exactly like a provider run. Provider is recorded honestly as motion-lab.
 */
export function importCompletedRender(db: DatabaseSync, labDir: string, input: ImportRenderInput): GenerationJob {
  ensureAiMotionSchema(db);
  const projectId = input.projectId?.trim() || "project_default";
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) throw new CosmosError("invalid_input", "importCompletedRender needs a prompt describing the piece.");
  const mode = input.mode === "text2video" ? "text2video" : "image2video";
  const normalized = input.filePath.replace(/\\/g, "/");
  const flatLab = labDir.replace(/\\/g, "/");
  const root = join(labDir, "..", "..");
  const candidates = normalized.startsWith(flatLab) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")
    ? [normalized]
    : [join(labDir, normalized), join(root, normalized)];
  const absolute = candidates.find((candidate) => existsSync(candidate));
  if (!absolute) throw new CosmosError("invalid_input", `Render file not found: ${input.filePath}.`);
  if (!/\.mp4$/i.test(absolute)) throw new CosmosError("invalid_input", "Only MP4 renders can be imported.");
  const bytes = statSync(absolute).size;
  if (bytes === 0) throw new CosmosError("invalid_input", "Render file is empty.");
  const head = readFileSync(absolute).subarray(0, 12);
  if (!(head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70)) {
    throw new CosmosError("invalid_video", "File is not an MP4 container.");
  }
  const id = `aimo-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const { publicDir } = aiMotionDirs(labDir);
  mkdirSync(publicDir, { recursive: true });
  copyFileSync(absolute, join(publicDir, `${id}.mp4`));
  const relPath = `public/ai-motion/${id}.mp4`;
  const meta = probeVideo(join(publicDir, `${id}.mp4`));
  const artifact = recordArtifact(db, {
    projectId,
    kind: "ai-motion-video",
    path: relPath,
    meta: { generationId: id, provider: "motion-lab", model: "@waves/motion", mode, prompt: prompt.slice(0, 500), engine: true }
  });
  const now = Date.now();
  db.prepare(
    `INSERT INTO motion_generations
      (id, project_id, provider, model, mode, prompt, negative_prompt, settings_json, output_path, video_url, status,
       seed, width, height, fps, frames, duration_ms, bytes, artifact_id, mock, created_at, completed_at)
     VALUES (?, ?, 'motion-lab', '@waves/motion', ?, ?, ?, '{}', ?, ?, 'COMPLETED', NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    projectId,
    mode,
    prompt,
    input.negativePrompt ?? null,
    relPath,
    `/ai-motion/${id}.mp4`,
    meta.width,
    meta.height,
    meta.fps,
    meta.frames,
    meta.durationMs,
    bytes,
    artifact.id,
    now,
    now
  );
  const row = getGeneration(db, id);
  if (!row) throw new Error("importCompletedRender: row vanished after insert.");
  return row;
}

export function markSelected(db: DatabaseSync, id: string): GenerationJob {
  const job = getGeneration(db, id);
  if (!job) throw new CosmosError("invalid_input", `Unknown generation "${id}".`);
  if (job.status !== "COMPLETED") throw new CosmosError("invalid_input", "Only completed generations can be marked for use.");
  db.prepare("UPDATE motion_generations SET selected = 0 WHERE project_id = ?").run(job.projectId);
  db.prepare("UPDATE motion_generations SET selected = 1 WHERE id = ?").run(id);
  const next = getGeneration(db, id);
  if (!next) throw new Error("markSelected: row vanished after update.");
  return next;
}

/** Copy the output into public/exports and index it as a saved Lab artifact. */
export function saveGenerationToLab(db: DatabaseSync, labDir: string, id: string): GenerationJob {
  const job = getGeneration(db, id);
  if (!job) throw new CosmosError("invalid_input", `Unknown generation "${id}".`);
  if (job.status !== "COMPLETED" || !job.outputPath) throw new CosmosError("invalid_input", "Only completed generations with video output can be saved.");
  const { exportsDir } = aiMotionDirs(labDir);
  mkdirSync(exportsDir, { recursive: true });
  const fileName = `${job.id}.mp4`;
  copyFileSync(join(labDir, job.outputPath), join(exportsDir, fileName));
  const artifact = recordArtifact(db, {
    projectId: job.projectId,
    kind: "ai-motion-saved",
    path: `public/exports/${fileName}`,
    meta: { generationId: job.id, provider: job.provider, model: job.model, mode: job.mode, prompt: job.prompt.slice(0, 500), seed: job.seed, width: job.width, height: job.height }
  });
  db.prepare("UPDATE motion_generations SET artifact_id = ? WHERE id = ?").run(artifact.id, id);
  const next = getGeneration(db, id);
  if (!next) throw new Error("saveGenerationToLab: row vanished after update.");
  return next;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  transport?: CosmosFetch;
  timeoutMs?: number;
  /** Test seam: bypass env selection with a stub provider. */
  provider?: MotionProvider;
}

/**
 * Run a QUEUED generation to terminal state. Synchronous and long-lived
 * (minutes on the trial endpoint) — callers expose it behind their own
 * timeout/job polling. Detailed failures go to server logs; the row keeps a
 * user-safe message only. Never throws for generation failures (row carries
 * them); throws only when the job row itself is unusable.
 */
export async function runGeneration(db: DatabaseSync, labDir: string, jobId: string, options: RunOptions = {}): Promise<GenerationResult> {
  ensureAiMotionSchema(db);
  const job = getGeneration(db, jobId);
  if (!job) throw new CosmosError("invalid_input", `Unknown generation "${jobId}".`);
  if (job.status !== "QUEUED") {
    if (job.status === "COMPLETED" || job.status === "FAILED") return toResult(job);
    throw new CosmosError("invalid_input", `Generation "${jobId}" is already ${job.status}.`);
  }
  const env = options.env ?? process.env;
  const provider = options.provider ?? resolveProvider(job.mock ? "mock" : selectedMotionProviderId(env));
  db.prepare("UPDATE motion_generations SET status = 'RUNNING' WHERE id = ?").run(jobId);

  const fail = (code: string, userMessage: string, logDetail: string): GenerationResult => {
    // Server logs keep the detail; the row keeps the safe message.
    console.error(`[ai-motion] generation ${jobId} failed (${code}): ${logDetail}`.slice(0, 1000));
    db.prepare("UPDATE motion_generations SET status = 'FAILED', error_code = ?, error = ?, completed_at = ? WHERE id = ?").run(
      code,
      userMessage,
      Date.now(),
      jobId
    );
    const failed = getGeneration(db, jobId);
    if (!failed) throw new Error("runGeneration: row vanished after failure update.");
    return toResult(failed);
  };

  try {
    const settings = validateCosmosSettings(job.settings as CosmosSettings);
    let inputBytes: Buffer | undefined;
    let inputMime: string | undefined;
    if (job.mode === "image2video" || job.mode === "video2video") {
      const need = job.mode === "image2video" ? "a source image" : "a source video";
      if (!job.sourceAssetId) return fail("invalid_input", `${job.mode} needs ${need}.`, "missing source_asset_id");
      try {
        const loaded = loadSourceBytes(db, labDir, job.sourceAssetId);
        inputBytes = loaded.bytes;
        inputMime = loaded.mime;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(error instanceof CosmosError ? error.code : "invalid_input", message, message.slice(0, 300));
      }
    }
    const motionRequest: MotionGenerationRequest = {
      provider: provider.id === "mock" ? "mock" : COSMOS_PROVIDER_ID,
      model: provider.id === "mock" ? "mock-cosmos" : COSMOS_MODEL_ID,
      mode: job.mode,
      prompt: job.prompt,
      ...(job.negativePrompt !== null ? { negativePrompt: job.negativePrompt } : {}),
      ...(inputBytes ? { inputBytes, inputMime } : {}),
      settings: job.settings as CosmosSettings
    };
    const { publicDir } = aiMotionDirs(labDir);
    mkdirSync(publicDir, { recursive: true });
    const outPath = join(publicDir, `${jobId}.mp4`);
    const result: MotionProviderResult = await provider.generate(motionRequest, {
      env,
      transport: options.transport,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(provider.id === "mock" ? { mockOutPath: outPath } : {})
    });
    if (provider.id !== "mock") {
      writeFileSync(outPath, result.videoBytes);
    }
    const stats = statSync(outPath);
    const relPath = `public/ai-motion/${jobId}.mp4`;
    const artifact = recordArtifact(db, {
      projectId: job.projectId,
      kind: "ai-motion-video",
      path: relPath,
      meta: {
        generationId: jobId,
        provider: result.provider,
        model: result.model,
        mode: job.mode,
        prompt: job.prompt.slice(0, 500),
        seed: result.seed,
        width: result.width,
        height: result.height,
        fps: result.fps,
        frames: result.frames,
        mock: provider.id === "mock"
      }
    });
    db.prepare(
      `UPDATE motion_generations SET status = 'COMPLETED', output_path = ?, video_url = ?, error_code = NULL, error = NULL,
        seed = ?, width = ?, height = ?, fps = ?, frames = ?, duration_ms = ?, bytes = ?, artifact_id = ?, mock = ?, completed_at = ? WHERE id = ?`
    ).run(
      relPath,
      `/ai-motion/${jobId}.mp4`,
      result.seed,
      result.width,
      result.height,
      result.fps,
      result.frames,
      result.durationMs,
      stats.size,
      artifact.id,
      provider.id === "mock" ? 1 : 0,
      Date.now(),
      jobId
    );
    const done = getGeneration(db, jobId);
    if (!done) throw new Error("runGeneration: row vanished after completion update.");
    return toResult(done);
  } catch (error) {
    if (error instanceof CosmosError) return fail(error.code, error.message, error.detail || error.message);
    const message = error instanceof Error ? error.message : String(error);
    return fail("server_error", `Generation failed: ${message.slice(0, 200)}`, message.slice(0, 500));
  }
}

/** One-shot convenience: create + run. Used by MCP tools and HTTP routes. */
export async function generateAndWait(
  labDir: string,
  input: GenerateInput,
  options: RunOptions & { db?: DatabaseSync } = {}
): Promise<GenerationResult> {
  const projectId = input.projectId?.trim() || "project_default";
  if (options.db) {
    const job = createGeneration(options.db, { ...input, providerId: inputProjectProvider(options) });
    return runGeneration(options.db, labDir, job.id, options);
  }
  const db = await openDb(labDir);
  try {
    const job = createGeneration(db.raw, { ...input, providerId: inputProjectProvider(options) });
    // Await INSIDE the try: returning the bare promise would run finally
    // (and close the DB) while the generation is still in flight.
    const result = await runGeneration(db.raw, labDir, job.id, options);
    return result;
  } finally {
    closeDb(db);
  }
}

function inputProjectProvider(options: RunOptions): string {
  if (options.provider) return options.provider.id;
  const env = options.env ?? process.env;
  try {
    return selectedMotionProviderId(env);
  } catch {
    return COSMOS_PROVIDER_ID;
  }
}

/** Public status snapshot for the model selector. No secret values. */
export function motionProviderStatus(env: Record<string, string | undefined> = process.env): {
  selected: string;
  providers: Array<{ provider: string; model: string; displayName: string; configured: boolean; detail: string; endpointHost: string; modes: MotionMode[] }>;
} {
  let selected = COSMOS_PROVIDER_ID;
  try {
    selected = selectedMotionProviderId(env);
  } catch {
    selected = COSMOS_PROVIDER_ID;
  }
  const cosmos = new NvidiaCosmosProvider().status(env);
  const mock = new MockMotionProvider().status(env);
  return { selected, providers: [cosmos, mock] };
}

/** Resolve StorePaths-adjacent lab dir helper for HTTP/MCP callers. */
export function labDirFromPaths(paths: StorePaths): string {
  return paths.labDir;
}
