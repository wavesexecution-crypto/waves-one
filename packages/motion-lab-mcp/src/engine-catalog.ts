/**
 * Engine catalogue access — always live, never duplicated.
 *
 * Every preset name, easing, token and property fact the MCP server
 * reports comes from the real @waves/motion build. If the engine
 * changes, the MCP surface follows automatically.
 */

import {
  MOTION_VERSION,
  classifyProperty,
  defaultMotionTokens,
  describeSpring,
  getPreset,
  getPropertyDefinition,
  listEasings,
  listPresets,
  resolveEasing,
  resolveStaggerOrder
} from "@waves/motion";

export interface FeelMapping {
  feel: string;
  spring: { stiffness: number; damping: number; mass: number };
  easing: string;
  note: string;
}

/**
 * Intent-level feel words → house physics. Anything unrecognized falls
 * back to the house default instead of failing the request.
 */
export function mapFeel(feel: string | undefined): FeelMapping {
  const tokens = defaultMotionTokens;
  const normalized = (feel ?? "").trim().toLowerCase();
  if (normalized.includes("snappy") || normalized.includes("sharp") || normalized.includes("immediate")) {
    return {
      feel: feel ?? "snappy",
      spring: { ...tokens.spring.snappy },
      easing: "waves-spring",
      note: "Snappy house spring — fastest settle for interactive feedback."
    };
  }
  if (
    normalized.includes("smooth") ||
    normalized.includes("soft") ||
    normalized.includes("calm") ||
    normalized.includes("gentle")
  ) {
    return {
      feel: feel ?? "smooth",
      spring: { ...tokens.spring.deliberate },
      easing: "waves-spring",
      note: "Deliberate house spring — slower, heavier, layout-grade motion."
    };
  }
  if (normalized.includes("signature") || normalized.includes("bounce") || normalized.includes("playful")) {
    return {
      feel: feel ?? "signature",
      spring: { ...tokens.spring.signature },
      easing: "waves-spring",
      note: "Signature spring — one barely perceptible settle. Use sparingly."
    };
  }
  return {
    feel: feel ?? "subtle spring",
    spring: { ...tokens.spring.waves },
    easing: "waves-spring",
    note: "House default — essentially critically damped, no visible bounce."
  };
}

export interface BehaviorMapping {
  behavior: string;
  preset: string | null;
  properties: Record<string, unknown>;
  note: string;
  /** Default stagger when the caller gives none (orb-origin: center-first). */
  stagger?: number;
  /** Default stagger ordering when the caller gives none. */
  staggerFrom?: string;
}

/**
 * Intent-level behaviors → preset or raw properties. Unknown behaviors
 * degrade to a restrained rise instead of failing.
 */
