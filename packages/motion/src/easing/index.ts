/**
 * Easing.
 *
 * `waves-standard`, `waves-entrance`, `waves-exit`, `waves-smooth`, `waves-snap`
 * and `waves-glide` are the Waves DNA curves. `waves-spring` is not a bezier:
 * it resolves through the real spring solver in `src/spring`, which is what
 * makes the house default feel controlled rather than approximated.
 */

import type { CubicBezierPoints, EasingFunction, EasingName, EasingSpec } from "../types";
import { fail } from "../core/errors";
import { defaultConfig, type WavesMotionConfig } from "../core/config";
import { createSpringEasing } from "../spring";

/* -------------------------------------------------------------------------- */
/* Cubic bezier                                                               */
/* -------------------------------------------------------------------------- */

export function cubicBezier(points: CubicBezierPoints): EasingFunction {
  const [x1, y1, x2, y2] = points;
  const A = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
  const B = (a1: number, a2: number) => 3 * a2 - 6 * a1;
  const C = (a1: number) => 3 * a1;
  const calc = (t: number, a1: number, a2: number) => ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
  const slope = (t: number, a1: number, a2: number) => 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton–Raphson, then bisection fallback. Eight iterations is plenty for
    // sub-pixel accuracy and keeps the per-frame cost negligible.
    let guess = t;
    for (let i = 0; i < 8; i++) {
      const current = calc(guess, x1, x2) - t;
      const derivative = slope(guess, x1, x2);
      if (Math.abs(current) < 1e-6) return calc(guess, y1, y2);
      if (Math.abs(derivative) < 1e-6) break;
      guess -= current / derivative;
    }
    let low = 0;
    let high = 1;
    guess = t;
    for (let i = 0; i < 20; i++) {
      const current = calc(guess, x1, x2);
      if (Math.abs(current - t) < 1e-6) break;
      if (current > t) high = guess;
      else low = guess;
      guess = (low + high) / 2;
    }
    return calc(guess, y1, y2);
  };
}

/* -------------------------------------------------------------------------- */
/* Named curves                                                               */
/* -------------------------------------------------------------------------- */

const linear: EasingFunction = (t) => t;
const sineOut: EasingFunction = (t) => Math.sin((t * Math.PI) / 2);
const quadOut: EasingFunction = (t) => 1 - (1 - t) * (1 - t);
const cubicOut: EasingFunction = (t) => 1 - (1 - t) ** 3;
const quartOut: EasingFunction = (t) => 1 - (1 - t) ** 4;
const expoOut: EasingFunction = (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t));
const circOut: EasingFunction = (t) => Math.sqrt(1 - (t - 1) ** 2);
const expoIn: EasingFunction = (t) => (t === 0 ? 0 : 2 ** (10 * t - 10));
const circIn: EasingFunction = (t) => 1 - Math.sqrt(1 - t ** 2);
const backOut: EasingFunction = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

/** The non-spring portion of the named easing catalogue. */
export const NAMED_EASINGS: Record<Exclude<EasingName, "waves-spring">, EasingFunction> = {
  linear,
  "waves-standard": cubicBezier(defaultConfig.tokens.easing.standard),
  "waves-entrance": cubicBezier(defaultConfig.tokens.easing.entrance),
  "waves-exit": cubicBezier(defaultConfig.tokens.easing.exit),
  "waves-smooth": cubicBezier(defaultConfig.tokens.easing.smooth),
  "waves-snap": cubicBezier(defaultConfig.tokens.easing.snap),
  "waves-glide": cubicBezier(defaultConfig.tokens.easing.glide),
  ease: cubicBezier([0.25, 0.1, 0.25, 1]),
  "ease-in": cubicBezier([0.42, 0, 1, 1]),
  "ease-out": cubicBezier([0, 0, 0.58, 1]),
  "ease-in-out": cubicBezier([0.42, 0, 0.58, 1]),
  "sine-out": sineOut,
  "quad-out": quadOut,
  "cubic-out": cubicOut,
  "quart-out": quartOut,
  "expo-out": expoOut,
  "expo-in": expoIn,
  "circ-out": circOut,
  "circ-in": circIn,
  "back-out": backOut
};

/** Every easing name the engine understands (including the spring alias). */
export const EASING_NAMES: EasingName[] = [
  "waves-standard",
  "waves-entrance",
  "waves-exit",
  "waves-smooth",
  "waves-spring",
  "waves-snap",
  "waves-glide",
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "sine-out",
  "quad-out",
  "cubic-out",
  "quart-out",
  "expo-out",
  "expo-in",
  "circ-out",
  "circ-in",
  "back-out"
];

export function isEasingName(value: unknown): value is EasingName {
  return typeof value === "string" && (EASING_NAMES as string[]).includes(value);
}
/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolvedEasing {
  /** The curve. */
  fn: EasingFunction;
  /** Canonical name for the schema/inspector (`waves-entrance`, `waves-spring`…). */
  name: string;
  /** True when the curve came from the spring solver. */
  spring: boolean;
  /** Milliseconds, when the curve defines its own natural duration (springs do). */
  duration?: number;
  /** Bezier points when applicable — used by the inspector's curve preview. */
  points?: CubicBezierPoints;
  /** Spring config when applicable. */
  springConfig?: { stiffness: number; damping: number; mass: number; velocity?: number };
}

/** Return the bezier points behind a Waves token curve (for previews + schema). */
export function easingTokenPoints(name: EasingName, config?: WavesMotionConfig): CubicBezierPoints | undefined {
  const tokens = (config ?? defaultConfig).tokens.easing as unknown as Record<string, unknown>;
  const mapped: Record<string, string> = {
    "waves-standard": "standard",
    "waves-entrance": "entrance",
    "waves-exit": "exit",
    "waves-smooth": "smooth",
    "waves-snap": "snap",
    "waves-glide": "glide"
  };
  const key = mapped[name as string];
  const value = key ? tokens[key] : undefined;
  return Array.isArray(value) ? (value as CubicBezierPoints) : undefined;
}

