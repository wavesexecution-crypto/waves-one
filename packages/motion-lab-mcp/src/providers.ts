/**
 * AI router — provider interface with server-side credentials and run records.
 *
 * Adapters never fake connectivity: without credentials they report
 * not-configured; with credentials they perform real HTTPS calls through an
 * injectable transport (tests inject a stub; production passes fetch).
 * Every attempt — success, refusal, or malformed output — records a
 * provider_runs row. Secrets live in env only and are never logged or
 * persisted. Model output must validate as structured data or it is
 * rejected, never published.
 */

import type { DatabaseSync } from "node:sqlite";

export interface ProviderSpec {
  id: string;
  models: string[];
  envKey: string;
}

export const PROVIDER_SPECS: ProviderSpec[] = [
  { id: "gpt", models: ["gpt-4o", "gpt-4o-mini"], envKey: "OPENAI_API_KEY" },
  { id: "claude", models: ["claude-sonnet-4-6", "claude-haiku-4-5"], envKey: "ANTHROPIC_API_KEY" },
  // Verified live against the models endpoint: 2.0/1.5 ids are retired (HTTP 404).
  { id: "gemini", models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"], envKey: "GEMINI_API_KEY" }
];

export interface ProviderRequest {
  task: string;
  model: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface ProviderResult {
  data: unknown;
  usage?: Record<string, unknown>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class ProviderNotConfigured extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(`Provider "${provider}" is not configured (missing credentials).`);
    this.name = "ProviderNotConfigured";
    this.provider = provider;
  }
}

export class ProviderOutputRejected extends Error {
  constructor(detail: string) {
    super(`Provider output rejected: ${detail}`);
    this.name = "ProviderOutputRejected";
  }
}

export function getProviderSpec(id: string): ProviderSpec {
  const spec = PROVIDER_SPECS.find((entry) => entry.id === id);
  if (!spec) throw new Error(`Unknown provider "${id}" — use gpt, claude, or gemini.`);
  return spec;
}

export function providerStatus(id: string, env: Record<string, string | undefined> = process.env): { configured: boolean; models: string[] } {
  const spec = getProviderSpec(id);
  return { configured: Boolean((env[spec.envKey] ?? "").trim()), models: spec.models };
}

/** Structured-output gate: plain objects only, no strings/arrays/null. */
export function validateStructuredOutput(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderOutputRejected("expected a JSON object at the top level.");
  }
  return value as Record<string, unknown>;
}

function recordRun(
  db: DatabaseSync,
  run: { provider: string; model: string; task: string; requestId: string; durationMs: number; status: string; error?: string; tokens?: unknown }
): void {
  db.prepare(
    "INSERT INTO provider_runs (id, provider, model, task, request_id, duration_ms, status, error, tokens_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    `prun-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    run.provider,
    run.model,
    run.task,
    run.requestId,
    run.durationMs,
    run.status,
    run.error ?? null,
    run.tokens === undefined ? null : JSON.stringify(run.tokens),
    Date.now()
  );
}

function endpointFor(provider: string): string {
  if (provider === "gpt") return "https://api.openai.com/v1/chat/completions";
  if (provider === "claude") return "https://api.anthropic.com/v1/messages";
  return "https://generativelanguage.googleapis.com/v1beta/models/MODEL:generateContent";
}

function buildBody(provider: string, model: string, request: ProviderRequest): Record<string, unknown> {
  if (provider === "gpt") {
    return {
      model,
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content: request.prompt }
      ],
      max_tokens: request.maxTokens ?? 1024,
      response_format: { type: "json_object" }
    };
  }
  if (provider === "claude") {
    return {
      model,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.system ? { system: request.system } : {}),
      messages: [{ role: "user", content: request.prompt }]
    };
  }
  return {
    system_instruction: request.system ? { parts: [{ text: request.system }] } : undefined,
    contents: [{ parts: [{ text: `${request.prompt}\n\nRespond with a single JSON object and nothing else.` }] }],
    generationConfig: { maxOutputTokens: request.maxTokens ?? 1024 }
  };
}

