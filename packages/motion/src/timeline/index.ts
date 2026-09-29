/**
 * Timelines — deterministic sequencing of animations.
 *
 * A timeline is a list of `MotionNode`s, each pinned to an absolute start time
 * via `at(ms)` or a dependency via `after(label)`. Resolution happens up front
 * (unknown labels fail loudly with stable codes), so the runtime phase is dumb:
 * every frame the timeline makes sure each child animation's local time equals
 * `elapsed - child.start`. Because children are real `Animation`s, scrubbing,
 * pausing and cancellation compose for free — a timeline is itself just
 * another tickable the engine pumps.
 *
 * `MotionNode` is the authoring surface: `motion({...}).after("intro")` reads
 * like the intent, and the same node plays standalone or inside any timeline,
 * which is what makes presets, stagger and timelines compose.
 */

import type { AnimationHandle, MotionSpec, StaggerOrigin, TargetInput } from "../types";
import type { WavesMotionEngine } from "../core/engine";
import { fail } from "../core/errors";
import { nextId } from "../core/dom";
import { configureStagger, resolveMotion } from "../presets";
import { createAnimation } from "../animation";
import { Animation } from "../animation/animation";

/* -------------------------------------------------------------------------- */
/* MotionNode — one authored step                                             */
/* -------------------------------------------------------------------------- */

export interface MotionNodeInit {
  spec: MotionSpec;
  /** Absolute start time in ms (mutually exclusive with `afterLabel`). */
  at?: number;
  /** Start when the node with this label finishes. */
  afterLabel?: string;
  /** Extra wait in ms applied after the dependency/at resolution. */
  wait?: number;
  /** Stagger binding for multi-target specs. */
  stagger?: number | { delay?: number; from?: StaggerOrigin; order?: (index: number, total: number) => number; seed?: number; reverse?: boolean };
}

export class MotionNode {
  readonly id = nextId("node");
  readonly init: MotionNodeInit;
  /** Resolved start time in ms from the timeline origin (set during build). */
  start = 0;

  constructor(init: MotionNodeInit) {
    this.init = init;
  }

  /** Pin this node to an absolute time from the timeline start. */
  at(ms: number): this {
    this.init.at = Math.max(0, ms);
    this.init.afterLabel = undefined;
    return this;
  }

  /** Start this node when the named node finishes. */
  after(label: string): this {
    this.init.afterLabel = label;
    this.init.at = undefined;
    return this;
  }

  /** Alias for `after` that reads better in chains. */
  then(label: string): this {
    return this.after(label);
  }

  /** Wait `ms` after the resolved start (works with both `at` and `after`). */
  wait(ms: number): this {
    this.init.wait = Math.max(0, ms);
    return this;
  }

  /** Stagger binding across this node's targets. */
  staggerBy(stagger: MotionNodeInit["stagger"]): this {
    this.init.stagger = stagger;
    return this;
  }

  /**
   * Resolve the node against an engine and produce its runtime animation
   * (not yet registered). Goes through `resolveMotionSpec` so presets,
   * spring defaults and the house easings expand exactly as they do outside
   * a timeline. `extraDelay` is added by the parent timeline.
   */
  resolve(engine: WavesMotionEngine): { animation: Animation; duration: number } {
    const spec = this.init.spec;
    const resolved = resolveMotion(
      { ...spec, delay: (spec.delay ?? 0) + (this.init.wait ?? 0) },
      engine
    );
    const elementDelays = this.init.stagger
      ? configureStagger(resolved.targets.length, typeof this.init.stagger === "number" ? { delay: this.init.stagger } : this.init.stagger)
      : undefined;
    const animation = createAnimation(resolved, engine, elementDelays ? { elementDelays } : undefined);
    return { animation, duration: resolved.totalDuration };
  }

  /** Play standalone (outside a timeline). Uses the given engine or the global one. */
  play(engine?: WavesMotionEngine): AnimationHandle {
    const target = engine ?? ((globalThis as Record<string, unknown>).__wavesMotionEngine as WavesMotionEngine | undefined);
    if (!target) fail("MOTION_INVALID_SPEC", "MotionNode.play() needs an engine — pass one or create the global engine first.");
    const { animation } = this.resolve(target);
    target.registry.register(animation);
    return animation.play();
  }
}

/** Authoring entry point: `motion({ target, properties, ... })`. */
export function motion(spec: MotionSpec): MotionNode {
  return new MotionNode({ spec });
}
/* -------------------------------------------------------------------------- */
/* Timeline                                                                   */
/* -------------------------------------------------------------------------- */

