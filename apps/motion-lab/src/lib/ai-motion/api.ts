/**
 * AI Motion HTTP client — browser talks only to same-origin dev routes.
 * Responses carry metadata + video URLs, never credentials or base64 video.
 */

import type {
  EnhanceResultBody,
  GenerateResultBody,
  GenerationRecord,
  MotionMode,
  ProviderStatusResponse,
  SourceAsset
} from "./types";

export class AiMotionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiMotionError";
    this.code = code;
  }
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new AiMotionError("server_error", `Server returned HTTP ${response.status} with no JSON body.`);
  }
  if (!response.ok || body.ok === false) {
    const code = typeof body.code === "string" ? body.code : "server_error";
    const message = typeof body.error === "string" ? body.error : `Request failed (HTTP ${response.status}).`;
    throw new AiMotionError(code, message);
  }
  return body;
}

function asSource(value: unknown): SourceAsset {
  return value as SourceAsset;
}

function asGeneration(value: unknown): GenerationRecord {
  return value as GenerationRecord;
}

export async function fetchProviderStatus(): Promise<ProviderStatusResponse> {
  const response = await fetch("/__lab/ai-motion/status");
  const body = await parseJson(response);
  return body as unknown as ProviderStatusResponse;
}

export async function uploadSource(file: File): Promise<SourceAsset> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
  const response = await fetch("/__lab/ai-motion/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, dataUrl })
  });
  const body = await parseJson(response);
  return asSource(body.source);
}

export interface GenerateArgs {
  mode: MotionMode;
  prompt: string;
  negativePrompt?: string;
  settings: {
    resolution: string;
    numFrames: number;
    fps: number;
    numInferenceSteps: number;
    guidanceScale: number;
    flowShift?: number;
    seed?: number;
  };
  sourceId?: string;
  /** Runtime provider override: "cosmos" (default) or "mock". Server env wins when omitted. */
  provider?: string;
}

export async function generateMotion(args: GenerateArgs): Promise<GenerateResultBody> {
  const response = await fetch("/__lab/ai-motion/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  const body = await parseJson(response);
  return body as unknown as GenerateResultBody;
}

export async function enhancePrompt(args: { prompt: string; sourceId?: string; mode: MotionMode }): Promise<EnhanceResultBody> {
  const response = await fetch("/__lab/ai-motion/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  const body = await parseJson(response);
  return body as unknown as EnhanceResultBody;
}

export async function listGenerations(limit = 50): Promise<GenerationRecord[]> {
  const response = await fetch(`/__lab/ai-motion/generations?limit=${limit}`);
  const body = await parseJson(response);
  return (body.generations ?? []) as GenerationRecord[];
}

export async function getGeneration(id: string): Promise<GenerationRecord> {
  const response = await fetch(`/__lab/ai-motion/generations/${encodeURIComponent(id)}`);
  const body = await parseJson(response);
  return asGeneration(body.generation);
}

export async function deleteGeneration(id: string): Promise<void> {
  const response = await fetch(`/__lab/ai-motion/generations/${encodeURIComponent(id)}`, { method: "DELETE" });
  await parseJson(response);
}

export async function useGeneration(id: string): Promise<GenerationRecord> {
  const response = await fetch(`/__lab/ai-motion/generations/${encodeURIComponent(id)}/use`, { method: "POST" });
  const body = await parseJson(response);
  return asGeneration(body.generation);
}

export async function saveGeneration(id: string): Promise<GenerationRecord> {
  const response = await fetch(`/__lab/ai-motion/generations/${encodeURIComponent(id)}/save`, { method: "POST" });
  const body = await parseJson(response);
  return asGeneration(body.generation);
}
