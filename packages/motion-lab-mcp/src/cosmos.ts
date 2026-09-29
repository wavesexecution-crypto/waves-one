/**
 * NVIDIA Cosmos3-Nano video provider — hosted API contract implementation.
 *
 * Documented hosted contract (model card):
 *
 *   POST https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano
 *   Authorization: Bearer $NVIDIA_API_KEY
 *
 *   text2video:  { model_mode: "text2video",  prompt, resolution,
 *                  num_frames, num_inference_steps, fps, seed }
 *   image2video: { model_mode: "image2video", input_reference, prompt, ... }
 *   video2video: { model_mode: "video2video", input_reference, prompt, ... }
 *
 *   Response: { b64_video: "<base64 mp4>" }
 *
 * Only these fields are transmitted — nothing invented (unknown fields risk
 * rejection). In particular `negative_prompt` is accepted by the UI and kept
 * in history but NOT sent, because it is not in the documented hosted field
 * list. Auth is server-side only: key in header, never logged/persisted.
 *
 * Single implementation shared by the Motion Lab UI (dev-server routes) and
 * the agent tool layer (MCP tools). Prompt enhancement (vision LLM) lives in
 * nvidia-live.ts and is a SEPARATE capability — never the video model.
 */

export const COSMOS_PROVIDER_ID = "nvidia";
export const COSMOS_MODEL_ID = "nvidia/cosmos3-nano";
export const COSMOS_DISPLAY_NAME = "Cosmos3-Nano";

/** Documented hosted endpoint. Override with NVIDIA_COSMOS_ENDPOINT. */
export const DEFAULT_COSMOS_ENDPOINT = "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano";

export type MotionMode = "text2video" | "image2video" | "video2video";

export type MotionGenerationStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface CosmosSettings {
  /** Resolution key, e.g. "480_16_9". Bare tiers ("256"/"480"/"720") valid. Default "720". */
  resolution?: string;
  /** Output frames: any integer 25..tier-max (256→397, 480→297, 720→197). Default 189. */
  numFrames?: number;
  /** Denoising steps [1, 100]. Default 35. */
  numInferenceSteps?: number;
  /** Guidance scale [1, 7]. Default 6. */
  guidanceScale?: number;
  /** Flow shift. Omitted → server default (10). */
  flowShift?: number;
  /** Output frame rate [1, 60]. Default 24. */
  fps?: number;
  /** Seed >= 0. Empty → omitted (server random). */
  seed?: number;
}

export interface NormalizedCosmosSettings {
  resolution: string;
  numFrames: number;
  numInferenceSteps: number;
  guidanceScale: number;
  flowShift: number | null;
  fps: number;
  /** Concrete seed, or null when the caller left it empty (server random). */
  seed: number | null;
  width: number;
  height: number;
  durationMs: number;
}

export interface MotionGenerationRequest {
  provider: string;
  model: string;
  mode: MotionMode;
  prompt: string;
  negativePrompt?: string;
  /** Conditioning bytes: image for image2video, video for video2video. */
  inputBytes?: Buffer;
  inputMime?: string;
  settings: CosmosSettings;
}

export interface MotionProviderResult {
  provider: string;
  model: string;
  videoBytes: Buffer;
  contentType: "video/mp4";
  byteLength: number;
  seed: number | null;
  upsampledPrompt: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  durationMs: number | null;
}

export interface MotionProviderStatus {
  provider: string;
  model: string;
  displayName: string;
  configured: boolean;
  /** What is missing when not configured. Never includes secret values. */
  detail: string;
  /** Endpoint host only (path kept server-side). */
  endpointHost: string;
  modes: MotionMode[];
}

export interface MotionProvider {
  id: string;
  models: string[];
  status(env?: Record<string, string | undefined>): MotionProviderStatus;
  generate(request: MotionGenerationRequest, ctx?: MotionContext): Promise<MotionProviderResult>;
}

export interface MotionContext {
  env?: Record<string, string | undefined>;
  /** Hard ceiling for the provider HTTP call. Default 600_000 (10 min). */
  timeoutMs?: number;
  transport?: CosmosFetch;
  /** Abort a hung generation from the caller. */
  signal?: AbortSignal;
}

export type CosmosFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/** Machine-readable error codes. `message` is safe to show in the UI. */
export type CosmosErrorCode =
  | "missing_api_key"
  | "unauthorized"
  | "endpoint_not_found"
  | "bad_request"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "malformed_response"
  | "invalid_video"
  | "unsupported_mode"
  | "invalid_input";

