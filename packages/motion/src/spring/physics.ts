/**
 * Spring physics — closed-form damped harmonic oscillator.
 *
 *     m·x'' + c·x' + k·x = 0
 *     ω₀ = √(k/m)          natural frequency
 *     ζ  = c / (2·√(k·m))  damping ratio
 *
 * Because the solution is analytic the engine can evaluate a spring at any
 * progress without integration drift, derive its settling time instead of
 * guessing a duration, and report overshoot for the design guardrails.
 *
 * The Waves default spring is essentially critically damped (ζ ≈ 1): it lands
 * with intent and no visible bounce.
 */

import type { SpringConfig, SpringEasing, SpringInput } from "../types";
import { defaultMotionTokens } from "../core/tokens";
import { clamp } from "../core/values";

/** ζ below this counts as observable overshoot in the design guardrails. */
export const OVERSHOOT_ZETA = 0.95;

export function normalizeSpring(input?: SpringInput, fallback: SpringConfig = defaultMotionTokens.spring.waves): SpringConfig {
  if (input === undefined) return { ...fallback };
  if (typeof input === "number") return { ...fallback, stiffness: input };
  return {
    stiffness: input.stiffness ?? fallback.stiffness,
    damping: input.damping ?? fallback.damping,
    mass: input.mass ?? fallback.mass,
    velocity: input.velocity ?? fallback.velocity,
    restDelta: input.restDelta ?? fallback.restDelta ?? 0.01,
    restSpeed: input.restSpeed ?? fallback.restSpeed ?? 0.2
  };
}

export interface SpringPhysics {
  omega0: number;
  zeta: number;
  /** Damped frequency (0 when critically or over damped). */
  omegaD: number;
  r1: number;
  r2: number;
  underdamped: boolean;
  criticallyDamped: boolean;
  overdamped: boolean;
  /** Peak overshoot ratio (0 when not observable). */
  overshoot: number;
  /** Natural period in ms (0 when not oscillating). */
  period: number;
}

export function springPhysics(config: SpringConfig): SpringPhysics {
  const k = Math.max(0.0001, config.stiffness);
  const c = Math.max(0, config.damping);
  const m = Math.max(0.0001, config.mass);
  const omega0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  const underdamped = zeta < 1 - 1e-6;
  const criticallyDamped = Math.abs(zeta - 1) <= 1e-6;
  const omegaD = underdamped ? omega0 * Math.sqrt(1 - zeta * zeta) : 0;
  const root = Math.sqrt(Math.max(0, zeta * zeta - 1));
  return {
    omega0,
    zeta,
    omegaD,
    r1: -omega0 * (zeta - root),
    r2: -omega0 * (zeta + root),
    underdamped,
    criticallyDamped,
    overdamped: zeta > 1 + 1e-6,
    overshoot: underdamped ? Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta)) : 0,
    period: omegaD > 0 ? (2 * Math.PI) / omegaD : 0
  };
}

/**
 * Displacement x(t) for a value settling from `amplitude` to 0, with initial
 * velocity `v0` expressed in distance units per second (normalised).
 */
function solve(physics: SpringPhysics, seconds: number, amplitude: number, v0: number): number {
  const scaledV0 = -v0 * amplitude;
  if (physics.underdamped) {
    const { omegaD, omega0, zeta } = physics;
    const envelope = Math.exp(-zeta * omega0 * seconds);
    const cos = Math.cos(omegaD * seconds);
    const sin = Math.sin(omegaD * seconds);
    const term = (scaledV0 + zeta * omega0 * amplitude) / omegaD;
    return envelope * (amplitude * cos + term * sin);
  }
  if (physics.criticallyDamped) {
    const { omega0 } = physics;
    const c2 = scaledV0 + omega0 * amplitude;
    return (amplitude + c2 * seconds) * Math.exp(-omega0 * seconds);
  }
  const { r1, r2 } = physics;
  const c2 = (scaledV0 - r1 * amplitude) / (r2 - r1);
  const c1 = amplitude - c2;
  return c1 * Math.exp(r1 * seconds) + c2 * Math.exp(r2 * seconds);
}

/** Derivative of `solve` (distance units per second). */
function solveVelocity(physics: SpringPhysics, seconds: number, amplitude: number, v0: number): number {
  const scaledV0 = -v0 * amplitude;
  if (physics.underdamped) {
    const { omegaD, omega0, zeta } = physics;
    const envelope = Math.exp(-zeta * omega0 * seconds);
    const cos = Math.cos(omegaD * seconds);
    const sin = Math.sin(omegaD * seconds);
    const term = (scaledV0 + zeta * omega0 * amplitude) / omegaD;
    const displacement = envelope * (amplitude * cos + term * sin);
    return -zeta * omega0 * displacement + envelope * (-amplitude * omegaD * sin + term * omegaD * cos);
  }
  if (physics.criticallyDamped) {
    const { omega0 } = physics;
    const c2 = scaledV0 + omega0 * amplitude;
    return (c2 - omega0 * (amplitude + c2 * seconds)) * Math.exp(-omega0 * seconds);
  }
  const { r1, r2 } = physics;
  const c2 = (scaledV0 - r1 * amplitude) / (r2 - r1);
  const c1 = amplitude - c2;
  return c1 * r1 * Math.exp(r1 * seconds) + c2 * r2 * Math.exp(r2 * seconds);
}

