/**
 * The intent-level tools (13 agent tools + apply_instruction for the Lab
 * surface). The AI speaks wishes; each handler translates
 * to engine ops, persists state, and returns structured results with the
 * generated target-website code. Nothing here exposes raw engine plumbing.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPresetProperties, catalogueSnapshot, easingExists, mapBehavior, mapFeel } from "./engine-catalog.js";
import { codeForOp } from "./codegen.js";
import { commit, findOp, nextId, readState, type StorePaths } from "./store.js";
import { inspectTarget } from "./target.js";
import { testOps, validateAll, validateOp } from "./validate.js";
import { listVoiceovers } from "./voiceover.js";
import { buildStory, extractEntities, validateStory } from "./story.js";
import { openDb, closeDb } from "./db.js";
import { artifactsForJob, listArtifacts, listAssets, listTechniques, registerAsset, recordTechnique } from "./assets.js";
import { cancel, enqueue, getEvents, getJob, listJobs, recoverStale } from "./jobs.js";
import { createWorker } from "./worker.js";
import { defaultHandlers } from "./orchestrator.js";
import { cascadeFor, crmRowsFor, enterMsFor, morphProperties, morphSpan, notebookSignalFor, planStory, workflowItemsFor } from "./planner.js";
import { createRenderHandler } from "./render.js";
import { createFromVoiceover } from "./pipeline.js";
import { getRevision, publishRevision } from "./revisions.js";
import {
  buildGsapScene,
  codeForGsapSpec,
  getGsapSpec,
  listGsapSpecs,
  modifyGsapSpec,
  publishGsapLive,
  saveGsapSpec,
  testGsapSpec
} from "./gsap-specs.js";
import {
  deleteGeneration,
  generateAndWait,
  getGeneration,
  importCompletedRender,
  listGenerations,
  markSelected,
  motionProviderStatus,
  saveGenerationToLab,
  saveSourceImage
} from "./ai-motion.js";
import { COSMOS_MODEL_ID, COSMOS_PROVIDER_ID, diagnoseCosmosConfig, selectedMotionProviderId } from "./cosmos.js";
import { enhanceMotionPrompt, liveChatStatus } from "./nvidia-live.js";
import { getAsset } from "./assets.js";
import type { MotionOp } from "./ops.js";
import type { ToolDefinition, ToolHandler } from "./protocol.js";

export const PREVIEW_URL = "http://localhost:5173/";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function props(value: unknown): Record<string, unknown> {
  return asRecord(value);
}

function springInput(value: unknown): { stiffness?: number; damping?: number; mass?: number } | undefined {
  const record = asRecord(value);
  const out: { stiffness?: number; damping?: number; mass?: number } = {};
  const stiffness = num(record.stiffness);
  const damping = num(record.damping);
  const mass = num(record.mass);
  if (stiffness !== undefined) out.stiffness = stiffness;
  if (damping !== undefined) out.damping = damping;
  if (mass !== undefined) out.mass = mass;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface SavedAnimation {
  name: string;
  description: string;
  opCount: number;
  opIds: string[];
  ops: MotionOp[];
}

/** Named animation library — canonical definitions under `.motion/animations/`. */
export function listSavedAnimations(paths: StorePaths): SavedAnimation[] {
  const dir = join(paths.labDir, ".motion", "animations");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: SavedAnimation[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        name?: unknown;
        description?: unknown;
        ops?: unknown;
      };
      const ops = Array.isArray(parsed.ops) ? (parsed.ops as MotionOp[]) : [];
      out.push({
        name: typeof parsed.name === "string" ? parsed.name : file.replace(/\.json$/, ""),
        description: typeof parsed.description === "string" ? parsed.description : "",
        opCount: ops.length,
        opIds: ops.map((op) => op.id),
        ops
      });
    } catch {
      /* one unreadable record never breaks the library listing */
    }
  }
  return out;
}

/**
 * Apply a modify-style patch to one op. Shared by `modify_animation` and
 * `apply_instruction` so both entry points execute identical mutations.
 */
export function patchOp(op: MotionOp, patch: Record<string, unknown>): MotionOp {
  if (op.kind === "animate") {
    const feelName = str(patch.feel);
    const feel = feelName ? mapFeel(feelName) : null;
    return {
      ...op,
      target: str(patch.target, op.target),
      properties: patch.properties ? props(patch.properties) : op.properties,
      options: {
        ...op.options,
        ...(num(patch.duration) !== undefined ? { duration: num(patch.duration) as number } : {}),
        ...(num(patch.delay) !== undefined ? { delay: num(patch.delay) as number } : {}),
        ...(num(patch.stagger) !== undefined ? { stagger: num(patch.stagger) as number } : {}),
        ...(str(patch.staggerFrom) ? { staggerFrom: str(patch.staggerFrom) } : {}),
        ...(str(patch.easing) ? { easing: str(patch.easing) } : {}),
        ...(patch.spring ? { spring: springInput(patch.spring) ?? op.options?.spring } : {}),
        ...(feel ? { easing: "waves-spring", spring: feel.spring } : {})
      }
    };
  }
  if (op.kind === "preset") {
    return {
      ...op,
      preset: str(patch.preset || patch.behavior, op.preset),
      target: str(patch.target, op.target),
      options: {
        ...op.options,
        ...(num(patch.duration) !== undefined ? { duration: num(patch.duration) as number } : {}),
        ...(num(patch.delay) !== undefined ? { delay: num(patch.delay) as number } : {}),
        ...(num(patch.stagger) !== undefined ? { stagger: num(patch.stagger) as number } : {}),
        ...(str(patch.staggerFrom) ? { staggerFrom: str(patch.staggerFrom) } : {}),
        ...(str(patch.easing) ? { easing: str(patch.easing) } : {})
      }
    };
  }
  if (op.kind === "text") {
    return {
      ...op,
      target: str(patch.target, op.target),
      ...(num(patch.stagger) !== undefined ? { stagger: num(patch.stagger) as number } : {}),
      ...(num(patch.duration) !== undefined ? { duration: num(patch.duration) as number } : {}),
      ...(str(patch.easing) ? { easing: str(patch.easing) } : {}),
      ...(num(patch.delay) !== undefined ? { delay: num(patch.delay) as number } : {})
    };
  }
  if (op.kind === "scroll") {
    return {
      ...op,
      target: str(patch.target, op.target),
      properties: patch.properties ? props(patch.properties) : op.properties
    };
  }
  throw new Error(`Op "${op.id}" is a ${op.kind} op — recreate it instead of patching.`);
}