export class CosmosError extends Error {
  readonly code: CosmosErrorCode;
  /** Server-log detail. May contain endpoint/status internals — never secrets. */
  readonly detail: string;
  constructor(code: CosmosErrorCode, message: string, detail = "") {
    super(message);
    this.name = "CosmosError";
    this.code = code;
    this.detail = detail;
  }
}

/** Resolution key family from the documented examples (tier + aspect). */
const RESOLUTION_TABLE: Record<string, { w: number; h: number; tier: string }> = {
  "256_16_9": { w: 320, h: 192, tier: "256" },
  "256_1_1": { w: 256, h: 256, tier: "256" },
  "256_9_16": { w: 192, h: 320, tier: "256" },
  "256_4_3": { w: 320, h: 256, tier: "256" },
  "256_3_4": { w: 256, h: 320, tier: "256" },
  "480_16_9": { w: 832, h: 480, tier: "480" },
  "480_1_1": { w: 640, h: 640, tier: "480" },
  "480_9_16": { w: 480, h: 832, tier: "480" },
  "480_4_3": { w: 736, h: 544, tier: "480" },
  "480_3_4": { w: 544, h: 736, tier: "480" },
  "720_16_9": { w: 1280, h: 720, tier: "720" },
  "720_1_1": { w: 960, h: 960, tier: "720" },
  "720_9_16": { w: 720, h: 1280, tier: "720" },
  "720_4_3": { w: 1104, h: 832, tier: "720" },
  "720_3_4": { w: 832, h: 1104, tier: "720" }
};

const TIER_ALIAS: Record<string, string> = { "256": "256_16_9", "480": "480_16_9", "720": "720_16_9" };
/** Tier frame caps from VideoFrameLimits (any integer, no cadence). */
const TIER_FRAME_CAP: Record<string, number> = { "256": 397, "480": 297, "720": 197 };

export const COSMOS_RESOLUTIONS = Object.keys(RESOLUTION_TABLE);
export const COSMOS_DEFAULTS = { resolution: "720", numFrames: 189, numInferenceSteps: 35, guidanceScale: 6, fps: 24 } as const;
export const COSMOS_PROMPT_MAX = 20000;
/** Client-side transport guardrail for conditioning payloads. */
export const COSMOS_INPUT_BYTES_MAX = 25_000_000;

export function resolveResolution(key: string): { key: string; w: number; h: number; tier: string } {
  const trimmed = key.trim();
  const canonical = TIER_ALIAS[trimmed] ?? trimmed;
  const entry = RESOLUTION_TABLE[canonical];
  if (!entry) throw new CosmosError("invalid_input", `Unsupported resolution "${key}". Use one of: ${COSMOS_RESOLUTIONS.join(", ")}.`);
  return { key: canonical, ...entry };
}

export function resolutionDimensions(key: string): { width: number; height: number } {
  const resolved = resolveResolution(key);
  return { width: resolved.w, height: resolved.h };
}

function intIn(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new CosmosError("invalid_input", `${label} must be an integer.`);
  return n;
}

