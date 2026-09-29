/**
 * Reduced motion resolution.
 *
 * "Animations must degrade cleanly. Never make essential information dependent
 * on animation." Reduced motion collapses travel, keeps the landing state, and
 * leaves only the short cross-fade that keeps a state change perceivable.
 */

import { defaultMotionTokens } from "./tokens";
import type { WavesMotionConfig } from "./config";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const reducedMotionListeners = new Set<(reduced: boolean) => void>();
let mediaQuery: MediaQueryList | null = null;
let mediaQueryBound = false;
let reducedMotionOverride: boolean | null = null;

function getMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  if (!mediaQuery) {
    mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    if (!mediaQueryBound) {
      mediaQueryBound = true;
      const handler = () => {
        const value = Boolean(mediaQuery?.matches);
        for (const listener of reducedMotionListeners) listener(value);
      };
      if (typeof mediaQuery.addEventListener === "function") mediaQuery.addEventListener("change", handler);
      else if (typeof (mediaQuery as any).addListener === "function") (mediaQuery as any).addListener(handler);
    }
  }
  return mediaQuery;
}

/** True when the OS/browser asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  const query = getMediaQuery();
  return query ? query.matches : false;
}

/** Subscribe to OS-level reduced-motion changes. */
export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  reducedMotionListeners.add(listener);
  getMediaQuery();
  return () => {
    reducedMotionListeners.delete(listener);
  };
}

/** Resolve the effective setting from the config mode alone. */
export function resolveReducedMotion(config: WavesMotionConfig): boolean {
  if (config.reducedMotion === "ignore") return false;
  if (config.reducedMotion === "force") return true;
  return prefersReducedMotion();
}

/**
 * Test/preview override. Passing `null` restores automatic detection.
 * Used by `testing.simulateReducedMotion()` and the Motion Lab toggle.
 */
export function setReducedMotionOverride(value: boolean | null): void {
  reducedMotionOverride = value;
  if (value !== null) {
    for (const listener of reducedMotionListeners) listener(value);
  }
}

export function getReducedMotionOverride(): boolean | null {
  return reducedMotionOverride;
}

/** Combine the override hook with the configured mode. */
export function isReducedMotion(config: WavesMotionConfig): boolean {
  if (reducedMotionOverride !== null && config.reducedMotion !== "ignore") return reducedMotionOverride;
  return resolveReducedMotion(config);
}

/**
 * Degrade a duration for reduced motion. The animation still lands on the
 * correct final value; it just stops travelling.
 */
export function degradeDuration(duration: number, reduced: boolean, allowFade = true): number {
  if (!reduced) return duration;
  return allowFade ? Math.min(defaultMotionTokens.duration.instant, duration) : 0;
}

/** Notify subscribers that reduced motion may have changed (config changes). */
export function broadcastReducedMotion(reduced: boolean): void {
  for (const listener of reducedMotionListeners) listener(reduced);
}