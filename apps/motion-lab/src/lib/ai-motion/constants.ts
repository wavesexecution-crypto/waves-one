/**
 * AI Motion workspace constants — verified Cosmos3-Generator contract values
 * (resolution table, caps, cadence) plus Motion Lab example prompts.
 */

import type { CosmosSettingsInput } from "./types";

export const COSMOS_MODEL_LABEL = "NVIDIA Cosmos3-Nano";
export const COSMOS_MODEL_ID = "nvidia/cosmos3-nano";
export const PROMPT_MAX = 20000;

export const DEFAULT_SETTINGS: CosmosSettingsInput = {
  resolution: "720",
  numFrames: 189,
  fps: 24,
  numInferenceSteps: 35,
  guidanceScale: 6,
  flowShift: "",
  seed: ""
};

/** Tier frame caps from the registry VideoFrameLimits (any integer, no cadence). */
export const TIER_FRAME_CAP: Record<string, number> = { "256": 397, "480": 297, "720": 197 };

export function tierOfResolution(key: string): string {
  return key.split("_")[0] || "720";
}

export function capForResolution(key: string): number {
  return TIER_FRAME_CAP[tierOfResolution(key)] ?? 197;
}

export interface ResolutionOption {
  key: string;
  label: string;
  width: number;
  height: number;
}

export const RESOLUTIONS: ResolutionOption[] = [
  { key: "720_16_9", label: "720p landscape · 1280 × 720", width: 1280, height: 720 },
  { key: "720_9_16", label: "720p portrait · 720 × 1280", width: 720, height: 1280 },
  { key: "720_1_1", label: "720p square · 960 × 960", width: 960, height: 960 },
  { key: "720_4_3", label: "720p 4:3 · 1104 × 832", width: 1104, height: 832 },
  { key: "720_3_4", label: "720p 3:4 · 832 × 1104", width: 832, height: 1104 },
  { key: "480_16_9", label: "480p landscape · 832 × 480", width: 832, height: 480 },
  { key: "480_9_16", label: "480p portrait · 480 × 832", width: 480, height: 832 },
  { key: "480_1_1", label: "480p square · 640 × 640", width: 640, height: 640 },
  { key: "480_4_3", label: "480p 4:3 · 736 × 544", width: 736, height: 544 },
  { key: "480_3_4", label: "480p 3:4 · 544 × 736", width: 544, height: 736 },
  { key: "256_16_9", label: "256p landscape · 320 × 192", width: 320, height: 192 },
  { key: "256_9_16", label: "256p portrait · 192 × 320", width: 192, height: 320 },
  { key: "256_1_1", label: "256p square · 256 × 256", width: 256, height: 256 },
  { key: "256_4_3", label: "256p 4:3 · 320 × 256", width: 320, height: 256 },
  { key: "256_3_4", label: "256p 3:4 · 256 × 320", width: 256, height: 320 }
];

/** Frame count: any integer in [25, tier cap] per the registry VideoFrameLimits. */
export function isValidFrames(frames: number, cap: number): boolean {
  return Number.isInteger(frames) && frames >= 25 && frames <= cap;
}

export function clampFrames(frames: number, cap: number): number {
  if (!Number.isFinite(frames)) return DEFAULT_SETTINGS.numFrames;
  return Math.max(25, Math.min(cap, Math.floor(frames)));
}

export function estimatedDurationMs(frames: number, fps: number): number | null {
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || fps <= 0) return null;
  return Math.round((frames / fps) * 1000);
}

export const EXAMPLE_PROMPTS: string[] = [
  "Slow cinematic camera push toward the subject, subtle parallax, controlled reflections, physically plausible lighting movement, stable geometry, premium technology commercial aesthetic.",
  "Subtle orbital camera movement around the object, realistic metallic reflections, shallow depth of field, restrained particles, smooth continuous motion, no deformation.",
  "Preserve the source design exactly while introducing subtle cinematic movement, soft volumetric lighting, realistic reflections and controlled camera motion.",
  "Gentle crane descent over the scene, soft morning light shifting across surfaces, faint atmospheric haze, slow continuous motion, photorealistic detail, no morphing.",
  "Static camera, living scene: subtle light flicker, drifting dust in volumetric shafts, gentle surface reflections evolving, hyper-stable geometry, cinematic restraint."
];

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTime(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return "—";
  }
}

/** Rough token estimate for the counter (≈ chars / 4). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
