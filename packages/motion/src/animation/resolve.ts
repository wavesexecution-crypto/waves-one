/**
 * Spec resolution — turns authored input into a `ResolvedMotionSpec`.
 *
 * This is the single path every animation takes: `waves.animate`, presets,
 * stagger, text, scroll, gestures, React props and timeline nodes all funnel
 * through `resolveSpec`. That is what makes the system inspectable — the
 * schema, the inspector, the recorder and the CLI always see the same resolved
 * shape, whatever the author wrote.
 *
 * Resolution is a pure function of (target, properties, options, config).
 * It never throws for soft problems: unknown properties and missing targets
 * become machine-readable diagnostics instead of crashes.
 */

import type {
  MotionOptions,
  MotionSpec,
  Primitive,
  PropertyInput,
  PropertyMap,
  ResolvedMotionSpec,
  SpringInput,
  TargetInput
} from "../types";
import { classifyProperty, getPropertyDefinition } from "../core/properties";
import { describeTarget } from "../core/dom";
import { resolveEasing, type ResolvedEasing } from "../easing";
import { degradeDuration } from "../core/reduced-motion";
import { reportDiagnostic } from "../core/errors";
import { normalizeSpring, createSpringEasing } from "../spring";
import type { WavesMotionConfig } from "../core/config";
import type { ConfigStore } from "../core/config";

/** Structural engine view — avoids an import cycle with `core/engine`. */
export interface SpecHost {
  readonly config: ConfigStore;
  isReducedMotion(): boolean;
  targets(target: TargetInput): Element[];
}

const NUMERIC_KEY = /^(0(\.\d+)?|1)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ResolveOptions extends MotionOptions {
  /** Preset that produced this spec, e.g. `"rise"`. */
  origin?: string;
  /** Preset parameters carried through to the schema. */
  params?: Record<string, unknown>;
}

export interface ResolvedAnimation {
  spec: ResolvedMotionSpec;
  easing: ResolvedEasing;
  /** Single-iteration duration after reduced-motion degradation. */
  duration: number;
  /** delay + duration × (repeat + 1) — what timelines actually schedule. */
  totalDuration: number;
  /** delay + duration — one pass including the initial delay. */
  passDuration: number;
  reduced: boolean;
  targets: Element[];
}

/** The canonical spec string for the resolved target set. */
function targetLabel(target: TargetInput, elements: Element[]): string {
  if (typeof target === "string" && target.length > 0) return target;
  if (elements.length > 0) return elements.map((element) => describeTarget(element)).join(", ");
  return "(no targets)";
}

/** Build the schema-ready easing value (names/beziers only). */
function specEasingValue(spec?: MotionOptions["easing"]): string | [number, number, number, number] {
  if (typeof spec === "string") return spec;
  if (Array.isArray(spec)) return spec as [number, number, number, number];
  return "custom-fn";
}

/**
 * Resolve everything. Deterministic: the same inputs always produce the same
 * spec — the same duration, the same delay, the same cost table.
 */
export function resolveSpec(
  target: TargetInput,
  properties: PropertyMap,
  options: ResolveOptions = {},
  host?: SpecHost
): ResolvedAnimation {
  const safeConfig: WavesMotionConfig = host ? host.config.get() : ({} as WavesMotionConfig);
  const elements = host ? host.targets(target) : [];
  const reduced = host ? host.isReducedMotion() : false;

  const { map } = normalizeProperties(properties, safeConfig);

  // Reduced motion: transform channels stop travelling; the landing state is kept.
  const finalProperties: PropertyMap = {};
  for (const [name, input] of Object.entries(map)) {
    const record = isRecord(input) ? (input as Record<string, unknown>) : null;
    if (!reduced || !record || record.from === undefined) {
      finalProperties[name] = input;
      continue;
    }
    const definition = getPropertyDefinition(name);
    if (definition && definition.channel === "transform") {
      finalProperties[name] = { from: record.to as Primitive, to: record.to as Primitive };
    } else {
      finalProperties[name] = input;
    }
  }

  const easing = resolveEasing(options.easing, safeConfig);
  const springInput: SpringInput | undefined = options.spring;

  // Duration precedence: explicit → spring settling time → house default.
  let duration = options.duration ?? easing.duration ?? safeConfig.defaultDuration ?? 350;

  // Cost classification for the performance layer.
  const cost: Record<string, ResolvedMotionSpec["cost"][string]> = {};
  for (const name of Object.keys(finalProperties)) cost[name] = classifyProperty(name);

  const usesSpring = springInput !== undefined || easing.spring;
  const spec: ResolvedMotionSpec = {
    target: targetLabel(target, elements),
    properties: finalProperties,
    delay: Math.max(0, options.delay ?? 0),
    duration: Math.max(1, Math.round(duration)),
    easing: usesSpring ? "waves-spring" : (specEasingValue(options.easing) as string | [number, number, number, number]),
    repeat: options.repeat ?? 0,
    yoyo: options.yoyo ?? false,
    reverse: options.reverse ?? false,
    from: options.from,
    label: options.label,
    params: options.params,
    origin: options.origin,
    cost,
    spring: usesSpring ? normalizeSpring(springInput === undefined ? undefined : springInput, safeConfig.spring) : undefined
  };

  // Springs define their own duration unless the author pinned one.
  if (springInput !== undefined && options.duration === undefined) {
    const tuned = createSpringEasing(normalizeSpring(springInput, safeConfig.spring));
    spec.duration = Math.max(1, Math.round(tuned.duration));
    duration = spec.duration;
  }

  if (reduced) {
    spec.duration = degradeDuration(spec.duration, true, true);
    duration = spec.duration;
  }

  const iterations = Math.max(0, options.repeat ?? 0) + 1;
  const totalDuration = spec.delay + spec.duration * iterations;
  const passDuration = spec.delay + spec.duration;

  return { spec, easing, duration: spec.duration, totalDuration, passDuration, reduced, targets: elements };
}

