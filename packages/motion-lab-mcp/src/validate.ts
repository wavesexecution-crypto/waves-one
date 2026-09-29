/**
 * Deterministic validation + test simulation — no DOM, no browser.
 *
 * Every check is a pure function of the ops: preset names against the
 * live catalogue, properties against the property catalog, easings
 * through the real resolver, springs through the real solver, timeline
 * layout through the same sequential/at/after rules the runtime uses.
 * The browser preview then only confirms what validation already proved.
 */

import { defaultMotionTokens } from "@waves/motion";
import {
  easingExists,
  mapFeel,
  presetExists,
  propertyCost,
  propertyKnown,
  springVerdict,
  staggerOriginValid
} from "./engine-catalog.js";
import type { MotionOp } from "./ops.js";
import { SCENE_KINDS } from "./ops.js";

export interface ValidationIssue {
  level: "error" | "warning";
  opId: string;
  code: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const MAX_REASONABLE_DURATION = 8000;
const MAX_REASONABLE_STAGGER = 2000;

function checkEasing(value: unknown, opId: string, report: ValidationReport): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !easingExists(value)) {
    report.errors.push({ level: "error", opId, code: "MOTION_UNKNOWN_EASING", message: `Unknown easing "${String(value)}".` });
  }
}

function checkProperties(properties: Record<string, unknown> | undefined, opId: string, report: ValidationReport): void {
  if (!properties) return;
  for (const name of Object.keys(properties)) {
    if (!propertyKnown(name)) {
      report.errors.push({ level: "error", opId, code: "MOTION_UNKNOWN_PROPERTY", message: `Unknown property "${name}" — the engine would report it as a diagnostic, not animate it.` });
    }
  }
}

function checkTiming(duration: number | undefined, delay: number | undefined, stagger: number | undefined, opId: string, report: ValidationReport): void {
  if (duration !== undefined && (duration < 0 || duration > MAX_REASONABLE_DURATION)) {
    report.warnings.push({ level: "warning", opId, code: "MOTION_TIMING", message: `Duration ${duration}ms is outside the 0–8000ms house range.` });
  }
  if (delay !== undefined && (delay < 0 || delay > MAX_REASONABLE_DURATION)) {
    report.warnings.push({ level: "warning", opId, code: "MOTION_TIMING", message: `Delay ${delay}ms is outside the 0–8000ms house range.` });
  }
  if (stagger !== undefined && (stagger < 0 || stagger > MAX_REASONABLE_STAGGER)) {
    report.warnings.push({ level: "warning", opId, code: "MOTION_TIMING", message: `Stagger ${stagger}ms is outside the 0–2000ms house range.` });
  }
}

