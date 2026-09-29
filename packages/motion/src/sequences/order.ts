/**
 * Stagger ordering strategies.
 *
 * A stagger is only ever a *reordering* of the resolved target list plus a
 * per-rank delay. Ordering is pure: given the same inputs it produces the same
 * rank order in the browser, in Node and in tests — which is what makes
 * AI-generated staggers deterministic and debuggable.
 */

import type { StaggerOrigin } from "../types";
import { createRandom } from "../core/random";
import { fail } from "../core/errors";

export interface StaggerOrderOptions {
  origin?: StaggerOrigin;
  /** Custom ranking — receives (index, total), returns the rank. */
  order?: (index: number, total: number) => number;
  /** Seeded randomness for `from: "random"`. */
  seed?: number;
  /** Grid coordinates for `from: "center" | "edges"` when DOM order lies. */
  positions?: { x: number; y: number }[];
  /** Invert the resolved ordering. */
  reverse?: boolean;
}

/** Euclidean distance helpers for grid-based ordering. */
function distanceFrom(index: number, positions: { x: number; y: number }[] | undefined, x: number, y: number): number {
  if (!positions || !positions[index]) return 0;
  const p = positions[index];
  return Math.hypot(p.x - x, p.y - y);
}

/**
 * Resolve the play order for `total` targets.
 * Returns an array of original indices in the order they should animate.
 */
export function resolveStaggerOrder(total: number, options: StaggerOrderOptions = {}): number[] {
  const origin = options.origin ?? "first";
  const indices = Array.from({ length: total }, (_value, index) => index);

  switch (origin) {
    case "first":
    case "index":
      break; // DOM order
    case "last":
      indices.reverse();
      break;
    case "center": {
      if (options.positions) {
        const xs = options.positions.map((p) => p.x);
        const ys = options.positions.map((p) => p.y);
        const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
        const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
        indices.sort((a, b) => distanceFrom(a, options.positions, midX, midY) - distanceFrom(b, options.positions, midX, midY));
      } else {
        const mid = (total - 1) / 2;
        indices.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
      }
      break;
    }
    case "edges": {
      if (options.positions) {
        const xs = options.positions.map((p) => p.x);
        const ys = options.positions.map((p) => p.y);
        const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
        const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
        indices.sort(
          (a, b) => distanceFrom(b, options.positions, midX, midY) - distanceFrom(a, options.positions, midX, midY)
        );
      } else {
        const mid = (total - 1) / 2;
        indices.sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid));
      }
      break;
    }
    case "random": {
      const shuffled = createRandom(options.seed ?? 42).shuffle(indices);
      indices.length = 0;
      indices.push(...shuffled);
      break;
    }
    case "custom": {
      if (typeof options.order !== "function") {
        fail("MOTION_UNKNOWN_STAGGER_ORIGIN", 'Stagger origin "custom" requires an `order(index, total)` function.');
      }
      const ranks = indices.map((index) => ({ index, rank: options.order!(index, total) }));
      ranks.sort((a, b) => a.rank - b.rank);
      indices.length = 0;
      indices.push(...ranks.map((entry) => entry.index));
      break;
    }
    default:
      fail("MOTION_UNKNOWN_STAGGER_ORIGIN", `Unknown stagger origin "${String(origin)}".`);
  }

  if (options.reverse) indices.reverse();
  return indices;
}

/**
 * Delay per target rank.
 * The first played target always starts at the animation's own delay.
 */
export function staggerDelayFor(rank: number, stagger: number): number {
  return Math.max(0, rank) * stagger;
}

/**
 * Resolve 2D grid coordinates for a target list — used by grid-aware staggers.
 * Coordinates are grid cells derived from bounding-box alignment, so DOM order
 * never has to match visual order.
 */
export function gridPositions(rects: { left: number; top: number; width: number; height: number }[]): {
  x: number;
  y: number;
}[] {
  if (!rects.length) return [];
  const baseLeft = Math.min(...rects.map((rect) => rect.left));
  const baseTop = Math.min(...rects.map((rect) => rect.top));
  return rects.map((rect) => ({
    x: Math.round((rect.left - baseLeft) / Math.max(1, rect.width)),
    y: Math.round((rect.top - baseTop) / Math.max(1, rect.height))
  }));
}
