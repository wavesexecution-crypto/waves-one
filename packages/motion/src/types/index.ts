/**
 * Waves Motion Engine — shared type surface (v1.0).
 *
 * Everything the engine can animate, schedule, record, inspect or serialise is
 * described by the types in this file. The same types back the machine-readable
 * schema in `src/schema`, so an AI agent (OpenCode) and a human developer are
 * looking at exactly the same contract.
 */

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

export type Primitive = number | string;

/** CSS/SVG units understood by the value engine. */
export type Unit =
  | "px"
  | "%"
  | "em"
  | "rem"
  | "vw"
  | "vh"
  | "vmin"
  | "vmax"
  | "deg"
  | "rad"
  | "turn"
  | "ms"
  | "s"
  | "";

/** The kind of interpolation that applies to a channel. */
export type ValueKind = "number" | "unit" | "color" | "transform" | "filter" | "string";

/** Logical style channel a property writes into. */
export type StyleChannel = "transform" | "filter" | "style" | "cssvar" | "svg" | "text";

/** A single keyframe of an animation track. */
export interface Keyframe {
  /** Normalised position, 0 – 1. */
  offset: number;
  /** Raw authored value (number, unit string, colour string …). */
  value: Primitive;
}

/**
 * Authored property input.
 *
 * - `12`                  → implicit `to`
 * - `[0, 1]`              → from → to
 * - `[0, 0.6, 1]`         → multi keyframe, evenly spaced
 * - `{ from: 40, to: 0 }` → explicit endpoints (+ optional `offset`, `easing`)
 * - `{ 0: 40, 1: 0 }`     → explicit offsets
 */
export type PropertyInput =
  | Primitive
  | Primitive[]
  | { from: Primitive; to: Primitive; offset?: number; easing?: EasingSpec }
  | Record<string, Primitive>;

/** A map of logical properties to authored inputs. */
export type PropertyMap = Record<string, PropertyInput>;

/* -------------------------------------------------------------------------- */
/* Easing                                                                     */
/* -------------------------------------------------------------------------- */

export type EasingName =
  | "linear"
  | "waves-standard"
  | "waves-entrance"
  | "waves-exit"
  | "waves-smooth"
  | "waves-spring"
  | "waves-snap"
  | "waves-glide"
  | "ease"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "sine-out"
  | "quad-out"
  | "cubic-out"
  | "quart-out"
  | "expo-out"
  | "expo-in"
  | "circ-out"
  | "circ-in"
  | "back-out";

/** Cubic bezier control points. */
export type CubicBezierPoints = [number, number, number, number];

export type EasingFunction = (t: number) => number;

export type EasingSpec = EasingName | CubicBezierPoints | EasingFunction;

/* -------------------------------------------------------------------------- */
/* Spring                                                                     */
/* -------------------------------------------------------------------------- */

export interface SpringConfig {
  /** Spring constant. Higher = faster. */
  stiffness: number;
  /** Damping coefficient. Higher = less oscillation. */
  damping: number;
  /** Mass of the moving body. */
  mass: number;
  /** Initial velocity (units per second, normalised against travelled distance). */
  velocity?: number;
  /** Rest thresholds. */
  restDelta?: number;
  restSpeed?: number;
}

export type SpringInput = Partial<SpringConfig> | number;

/** A spring curve usable as an `EasingSpec`, derived from the analytic solver. */
export interface SpringEasing {
  (t: number): number;
  /** Milliseconds the spring needs to settle, derived by the solver. */
  duration: number;
  config: SpringConfig;
  /** True when the spring overshoots its target. */
  observable: boolean;
  /** Peak overshoot ratio (0 for critical/over damped springs). */
  overshoot: number;
}
/* -------------------------------------------------------------------------- */
/* Motion specs                                                               */
/* -------------------------------------------------------------------------- */

export type TargetInput =
  | string
  | Element
  | Element[]
  | ArrayLike<Element>
  | NodeListOf<Element>
  | null
  | undefined;

