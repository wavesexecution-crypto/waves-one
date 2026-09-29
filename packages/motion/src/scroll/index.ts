/**
 * Scroll-driven motion.
 *
 * A scroll controller is a one-frame loop: read the scroll position, evaluate
 * a window of targets against it, queue writes, done. Everything is computed
 * from the authoritative frame time (never `Date.now()`), so the recorder,
 * inspector and tests see deterministic frames. `waves-smooth` is the scrub
 * easing — the curve designed for continuous, scrubbed motion.
 */

import type { EasingFunction, TargetInput } from "../types";
import type { Tickable, WavesMotionEngine } from "../core/engine";
import { fail, reportDiagnostic } from "../core/errors";
import { getViewport, onEvent, resolveTargets } from "../core/dom";
import { clamp01 } from "../animation/evaluate";
import { resolveEasing } from "../easing";
import { evaluateTrackTime, queueWrite } from "../animation/evaluate";
import { Animation } from "../animation/animation";
import { resolveStaggerOrder } from "../sequences/order";
import { resolveSpec } from "../animation/resolve";

let nextScrollId = 0;

/* -------------------------------------------------------------------------- */
/* Entry types                                                                */
/* -------------------------------------------------------------------------- */

export interface ScrollEntry {
  element: Element;
  /** Start (enter) and end (exit) scroll positions of the mapped window. */
  start: number;
  end: number;
  /** The shared animation whose tracks are scrubbed per element. */
  animation: Animation;
  /** Delay applied per rank so scrubbing honours stagger offsets. */
  delay: number;
  baseValues: Map<string, import("../core/values").ParsedValue>;
}

/** Synchronous scroll evaluation — no IO, no promises, frame-budget safe. */
export interface ScrollEvaluateOptions {
  scrollY?: number;
  viewportHeight?: number;
  fallbackProgress?: number;
  once?: boolean;
}

export class ScrollController implements Tickable {
  readonly id: string;
  state: "idle" | "running" | "paused" | "stopped" = "idle";
  /** Last window progress computed by `evaluate` (no IO needed to read it). */
  lastProgress = 0;
  private readonly engine: WavesMotionEngine;
  private readonly container: HTMLElement | null;
  private readonly scrollKey: "top" | "left";
  private readonly offsetKey: "scrollY" | "scrollX";
  private readonly entries: ScrollEntry[] = [];
  private readonly easing: EasingFunction;
  private readonly easeName: string;
  private readonly viewportSource: () => { height: number; width: number };
  private readonly scrollSource: () => number;
  private readonly unbind: () => void;
  private lastReported = -1;

