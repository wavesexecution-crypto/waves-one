/**
 * A runtime animation instance.
 *
 * An `Animation` owns the timing of one resolved spec: it registers with the
 * engine as a tickable, applies the delay, the easing curve (or the real spring
 * solver), each keyframe segment, and hands computed values to the element's
 * `StyleWriter` so all writes land in a single commit per frame.
 *
 * Lifecycle: idle → running → (paused) → finished | cancelled.
 * Interruption is velocity-aware: springs carry their velocity forward.
 */

import type {
  AnimationHandle,
  EasingFunction,
  MotionEventName,
  MotionLifecycleInfo,
  MotionState,
  Primitive,
  ResolvedMotionSpec
} from "../types";
import type { WavesMotionEngine, Tickable } from "../core/engine";
import { StyleWriter } from "../core/writer";
import { getPropertyDefinition, type PropertyDefinition } from "../core/properties";
import { type ParsedValue } from "../core/values";
import { nextId } from "../core/dom";
import { SpringValue } from "../spring";
import { resolveEasing, type ResolvedEasing } from "../easing";
import { buildTracksFromSpec } from "./tracks";
import { evaluateTrackTime, queueWrite, parseWithHints as parseValueWithDefinition } from "./evaluate";
import { clamp01 } from "./evaluate";

/** Internal resolved representation of one property track. */
export interface PropertyTrack {
  name: string;
  definition: PropertyDefinition;
  /** Keyframes in absolute ms, always starting at 0. */
  keyframes: { at: number; value: ParsedValue; easing?: EasingFunction }[];
  /** Value the track starts from when the animation begins. */
  from: ParsedValue;
  to: ParsedValue;
  /** Authored from value, or the identity placeholder. */
  base: Primitive;
  /** True when the author pinned `from` (shared by all elements). */
  fromAuthored: boolean;
  /** Iteration length in ms — the mirror axis for yoyo/reverse. */
  toTime: number;
}

/** Per-element view: same properties, per-target delay. */
export interface ElementBinding {
  element: Element;
  writer: StyleWriter;
  /** Extra delay for this element (stagger across targets), ms. */
  delay: number;
  springs: Map<string, SpringValue>;
  /** This element's own captured starting values for `to`-only tracks. */
  baseValues: Map<string, ParsedValue>;
}

/** Optional per-frame observer used by scroll scrubbing and the inspector. */
export type FrameObserver = (info: { time: number; progress: number }) => void;

export interface AnimationInit {
  spec: ResolvedMotionSpec;
  easing: ResolvedEasing;
  targets: Element[];
  /** Single-iteration duration (ms). */
  duration: number;
  /** Total duration including repeats (ms). */
  totalDuration: number;
  /** delay + duration (ms). */
  passDuration: number;
  delay: number;
  reduced: boolean;
  /** Per-target stagger delays, aligned to `targets`. */
  elementDelays?: number[];
  /** Per-property writer bases captured before binding (name → raw value). */
  baseValues: Map<string, Primitive>;
  onFrame?: FrameObserver;
}

export class Animation implements Tickable {
  readonly id: string;
  label?: string;
  state: MotionState = "idle";
  readonly spec: ResolvedMotionSpec;
  readonly targets: Element[];
  readonly duration: number;
  readonly totalDuration: number;
  readonly passDuration: number;
  readonly reduced: boolean;

  private readonly engine: WavesMotionEngine;
  private readonly tracks: PropertyTrack[];
  public readonly bindings: ElementBinding[] = [];
  private readonly callbacks: Partial<Record<MotionEventName, ((info: MotionLifecycleInfo) => void)[]>> = {};
  private readonly elementDelays: number[];
  private readonly onFrame?: FrameObserver;
  private readonly easing: ResolvedEasing;

  private springs = new Map<Element, Map<string, SpringValue>>();
  private registered = false;
  private started = false;
  private completed = false;
  private cancelled = false;
  private playStartedAt = 0;
  private pausedAt: number | null = null;
  private pausedElapsed = 0;
  private _elapsed = 0;
  private direction: 1 | -1 = 1;
  private currentIteration = 0;
  private _progress = 0;

