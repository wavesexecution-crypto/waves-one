/**
 * @waves/motion — deterministic animation engine for the Waves ecosystem.
 *
 * One import site for every subsystem: the engine factory, the animation
 * primitives, springs, easing, stagger ordering, presets, timelines, scroll,
 * tokens, the property catalog and the type surface. Nothing here reaches
 * into internals; consumers never import from `./core/*` or `./animation/*`
 * directly.
 */

/* ---------------------------------- core ---------------------------------- */

import { WavesMotionEngine, MOTION_VERSION, type MotionEngineOptions, type Tickable } from "./core/engine";

/** A dedicated engine instance (tests, labs, isolated islands). */
export function createEngine(options: MotionEngineOptions = {}): WavesMotionEngine {
  return new WavesMotionEngine(options);
}

/** Configure the global engine via its config store. */
export { isReducedMotion, onReducedMotionChange } from "./core/reduced-motion";
export { ConfigStore } from "./core/config";
export type { WavesMotionConfig } from "./core/config";
export { MOTION_VERSION };

/* -------------------------------- animation ------------------------------- */

import { resolveSpec, type ResolveOptions } from "./animation/resolve";

export type { ResolveOptions, ResolvedAnimation } from "./animation/resolve";
export { Animation } from "./animation/animation";
export type { AnimationInit, ElementBinding, FrameObserver, PropertyTrack } from "./animation/animation";
export { evaluateTrackTime, queueWrite, clamp01, parseWithHints } from "./animation/evaluate";
export { buildTracksFromSpec } from "./animation/tracks";

/* --------------------------------- springs -------------------------------- */

export { normalizeSpring, createSpringEasing, springPhysics, describeSpring, springSettlingTime, sampleSpring, SpringValue } from "./spring";
export type { SpringInput } from "./types";

/* --------------------------------- easing --------------------------------- */

export { resolveEasing, listEasings, easing, easingToCss, sampleEasing, easingSparkline, describeEasing } from "./easing";
export type { ResolvedEasing, EasingInfo } from "./easing";

/* ------------------------------- properties ------------------------------- */

export { getPropertyDefinition, listProperties, classifyProperty } from "./core/properties";
export { parseValue, interpolateValues, interpolateRaw } from "./core/values";
export type { ParsedValue } from "./core/values";

/* --------------------------------- stagger -------------------------------- */

export { resolveStaggerOrder, staggerDelayFor, gridPositions } from "./sequences/order";
export type { StaggerOrderOptions } from "./sequences/order";

/* --------------------------------- presets -------------------------------- */

export {
  PRESETS,
  listPresets,
  getPreset,
  describePreset,
  runPreset,
  runPresetSpec,
  runPresetOnTargets,
  resolveMotion,
  configureStagger,
  staggerStandard
} from "./presets";
export type { ConfigureStaggerOptions } from "./presets";

/* -------------------------------- timelines ------------------------------- */

export { MotionNode, Timeline, motion, createTimeline } from "./timeline";
export type { MotionNodeInit, TimelineInit } from "./timeline";

/* ---------------------------------- scroll --------------------------------- */

export { ScrollController, createScroll } from "./scroll";
export type { ScrollEntry, ScrollEvaluateOptions } from "./scroll";

/* ---------------------------------- tokens --------------------------------- */

export { defaultMotionTokens, cloneTokens, mergeTokens } from "./core/tokens";

/* ------------------------------- gsap track ------------------------------- */

export {
  GSAP_SPEC_VERSION,
  GSAP_SPRING_PRESETS,
  BRAND_FILM_MS,
  BRAND_FILM_NAME,
  BRAND_FILM_SCENES,
  SEAI_REEL_H,
  SEAI_REEL_MS,
  SEAI_REEL_NAME,
  SEAI_REEL_SCENES,
  SEAI_REEL_W,
  SEAI_REEL_DEMOS,
  MOTION_LAB_DEMO_H,
  MOTION_LAB_DEMO_MS,
  MOTION_LAB_DEMO_NAME,
  MOTION_LAB_DEMO_W,
  MOTION_LAB_DEMO_STAGE_VERSION,
  MOTION_LAB_DEMO_SCENES,
  GsapEngine,
  buildSeaiLaunchReel,
  buildMotionLabDemo,
  buildWavesBrandFilm,
  isGsapSceneSpec,
  planTimeline,
  playGsapScene,
  validateGsapSpec
} from "./gsap";
export type {
  GsapBuildWarnings,
  GsapEngineOptions,
  GsapHouseSpring,
  GsapIssue,
  GsapMotionPathOp,
  GsapOp,
  GsapOpBase,
  GsapOpType,
  GsapParallaxOp,
  GsapPlan,
  GsapPlayback,
  GsapPlaybackState,
  GsapPosition,
  GsapSceneSpec,
  GsapScrollOp,
  GsapSetOp,
  GsapSpringOp,
  GsapSpringPreset,
  GsapStaggerOp,
  GsapTextOp,
  GsapTweenOp,
  GsapValidateOptions,
  GsapValidationReport,
  GsapVars,
  PlannedOp
} from "./gsap";

/* ---------------------------------- types --------------------------------- */

import type { TargetInput, PropertyMap } from "./types";

export type {
  MotionState,
  MotionSpec,
  MotionOptions,
  ResolvedMotionSpec,
  MotionLifecycleInfo,
  AnimationHandle,
  MotionEventName,
  TargetInput,
  PropertyMap,
  PropertyInput,
  Primitive,
  SpringConfig,
  StaggerOptions,
  StaggerOrigin,
  TimelineSpec,
  EngineSnapshot,
  PerformanceWarning
} from "./types";

/** The global engine instance backing the convenience API. */
export const engine = /* @__PURE__ */ globalEngine();

function globalEngine(): WavesMotionEngine {
  const existing = (globalThis as Record<string, unknown>).__wavesMotionEngine as WavesMotionEngine | undefined;
  if (existing) return existing;
  const created = new WavesMotionEngine({ name: "global" });
  (globalThis as Record<string, unknown>).__wavesMotionEngine = created;
  return created;
}

/* ------------------------------ public facade ----------------------------- */

export const waves = {
  /** Animate elements. Returns a handle with play/pause/seek/finished. */
  animate: (target: TargetInput, properties: PropertyMap, options: ResolveOptions = {}) =>
    engine.animate(target, properties, options),

  /** Live-update running animation values. */
  update: (target: TargetInput, properties: PropertyMap, options: ResolveOptions = {}) =>
    engine.update(target, properties, options),

  /** Cancel every animation this engine is running. */
  cancelAll: (reason?: string) => engine.cancelAll(reason),

  /** Current engine snapshot for inspectors and debuggers. */
  snapshot: () => engine.snapshot(),

  /** Machine-readable performance warnings. */
  warnings: () => engine.warnings(),

  /** The engine behind the facade (advanced use, testing). */
  engine
};

export default waves;