function authHeaders(provider: string, apiKey: string): Record<string, string> {
  if (provider === "claude") {
    return { "x-api-key": apiKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function extractData(provider: string, model: string, payload: unknown): { data: unknown; usage?: Record<string, unknown> } {
  const body = payload as Record<string, unknown>;
  try {
    if (provider === "gpt") {
      const message = (body.choices as Array<{ message?: { content?: unknown } }>)[0]?.message?.content;
      const text = typeof message === "string" ? message : JSON.stringify(message ?? null);
      return { data: JSON.parse(text), usage: (body.usage ?? undefined) as Record<string, unknown> | undefined };
    }
    if (provider === "claude") {
      const blocks = body.content as Array<{ text?: unknown }>;
      const text = blocks.map((block) => (typeof block.text === "string" ? block.text : "")).join("");
      return { data: JSON.parse(text), usage: (body.usage ?? undefined) as Record<string, unknown> | undefined };
    }
    const parts = (body.candidates as Array<{ content?: { parts?: Array<{ text?: unknown }> } }>)[0]?.content?.parts ?? [];
    const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return { data: JSON.parse(cleaned), usage: (body.usageMetadata ?? undefined) as Record<string, unknown> | undefined };
  } catch {
    throw new ProviderOutputRejected("model did not return parseable JSON.");
  }
}

/**
 * Execute one provider task. Records every attempt. Transport injectable
 * for tests; production passes nothing and uses global fetch.
 */
export async function executeProvider(
  db: DatabaseSync,
  providerId: string,
  request: ProviderRequest,
  options: { transport?: FetchLike; env?: Record<string, string | undefined>; requestId?: string; timeoutMs?: number } = {}
): Promise<ProviderResult> {
  const spec = getProviderSpec(providerId);
  const env = options.env ?? process.env;
  const apiKey = (env[spec.envKey] ?? "").trim();
  const started = Date.now();
  const requestId = options.requestId ?? `req-${Date.now().toString(36)}`;
  const timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? 60_000));
  if (!apiKey) {
    recordRun(db, { provider: providerId, model: request.model, task: request.task, requestId, durationMs: 0, status: "not_configured", error: `Missing ${spec.envKey}.` });
    throw new ProviderNotConfigured(providerId);
  }
  if (!spec.models.includes(request.model)) {
    recordRun(db, { provider: providerId, model: request.model, task: request.task, requestId, durationMs: 0, status: "rejected", error: `Unknown model "${request.model}" for ${providerId}.` });
    throw new Error(`Unknown model "${request.model}" for provider "${providerId}".`);
  }
  const transport: FetchLike =
    options.transport ??
    ((url, init) =>
      fetch(url, init).then(async (response) => ({ ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown> })));
  // Hard ceiling: a hung provider can never hold a pipeline hostage. The
  // abort also cancels the underlying request when the transport honors it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutGuard = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error(`Provider "${providerId}" timed out after ${Math.round(timeoutMs / 1000)}s.`)), { once: true });
  });
  try {
    const endpoint = endpointFor(providerId).replace("MODEL", request.model);
    const withKey = providerId === "gemini" ? `${endpoint}?key=${encodeURIComponent(apiKey)}` : endpoint;
    const headers = providerId === "gemini" ? { "Content-Type": "application/json" } : authHeaders(providerId, apiKey);
    const response = await Promise.race([
      transport(withKey, { method: "POST", headers, body: JSON.stringify(buildBody(providerId, request.model, request)), signal: controller.signal }),
      timeoutGuard
    ]);
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}.`);
    const { data, usage } = extractData(providerId, request.model, await response.json());
    const validated = validateStructuredOutput(data);
    recordRun(db, { provider: providerId, model: request.model, task: request.task, requestId, durationMs: Date.now() - started, status: "completed", tokens: usage });
    return { data: validated, usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordRun(db, { provider: providerId, model: request.model, task: request.task, requestId, durationMs: Date.now() - started, status: "failed", error: message });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