/** Validate user settings against the registry schema; fill documented defaults. */
export function validateCosmosSettings(input: CosmosSettings = {}): NormalizedCosmosSettings {
  const resolved = resolveResolution(input.resolution ?? COSMOS_DEFAULTS.resolution);
  const cap = TIER_FRAME_CAP[resolved.tier];
  const rawFrames = input.numFrames ?? COSMOS_DEFAULTS.numFrames;
  const frames = intIn(rawFrames, "Frame count (num_frames)");
  if (frames < 25 || frames > cap) {
    throw new CosmosError("invalid_input", `Frame count (num_frames) must be within [25, ${cap}] for tier ${resolved.tier}. Got ${frames}.`);
  }
  const fps = typeof input.fps === "number" || typeof input.fps === "string" ? Number(input.fps) : COSMOS_DEFAULTS.fps;
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new CosmosError("invalid_input", `FPS must be within [1, 60]. Got ${String(input.fps)}.`);
  const steps = input.numInferenceSteps ?? COSMOS_DEFAULTS.numInferenceSteps;
  const stepsInt = intIn(steps, "Inference steps (num_inference_steps)");
  if (stepsInt < 1 || stepsInt > 100) throw new CosmosError("invalid_input", `Inference steps (num_inference_steps) must be within [1, 100]. Got ${stepsInt}.`);
  const guidance = typeof input.guidanceScale === "number" || typeof input.guidanceScale === "string" ? Number(input.guidanceScale) : COSMOS_DEFAULTS.guidanceScale;
  if (!Number.isFinite(guidance) || guidance < 1 || guidance > 7) {
    throw new CosmosError("invalid_input", `Guidance scale must be within [1, 7]. Got ${String(input.guidanceScale)}.`);
  }
  let flowShift: number | null = null;
  if (input.flowShift !== undefined && input.flowShift !== null && (input.flowShift as unknown) !== "") {
    const flow = Number(input.flowShift);
    if (!Number.isFinite(flow) || flow <= 0) throw new CosmosError("invalid_input", `Flow shift must be a positive number. Got ${String(input.flowShift)}.`);
    flowShift = flow;
  }
  let seed: number | null;
  if (input.seed === undefined || input.seed === null || (input.seed as unknown) === "") {
    seed = null;
  } else {
    seed = intIn(input.seed, "Seed");
    if (seed < 0 || seed > 4294967295) throw new CosmosError("invalid_input", `Seed must be within [0, 4294967295]. Got ${seed}.`);
  }
  return {
    resolution: resolved.key,
    numFrames: frames,
    numInferenceSteps: stepsInt,
    guidanceScale: guidance,
    flowShift,
    fps,
    seed,
    width: resolved.w,
    height: resolved.h,
    durationMs: Math.round((frames / fps) * 1000)
  };
}

export function validateMotionRequest(request: MotionGenerationRequest): { mode: MotionMode; prompt: string; negativePrompt?: string } {
  if (request.provider !== COSMOS_PROVIDER_ID) throw new CosmosError("invalid_input", `Unknown provider "${request.provider}". This workspace serves "${COSMOS_PROVIDER_ID}".`);
  if (request.model !== COSMOS_MODEL_ID) throw new CosmosError("invalid_input", `Unknown model "${request.model}". This workspace serves "${COSMOS_MODEL_ID}".`);
  if (request.mode !== "text2video" && request.mode !== "image2video" && request.mode !== "video2video") {
    throw new CosmosError("unsupported_mode", `Unsupported mode "${String((request as { mode?: unknown }).mode)}". Use "text2video", "image2video", or "video2video".`);
  }
  const prompt = (request.prompt ?? "").trim();
  // Registry: text2video requires a nonempty prompt; conditioned modes
  // accept null (server auto-captions). Empty here serializes to "".
  if (request.mode === "text2video" && !prompt) throw new CosmosError("invalid_input", "Text-to-video needs a nonempty prompt.");
  if (prompt.length > COSMOS_PROMPT_MAX) throw new CosmosError("invalid_input", `Prompt exceeds the 20000-character limit (${prompt.length}).`);
  const negativePrompt = request.negativePrompt === undefined ? undefined : String(request.negativePrompt);
  if (negativePrompt !== undefined && negativePrompt.length > COSMOS_PROMPT_MAX) {
    throw new CosmosError("invalid_input", `Negative prompt exceeds the 20000-character limit (${negativePrompt.length}).`);
  }
  if (request.mode === "image2video") {
    if (!request.inputBytes || request.inputBytes.length === 0) throw new CosmosError("invalid_input", "Image-to-video needs a source image.");
    if (!String(request.inputMime ?? "").startsWith("image/")) throw new CosmosError("invalid_input", "Image-to-video needs an image source.");
    if (request.inputBytes.length > COSMOS_INPUT_BYTES_MAX) throw new CosmosError("invalid_input", "Source image exceeds the 25 MB transport guardrail.");
  }
  if (request.mode === "video2video") {
    if (!request.inputBytes || request.inputBytes.length === 0) throw new CosmosError("invalid_input", "Video-to-video needs a source video.");
    if (!String(request.inputMime ?? "").startsWith("video/")) throw new CosmosError("invalid_input", "Video-to-video needs a video source.");
    if (request.inputBytes.length > COSMOS_INPUT_BYTES_MAX) throw new CosmosError("invalid_input", "Source video exceeds the 25 MB transport guardrail.");
  }
  return { mode: request.mode, prompt, negativePrompt };
}

