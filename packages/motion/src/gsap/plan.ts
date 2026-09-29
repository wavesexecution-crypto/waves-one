/**
 * Deterministic timeline planner — resolves spec positions into concrete
 * millisecond spans without a browser, GSAP, or DOM. The MCP test tool and
 * the engine agree on timing because both read this plan.
 */

import type { GsapOp, GsapSceneSpec } from "./spec";

export interface PlannedOp {
  id: string;
  type: string;
  target: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  ambient: boolean;
  scrubbed: boolean;
}

export interface GsapPlan {
  spans: PlannedOp[];
  totalMs: number;
  tweenCount: number;
  ambientCount: number;
  scrubbedCount: number;
  labels: Record<string, number>;
}

const RELATIVE = /^([a-zA-Z][\w-]*|<|>)?([+-]=[\d.]+)?$/;

function resolveStart(op: GsapOp, cursorMs: number, prevStartMs: number, labels: Map<string, number>): number {
  const position = op.position;
  if (position === undefined) return cursorMs;
  if (typeof position === "number") return Math.round(position * 1000);
  if (position === "<") return prevStartMs;
  if (position === ">") return cursorMs;
  const match = RELATIVE.exec(position.trim());
  if (!match) return cursorMs;
  const [, label, offset] = match;
  const deltaMs = offset ? Math.round(parseFloat(offset.slice(2)) * 1000) * (offset[0] === "-" ? -1 : 1) : 0;
  if (!label || label === "<") return (label === "<" ? prevStartMs : cursorMs) + deltaMs;
  if (label === ">") return cursorMs + deltaMs;
  const at = labels.get(label);
  return (at ?? cursorMs) + deltaMs;
}

/** Pure computation: every op → span. Scrubbed ops are zero-length markers. */
export function planTimeline(spec: GsapSceneSpec): GsapPlan {
  const spans: PlannedOp[] = [];
  const labels = new Map<string, number>();
  let cursorMs = 0;
  let prevStartMs = 0;
  let tweenCount = 0;
  let ambientCount = 0;
  let scrubbedCount = 0;
  for (const op of spec.ops) {
    const scrubbed = op.type === "scroll" || op.type === "parallax";
    const baseMs = Math.round(((op.duration ?? (op.type === "set" ? 0 : 0.5)) as number) * 1000);
    const delayMs = Math.round(((op.delay ?? 0) as number) * 1000);
    const startMs = Math.max(0, resolveStart(op, cursorMs, prevStartMs, labels) + delayMs);
    const endMs = scrubbed ? startMs : startMs + baseMs;
    const ambient = op.ambient === true;
    spans.push({ id: op.id, type: op.type, target: op.target, startMs, endMs, durationMs: endMs - startMs, ambient, scrubbed });
    if (op.label) labels.set(op.label, startMs);
    if (!scrubbed) {
      tweenCount += 1;
      if (ambient) ambientCount += 1;
      cursorMs = Math.max(cursorMs, endMs);
    } else {
      scrubbedCount += 1;
    }
    prevStartMs = startMs;
  }
  return {
    spans,
    totalMs: spans.reduce((max, span) => Math.max(max, span.endMs), 0),
    tweenCount,
    ambientCount,
    scrubbedCount,
    labels: Object.fromEntries(labels)
  };
}
