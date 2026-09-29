/**
 * Live registry of everything the engine is currently running.
 *
 * This is the data source behind the inspector, the CLI `inspect`/`timeline`
 * commands and the AI interface: OpenCode can ask the engine what is animating,
 * on which targets, for how long, with which easing, and what depends on what.
 */

import type { AnimationSnapshot, MotionState, ResolvedMotionSpec, TimelineSnapshot } from "../types";
import { describeTarget } from "./dom";

/** Structural view of an animation the registry needs (avoids a module cycle). */
export interface RegistryAnimation {
  readonly id: string;
  readonly label?: string;
  readonly state: MotionState;
  readonly progress: number;
  readonly duration: number;
  readonly elapsed: number;
  readonly targets: Element[];
  readonly spec: ResolvedMotionSpec;
  readonly startTime: number;
  readonly properties: string[];
}

/** Structural view of a timeline the registry needs. */
export interface RegistryTimeline {
  readonly id: string;
  readonly label?: string;
  readonly state: MotionState;
  readonly progress: number;
  readonly duration: number;
  toJSON(): import("../types").ResolvedTimelineNode;
}

export class AnimationRegistry {
  private animations = new Map<string, RegistryAnimation>();
  private timelines = new Map<string, RegistryTimeline>();
  private listeners = new Set<() => void>();

  register(animation: RegistryAnimation): void {
    this.animations.set(animation.id, animation);
    this.notify();
  }

  unregister(id: string): void {
    if (this.animations.delete(id)) this.notify();
  }

  /** Called whenever an animation progresses so the inspector stays live. */
  touch(): void {
    this.notify();
  }

  registerTimeline(timeline: RegistryTimeline): void {
    this.timelines.set(timeline.id, timeline);
    this.notify();
  }

  unregisterTimeline(id: string): void {
    if (this.timelines.delete(id)) this.notify();
  }

  get(id: string): RegistryAnimation | undefined {
    return this.animations.get(id);
  }

  getTimeline(id: string): RegistryTimeline | undefined {
    return this.timelines.get(id);
  }

  list(): RegistryAnimation[] {
    return Array.from(this.animations.values());
  }

  listTimelines(): RegistryTimeline[] {
    return Array.from(this.timelines.values());
  }

  running(): RegistryAnimation[] {
    return this.list().filter((animation) => animation.state === "running" || animation.state === "paused");
  }

  /** Everything currently touching a given target. */
  byTarget(element: Element): RegistryAnimation[] {
    return this.list().filter((animation) => animation.targets.includes(element));
  }

  /** Count of distinct elements being animated right now. */
  targetCount(): number {
    const set = new Set<Element>();
    for (const animation of this.running()) for (const target of animation.targets) set.add(target);
    return set.size;
  }

  clear(): void {
    this.animations.clear();
    this.timelines.clear();
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /* ------------------------------------------------------------------ */
  /* Serialisable views                                                 */
  /* ------------------------------------------------------------------ */

  snapshots(): AnimationSnapshot[] {
    return this.list().map((animation) => ({
      id: animation.id,
      label: animation.label,
      state: animation.state,
      progress: Number(animation.progress.toFixed(4)),
      duration: animation.duration,
      elapsed: Number(animation.elapsed.toFixed(2)),
      targets: animation.targets.map((target) => describeTarget(target)),
      spec: animation.spec,
      properties: animation.properties,
      startTime: animation.startTime
    }));
  }

  timelineSnapshots(): TimelineSnapshot[] {
    return this.listTimelines().map((timeline) => ({
      id: timeline.id,
      label: timeline.label,
      duration: timeline.duration,
      progress: Number(timeline.progress.toFixed(4)),
      state: timeline.state,
      tree: timeline.toJSON()
    }));
  }
}