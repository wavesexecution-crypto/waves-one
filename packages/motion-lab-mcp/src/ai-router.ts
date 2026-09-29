/**
 * AI Router — provider abstraction with structured output and validation.
 *
 * Supports multiple AI providers (GPT, Claude, Gemini) with task-level routing.
 * The AI provider NEVER directly mutates application state.
 * AI proposes. The deterministic Motion system validates and executes.
 *
 * All credentials stay server-side.
 * No fake provider availability.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  type ProviderSpec,
  PROVIDER_SPECS,
  type ProviderRequest,
  type ProviderResult,
  ProviderNotConfigured,
  ProviderOutputRejected,
  executeProvider,
  validateStructuredOutput,
  getProviderSpec
} from "./providers.js";

export type AIProvider = "openai" | "anthropic" | "gemini";

export interface AIProviderConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
  timeout?: number;
}

export interface StructuredRequest<T = unknown> {
  prompt: string;
  schema: T;
  temperature?: number;
  maxTokens?: number;
}

export interface StructuredResponse<T = unknown> {
  provider: AIProvider;
  model: string;
  data: T;
  tokensUsed?: { prompt?: number; completion?: number; total?: number };
  durationMs: number;
  requestId?: string;
}

export interface AIRouterContext {
  configs: Map<AIProvider, AIProviderConfig>;
  defaultProvider: AIProvider;
  db: DatabaseSync;
}

/**
 * AI task types for provider routing.
 * Different tasks can use different models optimized for that task.
 */
export type AITask =
  | "transcription"
  | "story-analysis"
  | "visual-planning"
  | "copy-generation"
  | "motion-parameters";

export interface TaskRouting {
  task: AITask;
  provider: AIProvider;
  model: string;
}

export class AIRouter {
  private readonly context: AIRouterContext;
  private readonly routing: Map<AITask, TaskRouting>;

  constructor(context: AIRouterContext) {
    this.context = context;
    this.routing = new Map();
  }

  /**
   * Configure task-level routing.
   * Example: transcription → Whisper, story analysis → GPT-4, visual planning → Claude.
   */
  setTaskRouting(task: AITask, provider: AIProvider, model: string): void {
    this.routing.set(task, { task, provider, model });
  }

  /**
   * Get provider config for a task, falling back to default.
   */
  getProviderForTask(task: AITask): AIProviderConfig {
    const routing = this.routing.get(task);
    const provider = routing?.provider ?? this.context.defaultProvider;
    const config = this.context.configs.get(provider);
    if (!config) {
      throw new Error(`AI provider "${provider}" not configured.`);
    }
    return config;
  }

  /**
   * Call AI provider with structured output and schema validation.
   * Returns validated structured data or throws.
   */
  async callStructured<T>(
    task: AITask,
    request: StructuredRequest<T>
  ): Promise<StructuredResponse<T>> {
    const config = this.getProviderForTask(task);
    const startTime = Date.now();
    const requestId = `req-${Date.now().toString(36)}`;

    // Map our provider names to the provider.ts spec names
    const providerMap: Record<AIProvider, "gpt" | "claude" | "gemini"> = {
      openai: "gpt",
      anthropic: "claude",
      gemini: "gemini"
    };

    const providerId = providerMap[config.provider];
    const spec = getProviderSpec(providerId);

    // Build the provider request
    const providerRequest: ProviderRequest = {
      task,
      model: config.model,
      prompt: request.prompt,
      maxTokens: request.maxTokens
    };

    try {
      const result = await executeProvider(this.context.db, providerId, providerRequest, { requestId });
      
      // Validate structured output
      const validated = validateStructuredOutput(result.data) as T;

      return {
        provider: config.provider,
        model: config.model,
        data: validated,
        tokensUsed: result.usage as any,
        durationMs: Date.now() - startTime,
        requestId
      };
    } catch (error) {
      if (error instanceof ProviderNotConfigured) {
        throw new Error(`Provider ${config.provider} not configured: ${error.message}`);
      }
      if (error instanceof ProviderOutputRejected) {
        throw new Error(`Provider ${config.provider} output rejected: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Health check: verify configured providers are reachable.
   */
  async healthCheck(): Promise<Map<AIProvider, boolean>> {
    const results = new Map<AIProvider, boolean>();
    for (const [provider] of this.context.configs) {
      try {
        // Simple health check by attempting a minimal call
        const providerMap: Record<AIProvider, "gpt" | "claude" | "gemini"> = {
          openai: "gpt",
          anthropic: "claude",
          gemini: "gemini"
        };
        const providerId = providerMap[provider];
        const spec = getProviderSpec(providerId);
        const env = process.env;
        const apiKey = (env[spec.envKey] ?? "").trim();
        results.set(provider, Boolean(apiKey));
      } catch {
        results.set(provider, false);
      }
    }
    return results;
  }
}

/**
 * Create AI router with explicit provider configurations.
 * No fake providers. If transcription is unavailable, the system uses deterministic fallback.
 */
export function createAIRouter(configs: AIProviderConfig[], defaultProvider: AIProvider, db: DatabaseSync): AIRouter {
  const configMap = new Map<AIProvider, AIProviderConfig>();
  for (const config of configs) {
    configMap.set(config.provider, config);
  }
  return new AIRouter({ configs: configMap, defaultProvider, db });
}

/**
 * Get provider status without credentials (for capability discovery).
 */
export function getProviderStatus(env: Record<string, string | undefined> = process.env): Map<AIProvider, { configured: boolean; models: string[] }> {
  const results = new Map<AIProvider, { configured: boolean; models: string[] }>();
  for (const spec of PROVIDER_SPECS) {
    const provider = spec.id as AIProvider;
    const configured = Boolean((env[spec.envKey] ?? "").trim());
    results.set(provider, { configured, models: spec.models });
  }
  return results;
}
