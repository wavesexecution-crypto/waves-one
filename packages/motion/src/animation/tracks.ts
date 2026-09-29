/**
 * Keyframe track construction.
 *
 * Turns a resolved spec's property map into per-property tracks of absolute-ms
 * keyframes. This is where authored input forms (`[40, 0]`, `{ from, to }`,
 * `{ 0: 40, 0.6: 20, 1: 0 }`) become a uniform structure the runtime can
 * evaluate per frame, and where multi-keyframe segments get their per-segment
 * easing overrides.
 */

import type { PropertyInput, PropertyMap, Primitive, ResolvedMotionSpec } from "../types";
import { getPropertyDefinition, type PropertyDefinition } from "../core/properties";
import { parseValue, type ParsedValue } from "../core/values";
import { resolveEasing } from "../easing";
import type { WavesMotionEngine } from "../core/engine";
import type { PropertyTrack } from "./animation";

/** Parse a raw value with a definition's hints. */
export function parseWithHints(value: Primitive, definition: PropertyDefinition): ParsedValue {
  return parseValue(value, {
    kind: definition.kind === "unit" ? "transform" : definition.kind === "number" ? "number" : undefined,
    unit: definition.unit || undefined,
    filterName: definition.filterKey
  });
}

/** Normalise one authored input (same rules as `animation/resolve`). */
function normalizePropertyForTrack(input: PropertyInput): Record<string, unknown> {
  if (Array.isArray(input)) {
    if (input.length === 0) return { to: 0 };
    if (input.length === 1) return { to: input[0] };
    if (input.length === 2) return { from: input[0], to: input[1] };
    const normalized: Record<string, unknown> = { from: input[0], to: input[input.length - 1] };
    for (let i = 1; i < input.length - 1; i++) {
      normalized[String(i / (input.length - 1))] = input[i];
    }
    return normalized;
  }
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    if ("from" in record || "to" in record) return record;
  }
  if (typeof input === "number" || typeof input === "string") return { to: input };
  return { to: 0 };
}

function collectOffsets(record: Record<string, unknown>): { offset: number; value: unknown }[] {
  const entries: { offset: number; value: unknown }[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === "from") continue;
    if (key === "to") {
      entries.push({ offset: 1, value });
      continue;
    }
    const offset = Number(key);
    if (Number.isFinite(offset) && offset > 0 && offset < 1) {
      entries.push({ offset, value });
    }
  }
  if (!entries.length && record.to !== undefined) entries.push({ offset: 1, value: record.to });
  return entries;
}

/** Build all tracks for a spec. `bases` resolves per-element writer bases. */
export function buildTracksFromSpec(
  spec: ResolvedMotionSpec,
  duration: number,
  engine: WavesMotionEngine,
  bases: Map<string, Primitive>
): PropertyTrack[] {
  const tracks: PropertyTrack[] = [];
  const properties = (spec.properties ?? {}) as PropertyMap;

  for (const [name, input] of Object.entries(properties)) {
    const definition = getPropertyDefinition(name);
    if (!definition) continue;

    const record = normalizePropertyForTrack(input);
    const offsets = collectOffsets(record);

    // The from value: authored or captured from the writer/base map.
    const authoredFrom = "from" in record && record.from !== undefined ? record.from : undefined;
    const fromAuthored = authoredFrom !== undefined;
    const base = (fromAuthored ? authoredFrom : bases.get(name) ?? definition.identity) as Primitive;

    // Wire the authored easing into the segments. `spec.easing` is "custom-fn"
    // when the author left the easing option alone (or passed a raw function),
    // so resolution here only triggers for explicitly chosen curves and springs.
    const segmentEasing =
      spec.easing !== "custom-fn"
        ? resolveEasing(spec.easing as import("../types").EasingSpec, engine.config.get()).fn
        : undefined;

    const keyframes = offsets
      .map((entry) => ({
        at: entry.offset * duration,
        value: parseWithHints(entry.value as Primitive, definition),
        easing: segmentEasing
      }))
      .sort((a, b) => a.at - b.at);
    keyframes.unshift({ at: 0, value: parseWithHints(base, definition), easing: undefined });

    tracks.push({
      name: definition.name,
      definition,
      keyframes,
      from: parseWithHints(base, definition),
      to: keyframes[keyframes.length - 1].value,
      base,
      fromAuthored,
      toTime: duration
    });
  }

  return tracks;
}
