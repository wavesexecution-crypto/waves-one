/**
 * Velocity-aware spring state.
 *
 * Unlike the easing curve, `SpringValue` keeps position *and* velocity so an
 * animation can be interrupted mid-flight and continue from the velocity it
 * already had — the behaviour required by gestures, layout transitions and any
 * animation that is retargeted while running.
 */

import type { SpringConfig } from "../types";
import { springPhysics } from "./physics";
import { normalizeSpring } from "./physics";

export class SpringValue {
  private position = 0;
  private currentVelocity = 0;

  constructor(
    public target: number,
    private config: SpringConfig = normalizeSpring()
  ) {}

  get value(): number {
    return this.position;
  }

  get velocity(): number {
    return this.currentVelocity;
  }

  get settings(): SpringConfig {
    return this.config;
  }

  /** Set the current value, optionally carrying velocity (interruption). */
  set(position: number, velocity = 0): void {
    this.position = position;
    this.currentVelocity = velocity;
  }

  /** Aim at a new target without resetting position or velocity. */
  retarget(target: number, velocity?: number): void {
    this.target = target;
    if (velocity !== undefined) this.currentVelocity = velocity;
  }

  reconfigure(config: SpringConfig): void {
    this.config = config;
  }

  /**
   * Step the spring by `deltaMs` using the analytic solution over that window,
   * normalised against the remaining distance so real velocity is carried.
   */
  step(deltaMs: number): { value: number; velocity: number; settled: boolean } {
    const distance = this.target - this.position;
    const restDelta = this.config.restDelta ?? 0.01;
    const restSpeed = this.config.restSpeed ?? 0.2;

    if (Math.abs(distance) < restDelta && Math.abs(this.currentVelocity) < restSpeed) {
      this.position = this.target;
      this.currentVelocity = 0;
      return { value: this.position, velocity: 0, settled: true };
    }

    const normalisedVelocity = distance === 0 ? 0 : this.currentVelocity / distance;
    const physics = springPhysics(this.config);
    const seconds = Math.max(0.0001, deltaMs / 1000);

    // Evaluate the analytic solution across the window and translate back:
    //   y(t) is the remaining fraction of the distance, so
    //   position = start + (1 − y)·distance  and  velocity = −y′·distance.
    const before = evaluate(physics, 0, normalisedVelocity);
    const after = evaluate(physics, seconds, normalisedVelocity);
    const afterVelocity = evaluateVelocity(physics, seconds, normalisedVelocity);

    this.position += (before - after) * distance;
    this.currentVelocity = -afterVelocity * distance;

    const settled = Math.abs(this.target - this.position) < restDelta && Math.abs(this.currentVelocity) < restSpeed;
    if (settled) {
      this.position = this.target;
      this.currentVelocity = 0;
    }
    return { value: this.position, velocity: this.currentVelocity, settled };
  }
}

/** Local copies of the closed-form solution, kept private to the stateful spring. */
function evaluate(physics: ReturnType<typeof springPhysics>, seconds: number, v0: number): number {
  const amplitude = 1;
  if (physics.underdamped) {
    const { omegaD, omega0, zeta } = physics;
    const envelope = Math.exp(-zeta * omega0 * seconds);
    const term = (-v0 + zeta * omega0 * amplitude) / omegaD;
    return envelope * (amplitude * Math.cos(omegaD * seconds) + term * Math.sin(omegaD * seconds));
  }
  if (physics.criticallyDamped) {
    const { omega0 } = physics;
    const c2 = -v0 + omega0 * amplitude;
    return (amplitude + c2 * seconds) * Math.exp(-omega0 * seconds);
  }
  const { r1, r2 } = physics;
  const c2 = (-v0 - r1 * amplitude) / (r2 - r1);
  const c1 = amplitude - c2;
  return c1 * Math.exp(r1 * seconds) + c2 * Math.exp(r2 * seconds);
}

function evaluateVelocity(physics: ReturnType<typeof springPhysics>, seconds: number, v0: number): number {
  const amplitude = 1;
  if (physics.underdamped) {
    const { omegaD, omega0, zeta } = physics;
    const envelope = Math.exp(-zeta * omega0 * seconds);
    const term = (-v0 + zeta * omega0 * amplitude) / omegaD;
    const displacement = envelope * (amplitude * Math.cos(omegaD * seconds) + term * Math.sin(omegaD * seconds));
    return -zeta * omega0 * displacement + envelope * (-amplitude * omegaD * Math.sin(omegaD * seconds) + term * omegaD * Math.cos(omegaD * seconds));
  }
  if (physics.criticallyDamped) {
    const { omega0 } = physics;
    const c2 = -v0 + omega0 * amplitude;
    return (c2 - omega0 * (amplitude + c2 * seconds)) * Math.exp(-omega0 * seconds);
  }
  const { r1, r2 } = physics;
  const c2 = (-v0 - r1 * amplitude) / (r2 - r1);
  const c1 = amplitude - c2;
  return c1 * r1 * Math.exp(r1 * seconds) + c2 * r2 * Math.exp(r2 * seconds);
}

/**
 * Convert a physical velocity (px/s) into the normalised velocity a spring
 * expects (fraction of the travelled distance per second).
 */
export function normalizeVelocity(velocityPerSecond: number, distance: number): number {
  if (!distance) return 0;
  return velocityPerSecond / distance;
}

/** Estimate velocity from the last two frames — the basis of release gestures. */
export function velocityFromDelta(distance: number, deltaMs: number): number {
  if (deltaMs <= 0) return 0;
  return (distance / deltaMs) * 1000;
}