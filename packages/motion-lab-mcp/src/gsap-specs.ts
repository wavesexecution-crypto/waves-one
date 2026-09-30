/**
 * GSAP spec track — the MCP-side store for GSAP animation specifications.
 *
 * Parallel to (never replacing) the MotionOp track: specs live as versioned
 * JSON under `.motion/gsap/<name>.json`, and the live one is mirrored to
 * `public/gsap-state.json` (`{ name, updatedAt, spec }`) which the Lab GSAP
 * workspace polls and the GsapEngine plays. Validation and planning reuse
 * the engine's own pure functions, so MCP and browser agree byte for byte.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isGsapSceneSpec, planTimeline, validateGsapSpec, type GsapOp, type GsapSceneSpec } from "@waves/motion";

export interface GsapSpecRecord {
  name: string;
  description: string;
  spec: GsapSceneSpec;
  updatedAt: string;
}

export interface GsapLiveState {
  name: string;
  updatedAt: string;
  spec: GsapSceneSpec;
  /**
   * Markup version of the stage this spec was authored against. The Lab
   * reloads once when its own bundle reports a different version, so a spec
   * published ahead of (or behind) the deployed bundle cannot strand a viewer
   * on GSAP_TARGET_MISSING.
   */
  stageVersion?: number;
}

function specsDir(labDir: string): string {
  return join(labDir, ".motion", "gsap");
}

function fileFor(labDir: string, name: string): string {
  return join(specsDir(labDir), `${name}.json`);
}

function liveFile(labDir: string): string {
  return join(labDir, "public", "gsap-state.json");
}

function safeName(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!cleaned) throw new Error("GSAP spec needs a non-empty name.");
  return cleaned;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, text, "utf8");
  }
}

function asOps(value: unknown): GsapOp[] {
  if (!Array.isArray(value)) throw new Error("GSAP spec needs an ops array.");
  return value as GsapOp[];
}

/** Build a scene from parts. IDs default deterministically when omitted. */
export function buildGsapScene(input: { name: string; description?: string; ops: Array<Record<string, unknown>> }): GsapSceneSpec {
  const name = safeName(input.name);
  const ops = asOps(
    input.ops.map((raw, index) => ({
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `op-${index + 1}`,
      ...raw
    }))
  );
  const spec: GsapSceneSpec = {
    version: 1,
    name,
    ...(input.description ? { description: input.description } : {}),
    ops
  };
  const report = validateGsapSpec(spec);
  if (!report.ok) {
    throw new Error(`GSAP spec "${name}" rejected: ${report.errors.map((issue) => `${issue.opId}:${issue.code}`).join(", ")}`);
  }
  return spec;
}

export function saveGsapSpec(labDir: string, spec: GsapSceneSpec): GsapSpecRecord {
  const report = validateGsapSpec(spec);
  if (!report.ok) {
    throw new Error(`GSAP spec "${spec.name}" rejected: ${report.errors.map((issue) => `${issue.opId}:${issue.code}`).join(", ")}`);
  }
  const record: GsapSpecRecord = { name: safeName(spec.name), description: spec.description ?? "", spec: { ...spec, name: safeName(spec.name) }, updatedAt: new Date().toISOString() };
  writeAtomic(fileFor(labDir, record.name), JSON.stringify(record, null, 2));
  return record;
}

