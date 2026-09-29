/**
 * The Waves Motion engine runtime.
 *
 * One engine owns: a clock, a frame pump, a configuration store, a writer pool,
 * a random source and the live animation registry. Animations and timelines are
 * not individually subscribed to rAF — they register as tickables, the engine
 * updates them in a deterministic order, then commits every dirty style writer
 * exactly once.
 */

import type { EngineSnapshot, PerformanceWarning, TargetInput } from "../types";
import { createRAFClock, createTimeoutClock, setFrameErrorHandler, Ticker, type MotionClock } from "./clock";
import { ConfigStore, type WavesMotionConfig } from "./config";
import { isReducedMotion } from "./reduced-motion";
import { type MotionTokens } from "./tokens";
import { AnimationRegistry } from "./registry";
import { WriterPool } from "./writer-pool";
import type { WriteRecord } from "./writer";
import { createRandom, setGlobalRandom, type RandomSource } from "./random";
import { requireTargets } from "./dom";
import { collectWarnings } from "./perf";
import { clearDiagnostics, describeError, reportDiagnostic } from "./errors";
import { createAnimation, resolveSpec, type ResolveOptions } from "../animation";
import type { AnimationHandle, PropertyMap } from "../types";

export const MOTION_VERSION = "1.0.0";

/** Anything the engine pumps each frame. */
export interface Tickable {
  readonly id: string;
  frame(time: number): void;
  readonly active: boolean;
}

export interface MotionEngineOptions {
  /** Override the clock (tests, CLI simulation, scrubbing). */
  clock?: MotionClock;
  /** Initial configuration. */
  config?: Partial<WavesMotionConfig>;
  /** Name used in diagnostics (`default`, `test`, `lab`). */
  name?: string;
  /** When true the caller drives frames with `engine.frame(time)`. */
  manual?: boolean;
}

export interface EngineEventMap {
  frame: { time: number; delta: number; animations: number; writes: number };
  write: WriteRecord;
  error: { code?: string; message: string };
  change: { kind: "config"; config?: WavesMotionConfig };
}

export class WavesMotionEngine {
  readonly version = MOTION_VERSION;
  readonly name: string;
  readonly clock: MotionClock;
  readonly ticker: Ticker;
  readonly config: ConfigStore;
  readonly registry = new AnimationRegistry();
  readonly writers: WriterPool;
  readonly random: RandomSource;

  private tickables = new Map<string, Tickable>();
  private listeners = new Map<keyof EngineEventMap, Set<(payload: any) => void>>();
  private unsubscribeTicker: (() => void) | null = null;
  private lastTime = 0;
  private manual: boolean;
  private disposed = false;
  private lastFrameStats = { animations: 0, writes: 0 };

  constructor(options: MotionEngineOptions = {}) {
    this.name = options.name ?? "default";
    this.manual = options.manual ?? false;
    this.clock = options.clock ?? (this.manual ? createTimeoutClock() : createRAFClock());
    this.config = new ConfigStore(options.config);
    this.ticker = new Ticker(this.clock, this.config.get().frameBudget);
    this.writers = new WriterPool({
      now: () => this.now(),
      gpuHints: () => this.config.get().gpuHints,
      precision: () => this.config.get().precision,
      onWrite: (record) => {
        this.writers.notifyWrite(record);
        this.emit("write", record);
      }
    });
    this.random = createRandom(this.config.get().seed);
    this.lastTime = this.now();

    setFrameErrorHandler((error) => this.emit("error", describeError(error)));
    this.config.subscribe((config) => {
      this.random.reset();
      this.ticker.frameBudget = config.frameBudget;
      this.emit("change", { kind: "config", config });
    });
    setGlobalRandom(this.config.get().seed);
  }

  /* -------------------------------- time -------------------------------- */

  now(): number {
    return this.clock.now();
  }

  get tokens(): MotionTokens {
    return this.config.get().tokens;
  }

  isReducedMotion(): boolean {
    return isReducedMotion(this.config.get());
  }

  configure(patch: Partial<WavesMotionConfig>): WavesMotionConfig {
    return this.config.configure(patch);
  }

  /* ----------------------------- scheduling ----------------------------- */

  add(tickable: Tickable): void {
    this.tickables.set(tickable.id, tickable);
    this.ensurePump();
  }

  remove(id: string): void {
    this.tickables.delete(id);
    if (this.tickables.size === 0) this.stop();
  }

  has(id: string): boolean {
    return this.tickables.has(id);
  }

  list(): Tickable[] {
    return Array.from(this.tickables.values());
  }

  /** Push a frame through the pump immediately (used by `seek`). */
  flush(): void {
    this.frame(this.now());
  }