export function mapBehavior(behavior: string | undefined): BehaviorMapping {
  const normalized = (behavior ?? "").trim().toLowerCase();
  const presets = listPresets().map((preset) => preset.name);
  if (normalized && presets.includes(normalized)) {
    return {
      behavior: behavior ?? "",
      preset: normalized,
      properties: {},
      note: `Direct preset "${normalized}" from the engine catalogue.`
    };
  }
  // Orb-origin transitions — the transformation-system vocabulary. UI states
  // emerge from, and dissolve back into, the intelligence point (center-first).
  if (normalized.includes("emerge from orb") || normalized.includes("orb emerge") || normalized.includes("rise from center") || normalized.includes("from the orb") || normalized.includes("from center") || normalized === "emerge") {
    return {
      behavior: behavior ?? "emerge from orb",
      preset: null,
      properties: { y: [28, 0], opacity: [0, 1] },
      staggerFrom: "center",
      note: "Orb-origin emergence — interface rises from the intelligence point, center-first."
    };
  }
  if (normalized.includes("dissolve to orb") || normalized.includes("return to orb") || normalized.includes("collapse to orb") || normalized.includes("back to orb") || normalized.includes("to the orb")) {
    return {
      behavior: behavior ?? "dissolve to orb",
      preset: null,
      properties: { y: [0, 20], opacity: [1, 0] },
      staggerFrom: "center",
      note: "Return to orb — interface settles back into the control plane, center-first."
    };
  }
  if (normalized.includes("disperse") || normalized.includes("scatter from center") || normalized.includes("orb dispersal")) {
    return {
      behavior: behavior ?? "orb disperse",
      preset: null,
      properties: { scale: [1, 0], opacity: [1, 0] },
      staggerFrom: "center",
      note: "Orb dispersal — particles condense as the next UI is born, center-first."
    };
  }
  if (normalized.includes("pulse") || normalized.includes("heartbeat")) {
    return {
      behavior: behavior ?? "orb pulse",
      preset: null,
      properties: { scale: [1, 1.07, 1] },
      note: "Orb pulse — a single heartbeat. Never looping."
    };
  }
  if (normalized.includes("sequential") || normalized.includes("one after another") || normalized.includes("cascade") || normalized.includes("stagger")) {
    return {
      behavior: behavior ?? "sequential entrance",
      preset: "rise",
      properties: {},
      note: "Sequential entrance via the rise preset with stagger binding."
    };
  }
  if (normalized.includes("fade")) {
    return { behavior: behavior ?? "fade", preset: "fade", properties: {}, note: "Restrained opacity fade." };
  }
  if (normalized.includes("scale") || normalized.includes("pop")) {
    return { behavior: behavior ?? "scale-in", preset: "scale-in", properties: {}, note: "Arrival without travel." };
  }
  if (normalized.includes("float") || normalized.includes("hover") || normalized.includes("ambient") || normalized.includes("idle")) {
    return { behavior: behavior ?? "float", preset: "float", properties: {}, note: "Ambient loop — must yoyo to loop seamlessly." };
  }
  if (normalized.includes("exit") || normalized.includes("leave") || normalized.includes("dismiss")) {
    return { behavior: behavior ?? "scale-out", preset: "scale-out", properties: {}, note: "Exit that never lingers." };
  }
  return {
    behavior: behavior ?? "entrance",
    preset: "rise",
    properties: {},
    note: "Defaulted to the signature rise — short travel, decisive settle."
  };
}

export function presetExists(name: string): boolean {
  return listPresets().some((preset) => preset.name === name);
}

/**
 * Expand a preset into raw properties for animate ops that must carry
 * physics (e.g. an explicit spring) the runPreset path cannot express.
 * Returns null when the preset is unknown.
 */
export function buildPresetProperties(
  preset: string,
  target: string,
  params: Record<string, unknown> = {}
): Record<string, unknown> | null {
  try {
    const built = getPreset(preset).build(target, params);
    return { ...(built.properties ?? {}) };
  } catch {
    return null;
  }
}

export function staggerOriginValid(origin: string): boolean {
  try {
    resolveStaggerOrder(1, { origin: origin as never });
    return true;
  } catch {
    return false;
  }
}

export function easingExists(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  try {
    resolveEasing(name as never);
    return true;
  } catch {
    return false;
  }
}

export function propertyKnown(name: string): boolean {
  try {
    // The engine returns null (not undefined) for unknown properties.
    return getPropertyDefinition(name) != null;
  } catch {
    return false;
  }
}

export function propertyCost(name: string): string {
  try {
    return String(classifyProperty(name));
  } catch {
    return "unknown";
  }
}

export function springVerdict(config: { stiffness?: number; damping?: number; mass?: number }): {
  description: string;
  verdict: string;
  duration: number;
} {
  const report = describeSpring(config);
  return { description: report.description, verdict: report.verdict, duration: report.duration };
}

export function catalogueSnapshot(): {
  version: string;
  presets: Array<{ name: string; summary: string }>;
  easings: string[];
  springs: Record<string, { stiffness: number; damping: number; mass: number }>;
  durations: Record<string, number>;
  distances: Record<string, number>;
  staggers: Record<string, number>;
} {
  const tokens = defaultMotionTokens;
  return {
    version: MOTION_VERSION,
    presets: listPresets().map((preset) => ({ name: preset.name, summary: preset.summary })),
    easings: listEasings().map((entry) => entry.name),
    springs: {
      waves: { ...tokens.spring.waves },
      snappy: { ...tokens.spring.snappy },
      deliberate: { ...tokens.spring.deliberate },
      signature: { ...tokens.spring.signature }
    },
    durations: { ...tokens.duration },
    distances: { ...tokens.distance },
    staggers: { ...tokens.stagger }
  };
}