/** Brief staging directory — plans live here until published. */
function briefsDir(paths: StorePaths): string {
  const dir = join(paths.labDir, ".motion", "briefs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface PlanBeat {
  name: string;
  intent: string;
  scene: Record<string, unknown> | null;
  op: Record<string, unknown>;
  label?: string;
  startMs?: number;
}

interface SceneCast {
  key: string;
  element: Record<string, unknown>;
  label: string;
}

/**
 * Shared narration→scene casting: keyword sets map story language onto
 * scene atoms + beat labels. Deterministic and inspectable — the agent
 * session supplies understanding, this supplies the mechanical mapping.
 * First match wins; order runs specific before generic.
 */
const NARRATION_SCENES: Array<{ match: RegExp; label: string; key: string; element: Record<string, unknown> }> = [
  // Explicit visual nouns win: saying "network" casts the network visual
  // even when CRM words share the sentence.
  { match: /\bnetwork\b|\bgraph\b|connect/, label: "DISCOVERY", element: { kind: "network", count: 120 }, key: "nar-network-explicit" },
  { match: /problem|pain|struggl|hard|manual|chaos|drown/, label: "PROBLEM", element: { kind: "title", text: "The problem" }, key: "nar-problem" },
  // The one system: convergence into the WAVES identity (orb), never a dashboard.
  { match: /\bsystem\b|platform|transform|become|converge|unif|together/, label: "SYSTEM", element: { kind: "orb", count: 72 }, key: "nar-system" },
  { match: /\bcrm\b|customers?|leads?|prospects?|contacts?|clients?|buyers?|accounts?/, label: "CRM", key: "nar-crm", element: { kind: "crm" } },
  // Scattered sources that have not converged yet: many origins, network visual.
  { match: /\bsources?|scattered|everywhere|inbox|emails?|messages?|notifications?/, label: "DISCOVERY", element: { kind: "network", count: 120 }, key: "nar-sources" },
  { match: /find|search|seek|discover|hunt|look for|brows|lookup/, label: "DISCOVERY", element: { kind: "network", count: 120 }, key: "nar-network" },
  { match: /notebook|research|context|understand|insight|analy[sz]|plan|strategy|blueprint|\bknow|learn|remember/, label: "NOTEBOOK", key: "nar-notebook", element: { kind: "notebook", text: "CONTEXT" } },
  { match: /workflow|outreach|deploy|execut|action|follow|pipeline|process|automat|manual|repetitive|hours|steps?|agents?|move|forward|progress|\brun/, label: "WORKFLOW", key: "nar-workflow", element: { kind: "workflow" } },
  { match: /report|result|milestone|track|measur|outcome|growth|scale|numbers?/, label: "REPORT", element: { kind: "milestones", count: 3 }, key: "nar-report" },
  { match: /finale|conclus|thank|choose|rent|operate|done\b|complete/, label: "FINALE", element: { kind: "title", large: true, eyebrow: "WAVES", text: "WAVES" }, key: "nar-finale" },
  { match: /\borb\b|waves\b|intelligence\b/, label: "INTRO", key: "nar-orb", element: { kind: "orb", count: 72 } }
];

export function castScene(sentence: string): SceneCast | null {
  const lowered = sentence.toLowerCase();
  const found = NARRATION_SCENES.find((candidate) => candidate.match.test(lowered));
  return found ? { key: found.key, element: { ...found.element }, label: found.label } : null;
}

export interface NarrationBeat {
  index: number;
  startMs: number;
  endMs: number;
  label: string;
  text: string;
  scene: { key: string; element: Record<string, unknown> } | null;
}

/** Split transcript sentences into labeled, scene-cast beats across a duration. */
export function analyzeNarration(
  transcript: string,
  durationMs: number,
  segments?: Array<{ startMs: number; endMs?: number; text?: string }>
): NarrationBeat[] {
  const total = Math.max(3000, Math.min(120000, Math.round(durationMs) || 20000));
  const raw: Array<{ startMs: number; endMs: number; text: string }> = Array.isArray(segments) && segments.length > 0
    ? segments.map((segment) => ({
        startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
        endMs: Math.round(Number(segment.endMs) || 0),
        text: typeof segment.text === "string" ? segment.text : ""
      }))
    : transcript
        .split(/(?<=[.!?])\s+|\n+/)
        .map((part) => part.trim().replace(/[.?!;]+$/, ""))
        .filter((part) => part.length > 0)
        .slice(0, 12)
        .map((text, index, all) => ({
          startMs: Math.floor((total * index) / all.length),
          endMs: Math.floor((total * (index + 1)) / all.length),
          text
        }));
  if (raw.length === 0) return [];
  const beats = raw.map((segment, index) => {
    const endMs = segment.endMs > segment.startMs ? segment.endMs : index + 1 < raw.length ? raw[index + 1].startMs : total;
    const cast = castScene(segment.text);
    return {
      index,
      startMs: segment.startMs,
      endMs: Math.min(total, Math.max(segment.startMs + 500, endMs)),
      label: cast?.label ?? `BEAT ${String(index + 1).padStart(2, "0")}`,
      text: segment.text,
      scene: cast ? { key: cast.key, element: cast.element } : null
    };
  });
  return beats;
}

/**
 * Deterministic brief parser: splits a creative brief into beats, casts
 * each beat to scene atoms + one mount op, and validates without publishing.
 * No model calls — the agent session provides understanding; this provides
 * the mechanical plan shape both can inspect.
 */
export function planBrief(
  brief: string,
  orientation: string,
  durationMs: number,
  pins?: Array<{ startMs: number; text?: string; label?: string }>
): { beats: PlanBeat[]; ops: MotionOp[]; sceneElements: Array<Record<string, unknown>> } {
  const vertical = orientation === "vertical";
  const total = Math.max(3000, Math.min(60000, Math.round(durationMs)));
  const parts = brief
    .split(/\s*(?:then|and then|next|finally)\s+|\.\s+|;\s+|!\s+|\?\s+/i)
    .map((part) => part.trim().replace(/[.?!;]+$/, ""))
    .filter((part) => part.length > 0)
    .slice(0, 8);
  const pinnedSteps =
    Array.isArray(pins) && pins.length > 0
      ? pins.slice(0, 12).map((pin, index) => ({
          sentence: (typeof pin.text === "string" && pin.text.trim()) || parts[index % Math.max(1, parts.length)] || brief.trim() || "signature entrance",
          pin
        }))
      : null;
  const steps = pinnedSteps ? pinnedSteps.map((step) => step.sentence) : parts.length > 0 ? parts : [brief.trim() || "signature entrance"];
  const windowMs = Math.floor(total / steps.length);
  const beats: PlanBeat[] = [];
  const ops: MotionOp[] = [];
  const sceneElements: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const SCENES: Array<{ match: RegExp; key: string; element: Record<string, unknown> }> = [
    // Explicit "network" casts before thematic CRM guesses sharing the sentence.
    { match: /\bnetwork\b/, key: "plan-network-explicit", element: { kind: "network", count: 120 } },
    // The one system converges into the orb identity, never a dashboard.
    { match: /\bsystem\b|platform|transform|become|converge|unif|together/, key: "plan-system", element: { kind: "orb", count: 72 } },
    { match: /\borb\b/, key: "plan-orb", element: { kind: "orb", count: 72 } },
    { match: /\bcrm\b|leads?|customers?|prospects?|clients?|buyers?|accounts?/, key: "plan-crm", element: { kind: "crm" } },
    { match: /\bsources?|scattered|everywhere|inbox|emails?|messages?/, key: "plan-sources", element: { kind: "network", count: 120 } },
    { match: /notebook|research|context|intelligence|plan|strategy|\bknow/, key: "plan-notebook", element: { kind: "notebook", text: "CONTEXT" } },
    { match: /workflow|pipeline|process|steps?|stages?|automat|agents?|move|forward/, key: "plan-workflow", element: { kind: "workflow" } },
    { match: /network|nodes?|graph/, key: "plan-network", element: { kind: "network", count: 120 } },
    { match: /hero|title|headline|finale|waves\b/, key: "plan-hero", element: { kind: "title", large: true, eyebrow: "WAVES", text: "Motion" } },
    { match: /cards?|grid|row/, key: "plan-cards", element: { kind: "cards", count: 3 } },
    { match: /text|words?|caption|message/, key: "plan-text", element: { kind: "text", text: "Motion" } }
  ];
  // Mount key per step, resolved up front so each op knows whether the next
  // beat hands off to a different mount (crossfade) or reuses this one.
  const stepKeys = steps.map((sentence) => SCENES.find((candidate) => candidate.match.test(sentence.toLowerCase()))?.key);
  const stepSpan = (index: number): number => {
    const pinnedStep = pinnedSteps ? pinnedSteps[index].pin : undefined;
    const following = pinnedSteps ? pinnedSteps[index + 1]?.pin.startMs : undefined;
    const begin = pinnedStep ? Math.max(0, Math.min(total, Math.round(pinnedStep.startMs))) : index * windowMs;
    if (pinnedStep) return Math.max(800, (typeof following === "number" ? following : total) - begin);
    return index === steps.length - 1 ? total - begin : windowMs;
  };
  steps.forEach((sentence, index) => {
    const pinned = pinnedSteps ? pinnedSteps[index].pin : undefined;
    const start = pinned ? Math.max(0, Math.min(total, Math.round(pinned.startMs))) : index * windowMs;
    const span = stepSpan(index);
    const found = SCENES.find((candidate) => candidate.match.test(sentence.toLowerCase()));
    const nextKey = index + 1 < steps.length ? stepKeys[index + 1] : undefined;
    let target = "*";
    let scene: Record<string, unknown> | null = null;
    if (found && !seen.has(found.key)) {
      seen.add(found.key);
      scene = { key: found.key, act: sceneElements.length + 1, ...(vertical ? { layout: "reel" } : {}), ...found.element };
      // Procedural scene data from the narration itself: entities populate
      // rows, chains, and signals instead of generic filler.
      const entities = extractEntities(sentence);
      if (scene.kind === "crm") scene.rows = crmRowsFor(entities);
      else if (scene.kind === "workflow") {
        const items = workflowItemsFor(entities);
        if (items) scene.items = items;
      } else if (scene.kind === "notebook") {
        const signal = notebookSignalFor(entities);
        if (signal) scene.signal = signal;
      }
      sceneElements.push(scene);
      target = `#lab-scene-${found.key}`;
    } else if (found) {
      target = `#lab-scene-${found.key}`;
    }
    const behavior = mapBehavior(sentence);
    const hasFeel = /snappy|soft|subtle|gentle|calm|spring|bouncy|fast|slow|dramatic|bold|tighter/i.test(sentence);
    const feel = hasFeel ? mapFeel(sentence) : null;
    const staggerMatch = sentence.match(/stagger\s*(?:to|of|:)?\s*(\d+)\s*ms?/i);
    const durationMatch = sentence.match(/duration\s*(?:to|of|:)?\s*(\d+)\s*ms?/i);
    // Emphasis heuristic: exclamation and urgency words land faster/harder.
    const intensity = /!|urgent|now|immediately|critical|must/i.test(sentence) ? 0.85 : 0.5;
    const explicitDuration = durationMatch ? Number(durationMatch[1]) : null;
    // Morph treatment: mount targets with a handoff ahead get enter-hold-exit
    // spans that dissolve through the next mount's enter. Explicit durations
    // and non-mount targets keep today's exact behavior.
    const canMorph =
      explicitDuration === null && found && target !== "*" && nextKey !== undefined && nextKey !== found.key;
    const nextIntensity = index + 1 < steps.length && /!|urgent|now|immediately|critical|must/i.test(steps[index + 1]) ? 0.85 : 0.5;
    const overlap = canMorph
      ? Math.min(1400, Math.round(enterMsFor(stepSpan(index + 1), nextIntensity) + 500))
      : 0;
    const morph = morphSpan(span, overlap, intensity, canMorph ? enterMsFor(stepSpan(index + 1), nextIntensity) : 0);
    const kind = String(found?.element?.kind ?? "box");
    const enterOverride = Object.keys(behavior.properties).length > 0 ? behavior.properties : null;
    const properties = canMorph
      ? morphProperties(kind, target, morph, enterOverride)
      : Object.keys(behavior.properties).length > 0
        ? behavior.properties
        : { y: [24, 0], opacity: [0, 1] };
    const op: Record<string, unknown> = {
      id: nextId("plan"),
      kind: "animate",
      target,
      properties,
      options: {
        delay: start,
        duration: explicitDuration ?? (canMorph ? morph.duration : Math.min(span, 2500)),
        ...(behavior.preset && Object.keys(behavior.properties).length === 0 ? { origin: behavior.preset } : {}),
        ...(feel ? { easing: "waves-spring", spring: feel.spring } : { easing: "waves-entrance" }),
        ...(staggerMatch ? { stagger: Number(staggerMatch[1]), staggerFrom: "first" } : {}),
        ...(behavior.staggerFrom && !staggerMatch ? { staggerFrom: behavior.staggerFrom } : {})
      }
    };
    ops.push(op as MotionOp);
    // Children cascade while the mount is still landing (not after it), so
    // rows, lines, and dots resolve through the entrance — no empty stage.
    // Mount-only targets ("*") and non-film kinds resolve to no cascade.
    if (target !== "*") {
      const cascade = cascadeFor(String(found?.element?.kind ?? "box"), target, start + Math.round(morph.enter * morph.duration * 0.5), nextId("plan"));
      if (cascade) ops.push(cascade);
    }
    // Headlines resolve glyph by glyph through the mount's own entrance.
    if (canMorph && (kind === "title" || kind === "hero")) {
      ops.push({
        id: nextId("plan"),
        kind: "text",
        target: `${target} .lab-scene-title`,
        duration: Math.max(300, Math.min(900, Math.round(span * 0.3))),
        delay: start + 80,
        stagger: 40,
        easing: "waves-entrance"
      } as MotionOp);
    }
    beats.push({
      name: `beat-${index + 1}`,
      intent: sentence,
      scene,
      op,
      ...(pinned?.label ? { label: pinned.label } : {}),
      startMs: start
    });
  });
  // One shared scene op when the plan introduces targets.
  const full: MotionOp[] = [];
  if (sceneElements.length > 0) {
    full.push({ id: nextId("scene"), kind: "scene", scene: { elements: sceneElements as never } });
  }
  for (const op of ops) full.push(op);
  return { beats, ops: full, sceneElements };
}

/** Technique ledger — provenance for adapted external techniques. */
export interface TechniqueRecord {
  id: string;
  sourceKind: string;
  sourceRef: string;
  url?: string;
  license: string;
  what: string;
  adaptedTo: string;
  compatibility: string;
  recordedAt: string;
}

const KNOWN_GOOD_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "Unlicense", "WAVES-internal"];

function ledgerPath(paths: StorePaths): string {
  return join(paths.labDir, ".motion", "techniques.json");
}

export function readLedger(paths: StorePaths): TechniqueRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(paths), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as TechniqueRecord[]) : [];
  } catch {
    return [];
  }
}

function writeLedger(paths: StorePaths, records: TechniqueRecord[]): void {
  mkdirSync(join(paths.labDir, ".motion"), { recursive: true });
  writeFileSync(ledgerPath(paths), JSON.stringify(records, null, 2));
}

/** Group transcribed words into time segments (~5s each) for beat planning. */
function wordsToSegments(words: Array<{ text: string; startMs: number; endMs: number }>): Array<{ index: number; startMs: number; endMs: number; text: string }> {
  if (words.length === 0) return [];
  const targetMs = 5000;
  const total = words[words.length - 1].endMs;
  const count = Math.max(1, Math.min(12, Math.round(total / targetMs) || 1));
  const per = Math.ceil(words.length / count);
  const segments: Array<{ index: number; startMs: number; endMs: number; text: string }> = [];
  for (let index = 0; index < count; index++) {
    const slice = words.slice(index * per, (index + 1) * per);
    if (slice.length === 0) continue;
    segments.push({
      index,
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      text: slice.map((word) => word.text).join(" ")
    });
  }
  return segments;
}

interface EnergySamples {
  durationMs: number;
  energy: number[];
}

/** Decode audio energy per 100ms window: WAV natively, anything else via local ffmpeg. */
function decodeEnergy(audioPath: string): EnergySamples {
  const raw = readFileSync(audioPath);
  const asWav = audioPath.toLowerCase().endsWith(".wav") ? decodeWav(raw) : null;
  const pcm = asWav ?? decodeWithFfmpeg(audioPath);
  const windowSize = Math.max(1, Math.floor(pcm.sampleRate / 10));
  const energy: number[] = [];
  for (let offset = 0; offset < pcm.samples.length; offset += windowSize) {
    let sum = 0;
    const end = Math.min(pcm.samples.length, offset + windowSize);
    for (let index = offset; index < end; index++) sum += pcm.samples[index] * pcm.samples[index];
    energy.push(Math.sqrt(sum / Math.max(1, end - offset)));
  }
  return { durationMs: Math.round((pcm.samples.length / pcm.sampleRate) * 1000), energy };
}

function decodeWav(raw: Buffer): { sampleRate: number; samples: Float32Array } | null {
  try {
    if (raw.toString("ascii", 0, 4) !== "RIFF" || raw.toString("ascii", 8, 12) !== "WAVE") return null;
    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    let dataAt = -1;
    let dataLen = 0;
    while (offset + 8 <= raw.length) {
      const id = raw.toString("ascii", offset, offset + 4);
      const size = raw.readUInt32LE(offset + 4);
      if (id === "fmt ") {
        sampleRate = raw.readUInt32LE(offset + 12);
        channels = raw.readUInt16LE(offset + 10);
        bits = raw.readUInt16LE(offset + 22);
      } else if (id === "data") {
        dataAt = offset + 8;
        dataLen = size;
      }
      offset += 8 + size + (size % 2);
    }
    if (!sampleRate || !channels || dataAt < 0) return null;
    const bytesPerSample = bits / 8 || 2;
    const frames = Math.floor(dataLen / (bytesPerSample * channels));
    const samples = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      let value = 0;
      for (let channel = 0; channel < channels; channel++) {
        const at = dataAt + (frame * channels + channel) * bytesPerSample;
        value += bits === 16 ? raw.readInt16LE(at) / 32768 : raw.readInt8(at) / 128;
      }
      samples[frame] = value / channels;
    }
    return { sampleRate, samples };
  } catch {
    return null;
  }
}

function decodeWithFfmpeg(audioPath: string): { sampleRate: number; samples: Float32Array } {
  try {
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", audioPath, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024
    }) as Buffer;
    const samples = new Float32Array(raw.length / 2);
    for (let index = 0; index < samples.length; index++) samples[index] = raw.readInt16LE(index * 2) / 32768;
    return { sampleRate: 16000, samples };
  } catch {
    throw new Error("Cannot decode this audio format: no WAV header and no local ffmpeg available.");
  }
}

