/**
 * Waves Motion DNA â€” the central motion tokens.
 *
 * This is the single source of truth for how Waves moves. Every product that
 * consumes the engine inherits the same DNA: the same durations, the same
 * curves, the same distances. Products may override tokens *centrally* through
 * `waves.configure({ tokens })` â€” never per animation.
 *
 * Design intent: precise, expensive, restrained, technical, fast, intentional.
 * No gratuitous bounce, no cartoon physics, no exaggerated easing.
 */

import type { CubicBezierPoints, SpringConfig } from "../types";

export interface DurationTokens {
  /** State feedback only â€” press, toggle, hover settle. */
  instant: number;
  /** UI micro-motion: hovers, fades, small offsets. */
  fast: number;
  /** The house default for content entrance / reveal. */
  normal: number;
  /** Hero moments, card stacks, section reveals. */
  deliberate: number;
  /** Full-page or flagship sequences. */
  cinematic: number;
}

export interface EasingTokens {
  /** Default for anything moving on screen with no other intent. */
  standard: CubicBezierPoints;
  /** Content arriving. Decisive, settles fast, never bounces. */
  entrance: CubicBezierPoints;
  /** Content leaving. Accelerates away, never lingers. */
  exit: CubicBezierPoints;
  /** Continuous, looping or scrubbed motion (float, marquee, scroll). */
  smooth: CubicBezierPoints;
  /** Named spring curve; resolves to the Waves spring solver, not a bezier. */
  wavesSpring: "waves-spring";
  /** Very short, hard settle for technical/UI chrome. */
  snap: CubicBezierPoints;
  /** Long tail for parallax and depth layers. */
  glide: CubicBezierPoints;
}

export interface DistanceTokens {
  micro: number;
  small: number;
  medium: number;
  large: number;
  /** Deliberate maximum for hero entrance travel. */
  hero: number;
}

export interface ScaleTokens {
  press: number;
  hover: number;
  enter: number;
  exit: number;
  /** Depth-layer settle used by the product card sequence. */
  depth: number;
}

export interface BlurTokens {
  subtle: number;
  soft: number;
  strong: number;
}

export interface OpacityTokens {
  veil: number;
  ghost: number;
  faint: number;
}

export interface StaggerTokens {
  tight: number;
  standard: number;
  loose: number;
  deliberate: number;
}

export interface SpringTokens {
  /** House default: controlled, essentially critically damped, no visible bounce. */
  waves: SpringConfig;
  /** Faster settle for interactive elements. */
  snappy: SpringConfig;
  /** Slower, heavier â€” layout and depth moves. */
  deliberate: SpringConfig;
  /** Allows one barely perceptible settle. Reserved for signature moments. */
  signature: SpringConfig;
}

export interface MotionTokens {
  duration: DurationTokens;
  easing: EasingTokens;
  distance: DistanceTokens;
  scale: ScaleTokens;
  blur: BlurTokens;
  opacity: OpacityTokens;
  stagger: StaggerTokens;
  spring: SpringTokens;
  perspective: { shallow: number; deep: number };
  rotate: { micro: number; tiny: number };
}

export const defaultMotionTokens: MotionTokens = {
  duration: {
    instant: 80,
    fast: 180,
    normal: 350,
    deliberate: 650,
    cinematic: 1000
  },
  easing: {
    standard: [0.32, 0.72, 0, 1],
    entrance: [0.16, 1, 0.3, 1],
    exit: [0.4, 0, 1, 1],
    smooth: [0.4, 0, 0.2, 1],
    wavesSpring: "waves-spring",
    snap: [0.2, 0.9, 0.1, 1],
    glide: [0.22, 0.61, 0.36, 1]
  },
  distance: {
    micro: 4,
    small: 12,
    medium: 24,
    large: 48,
    hero: 72
  },
  scale: {
    press: 0.98,
    hover: 1.02,
    enter: 0.96,
    exit: 0.985,
    depth: 0.995
  },
  blur: {
    subtle: 4,
    soft: 8,
    strong: 16
  },
  opacity: {
    veil: 0.06,
    ghost: 0.2,
    faint: 0.45
  },
  stagger: {
    tight: 60,
    standard: 120,
    loose: 200,
    deliberate: 320
  },
  spring: {
    // Î¶ â‰ˆ 1.0 â€” critically damped. Feels engineered, not rubbery.
    waves: { stiffness: 210, damping: 29, mass: 1, restDelta: 0.02, restSpeed: 0.25 },
    snappy: { stiffness: 420, damping: 34, mass: 1, restDelta: 0.02, restSpeed: 0.4 },
    deliberate: { stiffness: 120, damping: 26, mass: 1.2, restDelta: 0.02, restSpeed: 0.2 },
    // Î¶ â‰ˆ 0.92 â€” one barely perceptible settle, for signature moments only.
    signature: { stiffness: 180, damping: 24, mass: 1, restDelta: 0.015, restSpeed: 0.2 }
  },
  perspective: { shallow: 600, deep: 1200 },
  rotate: { micro: 1, tiny: 2 }
};

/** Deep-clone the tokens (config merging must never mutate the house DNA). */
export function cloneTokens(tokens: MotionTokens = defaultMotionTokens): MotionTokens {
  return {
    duration: { ...tokens.duration },
    easing: { ...tokens.easing },
    distance: { ...tokens.distance },
    scale: { ...tokens.scale },
    blur: { ...tokens.blur },
    opacity: { ...tokens.opacity },
    stagger: { ...tokens.stagger },
    spring: {
      waves: { ...tokens.spring.waves },
      snappy: { ...tokens.spring.snappy },
      deliberate: { ...tokens.spring.deliberate },
      signature: { ...tokens.spring.signature }
    },
    perspective: { ...tokens.perspective },
    rotate: { ...tokens.rotate }
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Per-branch merge used by `waves.configure({ tokens })`. */
export function mergeTokens(base: MotionTokens, patch?: DeepPartial<MotionTokens>): MotionTokens {
  if (!patch) return cloneTokens(base);
  const clone = cloneTokens(base);
  const merge = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> => {
    if (!source) return target;
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (value === undefined) continue;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        target[key] = merge({ ...(target[key] ?? {}) }, value as Record<string, any>);
      } else {
        target[key] = value;
      }
    }
    return target;
  };
  return merge(clone as unknown as Record<string, any>, patch as Record<string, any>) as unknown as MotionTokens;
}