  /** The frame pump: tickables in registration order, then one writer commit. */
  frame(time: number): void {
    if (this.disposed) return;
    const delta = Math.max(0, time - this.lastTime);
    this.lastTime = time;

    const tickables = Array.from(this.tickables.values());
    for (const tickable of tickables) {
      if (!tickable.active) {
        this.tickables.delete(tickable.id);
        continue;
      }
      tickable.frame(time);
    }

    this.writers.commit();
    this.lastFrameStats = { animations: tickables.length, writes: tickables.length };
    this.emit("frame", { time, delta, animations: tickables.length, writes: tickables.length });
    this.registry.touch();
  }

  private ensurePump(): void {
    if (this.unsubscribeTicker || this.disposed) return;
    this.unsubscribeTicker = this.ticker.add((time) => this.frame(time));
  }

  private stop(): void {
    if (!this.unsubscribeTicker) return;
    this.unsubscribeTicker();
    this.unsubscribeTicker = null;
  }

  /** Resolve targets using this engine's diagnostics setting. */
  targets(target: TargetInput, root?: ParentNode | null): Element[] {
    return requireTargets(!this.config.get().debug, target, root);
  }

  /* ------------------------------- animate -------------------------------- */

  /**
   * Animate resolved targets. All authored forms funnel through `resolveSpec`,
   * so presets, stagger, text, scroll, gestures and timelines produce the same
   * runtime object the inspector sees.
   */
  animate(
    target: TargetInput,
    properties: PropertyMap,
    options: ResolveOptions = {}
  ): AnimationHandle {
    const resolved = resolveSpec(target, properties, options, this);
    const elementDelays = Array.from({ length: resolved.targets.length }, (_value, index) => index * (options.stagger ?? 0));
    const animation = createAnimation(resolved, this, { elementDelays });
    this.registry.register(animation);
    return animation.play();
  }

  /**
   * Update the live value of an animation currently in flight. When no
   * matching animation runs, no-ops — the next `animate` picks it up.
   */
  update(target: TargetInput, properties: PropertyMap, options: ResolveOptions = {}): void {
    const resolved = resolveSpec(target, properties, options, this);
    for (const animation of this.registry.list()) {
      const candidate = animation as unknown as { targets?: Element[] };
      if (!candidate.targets || candidate.targets.length === 0) continue;
      if (options.label !== undefined && animation.label !== options.label) continue;
      if (resolved.targets.some((element) => !candidate.targets!.includes(element))) continue;
      const handle = animation as unknown as { applyFinalState?: () => void };
      handle.applyFinalState?.();
    }
  }

  /* ----------------------------- diagnostics ----------------------------- */

  /** Machine-readable performance warnings for the current state. */
  warnings(): PerformanceWarning[] {
    const config = this.config.get();
    return collectWarnings({
      animations: this.registry.list().map((animation) => ({
        id: animation.id,
        label: animation.label,
        state: animation.state,
        duration: animation.duration,
        spec: animation.spec,
        targets: animation.targets.map((element) => (element as Element).tagName?.toLowerCase() ?? "element")
      })),
      frames: this.ticker.stats(),
      thresholds: {
        maxConcurrentAnimations: config.maxConcurrentAnimations,
        longAnimationThreshold: config.longAnimationThreshold
      }
    });
  }

  /** Minimal snapshot; the inspector augments it with trees, curves and hints. */
  snapshot(): EngineSnapshot {
    return {
      version: this.version,
      reducedMotion: this.isReducedMotion(),
      animations: this.registry.snapshots(),
      timelines: this.registry.timelineSnapshots(),
      warnings: this.warnings(),
      frames: this.ticker.stats(),
      counts: {
        animations: this.registry.list().length,
        running: this.registry.running().length,
        timelines: this.registry.listTimelines().length,
        targets: this.registry.targetCount()
      }
    };
  }

  /** Cancel everything this engine is running. */
  cancelAll(reason = "cancel-all"): void {
    for (const tickable of Array.from(this.tickables.values())) {
      const candidate = tickable as unknown as { cancel?: (reason?: string) => void };
      if (typeof candidate.cancel === "function") candidate.cancel(reason);
    }
    this.tickables.clear();
    this.stop();
  }

  /** Full reset: cancels work, clears writers, registry and diagnostics. */
  reset(): void {
    this.cancelAll("reset");
    this.writers.reset();
    this.registry.clear();
    this.ticker.resetStats();
    clearDiagnostics();
  }

  /* -------------------------------- events ------------------------------- */

  on<K extends keyof EngineEventMap>(event: K, listener: (payload: EngineEventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: any) => void);
    return () => {
      set?.delete(listener as (payload: any) => void);
    };
  }

  private emit<K extends keyof EngineEventMap>(event: K, payload: EngineEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        listener(payload);
      } catch (error) {
        reportDiagnostic("MOTION_PERFORMANCE", `Engine listener failed: ${String(error)}`);
      }
    }
  }

  /** Frame-level counters used by the inspector header. */
  frameStats(): { animations: number; writes: number } {
    return this.lastFrameStats;
  }

  dispose(): void {
    this.cancelAll("dispose");
    this.stop();
    this.disposed = true;
    this.listeners.clear();
    setFrameErrorHandler(null);
  }
}

export { createRAFClock, createTimeoutClock };