/**
 * Build the hosted JSON body, byte-comparable with the working Playground
 * request: {resolution, num_frames, model_mode, prompt, negative_prompt,
 * input_reference?, seed?, guidance_scale?, num_inference_steps?, fps?,
 * flow_shift?}. Only documented fields; additionalProperties is false
 * server-side. negative_prompt "" matches the Playground default.
 */
export function buildCosmosRequestBody(args: {
  mode: MotionMode;
  prompt: string;
  negativePrompt?: string;
  inputDataUri?: string;
  settings: NormalizedCosmosSettings;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model_mode: args.mode,
    prompt: args.prompt,
    negative_prompt: args.negativePrompt ?? "",
    resolution: args.settings.resolution,
    num_frames: args.settings.numFrames,
    num_inference_steps: args.settings.numInferenceSteps,
    guidance_scale: args.settings.guidanceScale,
    fps: args.settings.fps,
    seed: args.settings.seed
  };
  if (args.settings.flowShift !== null) body.flow_shift = args.settings.flowShift;
  if (args.inputDataUri) body.input_reference = args.inputDataUri;
  return body;
}

function inputDataUri(bytes: Buffer, mime: string): string {
  const normalized = mime === "image/jpg" ? "image/jpeg" : mime;
  return `data:${normalized};base64,${bytes.toString("base64")}`;
}

function endpointFor(env: Record<string, string | undefined>): string {
  const override = (env.NVIDIA_COSMOS_ENDPOINT ?? "").trim();
  return override || DEFAULT_COSMOS_ENDPOINT;
}

/**
 * Cosmos API key resolution: a dedicated NVIDIA_COSMOS_API_KEY wins so the
 * video entitlement can live apart from any shared NVIDIA_API_KEY; the
 * shared key is the fallback. Either is server-side only.
 */
export function cosmosApiKey(env: Record<string, string | undefined> = process.env): string {
  return (env.NVIDIA_COSMOS_API_KEY ?? "").trim() || (env.NVIDIA_API_KEY ?? "").trim();
}

export type CosmosAuthMode = "cosmos-key" | "shared-key" | "missing";

export function cosmosAuthMode(env: Record<string, string | undefined> = process.env): CosmosAuthMode {
  if ((env.NVIDIA_COSMOS_API_KEY ?? "").trim()) return "cosmos-key";
  if ((env.NVIDIA_API_KEY ?? "").trim()) return "shared-key";
  return "missing";
}

export interface CosmosConfigDiagnostic {
  /** Full configured endpoint (host + path). Contains no credentials. */
  endpoint: string;
  endpointHost: string;
  authMode: CosmosAuthMode;
  configured: boolean;
  /** Human summary. Never includes secret values. */
  detail: string;
  /** Actionable next step for the current state. */
  action: string;
}

/**
 * COSMOS_STATUS diagnostic: endpoint, auth mode, and what to do next.
 * Safe to surface in UI/MCP responses — no credentials, only key presence.
 */
export function diagnoseCosmosConfig(env: Record<string, string | undefined> = process.env): CosmosConfigDiagnostic {
  const endpoint = endpointFor(env);
  const authMode = cosmosAuthMode(env);
  if (authMode === "missing") {
    return {
      endpoint,
      endpointHost: endpointHost(endpoint),
      authMode,
      configured: false,
      detail: "No Cosmos API key configured.",
      action: "Set NVIDIA_COSMOS_API_KEY (preferred) or NVIDIA_API_KEY in the server environment and restart. Obtain a key at build.nvidia.com (Get API Key); keys start with nvapi-."
    };
  }
  const via = authMode === "cosmos-key" ? "NVIDIA_COSMOS_API_KEY" : "NVIDIA_API_KEY (shared fallback)";
  return {
    endpoint,
    endpointHost: endpointHost(endpoint),
    authMode,
    configured: true,
    detail: `Ready to call ${endpointHost(endpoint)} via ${via}.`,
    action: "If generation 404s: the route is not published for this key — check entitlement/credits or override NVIDIA_COSMOS_ENDPOINT. If 401/402: key invalid, unentitled, or credits exhausted — regenerate the key with the Public API Endpoints role. If 422: the server rejected the body — see the error detail."
  };
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "ai.api.nvidia.com";
  }
}