export interface MotionOptions {
  /** Explicit duration in ms. When omitted it comes from the easing/spring. */
  duration?: number;
  /** Delay in ms. */
  delay?: number;
  /** Easing name, bezier points or function. `"waves-spring"` uses the Waves spring. */
  easing?: EasingSpec;
  /** Spring physics; overrides `easing` when present. */
  spring?: SpringInput;
  /** Repeat count (0 = play once). */
  repeat?: number;
  /** Play in reverse. */
  reverse?: boolean;
  /** Ping-pong each repeat (only meaningful with `repeat`). */
  yoyo?: boolean;
  /** Where to start playback from, 0 – 1. */
  from?: number;
  /** Keep the final computed values written after completion. */
  fill?: "none" | "forwards";
  /** Human/AI readable label used by the inspector. */
  label?: string;
  /** Stable id (auto-generated when omitted). */
  id?: string;
  /** Skip the DOM write path and only resolve timing (Node/CLI tooling). */
  dryRun?: boolean;
  /** Per-target stagger across the resolved target list (ms). */
  stagger?: number;
  /** Stagger ordering. */
  staggerFrom?: StaggerOrigin;
  onUpdate?: (progress: number) => void;
  onComplete?: (info: MotionLifecycleInfo) => void;
  onCancel?: (info: MotionLifecycleInfo) => void;
  onStart?: (info: MotionLifecycleInfo) => void;
}

/** A fully resolved, serialisable animation description (the OpenCode contract). */
export interface MotionSpec {
  target: string;
  animation?: PresetName | string;
  properties?: PropertyMap;
  delay?: number;
  duration?: number;
  easing?: string | CubicBezierPoints;
  spring?: Partial<SpringConfig>;
  repeat?: number;
  yoyo?: boolean;
  reverse?: boolean;
  from?: number;
  label?: string;
  /** Preset parameters, if a preset produced this spec. */
  params?: Record<string, unknown>;
  /** Resolved source chain, e.g. `["rise"]` or `["custom"]`. */
  origin?: string;
}

