/**
 * Live NVIDIA chat/vision integration (prompt intelligence for AI Motion).
 *
 * Verified live 2026-09-29 against the hosted Build API with a trial key:
 * `meta/llama-3.2-11b-vision-instruct` answers on
 * https://integrate.api.nvidia.com/v1/chat/completions (OpenAI-compatible),
 * including image_url inputs. The account's other listings (cosmos-reason2-8b,
 * gemma-2b) 404 with "Function … Not found for account", so the default
 * model is the verified one; override with NVIDIA_CHAT_MODEL.
 *
 * Server-side only: key in Authorization header, never logged/persisted.
 * Output is an enhanced prompt string — callers apply it only on explicit
 * user action, never by overwriting.
 */

import { CosmosError, type CosmosFetch } from "./cosmos.js";

export const LIVE_CHAT_MODEL_DEFAULT = "meta/llama-3.2-11b-vision-instruct";
export const LIVE_CHAT_ENDPOINT_DEFAULT = "https://integrate.api.nvidia.com/v1/chat/completions";

export interface LiveChatStatus {
  provider: string;
  model: string;
  displayName: string;
  configured: boolean;
  detail: string;
  endpointHost: string;
  capabilities: string[];
}

export function liveChatModel(env: Record<string, string | undefined> = process.env): string {
  return (env.NVIDIA_CHAT_MODEL ?? "").trim() || LIVE_CHAT_MODEL_DEFAULT;
}

function liveChatEndpoint(env: Record<string, string | undefined>): string {
  return (env.NVIDIA_CHAT_ENDPOINT ?? "").trim() || LIVE_CHAT_ENDPOINT_DEFAULT;
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "integrate.api.nvidia.com";
  }
}

export function liveChatStatus(env: Record<string, string | undefined> = process.env): LiveChatStatus {
  const configured = Boolean((env.NVIDIA_API_KEY ?? "").trim());
  const model = liveChatModel(env);
  return {
    provider: "nvidia",
    model,
    displayName: "NVIDIA Llama 3.2 Vision",
    configured,
    detail: configured ? `Ready · ${model}` : "NVIDIA_API_KEY not configured",
    endpointHost: endpointHost(liveChatEndpoint(env)),
    capabilities: ["prompt-enhancement", "vision"]
  };
}

export interface EnhanceInput {
  prompt: string;
  mode?: string;
  imageBytes?: Buffer;
  imageMime?: string;
}

export interface EnhanceResult {
  enhanced: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface EnhanceOptions {
  env?: Record<string, string | undefined>;
  transport?: CosmosFetch;
  timeoutMs?: number;
  maxTokens?: number;
}

const SYSTEM_PROMPT =
  "You are a motion-direction assistant for AI video generation (NVIDIA Cosmos-style world models). " +
  "Rewrite the user's prompt as one dense cinematic paragraph: camera behavior first, then lighting, " +
  "material and reflection response, what must stay geometrically stable, and what must never happen " +
  "(no deformation, no morphing, no extra limbs or text). If a source image is provided, ground the " +
  "motion in what you see. Preserve the user's intent — intensify, don't replace. " +
  "Respond with the enhanced prompt only, no preamble, no quotes, no explanation.";

function defaultTransport(): CosmosFetch {
  return (url, init) =>
    fetch(url, init).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
      text: () => response.text()
    }));
}

function extractContent(payload: unknown): string {
  const body = payload as Record<string, unknown>;
  const choices = body.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : "";
  if (!text.trim()) throw new CosmosError("malformed_response", "The enhancement model returned no text. Retry.", "empty choice content");
  return text.trim().slice(0, 4000);
}

/** Enhance a motion prompt via the live NVIDIA vision model. Pure text in/out. */
export async function enhanceMotionPrompt(input: EnhanceInput, options: EnhanceOptions = {}): Promise<EnhanceResult> {
  const env = options.env ?? process.env;
  const apiKey = (env.NVIDIA_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new CosmosError(
      "missing_api_key",
      "NVIDIA_API_KEY is not configured. Set it in the server environment to enable prompt enhancement.",
      "env NVIDIA_API_KEY empty"
    );
  }
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) throw new CosmosError("invalid_input", "Enhancement needs a prompt to enhance.");
  if (prompt.length > 20000) throw new CosmosError("invalid_input", "Prompt exceeds the 20000-character limit.");
  const model = liveChatModel(env);
  const endpoint = liveChatEndpoint(env);
  const transport = options.transport ?? defaultTransport();
  const rawTimeout = options.timeoutMs ?? Number(env.NVIDIA_CHAT_TIMEOUT_MS);
  const timeoutMs = Math.max(5000, Math.round(Number.isFinite(rawTimeout) ? (rawTimeout as number) : 120_000));

  const userContent: unknown[] = [{ type: "text", text: `Mode: ${input.mode === "image2video" ? "image-to-video" : "text-to-video"}\nPrompt: ${prompt}` }];
  if (input.imageBytes && input.imageBytes.length > 0) {
    if (input.imageBytes.length > 12_000_000) throw new CosmosError("invalid_input", "Source image exceeds 12 MB.");
    const mime = input.imageMime === "image/jpg" ? "image/jpeg" : (input.imageMime ?? "image/png");
    userContent.push({ type: "image_url", image_url: { url: `data:${mime};base64,${input.imageBytes.toString("base64")}` } });
  }
  const body = { model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }], max_tokens: options.maxTokens ?? 320, temperature: 0.7 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      let snippet = "";
      try {
        snippet = (await response.text()).slice(0, 300);
      } catch {
        snippet = "";
      }
      if (response.status === 401 || response.status === 403) throw new CosmosError("unauthorized", "NVIDIA rejected the API key. Check NVIDIA_API_KEY.", `HTTP ${response.status}`);
      if (response.status === 404) throw new CosmosError("endpoint_not_found", `Model "${model}" is not invocable for this key. Set NVIDIA_CHAT_MODEL to an entitled model.`, `HTTP 404: ${snippet}`);
      if (response.status === 429) throw new CosmosError("rate_limited", "NVIDIA rate limit hit. Wait and retry.", "HTTP 429");
      throw new CosmosError("server_error", `Enhancement failed (HTTP ${response.status}). Retry.`, `HTTP ${response.status}: ${snippet}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CosmosError("malformed_response", "Enhancement returned non-JSON. Retry.", "json() threw");
    }
    const usage = (payload as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    return {
      enhanced: extractContent(payload),
      model,
      promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
      completionTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null
    };
  } catch (error) {
    if (error instanceof CosmosError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("abort") || (error instanceof Error && error.name === "AbortError")) {
      throw new CosmosError("timeout", "Enhancement timed out. Retry.", message.slice(0, 200));
    }
    throw new CosmosError("network", `Could not reach NVIDIA: ${message.slice(0, 200)}`, message.slice(0, 300));
  } finally {
    clearTimeout(timer);
  }
}