interface TimelineEntry {
  node: MotionNode;
  label: string;
  start: number;
  duration: number;
  animation: Animation;
}

export interface TimelineInit {
  engine: WavesMotionEngine;
  label?: string;
  id?: string;
  /** Repeat the whole sequence N extra times (0 = play once). */
  repeat?: number;
  /** Reverse direction on alternate repeats. */
  yoyo?: boolean;
}

export class Timeline {
  readonly id: string;
  readonly label?: string;
  state: "idle" | "running" | "paused" | "finished" | "cancelled" = "idle";
  private readonly engine: WavesMotionEngine;
  private readonly nodes: MotionNode[] = [];
  private entries: TimelineEntry[] = [];
  private readonly repeat: number;
  private readonly yoyo: boolean;
  private duration = 0;
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedElapsed = 0;
  private elapsed = 0;
  private iteration = 0;
  private built = false;
  private pendingAt?: number;
  private pendingAfter?: string;
  private gapTotal = 0;

  constructor(init: TimelineInit) {
    this.engine = init.engine;
    this.label = init.label;
    this.id = init.id ?? nextId("timeline");
    this.repeat = Math.max(0, init.repeat ?? 0);
    this.yoyo = init.yoyo ?? false;
  }

  /** Append a node. Uses `pendingAt`/`pendingAfter` slots, else sequential. */
  add(node: MotionNode | MotionSpec): this {
    const entry = node instanceof MotionNode ? node : new MotionNode({ spec: node });
    if (this.pendingAt !== undefined) entry.at(this.pendingAt);
    else if (this.pendingAfter !== undefined) entry.after(this.pendingAfter);
    this.pendingAt = undefined;
    this.pendingAfter = undefined;
    const gap = this.gapTotal;
    this.gapTotal = 0;
    if (gap > 0) entry.wait(gap);
    this.nodes.push(entry);
    this.built = false;
    return this;
  }

  /** Absolute-time slot for the next appended node. */
  at(ms: number): this {
    this.pendingAt = Math.max(0, ms);
    return this;
  }

  /** Dependency slot for the next appended node. */
  after(label: string): this {
    this.pendingAfter = label;
    return this;
  }

  /** Insert an empty wait before the next appended node. */
  gap(ms: number): this {
    this.gapTotal += Math.max(0, ms);
    return this;
  }

  /**
   * Resolve start times and materialise child animations. Resolution happens
   * up front because durations are needed for layout (sequential flow and
   * `after(label)` depend on them, and spring presets derive their duration
   * at resolve time). Unknown dependency labels fail loudly with a stable
   * code — an AI-authored timeline must never wait on a label that never
   * arrives.
   */
  private build(): void {
    this.entries = [];
    let sequential = 0;
    const byLabel = new Map<string, TimelineEntry>();
    const pending = new Map<string, TimelineEntry[]>();
    const labels = new Set<string>();

    for (const node of this.nodes) {
      const label = node.init.spec.label ?? node.id;
      if (labels.has(label)) fail("MOTION_INVALID_SPEC", `Duplicate timeline label "${label}".`, { timeline: this.id, label });
      labels.add(label);
    }

    for (const node of this.nodes) {
      const label = node.init.spec.label ?? node.id;
      const { animation, duration } = node.resolve(this.engine);
      this.engine.registry.register(animation);
      const entry: TimelineEntry = { node, label, start: 0, duration, animation };
      this.entries.push(entry);

      if (node.init.at !== undefined) {
        entry.start = node.init.at;
      } else if (node.init.afterLabel) {
        const dep = byLabel.get(node.init.afterLabel);
        if (dep) entry.start = dep.start + dep.duration;
        else {
          // Forward reference — resolved once the dependency appears.
          const queue = pending.get(node.init.afterLabel) ?? [];
          queue.push(entry);
          pending.set(node.init.afterLabel, queue);
          entry.start = -1; // unresolved marker
        }
      } else {
        entry.start = sequential;
      }

      if (entry.start >= 0) sequential = entry.start + entry.duration;
      byLabel.set(label, entry);
      const waiting = pending.get(label);
      if (waiting) {
        for (const waiterEntry of waiting) waiterEntry.start = entry.start + entry.duration;
        pending.delete(label);
      }
    }

    const unresolved = this.entries.filter((entry) => entry.start < 0);
    if (unresolved.length > 0) {
      fail("MOTION_CYCLE_DETECTED", `Timeline references unknown label(s): ${unresolved.map((entry) => entry.node.init.afterLabel).join(", ")}.`, {
        timeline: this.id,
        missing: unresolved.map((entry) => entry.node.init.afterLabel)
      });
    }
    this.entries.sort((a, b) => a.start - b.start);
    this.duration = this.entries.reduce((max, entry) => Math.max(max, entry.start + entry.duration), 0);
    this.built = true;
  }

