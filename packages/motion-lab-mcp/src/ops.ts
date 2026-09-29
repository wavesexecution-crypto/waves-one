/**
 * Motion Lab op contract — the shared language between the MCP server
 * and the browser runtime surface.
 *
 * The browser polls `public/motion-state.json` (`{ revision, ops }`) and
 * replays ops in order against the real @waves/motion engine. Ops are
 * intent-level: the MCP server translates AI requests into these, and
 * generates the equivalent target-website code alongside.
 */

export type OpId = string;

export interface AnimateOptions {
  duration?: number;
  delay?: number;
  easing?: string;
  /** Preset this animate op was expanded from (engine resolveSpec origin). */
  origin?: string;
  spring?: { stiffness?: number; damping?: number; mass?: number; velocity?: number };
  stagger?: number;
  staggerFrom?: string;
  repeat?: number;
  yoyo?: boolean;
}

export interface SceneElement {
  /** Stable key used to build a selector (`#lab-scene-<key>`). */
  key: string;
  kind: "cards" | "hero" | "box" | "text" | "title" | "flow" | "network" | "pipeline" | "stages" | "milestones" | "orb" | "crm" | "notebook" | "workflow" | "particle-orb";
  count?: number;
  text?: string;
  label?: string;
  /** Optional act grouping for multi-act films (mounts get `data-act`). */
  act?: number;
  /** Optional recomposition hint: "reel" renders the stage for 9:16 vertical. */
  layout?: string;
  /** Optional content fields for film kinds (all rendered grayscale). */
  sub?: string;
  eyebrow?: string;
  caption?: string;
  caption2?: string;
  items?: string[];
  highlight?: number[];
  large?: boolean;
  /** Procedural CRM rows ([company, contact, status, touch]) from narration entities. */
  rows?: string[][];
  /** Procedural notebook SIGNALS value from narration entities. */
  signal?: string;
}

export type MotionOp =
  | { id: OpId; kind: "reset" }
  | { id: OpId; kind: "scene"; scene: { elements: SceneElement[] } }
  | { id: OpId; kind: "animate"; target: string; properties: Record<string, unknown>; options?: AnimateOptions }
  | {
      id: OpId;
      kind: "preset";
      preset: string;
      target: string;
      params?: Record<string, unknown>;
      options?: AnimateOptions;
    }
  | {
      id: OpId;
      kind: "timeline";
      label?: string;
      nodes: Array<{
        target: string;
        properties?: Record<string, unknown>;
        preset?: string;
        params?: Record<string, unknown>;
        label?: string;
        at?: number;
        after?: string;
        stagger?: number;
        duration?: number;
        easing?: string;
      }>;
    }
  | {
      id: OpId;
      kind: "scroll";
      target: string;
      properties?: Record<string, unknown>;
      options?: { start?: string | number; end?: string | number; easing?: string };
    }
  | { id: OpId; kind: "text"; target: string; stagger?: number; duration?: number; easing?: string; delay?: number };

export interface MotionState {
  revision: number;
  updatedAt: string;
  ops: MotionOp[];
}

/** Runtime list of known scene element kinds (mirrors the SceneElement union). */
export const SCENE_KINDS = [
  "cards",
  "hero",
  "box",
  "text",
  "title",
  "flow",
  "network",
  "pipeline",
  "stages",
  "milestones",
  "orb",
  "crm",
  "notebook",
  "workflow",
  "particle-orb"
] as const;

export function emptyState(): MotionState {
  return { revision: 0, updatedAt: new Date(0).toISOString(), ops: [] };
}
