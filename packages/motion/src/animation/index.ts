/**
 * Public surface of the animation layer.
 *
 * `createAnimation` is the only way subsystems build an `Animation` — presets,
 * stagger, text, scroll, gestures and timelines all funnel through it, which
 * keeps construction (track building, base capture) in one place.
 */

import { Animation, type AnimationInit, type ElementBinding, type FrameObserver, type PropertyTrack } from "./animation";
import { resolveSpec, type ResolveOptions, type ResolvedAnimation, type SpecHost } from "./resolve";
import { buildTracksFromSpec, parseWithHints } from "./tracks";
import { evaluateTrackTime, queueWrite, clamp01 } from "./evaluate";
import { resolveStaggerOrder, staggerDelayFor, gridPositions } from "../sequences/order";

export {
  Animation,
  resolveSpec,
  buildTracksFromSpec,
  parseWithHints,
  evaluateTrackTime,
  queueWrite,
  clamp01,
  resolveStaggerOrder,
  staggerDelayFor,
  gridPositions
};
export type { AnimationInit, ElementBinding, FrameObserver, PropertyTrack, ResolveOptions, ResolvedAnimation, SpecHost };

/** Options the caller can pass alongside an already-resolved animation. */
export interface CreateAnimationOptions {
  /** Per-target stagger delays, aligned to the resolved target list. */
  elementDelays?: number[];
  onFrame?: FrameObserver;
}

/**
 * Build an `Animation` from a resolved spec plus an engine.
 * Bases are captured lazily at `play()` time, when bindings exist.
 */
export function createAnimation(
  resolved: ResolvedAnimation,
  engine: SpecHost & { writers: { writerFor(element: Element): { readBase(name: string): unknown; set(name: string, value: string, raw?: unknown): void; markDirty(): void } } },
  options: CreateAnimationOptions = {}
): Animation {
  const init: AnimationInit = {
    spec: resolved.spec,
    easing: resolved.easing,
    targets: resolved.targets,
    duration: resolved.duration,
    totalDuration: resolved.totalDuration,
    passDuration: resolved.passDuration,
    delay: resolved.spec.delay,
    reduced: resolved.reduced,
    elementDelays: options.elementDelays,
    baseValues: new Map(),
    onFrame: options.onFrame
  };
  return new Animation(init, engine as never);
}
