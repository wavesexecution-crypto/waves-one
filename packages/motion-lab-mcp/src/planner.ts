/**
 * Motion planner — story beats into canonical animation operations.
 *
 * Consumes StoryBeat[] (story engine output) and emits MotionOp[] the
 * engine executes unchanged: one mount op per visual group (multi-keyframe
 * enter-hold-exit spans from beat times), cascades left for conversational
 * follow-ups. Obeys the house rules by construction:
 * - single writer per property (audited before return),
 * - single-op multi-keyframe spans,
 * - catalogue-valid properties/easings, deterministic timing.
 * Validation happens here AND again at publish time; the planner never
 * publishes by itself.
 */

import type { MotionOp } from "./ops.js";
import { validateAll, type ValidationReport } from "./validate.js";
import type { StoryBeat } from "./story.js";
import { buildPresetProperties } from "./engine-catalog.js";

export interface PlannedResult {
  ops: MotionOp[];
  overlaps: Array<{ key: string; first: string; second: string }>;
  validation: ValidationReport;
}

export interface Overlap {
  key: string;
  first: string;
  second: string;
}

function spanOf(op: MotionOp): { start: number; end: number } | null {
  if (op.kind === "animate") {
    const options = op.options ?? {};
    const duration = typeof options.duration === "number" ? options.duration : 350;
    const delay = typeof options.delay === "number" ? options.delay : 0;
    const stagger = typeof options.stagger === "number" ? options.stagger : 0;
    return { start: delay, end: delay + duration + stagger * 4 };
  }
  if (op.kind === "text") {
    const delay = typeof op.delay === "number" ? op.delay : 0;
    const duration = typeof op.duration === "number" ? op.duration : 350;
    const stagger = typeof op.stagger === "number" ? op.stagger : 40;
    return { start: delay, end: delay + duration + stagger * 4 };
  }
  return null;
}

function targetsOf(op: MotionOp): string[] {
  if (op.kind === "animate" || op.kind === "preset" || op.kind === "scroll" || op.kind === "text") return [op.target];
  if (op.kind === "timeline") return op.nodes.map((node) => node.target);
  return [];
}

function propertiesOf(op: MotionOp): string[] {
  if (op.kind === "animate") return Object.keys(op.properties ?? {});
  if (op.kind === "scroll") return Object.keys(op.properties ?? {});
  if (op.kind === "text") return ["y", "opacity"];
  return [];
}

/**
 * The resolved timeline span of one op (null for structural ops like scene).
 * Exported so the render service derives durations from the same math.
 */
export function opSpan(op: MotionOp): { start: number; end: number } | null {
  return spanOf(op);
}

/**
 * The single-writer audit: same target + same property with overlapping
 * windows is a publish-blocking defect (delay-period repaint fights).
 */
export function auditSingleWriter(ops: MotionOp[]): Overlap[] {
  const windows = new Map<string, Array<{ op: string; start: number; end: number }>>();
  for (const op of ops) {
    const span = spanOf(op);
    if (!span) continue;
    for (const target of targetsOf(op)) {
      for (const name of propertiesOf(op)) {
        const key = `${target} :: ${name}`;
        const list = windows.get(key) ?? [];
        list.push({ op: op.id, ...span });
        windows.set(key, list);
      }
    }
  }
  const overlaps: Overlap[] = [];
  for (const [key, list] of windows) {
    const sorted = list.slice().sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index].start < sorted[index - 1].end) {
        overlaps.push({ key, first: sorted[index - 1].op, second: sorted[index].op });
      }
    }
  }
  return overlaps;
}

const VISUAL_KIND: Record<string, string> = {
  orb: "orb",
  title: "title",
  crm: "crm",
  network: "network",
  notebook: "notebook",
  workflow: "workflow",
  milestones: "milestones"
};

/**
 * Mount visual → engine primitive pair. Enters come straight from the
 * catalogue (zero duplication: the same spec factories the runtime
 * executes); exits dissolve so the next mount can form through them.
 */
