/**
 * AI Motion workspace types — browser-side mirrors of the server records.
 * No credentials, no base64 video: the browser only handles metadata + URLs.
 */

export type MotionMode = "image2video" | "text2video" | "video2video";

export type GenerationPhase =
  | "idle"
  | "preparing"
  | "uploading"
  | "generating"
  | "processing"
  | "complete"
  | "failed";

/** Registry-verified hosted fields: resolution, num_frames, num_inference_steps, guidance_scale, flow_shift, fps, seed. */
export interface CosmosSettingsInput {
  resolution: string;
  numFrames: number;
  fps: number;
  numInferenceSteps: number;
  guidanceScale: number;
  /** Empty = omitted (server default). */
  flowShift: string;
  /** Empty = omitted (server random). */
  seed: string;
}

export interface ProviderInfo {
  provider: string;
  model: string;
  displayName: string;
  configured: boolean;
  detail: string;
  endpointHost: string;
  modes: MotionMode[];
}

export interface EnhanceInfo {
  provider: string;
  model: string;
  displayName: string;
  configured: boolean;
  detail: string;
  endpointHost: string;
  capabilities: string[];
}

export interface ProviderStatusResponse {
  ok: boolean;
  selected: string;
  providers: ProviderInfo[];
  promptEnhancement?: EnhanceInfo;
}

export interface EnhanceResultBody {
  ok: boolean;
  enhanced: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
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

export interface GenerationRecord {
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
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
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

export interface GenerateResultBody {
  ok: boolean;
  provider: string;
  model: string;
  generationId: string;
  status: GenerationRecord["status"];
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
  outputAssetId?: string | null;
}

export interface PromptHistoryEntry {
  prompt: string;
  negativePrompt: string;
  mode: MotionMode;
  usedAt: number;
}
