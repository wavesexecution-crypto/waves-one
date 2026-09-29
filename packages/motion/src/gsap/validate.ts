/**
 * GSAP spec validation — pure, dependency-free (no GSAP import, no DOM).
 * Target existence is checked only when the caller supplies a resolver, so
 * the MCP server validates structure in Node while the Lab validates
 * against the live scope.
 */

import { planTimeline } from "./plan";
import { GSAP_SPEC_VERSION, GSAP_SPRING_PRESETS, isGsapSceneSpec, type GsapOp, type GsapSceneSpec } from "./spec";

export interface GsapIssue {
  level: "error" | "warning";
  opId: string;
  code: string;
  message: string;
}

export interface GsapValidationReport {
  ok: boolean;
  errors: GsapIssue[];
  warnings: GsapIssue[];
  targetsChecked: boolean;
}

export interface GsapValidateOptions {
  /** Return match count for a selector; omit to skip existence checks. */
  resolveTarget?: (selector: string) => number;
}

const OP_TYPES = ["tween", "stagger", "text", "scroll", "spring", "motion-path", "parallax", "set"] as const;

/** GSAP core ease grammar: name[.in|.out|.inOut][(params)]. */
const EASE_RE = /^(none|power[0-4]|back|elastic|bounce|circ|expo|sine|linear)(\.(in|out|inOut))?(\(([^)]*)\))?$/;