export function getGsapSpec(labDir: string, name: string): GsapSpecRecord | null {
  try {
    const raw = readFileSync(fileFor(labDir, safeName(name)), "utf8");
    const parsed = JSON.parse(raw) as GsapSpecRecord;
    if (!isGsapSceneSpec(parsed.spec)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listGsapSpecs(labDir: string): Array<{ name: string; description: string; opCount: number; updatedAt: string }> {
  let files: string[] = [];
  try {
    files = readdirSync(specsDir(labDir)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: Array<{ name: string; description: string; opCount: number; updatedAt: string }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(specsDir(labDir), file), "utf8")) as GsapSpecRecord;
      if (!isGsapSceneSpec(parsed.spec)) continue;
      out.push({ name: parsed.name, description: parsed.description ?? "", opCount: parsed.spec.ops.length, updatedAt: parsed.updatedAt });
    } catch {
      /* one unreadable record never breaks the listing */
    }
  }
  return out;
}

/**
 * Patch one op by id (shallow merge of provided fields) or append new ops.
 * Re-validates the whole scene before persisting — a bad patch never lands.
 */
export function modifyGsapSpec(
  labDir: string,
  name: string,
  patch: { opId?: string; fields?: Record<string, unknown>; append?: Array<Record<string, unknown>> }
): GsapSpecRecord {
  const existing = getGsapSpec(labDir, name);
  if (!existing) throw new Error(`Unknown GSAP animation "${name}".`);
  let ops: GsapOp[] = [...existing.spec.ops];
  if (patch.opId) {
    const index = ops.findIndex((op) => op.id === patch.opId);
    if (index < 0) throw new Error(`Op "${patch.opId}" not found in "${name}".`);
    ops[index] = { ...ops[index], ...(patch.fields ?? {}) } as GsapOp;
  }
  if (patch.append) {
    const base = ops.length;
    ops = [...ops, ...asOps(patch.append.map((raw, index) => ({ id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `op-${base + index + 1}`, ...raw })))];
  }
  if (!patch.opId && !patch.append) throw new Error("modify_gsap_animation needs opId+fields or append ops.");
  return saveGsapSpec(labDir, { ...existing.spec, ops });
}

/** Publish a spec to the live mirror the Lab workspace plays. */
export function publishGsapLive(labDir: string, name: string, stageVersion?: number): GsapLiveState {
  const record = getGsapSpec(labDir, name);
  if (!record) throw new Error(`Unknown GSAP animation "${name}".`);
  const live: GsapLiveState = {
    name: record.name,
    updatedAt: new Date().toISOString(),
    spec: record.spec,
    ...(typeof stageVersion === "number" ? { stageVersion } : {})
  };
  writeAtomic(liveFile(labDir), JSON.stringify(live, null, 2));
  return live;
}

export function readGsapLive(labDir: string): GsapLiveState | null {
  try {
    const parsed = JSON.parse(readFileSync(liveFile(labDir), "utf8")) as GsapLiveState;
    if (!isGsapSceneSpec(parsed.spec)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Deterministic dry-run: validation + plan. No browser, no GSAP needed. */
export function testGsapSpec(spec: GsapSceneSpec): { validation: ReturnType<typeof validateGsapSpec>; plan: ReturnType<typeof planTimeline> } {
  return { validation: validateGsapSpec(spec), plan: planTimeline(spec) };
}

/** Readable GSAP code for a spec — the website snippet agents hand over. */
export function codeForGsapSpec(spec: GsapSceneSpec): string {
  const lines: string[] = [`import { gsap } from "gsap";`, ``, `// ${spec.name} — generated from the Motion Lab GSAP spec (${spec.ops.length} ops).`, `const tl = gsap.timeline({ defaults: { ease: "power3.out" } });`];
  for (const op of spec.ops) {
    const pos = op.position === undefined ? "" : `, ${typeof op.position === "number" ? op.position : `"${op.position}"`}`;
    const vars = (extra: string) => `{ duration: ${op.duration ?? 0.5}${op.ease ? `, ease: "${op.ease}"` : ""}${extra} }`;
    switch (op.type) {
      case "set":
        lines.push(`tl.set("${op.target}", ${JSON.stringify(op.to)}${pos ? `${pos}` : ""});`);
        break;
      case "tween":
      case "spring":
        lines.push(`tl.fromTo("${op.target}", ${JSON.stringify(op.from ?? {})}, ${vars(`, ...${JSON.stringify(op.to)}`)}${pos});`);
        break;
      case "stagger":
        lines.push(`tl.fromTo("${op.target}", ${JSON.stringify(op.from ?? {})}, ${vars(`, ...${JSON.stringify(op.to)}, stagger: ${JSON.stringify(op.stagger)}`)}${pos});`);
        break;
      case "text":
        lines.push(`// split "${op.target}" into .char spans, then`);
        lines.push(`tl.fromTo("${op.target} .waves-gsap-char", ${JSON.stringify(op.from ?? {})}, ${vars(`, ...${JSON.stringify(op.to)}`)}${pos});`);
        break;
      case "scroll":
        lines.push(`tl.fromTo("${op.target}", ${JSON.stringify(op.from ?? {})}, ${vars(`, ...${JSON.stringify(op.to)}, scrollTrigger: { trigger: "${op.trigger ?? op.target}", start: "${op.start ?? "top bottom"}", end: "${op.end ?? "bottom top"}", scrub: ${JSON.stringify(op.scrub ?? true)} }`)}${pos});`);
        break;
      case "motion-path":
        lines.push(`tl.to("${op.target}", ${vars(`, motionPath: ${JSON.stringify(op.path)}`)}${pos});`);
        break;
      case "parallax":
        lines.push(`tl.fromTo("${op.target}", { yPercent: ${-op.speed * 10} }, { yPercent: ${op.speed * 10}, ease: "none", scrollTrigger: { trigger: "${op.trigger ?? op.target}", scrub: true } });`);
        break;
    }
  }
  return lines.join("\n");
}
