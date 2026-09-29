/**
 * AI provider abstraction for the creative director.
 *
 * Providers plug in here without touching the rest of the app: each entry
 * declares its models and capabilities, and every generation records which
 * provider/model directed it. Model fulfillment happens through the
 * connected MCP session — the registry never claims a live API connection
 * it cannot verify, so availability is reported as session-routed.
 */

export interface ProviderModel {
  id: string;
  label: string;
  capabilities: string[];
}

export interface ProviderDefinition {
  id: string;
  label: string;
  blurb: string;
  models: ProviderModel[];
  /** How this provider is reached from this installation. */
  route: string;
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "gpt",
    label: "GPT",
    blurb: "OpenAI models for direction and refinement.",
    models: [{ id: "session-default", label: "Session default", capabilities: ["direction", "refinement"] }],
    route: "session"
  },
  {
    id: "claude",
    label: "Claude",
    blurb: "Anthropic models for direction and refinement.",
    models: [{ id: "session-default", label: "Session default", capabilities: ["direction", "refinement"] }],
    route: "session"
  },
  {
    id: "gemini",
    label: "Gemini",
    blurb: "Google models for direction and refinement.",
    models: [{ id: "session-default", label: "Session default", capabilities: ["direction", "refinement"] }],
    route: "session"
  }
];

export const DEFAULT_PROVIDER = "claude";
export const DEFAULT_MODEL = "session-default";

export function getProvider(id: string): ProviderDefinition {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0];
}

export function getModelLabel(providerId: string, modelId: string): string {
  const provider = getProvider(providerId);
  return provider.models.find((model) => model.id === modelId)?.label ?? modelId;
}