function checkEase(value: unknown, opId: string, report: GsapValidationReport): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    report.errors.push({ level: "error", opId, code: "GSAP_EASE_TYPE", message: `Ease must be a string, got ${typeof value}.` });
    return;
  }
  const match = EASE_RE.exec(value.trim());
  if (!match) {
    report.errors.push({ level: "error", opId, code: "GSAP_UNKNOWN_EASE", message: `Unknown ease "${value}" — use a GSAP core ease like power3.out.` });
    return;
  }
  const params = match[5];
  if (params !== undefined && params.trim().length > 0) {
    for (const part of params.split(",")) {
      const n = Number(part.trim());
      if (!Number.isFinite(n)) {
        report.errors.push({ level: "error", opId, code: "GSAP_EASE_PARAMS", message: `Ease "${value}" has a non-numeric parameter.` });
        return;
      }
    }
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** Layout-thrashing properties — warn, never error (escape hatch stays). */
const LAYOUT_PROPS = new Set(["width", "height", "top", "left", "right", "bottom", "margin", "marginTop", "marginLeft", "marginRight", "marginBottom", "padding", "fontSize"]);

function checkProps(props: Record<string, unknown> | undefined, opId: string, report: GsapValidationReport, what: string): void {
  if (!props) return;
  for (const [name, value] of Object.entries(props)) {
    if (typeof value !== "number" && typeof value !== "string") {
      report.errors.push({ level: "error", opId, code: "GSAP_PROP_TYPE", message: `${what}.${name} must be a number or string.` });
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      report.errors.push({ level: "error", opId, code: "GSAP_PROP_RANGE", message: `${what}.${name} is NaN or infinite.` });
    }
    if (LAYOUT_PROPS.has(name)) {
      report.warnings.push({ level: "warning", opId, code: "GSAP_LAYOUT_PROP", message: `${what}.${name} triggers layout — prefer transforms/opacity.` });
    }
  }
}

const POSITION_RE = /^(<|>|[a-zA-Z][\w-]*([+-]=[\d.]+)?|[+-]=[\d.]+)$/;

export function validateGsapSpec(spec: unknown, options: GsapValidateOptions = {}): GsapValidationReport {
  const report: GsapValidationReport = { ok: true, errors: [], warnings: [], targetsChecked: typeof options.resolveTarget === "function" };
  const err = (opId: string, code: string, message: string) => report.errors.push({ level: "error", opId, code, message });
  if (!isGsapSceneSpec(spec)) {
    err("(scene)", "GSAP_SPEC_SHAPE", "Spec must be { version: 1, name: string, ops: [] }.");
    report.ok = false;
    return report;
  }
  if (spec.version !== GSAP_SPEC_VERSION) err("(scene)", "GSAP_SPEC_VERSION", `Unsupported spec version ${String((spec as { version?: unknown }).version)}.`);
  if (!spec.name.trim()) err("(scene)", "GSAP_SPEC_NAME", "Scene needs a non-empty name.");
  const seen = new Set<string>();
  const labels = new Set<string>();
  spec.ops.forEach((op, index) => {
    const opId = typeof (op as { id?: unknown }).id === "string" && (op as { id: string }).id ? (op as { id: string }).id : `#${index}`;
    if (typeof (op as { id?: unknown }).id !== "string" || !(op as { id: string }).id.trim()) {
      err(opId, "GSAP_OP_ID", "Every op needs a non-empty string id.");
    } else if (seen.has((op as { id: string }).id)) {
      err(opId, "GSAP_DUP_ID", `Duplicate op id "${(op as { id: string }).id}".`);
    } else {
      seen.add((op as { id: string }).id);
    }
    const type = (op as { type?: unknown }).type;
    if (typeof type !== "string" || !(OP_TYPES as readonly string[]).includes(type)) {
      err(opId, "GSAP_OP_TYPE", `Unknown op type "${String(type)}".`);
      return;
    }
    const full = op as GsapOp;
    if (typeof full.target !== "string" || !full.target.trim()) {
      err(opId, "GSAP_NO_TARGET", "Op needs a non-empty target selector.");
    } else if (options.resolveTarget) {
      let count = 0;
      try {
        count = options.resolveTarget(full.target);
      } catch {
        count = 0;
      }
      if (count === 0) err(opId, "GSAP_TARGET_MISSING", `Target "${full.target}" matches nothing in scope.`);
    }
    if (full.label !== undefined) {
      if (typeof full.label !== "string" || !full.label.trim()) err(opId, "GSAP_LABEL", "Label must be a non-empty string.");
      else labels.add(full.label);
    }
    if (full.duration !== undefined && finiteNumber(full.duration) === null) err(opId, "GSAP_DURATION", "Duration must be a finite number.");
    else if (full.duration !== undefined && (full.duration as number) < 0) err(opId, "GSAP_DURATION", "Duration cannot be negative.");
    if (full.delay !== undefined && (finiteNumber(full.delay) === null || (full.delay as number) < 0)) {
      err(opId, "GSAP_DELAY", "Delay must be a finite number ≥ 0.");
    }
    if (full.position !== undefined) {
      if (typeof full.position === "number") {
        if (!Number.isFinite(full.position) || full.position < 0) err(opId, "GSAP_POSITION", "Numeric position must be finite and ≥ 0.");
      } else if (typeof full.position !== "string" || !POSITION_RE.test(full.position.trim())) {
        err(opId, "GSAP_POSITION", `Position "${String(full.position)}" is not a valid label, "<", ">", or offset.`);
      }
    }
    checkEase(full.ease, opId, report);
    if (full.type !== "motion-path" && full.type !== "parallax") {
      checkProps((full as { from?: Record<string, unknown> }).from, opId, report, "from");
    }
    if (full.type !== "motion-path" && full.type !== "parallax") {
      checkProps((full as { to?: Record<string, unknown> }).to, opId, report, "to");
    }
    if (full.type === "stagger") {
      const stagger = (full as { stagger?: unknown }).stagger;
      const okStagger =
        (typeof stagger === "number" && Number.isFinite(stagger) && stagger >= 0) ||
        (stagger !== null && typeof stagger === "object" && Number.isFinite((stagger as { each?: unknown }).each) && ((stagger as { each: number }).each as number) >= 0);
      if (!okStagger) err(opId, "GSAP_STAGGER", "Stagger must be a finite number ≥ 0 or { each: number ≥ 0, from? }.");
    }
    if (full.type === "text") {
      const split = (full as { split?: unknown }).split;
      if (split !== undefined && split !== "chars" && split !== "words") err(opId, "GSAP_TEXT_SPLIT", 'Split must be "chars" or "words".');
      const stagger = (full as { stagger?: unknown }).stagger;
      if (stagger !== undefined && (typeof stagger !== "number" || !Number.isFinite(stagger) || stagger < 0)) {
        err(opId, "GSAP_STAGGER", "Text stagger must be a finite number ≥ 0.");
      }
    }
    if (full.type === "spring") {
      const spring = (full as { spring?: unknown }).spring;
      if (typeof spring === "string") {
        if (!(spring in GSAP_SPRING_PRESETS)) err(opId, "GSAP_SPRING", `Unknown spring preset "${spring}" — use gentle, snappy, deliberate, signature, or house.`);
      } else if (spring !== null && typeof spring === "object") {
        const config = spring as { stiffness?: unknown; damping?: unknown; mass?: unknown };
        if (typeof config.stiffness !== "number" || !Number.isFinite(config.stiffness) || config.stiffness <= 0) {
          err(opId, "GSAP_SPRING", "Spring config needs stiffness > 0.");
        }
        if (typeof config.damping !== "number" || !Number.isFinite(config.damping) || config.damping < 0) {
          err(opId, "GSAP_SPRING", "Spring config needs damping ≥ 0.");
        }
        if (config.mass !== undefined && (typeof config.mass !== "number" || !Number.isFinite(config.mass) || config.mass <= 0)) {
          err(opId, "GSAP_SPRING", "Spring mass must be > 0.");
        }
      } else {
        err(opId, "GSAP_SPRING", "Spring op needs a preset name or { stiffness, damping, mass? }.");
      }
    }
    if (full.type === "motion-path") {
      const path = (full as { path?: unknown }).path;
      const okPath =
        (typeof path === "string" && /[Mm]\s*-?[\d.]/.test(path)) ||
        (Array.isArray(path) && path.length >= 2 && path.every((point) => point !== null && typeof point === "object" && Number.isFinite((point as { x?: unknown }).x) && Number.isFinite((point as { y?: unknown }).y)));
      if (!okPath) err(opId, "GSAP_MOTION_PATH", "Path must be SVG path data (starting with M) or ≥2 {x,y} waypoints.");
    }
    if (full.type === "parallax") {
      const speed = (full as { speed?: unknown }).speed;
      if (typeof speed !== "number" || !Number.isFinite(speed)) err(opId, "GSAP_PARALLAX", "Parallax speed must be a finite number.");
      else if (Math.abs(speed) > 1) {
        report.warnings.push({ level: "warning", opId, code: "GSAP_PARALLAX_RANGE", message: `Speed ${speed} exceeds the typical ±1 range.` });
      }
    }
    if (full.type === "scroll") {
      const scrub = (full as { scrub?: unknown }).scrub;
      if (scrub !== undefined && scrub !== true && scrub !== false && (typeof scrub !== "number" || !Number.isFinite(scrub) || scrub < 0)) {
        err(opId, "GSAP_SCRUB", "Scrub must be boolean or a finite number ≥ 0.");
      }
    }
  });
  // Label references resolve against declared labels.
  for (const op of spec.ops) {
    const full = op as GsapOp;
    if (typeof full.position === "string") {
      const base = full.position.trim().split(/[+-]=/)[0].trim();
      if (base && base !== "<" && base !== ">" && !labels.has(base)) {
        report.warnings.push({ level: "warning", opId: full.id, code: "GSAP_LABEL_REF", message: `Position references unknown label "${base}" — resolves to timeline end.` });
      }
    }
  }
  // Ordering sanity from the deterministic plan.
  try {
    const plan = planTimeline(spec);
    for (const span of plan.spans) {
      if (span.startMs < 0) {
        report.errors.push({ level: "error", opId: span.id, code: "GSAP_ORDER", message: "Op starts before t=0." });
      }
    }
  } catch {
    report.errors.push({ level: "error", opId: "(scene)", code: "GSAP_PLAN", message: "Timeline planning failed." });
  }
  report.ok = report.errors.length === 0;
  return report;
}
