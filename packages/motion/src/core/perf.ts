/**
 * Performance analysis + warnings.
 *
 * "Performance is mandatory." This module turns the engine's runtime knowledge
 * into actionable, machine-readable warnings surfaced through the inspector and
 * the CLI. It never blocks an animation — it explains the cost.
 */

import type { FrameStats, PerformanceWarning, PropertyCost, ResolvedMotionSpec } from "../types";
import { classifyProperty } from "./properties";

/** Thresholds that define "acceptable" Waves motion. */
export interface PerformanceThresholds {
  maxConcurrentAnimations: number;
  longAnimationThreshold: number;
  /** Blur radii above this are treated as expensive filters. */
  expensiveBlur: number;
  /** Simultaneous layout-animating elements above this is flagged. */
  maxLayoutAnimations: number;
  /** Dropped frames above this in a session counts as an error. */
  maxDroppedFrames: number;
}

export const defaultThresholds: PerformanceThresholds = {
  maxConcurrentAnimations: 64,
  longAnimationThreshold: 2500,
  expensiveBlur: 12,
  maxLayoutAnimations: 4,
  maxDroppedFrames: 0
};

export interface CostProfile {
  composite: number;
  paint: number;
  layout: number;
  expensive: number;
  /** 0 (free) → 100 (likely to jank). */
  score: number;
  properties: Record<string, PropertyCost>;
  verdict: "composite-only" | "paint-work" | "layout-work" | "expensive";
}

/** Analyse the cost of a single spec. */
export function analyzeCost(properties: Record<string, PropertyCost>, spec?: ResolvedMotionSpec): CostProfile {
  const counts = { composite: 0, paint: 0, layout: 0, expensive: 0 };
  for (const cost of Object.values(properties)) counts[cost] += 1;

  let score = counts.composite + counts.paint * 12 + counts.layout * 25 + counts.expensive * 35;
  if (spec?.duration && spec.duration > defaultThresholds.longAnimationThreshold) score += 10;
  score = Math.min(100, score);

  const verdict: CostProfile["verdict"] = counts.expensive
    ? "expensive"
    : counts.layout
      ? "layout-work"
      : counts.paint
        ? "paint-work"
        : "composite-only";

  return { ...counts, score, properties, verdict };
}

export interface WarningInput {
  animations: {
    id: string;
    label?: string;
    state: string;
    duration: number;
    spec: ResolvedMotionSpec;
    targets: string[];
  }[];
  frames: FrameStats;
  thresholds?: Partial<PerformanceThresholds>;
}

/** Extract the largest numeric value from any authored property input. */
export function extractMaxNumber(input: unknown): number {
  if (typeof input === "number") return input;
  if (typeof input === "string") {
    const parsed = parseFloat(input);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (Array.isArray(input)) return Math.max(0, ...input.map((value) => extractMaxNumber(value)));
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if ("from" in record || "to" in record) {
      return Math.max(extractMaxNumber(record.from), extractMaxNumber(record.to));
    }
    return Math.max(0, ...Object.values(record).map((value) => extractMaxNumber(value)));
  }
  return 0;
}

/** Classify a single property outside of a spec (CLI helpers + docs). */
export function classify(property: string): PropertyCost {
  return classifyProperty(property);
}
/** Run every performance rule and return the ordered warning list. */
export function collectWarnings(input: WarningInput): PerformanceWarning[] {
  const thresholds = { ...defaultThresholds, ...(input.thresholds ?? {}) };
  const warnings: PerformanceWarning[] = [];
  const running = input.animations.filter((animation) => animation.state === "running");

  /* --- concurrency --------------------------------------------------- */
  if (running.length > thresholds.maxConcurrentAnimations) {
    warnings.push({
      code: "MOTION_TOO_MANY_ANIMATIONS",
      severity: "warning",
      message: `${running.length} animations are running simultaneously (limit ${thresholds.maxConcurrentAnimations}).`,
      hint: "Split the moment into a timeline with stagger instead of starting everything at once."
    });
  }

  /* --- per-property cost --------------------------------------------- */
  const layoutElements = new Set<string>();
  for (const animation of input.animations) {
    const cost = animation.spec.cost ?? {};
    for (const [property, value] of Object.entries(cost)) {
      if (value === "layout") {
        for (const target of animation.targets) layoutElements.add(`${target}:${property}`);
        warnings.push({
          code: "MOTION_LAYOUT_PROPERTY",
          severity: "warning",
          message: `Animating "${property}" triggers layout.`,
          hint: "Prefer transform/opacity (x, y, scale, opacity). Use width/height only for genuine expand/collapse.",
          animationId: animation.id,
          property
        });
      }
      if (value === "expensive") {
        warnings.push({
          code: "MOTION_EXPENSIVE_FILTER",
          severity: "warning",
          message: `Animating "${property}" is expensive to repaint.`,
          hint: "Use the `blur-reveal` preset's restrained 8px blur, or swap to opacity for depth.",
          animationId: animation.id,
          property
        });
      }
    }

    const authored = animation.spec.properties as Record<string, unknown> | undefined;
    const blur = authored?.blur === undefined ? 0 : extractMaxNumber(authored.blur);
    if (blur > thresholds.expensiveBlur) {
      warnings.push({
        code: "MOTION_HEAVY_BLUR",
        severity: "warning",
        message: `Blur radius ${blur}px exceeds the Waves restrained limit (${thresholds.expensiveBlur}px).`,
        hint: "Waves depth uses 4–8px of blur. Larger radii force a full-layer repaint every frame.",
        animationId: animation.id,
        property: "blur"
      });
    }

    if (animation.duration > thresholds.longAnimationThreshold) {
      warnings.push({
        code: "MOTION_LONG_ANIMATION",
        severity: "info",
        message: `Animation "${animation.label ?? animation.id}" runs for ${Math.round(animation.duration)}ms.`,
        hint: "Long-running motion should be a deliberate showpiece or driven by scroll progress.",
        animationId: animation.id
      });
    }
  }

  if (layoutElements.size > thresholds.maxLayoutAnimations) {
    warnings.push({
      code: "MOTION_LAYOUT_STORM",
      severity: "error",
      message: `${layoutElements.size} layout-animating elements at once. Expect dropped frames and layout thrash.`,
      hint: "Reduce the number of layout properties, or animate a transform on a wrapper instead."
    });
  }

  /* --- runtime frame health ------------------------------------------ */
  if (input.frames.frames > 0 && input.frames.dropped > thresholds.maxDroppedFrames) {
    warnings.push({
      code: "MOTION_DROPPED_FRAMES",
      severity: input.frames.dropped > 12 ? "error" : "warning",
      message: `${input.frames.dropped} dropped frame(s) of ${input.frames.frames} (longest ${input.frames.longestFrame}ms, ~${input.frames.estimatedFps}fps).`,
      hint: "Check for layout-animating properties or too many simultaneous filter animations."
    });
  }

  return warnings;
}