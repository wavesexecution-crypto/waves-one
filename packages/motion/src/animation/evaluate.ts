/**
 * Per-frame track evaluation.
 *
 * Pure helpers the `Animation` frame loop uses to turn a keyframe track plus a
 * local time into a CSS-ready value string. Keeps `animation.ts` free of value
 * maths and makes the evaluation trivially unit-testable.
 */

import type { EasingFunction, Primitive } from "../types";
import type { PropertyDefinition } from "../core/properties";
import { interpolateValues, parseValue } from "../core/values";
import type { ParsedValue } from "../core/values";
import type { PropertyTrack } from "./animation";

/**
 * Evaluate a track at `localTime` (ms within the current iteration).
 * `direction` is 1 (forward) or −1 (yoyo/reverse), applied by mirroring time.
 * `elementFrom` overrides the first keyframe for per-element captured bases
 * (`to`-only animations start from wherever the element actually is).
 */
export function evaluateTrackTime(
  track: PropertyTrack,
  localTime: number,
  direction: 1 | -1,
  elementFrom?: ParsedValue
): ParsedValue {
  const keyframes = track.keyframes;
  if (keyframes.length === 0) return track.from;

  const firstValue = elementFrom ?? keyframes[0].value;
  if (keyframes.length === 1) return firstValue;

  // Mirror time for reverse/yoyo: t' = duration − t.
  const mirrored = direction === -1 ? track.toTime - localTime : localTime;
  const time = Math.max(0, Math.min(track.toTime, mirrored));

  // Before the first keyframe / after the last.
  if (time <= 0) return firstValue;
  const last = keyframes[keyframes.length - 1];
  if (time >= last.at) return last.value;

  // Find the surrounding segment.
  for (let index = 0; index < keyframes.length - 1; index++) {
    const a = keyframes[index];
    const b = keyframes[index + 1];
    const segmentFrom = index === 0 ? firstValue : a.value;
    if (time >= a.at && time <= b.at) {
      const span = Math.max(1e-6, b.at - a.at);
      const raw = (time - a.at) / span;
      const eased = (b.easing ?? defaultEase)(raw);
      return {
        ...(segmentFrom.kind === b.value.kind ? segmentFrom : b.value),
        raw: interpolateValues(segmentFrom, b.value, eased)
      };
    }
  }
  return last.value;
}

/** Linear — the default segment easing when no override is authored. */
function defaultEase(t: number): number {
  return t;
}

/** Queue a computed value on the element's writer for this frame's commit. */
export function queueWrite(
  writer: { set(name: string, value: string, raw?: unknown): void },
  track: PropertyTrack,
  value: ParsedValue
): void {
  // Seed the next animation with the CSS-ready string, not the parsed object —
  // `readBase` treats the stored value as a primitive.
  writer.set(track.name, value.raw, value.raw);
}

/** Re-parse a captured base value with the track's definition hints. */
export function parseWithHints(value: Primitive, definition: PropertyDefinition): ParsedValue {
  return parseValue(value, {
    kind: definition.kind === "unit" ? "transform" : definition.kind === "number" ? "number" : undefined,
    unit: definition.unit || undefined,
    filterName: definition.filterKey
  });
}

/** Helper shared with `animation.ts`: clamped 0–1. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Re-exported so `animation.ts` has one import site for value parsing. */
export { parseValue };