/** Map HTTP failure to a user-safe error. Body detail stays server-side. */
async function throwForStatus(status: number, readText: () => Promise<string>, endpoint: string): Promise<never> {
  let snippet = "";
  try {
    snippet = (await readText()).slice(0, 500);
  } catch {
    snippet = "";
  }
  const ep = endpointHost(endpoint);
  if (status === 401 || status === 403) {
    throw new CosmosError("unauthorized", "NVIDIA rejected the API key (HTTP 401/403). Check NVIDIA_API_KEY and its Cosmos entitlement.", `HTTP ${status} from ${ep}: ${snippet}`);
  }
  if (status === 404) {
    throw new CosmosError(
      "endpoint_not_found",
      "The Cosmos endpoint returned HTTP 404 with a gateway 'page not found' body (no JSON, no route). Capture the Playground's working request (browser devtools → Network → copy as cURL) and set NVIDIA_COSMOS_ENDPOINT to that exact URL.",
      `HTTP 404 from ${endpoint}: ${snippet}`
    );
  }
  if (status === 422) {
    throw new CosmosError("bad_request", `Cosmos rejected the request parameters (HTTP 422).${snippet ? ` Detail: ${snippet}` : ""}`, `HTTP 422: ${snippet}`);
  }
  if (status === 429) {
    throw new CosmosError("rate_limited", "NVIDIA rate limit hit (HTTP 429). Wait and retry.", `HTTP 429: ${snippet}`);
  }
  if (status >= 500) {
    throw new CosmosError("server_error", `NVIDIA generation failed server-side (HTTP ${status}). Retry.`, `HTTP ${status}: ${snippet}`);
  }
  throw new CosmosError("bad_request", `Cosmos request failed (HTTP ${status}).${snippet ? ` Detail: ${snippet}` : ""}`, `HTTP ${status}: ${snippet}`);
}

/** MP4 sniff: `ftyp` box at offset 4. Rejects HTML error pages saved as video. */
export function isMp4Bytes(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

/** Validate + decode the hosted response. Never forwards giant payloads onward. */
export function parseCosmosResponse(payload: unknown): { videoBytes: Buffer; seed: number | null; upsampledPrompt: string | null } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CosmosError("malformed_response", "Cosmos returned an unparseable response. Retry the generation.", "top-level JSON is not an object");
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.error === "string" && body.error) {
    throw new CosmosError("server_error", `Cosmos reported an error: ${body.error.slice(0, 300)}`, `error field: ${String(body.error).slice(0, 500)}`);
  }
  const b64 = body.b64_video;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new CosmosError("malformed_response", "Cosmos response had no video payload (missing b64_video). Retry the generation.", `keys: ${Object.keys(body).join(",")}`);
  }
  let videoBytes: Buffer;
  try {
    videoBytes = Buffer.from(b64, "base64");
  } catch {
    throw new CosmosError("malformed_response", "Cosmos video payload was not valid base64.", "base64 decode threw");
  }
  if (videoBytes.length < 1024) {
    throw new CosmosError("invalid_video", "Cosmos returned a suspiciously small video payload. Retry the generation.", `bytes: ${videoBytes.length}`);
  }
  if (!isMp4Bytes(videoBytes)) {
    throw new CosmosError("invalid_video", "Cosmos payload did not decode to an MP4 container. Retry the generation.", `magic: ${videoBytes.subarray(0, 12).toString("hex")}`);
  }
  const seed = typeof body.seed === "number" && Number.isFinite(body.seed) ? body.seed : null;
  const upsampledPrompt = typeof body.upsampled_prompt === "string" ? body.upsampled_prompt : null;
  return { videoBytes, seed, upsampledPrompt };
}

export const COSMOS_DEFAULT_TIMEOUT_MS = 600_000;

/** Resolve the provider-call ceiling. Unset/unparseable input → default. */
export function resolveCosmosTimeout(ctx: MotionContext = {}, env: Record<string, string | undefined> = process.env): number {
  const raw = ctx.timeoutMs ?? Number(env.NVIDIA_COSMOS_TIMEOUT_MS);
  return Math.max(1000, Math.round(Number.isFinite(raw) ? (raw as number) : COSMOS_DEFAULT_TIMEOUT_MS));
}

function defaultTransport(): CosmosFetch {
  return (url, init) =>
    fetch(url, init).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
      text: () => response.text()
    }));
}

/**
 * Execute one Cosmos3-Nano generation per the documented hosted contract.
 * Records nothing; callers persist. Secrets stay in headers — never in
 * errors, logs, or return values.
 */
