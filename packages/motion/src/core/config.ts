/**
 * Engine configuration.
 *
 * Config is instance-scoped so an app can run several isolated engines
 * (a page engine, a sandbox engine for AI experiments, a deterministic test
 * engine). Nothing here touches the DOM — reduced-motion lives in
 * `core/reduced-motion.ts`.
 */

import type { EasingSpec, SpringConfig } from "../types";
import { cloneTokens, defaultMotionTokens, mergeTokens, type DeepPartial, type MotionTokens } from "./tokens";

export type ReducedMotionMode = "respect" | "ignore" | "force";

export interface WavesMotionConfig {
  /** How `prefers-reduced-motion` is handled. */
  reducedMotion: ReducedMotionMode;
  /** Used when an animation does not specify a duration. */
  defaultDuration: number;
  /** Used when an animation does not specify an easing. */
  defaultEasing: EasingSpec;
  /** The house spring (overridden centrally, never per animation). */
  spring: SpringConfig;
  /** Seed for every random value the engine produces. */
  seed: number;
  /** Write `will-change` / 3D hints for animated composite properties. */
  gpuHints: boolean;
  /** Animation count above which the inspector raises a warning. */
  maxConcurrentAnimations: number;
  /** Animations longer than this (ms) are flagged as long-running. */
  longAnimationThreshold: number;
  /** Target frame budget in ms (16.7 for 60fps). */
  frameBudget: number;
  /** Keep a rolling recording of frames for the recorder/inspector. */
  record: boolean;
  /** Expose the engine on `globalThis` for inspector/devtools. */
  expose: boolean;
  /** Emit debug logs. */
  debug: boolean;
  /** Decimal precision for written numbers (keeps inline styles small). */
  precision: number;
  /** Tokens — the Waves motion DNA. */
  tokens: MotionTokens;
  /** Optional frame-rate cap for low-power profiles. */
  fpsCap: number | null;
}

export const defaultConfig: WavesMotionConfig = {
  reducedMotion: "respect",
  defaultDuration: defaultMotionTokens.duration.normal,
  defaultEasing: [0.32, 0.72, 0, 1],
  spring: { ...defaultMotionTokens.spring.waves },
  seed: 42,
  gpuHints: true,
  maxConcurrentAnimations: 64,
  longAnimationThreshold: 2500,
  frameBudget: 1000 / 60,
  record: false,
  expose: true,
  debug: false,
  precision: 4,
  tokens: cloneTokens(defaultMotionTokens),
  fpsCap: null
};

export type ConfigListener = (config: WavesMotionConfig, changed: (keyof WavesMotionConfig)[]) => void;

/** Merge a partial patch into a config, cloning the branches that matter. */
export function mergeConfig(base: WavesMotionConfig, patch: Partial<WavesMotionConfig>): WavesMotionConfig {
  const next: WavesMotionConfig = { ...base };
  for (const key of Object.keys(patch) as (keyof WavesMotionConfig)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key === "tokens") {
      next.tokens = mergeTokens(base.tokens, value as DeepPartial<MotionTokens>);
    } else if (key === "spring") {
      next.spring = { ...base.spring, ...(value as SpringConfig) };
    } else {
      (next as any)[key] = value;
    }
  }
  return next;
}

/** A standalone, observable configuration store. */
export class ConfigStore {
  private current: WavesMotionConfig;
  private listeners = new Set<ConfigListener>();

  constructor(initial: Partial<WavesMotionConfig> = {}) {
    this.current = mergeConfig(defaultConfig, initial);
  }

  get(): WavesMotionConfig {
    return this.current;
  }

  /** Apply a partial configuration and notify listeners. */
  configure(patch: Partial<WavesMotionConfig>): WavesMotionConfig {
    const changed: (keyof WavesMotionConfig)[] = [];
    for (const key of Object.keys(patch) as (keyof WavesMotionConfig)[]) {
      if (patch[key] !== undefined) changed.push(key);
    }
    this.current = mergeConfig(this.current, patch);
    for (const listener of this.listeners) listener(this.current, changed);
    return this.current;
  }

  subscribe(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Restore the house defaults. */
  reset(): WavesMotionConfig {
    this.current = mergeConfig(defaultConfig, {});
    for (const listener of this.listeners) listener(this.current, ["reducedMotion"]);
    return this.current;
  }
}