/**
 * Resolve any easing spec into a curve plus metadata.
 * Springs resolve through the real solver, so their duration is derived
 * analytically rather than invented.
 */
export function resolveEasing(spec?: EasingSpec, config?: WavesMotionConfig): ResolvedEasing {
  const effective = spec ?? config?.defaultEasing ?? defaultConfig.defaultEasing;

  if (typeof effective === "function") {
    return { fn: effective as EasingFunction, name: "custom-fn", spring: false };
  }

  if (Array.isArray(effective)) {
    const points = effective as CubicBezierPoints;
    return { fn: cubicBezier(points), name: `cubic-bezier(${points.join(", ")})`, spring: false, points };
  }

  if (effective === "waves-spring") {
    const springConfig = config?.spring ?? defaultConfig.spring;
    const easingFn = createSpringEasing(springConfig);
    return {
      fn: easingFn,
      name: "waves-spring",
      spring: true,
      duration: easingFn.duration,
      springConfig: {
        stiffness: easingFn.config.stiffness,
        damping: easingFn.config.damping,
        mass: easingFn.config.mass,
        velocity: easingFn.config.velocity
      }
    };
  }

  const curve = NAMED_EASINGS[effective as Exclude<EasingName, "waves-spring">];
  if (!curve) {
    fail("MOTION_UNKNOWN_EASING", `Unknown easing "${String(effective)}".`, {
      easing: String(effective),
      available: EASING_NAMES
    });
  }
  return {
    fn: curve,
    name: effective as string,
    spring: false,
    points: easingTokenPoints(effective as EasingName, config)
  };
}

/** Convenience for imperative callers: `waves.easing("waves-entrance")` → function. */
export function easing(spec: EasingSpec): EasingFunction {
  return resolveEasing(spec).fn;
}

/** Human description used by the inspector and the CLI. */
export function describeEasing(spec?: EasingSpec, config?: WavesMotionConfig): string {
  const resolved = resolveEasing(spec, config);
  if (resolved.spring) {
    const spring = resolved.springConfig!;
    return `waves-spring (k=${spring.stiffness}, c=${spring.damping}, m=${spring.mass}${spring.velocity ? `, v=${spring.velocity}` : ""}) → ${Math.round(resolved.duration ?? 0)}ms`;
  }
  return resolved.name;
}

/** Sample a curve for the inspector's curve preview / CLI chart. */
export function sampleEasing(spec?: EasingSpec, count = 24, config?: WavesMotionConfig): number[] {
  const { fn } = resolveEasing(spec, config);
  const samples: number[] = [];
  for (let i = 0; i <= count; i++) samples.push(Number(fn(i / count).toFixed(4)));
  return samples;
}
/** Render a tiny ASCII curve — used by `waves-motion easing <name>`. */
export function easingSparkline(spec: EasingSpec | undefined, width = 56, height = 7): string {
  const samples = sampleEasing(spec, width - 1);
  const rows: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    let line = "";
    for (const value of samples) {
      const level = Math.round((Math.min(Math.max(value, 0), 1.2) / 1.2) * (height - 1));
      line += level === row ? "*" : " ";
    }
    rows.push(line);
  }
  return rows.join("\n");
}

/** Catalogue metadata for the schema, docs and CLI listings. */
export interface EasingInfo {
  name: EasingName;
  spring: boolean;
  points?: CubicBezierPoints;
  duration?: number;
  description: string;
}

const EASING_NOTES: Record<string, string> = {
  "waves-standard": "House default. Precise settle with no overshoot.",
  "waves-entrance": "Content arriving. Decisive, settles fast.",
  "waves-exit": "Content leaving. Accelerates away, never lingers.",
  "waves-smooth": "Continuous / scrubbed motion (float, marquee, scroll).",
  "waves-spring": "The Waves spring — controlled, essentially critically damped.",
  "waves-snap": "Hard, technical settle for UI chrome.",
  "waves-glide": "Long tail for depth and parallax layers.",
  linear: "Constant rate. Reserved for scrubbed progress.",
  "back-out": "Slight overshoot. Use only for deliberate signature moments."
};

export function listEasings(config?: WavesMotionConfig): EasingInfo[] {
  return EASING_NAMES.map((name) => {
    const resolved = resolveEasing(name, config);
    return {
      name,
      spring: resolved.spring,
      points: resolved.points,
      duration: resolved.duration,
      description: EASING_NOTES[name] ?? "Utility curve."
    };
  });
}

/**
 * Convert any easing into a CSS timing function. CSS cannot express a spring,
 * so springs are sampled into a `linear(...)` approximation — that keeps CSS
 * exports faithful instead of silently degrading to `ease`.
 */
export function easingToCss(spec?: EasingSpec, config?: WavesMotionConfig): string {
  const resolved = resolveEasing(spec, config);
  if (resolved.spring) {
    const samples = sampleEasing(spec, 12, config);
    return `linear(${samples.map((value) => value.toFixed(4)).join(", ")})`;
  }
  if (resolved.points) return `cubic-bezier(${resolved.points.join(", ")})`;
  if (resolved.name === "linear") return "linear";
  if (resolved.name === "ease") return "ease";
  if (resolved.name === "custom-fn") {
    const samples = sampleEasing(spec, 12, config);
    return `linear(${samples.map((value) => value.toFixed(4)).join(", ")})`;
  }
  return "linear";
}