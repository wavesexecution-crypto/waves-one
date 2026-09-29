/**
 * @waves/motion gsap track — structured specs, validation, planning, and the
 * deterministic GSAP executor. The house engine is untouched; this is the
 * additional first-class browser engine for DOM/SVG motion.
 */

export {
  GSAP_SPEC_VERSION,
  GSAP_SPRING_PRESETS,
  isGsapSceneSpec,
  type GsapHouseSpring,
  type GsapMotionPathOp,
  type GsapOp,
  type GsapOpBase,
  type GsapOpType,
  type GsapParallaxOp,
  type GsapPosition,
  type GsapSceneSpec,
  type GsapScrollOp,
  type GsapSetOp,
  type GsapSpringOp,
  type GsapSpringPreset,
  type GsapStaggerOp,
  type GsapTextOp,
  type GsapTweenOp
} from "./spec";
export { planTimeline, type GsapPlan, type PlannedOp } from "./plan";
export { validateGsapSpec, type GsapIssue, type GsapValidateOptions, type GsapValidationReport } from "./validate";
export { GsapEngine, playGsapScene, type GsapBuildWarnings, type GsapEngineOptions, type GsapPlayback, type GsapPlaybackState } from "./engine";