/** Convenience for tooling: resolve a plain `MotionSpec` into timing math. */
export function specTotalDuration(spec: MotionSpec & { duration: number; delay: number }): number {
  const iterations = Math.max(0, spec.repeat ?? 0) + 1;
  return spec.delay + spec.duration * iterations;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Normalise one authored property input into a `{ from, to, …offsets }` map. */
export function normalizeProperty(input: PropertyInput, config: WavesMotionConfig, name: string): PropertyInput {
  if (Array.isArray(input)) {
    if (input.length === 0) return { to: 0 };
    if (input.length === 1) return { to: input[0] };
    if (input.length === 2) return { from: input[0], to: input[1] };
    // Multi-keyframe: evenly spaced middle stops as numeric-keyed offsets.
    const normalized: Record<string, Primitive> = { from: input[0], to: input[input.length - 1] };
    for (let i = 1; i < input.length - 1; i++) {
      normalized[String(round2(i / (input.length - 1)))] = input[i];
    }
    return normalized;
  }

  if (isRecord(input)) {
    const record = input as Record<string, unknown>;
    if ("from" in record || "to" in record) {
      return record.from !== undefined
        ? { from: record.from as Primitive, to: record.to as Primitive }
        : { to: record.to as Primitive };
    }
    // Numeric-keyed offsets form: { 0: 40, 0.5: 20, 1: 0 }.
    const keys = Object.keys(record).filter((key) => NUMERIC_KEY.test(key));
    if (keys.length >= 2) {
      const ordered = keys.sort((a, b) => Number(a) - Number(b));
      const normalized: Record<string, Primitive> = {
        from: record[ordered[0]] as Primitive,
        to: record[ordered[ordered.length - 1]] as Primitive
      };
      for (const key of ordered.slice(1, -1)) normalized[key] = record[key] as Primitive;
      return normalized;
    }
  }

  // Bare primitive: implicit `to` — the from value comes from the writer base.
  if (typeof input === "number" || typeof input === "string") return { to: input };

  reportDiagnostic("MOTION_INVALID_VALUE", `Unusable value for "${name}".`, {
    property: name,
    value: String(input),
    hint: "Use a number, a [from, to] array, or { from, to }."
  });
  return { to: 0 };
}

/** Normalise a whole property map, dropping unknown properties with diagnostics. */
export function normalizeProperties(
  properties: PropertyMap | undefined,
  config: WavesMotionConfig
): { map: PropertyMap; unknown: string[] } {
  const map: PropertyMap = {};
  const unknown: string[] = [];
  for (const [name, input] of Object.entries(properties ?? {})) {
    if (!getPropertyDefinition(name)) {
      unknown.push(name);
      reportDiagnostic("MOTION_UNKNOWN_PROPERTY", `Unknown property "${name}" — skipped.`, {
        property: name,
        hint: "See the property catalog (waves.properties.list) for supported primitives; CSS custom properties (`--*`) are accepted."
      });
      continue;
    }
    map[name] = normalizeProperty(input, config, name);
  }
  return { map, unknown };
}
