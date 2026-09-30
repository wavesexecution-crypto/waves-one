/**
 * GSAP motion specification — the deterministic, inspectable, editable,
 * serializable representation of GSAP-driven motion.
 *
 * The AI (and the MCP tools) author specs; `GsapEngine` translates them
 * into real GSAP timelines. Nothing here imports GSAP, touches the DOM, or
 * depends on a browser — specs validate and simulate anywhere.
 */

export const GSAP_SPEC_VERSION = 1;

export type GsapOpType =
  | "tween"
  | "stagger"
  | "text"
  | "scroll"
  | "spring"
  | "motion-path"
  | "parallax"
  | "set";

/** Timeline position: absolute seconds, relative tokens, or a label. */
export type GsapPosition = number | "<" | ">" | string;

/** GSAP tween property bag: numbers or CSS strings, no functions. */
export type GsapVars = Record<string, number | string>;

export interface GsapOpBase {
  /** Stable id for modify/patch/inspect. */
  id: string;
  type: GsapOpType;
  /** CSS selector, resolved inside the engine scope. */
  target: string;
  /** Seconds. Omitted for `set`. */
  duration?: number;
  /** GSAP ease string, e.g. "power3.out". */
  ease?: string;
  /** Seconds of delay before the tween starts. */
  delay?: number;
  /** Timeline position. Defaults to end-of-timeline. */
  position?: GsapPosition;
  /** Marks this op's start for label references. */
  label?: string;
  /** When true, loops yoyo forever and is skipped under reduced motion. */
  ambient?: boolean;
  /** Skip this op when reduced motion is active (default: ambient/scroll ops). */
  skipOnReducedMotion?: boolean;
}

export interface GsapTweenOp extends GsapOpBase {
  type: "tween";
  from?: GsapVars;
  to: GsapVars;
}

export interface GsapStaggerOp extends GsapOpBase {
  type: "stagger";
  from?: GsapVars;
  to: GsapVars;
  stagger: number | { each: number; from?: "first" | "last" | "center" | "edges" | "random" };
}

export interface GsapTextOp extends GsapOpBase {
  type: "text";
  split?: "chars" | "words";
  from?: GsapVars;
  to: GsapVars;
  stagger?: number;
}

export interface GsapScrollOp extends GsapOpBase {
  type: "scroll";
  from?: GsapVars;
  to: GsapVars;
  /** Scrub smoothing (true = direct scrub). */
  scrub?: boolean | number;
  trigger?: string;
  start?: string;
  end?: string;
}

export interface GsapHouseSpring {
  stiffness: number;
  damping: number;
  mass?: number;
}

export type GsapSpringPreset = "gentle" | "snappy" | "deliberate" | "signature" | "house";

export interface GsapSpringOp extends GsapOpBase {
  type: "spring";
  from?: GsapVars;
  to: GsapVars;
  spring: GsapSpringPreset | GsapHouseSpring;
}

/** House spring physics behind the named presets (matches engine tokens). */
export const GSAP_SPRING_PRESETS: Record<GsapSpringPreset, GsapHouseSpring> = {
  house: { stiffness: 210, damping: 29, mass: 1 },
  gentle: { stiffness: 120, damping: 22, mass: 1 },
  snappy: { stiffness: 420, damping: 32, mass: 1 },
  deliberate: { stiffness: 140, damping: 26, mass: 1.4 },
  signature: { stiffness: 260, damping: 24, mass: 1 }
};

export interface GsapMotionPathOp extends GsapOpBase {
  type: "motion-path";
  /** SVG path data, waypoints, or a selector for an SVGPathElement. */
  path: string | Array<{ x: number; y: number }>;
  align?: string;
  alignOrigin?: [number, number];
  curviness?: number;
}

export interface GsapParallaxOp extends GsapOpBase {
  type: "parallax";
  /** -1..1 typical. Distance factor across the trigger window. */
  speed: number;
  trigger?: string;
  start?: string;
  end?: string;
}

export interface GsapSetOp extends GsapOpBase {
  type: "set";
  to: GsapVars;
}

export type GsapOp =
  | GsapTweenOp
  | GsapStaggerOp
  | GsapTextOp
  | GsapScrollOp
  | GsapSpringOp
  | GsapMotionPathOp
  | GsapParallaxOp
  | GsapSetOp;

export interface GsapSceneSpec {
  version: typeof GSAP_SPEC_VERSION;
  name: string;
  description?: string;
  ops: GsapOp[];
  defaults?: { duration?: number; ease?: string };
}

/** Type guard for raw (parsed-JSON) specs. */
export function isGsapSceneSpec(value: unknown): value is GsapSceneSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === GSAP_SPEC_VERSION && typeof record.name === "string" && Array.isArray(record.ops);
}