  /* ------------------------------ runtime -------------------------------- */

  /** Ensure the timeline is laid out (children resolve during `build`). */
  private materialise(): void {
    if (!this.built) this.build();
  }

  get totalDuration(): number {
    if (!this.built) this.build();
    return this.duration * (this.repeat + 1);
  }

  get progress(): number {
    const total = this.totalDuration;
    return total > 0 ? Math.min(1, Math.max(0, this.elapsed / total)) : 0;
  }

  play(): this {
    if (this.state === "finished" || this.state === "cancelled") {
      this.state = "idle";
      this.elapsed = 0;
      this.iteration = 0;
      this.pausedElapsed = 0;
      for (const entry of this.entries) entry.animation?.cancel();
      this.built = false;
      this.entries = [];
    }
    this.materialise();
    this.startedAt = this.engine.now();
    this.state = "running";
    this.engine.add(this);
    return this;
  }

  pause(): this {
    if (this.state !== "running") return this;
    this.pausedAt = this.engine.now();
    this.state = "paused";
    for (const entry of this.entries) if (this.elapsed >= entry.start) entry.animation?.pause();
    return this;
  }

  resume(): this {
    if (this.state !== "paused") return this;
    if (this.pausedAt !== null) {
      this.pausedElapsed += this.engine.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.state = "running";
    for (const entry of this.entries) if (this.elapsed >= entry.start) entry.animation?.resume();
    return this;
  }

  cancel(): this {
    if (this.state === "cancelled" || this.state === "finished") return this;
    this.state = "cancelled";
    this.engine.remove(this.id);
    for (const entry of this.entries) entry.animation?.cancel();
    return this;
  }

  finish(): this {
    if (this.state === "finished") return this;
    this.seek(this.totalDuration);
    this.state = "finished";
    this.engine.remove(this.id);
    return this;
  }

  /** Scrub to an absolute time in ms; every child is pulled to its local time. */
  seek(timeMs: number): this {
    this.materialise();
    const clamped = Math.max(0, Math.min(this.totalDuration, timeMs));
    this.elapsed = clamped;
    for (const entry of this.entries) {
      const animation = entry.animation;
      if (!animation) continue;
      const local = clamped - entry.start;
      if (local <= 0) animation.seekTo(0);
      else if (local >= entry.duration) animation.seekTo(entry.duration);
      else animation.seekTo(local);
    }
    return this;
  }

  /** Tickable contract — the engine calls this with absolute time. */
  frame(time: number): void {
    if (this.state !== "running") return;
    this.elapsed = Math.max(0, time - (this.startedAt + this.pausedElapsed));

    let allDone = this.entries.length > 0;
    for (const entry of this.entries) {
      const animation = entry.animation;
      if (this.elapsed < entry.start) {
        allDone = false;
        continue;
      }
      if (animation.state === "idle") animation.play();
      if (animation.state !== "finished" && animation.state !== "cancelled") allDone = false;
    }

    if (allDone) {
      if (this.iteration < this.repeat) {
        this.iteration += 1;
        if (this.yoyo) for (const entry of this.entries) entry.animation?.reverse();
        for (const entry of this.entries) {
          entry.animation?.cancel();
          entry.animation?.play();
        }
        this.startedAt = time;
        return;
      }
      this.state = "finished";
      this.engine.remove(this.id);
    }
  }

  get active(): boolean {
    return this.state === "running" || this.state === "paused";
  }

  /** Resolved tree for the inspector / snapshot tests. */
  tree(): { id: string; label: string; duration: number; state: string; entries: { label: string; start: number; duration: number }[] } {
    this.materialise();
    return {
      id: this.id,
      label: this.label ?? "",
      duration: this.duration,
      state: this.state,
      entries: this.entries.map((entry) => ({ label: entry.label, start: entry.start, duration: entry.duration }))
    };
  }
}

/** Authoring entry point for a timeline bound to an engine. */
export function createTimeline(
  engine: WavesMotionEngine,
  options: { label?: string; id?: string; repeat?: number; yoyo?: boolean } = {}
): Timeline {
  return new Timeline({ engine, ...options });
}