export function buildTools(paths: StorePaths): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
  const state = () => readState(paths);

  const inspect_animation = {
    definition: {
      name: "inspect_animation",
      description:
        "Inspect the current Lab animation state: every op, revision, saved animation library, validation summary, and the live engine catalogue (presets, easings, springs, tokens). Call this first when asked to change motion, or with an op id to focus one animation.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Optional op id to focus." } }
      }
    },
    handler: (args: Record<string, unknown>) => {
      const current = state();
      const id = str(args.id);
      const ops = id ? current.ops.filter((op) => op.id === id) : current.ops;
      if (id && ops.length === 0) throw new Error(`Unknown op id "${id}".`);
      return {
        ok: true,
        revision: current.revision,
        updatedAt: current.updatedAt,
        ops: ops.map((op) => ({ ...op, code: codeForOp(op) })),
        savedAnimations: listSavedAnimations(paths).map((entry) => ({
          name: entry.name,
          description: entry.description,
          opCount: entry.opCount,
          opIds: entry.opIds
        })),
        techniques: readLedger(paths).map((entry) => ({
          id: entry.id,
          source: `${entry.sourceKind}:${entry.sourceRef}`,
          license: entry.license,
          what: entry.what
        })),
        validation: validateAll(current.ops),
        catalogue: catalogueSnapshot()
      };
    }
  };

  const inspect_target = {
    definition: {
      name: "inspect_target",
      description:
        "Inspect a target project: source files, existing @waves/motion usage, available selectors/ids/hooks, and which Lab op targets match. The AI calls this before designing motion so it never guesses what elements exist.",
      inputSchema: {
        type: "object",
        properties: {
          projectRoot: {
            type: "string",
            description: "Directory to scan. Defaults to the workspace root. Use the target website root when animating a real site."
          }
        }
      }
    },
    handler: (args: Record<string, unknown>) => {
      const root = str(args.projectRoot, paths.root);
      const current = state();
      const opTargets = current.ops.flatMap((op) => {
        if (op.kind === "animate" || op.kind === "preset" || op.kind === "scroll" || op.kind === "text") return [op.target];
        if (op.kind === "timeline") return op.nodes.map((node) => node.target);
        return [];
      });
      return { ok: true, ...inspectTarget(root, opTargets) };
    }
  };

  const create_animation = {
    definition: {
      name: "create_animation",
      description:
        "Create an animation from intent. Give a target plus any of: behavior (e.g. 'sequential entrance'), explicit properties, stagger, feel (e.g. 'subtle spring'), easing, duration, delay. Translates to correct engine ops and returns the website code.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "CSS selector or element reference, e.g. '.hero-card'." },
          behavior: { type: "string", description: "Intent: 'sequential entrance', 'fade', 'rise', preset name, or orb-origin transitions ('emerge from orb', 'dissolve to orb', 'orb disperse', 'orb pulse')." },
          properties: { type: "object", description: "Explicit properties, e.g. { y: [12, 0], opacity: [0, 1] }." },
          duration: { type: "number" },
          delay: { type: "number" },
          stagger: { type: "number", description: "Per-target delay in ms for multi-target entrances." },
          staggerFrom: { type: "string", description: "first | last | center | edges | random." },
          feel: { type: "string", description: "Feel words: 'subtle spring', 'snappy', 'soft', 'signature'." },
          easing: { type: "string" },
          spring: { type: "object", description: "{ stiffness, damping, mass } — overrides the feel mapping." },
          scene: { type: "object", description: "{ elements: [{ key, kind: cards|hero|box|text, count?, text? }] } to materialize preview targets." }
        },
        required: ["target"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const target = str(args.target);
      if (!target) throw new Error("create_animation requires a target selector.");
      const behavior = mapBehavior(str(args.behavior) || undefined);
      const feelName = str(args.feel);
      const feel = mapFeel(feelName || undefined);
      const explicit = props(args.properties);
      const explicitSpring = springInput(args.spring);
      const explicitEasing = str(args.easing);
      // A spring request (or explicit easing) cannot ride the runPreset path —
      // the runtime expands presets with house physics only. Expand to an
      // animate op so the physics the AI promised is the physics executed.
      const wantsSpring = explicitSpring ?? (feelName.toLowerCase().includes("spring") ? feel.spring : undefined);
      const usePreset = Object.keys(explicit).length === 0 && behavior.preset && !wantsSpring && !explicitEasing;
      // Orb-origin behaviors carry their stagger ordering when the caller gives none.
      const stagger = num(args.stagger) ?? behavior.stagger;
      const staggerFrom = str(args.staggerFrom) || behavior.staggerFrom || "";
      const ops: MotionOp[] = [];
      const scene = asRecord(args.scene);
      if (Array.isArray(scene.elements) && scene.elements.length > 0) {
        ops.push({ id: nextId("scene"), kind: "scene", scene: { elements: scene.elements as never } });
      }
      let op: MotionOp;
      if (usePreset) {
        op = {
          id: nextId("op"),
          kind: "preset",
          preset: behavior.preset as string,
          target,
          options: {
            ...(num(args.duration) !== undefined ? { duration: num(args.duration) as number } : {}),
            ...(num(args.delay) !== undefined ? { delay: num(args.delay) as number } : {}),
            ...(stagger !== undefined ? { stagger } : {}),
            ...(staggerFrom ? { staggerFrom } : {}),
            ...(str(args.easing) ? { easing: str(args.easing) } : {})
          }
        };
      } else {
        const fallback = { y: [12, 0], opacity: [0, 1] };
        const behaviorProps = Object.keys(behavior.properties).length > 0 ? behavior.properties : null;
        const properties =
          Object.keys(explicit).length > 0
            ? explicit
            : (behaviorProps ?? (behavior.preset ? (buildPresetProperties(behavior.preset, target, {}) ?? fallback) : fallback));
        const spring = wantsSpring ?? (Object.keys(explicit).length > 0 && !explicitEasing ? feel.spring : undefined);
        op = {
          id: nextId("op"),
          kind: "animate",
          target,
          properties,
          options: {
            ...(behavior.preset && Object.keys(explicit).length === 0 ? { origin: behavior.preset } : {}),
            ...(num(args.duration) !== undefined ? { duration: num(args.duration) as number } : {}),
            ...(num(args.delay) !== undefined ? { delay: num(args.delay) as number } : {}),
            ...(explicitEasing ? { easing: explicitEasing } : spring ? { easing: "waves-spring" } : {}),
            ...(spring ? { spring } : {}),
            ...(stagger !== undefined ? { stagger } : {}),
            ...(staggerFrom ? { staggerFrom } : {})
          }
        };
      }
      ops.push(op);
      const current = commit(paths, [...state().ops, ...ops]);
      const validation = validateOp(op);
      return {
        ok: validation.ok,
        op,
        scene: ops.length > 1 ? ops[0] : undefined,
        intent: { behavior: behavior.note, feel: feel.note },
        code: codeForOp(op),
        validation,
        revision: current.revision,
        preview: PREVIEW_URL
      };
    }
  };

  const modify_animation = {
    definition: {
      name: "modify_animation",
      description:
        "Adjust a created animation by op id: duration, delay, stagger, easing, feel, spring, properties, target, or behavior. Re-validates and returns the updated op plus website code.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          patch: {
            type: "object",
            description: "{ duration, delay, stagger, staggerFrom, easing, feel, spring, properties, target, behavior, preset }"
          }
        },
        required: ["id", "patch"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const id = str(args.id);
      const patch = props(args.patch);
      const current = state();
      const existing = findOp(current, id);
      if (!existing) throw new Error(`Unknown op id "${id}".`);
      const next = patchOp(existing, patch);
      const ops = current.ops.map((op) => (op.id === id ? next : op));
      const committed = commit(paths, ops);
      const validation = validateOp(next);
      return { ok: validation.ok, op: next, code: codeForOp(next), validation, revision: committed.revision };
    }
  };

  const create_timeline = {
    definition: {
      name: "create_timeline",
      description:
        "Sequence multiple steps deterministically: each item pins to an order, an absolute time (at), or a dependency (after a label). Computes the layout (starts + total) the same way the runtime does.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          items: {
            type: "array",
            description: "Ordered steps: { target, behavior|preset|properties, at?, after?, stagger?, duration?, easing?, feel? }",
            items: { type: "object" }
          },
          scene: { type: "object" }
        },
        required: ["items"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const rawItems = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
      if (rawItems.length === 0) throw new Error("create_timeline requires at least one item.");
      const nodes: Extract<MotionOp, { kind: "timeline" }>["nodes"] = rawItems.map((item, index) => {
        const behavior = mapBehavior(str(item.behavior || item.preset) || undefined);
        const feelName = str(item.feel);
        const feel = feelName ? mapFeel(feelName) : null;
        const itemExplicit = props(item.properties);
        const itemBehaviorProps = Object.keys(behavior.properties).length > 0 ? behavior.properties : null;
        return {
          target: str(item.target, `*`),
          ...(behavior.preset && Object.keys(itemExplicit).length === 0 ? { preset: behavior.preset } : {}),
          ...(Object.keys(itemExplicit).length > 0 ? { properties: itemExplicit } : itemBehaviorProps ? { properties: itemBehaviorProps } : {}),
          label: str(item.label, `step-${index}`),
          ...(num(item.at) !== undefined ? { at: num(item.at) as number } : {}),
          ...(str(item.after) ? { after: str(item.after) } : {}),
          ...(num(item.stagger) !== undefined ? { stagger: num(item.stagger) as number } : {}),
          ...(num(item.duration) !== undefined ? { duration: num(item.duration) as number } : {}),
          ...(str(item.easing) ? { easing: str(item.easing) } : feel ? { easing: "waves-spring" } : {})
        };
      });
      const ops: MotionOp[] = [];
      const scene = asRecord(args.scene);
      if (Array.isArray(scene.elements) && scene.elements.length > 0) {
        ops.push({ id: nextId("scene"), kind: "scene", scene: { elements: scene.elements as never } });
      }
      const op: Extract<MotionOp, { kind: "timeline" }> = {
        id: nextId("tl"),
        kind: "timeline",
        ...(str(args.label) ? { label: str(args.label) } : {}),
        nodes
      };
      ops.push(op);
      const current = commit(paths, [...state().ops, ...ops]);
      const validation = validateOp(op);
      const simulated = testOps([op]);
      return {
        ok: validation.ok,
        op,
        layout: simulated.spans[0],
        code: codeForOp(op),
        validation,
        revision: current.revision,
        preview: PREVIEW_URL
      };
    }
  };

  const apply_preset = {
    definition: {
      name: "apply_preset",
      description: "Apply one named catalogue preset (rise, fade, cascade, magnetic, ...) to a target. Fails loudly on unknown preset names.",
      inputSchema: {
        type: "object",
        properties: {
          preset: { type: "string" },
          target: { type: "string" },
          params: { type: "object" },
          stagger: { type: "number" },
          scene: { type: "object" }
        },
        required: ["preset", "target"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const preset = str(args.preset);
      const target = str(args.target);
      if (!preset) throw new Error("apply_preset requires a preset name.");
      if (!target) throw new Error("apply_preset requires a target selector.");
      const ops: MotionOp[] = [];
      const scene = asRecord(args.scene);
      if (Array.isArray(scene.elements) && scene.elements.length > 0) {
        ops.push({ id: nextId("scene"), kind: "scene", scene: { elements: scene.elements as never } });
      }
      const op: MotionOp = {
        id: nextId("op"),
        kind: "preset",
        preset,
        target,
        ...(Object.keys(props(args.params)).length > 0 ? { params: props(args.params) } : {}),
        ...(num(args.stagger) !== undefined ? { options: { stagger: num(args.stagger) as number } } : {})
      };
      ops.push(op);
      const current = commit(paths, [...state().ops, ...ops]);
      const validation = validateOp(op);
      return { ok: validation.ok, op, code: codeForOp(op), validation, revision: current.revision, preview: PREVIEW_URL };
    }
  };

  const add_stagger = {
    definition: {
      name: "add_stagger",
      description: "Set stagger binding on an animate/preset/text op: per-target delay plus ordering origin (first, last, center, edges, random).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          delay: { type: "number", description: "Milliseconds between consecutive targets." },
          from: { type: "string", description: "first | last | center | edges | random." }
        },
        required: ["id", "delay"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const delay = num(args.delay);
      if (delay === undefined) throw new Error("add_stagger requires a numeric delay.");
      return (buildToolsRef.modify as ToolHandler)({ id: str(args.id), patch: { stagger: delay, ...(str(args.from) ? { staggerFrom: str(args.from) } : {}) } });
    }
  };

  const add_spring = {
    definition: {
      name: "add_spring",
      description: "Give an animate op spring physics: either a house spring preset (waves, snappy, deliberate, signature) or an explicit { stiffness, damping, mass } config.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          preset: { type: "string", description: "waves | snappy | deliberate | signature." },
          config: { type: "object", description: "{ stiffness, damping, mass }." }
        },
        required: ["id"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const presetName = str(args.preset).toLowerCase();
      const presets: Record<string, string> = { waves: "house default", snappy: "snappy", deliberate: "deliberate", signature: "signature" };
      if (!str(args.preset) && !args.config) throw new Error("add_spring requires a preset or a config.");
      if (str(args.preset) && !presets[presetName]) {
        throw new Error(`Unknown spring preset "${str(args.preset)}" — use waves, snappy, deliberate, or signature.`);
      }
      const feel = str(args.preset) ? mapFeel(presetName === "waves" ? "subtle spring" : presetName) : null;
      const spring = springInput(args.config) ?? feel?.spring;
      const current = readState(paths);
      const existing = findOp(current, str(args.id));
      if (!existing) throw new Error(`Unknown op id "${str(args.id)}".`);
      if (existing.kind === "preset") {
        // runPreset expands with house physics only, so a spring request
        // converts the op to its animate equivalent — same motion, honest physics.
        const expanded = buildPresetProperties(existing.preset, existing.target, existing.params ?? {});
        if (!expanded) throw new Error(`Unknown preset "${existing.preset}".`);
        const next: MotionOp = {
          id: existing.id,
          kind: "animate",
          target: existing.target,
          properties: expanded,
          options: { ...existing.options, origin: existing.preset, easing: "waves-spring", ...(spring ? { spring } : {}) }
        };
        const committed = commit(paths, current.ops.map((op) => (op.id === next.id ? next : op)));
        const validation = validateOp(next);
        return {
          ok: validation.ok,
          op: next,
          convertedFrom: "preset",
          code: codeForOp(next),
          validation,
          revision: committed.revision
        };
      }
      return (buildToolsRef.modify as ToolHandler)({
        id: str(args.id),
        patch: {
          easing: "waves-spring",
          ...(spring ? { spring } : {})
        }
      });
    }
  };

  const add_scroll_motion = {
    definition: {
      name: "add_scroll_motion",
      description: "Bind motion to scroll position (scrubbed, deterministic): target plus optional properties, window (start/end), and easing.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          properties: { type: "object" },
          start: { type: ["string", "number"] },
          end: { type: ["string", "number"] },
          easing: { type: "string" },
          scene: { type: "object" }
        },
        required: ["target"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const target = str(args.target);
      if (!target) throw new Error("add_scroll_motion requires a target selector.");
      const ops: MotionOp[] = [];
      const scene = asRecord(args.scene);
      if (Array.isArray(scene.elements) && scene.elements.length > 0) {
        ops.push({ id: nextId("scene"), kind: "scene", scene: { elements: scene.elements as never } });
      }
      const start = typeof args.start === "string" || typeof args.start === "number" ? (args.start as string | number) : undefined;
      const end = typeof args.end === "string" || typeof args.end === "number" ? (args.end as string | number) : undefined;
      const op: MotionOp = {
        id: nextId("op"),
        kind: "scroll",
        target,
        properties: Object.keys(props(args.properties)).length > 0 ? props(args.properties) : { y: [40, 0], opacity: [0.2, 1] },
        options: {
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
          ...(str(args.easing) ? { easing: str(args.easing) } : { easing: "waves-smooth" })
        }
      };
      ops.push(op);
      const current = commit(paths, [...state().ops, ...ops]);
      const validation = validateOp(op);
      return { ok: validation.ok, op, code: codeForOp(op), validation, revision: current.revision, preview: PREVIEW_URL };
    }
  };

  const add_text_motion = {
    definition: {
      name: "add_text_motion",
      description: "Reveal text by splitting the headline into chars and staggering through the core path (v1 has no separate text module — this is the canonical composition).",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Headline selector whose children split into .char spans." },
          stagger: { type: "number" },
          duration: { type: "number" },
          easing: { type: "string" },
          scene: { type: "object" }
        },
        required: ["target"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const target = str(args.target);
      if (!target) throw new Error("add_text_motion requires a target selector.");
      const ops: MotionOp[] = [];
      const scene = asRecord(args.scene);
      if (Array.isArray(scene.elements) && scene.elements.length > 0) {
        ops.push({ id: nextId("scene"), kind: "scene", scene: { elements: scene.elements as never } });
      }
      const op: MotionOp = {
        id: nextId("op"),
        kind: "text",
        target,
        ...(num(args.stagger) !== undefined ? { stagger: num(args.stagger) as number } : { stagger: 40 }),
        ...(num(args.duration) !== undefined ? { duration: num(args.duration) as number } : {}),
        ...(str(args.easing) ? { easing: str(args.easing) } : {})
      };
      ops.push(op);
      const current = commit(paths, [...state().ops, ...ops]);
      const validation = validateOp(op);
      return { ok: validation.ok, op, code: codeForOp(op), validation, revision: current.revision, preview: PREVIEW_URL };
    }
  };

  const preview_animation = {
    definition: {
      name: "preview_animation",
      description: "Publish current state to the black runtime surface. Returns the localhost preview URL plus revision and op count. Open the URL to watch the engine render.",
      inputSchema: { type: "object", properties: {} }
    },
    handler: () => {
      const current = state();
      const republished = commit(paths, current.ops);
      return { ok: true, url: PREVIEW_URL, revision: republished.revision, ops: republished.ops.length, updatedAt: republished.updatedAt };
    }
  };

  const test_animation = {
    definition: {
      name: "test_animation",
      description: "Deterministically simulate the animation (whole state or one op id): spans, totals, property costs, spring verdicts, reduced-motion behavior. No browser needed.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Optional op id to simulate alone." } }
      }
    },
    handler: (args: Record<string, unknown>) => {
      const current = state();
      const id = str(args.id);
      const ops = id ? current.ops.filter((op) => op.id === id) : current.ops;
      if (id && ops.length === 0) throw new Error(`Unknown op id "${id}".`);
      return { revision: current.revision, ...testOps(ops) };
    }
  };

  const validate_animation = {
    definition: {
      name: "validate_animation",
      description: "Validate the animation (whole state or one op id) against the live engine catalogue: presets, properties, easings, timings, timeline labels, spring guardrails. Returns errors and warnings.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Optional op id to validate alone." } }
      }
    },
    handler: (args: Record<string, unknown>) => {
      const current = state();
      const id = str(args.id);
      const ops = id ? current.ops.filter((op) => op.id === id) : current.ops;
      if (id && ops.length === 0) throw new Error(`Unknown op id "${id}".`);
      return { revision: current.revision, ...validateAll(ops) };
    }
  };

  const apply_instruction = {
    definition: {
      name: "apply_instruction",
      description:
        "Apply a plain-language instruction to the current animation (e.g. 'make the cards stagger 200ms and make the spring softer', 'load the premium hero', 'replay'). Deterministically maps explicit parameters to engine patches, validates before publishing, and publishes on success. Returns understood:false with guidance when the instruction maps to nothing.",
      inputSchema: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "Plain-language change request." }
        },
        required: ["instruction"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const text = str(args.instruction);
      if (!text) throw new Error("apply_instruction requires an instruction string.");
      const lowered = text.toLowerCase();
      const saved = listSavedAnimations(paths);
      const normalized = (value: string) => value.toLowerCase().replace(/[-_]+/g, " ").trim();
      const named = saved.find((entry) => normalized(lowered).includes(normalized(entry.name)));

      // Load / select a saved animation by name.
      if (/\b(load|select|show|open|restore|switch to)\b/.test(lowered) || (named && /\b(play|preview)\b/.test(lowered))) {
        const pick =
          named ??
          (saved.length === 1 && /\b(load|select|show|open|restore|switch to|animation)\b/.test(lowered) ? saved[0] : undefined);
        if (!pick) {
          return {
            ok: false,
            understood: false,
            action: "none",
            reply: `No saved animation matches. Available: ${saved.map((entry) => entry.name).join(", ") || "none"}.`,
            validation: validateAll(state().ops),
            revision: state().revision
          };
        }
        const committed = commit(paths, pick.ops);
        const validation = validateAll(pick.ops);
        return {
          ok: validation.ok,
          understood: true,
          action: "loaded",
          animation: pick.name,
          summary: `Loaded "${pick.name}" (${pick.opCount} ops).`,
          validation,
          revision: committed.revision,
          preview: PREVIEW_URL
        };
      }

      // Replay asks for no state change — the surface replays locally.
      if (/^(replay|play again|play it again|restart|play the animation)\b/.test(lowered.trim())) {
        return { ok: true, understood: true, action: "replay", summary: "Replaying the current animation.", revision: state().revision };
      }

      // Clear the stage.
      if (/\b(clear|remove all|delete all|reset)( the)? animation\b/.test(lowered)) {
        const committed = commit(paths, []);
        return { ok: true, understood: true, action: "cleared", summary: "Cleared all animation ops.", revision: committed.revision, preview: PREVIEW_URL };
      }

      // Parameter modifications over the working set. Section words scope
      // the edit to ops whose target mentions them (crm, notebook, workflow,
      // orb, hero, cards, finale, report, dots, ...); otherwise every
      // animate-class op is a candidate.
      const current = state();
      const SECTION_WORDS = ["crm", "notebook", "workflow", "orb", "hero", "title", "cards", "finale", "report", "mail", "badge", "dots", "network", "pipeline", "deploy", "milestone", "rows", "bar", "context", "stages", "replies", "follow"];
      const sectionHits = SECTION_WORDS.filter((word) => {
        const stem = word.endsWith("s") ? word.slice(0, -1) : word;
        return lowered.includes(word) || lowered.includes(stem);
      });
      let animatable = current.ops.filter((op) => op.kind === "animate" || op.kind === "preset" || op.kind === "text");
      let scopeNote = "";
      if (sectionHits.length > 0) {
        const scoped = animatable.filter((op) => {
          const target = (op as { target?: string }).target ?? "";
          const haystack = target.toLowerCase();
          return sectionHits.some((word) => haystack.includes(word) || haystack.includes(word.endsWith("s") ? word.slice(0, -1) : word));
        });
        if (scoped.length > 0) {
          animatable = scoped;
          scopeNote = ` (scoped to ${scoped.length} op(s) mentioning ${sectionHits.join(", ")})`;
        }
      }
      if (animatable.length === 0) {
        return {
          ok: false,
          understood: false,
          action: "none",
          reply: "There are no animate ops to modify yet. Create one first (e.g. load an animation).",
          validation: validateAll(current.ops),
          revision: current.revision
        };
      }
      const patch: Record<string, unknown> = {};
      const changes: string[] = [];
      const stagger = lowered.match(/stagger\s*(?:to|of|:)?\s*(\d+)\s*ms?/);
      if (stagger) {
        patch.stagger = Number(stagger[1]);
        changes.push(`stagger → ${stagger[1]}ms`);
      }
      const delay = lowered.match(/delay\s*(?:to|of|:)?\s*(\d+)\s*ms?/);
      if (delay) {
        patch.delay = Number(delay[1]);
        changes.push(`delay → ${delay[1]}ms`);
      }
      const duration = lowered.match(/duration\s*(?:to|of|:)?\s*(\d+)\s*ms?/);
      if (duration) {
        patch.duration = Number(duration[1]);
        changes.push(`duration → ${duration[1]}ms`);
      }
      const easing = lowered.match(/easing\s*(?:to|:)?\s*([\w-]+)/);
      if (easing && easingExists(easing[1])) {
        patch.easing = easing[1];
        changes.push(`easing → ${easing[1]}`);
      }
      const dramatic = /dramatic|dramatically|\bbold\b|more\s+presence/.test(lowered);
      const tighter = /\btighter\b|tighten|more\s+compact/.test(lowered);
      if (tighter) {
        changes.push("tighten timing relatively");
      }
      if (dramatic) {
        patch.feel = "snappy";
        changes.push("spring → snappy (dramatic presence)");
      }
      const feel = dramatic
        ? ""
        : /softer|\bsoft\b|\bslower\b|slow (it |them |those )?down/.test(lowered)
        ? "soft"
        : /snappier|\bsnappy\b|sharper|\bfaster\b|quicker|speed (it |them |those )?up/.test(lowered)
          ? "snappy"
          : /subtle|gentle|calm|restrained/.test(lowered)
            ? "subtle spring"
            : /signature|bouncy|playful/.test(lowered)
              ? "signature"
              : "";
      if (feel) {
        patch.feel = feel;
        changes.push(`spring → ${feel}`);
      }
      if (changes.length === 0) {
        return {
          ok: false,
          understood: false,
          action: "none",
          reply: "I couldn't map that to an engine change. Try e.g. 'make the cards stagger 200ms', 'make the spring softer', or 'load the premium hero'.",
          validation: validateAll(current.ops),
          revision: current.revision
        };
      }
      // Stagger edits prefer ops that already stagger; other fields hit every animate op.
      const staggerTargets = animatable.filter((op) => {
        const options = (op as { options?: { stagger?: number } }).options;
        return typeof options?.stagger === "number";
      });
      const targets = patch.stagger !== undefined && staggerTargets.length > 0 ? staggerTargets : animatable;
      // "tighter" tightens relatively: halve stagger (floor 20ms), scale
      // explicit durations ×0.7 (floor 150ms) — computed per op, then patched.
      const perOpPatch = new Map<string, Record<string, unknown>>();
      if (tighter) {
        for (const target of targets) {
          const options = (target as { options?: { stagger?: number; duration?: number } }).options ?? {};
          const individual: Record<string, unknown> = { ...patch };
          if (typeof options.stagger === "number") individual.stagger = Math.max(20, Math.round(options.stagger / 2));
          if (typeof options.duration === "number") individual.duration = Math.max(150, Math.round(options.duration * 0.7));
          perOpPatch.set(target.id, individual);
        }
      }
      const proposed = current.ops.map((op) =>
        targets.some((target) => target.id === op.id) ? patchOp(op, perOpPatch.get(op.id) ?? patch) : op
      );
      const validation = validateAll(proposed);
      if (!validation.ok) {
        return { ok: false, understood: true, action: "rejected", changes, validation, revision: current.revision };
      }
      const committed = commit(paths, proposed);
      const changedOps = targets.map((target) => target.id);
      return {
        ok: true,
        understood: true,
        action: "modified",
        summary: changes.join(", ") + scopeNote,
        ops: changedOps,
        codes: changedOps.map((id) => {
          const op = committed.ops.find((candidate) => candidate.id === id);
          return op ? codeForOp(op) : "";
        }),
        validation,
        revision: committed.revision,
        preview: PREVIEW_URL
      };
    }
  };

  const plan_animation = {
    definition: {
      name: "plan_animation",
      description:
        "Turn a creative brief into an inspectable animation plan: beats, scene atoms, and validated ops — WITHOUT publishing. Review the plan, then publish_plan to ship it. Deterministic; the agent provides understanding, this provides structure.",
      inputSchema: {
        type: "object",
        properties: {
          brief: { type: "string", description: "Creative brief, e.g. 'orb disperses, then three cards emerge'." },
          orientation: { type: "string", description: "landscape (default) or vertical." },
          durationMs: { type: "number", description: "Total plan length in ms (3000–60000, default 20000)." },
          provider: { type: "string", description: "Directing provider id (gpt, claude, gemini)." },
          model: { type: "string", description: "Directing model id (session default unless specified)." },
          segments: { type: "array", description: "Optional pinned beats [{ startMs, text?, label? }] — voiceover-exact timing wins over even distribution.", items: { type: "object" } }
        },
        required: ["brief"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const brief = str(args.brief);
      if (!brief) throw new Error("plan_animation requires a brief string.");
      const orientation = str(args.orientation, "landscape").toLowerCase() === "vertical" ? "vertical" : "landscape";
      const durationMs = num(args.durationMs) ?? 20000;
      const pins = Array.isArray(args.segments)
        ? (args.segments as Array<Record<string, unknown>>).map((segment) => ({
            startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
            ...(typeof segment.text === "string" ? { text: segment.text } : {}),
            ...(typeof segment.label === "string" ? { label: segment.label } : {})
          }))
        : undefined;
      const planned = planBrief(brief, orientation, durationMs, pins);
      const validation = validateAll(planned.ops);
      const slug = brief.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "plan";
      const id = `${slug}-${Date.now().toString(36)}`;
      const provider = str(args.provider, "session").toLowerCase();
      const model = str(args.model, "session-default");
      const record = { id, brief, orientation, durationMs: Math.max(3000, Math.min(60000, Math.round(durationMs))), provider, model, beats: planned.beats, ops: planned.ops, validation, status: "proposed", createdAt: new Date().toISOString() };
      writeFileSync(join(briefsDir(paths), `${id}.json`), JSON.stringify(record, null, 2));
      return { ok: validation.ok, id, provider, model, beats: planned.beats, validation, revision: state().revision, hint: "Review beats, then publish_plan to ship." };
    }
  };

  const publish_plan = {
    definition: {
      name: "publish_plan",
      description: "Publish a proposed plan from plan_animation: re-validates, commits its ops to live state, marks the brief published. Returns the new revision for preview.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Plan id returned by plan_animation." } },
        required: ["id"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const id = str(args.id);
      const file = join(briefsDir(paths), `${id}.json`);
      let record: { ops: MotionOp[]; status: string };
      try {
        record = JSON.parse(readFileSync(file, "utf8")) as { ops: MotionOp[]; status: string };
      } catch {
        throw new Error(`Unknown plan id "${id}".`);
      }
      if (!Array.isArray(record.ops)) throw new Error(`Plan "${id}" has no ops.`);
      const validation = validateAll(record.ops);
      if (!validation.ok) {
        return { ok: false, understood: true, action: "rejected", validation, revision: state().revision };
      }
      const committed = commit(paths, record.ops);
      const updated = { ...(record as Record<string, unknown>), status: "published", publishedRev: committed.revision };
      writeFileSync(file, JSON.stringify(updated, null, 2));
      return { ok: true, id, revision: committed.revision, ops: committed.ops.length, validation, preview: PREVIEW_URL };
    }
  };

  const restore_state = {
    definition: {
      name: "restore_state",
      description:
        "Restore live animation state to an explicit op array (undo primitive): validates first, commits only when clean. Returns the new revision for preview.",
      inputSchema: {
        type: "object",
        properties: {
          ops: { type: "object", description: "Full op array to restore (as returned by inspect_animation)." },
          reason: { type: "string", description: "Why this restore happens, e.g. 'undo stagger change'." }
        },
        required: ["ops"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const ops = Array.isArray(args.ops) ? (args.ops as MotionOp[]) : [];
      const validation = validateAll(ops);
      if (!validation.ok) {
        return { ok: false, understood: true, action: "rejected", validation, revision: state().revision };
      }
      const committed = commit(paths, ops);
      return { ok: true, reason: str(args.reason), revision: committed.revision, ops: committed.ops.length, validation, preview: PREVIEW_URL };
    }
  };

  const record_technique = {
    definition: {
      name: "record_technique",
      description:
        "Record provenance for an externally adapted technique (repo, package, docs, example): source ref, license, what was borrowed, and compatibility verdict. Copyleft/proprietary sources are study-only and rejected for adaptation. Optionally links a reference manifest id under .motion/references/.",
      inputSchema: {
        type: "object",
        properties: {
          sourceKind: { type: "string", description: "repo | package | docs | example | internal" },
          sourceRef: { type: "string", description: "e.g. owner/repo, npm spec, or doc URL" },
          url: { type: "string" },
          license: { type: "string", description: "SPDX id, e.g. MIT. Required." },
          what: { type: "string", description: "What technique/pattern was borrowed (never pasted code)." },
          adaptedTo: { type: "string", description: "Which Motion Lab op/behavior/scene embodies it." },
          compatibility: { type: "string", description: "Why it is compatible with the engine/op model." },
          reference: { type: "string", description: "Optional .motion/references/<id> manifest that must exist with license+consent." }
        },
        required: ["sourceKind", "sourceRef", "license", "what", "adaptedTo", "compatibility"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const sourceKind = str(args.sourceKind).toLowerCase();
      const sourceRef = str(args.sourceRef);
      const license = str(args.license);
      const what = str(args.what);
      const adaptedTo = str(args.adaptedTo);
      const compatibility = str(args.compatibility);
      if (!["repo", "package", "docs", "example", "internal"].includes(sourceKind)) {
        throw new Error(`Unknown sourceKind "${sourceKind}" — use repo, package, docs, example, or internal.`);
      }
      if (!sourceRef || !license || !what || !adaptedTo || !compatibility) {
        throw new Error("record_technique requires sourceKind, sourceRef, license, what, adaptedTo, compatibility.");
      }
      const blocked = ["GPL", "AGPL", "LGPL", "SSPL", "BUSL", "proprietary", "unknown"];
      if (blocked.some((token) => license.toLowerCase().includes(token.toLowerCase())) || license.trim().length === 0) {
        throw new Error(`License "${license}" is study-only (copyleft/proprietary/unknown) — adaptation refused. Record research notes outside the ledger.`);
      }
      if (!KNOWN_GOOD_LICENSES.some((known) => license.toLowerCase().includes(known.toLowerCase()))) {
        throw new Error(`License "${license}" is not in the known-good set (${KNOWN_GOOD_LICENSES.join(", ")}) — confirm terms before adapting.`);
      }
      const reference = str(args.reference);
      if (reference) {
        let manifest: Record<string, unknown>;
        try {
          manifest = JSON.parse(readFileSync(join(paths.labDir, ".motion", "references", reference, "manifest.json"), "utf8")) as Record<string, unknown>;
        } catch {
          throw new Error(`Reference "${reference}" has no manifest at .motion/references/${reference}/manifest.json.`);
        }
        if (typeof manifest.license !== "string" || typeof manifest.consent !== "string" || !manifest.license || !manifest.consent) {
          throw new Error(`Reference "${reference}" manifest must document license and consent.`);
        }
      }
      const records = readLedger(paths);
      const entry: TechniqueRecord = {
        id: `tech-${Date.now().toString(36)}-${records.length + 1}`,
        sourceKind,
        sourceRef,
        ...(str(args.url) ? { url: str(args.url) } : {}),
        license,
        what,
        adaptedTo,
        compatibility,
        recordedAt: new Date().toISOString()
      };
      const db = await openDb(paths.labDir);
      try {
        const indexed = recordTechnique(db.raw, "project_default", {
          sourceKind,
          sourceRef,
          license,
          what,
          adaptedTo: adaptedTo,
          compatibility,
          ledgerId: entry.id
        });
        records.push(entry);
        writeLedger(paths, records);
        return { ok: true, technique: entry, ledgerCount: records.length, indexed: indexed.row.id, indexedNew: indexed.created };
      } finally {
        closeDb(db);
      }
    }
  };

  const ingest_asset = {
    definition: {
      name: "ingest_asset",
      description:
        "Register a pipeline input asset: a repo-relative file that must exist (voiceover audio, reference doc, image, data) or inline text (script/notes, max 1MB) saved under .motion/assets/. Absolute paths and parent escapes are refused.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "voiceover | reference | image | video | script | data." },
          label: { type: "string", description: "Human label, e.g. 'Founder VO take 3'." },
          path: { type: "string", description: "Repo-relative file path that must exist." },
          text: { type: "string", description: "Inline content saved as an asset file (alternative to path)." },
          projectId: { type: "string", description: "Project id (default project_default)." }
        },
        required: ["kind", "label"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const projectId = str(args.projectId, "project_default");
      const kind = str(args.kind).toLowerCase();
      const label = str(args.label).trim();
      if (!label) throw new Error("ingest_asset requires a label.");
      const relPath = str(args.path).replace(/\\/g, "/");
      const text = typeof args.text === "string" ? args.text : "";
      if ((relPath ? 1 : 0) + (text ? 1 : 0) !== 1) {
        throw new Error("ingest_asset needs exactly one of path or text.");
      }
      const db = await openDb(paths.labDir);
      try {
        if (relPath) {
          const resolved = join(paths.labDir, relPath);
          if (!resolved.startsWith(paths.labDir)) throw new Error(`ingest_asset: path "${relPath}" escapes the lab directory.`);
          if (!existsSync(resolved)) throw new Error(`ingest_asset: file "${relPath}" does not exist.`);
          const size = statSync(resolved).size;
          const asset = registerAsset(db.raw, projectId, { kind, label, path: relPath, bytes: 0, meta: { size } });
          return { ok: true, asset };
        }
        if (text.length > 1_000_000) throw new Error("ingest_asset: inline text over 1MB — save it as a file and ingest by path.");
        const fileName = `asset-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}.txt`;
        const stored = join(paths.labDir, ".motion", "assets", fileName);
        mkdirSync(join(paths.labDir, ".motion", "assets"), { recursive: true });
        writeFileSync(stored, text);
        const asset = registerAsset(db.raw, projectId, {
          kind,
          label,
          path: `.motion/assets/${fileName}`,
          bytes: 0,
          meta: { chars: text.length }
        });
        return { ok: true, asset };
      } finally {
        closeDb(db);
      }
    }
  };

  const asset_list = {
    definition: {
      name: "asset_list",
      description: "List registered input assets for a project, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project id (default project_default)." },
          limit: { type: "number", description: "Max rows (default 50, max 200)." }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const projectId = str(args.projectId, "project_default");
      const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || 50)));
      const db = await openDb(paths.labDir);
      try {
        return { ok: true, assets: listAssets(db.raw, projectId, limit) };
      } finally {
        closeDb(db);
      }
    }
  };

  const technique_list = {
    definition: {
      name: "technique_list",
      description: "List the indexed technique ledger for a project, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project id (default project_default)." },
          limit: { type: "number", description: "Max rows (default 50, max 200)." }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const projectId = str(args.projectId, "project_default");
      const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || 50)));
      const db = await openDb(paths.labDir);
      try {
        return { ok: true, techniques: listTechniques(db.raw, projectId, limit) };
      } finally {
        closeDb(db);
      }
    }
  };

  const artifact_list = {
    definition: {
      name: "artifact_list",
      description: "List job output artifacts — by project, optionally filtered to one job or revision.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project id (default project_default)." },
          jobId: { type: "string", description: "Only artifacts from this job." },
          rev: { type: "number", description: "Only artifacts from this revision." },
          limit: { type: "number", description: "Max rows (default 50, max 200)." }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const projectId = str(args.projectId, "project_default");
      const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || 50)));
      const db = await openDb(paths.labDir);
      try {
        if (str(args.jobId)) return { ok: true, artifacts: artifactsForJob(db.raw, str(args.jobId)) };
        const rows = listArtifacts(db.raw, projectId, limit);
        const rev = args.rev === undefined ? undefined : Math.round(Number(args.rev));
        return { ok: true, artifacts: rev === undefined ? rows : rows.filter((row) => row.rev === rev) };
      } finally {
        closeDb(db);
      }
    }
  };

  const create_from_voiceover = {
    definition: {
      name: "create_from_voiceover",
      description:
        "Full voiceover-to-render chain in one call: voiceover asset (or inline transcript/segments) → story → plan → published revision → render job → manifest artifact. Returns every provenance link (asset, rev, job, artifact). Needs transcript/segments unless transcription is configured — never invents narration.",
      inputSchema: {
        type: "object",
        properties: {
          voiceoverId: { type: "string", description: "Registered voiceover id (supplies duration + asset link)." },
          transcript: { type: "string", description: "Narration text (or timed segments)." },
          segments: { type: "array", description: "Timed segments [{ startMs, endMs?, text? }].", items: { type: "object" } },
          durationMs: { type: "number", description: "Total duration (defaults to voiceover length or 20000)." },
          orientation: { type: "string", description: "landscape (default) or vertical." },
          format: { type: "string", description: "mp4 (default) or webm." },
          message: { type: "string", description: "Revision message." },
          projectId: { type: "string", description: "Project id (default project_default)." }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const segments = Array.isArray(args.segments)
        ? args.segments.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
        : undefined;
      const db = await openDb(paths.labDir);
      try {
        const ran = await createFromVoiceover(
          db.raw,
          {
            projectId: str(args.projectId, "project_default") || "project_default",
            voiceoverId: str(args.voiceoverId) || undefined,
            transcript: typeof args.transcript === "string" ? args.transcript : undefined,
            segments: segments?.map((entry) => ({
              startMs: Math.max(0, Math.round(Number(entry.startMs) || 0)),
              endMs: entry.endMs === undefined ? undefined : Math.max(0, Math.round(Number(entry.endMs) || 0)),
              text: typeof entry.text === "string" ? entry.text : undefined
            })),
            durationMs: args.durationMs === undefined ? undefined : Math.round(Number(args.durationMs)),
            orientation: str(args.orientation, "landscape"),
            format: str(args.format, "mp4").toLowerCase() === "webm" ? "webm" : "mp4",
            message: str(args.message) || undefined
          },
          { labDir: paths.labDir, artifactsDir: artifactsDir }
        );
        return {
          ok: true,
          rev: ran.rev,
          revisionId: ran.revisionId,
          fileRevision: ran.fileRevision,
          jobId: ran.jobId,
          assetId: ran.asset?.id ?? null,
          artifactId: ran.artifactId,
          transcript: ran.transcript,
          brief: ran.brief,
          beats: ran.story.beats,
          ops: ran.ops,
          validation: ran.validation,
          durationMs: ran.durationMs,
          orientation: ran.orientation,
          preview: PREVIEW_URL
        };
      } finally {
        closeDb(db);
      }
    }
  };

  const synthesize_voiceover = {    definition: {
      name: "synthesize_voiceover",
      description:
        "Synthesize narration audio for an animation via ElevenLabs (key-gated). Without ELEVENLABS_API_KEY set, refuses cleanly with setup guidance — the pipeline works fully without it. With a key, saves MP3 + sidecar under .motion/voiceovers/ for export muxing. Voice must be an explicit voice ID (param or ELEVENLABS_VOICE_ID); no defaults are fabricated.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Narration script." },
          voice: { type: "string", description: "ElevenLabs voice ID (or set ELEVENLABS_VOICE_ID)." },
          animation: { type: "string", description: "Saved animation this narration belongs to (sidecar reference)." }
        },
        required: ["text"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const text = str(args.text);
      if (!text) throw new Error("synthesize_voiceover requires a text script.");
      if (text.length > 5000) throw new Error("Narration script is limited to 5000 characters.");
      const apiKey = (process.env.ELEVENLABS_API_KEY ?? "").trim();
      if (!apiKey) {
        return {
          ok: false,
          gated: true,
          error: "ElevenLabs is not configured.",
          hint: "Set ELEVENLABS_API_KEY (and optionally ELEVENLABS_VOICE_ID) in the MCP server environment, then retry. All animation tooling works without it."
        };
      }
      const voice = str(args.voice) || (process.env.ELEVENLABS_VOICE_ID ?? "").trim();
      if (!voice) throw new Error("Provide an explicit ElevenLabs voice ID via the voice param or ELEVENLABS_VOICE_ID.");
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" })
      });
      if (!response.ok) {
        throw new Error(`ElevenLabs request failed (HTTP ${response.status}). Check key, voice ID, and quota.`);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) throw new Error("ElevenLabs returned empty audio.");
      const dir = join(paths.labDir, ".motion", "voiceovers");
      mkdirSync(dir, { recursive: true });
      const id = `vo-${Date.now().toString(36)}`;
      writeFileSync(join(dir, `${id}.mp3`), audio);
      const sidecar = {
        id,
        audio: `voiceovers/${id}.mp3`,
        text,
        voice,
        model: "eleven_multilingual_v2",
        animation: str(args.animation) || null,
        bytes: audio.length,
        createdAt: new Date().toISOString()
      };
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(sidecar, null, 2));
      return { ok: true, voiceover: sidecar };
    }
  };

  const analyze_narration = {
    definition: {
      name: "analyze_narration",
      description:
        "Analyze narration into labeled, scene-cast beats — no model calls. Accepts transcript text and/or timestamped segments (e.g. from transcribe_voiceover); keyword casting maps story language onto INTRO/PROBLEM/CRM/DISCOVERY/NOTEBOOK/WORKFLOW/REPORT/FINALE and scene atoms. Feed the beats to plan_animation segments for voiceover-exact timing.",
      inputSchema: {
        type: "object",
        properties: {
          transcript: { type: "string", description: "Full narration text (split into sentences when segments are absent)." },
          segments: { type: "array", description: "Timestamped segments [{ startMs, endMs?, text? }].", items: { type: "object" } },
          durationMs: { type: "number", description: "Total narration length in ms (voiceover duration wins)." }
        }
      }
    },
    handler: (args: Record<string, unknown>) => {
      const segments = Array.isArray(args.segments)
        ? (args.segments as Array<Record<string, unknown>>).map((segment) => ({
            startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
            endMs: segment.endMs === undefined ? 0 : Math.max(0, Math.round(Number(segment.endMs) || 0)),
            text: typeof segment.text === "string" ? segment.text : ""
          }))
        : undefined;
      const durationMs = num(args.durationMs) ?? 20000;
      const beats = analyzeNarration(str(args.transcript), durationMs, segments);
      if (beats.length === 0) throw new Error("analyze_narration needs transcript text or non-empty segments.");
      return { ok: true, beats, count: beats.length };
    }
  };

  const transcribe_voiceover = {    definition: {
      name: "transcribe_voiceover",
      description:
        "Transcribe a voiceover sidecar into timestamped segments via ElevenLabs Scribe (key-gated). Without ELEVENLABS_API_KEY set, refuses cleanly — use detect_beats for keyless structural segmentation instead.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Voiceover sidecar id (vo-*)." }
        },
        required: ["id"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const id = str(args.id).replace(/\.mp3$/, "");
      if (!id) throw new Error("transcribe_voiceover requires a voiceover id.");
      const metaPath = join(paths.labDir, ".motion", "voiceovers", `${id}.json`);
      let sidecar: Record<string, unknown>;
      try {
        sidecar = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      } catch {
        throw new Error(`Unknown voiceover "${id}". Upload one first.`);
      }
      const apiKey = (process.env.ELEVENLABS_API_KEY ?? "").trim();
      if (!apiKey) {
        return {
          ok: false,
          gated: true,
          error: "ElevenLabs is not configured.",
          hint: "Set ELEVENLABS_API_KEY in the MCP server environment for transcription, or use detect_beats for keyless structural beats."
        };
      }
      const audioPath = join(paths.labDir, ".motion", "voiceovers", `${id}.mp3`);
      let audio: Buffer;
      try {
        audio = readFileSync(audioPath);
      } catch {
        throw new Error(`Voiceover audio missing for "${id}".`);
      }
      const boundary = `----motionlab${Date.now().toString(36)}`;
      const preamble = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${id}.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`
      );
      const epilogue = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n--${boundary}--\r\n`);
      const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat([preamble, audio, epilogue])
      });
      if (!response.ok) {
        throw new Error(`ElevenLabs transcription failed (HTTP ${response.status}). Check key and quota.`);
      }
      const transcript = (await response.json()) as { text?: unknown; words?: Array<{ text?: unknown; start?: unknown; end?: unknown }> };
      const words = Array.isArray(transcript.words)
        ? transcript.words
            .filter((word) => typeof word.text === "string")
            .map((word) => ({ text: String(word.text), startMs: Math.round(Number(word.start ?? 0) * 1000), endMs: Math.round(Number(word.end ?? 0) * 1000) }))
        : [];
      const segments = wordsToSegments(words);
      const updated = { ...(sidecar as Record<string, unknown>), transcript: typeof transcript.text === "string" ? transcript.text : "", segments };
      writeFileSync(metaPath, JSON.stringify(updated, null, 2));
      return { ok: true, id, segments, voiceover: updated };
    }
  };

  const detect_beats = {
    definition: {
      name: "detect_beats",
      description:
        "Segment a voiceover into structural beats without any API key: WAV files are decoded natively (PCM energy per window); other formats use a local ffmpeg when available. Returns start/end spans the UI maps onto scenes. Honest signal analysis, not semantics.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Voiceover sidecar id (vo-*)." },
          beats: { type: "number", description: "Target beat count (2–12, default 6)." },
          floorMs: { type: "number", description: "Minimum beat length in ms (default 1500)." }
        },
        required: ["id"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const id = str(args.id).replace(/\.mp3$/, "").replace(/\.(wav|m4a|aac)$/, "");
      if (!id) throw new Error("detect_beats requires a voiceover id.");
      const dir = join(paths.labDir, ".motion", "voiceovers");
      const candidates = [`${id}.wav`, `${id}.mp3`, `${id}.m4a`, `${id}.aac`].map((file) => join(dir, file));
      const audioPath = candidates.find((file) => {
        try {
          readFileSync(file);
          return true;
        } catch {
          return false;
        }
      });
      if (!audioPath) throw new Error(`No audio found for voiceover "${id}".`);
      const wantBeats = Math.max(2, Math.min(12, Math.round(num(args.beats) ?? 6)));
      const floorMs = Math.max(500, num(args.floorMs) ?? 1500);
      const samples = decodeEnergy(audioPath);
      const totalMs = samples.durationMs;
      // Honor the floor: fewer, longer beats rather than clipped ones.
      const effectiveBeats = Math.max(2, Math.min(wantBeats, Math.floor(totalMs / floorMs)));
      const bucket = Math.max(1, Math.floor(samples.energy.length / Math.max(effectiveBeats * 4, 8)));
      const boundaries: number[] = [0];
      for (let index = 1; index < effectiveBeats; index++) {
        boundaries.push(Math.round((totalMs * index) / effectiveBeats));
      }
      boundaries.push(totalMs);
      // Snap interior boundaries to local energy minima so cuts land on pauses.
      for (let index = 1; index < boundaries.length - 1; index++) {
        const center = Math.floor((boundaries[index] / totalMs) * samples.energy.length);
        let best = center;
        let bestEnergy = Number.POSITIVE_INFINITY;
        for (let offset = -bucket; offset <= bucket; offset++) {
          const at = Math.min(samples.energy.length - 1, Math.max(0, center + offset));
          if (samples.energy[at] < bestEnergy) {
            bestEnergy = samples.energy[at];
            best = at;
          }
        }
        const snapped = Math.round((best / samples.energy.length) * totalMs);
        if (snapped - boundaries[index - 1] >= floorMs && boundaries[index + 1] - snapped >= floorMs / 2) {
          boundaries[index] = snapped;
        }
      }
      const labeled = boundaries.slice(0, -1).map((start, index) => ({
        index,
        startMs: start,
        endMs: boundaries[index + 1],
        label: `BEAT ${String(index + 1).padStart(2, "0")}`
      }));
      const metaPath = join(dir, `${id}.json`);
      try {
        const sidecar = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        writeFileSync(metaPath, JSON.stringify({ ...sidecar, segments: labeled }, null, 2));
      } catch {
        /* sidecar update is best-effort */
      }
      return { ok: true, id, durationMs: totalMs, segments: labeled };
    }
  };

  const voiceover_list = {
    definition: {
      name: "voiceover_list",
      description: "List registered voiceovers (metadata only, never bytes): id, file, duration, created time.",
      inputSchema: { type: "object", properties: {} }
    },
    handler: async () => {
      return { ok: true, voiceovers: listVoiceovers(paths.labDir) };
    }
  };

  const voiceover_get = {
    definition: {
      name: "voiceover_get",
      description: "Inspect one voiceover: sidecar metadata plus transcript/segments when present. Never returns audio bytes.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Voiceover sidecar id (vo-*)." } },
        required: ["id"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const { listVoiceovers } = await import("./voiceover.js");
      const id = str(args.id).replace(/\.mp3$/, "").replace(/\.(wav|m4a|aac)$/, "");
      const found = listVoiceovers(paths.labDir).find((entry) => entry.id === id);
      if (!found) throw new Error(`Unknown voiceover "${str(args.id)}". Upload one first.`);
      let transcript = "";
      let segments: unknown[] = [];
      try {
        const sidecar = JSON.parse(readFileSync(join(paths.labDir, ".motion", "voiceovers", `${found.id}.json`), "utf8")) as Record<string, unknown>;
        if (typeof sidecar.transcript === "string") transcript = sidecar.transcript;
        if (Array.isArray(sidecar.segments)) segments = sidecar.segments;
      } catch {
        /* metadata-only fallback */
      }
      return { ok: true, voiceover: found, transcript, segments };
    }
  };

  const build_story = {
    definition: {
      name: "build_story",
      description:
        "Build a validated story from transcript text and/or timed segments: labeled beats with intent, entities, emphasis, intensity, and visual intent. Deterministic; interpretation is explicitly marked. Stores the story; use plan_story (Phase 3) to turn beats into ops.",
      inputSchema: {
        type: "object",
        properties: {
          transcript: { type: "string", description: "Full narration text." },
          voiceoverId: { type: "string", description: "Optional voiceover id to link." },
          segments: { type: "array", description: "Timed segments [{ startMs, endMs?, text? }].", items: { type: "object" } },
          durationMs: { type: "number", description: "Total length in ms (voiceover duration wins when linked)." }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const voiceoverId = str(args.voiceoverId) || null;
      let durationMs = num(args.durationMs) ?? 20000;
      if (voiceoverId) {
        try {
          const meta = JSON.parse(
            readFileSync(join(paths.labDir, ".motion", "voiceovers", `${voiceoverId}.json`), "utf8")
          ) as Record<string, unknown>;
          if (typeof meta.durationMs === "number" && meta.durationMs > 0) durationMs = meta.durationMs;
        } catch {
          throw new Error(`Unknown voiceover "${voiceoverId}". Upload one first.`);
        }
      }
      const segments = Array.isArray(args.segments)
        ? (args.segments as Array<Record<string, unknown>>).map((segment) => ({
            startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
            endMs: segment.endMs === undefined ? 0 : Math.max(0, Math.round(Number(segment.endMs) || 0)),
            text: typeof segment.text === "string" ? segment.text : ""
          }))
        : undefined;
      const story = buildStory(str(args.transcript), durationMs, segments);
      const validation = validateStory(story);
      if (!validation.ok) throw new Error(`Story invalid: ${validation.errors.join("; ")}`);
      const db = await openDb(paths.labDir);
      try {
        if (voiceoverId) {
          db.raw.prepare("INSERT OR IGNORE INTO voiceovers (id, project_id, file, mime, bytes, duration_ms, created_at) VALUES (?, 'project_default', ?, 'audio/mpeg', 0, ?, ?)").run(
            voiceoverId,
            `${voiceoverId}.mp3`,
            durationMs,
            Date.now()
          );
        }
        const id = `story-${Date.now().toString(36)}`;
        db.raw.prepare("INSERT INTO stories (id, project_id, voiceover_id, brief, beats, interpretation, created_at) VALUES (?, 'project_default', ?, ?, ?, ?, ?)").run(
          id,
          voiceoverId,
          str(args.transcript).slice(0, 500),
          JSON.stringify(story.beats),
          story.interpretation,
          Date.now()
        );
        return { ok: true, id, story, validation };
      } finally {
        closeDb(db);
      }
    }
  };

  const plan_story = {
    definition: {
      name: "plan_story",
      description:
        "Turn story beats into canonical animation ops (no publishing): one mount op per visual group with absolute beat timing, single-writer audited, validated. Feed beats from build_story.",
      inputSchema: {
        type: "object",
        properties: {
          beats: { type: "array", description: "Story beats [{ startMs, endMs, narration?, intent?, visualIntent? }].", items: { type: "object" } },
          orientation: { type: "string", description: "landscape (default) or vertical." }
        },
        required: ["beats"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const beats = (Array.isArray(args.beats) ? args.beats : []) as Array<Record<string, unknown>>;
      if (beats.length === 0) throw new Error("plan_story requires a non-empty beats array.");
      const orientation = str(args.orientation, "landscape").toLowerCase() === "vertical" ? "vertical" : "landscape";
      const planned = planStory(
        beats.map((beat, index) => ({
          id: typeof beat.id === "string" ? beat.id : `beat-${String(index + 1).padStart(2, "0")}`,
          startMs: Math.max(0, Math.round(Number(beat.startMs) || 0)),
          endMs: Math.max(0, Math.round(Number(beat.endMs) || 0)),
          narration: typeof beat.narration === "string" ? beat.narration : "",
          intent: typeof beat.intent === "string" ? beat.intent : "beat",
          label: typeof beat.label === "string" && beat.label ? beat.label : typeof beat.intent === "string" && beat.intent ? beat.intent : "beat",
          entities: [],
          emphasis: [],
          intensity: 0.5,
          visualIntent: typeof beat.visualIntent === "string" ? beat.visualIntent : "title"
        })),
        orientation
      );
      return { ok: planned.validation.ok, ops: planned.ops, overlaps: planned.overlaps, validation: planned.validation, hint: "Overlaps must be empty; publish_revision ships." };
    }
  };

  const publish_revision = {
    definition: {
      name: "publish_revision",
      description:
        "Publish ops as a new immutable revision: validates first, rejects stale expectedRevision with a conflict (never silently overwrites), and never publishes invalid ops. Returns the new rev number.",
      inputSchema: {
        type: "object",
        properties: {
          ops: { type: "array", description: "Full op array to publish.", items: { type: "object" } },
          expectedRevision: { type: "number", description: "Current rev you based this on; conflicts reject." },
          message: { type: "string", description: "What this revision changes." },
          projectId: { type: "string", description: "Project id (default project_default)." }
        },
        required: ["ops"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const ops = Array.isArray(args.ops) ? (args.ops as MotionOp[]) : [];
      if (ops.length === 0) throw new Error("publish_revision requires a non-empty ops array.");
      const projectId = str(args.projectId, "project_default");
      const expected = args.expectedRevision === undefined ? undefined : Math.round(Number(args.expectedRevision));
      if (args.expectedRevision !== undefined && !Number.isFinite(expected)) {
        throw new Error("expectedRevision must be a number.");
      }
      const db = await openDb(paths.labDir);
      try {
        const row = publishRevision(db.raw, projectId, ops, {
          expectedRev: expected,
          message: str(args.message),
          actor: "mcp"
        });
        return { ok: true, rev: row.rev, id: row.id, parentRev: row.parent_rev, preview: PREVIEW_URL };
      } finally {
        closeDb(db);
      }
    }
  };

  const artifactsDir = join(paths.labDir, "artifacts");

  const enqueue_render = {
    definition: {
      name: "enqueue_render",
      description:
        "Enqueue a durable render job for a published revision: re-validates, re-audits, and writes a render manifest artifact via a worker. Idempotent per revision+format — re-enqueue returns the existing job. Fails loudly for unknown revisions.",
      inputSchema: {
        type: "object",
        properties: {
          rev: { type: "number", description: "Published revision number to render." },
          format: { type: "string", description: "mp4 (default) or webm." },
          projectId: { type: "string", description: "Project id (default project_default)." }
        },
        required: ["rev"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const rev = Math.round(Number(args.rev));
      if (!Number.isFinite(rev) || rev < 1) throw new Error("enqueue_render needs rev >= 1.");
      const projectId = str(args.projectId, "project_default");
      const format = str(args.format, "mp4").toLowerCase() === "webm" ? "webm" : "mp4";
      const db = await openDb(paths.labDir);
      try {
        const existing = getRevision(db.raw, projectId, rev);
        if (!existing) throw new Error(`enqueue_render: revision ${rev} of project "${projectId}" does not exist — publish it first.`);
        const { job, duplicate } = enqueue(db.raw, {
          projectId,
          type: "render",
          payload: { projectId, rev, format },
          maxAttempts: 3,
          idempotencyKey: `render:${projectId}:${rev}:${format}`
        });
        return { ok: true, jobId: job.id, status: job.status, duplicate, rev, format };
      } finally {
        closeDb(db);
      }
    }
  };

  const run_jobs_once = {
    definition: {
      name: "run_jobs_once",
      description:
        "Tick an in-process worker until the queue drains (or maxTicks): executes validate/simulate/render jobs synchronously and returns each outcome. Crashed-worker leases are recovered first.",
      inputSchema: {
        type: "object",
        properties: {
          types: { type: "array", description: "Only run these job types.", items: { type: "string" } },
          maxTicks: { type: "number", description: "Max jobs to run (default 10, max 50)." }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const types = Array.isArray(args.types) ? args.types.filter((entry): entry is string => typeof entry === "string") : undefined;
      const maxTicks = Math.max(1, Math.min(50, Math.round(Number(args.maxTicks) || 10)));
      const db = await openDb(paths.labDir);
      try {
        recoverStale(db.raw, 30_000);
        const worker = createWorker(db.raw, { ...defaultHandlers(), render: createRenderHandler(artifactsDir) }, types ? { types } : {});
        const outcomes: Array<{ jobId: string; type: string; outcome: string }> = [];
        for (let guard = 0; guard < maxTicks; guard++) {
          const ticked = await worker.tick();
          if (!ticked) break;
          outcomes.push({ jobId: ticked.job.id, type: ticked.job.type, outcome: ticked.outcome });
        }
        return { ok: true, ran: outcomes.length, outcomes };
      } finally {
        closeDb(db);
      }
    }
  };

  const job_status = {
    definition: {
      name: "job_status",
      description: "Full job state plus its durable event audit trail (enqueued, claimed, progress, completed/failed, recovered).",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Job id." }
        },
        required: ["jobId"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const jobId = str(args.jobId);
      if (!jobId) throw new Error("job_status needs jobId.");
      const db = await openDb(paths.labDir);
      try {
        const job = getJob(db.raw, jobId);
        if (!job) throw new Error(`job_status: unknown job "${jobId}".`);
        return { ok: true, job, events: getEvents(db.raw, jobId) };
      } finally {
        closeDb(db);
      }
    }
  };

  const job_list = {
    definition: {
      name: "job_list",
      description: "List jobs for a project, newest first, optionally filtered by status.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project id (default project_default)." },
          status: { type: "string", description: "QUEUED, RUNNING, COMPLETED, FAILED, or CANCELLED." },
          limit: { type: "number", description: "Max rows (default 20, max 200)." }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const projectId = str(args.projectId, "project_default");
      const rawStatus = str(args.status).toUpperCase();
      const status = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(rawStatus)
        ? (rawStatus as "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED")
        : undefined;
      if (args.status !== undefined && status === undefined) throw new Error(`job_list: unknown status "${String(args.status)}".`);
      const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || 20)));
      const db = await openDb(paths.labDir);
      try {
        return { ok: true, jobs: listJobs(db.raw, projectId, status, limit) };
      } finally {
        closeDb(db);
      }
    }
  };

  const job_cancel = {
    definition: {
      name: "job_cancel",
      description: "Cancel a queued or running job. Terminal jobs (completed/failed/cancelled) cannot be cancelled.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Job id." }
        },
        required: ["jobId"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const jobId = str(args.jobId);
      if (!jobId) throw new Error("job_cancel needs jobId.");
      const db = await openDb(paths.labDir);
      try {
        const cancelled = cancel(db.raw, jobId);
        return { ok: cancelled, jobId };
      } finally {
        closeDb(db);
      }
    }
  };

  const generate_ai_motion = {
    definition: {
      name: "generate_ai_motion",
      description:
        "Generate an AI motion asset with NVIDIA Cosmos3-Nano (mock when MOTION_PROVIDER=mock). Modes: text2video, image2video (needs sourceAssetId of an uploaded image), video2video (needs sourceAssetId of an uploaded MP4). Uses the exact same backend as the Motion Lab UI. Long-lived; returns the stored video URL on success.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", description: `Motion provider id (default "${COSMOS_PROVIDER_ID}").` },
          model: { type: "string", description: `Model id (default "${COSMOS_MODEL_ID}").` },
          mode: { type: "string", description: "text2video, image2video, or video2video." },
          sourceAssetId: { type: "string", description: "Asset id of an uploaded source (image for image2video, MP4 for video2video)." },
          prompt: { type: "string", description: "Text prompt (max 20000 chars). Required." },
          negativePrompt: { type: "string", description: "Optional negative prompt, transmitted as negative_prompt." },
          settings: {
            type: "object",
            description: "Registry-verified hosted settings: resolution, numFrames, numInferenceSteps, guidanceScale, flowShift, fps, seed.",
            properties: {
              resolution: { type: "string" },
              numFrames: { type: "number" },
              numInferenceSteps: { type: "number" },
              guidanceScale: { type: "number" },
              flowShift: { type: "number" },
              fps: { type: "number" },
              seed: { type: "number" }
            }
          },
          projectId: { type: "string", description: "Project id (default project_default)." }
        },
        required: ["mode"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const rawMode = str(args.mode);
      if (rawMode !== "image2video" && rawMode !== "text2video" && rawMode !== "video2video") {
        throw new Error(`generate_ai_motion: unsupported mode "${rawMode}". Use text2video, image2video, or video2video.`);
      }
      const mode: "image2video" | "text2video" | "video2video" = rawMode;
      const settings = props(args.settings);
      const input = {
        mode,
        prompt: str(args.prompt),
        ...(typeof args.negativePrompt === "string" ? { negativePrompt: args.negativePrompt } : {}),
        settings: {
          ...(typeof settings.resolution === "string" ? { resolution: settings.resolution } : {}),
          ...(settings.numFrames !== undefined ? { numFrames: Number(settings.numFrames) } : {}),
          ...(settings.fps !== undefined ? { fps: Number(settings.fps) } : {}),
          ...(settings.numInferenceSteps !== undefined ? { numInferenceSteps: Number(settings.numInferenceSteps) } : {}),
          ...(settings.guidanceScale !== undefined ? { guidanceScale: Number(settings.guidanceScale) } : {}),
          ...(settings.flowShift !== undefined && settings.flowShift !== null && String(settings.flowShift) !== "" ? { flowShift: Number(settings.flowShift) } : {}),
          ...(settings.seed !== undefined && settings.seed !== null && String(settings.seed) !== "" ? { seed: Number(settings.seed) } : {})
        },
        ...(str(args.sourceAssetId) ? { sourceId: str(args.sourceAssetId) } : {}),
        projectId: str(args.projectId, "project_default")
      };
      const requestedProvider = str(args.provider) || undefined;
      const env = requestedProvider ? { ...process.env, MOTION_PROVIDER: requestedProvider } : process.env;
      try {
        void selectedMotionProviderId(env);
      } catch {
        throw new Error(`generate_ai_motion: unknown provider "${requestedProvider}". Use "${COSMOS_PROVIDER_ID}" or "mock".`);
      }
      if (str(args.model) && str(args.model) !== COSMOS_MODEL_ID && requestedProvider !== "mock") {
        throw new Error(`generate_ai_motion: unknown model "${str(args.model)}". This workspace serves "${COSMOS_MODEL_ID}".`);
      }
      const result = await generateAndWait(paths.labDir, input, { env });
      return { ok: result.status === "COMPLETED", ...result };
    }
  };

  const inspect_ai_motion_generation = {
    definition: {
      name: "inspect_ai_motion_generation",
      description:
        "Inspect the AI motion provider state: which provider/model is selected, whether NVIDIA Cosmos3-Nano is configured (NVIDIA_API_KEY present — value never exposed), supported modes, and the verified Cosmos3-Generator parameter contract.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project id (default project_default)." }
        }
      }
    },
    handler: (args: Record<string, unknown>) => {
      void args;
      return { ok: true, ...motionProviderStatus(process.env), cosmosConfig: diagnoseCosmosConfig(process.env), promptEnhancement: liveChatStatus(process.env) };
    }
  };

  const get_ai_motion_result = {
    definition: {
      name: "get_ai_motion_result",
      description:
        "Read AI motion generation results: fetch one generation by id (with provider, model, status, video URL, and metadata), list recent generations, delete one, mark one for use, save one into the Lab exports, or register an upload source. Never returns credentials or base64 video.",
      inputSchema: {
        type: "object",
        properties: {
          generationId: { type: "string", description: "Generation id (aimo-...). Omit with list:true to list." },
          list: { type: "boolean", description: "List recent generations for the project." },
          limit: { type: "number", description: "Max rows for list (default 20, max 200)." },
          action: {
            type: "string",
            description: "delete | use | save | import. delete/use/save operate on generationId; import ingests an MP4 file. Default: read."
          },
          importRender: {
            type: "object",
            description: "With action:import — ingest a rendered MP4 as a COMPLETED generation: { filePath, prompt, mode?, label? }.",
            properties: {
              filePath: { type: "string" },
              prompt: { type: "string" },
              mode: { type: "string" },
              label: { type: "string" }
            }
          },
          uploadSource: {
            type: "object",
            description: "Register an upload source: { name, dataUrl (data:image/...;base64,...), label? }.",
            properties: {
              name: { type: "string" },
              dataUrl: { type: "string" },
              label: { type: "string" }
            }
          },
          projectId: { type: "string", description: "Project id (default project_default)." }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const projectId = str(args.projectId, "project_default");
      const db = await openDb(paths.labDir);
      try {
        const upload = props(args.uploadSource);
        if (upload.dataUrl) {
          const source = saveSourceImage(db.raw, paths.labDir, projectId, {
            name: str(upload.name, "source.png"),
            dataUrl: str(upload.dataUrl),
            ...(typeof upload.label === "string" ? { label: upload.label } : {})
          });
          return { ok: true, source };
        }
        if (args.list) {
          const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || 20)));
          return { ok: true, generations: listGenerations(db.raw, projectId, limit) };
        }
        const action = str(args.action);
        if (action === "import") {
          const spec = props(args.importRender);
          if (!str(spec.filePath) || !str(spec.prompt)) {
            throw new Error("get_ai_motion_result action:import needs importRender { filePath, prompt }.");
          }
          const mode = str(spec.mode) === "text2video" ? "text2video" : "image2video";
          return {
            ok: true,
            generation: importCompletedRender(db.raw, paths.labDir, {
              filePath: str(spec.filePath),
              prompt: str(spec.prompt),
              mode,
              ...(str(spec.label) ? { label: str(spec.label) } : {}),
              projectId
            })
          };
        }
        const generationId = str(args.generationId);
        if (!generationId) throw new Error('get_ai_motion_result needs generationId, list:true, uploadSource.dataUrl, or action:import.');
        if (action === "delete") return { ok: deleteGeneration(db.raw, paths.labDir, generationId), generationId };
        if (action === "use") return { ok: true, generation: markSelected(db.raw, generationId) };
        if (action === "save") return { ok: true, generation: saveGenerationToLab(db.raw, paths.labDir, generationId) };
        if (action && action !== "read") throw new Error(`get_ai_motion_result: unknown action "${action}". Use delete, use, save, or import.`);
        const generation = getGeneration(db.raw, generationId);
        if (!generation) throw new Error(`get_ai_motion_result: unknown generation "${generationId}".`);
        return { ok: true, generation };
      } finally {
        closeDb(db);
      }
    }
  };

  const enhance_motion_prompt = {
    definition: {
      name: "enhance_motion_prompt",
      description:
        "Rewrite a motion prompt into dense cinematic direction with the live NVIDIA vision model (meta/llama-3.2-11b-vision-instruct, verified invocable). Accepts an optional sourceAssetId whose image the model sees. Returns the enhanced text — never overwrites anything; the caller applies it explicitly.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Draft prompt to enhance (max 20000 chars)." },
          mode: { type: "string", description: "image2video (default) or text2video — frames the direction." },
          sourceAssetId: { type: "string", description: "Asset id of a source image for the model to see." },
          projectId: { type: "string", description: "Project id (default project_default)." }
        },
        required: ["prompt"]
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const prompt = str(args.prompt);
      if (!prompt.trim()) throw new Error("enhance_motion_prompt needs a prompt.");
      const mode = str(args.mode) === "text2video" ? "text2video" : "image2video";
      const sourceId = str(args.sourceAssetId);
      let imageBytes: Buffer | undefined;
      let imageMime: string | undefined;
      if (sourceId) {
        const db = await openDb(paths.labDir);
        try {
          const asset = getAsset(db.raw, sourceId);
          if (!asset?.path) throw new Error(`enhance_motion_prompt: unknown source "${sourceId}".`);
          const resolved = join(paths.labDir, asset.path);
          if (!resolved.startsWith(paths.labDir)) throw new Error("enhance_motion_prompt: source escapes the lab directory.");
          imageBytes = readFileSync(resolved);
          const meta = asset.meta as Record<string, unknown>;
          imageMime = typeof meta.mime === "string" ? meta.mime : "image/png";
        } finally {
          closeDb(db);
        }
      }
      const result = await enhanceMotionPrompt({ prompt, mode, ...(imageBytes ? { imageBytes, imageMime } : {}) }, { env: process.env });
      return { ok: true, ...result };
    }
  };

  const create_gsap_animation = {
    definition: {
      name: "create_gsap_animation",
      description:
        "Create a GSAP animation from a structured spec (tween, stagger, text, scroll, spring, motion-path, parallax, set ops). Validates against the GSAP track schema, persists the versioned spec, and returns the plan plus website-ready GSAP code. Timeline/stagger/spring/scroll/text behavior is expressed as spec ops — no separate per-verb tools needed.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scene name, e.g. 'obsidian-hero'." },
          description: { type: "string", description: "What this animation does." },
          ops: {
            type: "array",
            description: "Spec ops: [{ id?, type, target, from?, to?, duration?, ease?, delay?, position?, label?, stagger?, spring?, path?, speed?, scrub? }].",
            items: { type: "object" }
          },
          publish: { type: "boolean", description: "Publish to the live Lab mirror immediately." }
        },
        required: ["ops"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const ops = Array.isArray(args.ops) ? (args.ops as Array<Record<string, unknown>>) : [];
      if (ops.length === 0) throw new Error("create_gsap_animation requires at least one op.");
      const spec = buildGsapScene({ name: str(args.name, `gsap-${Date.now().toString(36)}`), ...(typeof args.description === "string" ? { description: args.description } : {}), ops });
      const record = saveGsapSpec(paths.labDir, spec);
      const tested = testGsapSpec(record.spec);
      const live = args.publish ? publishGsapLive(paths.labDir, record.name) : undefined;
      return {
        ok: tested.validation.ok,
        name: record.name,
        description: record.description,
        validation: tested.validation,
        plan: tested.plan,
        code: codeForGsapSpec(record.spec),
        ...(live ? { live: { name: live.name, updatedAt: live.updatedAt }, preview: PREVIEW_URL } : {})
      };
    }
  };

  const modify_gsap_animation = {
    definition: {
      name: "modify_gsap_animation",
      description: "Patch one GSAP spec op by id (shallow field merge) or append new ops. Re-validates the whole scene before persisting; a bad patch never lands.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scene name." },
          opId: { type: "string", description: "Op id to patch." },
          fields: { type: "object", description: "Fields to merge into the op." },
          append: { type: "array", description: "Ops to append.", items: { type: "object" } }
        },
        required: ["name"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const name = str(args.name);
      if (!name) throw new Error("modify_gsap_animation requires a scene name.");
      const record = modifyGsapSpec(paths.labDir, name, {
        ...(str(args.opId) ? { opId: str(args.opId) } : {}),
        ...(Object.keys(props(args.fields)).length > 0 ? { fields: props(args.fields) } : {}),
        ...(Array.isArray(args.append) ? { append: args.append.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object") } : {})
      });
      const tested = testGsapSpec(record.spec);
      return { ok: tested.validation.ok, name: record.name, validation: tested.validation, plan: tested.plan, code: codeForGsapSpec(record.spec) };
    }
  };

  const gsap_op_append = (toolName: string, opType: string, blurb: string) => ({
    definition: {
      name: toolName,
      description: blurb,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scene to extend (created if missing)." },
          target: { type: "string", description: "CSS selector the op drives." },
          path: { type: ["string", "array"], description: "motion-path: SVG path data or [{x,y}, …] waypoints." },
          speed: { type: "number", description: "parallax: distance factor, ±1 typical." },
          duration: { type: "number" },
          ease: { type: "string" },
          delay: { type: "number" },
          position: { type: ["string", "number"], description: "Timeline position." },
          id: { type: "string", description: "Op id (defaults deterministically)." }
        },
        required: ["name", "target"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const name = str(args.name);
      const target = str(args.target);
      if (!name) throw new Error(`${toolName} requires a scene name.`);
      if (!target) throw new Error(`${toolName} requires a target selector.`);
      const op: Record<string, unknown> = {
        ...(str(args.id) ? { id: str(args.id) } : {}),
        type: opType,
        target,
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.speed !== undefined ? { speed: Number(args.speed) } : {}),
        ...(num(args.duration) !== undefined ? { duration: num(args.duration) as number } : {}),
        ...(str(args.ease) ? { ease: str(args.ease) } : {}),
        ...(num(args.delay) !== undefined ? { delay: num(args.delay) as number } : {}),
        ...(args.position !== undefined ? { position: args.position as string | number } : {})
      };
      const existing = getGsapSpec(paths.labDir, name);
      const record = existing
        ? modifyGsapSpec(paths.labDir, name, { append: [op] })
        : saveGsapSpec(paths.labDir, buildGsapScene({ name, ops: [{ ...op, ...(opType === "parallax" ? { duration: 0.5 } : {}) }] }));
      const tested = testGsapSpec(record.spec);
      return { ok: tested.validation.ok, name: record.name, op, validation: tested.validation, plan: tested.plan, code: codeForGsapSpec(record.spec) };
    }
  });

  const add_motion_path = gsap_op_append(
    "add_motion_path",
    "motion-path",
    "Drive a target along an SVG path or waypoint list (GSAP MotionPath). Appends to the named scene, creating it when missing. Validates path data before persisting."
  );

  const add_parallax = gsap_op_append(
    "add_parallax",
    "parallax",
    "Bind a target to scroll with a speed factor (scrubbed yPercent drift). Appends to the named scene, creating it when missing. Warns outside the ±1 range."
  );

  const preview_gsap_animation = {
    definition: {
      name: "preview_gsap_animation",
      description: "Publish a GSAP scene to the live Lab mirror. Returns the preview URL plus name and op count. Open the GSAP workspace to watch the engine render.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Scene name." } },
        required: ["name"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const name = str(args.name);
      if (!name) throw new Error("preview_gsap_animation requires a scene name.");
      const live = publishGsapLive(paths.labDir, name);
      const record = getGsapSpec(paths.labDir, name);
      return { ok: true, url: PREVIEW_URL, name: live.name, ops: record?.spec.ops.length ?? 0, updatedAt: live.updatedAt };
    }
  };

  const test_gsap_animation = {
    definition: {
      name: "test_gsap_animation",
      description: "Deterministically simulate a GSAP scene (spans, totals, tween/ambient/scrub counts, labels). No browser needed — the engine resolves identical timing.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Scene name." } },
        required: ["name"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const record = getGsapSpec(paths.labDir, str(args.name));
      if (!record) throw new Error(`Unknown GSAP animation "${str(args.name)}".`);
      const tested = testGsapSpec(record.spec);
      return { ok: tested.validation.ok, name: record.name, validation: tested.validation, plan: tested.plan };
    }
  };

  const validate_gsap_animation = {
    definition: {
      name: "validate_gsap_animation",
      description: "Validate a GSAP scene (targets unchecked server-side — the Lab checks them against the live scope): types, durations, easings, stagger/spring/path/parallax fields, label references, timeline ordering.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Scene name." } },
        required: ["name"]
      }
    },
    handler: (args: Record<string, unknown>) => {
      const record = getGsapSpec(paths.labDir, str(args.name));
      if (!record) throw new Error(`Unknown GSAP animation "${str(args.name)}".`);
      const validation = testGsapSpec(record.spec).validation;
      return { name: record.name, ...validation, specs: listGsapSpecs(paths.labDir).map((entry) => entry.name) };
    }
  };

  const buildToolsRef: Record<string, unknown> = {};
  const entries = [
    inspect_animation,
    inspect_target,
    create_animation,
    modify_animation,
    create_timeline,
    apply_preset,
    add_stagger,
    add_spring,
    add_scroll_motion,
    add_text_motion,
    apply_instruction,
    record_technique,
    restore_state,
    synthesize_voiceover,
    voiceover_list,
    voiceover_get,
    build_story,
    plan_story,
    publish_revision,
    enqueue_render,
    run_jobs_once,
    job_status,
    job_list,
    job_cancel,
    ingest_asset,
    asset_list,
    technique_list,
    artifact_list,
    create_from_voiceover,
    analyze_narration,
    transcribe_voiceover,
    detect_beats,
    plan_animation,
    publish_plan,
    preview_animation,
    test_animation,
    validate_animation,
    generate_ai_motion,
    inspect_ai_motion_generation,
    get_ai_motion_result,
    enhance_motion_prompt,
    create_gsap_animation,
    modify_gsap_animation,
    add_motion_path,
    add_parallax,
    preview_gsap_animation,
    test_gsap_animation,
    validate_gsap_animation
  ];
  buildToolsRef.modify = modify_animation.handler;
  return entries.map((entry) => ({ definition: entry.definition, handler: entry.handler }));
}