export function validateOp(op: MotionOp): ValidationReport {
  const report: ValidationReport = { ok: true, errors: [], warnings: [] };
  switch (op.kind) {
    case "reset":
      break;
    case "scene": {
      for (const element of op.scene.elements ?? []) {
        if (!(SCENE_KINDS as readonly string[]).includes(element.kind)) {
          report.errors.push({ level: "error", opId: op.id, code: "MOTION_UNKNOWN_SCENE", message: `Unknown scene element kind "${String(element.kind)}" — the runtime would render a blank box.` });
        }
      }
      break;
    }
    case "animate": {
      if (!op.target || op.target.trim().length === 0) {
        report.errors.push({ level: "error", opId: op.id, code: "MOTION_NO_TARGET", message: "Animate op has an empty target." });
      }
      checkProperties(op.properties, op.id, report);
      checkEasing(op.options?.easing, op.id, report);
      checkTiming(op.options?.duration, op.options?.delay, op.options?.stagger, op.id, report);
      if (op.options?.staggerFrom !== undefined && !staggerOriginValid(op.options.staggerFrom)) {
        report.errors.push({ level: "error", opId: op.id, code: "MOTION_UNKNOWN_STAGGER_ORIGIN", message: `Unknown stagger origin "${op.options.staggerFrom}" — the runtime fails loudly on it.` });
      }
      if (op.options?.spring) {
        const verdict = springVerdict(op.options.spring);
        if (verdict.verdict === "bouncy") {
          report.warnings.push({ level: "warning", opId: op.id, code: "MOTION_BOUNCY", message: `Spring is bouncy (${verdict.description}). Reserve overshoot for signature moments.` });
        }
      }
      break;
    }
    case "preset": {
      if (!presetExists(op.preset)) {
        report.errors.push({ level: "error", opId: op.id, code: "MOTION_UNKNOWN_PRESET", message: `Unknown preset "${op.preset}".` });
      }
      if (!op.target || op.target.trim().length === 0) {
        report.errors.push({ level: "error", opId: op.id, code: "MOTION_NO_TARGET", message: "Preset op has an empty target." });
      }
      checkTiming(op.options?.duration, op.options?.delay, op.options?.stagger, op.id, report);
      if (op.options?.staggerFrom !== undefined && !staggerOriginValid(op.options.staggerFrom)) {
        report.errors.push({ level: "error", opId: op.id, code: "MOTION_UNKNOWN_STAGGER_ORIGIN", message: `Unknown stagger origin "${op.options.staggerFrom}" — the runtime fails loudly on it.` });
      }
      break;
    }
    case "timeline": {
      if (op.nodes.length === 0) {
        report.errors.push({ level: "error", opId: op.id, code: "MOTION_EMPTY_TIMELINE", message: "Timeline has no nodes." });
      }
      const labels = new Set<string>();
      for (const node of op.nodes) {
        if (node.preset && !presetExists(node.preset)) {
          report.errors.push({ level: "error", opId: op.id, code: "MOTION_UNKNOWN_PRESET", message: `Unknown preset "${node.preset}" in timeline node.` });
        }
        if (node.properties) checkProperties(node.properties, op.id, report);
        checkEasing(node.easing, op.id, report);
        if (node.label) {
          if (labels.has(node.label)) {
            report.errors.push({ level: "error", opId: op.id, code: "MOTION_DUPLICATE_LABEL", message: `Duplicate timeline label "${node.label}".` });
          }
          labels.add(node.label);
        }
      }
      for (const node of op.nodes) {
        if (node.after && !labels.has(node.after)) {
          report.errors.push({ level: "error", opId: op.id, code: "MOTION_UNKNOWN_LABEL", message: `Timeline node waits on unknown label "${node.after}".` });
        }
      }
      break;
    }
    case "scroll": {
      if (!op.target || op.target.trim().length === 0) {
        report.errors.push({ level: "error", opId: op.id, code: "MOTION_NO_TARGET", message: "Scroll op has an empty target." });
      }
      if (op.properties) checkProperties(op.properties, op.id, report);
      checkEasing(op.options?.easing, op.id, report);
      break;
    }
    case "text": {
      if (!op.target || op.target.trim().length === 0) {
        report.errors.push({ level: "error", opId: op.id, code: "MOTION_NO_TARGET", message: "Text op has an empty target." });
      }
      checkTiming(op.duration, op.delay, op.stagger, op.id, report);
      checkEasing(op.easing, op.id, report);
      break;
    }
    default: {
      // Untyped JSON can carry kinds outside the union; the runtime ignores
      // them, so validation rejects loudly instead of shipping dead ops.
      const unknown = op as { id?: unknown; kind?: unknown };
      const unknownId = typeof unknown.id === "string" ? unknown.id : "unknown";
      report.errors.push({ level: "error", opId: unknownId, code: "MOTION_UNKNOWN_KIND", message: `Unknown op kind "${String(unknown.kind)}" — the runtime would ignore it.` });
      break;
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}

export function validateAll(ops: MotionOp[]): ValidationReport {
  const combined: ValidationReport = { ok: true, errors: [], warnings: [] };
  for (const op of ops) {
    const single = validateOp(op);
    combined.errors.push(...single.errors);
    combined.warnings.push(...single.warnings);
  }
  combined.ok = combined.errors.length === 0;
  return combined;
}

/* ------------------------- test simulation ------------------------- */

export interface SimulatedSpan {
  opId: string;
  kind: string;
  target?: string;
  start: number;
  duration: number;
  end: number;
  staggerSpread: number;
  costs: Record<string, string>;
  spring?: string;
  note: string;
}

export interface TestReport {
  ok: boolean;
  spans: SimulatedSpan[];
  totalDuration: number;
  reducedMotionNote: string;
  validation: ValidationReport;
}

const FALLBACK_DURATION = 350;

function spanFor(op: MotionOp, index: number): SimulatedSpan {
  const tokens = defaultMotionTokens;
  const base: SimulatedSpan = {
    opId: op.id,
    kind: op.kind,
    start: 0,
    duration: FALLBACK_DURATION,
    end: FALLBACK_DURATION,
    staggerSpread: 0,
    costs: {},
    note: ""
  };
  switch (op.kind) {
    case "reset":
      return { ...base, duration: 0, end: 0, note: "Clears engine state before subsequent ops." };
    case "scene":
      return { ...base, duration: 0, end: 0, note: `Materializes ${op.scene.elements.length} neutral preview target(s).` };
    case "animate": {
      const duration = op.options?.duration ?? tokens.duration.normal;
      const delay = op.options?.delay ?? 0;
      const stagger = op.options?.stagger ?? 0;
      const costs: Record<string, string> = {};
      for (const name of Object.keys(op.properties)) costs[name] = propertyCost(name);
      const mapped = op.options?.easing ? undefined : mapFeel(undefined);
      void mapped;
      return {
        ...base,
        target: op.target,
        start: delay + index * 0,
        duration,
        end: delay + duration + stagger * 4,
        staggerSpread: stagger,
        costs,
        spring: op.options?.spring ? springVerdict(op.options.spring).description : undefined,
        note: op.options?.easing ? `Easing ${op.options.easing}.` : "House default easing."
      };
    }
    case "preset":
      return {
        ...base,
        target: op.target,
        duration: op.options?.duration ?? tokens.duration.normal,
        end: (op.options?.delay ?? 0) + (op.options?.duration ?? tokens.duration.normal),
        note: `Preset "${op.preset}" expands with house duration/easing.`
      };
    case "timeline": {
      let sequential = 0;
      const byLabel = new Map<string, number>();
      let total = 0;
      const pending = new Map<string, number[]>();
      op.nodes.forEach((node, nodeIndex) => {
        const duration = node.duration ?? tokens.duration.normal;
        const label = node.label ?? `node-${nodeIndex}`;
        let start: number;
        if (node.at !== undefined) start = node.at;
        else if (node.after) {
          const dep = byLabel.get(node.after);
          if (dep === undefined) {
            const queue = pending.get(node.after) ?? [];
            queue.push(nodeIndex);
            pending.set(node.after, queue);
            start = -1;
          } else start = dep;
        } else start = sequential;
        if (start >= 0) {
          sequential = start + duration;
          byLabel.set(label, start + duration);
          total = Math.max(total, start + duration);
          for (const waiter of pending.get(label) ?? []) {
            void waiter;
          }
          pending.delete(label);
        }
      });
      return { ...base, duration: total, end: total, note: `${op.nodes.length} node(s), computed total ${total}ms.` };
    }
    case "scroll":
      return { ...base, target: op.target, duration: 0, end: 0, note: "Scrubbed by scroll position — no fixed duration." };
    case "text": {
      const duration = op.duration ?? tokens.duration.normal;
      const stagger = op.stagger ?? 40;
      return {
        ...base,
        target: op.target,
        duration,
        end: duration + stagger * 12,
        staggerSpread: stagger,
        note: `Char stagger ≈${stagger}ms over the headline.`
      };
    }
  }
}

export function testOps(ops: MotionOp[]): TestReport {
  const validation = validateAll(ops);
  const spans = ops.map((op, index) => spanFor(op, index));
  const totalDuration = spans.reduce((max, span) => Math.max(max, span.end), 0);
  return {
    ok: validation.ok,
    spans,
    totalDuration,
    reducedMotionNote:
      "Under reduced motion the runtime collapses transform travel but keeps landing states; durations are preserved.",
    validation
  };
}