export const PRIMITIVE_FOR_KIND: Record<string, { enter: string; exit: string }> = {
  orb: { enter: "orb-converge", exit: "orb-disperse" },
  crm: { enter: "crm-populate", exit: "scale-out" },
  network: { enter: "node-connect", exit: "scale-out" },
  notebook: { enter: "notebook-write", exit: "dissolve" },
  workflow: { enter: "workflow-build", exit: "scale-out" },
  milestones: { enter: "data-converge", exit: "scale-out" },
  title: { enter: "text-resolve", exit: "dissolve" }
};

function numStop(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface MorphSpan {
  /** Full op window: own span plus the crossfade overlap into the next mount. */
  duration: number;
  /** Normalized enter completion (intensity-paced: stronger beats land faster). */
  enter: number;
  /** Normalized exit start (timed so the exit dissolves through the next enter). */
  exitStart: number;
}

/**
 * Timing math shared by both planners. The overlap reaches into the next
 * mount's window; the exit starts just before the handoff so consecutive
 * mounts crossfade instead of hard-cutting. All fractions clamped.
 */
export function enterMsFor(spanMs: number, intensity: number): number {
  const clamped = Math.max(0, Math.min(1, intensity));
  return Math.max(200, Math.min(700, Math.round(spanMs * (0.35 - 0.2 * clamped))));
}

export function morphSpan(spanMs: number, overlapMs: number, intensity: number, nextEnterMs = 0): MorphSpan {
  const span = Math.max(800, Math.round(spanMs));
  const overlap = Math.max(0, Math.min(Math.round(overlapMs), Math.floor(span * 0.4)));
  const duration = span + overlap;
  const enterMs = enterMsFor(span, intensity);
  const enter = Math.max(0.05, Math.min(0.6, Math.round((enterMs / duration) * 100) / 100));
  // The exit starts just as the next mount lands (not when this span ends),
  // so consecutive mounts crossfade through each other instead of dipping
  // to black between them. Final mounts still resolve at the film end.
  const exitStartAbs = nextEnterMs > 0 ? span + Math.max(0, nextEnterMs) * 0.4 : span;
  const exitStart = Math.max(enter + 0.05, Math.min(0.95, Math.round((exitStartAbs / duration) * 100) / 100));
  return { duration, enter, exitStart };
}

/**
 * One mount op's properties from engine primitives: enter [from → to],
 * hold, then exit [to → gone]. Cross-mount overlaps are legal (different
 * targets); same-target repeats must never extend (callers guarantee it).
 * An explicit enter override (authorial behavior mapping) replaces the
 * primitive enter while the primitive exit still dissolves through it.
 */
export function morphProperties(
  kind: string,
  target: string,
  span: MorphSpan,
  enterOverride?: Record<string, unknown> | null
): Record<string, Record<number, number>> {
  const primitive = PRIMITIVE_FOR_KIND[kind];
  const enterRaw =
    enterOverride && Object.keys(enterOverride).length > 0
      ? enterOverride
      : (primitive ? buildPresetProperties(primitive.enter, target, {}) : null) ?? { y: [24, 0], opacity: [0, 1] };
  const exitRaw = (primitive ? buildPresetProperties(primitive.exit, target, {}) : null) ?? { opacity: [1, 0] };
  const out: Record<string, Record<number, number>> = {};
  for (const key of new Set([...Object.keys(enterRaw), ...Object.keys(exitRaw)])) {
    const enterPair = Array.isArray((enterRaw as Record<string, unknown>)[key]) ? ((enterRaw as Record<string, unknown>)[key] as unknown[]) : [];
    const exitPair = Array.isArray((exitRaw as Record<string, unknown>)[key]) ? ((exitRaw as Record<string, unknown>)[key] as unknown[]) : [];
    const start = numStop(enterPair[0]) ?? numStop(exitPair[0]) ?? 0;
    const mid = numStop(enterPair[1]) ?? numStop(exitPair[0]) ?? start;
    const end = numStop(exitPair[1]) ?? mid;
    out[key] = { 0: start, [span.enter]: mid, [span.exitStart]: mid, 1: end };
  }
  return out;
}

/** Procedural scene data from narration entities (fallback-free builders use house defaults). */const GENERIC_ENTITIES = new Set(["WAVES", "CRM", "NOTEBOOK", "WORKFLOW", "REPORT", "MOTION", "ORB", "SYSTEM"]);

function contentEntities(entities: string[]): string[] {
  return entities.filter((entity) => entity.length >= 2 && !GENERIC_ENTITIES.has(entity.toUpperCase())).slice(0, 6);
}

const CRM_STATUSES = ["NEW", "REPLIED", "FOLLOW-UP"];
const CRM_TOUCH = ["2d", "1d", "3h"];
const CRM_FALLBACK = ["Acme Corp", "Globex", "Initech"];
const CRM_CONTACTS = ["J. Doe", "A. Smith", "B. Jones"];

export function crmRowsFor(entities: string[]): string[][] {
  const names = contentEntities(entities);
  return [0, 1, 2].map((index) => [
    names[index] ?? CRM_FALLBACK[index],
    CRM_CONTACTS[index],
    CRM_STATUSES[index % CRM_STATUSES.length],
    CRM_TOUCH[index % CRM_TOUCH.length]
  ]);
}

export function workflowItemsFor(entities: string[]): string[] | null {
  const items = contentEntities(entities)
    .map((entity) => entity.toUpperCase())
    .slice(0, 6);
  return items.length >= 2 ? items : null;
}

export function notebookSignalFor(entities: string[]): string | null {
  return contentEntities(entities).find((entity) => entity.length >= 3) ?? null;
}

/** Mount visuals whose children enter as a staggered cascade (not orb/title/cards). */
const CASCADE_KINDS = new Set(["crm", "network", "notebook", "workflow", "milestones", "flow", "pipeline", "stages"]);

/**
 * A cascade op for a mount's hidden children (`.lab-reveal`): rows, lines,
 * nodes, and dots resolve in stagger order after the mount lands, using the
 * kind's enter primitive. One op per mount; mount and children are distinct
 * audit targets, so the cascade never collides with its mount op.
 */
export function cascadeFor(kind: string, mountTarget: string, delayMs: number, id: string): MotionOp | null {
  if (!CASCADE_KINDS.has(kind)) return null;
  const primitive = PRIMITIVE_FOR_KIND[kind];
  const properties =
    (primitive ? buildPresetProperties(primitive.enter, mountTarget, {}) : null) ?? { y: [16, 0], opacity: [0, 1] };
  return {
    id,
    kind: "animate",
    target: `${mountTarget} .lab-reveal`,
    properties: properties as never,
    options: {
      delay: Math.max(0, Math.round(delayMs)),
      duration: 600,
      easing: "waves-entrance",
      stagger: kind === "network" ? 12 : 80,
      staggerFrom: kind === "network" ? "center" : "first"
    }
  };
}

let planCounter = 0;
function planId(prefix: string): string {
  planCounter += 1;
  return `${prefix}-plan-${Date.now().toString(36)}-${planCounter}`;
}

/**
 * Plan a story into ops. Consecutive beats sharing a visual merge into one
 * mount span, so the single-writer invariant holds by construction.
 */
export function planStory(beats: StoryBeat[], orientation: string): PlannedResult {
  const vertical = orientation === "vertical";
  const sceneElements: Array<Record<string, unknown>> = [];
  const groups: Array<{ visual: string; key: string; startMs: number; endMs: number; title: string; intensity: number; entities: string[] }> = [];
  for (const beat of beats) {
    const visual = VISUAL_KIND[beat.visualIntent] ? beat.visualIntent : "title";
    const last = groups[groups.length - 1];
    if (last && last.visual === visual) {
      last.endMs = Math.max(last.endMs, beat.endMs);
      last.intensity = Math.max(last.intensity, beat.intensity);
      for (const entity of beat.entities) {
        if (!last.entities.includes(entity) && last.entities.length < 8) last.entities.push(entity);
      }
    } else {
      const key = `pl-${visual}-${groups.length + 1}`;
      groups.push({
        visual,
        key,
        startMs: beat.startMs,
        endMs: beat.endMs,
        title: beat.narration.slice(0, 60),
        intensity: Math.max(0, Math.min(1, beat.intensity)),
        entities: beat.entities.slice(0, 8)
      });
    }
  }
  const ops: MotionOp[] = [];
  groups.forEach((group, index) => {
    const span = Math.max(800, group.endMs - group.startMs);
    const next = groups[index + 1];
    const nextSpan = next ? Math.max(800, next.endMs - next.startMs) : 0;
    // The overlap covers the next mount's full landing plus a blend tail, so
    // the outgoing mount never drops below the incoming one mid-handoff.
    const overlap = next ? Math.min(1400, Math.round(enterMsFor(nextSpan, next.intensity) + 500)) : 0;
    const nextEnterMs = next ? enterMsFor(nextSpan, next.intensity) : 0;
    const target = `#lab-scene-${group.key}`;
    const element: Record<string, unknown> = { key: group.key, act: index + 1, ...(vertical ? { layout: "reel" } : {}) };
    if (group.visual === "orb") {
      element.kind = "orb";
      element.count = 72;
    } else if (group.visual === "title") {
      element.kind = "title";
      element.eyebrow = "WAVES";
      element.text = group.title || "Motion";
    } else if (group.visual === "crm") {
      element.kind = "crm";
      element.rows = crmRowsFor(group.entities);
    } else if (group.visual === "network") {
      element.kind = "network";
      element.count = 120;
    } else if (group.visual === "notebook") {
      element.kind = "notebook";
      element.text = "CONTEXT";
      const signal = notebookSignalFor(group.entities);
      if (signal) element.signal = signal;
    } else if (group.visual === "workflow") {
      element.kind = "workflow";
      const items = workflowItemsFor(group.entities);
      if (items) element.items = items;
    } else if (group.visual === "milestones") {
      element.kind = "milestones";
      element.count = 3;
    } else {
      element.kind = "box";
    }
    sceneElements.push(element);
    // Crossfade into the next mount: the exit dissolves through its enter.
    // Same-target repeats never occur here (merged above), so the extension
    // cannot collide with another writer on this target.
    const morph = morphSpan(span, overlap, group.intensity, nextEnterMs);
    ops.push({
      id: planId("op"),
      kind: "animate",
      target,
      properties: morphProperties(group.visual, target, morph) as never,
      options: { delay: group.startMs, duration: morph.duration, easing: "waves-entrance" }
    });
    // Children cascade while the mount is still landing (not after it), so
    // rows, lines, and dots resolve through the entrance — no empty stage.
    const cascade = cascadeFor(group.visual, target, group.startMs + Math.round(morph.enter * morph.duration * 0.5), planId("cascade"));
    if (cascade) ops.push(cascade);
    // Headlines resolve glyph by glyph through the mount's own entrance.
    if (group.visual === "title") {
      ops.push({
        id: planId("text"),
        kind: "text",
        target: `${target} .lab-scene-title`,
        duration: Math.max(300, Math.min(900, Math.round(span * 0.3))),
        delay: group.startMs + 80,
        stagger: 40,
        easing: "waves-entrance"
      });
    }
  });
  const full: MotionOp[] = [{ id: planId("scene"), kind: "scene", scene: { elements: sceneElements as never } }, ...ops];
  return { ops: full, overlaps: auditSingleWriter(full), validation: validateAll(full) };
}
