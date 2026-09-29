/**
 * Operation lifecycle guards for audio/media paths.
 *
 * Every external or media operation in the Lab resolves through here:
 * - withTimeout: hard ceiling on any await (decode, bridge, metadata,
 *   export). The timer is always cleared on settle — timeouts bound
 *   waiting, they never substitute for completion semantics.
 * - createOpToken: single-active-operation ownership. Starting, cancelling,
 *   or replacing work invalidates every in-flight continuation, so a
 *   stale upload/generation can never write state over newer work and a
 *   hung predecessor can never hold the UI hostage.
 * - pickDuration / probeFileDuration: durations come from actual loaded
 *   media metadata. First finite positive value wins; nothing is
 *   hardcoded and no event is awaited without a timeout.
 */

export type LifecycleStage = "idle" | "loading" | "processing" | "playing" | "exporting" | "complete" | "error";

/** MCP bridge round-trip ceiling (server kills its child at 25s). */
export const BRIDGE_TIMEOUT_MS = 45_000;
/** AudioContext decode ceiling for a <=50MB voiceover. */
export const DECODE_TIMEOUT_MS = 30_000;
/** <audio> metadata probe ceiling. */
export const METADATA_TIMEOUT_MS = 10_000;
/** Export ceiling (record + headless capture + ffmpeg transcode). */
export const EXPORT_TIMEOUT_MS = 300_000;

export class TimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "TimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a promise against a hard timeout. Inner rejections propagate
 * unchanged (never masked as timeouts); the timer clears on settle.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timer = null;
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  return Promise.race([promise, guard]).then(
    (value) => {
      if (timer !== null) clearTimeout(timer);
      return value;
    },
    (error: unknown) => {
      if (timer !== null) clearTimeout(timer);
      throw error;
    }
  );
}

export interface OpToken {
  next(): number;
  alive(candidate: number): boolean;
  current(): number;
}

/** Monotonic single-owner token source. next() invalidates all prior ids. */
export function createOpToken(): OpToken {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    alive(candidate: number): boolean {
      return candidate === current;
    },
    current(): number {
      return current;
    }
  };
}

/** First finite positive duration wins (ms, rounded). Null when none qualify. */
export function pickDuration(candidates: Array<number | null | undefined>): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return Math.round(candidate);
    }
  }
  return null;
}

/**
 * Fetch JSON with a hard timeout. Non-2xx responses reject with the HTTP
 * status (callers decide whether that is terminal or retryable); an
 * expired wait rejects as TimeoutError. Never awaits indefinitely.
 */
export async function fetchJson<T>(url: string, timeoutMs: number, label: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}).`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TimeoutError(label, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a File's real duration from loaded media metadata. Rejects on
 * timeout, load error, or missing duration — callers fall back to the
 * decoded buffer, never to a guess.
 */
export function probeFileDuration(file: File, timeoutMs: number = METADATA_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let done = false;
    const finish = (action: () => void): void => {
      if (done) return;
      done = true;
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* revoke is best-effort */
      }
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new TimeoutError("audio metadata", timeoutMs)));
    }, timeoutMs);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const picked = pickDuration([audio.duration * 1000]);
      clearTimeout(timer);
      finish(() => {
        if (picked !== null) resolve(picked);
        else reject(new Error("Audio metadata has no duration."));
      });
    };
    audio.onerror = () => {
      clearTimeout(timer);
      finish(() => reject(new Error("Audio metadata failed to load.")));
    };
    audio.src = url;
  });
}
