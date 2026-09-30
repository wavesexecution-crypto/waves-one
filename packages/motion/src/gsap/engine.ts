/**
 * GsapEngine — the dedicated GSAP execution layer.
 *
 * Motion specs in, GSAP timelines out. All DOM writes happen inside a
 * `gsap.context()` scoped to the mount scope, so `dispose()` reverts
 * everything: inline styles, ScrollTriggers, and the text-splitter's DOM.
 * GSAP owns all timing — no rAF loops, no manual tickers here.
 */

import { gsap } from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { createSpringEasing } from "../spring";
import { planTimeline } from "./plan";
import { GSAP_SPRING_PRESETS, type GsapMotionPathOp, type GsapOp, type GsapParallaxOp, type GsapSceneSpec, type GsapScrollOp, type GsapSpringOp, type GsapStaggerOp, type GsapTextOp, type GsapTweenOp } from "./spec";
import { validateGsapSpec } from "./validate";

export type GsapPlaybackState = "IDLE" | "PLAYING" | "PAUSED" | "COMPLETED";

export interface GsapEngineOptions {
  /** Scope for selector text and gsap.context. Defaults to document. */
  scope?: string | Element | Document;
  /** "auto" reads prefers-reduced-motion; "on"/"off" force it. */
  reducedMotion?: "auto" | "on" | "off";
}

export interface GsapBuildWarnings {
  skipped: string[];
  warnings: string[];
  reducedMotionApplied: boolean;
}

export interface GsapPlayback {
  readonly id: string;
  readonly totalMs: number;
  state(): GsapPlaybackState;
  onStateChange(listener: (state: GsapPlaybackState) => void): () => void;
  /**
   * Fires on every GSAP tick that advances the timeline, carrying real
   * timeline time in seconds.
   *
   * This exists so consumers do not have to poll with their own `setInterval`.
   * A competing timer reads `time()` out of step with GSAP's ticker, which is
   * how a transport clock ends up looking alive while the stage is showing a
   * stale frame. Driving the clock from the timeline's own `onUpdate` makes the
   * readout and the rendered frame the same source of truth.
   */
  onUpdate(listener: (timeSeconds: number, progress: number) => void): () => void;
  play(): void;
  pause(): void;
  restart(): void;
  reverse(): void;
  kill(): void;
  time(value?: number): number;
  progress(value?: number): number;
  /** The live GSAP timeline (advanced use, inspection). */
  timeline(): gsap.core.Timeline;
}

/**
 * Plugin availability is tracked per plugin, not as one flag: ScrollTrigger
 * needs `matchMedia`, which non-browser environments may lack, and a single
 * shared try/catch would take MotionPathPlugin down with it.
 */
const pluginReady = { scrollTrigger: false, motionPath: false, attempted: false };

function ensureScrollTrigger(): boolean {
  if (pluginReady.scrollTrigger) return true;
  if (pluginReady.attempted) return false;
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  pluginReady.attempted = true;
  try {
    gsap.registerPlugin(ScrollTrigger);
    pluginReady.scrollTrigger = true;
  } catch {
    /* environment without matchMedia — scroll/parallax ops degrade */
  }
  return pluginReady.scrollTrigger;
}

function ensureMotionPath(): boolean {
  if (pluginReady.motionPath) return true;
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  try {
    gsap.registerPlugin(MotionPathPlugin);
    pluginReady.motionPath = true;
  } catch {
    /* plugin unavailable — motion-path ops degrade */
  }
  return pluginReady.motionPath;
}

function reducedMotionPreferred(mode: "auto" | "on" | "off"): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
  } catch {
    /* no media query — full motion */
  }
  return false;
}

function resolveScope(scope: string | Element | Document | undefined): Element | Document | undefined {
  if (scope === undefined) return typeof document !== "undefined" ? document : undefined;
  if (typeof scope === "string") {
    try {
      if (typeof document !== "undefined") return document.querySelector(scope) ?? undefined;
    } catch {
      return undefined;
    }
    return undefined;
  }
  return scope;
}