/** Normalised spring value (0 → 1) at time `t` ms. */
export function springValuedAt(config: SpringConfig, t: number, velocity = 0): number {
  const physics = springPhysics(config);
  if (t <= 0) return 0;
  return clamp(1 - solve(physics, t / 1000, 1, velocity), -0.5, 1.5);
}

/** Normalised spring velocity at time `t` ms, in distance units per second. */
export function springVelocityAt(config: SpringConfig, t: number, velocity = 0): number {
  const physics = springPhysics(config);
  if (t <= 0) return velocity;
  return -solveVelocity(physics, t / 1000, 1, velocity);
}
/**
 * Settling time in ms: the first time the spring is inside the rest thresholds
 * and stays there. Derived by scanning the closed-form solution at 4ms
 * granularity — deterministic, no integration, evaluated once per animation.
 */
export function springSettlingTime(config: SpringConfig, velocity = 0): number {
  const restDelta = config.restDelta ?? 0.01;
  const restSpeed = config.restSpeed ?? 0.2;
  const physics = springPhysics(config);
  const maxTime = 12000;
  const step = 4;
  let lastOutside = 0;

  for (let t = step; t <= maxTime; t += step) {
    const displacement = solve(physics, t / 1000, 1, velocity);
    const speed = Math.abs(solveVelocity(physics, t / 1000, 1, velocity));
    const outside = Math.abs(displacement) > restDelta || speed > restSpeed;
    if (outside) {
      lastOutside = t;
      continue;
    }
    if (lastOutside === 0) return t;
    if (t - lastOutside >= step * 2) return lastOutside + step * 2;
  }
  return maxTime;
}

/**
 * Build a spring usable as an easing curve: `f(0) = 0`, `f(1) = 1`, with the
 * normalised progress following the real spring motion.
 */
export function createSpringEasing(input?: SpringInput, fallback?: SpringConfig): SpringEasing {
  const config = normalizeSpring(input, fallback ?? defaultMotionTokens.spring.waves);
  const physics = springPhysics(config);
  const velocity = config.velocity ?? 0;
  const duration = Math.max(1, springSettlingTime(config, velocity));

  const fn = ((t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return clamp(1 - solve(physics, (t * duration) / 1000, 1, velocity), -0.5, 1.5);
  }) as SpringEasing;

  fn.duration = duration;
  fn.config = config;
  fn.observable = physics.zeta < OVERSHOOT_ZETA;
  fn.overshoot = physics.overshoot;
  return fn;
}

/** Describe a spring for the inspector / CLI (`ζ`, settling time, overshoot). */
export interface SpringReport {
  config: SpringConfig;
  zeta: number;
  omega0: number;
  duration: number;
  overshoot: number;
  observable: boolean;
  verdict: "restrained" | "controlled" | "bouncy";
  description: string;
}

export function describeSpring(input?: SpringInput): SpringReport {
  const config = normalizeSpring(input);
  const physics = springPhysics(config);
  const duration = springSettlingTime(config, config.velocity ?? 0);
  const verdict = physics.overshoot > 0.12 ? "bouncy" : physics.zeta < OVERSHOOT_ZETA ? "controlled" : "restrained";
  return {
    config,
    zeta: Number(physics.zeta.toFixed(4)),
    omega0: Number(physics.omega0.toFixed(4)),
    duration,
    overshoot: Number(physics.overshoot.toFixed(4)),
    observable: physics.zeta < OVERSHOOT_ZETA,
    verdict,
    description: `ζ=${physics.zeta.toFixed(2)}, settles in ${duration}ms, overshoot ${(physics.overshoot * 100).toFixed(1)}%`
  };
}

/** Sample a spring curve for previews, docs and the CLI chart. */
export function sampleSpring(input?: SpringInput, count = 24): number[] {
  const curve = createSpringEasing(input);
  const samples: number[] = [];
  for (let i = 0; i <= count; i++) samples.push(Number(curve(i / count).toFixed(4)));
  return samples;
}

/** Render a tiny ASCII curve of a spring's motion. */
export function springSparkline(input?: SpringInput, width = 56, height = 7): string {
  const samples = sampleSpring(input, width - 1);
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

/** The house springs, exposed for products that need to name them explicitly. */
export const wavesSprings = defaultMotionTokens.spring;

/** `waves.spring({ stiffness, damping, mass, velocity })` */
export function spring(input?: SpringInput): SpringEasing {
  return createSpringEasing(input);
}