export async function executeCosmosGeneration(
  request: MotionGenerationRequest,
  ctx: MotionContext = {}
): Promise<MotionProviderResult> {
  const env = ctx.env ?? process.env;
  const apiKey = cosmosApiKey(env);
  if (!apiKey) {
    throw new CosmosError(
      "missing_api_key",
      "No Cosmos API key configured. Set NVIDIA_COSMOS_API_KEY (preferred) or NVIDIA_API_KEY in the server environment and restart (see AI-MOTION.md).",
      "no cosmos api key in env"
    );
  }
  const { mode, prompt, negativePrompt } = validateMotionRequest(request);
  const settings = validateCosmosSettings(request.settings);
  const endpoint = endpointFor(env);
  const transport = ctx.transport ?? defaultTransport();
  const timeoutMs = resolveCosmosTimeout(ctx, env);

  const body = buildCosmosRequestBody({
    mode,
    prompt,
    negativePrompt,
    inputDataUri: request.inputBytes ? inputDataUri(request.inputBytes, request.inputMime ?? "image/png") : undefined,
    settings
  });

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutGuard = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new CosmosError("timeout", `Cosmos generation timed out after ${Math.round(timeoutMs / 1000)}s. Generations often take minutes — raise NVIDIA_COSMOS_TIMEOUT_MS and retry.`, "abort fired")), { once: true });
  });
  try {
    const response = await Promise.race([
      transport(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      }),
      timeoutGuard
    ]);
    if (!response.ok) await throwForStatus(response.status, () => response.text(), endpoint);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CosmosError("malformed_response", "Cosmos returned a non-JSON response. Retry the generation.", "json() threw");
    }
    const { videoBytes, seed, upsampledPrompt } = parseCosmosResponse(payload);
    return {
      provider: COSMOS_PROVIDER_ID,
      model: COSMOS_MODEL_ID,
      videoBytes,
      contentType: "video/mp4",
      byteLength: videoBytes.length,
      seed,
      upsampledPrompt,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      frames: settings.numFrames,
      durationMs: settings.durationMs
    };
  } catch (error) {
    if (error instanceof CosmosError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("abort") || (error instanceof Error && error.name === "AbortError")) {
      throw new CosmosError("timeout", `Cosmos generation timed out after ${Math.round(timeoutMs / 1000)}s. Retry; long generations are normal on the trial endpoint.`, message.slice(0, 200));
    }
    throw new CosmosError("network", `Could not reach the Cosmos endpoint: ${message.slice(0, 200)}`, message.slice(0, 300));
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export class NvidiaCosmosProvider implements MotionProvider {
  readonly id = COSMOS_PROVIDER_ID;
  readonly models = [COSMOS_MODEL_ID];
  status(env: Record<string, string | undefined> = process.env): MotionProviderStatus {
    const diag = diagnoseCosmosConfig(env);
    return {
      provider: COSMOS_PROVIDER_ID,
      model: COSMOS_MODEL_ID,
      displayName: `NVIDIA ${COSMOS_DISPLAY_NAME}`,
      configured: diag.configured,
      detail: diag.configured ? `Ready (${diag.authMode === "cosmos-key" ? "NVIDIA_COSMOS_API_KEY" : "NVIDIA_API_KEY"})` : "No Cosmos API key (set NVIDIA_COSMOS_API_KEY)",
      endpointHost: diag.endpointHost,
      modes: ["image2video", "text2video", "video2video"]
    };
  }
  generate(request: MotionGenerationRequest, ctx: MotionContext = {}): Promise<MotionProviderResult> {
    return executeCosmosGeneration(request, ctx);
  }
}

/** Registry hook so future models plug in without touching callers. */
export function getMotionProvider(id: string): MotionProvider {
  if (id === COSMOS_PROVIDER_ID) return new NvidiaCosmosProvider();
  throw new CosmosError("invalid_input", `Unknown motion provider "${id}". Available: "${COSMOS_PROVIDER_ID}".`);
}

export function selectedMotionProviderId(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.MOTION_PROVIDER ?? "cosmos").trim().toLowerCase();
  if (raw === "cosmos" || raw === "nvidia") return COSMOS_PROVIDER_ID;
  if (raw === "mock") return "mock";
  throw new CosmosError("invalid_input", `Unknown MOTION_PROVIDER "${raw}". Use "cosmos" or "mock".`);
}
