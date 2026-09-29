/**
 * Seeded randomness.
 *
 * "Animations must be deterministic. Avoid randomness unless explicitly
 * requested. Provide seeded randomness where randomness is useful."
 *
 * Every random value the engine produces flows through a `RandomSource`.
 * Given the same seed, the same sequence is produced — in the browser, in the
 * CLI and in tests. This is what lets OpenCode reproduce and debug its own work.
 */

export interface RandomSource {
  readonly seed: number;
  /** Next float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  bool(p?: number): boolean;
  /** Deterministic pick from a list. */
  pick<T>(items: readonly T[]): T;
  /** Deterministic Fisher–Yates shuffle (returns a copy). */
  shuffle<T>(items: readonly T[]): T[];
  /** Random signed unit value, useful for restrained jitter. */
  signed(amount?: number): number;
  /** Reset back to the initial seed. */
  reset(): void;
}

/** mulberry32 — small, fast, well-distributed, ideal for deterministic motion. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string into a stable 32-bit seed (FNV-1a). */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRandom(seed: number | string = 42): RandomSource {
  const numeric = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
  let generator = mulberry32(numeric);

  const source: RandomSource = {
    seed: numeric,
    next: () => generator(),
    range: (min, max) => min + generator() * (max - min),
    int: (min, max) => Math.floor(min + generator() * (max - min + 1)),
    bool: (p = 0.5) => generator() < p,
    pick: (items) => {
      if (!items.length) throw new RangeError("[waves-motion] pick() called with an empty list");
      return items[Math.floor(generator() * items.length)];
    },
    shuffle: (items) => {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(generator() * (i + 1));
        const tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
      }
      return copy;
    },
    signed: (amount = 1) => (generator() * 2 - 1) * amount,
    reset: () => {
      generator = mulberry32(numeric);
    }
  };

  return source;
}

/** Default engine-wide source; re-seeded through `waves.configure({ seed })`. */
let globalRandom = createRandom(42);

export function setGlobalRandom(seed: number | string): RandomSource {
  globalRandom = createRandom(seed);
  return globalRandom;
}

export function getGlobalRandom(): RandomSource {
  return globalRandom;
}

/** `waves.random({ seed: 42 })` */
export function random(options: { seed?: number | string } = {}): RandomSource {
  return options.seed === undefined ? getGlobalRandom() : createRandom(options.seed);
}