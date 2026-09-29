/**
 * Clock + ticker.
 *
 * The engine never calls `requestAnimationFrame` directly: everything goes
 * through a `MotionClock`. That single indirection is what makes the engine
 * deterministic — swap in `createManualClock()` and every animation, timeline,
 * scroll controller and gesture can be stepped frame-by-frame with exact
 * millisecond values in a Node/vitest environment.
 */

export interface MotionClock {
  /** Monotonic time in milliseconds. */
  now(): number;
  /** Schedule a frame callback; returns a handle. */
  request(cb: (time: number) => void): number;
  /** Cancel a scheduled frame. */
  cancel(handle: number): void;
  /** True when the clock drives itself (rAF) rather than being stepped manually. */
  readonly automatic: boolean;
}

const hasRAF = typeof globalThis !== "undefined" && typeof (globalThis as any).requestAnimationFrame === "function";

/** Default browser clock: real time, real frames. */
export function createRAFClock(): MotionClock {
  if (!hasRAF) return createTimeoutClock();
  return {
    automatic: true,
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    request: (cb) => (globalThis as any).requestAnimationFrame(cb),
    cancel: (handle) => (globalThis as any).cancelAnimationFrame(handle)
  };
}

/** Timeout-based fallback for environments without rAF but with real time. */
export function createTimeoutClock(targetFps = 60): MotionClock {
  const interval = Math.max(1, Math.round(1000 / targetFps));
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  return {
    automatic: true,
    now,
    request: (cb) => setTimeout(() => cb(now()), interval) as unknown as number,
    cancel: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
  };
}

export interface ManualClock extends MotionClock {
  /** Advance the clock by `ms`, running `step`-sized frames (default 1 frame = 16.666ms). */
  advance(ms: number, step?: number): number;
  /** Run exactly one frame of `step` ms. */
  frame(step?: number): number;
  /** Move the clock without running callbacks. */
  set(time: number): void;
  /** Number of frames executed so far. */
  readonly frames: number;
}

/**
 * Deterministic clock for tests, CLI simulation and the recorder.
 * Time only moves when you tell it to.
 */
export function createManualClock(start = 0, defaultStep = 1000 / 60): ManualClock {
  let time = start;
  let frames = 0;
  let nextHandle = 1;
  const pending = new Map<number, (time: number) => void>();

  const runPending = () => {
    const callbacks = Array.from(pending.values());
    pending.clear();
    for (const cb of callbacks) cb(time);
  };

  const clock: ManualClock = {
    automatic: false,
    get frames() {
      return frames;
    },
    now: () => time,
    request(cb) {
      const handle = nextHandle++;
      pending.set(handle, cb);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    set(next) {
      time = next;
    },
    frame(step = defaultStep) {
      time += step;
      frames++;
      runPending();
      return time;
    },
    advance(ms, step = defaultStep) {
      const framesToRun = Math.max(1, Math.round(ms / step));
      for (let i = 0; i < framesToRun; i++) clock.frame(step);
      return time;
    }
  };

  return clock;
}

/**
 * A ticker multiplexes every subscriber onto one frame loop per clock.
 * One rAF per engine per frame — never one per animation.
 */
export class Ticker {
  private subscribers = new Set<(time: number, delta: number) => void>();
  private handle: number | null = null;
  private lastTime = 0;
  private statsFrames = 0;
  private dropped = 0;
  private longest = 0;
  private total = 0;

  constructor(
    public readonly clock: MotionClock,
    /** Frame budget in ms; frames slower than this count as dropped. */
    public frameBudget = 1000 / 60
  ) {}

  get size(): number {
    return this.subscribers.size;
  }

  /** Register a per-frame callback. Returns an unsubscribe function. */
  add(cb: (time: number, delta: number) => void): () => void {
    this.subscribers.add(cb);
    this.start();
    return () => {
      this.subscribers.delete(cb);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  remove(cb: (time: number, delta: number) => void): void {
    this.subscribers.delete(cb);
    if (this.subscribers.size === 0) this.stop();
  }

  /** Force one frame immediately (used to push a `seek` through synchronously). */
  flush(now = this.clock.now()): void {
    this.runFrame(now);
  }

  stats(): { frames: number; dropped: number; longestFrame: number; averageFrame: number; estimatedFps: number } {
    const frames = this.statsFrames;
    return {
      frames,
      dropped: this.dropped,
      longestFrame: Number(this.longest.toFixed(2)),
      averageFrame: frames ? Number((this.total / frames).toFixed(2)) : 0,
      estimatedFps: this.total ? Number((1000 / (this.total / frames)).toFixed(1)) : 0
    };
  }

  resetStats(): void {
    this.statsFrames = 0;
    this.dropped = 0;
    this.longest = 0;
    this.total = 0;
  }

  private start(): void {
    if (this.handle !== null || this.subscribers.size === 0) return;
    this.lastTime = this.clock.now();
    this.handle = this.clock.request(this.tick);
  }

  private stop(): void {
    if (this.handle === null) return;
    this.clock.cancel(this.handle);
    this.handle = null;
  }

  private tick = (time: number): void => {
    this.handle = null;
    this.runFrame(time);
    if (this.subscribers.size > 0) this.handle = this.clock.request(this.tick);
  };

  private runFrame(time: number): void {
    const delta = Math.max(0, time - this.lastTime);
    this.lastTime = time;
    this.statsFrames++;
    this.total += delta;
    if (delta > this.longest) this.longest = delta;
    if (delta > this.frameBudget * 1.8) this.dropped += Math.max(1, Math.round(delta / this.frameBudget) - 1);

    for (const cb of Array.from(this.subscribers)) {
      try {
        cb(time, delta);
      } catch (error) {
        // A broken animation must never take down the frame loop.
        reportFrameError(error);
      }
    }
  }
}

let frameErrorHandler: ((error: unknown) => void) | null = null;

/** Route frame errors to the engine diagnostics instead of throwing. */
export function setFrameErrorHandler(handler: ((error: unknown) => void) | null): void {
  frameErrorHandler = handler;
}

function reportFrameError(error: unknown): void {
  if (frameErrorHandler) frameErrorHandler(error);
  else if (typeof console !== "undefined") console.error("[waves-motion] frame error", error);
}

/** `performance.now()`-free sleep helper used by the CLI benchmark. */
export function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}