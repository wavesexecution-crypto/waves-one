/**
 * Presets — the named, AI-callable vocabulary of Waves Motion.
 *
 * Every preset is a *pure spec factory*: it turns a target plus parameters into
 * a `MotionSpec` with zero DOM access, so the same call resolves identically in
 * the browser, in Node (CLI/SSG) and in tests. DOM application happens in one
 * funnel (`runPreset` → `resolveMotion` → `createAnimation`), which keeps
 * presets inspectable and the runtime single-pathed.
 *
 * Design rules encoded here (from the motion DNA):
 *  - entrances use `waves-entrance`, exits use `waves-exit`,
 *  - transforms travel at most one token distance, never "random big numbers",
 *  - `waves-spring` is reserved for interactive/settling motion,
 *  - all defaults come from `defaultMotionTokens`, never magic numbers.
 */

import type {
  AnimationHandle,
  EasingSpec,
  MotionOptions,
  MotionSpec,
  PresetDefinition,
  PresetName,
  PresetParamMeta,
  PropertyMap,
  StaggerOrigin,
  TargetInput
} from "../types";
import type { WavesMotionEngine } from "../core/engine";
import { defaultMotionTokens as tokens } from "../core/tokens";
import { fail } from "../core/errors";
import { resolveStaggerOrder } from "../sequences/order";
import { MotionNode } from "../timeline";
import { createAnimation, resolveSpec, type ResolvedAnimation } from "../animation";

/* -------------------------------------------------------------------------- */
/* Spec resolution — the one funnel from MotionSpec to runtime                */
/* -------------------------------------------------------------------------- */

/** Per-preset duration overrides (spring presets derive their own). */
const PRESET_DURATIONS: Partial<Record<string, number>> = {
  rise: tokens.duration.normal,
  drop: tokens.duration.normal,
  reveal: tokens.duration.normal,
  fade: tokens.duration.fast,
  "scale-in": tokens.duration.normal,
  "scale-out": tokens.duration.fast,
  "blur-reveal": tokens.duration.deliberate,
  snap: tokens.duration.instant,
  float: tokens.duration.cinematic,
  stack: tokens.duration.deliberate,
  cascade: tokens.duration.deliberate,
  stagger: tokens.duration.normal,
  magnetic: tokens.duration.fast,
  parallax: tokens.duration.cinematic,
  expand: tokens.duration.normal,
  collapse: tokens.duration.fast,
  "text-reveal": tokens.duration.deliberate,
  "line-reveal": tokens.duration.deliberate,
  counter: tokens.duration.normal,
  orbit: tokens.duration.cinematic,
  "perspective-in": tokens.duration.normal,
  "perspective-out": tokens.duration.fast,
  "path-draw": tokens.duration.deliberate,
  "orb-disperse": tokens.duration.fast,
  dissolve: tokens.duration.fast,
  "orb-converge": tokens.duration.normal,
  "node-connect": tokens.duration.normal,
  "card-assemble": tokens.duration.normal,
  "text-resolve": tokens.duration.deliberate,
  "workflow-build": tokens.duration.normal,
  "crm-populate": tokens.duration.fast,
  "notebook-write": tokens.duration.fast,
  "data-converge": tokens.duration.normal,
  "system-resolve": tokens.duration.deliberate
};

/** Per-preset house easings. */
const PRESET_EASINGS: Partial<Record<string, string>> = {
  rise: "waves-entrance",
  drop: "waves-entrance",
  reveal: "waves-entrance",
  fade: "waves-standard",
  "scale-in": "waves-entrance",
  "scale-out": "waves-exit",
  "blur-reveal": "waves-entrance",
  snap: "waves-snap",
  float: "waves-smooth",
  stack: "waves-entrance",
  cascade: "waves-entrance",
  stagger: "waves-entrance",
  magnetic: "waves-spring",
  parallax: "waves-smooth",
  expand: "waves-standard",
  collapse: "waves-exit",
  "text-reveal": "waves-entrance",
  "line-reveal": "waves-standard",
  counter: "waves-standard",
  orbit: "linear",
  "perspective-in": "waves-entrance",
  "perspective-out": "waves-exit",
  "path-draw": "waves-standard",
  "orb-disperse": "waves-exit",
  dissolve: "waves-exit",
  "orb-converge": "waves-entrance",
  "node-connect": "waves-entrance",
  "card-assemble": "waves-entrance",
  "text-resolve": "waves-entrance",
  "workflow-build": "waves-entrance",
  "crm-populate": "waves-entrance",
  "notebook-write": "waves-entrance",
  "data-converge": "waves-entrance",
  "system-resolve": "waves-entrance"
};