function countTargets(scope: Element | Document | undefined, selector: string): number {
  if (!scope) return 0;
  try {
    return scope.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function toVars(input: Record<string, number | string> | undefined): Record<string, number | string> {
  return { ...(input ?? {}) };
}

function springEase(spring: GsapSpringOp["spring"]): (t: number) => number {
  const config = typeof spring === "string" ? GSAP_SPRING_PRESETS[spring] : spring;
  const easing = createSpringEasing({ stiffness: config.stiffness, damping: config.damping, mass: config.mass ?? 1 });
  return (t: number) => easing(t);
}

const CHAR_CLASS = "waves-gsap-char";

function splitTextContent(target: Element, mode: "chars" | "words"): Element[] {
  const text = target.textContent ?? "";
  target.textContent = "";
  const out: Element[] = [];
  const push = (content: string) => {
    const span = document.createElement("span");
    span.className = CHAR_CLASS;
    span.style.display = "inline-block";
    // Deliberately no `will-change`: a text reveal can split into 50+ spans and
    // promoting every one of them for the life of the timeline costs far more
    // in compositing than the tween saves. GSAP's force3D handles the tween.
    span.textContent = content;
    target.appendChild(span);
    out.push(span);
  };
  if (mode === "words") {
    const words = text.split(/(\s+)/);
    for (const word of words) {
      if (!word) continue;
      if (/^\s+$/.test(word)) {
        target.appendChild(document.createTextNode(" "));
        continue;
      }
      push(word);
    }
  } else {
    for (const char of text) push(char === " " ? " " : char);
  }
  return out;
}

let playbackCounter = 0;

export class GsapEngine {
  private readonly options: Required<Pick<GsapEngineOptions, "reducedMotion">> & Pick<GsapEngineOptions, "scope">;
  private ctx: gsap.Context | null = null;
  private triggers: ScrollTrigger[] = [];
  private timelines = new Set<gsap.core.Timeline>();
  private snapshots = new Map<Element, string>();

  constructor(options: GsapEngineOptions = {}) {
    this.options = { scope: options.scope, reducedMotion: options.reducedMotion ?? "auto" };
  }

  /** Build a scene into a controllable playback. Throws on invalid specs. */
  build(spec: GsapSceneSpec, opts: { autoplay?: boolean } = {}): { playback: GsapPlayback; report: GsapBuildWarnings } {
    const report: GsapBuildWarnings = { skipped: [], warnings: [], reducedMotionApplied: false };
    const scopeEl = resolveScope(this.options.scope);
    const validation = validateGsapSpec(spec, {
      resolveTarget: scopeEl ? (selector) => countTargets(scopeEl, selector) : undefined
    });
    if (!validation.ok) {
      // A whole scene failing on one cause (e.g. a bundle that does not host
      // the stage markup) can be hundreds of identical issues. Keep the
      // thrown message short and legible; the validator still holds them all.
      const summary = validation.errors.slice(0, 4).map((issue) => `${issue.opId}:${issue.code}`).join(", ");
      const extra = validation.errors.length > 4 ? ` (+${validation.errors.length - 4} more)` : "";
      throw new Error(`Invalid GSAP scene "${spec.name}": ${validation.errors.length} error(s) — ${summary}${extra}`);
    }
    for (const warning of validation.warnings) report.warnings.push(`${warning.opId}:${warning.code} ${warning.message}`);

    const reduced = reducedMotionPreferred(this.options.reducedMotion);
    report.reducedMotionApplied = reduced;
    const autoplay = opts.autoplay ?? !reduced;

    this.dispose();
    const ctx = gsap.context(() => {}, scopeEl);
    this.ctx = ctx;
    // Register what this environment can support; per-plugin so one failure
    // (ScrollTrigger needs matchMedia) never disables the others.
    ensureMotionPath();
    ensureScrollTrigger();

    const tl = gsap.timeline({ paused: true, defaults: { duration: 0.5, ease: "power3.out", ...(spec.defaults ?? {}) } });
    let state: GsapPlaybackState = "IDLE";
    const listeners = new Set<(state: GsapPlaybackState) => void>();
    const setState = (next: GsapPlaybackState) => {
      if (state === next) return;
      state = next;
      for (const listener of listeners) {
        try {
          listener(next);
        } catch {
          /* listener errors never break playback */
        }
      }
    };
    tl.eventCallback("onStart", () => setState("PLAYING"));
    tl.eventCallback("onComplete", () => setState("COMPLETED"));
    tl.eventCallback("onReverseComplete", () => setState("IDLE"));

    // Real per-tick progress, from GSAP's own ticker. A paused timeline that is
    // seeked (scrub, reduced-motion step) does not fire onUpdate, so the
    // listeners are also drained explicitly by `time`/`progress` below.
    const updateListeners = new Set<(timeSeconds: number, progress: number) => void>();
    const emitUpdate = (): void => {
      if (updateListeners.size === 0) return;
      const t = tl.time();
      const p = tl.progress();
      for (const listener of updateListeners) {
        try {
          listener(t, p);
        } catch {
          /* listener errors never break playback */
        }
      }
    };
    tl.eventCallback("onUpdate", emitUpdate);

    const at = (op: GsapOp): gsap.Position => (op.position === undefined ? ">" : (op.position as gsap.Position));
    const queryOrWarn = (op: GsapOp): string | null => {
      if (scopeEl && countTargets(scopeEl, op.target) === 0) {
        report.skipped.push(`${op.id}: target "${op.target}" matched nothing at build — skipped.`);
        return null;
      }
      return op.target;
    };

    ctx.add(() => {
      for (const op of spec.ops) {
        if (reduced && (op.ambient || op.skipOnReducedMotion || op.type === "scroll" || op.type === "parallax")) {
          report.skipped.push(`${op.id}: skipped under reduced motion (end state applied).`);
          continue;
        }
        try {
          this.appendOp(tl, op, at(op), queryOrWarn, report);
        } catch (error) {
          report.skipped.push(`${op.id}: build failed (${error instanceof Error ? error.message : String(error)}) — skipped.`);
        }
      }
    });

    // A paused timeline does not render time 0 on its own, so `set` ops that
    // park an element's initial state never land until the first play().
    // `render(0)` is the one call that forces that frame (progress/time/
    // totalProgress short-circuit on an unchanged time).
    if (!reduced) tl.render(0, false, true);

    const playback: GsapPlayback = {
      id: `gsap-${(playbackCounter += 1)}`,
      // Deterministic plan total: tl.totalDuration() explodes with ambient
      // repeat:-1 tweens, so the plan (ambient counted once) is the truth.
      totalMs: planTimeline(spec).totalMs,
      state: () => state,
      onStateChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onUpdate: (listener) => {
        updateListeners.add(listener);
        return () => {
          updateListeners.delete(listener);
        };
      },
      play: () => {
        // At the end, play holds COMPLETED (restart() replays explicitly).
        if (tl.progress() >= 1) {
          tl.pause();
          setState("COMPLETED");
          return;
        }
        tl.play();
        setState("PLAYING");
      },
      pause: () => {
        tl.pause();
        setState(tl.progress() >= 1 ? "COMPLETED" : "PAUSED");
      },
      restart: () => {
        tl.restart();
        setState("PLAYING");
      },
      reverse: () => {
        tl.reverse();
        setState("PLAYING");
      },
      kill: () => {
        tl.kill();
        setState("IDLE");
      },
      // A seek on a paused timeline DOES fire the timeline's own onUpdate, so
      // there is deliberately no manual emit here: adding one double-fired every
      // scrub, and a consumer counting ticks would see two per seek.
      time: (value?: number) => {
        if (value === undefined) return tl.time();
        tl.time(value);
        return tl.time();
      },
      progress: (value?: number) => {
        if (value === undefined) return tl.progress();
        tl.progress(value);
        return tl.progress();
      },
      timeline: () => tl
    };

    this.timelines.add(tl);
    if (reduced) {
      // Final visual state immediately: scrubbed ops were skipped, so land
      // every built tween at its end. Usability preserved, nothing moves.
      tl.progress(1);
      setState("COMPLETED");
    } else if (autoplay) {
      playback.play();
    }
    return { playback, report };
  }

  /** Apply initial states immediately (gsap.set inside the context). */
  setInitialState(ops: GsapOp | GsapOp[]): void {
    const list = Array.isArray(ops) ? ops : [ops];
    const scopeEl = resolveScope(this.options.scope);
    if (!this.ctx) this.ctx = gsap.context(() => {}, scopeEl);
    this.ctx.add(() => {
      for (const op of list) {
        if (op.type !== "set") continue;
        gsap.set(op.target, toVars(op.to));
      }
    });
  }

  createTimeline(vars?: gsap.TimelineVars): gsap.core.Timeline {
    return gsap.timeline(vars);
  }

  /** Stagger origins: spec vocabulary → GSAP vocabulary. */
  private staggerVars(op: GsapStaggerOp): gsap.StaggerVars {
    if (typeof op.stagger === "number") return { each: op.stagger };
    const from = op.stagger.from === "first" ? "start" : op.stagger.from === "last" ? "end" : (op.stagger.from ?? "start");
    return { each: op.stagger.each, from };
  }

  /**
   * One animation for `from`/`to` ops. An op with no `from` is a plain `to`:
   * a `fromTo` with empty start vars still immediate-renders, which can clear
   * the parked state a preceding `set` op just applied.
   */
  private varsAnimation(
    target: gsap.TweenTarget,
    from: Record<string, number | string> | undefined,
    to: Record<string, number | string>,
    extra: gsap.TweenVars
  ): gsap.core.Tween {
    const end = { ...toVars(to), ...extra };
    if (Object.keys(toVars(from)).length > 0) return gsap.fromTo(target, toVars(from), end);
    // No `from`: this is a plain `to` and must not immediate-render, or it
    // overwrites the parked state a preceding `set` op applied before its own
    // start time is reached.
    return gsap.to(target, { immediateRender: false, ...end });
  }

  addTween(tl: gsap.core.Timeline, op: GsapTweenOp, position?: gsap.Position): gsap.core.Tween {
    const tween = this.varsAnimation(op.target, op.from, op.to, { duration: op.duration ?? 0.5, ease: op.ease ?? "power3.out", delay: op.delay ?? 0 });
    tl.add(tween, position ?? ">");
    return tween;
  }

  addStagger(tl: gsap.core.Timeline, op: GsapStaggerOp, position?: gsap.Position): gsap.core.Tween {
    const tween = this.varsAnimation(op.target, op.from, op.to, {
      duration: op.duration ?? 0.5,
      ease: op.ease ?? "power3.out",
      delay: op.delay ?? 0,
      stagger: this.staggerVars(op)
    });
    tl.add(tween, position ?? ">");
    return tween;
  }

  addTextMotion(tl: gsap.core.Timeline, op: GsapTextOp, position?: gsap.Position): gsap.core.Tween | null {
    const scopeEl = resolveScope(this.options.scope);
    if (!scopeEl || typeof document === "undefined") return null;
    const root = scopeEl.querySelector(op.target);
    if (!(root instanceof Element)) return null;
    if (!this.snapshots.has(root)) this.snapshots.set(root, root.innerHTML);
    const parts = splitTextContent(root, op.split ?? "chars");
    if (parts.length === 0) return null;
    // The container is a layout box the chars live inside; a `text` op must
    // not put the reveal's opacity on it or the chars sit inside a hidden box.
    // Specs fade the container with their own op when they want it hidden.
    const tween = this.varsAnimation(parts, op.from, op.to, {
      duration: op.duration ?? 0.5,
      ease: op.ease ?? "power3.out",
      delay: op.delay ?? 0,
      stagger: op.stagger ?? 0.04
    });
    tl.add(tween, position ?? ">");
    return tween;
  }

  addScrollMotion(tl: gsap.core.Timeline, op: GsapScrollOp, report?: GsapBuildWarnings): gsap.core.Tween | null {
    if (!ensureScrollTrigger()) {
      report?.skipped.push(`${op.id}: ScrollTrigger unavailable — scroll op skipped.`);
      return null;
    }
    const tween = gsap.fromTo(
      op.target,
      toVars(op.from),
      {
        ...toVars(op.to),
        duration: op.duration ?? 0.5,
        ease: op.ease ?? "none",
        scrollTrigger: {
          trigger: op.trigger ?? op.target,
          start: op.start ?? "top bottom",
          end: op.end ?? "bottom top",
          scrub: op.scrub ?? true,
          onToggle: (self) => {
            if (!this.triggers.includes(self)) this.triggers.push(self);
          }
        }
      }
    );
    tl.add(tween, op.position === undefined ? ">" : (op.position as gsap.Position));
    return tween;
  }

  addSpring(tl: gsap.core.Timeline, op: GsapSpringOp, position?: gsap.Position): gsap.core.Tween {
    const tween = this.varsAnimation(op.target, op.from, op.to, { duration: op.duration ?? 0.8, delay: op.delay ?? 0, ease: springEase(op.spring) });
    tl.add(tween, position ?? ">");
    return tween;
  }

  addMotionPath(tl: gsap.core.Timeline, op: GsapMotionPathOp, report?: GsapBuildWarnings): gsap.core.Tween | null {
    if (!ensureMotionPath()) {
      report?.skipped.push(`${op.id}: MotionPathPlugin unavailable — motion-path op skipped.`);
      return null;
    }
    const path = Array.isArray(op.path) ? op.path.map((point) => ({ x: point.x, y: point.y })) : op.path;
    const tween = gsap.to(op.target, {
      duration: op.duration ?? 1,
      ease: op.ease ?? "power2.inOut",
      delay: op.delay ?? 0,
      motionPath: { path: path as string, ...(op.align ? { align: op.align } : {}), ...(op.alignOrigin ? { alignOrigin: op.alignOrigin } : {}), ...(op.curviness !== undefined ? { curviness: op.curviness } : {}) }
    });
    tl.add(tween, op.position === undefined ? ">" : (op.position as gsap.Position));
    return tween;
  }

  addParallax(tl: gsap.core.Timeline, op: GsapParallaxOp, report?: GsapBuildWarnings): gsap.core.Tween | null {
    if (!ensureScrollTrigger()) {
      report?.skipped.push(`${op.id}: ScrollTrigger unavailable — parallax op skipped.`);
      return null;
    }
    const tween = gsap.fromTo(op.target, { yPercent: -op.speed * 10 }, {
      yPercent: op.speed * 10,
      ease: "none",
      scrollTrigger: {
        trigger: op.trigger ?? op.target,
        start: op.start ?? "top bottom",
        end: op.end ?? "bottom top",
        scrub: true,
        onToggle: (self) => {
          if (!this.triggers.includes(self)) this.triggers.push(self);
        }
      }
    });
    tl.add(tween, op.position === undefined ? ">" : (op.position as gsap.Position));
    return tween;
  }

  private appendOp(
    tl: gsap.core.Timeline,
    op: GsapOp,
    position: gsap.Position,
    queryOrWarn: (op: GsapOp) => string | null,
    report: GsapBuildWarnings
  ): void {
    switch (op.type) {
      case "set": {
        if (!queryOrWarn(op)) return;
        tl.set(op.target, toVars(op.to), position);
        return;
      }
      case "tween": {
        if (!queryOrWarn(op)) return;
        const tween = this.addTween(tl, op, position);
        if (op.ambient) tween.repeat(-1).yoyo(true);
        return;
      }
      case "stagger": {
        if (!queryOrWarn(op)) return;
        const tween = this.addStagger(tl, op, position);
        if (op.ambient) tween.repeat(-1).yoyo(true);
        return;
      }
      case "text": {
        const built = this.addTextMotion(tl, op, position);
        if (!built) report.skipped.push(`${op.id}: text target unavailable — skipped.`);
        else if (op.ambient) built.repeat(-1).yoyo(true);
        return;
      }
      case "scroll": {
        if (!queryOrWarn(op)) return;
        this.addScrollMotion(tl, op as GsapScrollOp, report);
        return;
      }
      case "spring": {
        if (!queryOrWarn(op)) return;
        this.addSpring(tl, op as GsapSpringOp, position);
        return;
      }
      case "motion-path": {
        if (!queryOrWarn(op)) return;
        this.addMotionPath(tl, op as GsapMotionPathOp, report);
        return;
      }
      case "parallax": {
        if (!queryOrWarn(op)) return;
        this.addParallax(tl, op as GsapParallaxOp, report);
        return;
      }
    }
  }

  /** Revert everything: kill timelines/triggers, restore split DOM, revert context. */
  dispose(): void {
    // Timelines first: a discarded-but-playing timeline would otherwise keep
    // writing styles and firing completion callbacks into a dead playback.
    for (const tl of this.timelines) {
      try {
        tl.kill();
      } catch {
        /* already dead */
      }
    }
    this.timelines.clear();
    for (const trigger of this.triggers) {
      try {
        trigger.kill();
      } catch {
        /* already dead */
      }
    }
    this.triggers = [];
    for (const [element, html] of this.snapshots) {
      try {
        element.innerHTML = html;
      } catch {
        /* detached */
      }
    }
    this.snapshots.clear();
    if (this.ctx) {
      try {
        this.ctx.revert();
      } catch {
        /* nothing recorded */
      }
      this.ctx = null;
    }
  }
}

/** Convenience: build a spec in one call. The engine owns cleanup. */
export function playGsapScene(
  spec: GsapSceneSpec,
  options: GsapEngineOptions & { autoplay?: boolean } = {}
): { engine: GsapEngine; playback: GsapPlayback; report: GsapBuildWarnings } {
  const engine = new GsapEngine(options);
  const { playback, report } = engine.build(spec, { autoplay: options.autoplay });
  return { engine, playback, report };
}

export { planTimeline };
export type { GsapPlan, PlannedOp } from "./plan";
