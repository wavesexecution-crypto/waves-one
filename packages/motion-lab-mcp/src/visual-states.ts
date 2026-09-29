/**
 * Visual State Engine — first-class visual states with geometry, composition,
 * transitions, and layout rules.
 *
 * Each state needs:
 * - identity (unique key)
 * - geometry (elements, positioning)
 * - composition (visual structure)
 * - animation capabilities
 * - parameters
 * - valid transitions to other states
 * - responsive layout rules (vertical/landscape)
 * - accessibility metadata
 * - validation rules
 *
 * The system knows which states can transition into which other states.
 * Transitions are actual transformations, not fade out + fade in.
 */

export type VisualStateKind =
  | "orb"
  | "search"
  | "crm"
  | "notebook"
  | "workflow"
  | "data"
  | "browser"
  | "agent"
  | "network"
  | "pipeline"
  | "stages"
  | "milestones"
  | "hero"
  | "title";

export interface VisualStateGeometry {
  elements: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    rotation?: number;
  }>;
}

export interface VisualStateLayout {
  vertical: {
    spacing: number;
    alignment: "start" | "center" | "end";
    maxWidth: number;
  };
  landscape: {
    spacing: number;
    alignment: "start" | "center" | "end";
    maxWidth: number;
  };
}

export interface VisualStateTransition {
  from: VisualStateKind;
  to: VisualStateKind;
  type: "morph" | "dissolve" | "cascade";
  durationMs: number;
  easing: string;
}

export interface VisualState {
  kind: VisualStateKind;
  label: string;
  description: string;
  geometry: VisualStateGeometry;
  layout: VisualStateLayout;
  animationCapabilities: string[];
  parameters: Record<string, unknown>;
  validTransitions: VisualStateKind[];
  accessibility: {
    role: string;
    label: string;
    description: string;
  };
  validation: {
    minDurationMs: number;
    maxDurationMs: number;
    requiredParams: string[];
  };
}

/**
 * Visual vocabulary mapping: semantic intent → visual state.
 */
export interface VisualVocabulary {
  intent: string;
  keywords: string[];
  state: VisualStateKind;
  description: string;
}

export const VISUAL_VOCABULARY: VisualVocabulary[] = [
  {
    intent: "discover",
    keywords: ["search", "find", "explore", "hunt", "seek", "discover"],
    state: "search",
    description: "Search/exploration visual"
  },
  {
    intent: "connect",
    keywords: ["connect", "link", "network", "nodes", "graph"],
    state: "network",
    description: "Connected nodes visualization"
  },
  {
    intent: "understand",
    keywords: ["understand", "analyze", "context", "research", "notebook"],
    state: "notebook",
    description: "Research/intelligence surface"
  },
  {
    intent: "customer",
    keywords: ["customer", "crm", "leads", "prospects", "contacts"],
    state: "crm",
    description: "CRM table view"
  },
  {
    intent: "automate",
    keywords: ["automate", "workflow", "process", "pipeline", "sequence"],
    state: "workflow",
    description: "Workflow chain visualization"
  },
  {
    intent: "execute",
    keywords: ["execute", "action", "deploy", "run", "perform"],
    state: "pipeline",
    description: "Execution pipeline"
  },
  {
    intent: "data",
    keywords: ["data", "chart", "metrics", "analytics", "visualization"],
    state: "data",
    description: "Data visualization"
  },
  {
    intent: "system",
    keywords: ["system", "orb", "waves", "intelligence", "ai"],
    state: "orb",
    description: "WAVES orb visualization"
  },
  {
    intent: "scale",
    keywords: ["scale", "grow", "expand", "network", "reach"],
    state: "network",
    description: "Expanding network"
  },
  {
    intent: "result",
    keywords: ["result", "outcome", "milestone", "achievement", "report"],
    state: "milestones",
    description: "Results/milestones view"
  },
  {
    intent: "finale",
    keywords: ["finale", "conclusion", "end", "complete", "summary"],
    state: "title",
    description: "Title card/finale"
  }
];

/**
 * Map semantic intent to visual state.
 */
export function mapIntentToState(intent: string, keywords: string[] = []): VisualStateKind {
  const lower = intent.toLowerCase();
  const allKeywords = [lower, ...keywords.map((k) => k.toLowerCase())];

  for (const vocab of VISUAL_VOCABULARY) {
    if (vocab.intent === lower) return vocab.state;
    for (const keyword of allKeywords) {
      if (vocab.keywords.some((vk) => keyword.includes(vk))) {
        return vocab.state;
      }
    }
  }

  // Default to orb as the fundamental visual state
  return "orb";
}

/**
 * Get valid transitions from one state to another.
 */
export function getValidTransitions(from: VisualStateKind): VisualStateKind[] {
  // All states can transition to/from orb (the fundamental state)
  const baseTransitions: VisualStateKind[] = ["orb"];

  // State-specific transition rules
  const transitionRules: Record<VisualStateKind, VisualStateKind[]> = {
    orb: ["search", "network", "crm", "notebook", "title"],
    search: ["orb", "network", "crm"],
    crm: ["orb", "notebook", "workflow"],
    notebook: ["orb", "workflow", "crm"],
    workflow: ["orb", "pipeline", "stages"],
    data: ["orb", "milestones"],
    browser: ["orb", "search"],
    agent: ["orb", "workflow"],
    network: ["orb", "search", "crm"],
    pipeline: ["orb", "workflow", "stages"],
    stages: ["orb", "pipeline", "milestones"],
    milestones: ["orb", "title"],
    hero: ["orb", "title"],
    title: ["orb"]
  };

  return [...new Set([...baseTransitions, ...(transitionRules[from] ?? [])])];
}

/**
 * Validate a state transition.
 */
export function validateTransition(from: VisualStateKind, to: VisualStateKind): boolean {
  if (from === to) return true;
  const valid = getValidTransitions(from);
  return valid.includes(to);
}

/**
 * Create transition specification between two states.
 */
export function createTransition(
  from: VisualStateKind,
  to: VisualStateKind
): VisualStateTransition | null {
  if (!validateTransition(from, to)) return null;

  // Orb transitions are morphs
  if (from === "orb" || to === "orb") {
    return {
      from,
      to,
      type: "morph",
      durationMs: 800,
      easing: "waves-smooth"
    };
  }

  // Related states dissolve
  return {
    from,
    to,
    type: "dissolve",
    durationMs: 600,
    easing: "waves-entrance"
  };
}