/** Per-preset house springs (used when no duration is authored). */
const PRESET_SPRINGS: Partial<Record<string, string>> = {
  magnetic: "snappy",
  snap: "snappy"
};

/**
 * Resolve a declarative `MotionSpec` against an engine into the runtime shape.
 * Preset `animation` entries expand here, so every consumer — timelines,
 * stagger, text, `waves.enter` — sees the exact same resolved spec.
 */
export function resolveMotion(spec: MotionSpec, engine: WavesMotionEngine): ResolvedAnimation {
  const presetName = spec.animation as string | undefined;
  const preset = presetName ? getPreset(presetName) : undefined;
  if (presetName && !preset) {
    fail("MOTION_UNKNOWN_PRESET", `Unknown preset "${presetName}".`, { preset: presetName });
  }

  // Presets expand into concrete properties; authored properties always win.
  let properties: PropertyMap = spec.properties ?? {};
  if (preset) {
    const built = preset.build(spec.target, spec.params);
    properties = { ...(built.properties ?? {}), ...(spec.properties ?? {}) };
  }

  const springInput =
    spec.spring ??
    (presetName && PRESET_SPRINGS[presetName]
      ? tokens.spring[PRESET_SPRINGS[presetName] as keyof typeof tokens.spring]
      : undefined);

  const easing = (spec.easing ?? (presetName ? PRESET_EASINGS[presetName] : undefined)) as EasingSpec | undefined;

  const resolved = resolveSpec(spec.target as TargetInput, properties, {
    duration: spec.duration ?? (presetName ? PRESET_DURATIONS[presetName] : undefined),
    delay: spec.delay,
    easing,
    spring: springInput,
    repeat: spec.repeat,
    yoyo: spec.yoyo,
    reverse: spec.reverse,
    from: spec.from,
    label: spec.label,
    origin: presetName ?? spec.origin,
    params: spec.params
  }, engine);

  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

function param(name: string, type: PresetParamMeta["type"], description: string, extra: Partial<PresetParamMeta> = {}): PresetParamMeta {
  return { name, type, description, ...extra };
}

const t = tokens;

/** The preset catalogue. Pure factories — no DOM, safe in Node/CLI. */
export const PRESETS: Record<string, PresetDefinition> = {
  rise: {
    name: "rise",
    summary: "Content rises into place from below.",
    intent: "The signature Waves entrance: short travel, decisive settle, never floaty.",
    channels: ["transform", "style"],
    tokens: ["distance.small", "duration.normal", "easing.entrance"],
    params: [param("distance", "number", "Travel distance in px.", { default: t.distance.small })],
    build: (target, params) => ({
      target,
      animation: "rise",
      properties: { y: [params?.distance ?? t.distance.small, 0], opacity: [0, 1] }
    })
  },
  drop: {
    name: "drop",
    summary: "Content drops into place from above.",
    intent: "Mirror of `rise` for overlays and banners arriving from the top edge.",
    channels: ["transform", "style"],
    tokens: ["distance.small", "duration.normal", "easing.entrance"],
    params: [param("distance", "number", "Travel distance in px.", { default: t.distance.small })],
    build: (target, params) => ({
      target,
      animation: "drop",
      properties: { y: [-(params?.distance ?? t.distance.small), 0], opacity: [0, 1] }
    })
  },
  reveal: {
    name: "reveal",
    summary: "Unveils clipped content with a slide.",
    intent: "For cards and media with `overflow: hidden` wrappers; the clip, not the element, moves.",
    channels: ["transform"],
    tokens: ["distance.medium", "duration.normal", "easing.entrance"],
    params: [param("distance", "number", "Clip travel in px.", { default: t.distance.medium })],
    build: (target, params) => ({
      target,
      animation: "reveal",
      properties: { y: [params?.distance ?? t.distance.medium, 0] }
    })
  },
  fade: {
    name: "fade",
    summary: "Simple opacity fade.",
    intent: "The most restrained transition; used when motion must not add meaning.",
    channels: ["style"],
    tokens: ["duration.fast"],
    params: [],
    build: (target) => ({ target, animation: "fade", properties: { opacity: [0, 1] } })
  },
  "scale-in": {
    name: "scale-in",
    summary: "Scales content in from slightly smaller.",
    intent: "Arrival without travel — used for chips, badges, inline confirmations.",
    channels: ["transform", "style"],
    tokens: ["scale.enter", "duration.normal", "easing.entrance"],
    params: [param("from", "number", "Start scale.", { default: t.scale.enter })],
    build: (target, params) => ({
      target,
      animation: "scale-in",
      properties: { scale: [params?.from ?? t.scale.enter, 1], opacity: [0, 1] }
    })
  },
  "scale-out": {
    name: "scale-out",
    summary: "Scales content out to slightly smaller.",
    intent: "Exit that removes the element without shrinking the layout.",
    channels: ["transform", "style"],
    tokens: ["scale.exit", "duration.fast", "easing.exit"],
    params: [param("to", "number", "End scale.", { default: t.scale.exit })],
    build: (target, params) => ({
      target,
      animation: "scale-out",
      properties: { scale: [1, params?.to ?? t.scale.exit], opacity: [1, 0] }
    })
  },
  "blur-reveal": {
    name: "blur-reveal",
    summary: "Resolves from a blur into focus.",
    intent: "Premium reveal for hero media; blur collapses while opacity rises.",
    channels: ["filter", "style"],
    tokens: ["blur.soft", "duration.deliberate", "easing.entrance"],
    params: [param("blur", "number", "Start blur in px.", { default: t.blur.soft })],
    build: (target, params) => ({
      target,
      animation: "blur-reveal",
      properties: { blur: [params?.blur ?? t.blur.soft, 0], opacity: [0, 1], scale: [1.02, 1] }
    })
  },
  snap: {
    name: "snap",
    summary: "Hard, immediate UI settle.",
    intent: "State feedback for chrome: toggles, tabs, pressed states. Shortest house duration.",
    channels: ["transform"],
    tokens: ["scale.press", "duration.instant", "easing.snap"],
    params: [param("scaleTo", "number", "Press scale.", { default: t.scale.press })],
    build: (target, params) => ({
      target,
      animation: "snap",
      duration: t.duration.instant,
      easing: "waves-snap",
      spring: tokens.spring.snappy,
      properties: { scale: [1, params?.scaleTo ?? t.scale.press] }
    })
  },
  float: {
    name: "float",
    summary: "Continuous gentle hover loop.",
    intent: "Ambient life for idle surfaces; must loop seamlessly with `yoyo`.",
    channels: ["transform"],
    tokens: ["distance.micro", "duration.cinematic", "easing.smooth"],
    params: [param("distance", "number", "Hover amplitude in px.", { default: t.distance.micro })],
    build: (target, params) => ({
      target,
      animation: "float",
      repeat: 12,
      yoyo: true,
      easing: "waves-smooth",
      duration: t.duration.cinematic,
      properties: { y: [0, params?.distance ?? t.distance.micro] }
    })
  },
  stack: {
    name: "stack",
    summary: "Cards stack with depth.",
    intent: "The product card sequence: each layer lands with a depth settle behind the previous.",
    channels: ["transform", "style"],
    tokens: ["scale.depth", "duration.deliberate", "easing.entrance", "stagger.standard"],
    params: [
      param("depth", "number", "Scale per layer.", { default: t.scale.depth }),
      param("lift", "number", "Vertical offset per layer in px.", { default: t.distance.small })
    ],
    build: (target, params) => ({
      target,
      animation: "stack",
      properties: { scale: [params?.depth ?? t.scale.depth, 1], y: [params?.lift ?? t.distance.small, 0], opacity: [0, 1] }
    })
  },
  cascade: {
    name: "cascade",
    summary: "A list or grid of items cascades in.",
    intent: "The canonical staggered entrance — pure DOM order by default, direction-aware via `from`.",
    channels: ["transform", "style"],
    tokens: ["stagger.standard", "duration.deliberate", "easing.entrance"],
    params: [
      param("stagger", "number", "Delay between items in ms.", { default: t.stagger.standard }),
      param("from", "string", "Ordering origin (first | last | center | edges | random | custom).")
    ],
    build: (target, params) => ({
      target,
      animation: "cascade",
      properties: { y: [t.distance.small, 0], opacity: [0, 1] }
    })
  },
  magnetic: {
    name: "magnetic",
    summary: "Element leans toward the cursor and settles back.",
    intent: "Interactive attraction; driven by the gesture subsystem, springs carry the interruption velocity.",
    channels: ["transform"],
    tokens: ["distance.small", "spring.snappy"],
    params: [
      param("strength", "number", "Pull strength 0-1.", { default: 0.5 }),
      param("max", "number", "Maximum pull in px.", { default: t.distance.micro })
    ],
    build: (target, params) => ({
      target,
      animation: "magnetic",
      duration: tokens.duration.fast,
      easing: "waves-spring",
      spring: tokens.spring.snappy,
      properties: { x: 0, y: 0 }
    })
  },
  parallax: {
    name: "parallax",
    summary: "Depth layers translate with scroll.",
    intent: "Scrubbed depth — position derived from scroll progress, never time-based on its own.",
    channels: ["transform"],
    tokens: ["distance.medium", "easing.smooth"],
    params: [
      param("strength", "number", "Scroll coupling strength.", { default: 0.5 }),
      param("axis", "string", "Scroll axis (y | x).", { default: "y" })
    ],
    build: (target, params) => ({
      target,
      animation: "parallax",
      easing: "linear",
      properties: { y: [0, -Math.round(t.distance.medium * (params?.strength ?? 0.5))] }
    })
  },
  /* ---------------------------------------------------------------------- */
  /* Orb-morph vocabulary — the WAVES identity transitions. Mount-level     */
  /* enters/exits composed by the Motion Lab planners into continuous       */
  /* orb → interface → orb sequences. Same tokens, same house easings.      */
  /* ---------------------------------------------------------------------- */
  "orb-disperse": {
    name: "orb-disperse",
    summary: "The orb blooms outward and dissolves as an interface is born.",
    intent: "Orb exit: scale bloom plus fade. The dots scatter so data mounts can form from them.",
    channels: ["transform", "style"],
    tokens: ["scale.exit", "duration.fast", "easing.exit"],
    params: [],
    build: (target) => ({
      target,
      animation: "orb-disperse",
      properties: { scale: [1, 1.1], opacity: [1, 0] }
    })
  },
  dissolve: {
    name: "dissolve",
    summary: "Content dissolves in place without travel or scale.",
    intent: "The quietest exit: opacity-led removal for typography and reading surfaces.",
    channels: ["style"],
    tokens: ["duration.fast", "easing.exit"],
    params: [],
    build: (target) => ({
      target,
      animation: "dissolve",
      properties: { opacity: [1, 0] }
    })
  },
  "orb-converge": {
    name: "orb-converge",
    summary: "Scattered elements gather into the orb identity.",
    intent: "Orb entrance and finale: settle from slightly dispersed into the intelligence point.",
    channels: ["transform", "style"],
    tokens: ["scale.enter", "duration.normal", "easing.entrance"],
    params: [],
    build: (target) => ({
      target,
      animation: "orb-converge",
      properties: { scale: [1.12, 1], opacity: [0, 1] }
    })
  },
  "node-connect": {
    name: "node-connect",
    summary: "Network nodes rise and link, center-first.",
    intent: "Discovery visuals: short travel with cascade binding from the orb center.",
    channels: ["transform", "style"],
    tokens: ["distance.small", "duration.normal", "easing.entrance"],
    params: [
      param("distance", "number", "Travel distance in px.", { default: t.distance.small })
    ],
    build: (target, params) => ({
      target,
      animation: "node-connect",
      properties: { y: [params?.distance ?? t.distance.small, 0], opacity: [0, 1] }
    })
  },
  "card-assemble": {
    name: "card-assemble",
    summary: "Cards assemble with depth settle.",
    intent: "CRM and data surfaces: rise plus restrained scale landing, never flat fades.",
    channels: ["transform", "style"],
    tokens: ["distance.small", "scale.enter", "duration.normal", "easing.entrance"],
    params: [],
    build: (target) => ({
      target,
      animation: "card-assemble",
      properties: { y: [t.distance.small, 0], scale: [t.scale.enter, 1], opacity: [0, 1] }
    })
  },
  "text-resolve": {
    name: "text-resolve",
    summary: "Typography resolves from blur into focus.",
    intent: "Headline moments: blur collapse plus opacity, no travel, no bounce.",
    channels: ["filter", "style"],
    tokens: ["blur.soft", "duration.deliberate", "easing.entrance"],
    params: [
      param("blur", "number", "Start blur in px.", { default: t.blur.soft })
    ],
    build: (target, params) => ({
      target,
      animation: "text-resolve",
      properties: { blur: [params?.blur ?? t.blur.soft, 0], opacity: [0, 1] }
    })
  },
  "workflow-build": {
    name: "workflow-build",
    summary: "Workflow chain links assemble downward.",
    intent: "Process visuals: decisive short-travel entrance per chain node.",
    channels: ["transform", "style"],
    tokens: ["distance.small", "duration.normal", "easing.entrance"],
    params: [],
    build: (target) => ({
      target,
      animation: "workflow-build",
      properties: { y: [t.distance.small, 0], opacity: [0, 1] }
    })
  },
  "crm-populate": {
    name: "crm-populate",
    summary: "CRM rows populate with minimal travel.",
    intent: "Table surfaces: rows land fast and quiet so data, not motion, carries the beat.",
    channels: ["transform", "style"],
    tokens: ["distance.micro", "duration.fast", "easing.entrance"],
    params: [],
    build: (target) => ({
      target,
      animation: "crm-populate",
      properties: { y: [t.distance.micro, 0], opacity: [0, 1] }
    })
  },
  "notebook-write": {
    name: "notebook-write",
    summary: "Research lines appear with restraint.",
    intent: "Context surfaces: opacity-led entrance, almost no travel — reading, not motion.",
    channels: ["style"],
    tokens: ["duration.fast", "easing.entrance"],
    params: [],
    build: (target) => ({
      target,
      animation: "notebook-write",
      properties: { opacity: [0, 1] }
    })
  },
  "data-converge": {
    name: "data-converge",
    summary: "Data surfaces converge from slightly wide.",
    intent: "Milestones and reports: settle inward from dispersed to resolved.",
    channels: ["transform", "style"],
    tokens: ["scale.enter", "duration.normal", "easing.entrance"],
    params: [],
    build: (target) => ({
      target,
      animation: "data-converge",
      properties: { scale: [t.scale.enter, 1], opacity: [0, 1] }
    })
  },
  "system-resolve": {
    name: "system-resolve",
    summary: "The resolved system locks into place.",
    intent: "Finale state: near-still settle into the WAVES system. Confidence, not celebration.",
    channels: ["transform", "style"],
    tokens: ["scale.enter", "duration.deliberate", "easing.entrance"],
    params: [],
    build: (target) => ({
      target,
      animation: "system-resolve",
      properties: { scale: [0.98, 1], opacity: [0, 1] }
    })
  }
};

/* -------------------------------------------------------------------------- */
/* Stagger binding configuration                                              */
/* -------------------------------------------------------------------------- */

/**
 * Turn authored `StaggerOptions` into per-element delays in *target order*.
 *
 * This is the "stagger binding" half of the subsystem: `sequences/order.ts`
 * resolves the deterministic play order, this maps that order back onto the
 * element list the animation was given, so `elementDelays[i]` is the delay for
 * `targets[i]`. `staggerStandard()` is the only helper most call sites need.
 */
export interface ConfigureStaggerOptions {
  /** Milliseconds between consecutive targets. */
  delay?: number;
  /** Ordering strategy. */
  from?: StaggerOrigin;
  /** Custom ranking for `from: "custom"`. */
  order?: (index: number, total: number) => number;
  /** Seeded randomness for `from: "random"`. */
  seed?: number;
  /** Invert the resolved ordering. */
  reverse?: boolean;
  /** Cap the total spread, compressing the per-rank delay to fit. */
  maxSpread?: number;
}

/**
 * Turn authored stagger options into per-element delays, aligned to the
 * *target list order* (not the play order). This is the stagger-binding half
 * of the subsystem: `sequences/order.ts` resolves the deterministic play
 * order, this maps it back onto `elementDelays[i]` for `createAnimation`.
 */
export function configureStagger(count: number, stagger: ConfigureStaggerOptions = {}): number[] {
  const perRank = Math.max(0, stagger.delay ?? t.stagger.standard);
  const order = resolveStaggerOrder(count, {
    origin: stagger.from,
    order: stagger.order,
    seed: stagger.seed ?? 42,
    reverse: stagger.reverse
  });
  const delays = new Array<number>(count).fill(0);
  for (let rank = 0; rank < count; rank++) {
    delays[order[rank]] = rank * perRank;
  }
  if (stagger.maxSpread !== undefined && count > 1) {
    const spread = (count - 1) * perRank;
    if (spread > stagger.maxSpread) {
      const scaled = Math.max(0, stagger.maxSpread / (count - 1));
      for (let index = 0; index < count; index++) delays[index] = index * scaled;
    }
  }
  return delays;
}

/** The house stagger: Waves standard spacing, first origin, DOM order. */
export function staggerStandard(count: number, delay = t.stagger.standard): number[] {
  return configureStagger(count, { delay, from: "first" });
}

/* -------------------------------------------------------------------------- */
/* Execution API                                                              */
/* -------------------------------------------------------------------------- */

/** Catalogue lookup. Unknown names throw `MOTION_UNKNOWN_PRESET`. */
export function getPreset(name: PresetName): PresetDefinition {
  const preset = PRESETS[name as string];
  if (!preset) fail("MOTION_UNKNOWN_PRESET", `Unknown preset "${String(name)}".`, { preset: String(name) });
  return preset;
}

/** Machine- and AI-readable catalogue for the CLI, docs and schema. */
export function listPresets(): PresetDefinition[] {
  return Object.values(PRESETS);
}

/** One-line description used by `waves-motion presets <name>`. */
export function describePreset(name: PresetName): string {
  const preset = getPreset(name);
  const channelList = preset.channels.join(", ");
  const tokenList = preset.tokens.join(", ");
  return `${preset.name} — ${preset.summary} [channels: ${channelList}] [tokens: ${tokenList}]`;
}

/**
 * Play a preset. Applies stagger binding when `options.stagger` is set, so a
 * single call fans out over the whole target list in deterministic order.
 */
export function runPreset(
  name: PresetName,
  target: TargetInput,
  params: Record<string, any> = {},
  engine: WavesMotionEngine,
  options: MotionOptions = {}
): AnimationHandle {
  const preset = getPreset(name);
  const built = preset.build(target as string, { ...params });
  const resolved = resolveMotion({ ...built, label: options.label ?? built.label }, engine);
  const elementDelays = options.stagger
    ? configureStagger(resolved.targets.length, { delay: options.stagger, from: options.staggerFrom })
    : undefined;
  const animation = createAnimation(resolved, engine, elementDelays ? { elementDelays } : undefined);
  engine.registry.register(animation);
  return animation.play();
}

/**
 * Build a `MotionNode` for a preset without playing it — the compositional
 * path used inside timelines, so presets, stagger and timelines compose.
 */
export function runPresetSpec(
  name: PresetName,
  target: TargetInput,
  params: Record<string, any> = {},
  options: MotionOptions = {}
): MotionNode {
  const preset = getPreset(name);
  const built = preset.build(target as string, { ...params });
  return new MotionNode({ spec: { ...built, label: options.label ?? built.label }, stagger: options.stagger });
}

/** Internal: play an already-built spec with stagger binding applied. */
export function runPresetOnTargets(
  built: MotionSpec,
  engine: WavesMotionEngine,
  options: MotionOptions = {}
): AnimationHandle {
  const resolved = resolveMotion(built, engine);
  const elementDelays = options.stagger
    ? configureStagger(resolved.targets.length, { delay: options.stagger, from: options.staggerFrom })
    : undefined;
  const animation = createAnimation(resolved, engine, elementDelays ? { elementDelays } : undefined);
  engine.registry.register(animation);
  return animation.play();
}

