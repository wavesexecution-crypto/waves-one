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
  type GsapTweenOp,
  type GsapVars
} from "./spec";
export { BRAND_FILM_MS, BRAND_FILM_NAME, BRAND_FILM_SCENES, buildWavesBrandFilm } from "./brand-film";
export {
  SEAI_REEL_H,
  SEAI_REEL_MS,
  SEAI_REEL_NAME,
  SEAI_REEL_SCENES,
  SEAI_REEL_W,
  SEAI_REEL_DEMOS,
  buildSeaiLaunchReel
} from "./seai-launch-reel";
export {
  MOTION_LAB_DEMO_H,
  MOTION_LAB_DEMO_MS,
  MOTION_LAB_DEMO_NAME,
  MOTION_LAB_DEMO_W,
  MOTION_LAB_DEMO_STAGE_VERSION,
  MOTION_LAB_DEMO_SCENES,
  buildMotionLabDemo
} from "./motion-lab-demo";
export { planTimeline, type GsapPlan, type PlannedOp } from "./plan";
export { validateGsapSpec, type GsapIssue, type GsapValidateOptions, type GsapValidationReport } from "./validate";
export { GsapEngine, playGsapScene, type GsapBuildWarnings, type GsapEngineOptions, type GsapPlayback, type GsapPlaybackState } from "./engine";