  constructor(init: {
    engine: WavesMotionEngine;
    target: TargetInput;
    properties: Record<string, any>;
    options?: {
      start?: "enter" | "start" | number;
      end?: "end" | number;
      offset?: number;
      easing?: string;
      container?: HTMLElement | null;
      stagger?: number;
      from?: import("../types").StaggerOrigin;
      label?: string;
    };
  }) {
    this.engine = init.engine;
    this.id = `scroll-${nextScrollId++}`;
    const options = init.options ?? {};
    this.container = options.container ?? null;
    this.scrollKey = options.offset !== undefined && options.offset < 0 ? "left" : "top";
    this.offsetKey = this.scrollKey === "top" ? "scrollY" : "scrollX";
    const resolvedEasing = resolveEasing((options.easing as any) ?? "waves-smooth", this.engine.config.get());
    this.easing = resolvedEasing.fn;
    this.easeName = resolvedEasing.name;

    // Targets resolve through the engine funnel (missing selectors reported).
    const elements = this.engine.targets(init.target);

    // Deterministic stagger rank order (same rules as the animation stagger).
    const order = resolveStaggerOrder(elements.length, { origin: options.from ?? "first", seed: this.engine.config.get().seed });
    const stagger = options.stagger ?? 0;
    const delays = new Map<Element, number>();
    order.forEach((elementIndex: number, rank: number) => delays.set(elements[elementIndex], rank * stagger));

    const scroll = readWindowScroll(this.container);
    const span = stagger * Math.max(0, elements.length - 1);
    for (const element of elements) {
      const delay = delays.get(element) ?? 0;
      const window0 = scrollWindow(element, options.start ?? "enter", options.end ?? "end", this.container, scroll);
      const entry: ScrollEntry = {
        element,
        start: window0.start - delay,
        end: Math.max(window0.start + 1, window0.end + span - delay),
        animation: null as unknown as Animation,
        delay,
        baseValues: new Map()
      };
      this.entries.push(entry);
    }

    // One shared animation: every element of the target list binds to it, so
    // the same spec, easing and reduced-motion degradation drive the window.
    const resolved = resolveSpec(elements, init.properties, { label: options.label ?? this.id }, this.engine);
    const animation = new Animation(
      {
        spec: resolved.spec,
        targets: elements,
        duration: resolved.spec.duration,
        totalDuration: resolved.totalDuration,
        passDuration: resolved.passDuration,
        reduced: resolved.reduced,
        elementDelays: elements.map((element) => delays.get(element) ?? 0),
        delay: resolved.spec.delay,
        baseValues: new Map(),
        easing: resolveEasing(undefined, this.engine.config.get())
      },
      this.engine
    );
    for (const entry of this.entries) entry.animation = animation;

    // Initial scrub: paint the authored start state without a frame.
    animation.play();
    animation.pause();
    animation.seekTo(0);

    // Hosts without scroll APIs (Node/CLI) fall back to a fixed progress.
    this.viewportSource = () => getViewport();
    this.scrollSource = () => readWindowScroll(this.container)[this.scrollKey];
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      this.unbind = () => {};
      reportDiagnostic("MOTION_NO_DOM", `Scroll controller "${this.id}" has no scroll source; use evaluate({ scrollY }) directly.`);
    } else {
      const target: EventTarget = this.container ?? window;
      this.unbind = onEvent(target, "scroll", () => this.engine.flush(), { passive: true });
    }
  }

  /* ------------------------------ lifecycle ------------------------------- */

  play(): this {
    if (this.state === "stopped") return this;
    this.state = "running";
    this.engine.add(this);
    return this;
  }

  pause(): this {
    if (this.state !== "running") return this;
    this.state = "paused";
    this.engine.remove(this.id);
    return this;
  }

  resume(): this {
    return this.play();
  }

  stop(): this {
    this.state = "stopped";
    this.engine.remove(this.id);
    this.unbind();
    return this;
  }

  destroy(): void {
    this.stop();
    for (const entry of this.entries) entry.animation.cancel();
    this.entries.length = 0;
  }

  /** Tickable contract — called with the authoritative frame time. */
  frame(_time: number): void {
    if (this.state !== "running") return;
    this.evaluate();
  }

  get active(): boolean {
    return this.state === "running" || this.state === "paused";
  }

  /** Current scroll offset of the bound container (or window). */
  get scrollPosition(): number {
    return this.scrollSource();
  }

  /** The scrub easing in use (for the inspector). */
  get easingName(): string {
    return this.easeName;
  }

  /* ------------------------------- evaluate ------------------------------- */

  /**
   * The one-frame loop: read scroll, evaluate the window, queue writes.
   * No IO beyond the scroll/rect reads, so it is safe per frame.
   */
  evaluate(options: ScrollEvaluateOptions = {}): void {
    const scrollY = options.scrollY ?? this.scrollSource();
    const viewportHeight = options.viewportHeight ?? this.viewportSource().height;
    let progress = -1;
    for (const entry of this.entries) {
      const window = scrollWindow(entry.element, entry.start, entry.end, this.container, {
        top: scrollY,
        left: 0,
        height: viewportHeight
      });
      const raw = window.start === window.end ? 1 : (scrollY - window.start) / (window.end - window.start);
      const eased = this.easing(Math.max(0, Math.min(1, raw)));
      entry.animation.seekTo(entry.delay + eased * entry.animation.spec.duration);
      this.engine.writers.markDirty(entry.animation.bindings[0]?.writer as never);
      progress = eased;
    }
    this.lastProgress = progress;
    this.engine.writers.commit();
    if (options.once && progress !== this.lastReported) this.lastReported = progress;
  }

  /** Progress of the first entry's window at the given scroll position. */
  progressAt(scrollY: number): number {
    const entry = this.entries[0];
    if (!entry) return 0;
    return Math.max(0, Math.min(1, (scrollY - entry.start) / Math.max(1, entry.end - entry.start)));
  }

  /** Ordered geometry snapshot for the inspector / tests (no style writes). */
  snapshot(scrollY = this.scrollSource()): { element: Element; progress: number; delay: number; window: { start: number; end: number } }[] {
    const viewportHeight = this.viewportSource().height;
    return this.entries.map((entry) => {
      const window = scrollWindow(entry.element, entry.start, entry.end, this.container, {
        top: scrollY,
        left: 0,
        height: viewportHeight
      });
      return {
        element: entry.element,
        progress: window.start === window.end ? 1 : Math.max(0, Math.min(1, (scrollY - window.start) / (window.end - window.start))),
        delay: entry.delay,
        window: { start: window.start, end: window.end }
      };
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Geometry + factory                                                         */
/* -------------------------------------------------------------------------- */

/** Container scroll position. */
function readWindowScroll(container: HTMLElement | null): { top: number; left: number; height: number } {
  if (container) {
    return {
      top: container.scrollTop || 0,
      left: container.scrollLeft || 0,
      height: container.clientHeight || 0
    };
  }
  if (typeof window === "undefined") return { top: 0, left: 0, height: 0 };
  return {
    top: window.scrollY || window.pageYOffset || 0,
    left: window.scrollX || window.pageXOffset || 0,
    height: window.innerHeight || (typeof document !== "undefined" ? document.documentElement?.clientHeight || 0 : 0)
  };
}

interface ScrollRect {
  top: number;
  left: number;
  height: number;
}

/**
 * The scroll window for one element.
 * Numeric `start`/`end` (from an entry) are used verbatim; string/keyword forms
 * are recomputed from the current rect — entries store numbers, so this is the
 * keyword path only for first layout.
 */
function scrollWindow(
  element: Element,
  start: "enter" | "start" | number,
  end: "end" | number,
  container: HTMLElement | null,
  scroll: { top: number; left: number; height: number }
): { start: number; end: number } {
  if (typeof start === "number" && typeof end === "number") return { start, end };
  const rect = (element as HTMLElement).getBoundingClientRect?.() as DOMRect | undefined;
  if (!rect) return { start: 0, end: 1 };
  const height = scroll.height || 0;
  const elementTop = rect.top + (container ? rect.top - rect.top : 0) + scroll.top - (rect.top - (container ? (container as HTMLElement).getBoundingClientRect().top : 0));
  const elementHeight = rect.height || 0;
  const startScroll = start === "enter" ? elementTop - height : start === "start" ? elementTop : start;
  const endScroll = end === "end" ? elementTop + elementHeight - height : end;
  return { start: startScroll, end: Math.max(startScroll + 1, endScroll) };
}

/** Authoring entry point: `createScroll(engine, ".card", { y: [40, 0] }, {...})`. */
export function createScroll(
  engine: WavesMotionEngine,
  target: TargetInput,
  properties: Record<string, any>,
  options: ConstructorParameters<typeof ScrollController>[0]["options"] = {}
): ScrollController {
  return new ScrollController({ engine, target, properties, options }).play();
}