export interface ResolvedMotionSpec extends MotionSpec {
  /** Milliseconds, always resolved. */
  duration: number;
  /** Milliseconds, always resolved. */
  delay: number;
  easing: string | CubicBezierPoints;
  properties: PropertyMap;
  /** Performance classification for each property. */
  cost: Record<string, PropertyCost>;
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

export type PresetName =
  | "rise"
  | "drop"
  | "reveal"
  | "fade"
  | "scale-in"
  | "scale-out"
  | "blur-reveal"
  | "snap"
  | "float"
  | "stack"
  | "cascade"
  | "stagger"
  | "magnetic"
  | "parallax"
  | "expand"
  | "collapse"
  | "text-reveal"
  | "line-reveal"
  | "counter"
  | "orbit"
  | "perspective-in"
  | "perspective-out"
  | "orb-disperse"
  | "dissolve"
  | "orb-converge"
  | "node-connect"
  | "card-assemble"
  | "text-resolve"
  | "workflow-build"
  | "crm-populate"
  | "notebook-write"
  | "data-converge"
  | "system-resolve"
  | (string & {});

export interface PresetParamMeta {
  name: string;
  type: "number" | "string" | "boolean" | "enum" | "object";
  default?: unknown;
  description: string;
  values?: readonly string[];
  min?: number;
  max?: number;
}

export interface PresetDefinition {
  name: PresetName;
  /** One line summary for the AI interface + CLI listings. */
  summary: string;
  /** Longer design intent note. */
  intent: string;
  /** Which channels this preset touches (transform/filter/style/…). */
  channels: StyleChannel[];
  /** Motion tokens it consumes. */
  tokens: string[];
  params: PresetParamMeta[];
  /** Pure spec factory — no DOM access, safe in Node/CLI. */
  build: (target: string, params?: Record<string, any>) => MotionSpec;
}
/* -------------------------------------------------------------------------- */
/* Animations + timelines                                                     */
/* -------------------------------------------------------------------------- */

export type MotionState = "idle" | "running" | "paused" | "finished" | "cancelled";

export interface MotionLifecycleInfo {
  id: string;
  label?: string;
  state: MotionState;
  progress: number;
  duration: number;
  elapsed: number;
  targets: Element[];
  spec?: ResolvedMotionSpec;
  reason?: string;
}

export interface AnimationHandle {
  readonly id: string;
  readonly label?: string;
  readonly state: MotionState;
  readonly duration: number;
  readonly progress: number;
  readonly elapsed: number;
  readonly targets: Element[];
  readonly spec: ResolvedMotionSpec;
  play(): AnimationHandle;
  pause(): AnimationHandle;
  resume(): AnimationHandle;
  cancel(reason?: string): AnimationHandle;
  finish(): AnimationHandle;
  reverse(): AnimationHandle;
  seek(timeOrProgress: number, unit?: "ms" | "progress"): AnimationHandle;
  then(cb: (info: MotionLifecycleInfo) => void): Promise<MotionLifecycleInfo>;
  readonly finished: Promise<MotionLifecycleInfo>;
  on(event: MotionEventName, cb: (info: MotionLifecycleInfo) => void): () => void;
}

export type MotionEventName = "start" | "update" | "complete" | "cancel" | "pause" | "resume";

/** Structural interface every schedulable timeline child satisfies. */
export interface TimelineShim {
  readonly id: string;
  readonly duration: number;
  readonly label?: string;
  readonly state?: MotionState;
  play(...args: any[]): any;
  pause?(): any;
  resume?(): any;
  seek?(time: number, unit?: "ms" | "progress"): any;
  cancel?(reason?: string): any;
  /** Present on declarative nodes. */
  readonly spec?: ResolvedMotionSpec;
  toJSON?(): ResolvedTimelineNode;
}

export interface CallbackNode {
  kind: "callback";
  duration: number;
  label?: string;
  run: (info: { time: number; timelineId: string }) => void;
}

/** Declarative, DOM-free motion node produced by presets and `waves.enter(...)`. */
export interface MotionNode {
  kind: "motion";
  id: string;
  label: string;
  spec: ResolvedMotionSpec;
  /** Pure duration including repeats. */
  readonly duration: number;
  /** Instantiate + start the real animation. */
  play(engine?: any): AnimationHandle;
  /** Instantiate without starting. */
  build(engine?: any): AnimationHandle;
  toJSON(): ResolvedTimelineNode;
}

/** Anything a timeline can schedule. */
export type TimelineChild = TimelineShim | MotionNode | CallbackNode;

/* -------------------------------------------------------------------------- */
/* Timeline (declarative / JSON)                                              */
/* -------------------------------------------------------------------------- */

export interface TimelineSpec {
  id?: string;
  label?: string;
  repeat?: number;
  yoyo?: boolean;
  items: TimelineItemSpec[];
}

export interface TimelineItemSpec {
  at?: number;
  after?: string;
  label?: string;
  motion?: MotionSpec;
  timeline?: TimelineSpec;
  wait?: number;
}

export interface ResolvedTimelineNode {
  kind: "motion" | "timeline" | "wait" | "callback";
  id: string;
  label: string;
  start: number;
  duration: number;
  spec?: ResolvedMotionSpec;
  children?: ResolvedTimelineNode[];
  deps?: string[];
}
/* -------------------------------------------------------------------------- */
/* Stagger                                                                    */
/* -------------------------------------------------------------------------- */

export type StaggerOrigin = "first" | "last" | "center" | "edges" | "random" | "index" | "custom";

export interface StaggerOptions {
  /** Milliseconds between consecutive targets. */
  delay?: number;
  /** Ordering strategy. */
  from?: StaggerOrigin;
  /** Custom ordering function, receives index + total, returns the rank. */
  order?: (index: number, total: number) => number;
  /** When set, delays are derived from 2D grid distance instead of DOM order. */
  grid?: { columns?: number; rows?: number; origin?: StaggerOrigin };
  /** Which preset to apply to every target. */
  animation?: PresetName;
  /** Preset parameters. */
  params?: Record<string, any>;
  /** Raw properties, used when no preset is given. */
  properties?: PropertyMap;
  duration?: number;
  easing?: EasingSpec;
  spring?: SpringInput;
  /** Seeded randomness for `from: "random"`. */
  seed?: number;
  /** Reverse the resolved ordering. */
  reverse?: boolean;
  /** Cap the total spread, compressing the delay to fit the window. */
  maxSpread?: number;
}

/* -------------------------------------------------------------------------- */
/* Performance + diagnostics                                                  */
/* -------------------------------------------------------------------------- */

export type PropertyCost = "composite" | "paint" | "layout" | "expensive";

export interface PerformanceWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  hint?: string;
  animationId?: string;
  target?: string;
  property?: string;
}

export interface FrameStats {
  frames: number;
  dropped: number;
  longestFrame: number;
  averageFrame: number;
  estimatedFps: number;
}

export interface EngineSnapshot {
  version: string;
  reducedMotion: boolean;
  animations: AnimationSnapshot[];
  timelines: TimelineSnapshot[];
  warnings: PerformanceWarning[];
  frames: FrameStats;
  counts: { animations: number; running: number; timelines: number; targets: number };
}

export interface AnimationSnapshot {
  id: string;
  label?: string;
  state: MotionState;
  progress: number;
  duration: number;
  elapsed: number;
  targets: string[];
  spec: ResolvedMotionSpec;
  properties: string[];
  startTime: number;
}

export interface TimelineSnapshot {
  id: string;
  label?: string;
  duration: number;
  progress: number;
  state: MotionState;
  tree: ResolvedTimelineNode;
}