  constructor(init: AnimationInit, engine: WavesMotionEngine) {
    this.engine = engine;
    this.spec = init.spec;
    this.targets = init.targets;
    this.duration = init.duration;
    this.totalDuration = init.totalDuration;
    this.passDuration = init.passDuration;
    this.reduced = init.reduced;
    this.label = init.spec.label;
    this.id = init.spec.label ? `${init.spec.label}:${nextId("anim")}` : nextId("anim");
    this.elementDelays = init.elementDelays ?? [];
    this.onFrame = init.onFrame;
    this.easing = init.easing;
    this.tracks = buildTracksFromSpec(init.spec, init.duration, engine, init.baseValues);
  }

  /* ------------------------------ inspection ------------------------------ */

  get progress(): number {
    return this._progress;
  }

  get elapsed(): number {
    return this._elapsed;
  }

  get properties(): string[] {
    return this.tracks.map((track) => track.name);
  }

  get startTime(): number {
    return this.playStartedAt;
  }

  get active(): boolean {
    return this.state === "running" || this.state === "paused";
  }

  info(): MotionLifecycleInfo {
    return {
      id: this.id,
      label: this.label,
      state: this.state,
      progress: this._progress,
      duration: this.totalDuration,
      elapsed: this._elapsed,
      targets: this.targets,
      spec: this.spec
    };
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /** Bind elements and register with the engine. Idempotent until finished. */
  play(): AnimationHandle {
    if (this.cancelled || this.completed) this.resetForReplay();
    if (this.bindings.length === 0) this.bindElements();
    if (!this.registered) {
      this.playStartedAt = this.engine.now();
      this.registered = true;
      this.started = false;
      this.state = "running";
      this.engine.add(this);
    }
    return this.handle();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.pausedAt = this.engine.now();
    this.state = "paused";
    this.dispatch("pause");
  }

  resume(): void {
    if (this.state !== "paused") return;
    if (this.pausedAt !== null) {
      this.pausedElapsed += this.engine.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.state = "running";
    this.dispatch("resume");
  }

  cancel(): void {
    if (this.cancelled || this.completed) return;
    this.cancelled = true;
    this.state = "cancelled";
    this.engine.remove(this.id);
    this.dispatch("cancel", "cancel");
  }

  finish(): void {
    if (this.completed) return;
    this.completed = true;
    this.state = "finished";
    this._progress = 1;
    this._elapsed = this.totalDuration;
    this.applyFinalState();
    // The final state must be visible immediately — `finish()` is imperative,
    // like `seekTo`, not a batched frame write.
    this.engine.writers.commit();
    this.engine.remove(this.id);
    this.dispatch("complete");
  }

  /** Play the remaining (or next) pass backwards — flips the authored direction. */
  reverse(): void {
    this.spec.reverse = !this.spec.reverse;
  }

  private resetForReplay(): void {
    this.cancelled = false;
    this.completed = false;
    this.started = false;
    this.registered = false;
    this._elapsed = 0;
    this.pausedElapsed = 0;
    this.pausedAt = null;
    this.currentIteration = 0;
    this.direction = 1;
    this._progress = 0;
    this.springs.clear();
  }

  /** Populate per-element bindings (writers + stagger delays + bases). */
  private bindElements(): void {
    for (const element of this.targets) {
      const writer = this.engine.writers.writerFor(element);
      const delay = this.elementDelays[this.bindings.length] ?? 0;
      const baseValues = new Map<string, ParsedValue>();
      for (const track of this.tracks) {
        if (track.fromAuthored) continue; // shared from value — no per-element capture
        baseValues.set(track.name, parseValueWithDefinition(writer.readBase(track.name), track.definition));
      }
      const binding: ElementBinding = { element, writer, delay, springs: new Map(), baseValues };
      this.bindings.push(binding);
    }
  }

  /** Write every track's final value — used by `finish()` and reduced motion. */
  private applyFinalState(): void {
    if (this.bindings.length === 0) this.bindElements();
    for (const binding of this.bindings) {
      for (const track of this.tracks) {
        queueWrite(binding.writer, track, track.to);
      }
      this.engine.writers.markDirty(binding.writer);
    }
  }

  private handle(): AnimationHandle {
    const animation = this;
    const info = () => animation.info();
    return {
      get id() {
        return animation.id;
      },
      get label() {
        return animation.label;
      },
      get state() {
        return animation.state;
      },
      get duration() {
        return animation.totalDuration;
      },
      get progress() {
        return animation._progress;
      },
      get elapsed() {
        return animation._elapsed;
      },
      get targets() {
        return animation.targets;
      },
      get spec() {
        return animation.spec;
      },
      get finished() {
        return animation.completion;
      },
      play() {
        animation.play();
        return this;
      },
      pause() {
        animation.pause();
        return this;
      },
      resume() {
        animation.resume();
        return this;
      },
      cancel() {
        animation.cancel();
        return this;
      },
      finish() {
        animation.finish();
        return this;
      },
      reverse() {
        animation.spec.reverse = true;
        return this;
      },
      seek(timeOrProgress: number) {
        // Progress (0-1) maps onto the active span; anything larger is absolute ms.
        if (timeOrProgress > 1) animation.seekTo(timeOrProgress);
        else animation.seekTo(timeOrProgress * Math.max(1, animation.totalDuration - animation.spec.delay));
        return this;
      },
      then(onDone) {
        return animation.completion.then((info) => {
          onDone(info);
          return info;
        });
      },
      on(event, callback) {
        return animation.on(event, callback);
      }
    };
  }

  /** Promise that resolves when the animation completes or is cancelled. */
  private get completion(): Promise<MotionLifecycleInfo> {
    if (this.completed || this.cancelled) return Promise.resolve(this.info());
    return new Promise((resolve) => {
      this.on("complete", (info) => resolve(info));
    });
  }

  /** Jump to an absolute time (ms) or progress (0–1) and paint immediately. */
  seekTo(timeOrProgress: number): void {
    const activeSpan = Math.max(1, this.totalDuration - this.spec.delay);
    const target =
      timeOrProgress > 1
        ? Math.max(0, Math.min(activeSpan, timeOrProgress))
        : Math.max(0, Math.min(activeSpan, timeOrProgress * activeSpan));
    this._elapsed = this.spec.delay + target;
    this._progress = Math.min(1, target / activeSpan);
    this.lastFrameTime = null;
    if (this.bindings.length === 0) this.bindElements();
    const local = Math.max(0, this._elapsed - this.spec.delay);
    const passLength = Math.max(1, this.spec.duration);

    if (local >= activeSpan) {
      // Scrub past the exit (or seekTo(1)): the modulo would wrap the final
      // keyframe back onto the start value — instead land on the finals, as a
      // naturally-completed frame does.
      for (const binding of this.bindings) {
        for (const track of this.tracks) {
          queueWrite(binding.writer, track, track.to);
        }
        this.engine.writers.markDirty(binding.writer);
      }
    } else {
      for (const binding of this.bindings) {
        // Per-element stagger offsets apply while scrubbing, exactly as in frame().
        const bindingLocal = Math.max(0, local - binding.delay);
        const inIteration = bindingLocal - Math.floor(bindingLocal / passLength) * passLength;
        for (const track of this.tracks) {
          const elementFrom = track.fromAuthored
            ? track.keyframes[0].value
            : binding.baseValues.get(track.name) ?? track.keyframes[0].value;
          queueWrite(binding.writer, track, evaluateTrackTime(track, inIteration, this.direction, elementFrom));
        }
        this.engine.writers.markDirty(binding.writer);
      }
    }
    // Scrubbing must paint immediately — the animation may not be registered
    // with the pump (seek before play, timeline scrubbing), so commit now.
    this.engine.writers.commit();
  }

  /* -------------------------------- events -------------------------------- */

  on(event: MotionEventName, callback: (info: MotionLifecycleInfo) => void): () => void {
    const list = (this.callbacks[event] ??= []);
    list.push(callback);
    return () => {
      const index = list.indexOf(callback);
      if (index >= 0) list.splice(index, 1);
    };
  }

  private dispatch(event: MotionEventName, reason?: MotionLifecycleInfo["reason"]): void {
    const listeners = this.callbacks[event];
    if (!listeners) return;
    const info: MotionLifecycleInfo = { ...this.info(), reason };
    for (const listener of listeners) listener(info);
  }

  /* -------------------------------- frame --------------------------------- */

  /** Advance the animation. `time` is the engine's absolute clock time. */
  frame(time: number): void {
    if (this.state === "paused") {
      this.lastFrameTime = time;
      return;
    }
    if (this.cancelled || this.completed) return;

    if (!this.started) {
      this.started = true;
      this.dispatch("start");
    }

    // The engine passes absolute time; the animation derives its own delta.
    const step = this.lastFrameTime === null ? 0 : Math.max(0, time - this.lastFrameTime);
    this.lastFrameTime = time;
    this._elapsed += step;
    const local = Math.max(0, this._elapsed - this.spec.delay);
    const passLength = Math.max(1, this.spec.duration);

    // Iteration bookkeeping (repeat + yoyo + reverse).
    const iteration = Math.floor(local / passLength);
    this.currentIteration = iteration;
    this.direction = this.spec.yoyo && iteration % 2 === 1 ? -1 : 1;
    if (this.spec.reverse) this.direction = (this.direction === 1 ? -1 : 1);
    const inIteration = local - iteration * passLength;

    for (const binding of this.bindings) {
      const bindingLocal = local - binding.delay;
      if (bindingLocal < 0) {
        continue; // still inside this element's stagger delay
      }
      // Stagger offsets the element's own timeline, not just the start gate —
      // a delayed element must evaluate against its binding-local elapsed time.
      const bindingTime = Math.max(0, bindingLocal);
      const bindingIteration = Math.floor(bindingTime / passLength);
      const bindingInIteration = bindingTime - bindingIteration * passLength;
      const springs = this.springs.get(binding.element);

      if (springs && springs.size > 0) {
        // Real spring pass — velocity-aware stepping per property.
        let settled = 0;
        for (const [name, spring] of springs) {
          const result = spring.step(step);
          const track = this.tracks.find((candidate) => candidate.name === name);
          if (track) queueWrite(binding.writer, track, springValueFor(track, spring.value));
          if (result.settled) settled += 1;
        }
        if (settled === springs.size && this.spec.repeat === 0) {
          this.finish();
          return;
        }
      } else {
        for (const track of this.tracks) {
          const elementFrom = track.fromAuthored ? track.keyframes[0].value : binding.baseValues.get(track.name) ?? track.keyframes[0].value;
          const value = evaluateTrackTime(track, bindingInIteration, this.direction, elementFrom);
          queueWrite(binding.writer, track, value);
        }
      }
      this.engine.writers.markDirty(binding.writer);
    }

    const activeSpan = Math.max(1, this.totalDuration - this.spec.delay);
    this._progress = Math.min(1, local / activeSpan);
    if (local >= activeSpan) {
      this.finish();
      return;
    }
    if (this.onFrame) this.onFrame({ time, progress: this._progress });
  }

  private lastFrameTime: number | null = null;
}

/** Wrap a raw spring number into the track's parsed-value shape. */
function springValueFor(track: PropertyTrack, value: number): ParsedValue {
  const shape = track.from;
  if (shape.kind === "color") {
    return { ...shape, numbers: shape.numbers.map(() => value) };
  }
  if (shape.kind === "string") {
    return { ...shape, numbers: [value] };
  }
  return { ...shape, numbers: [value] };
}
