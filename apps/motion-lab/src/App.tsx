import { useCallback, useEffect, useRef, useState } from "react";
import { runPreset, runPresetSpec } from "@waves/motion";
import { MotionNode, createTimeline, motion } from "@waves/motion/timeline";
import { createScroll, type ScrollController } from "@waves/motion/scroll";
import type { MotionOp, MotionState, SceneElement } from "@lab/ops";
import { getLabEngine, renewLabEngine } from "./lib/engine";
import { ensureParticles } from "./lib/particles";
import {
  BRIDGE_TIMEOUT_MS,
  DECODE_TIMEOUT_MS,
  EXPORT_TIMEOUT_MS,
  TimeoutError,
  createOpToken,
  fetchJson,
  pickDuration,
  probeFileDuration,
  withTimeout,
  type LifecycleStage
} from "./lib/lifecycle";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./lib/providers";
import AiMotion from "./AiMotion";
import GsapLab from "./GsapLab";

/**
 * WAVES Motion Lab — voiceover-driven creation instrument.
 *
 * One canvas, one voiceover dropzone, contextual controls. The user provides
 * a voiceover; the MCP pipeline (transcribe → beats → plan → validated ops)
 * builds the world around it. No panels, no timelines, no debug chrome.
 */

const POLL_MS = 750;
const VOICEOVER_EXTENSIONS = ["mp3", "wav", "m4a", "aac"];
const VOICEOVER_BYTES_MAX = 50_000_000;

/** Export recordings use a clean frame: stage only, nothing else. */
const EXPORT_CLEAN = new URLSearchParams(window.location.search).has("export");

/** Deep links: /?ai-motion=1 and /?gsap=1 open workspaces directly. */
function initialView(): "lab" | "ai" | "gsap" {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("ai-motion") || params.get("view") === "ai-motion") return "ai";
    if (params.has("gsap") || params.get("view") === "gsap") return "gsap";
  } catch {
    /* non-browser render — default to the Lab */
  }
  return "lab";
}

interface SavedEntry {
  name: string;
  description: string;
  opCount: number;
  opIds: string[];
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const scope = window as unknown as Record<string, unknown>;
  const ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as new () => SpeechRecognitionLike) : null;
}

interface Pausable {
  pause: () => unknown;
  resume: () => unknown;
}

interface BeatSpan {
  opId: string;
  kind: string;
  target?: string;
  start: number;
  duration: number;
  end: number;
}

interface Selection {
  kind: "target" | "op";
  label: string;
  opIds: string[];
}

interface Voiceover {
  id: string;
  file: string;
  durationMs: number;
  peaks: number[];
}

function formatClock(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function bridge(tool: string, args: Record<string, unknown>, timeoutMs: number = BRIDGE_TIMEOUT_MS): Promise<unknown> {
  const response = await fetchJson<{ ok: boolean; result?: unknown; error?: string }>(
    "/__lab/mcp",
    timeoutMs,
    `MCP ${tool}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args })
    }
  );
  if (!response.ok) throw new Error(response.error ?? `MCP ${tool} failed.`);
  return response.result;
}

function hideInitially(element: HTMLElement): void {
  element.setAttribute("data-cascade", "");
  // Behavioral hook for the planner's cascade ops: every element hidden for
  // a staggered entrance is addressable as a group. No visual rules attached.
  element.classList.add("lab-reveal");
  element.style.opacity = "0";
}

function caption(text: string | undefined, cls = "lab-scene-caption"): HTMLElement | null {
  if (!text) return null;
  const paragraph = document.createElement("div");
  paragraph.className = cls;
  paragraph.textContent = text;
  return paragraph;
}

function stageRow(items: string[], cascade = false): HTMLElement {
  const row = document.createElement("div");
  row.className = "lab-stages";
  items.forEach((item, index) => {
    if (index > 0) {
      const arrow = document.createElement("span");
      arrow.className = "lab-arrow";
      arrow.textContent = "→";
      row.appendChild(arrow);
    }
    const stage = document.createElement("span");
    stage.className = "lab-stage-name";
    stage.textContent = item;
    if (cascade) hideInitially(stage);
    row.appendChild(stage);
  });
  return row;
}

function buildSceneElement(stage: HTMLElement, element: SceneElement): void {
  const mount = document.createElement("div");
  mount.id = `lab-scene-${element.key}`;
  mount.setAttribute("data-lab", `scene-${element.key}`);
  if (element.act !== undefined) mount.setAttribute("data-act", String(element.act));
  if (element.label) mount.setAttribute("aria-label", element.label);

  if (element.kind === "cards") {
    mount.className = "lab-scene-cards";
    const count = Math.max(1, Math.min(12, element.count ?? 3));
    for (let index = 0; index < count; index++) {
      const card = document.createElement("div");
      card.className = "lab-scene-card";
      card.setAttribute("data-lab", `scene-${element.key}-${index}`);
      mount.appendChild(card);
    }
  } else if (element.kind === "hero") {
    mount.className = "lab-scene-hero";
    const eyebrow = document.createElement("div");
    eyebrow.className = "lab-scene-eyebrow";
    eyebrow.textContent = "WAVES";
    const title = document.createElement("div");
    title.className = "lab-scene-title";
    title.textContent = element.text ?? "Motion, engineered.";
    const cards = document.createElement("div");
    cards.className = "lab-scene-cards";
    const count = Math.max(1, Math.min(12, element.count ?? 3));
    for (let index = 0; index < count; index++) {
      const card = document.createElement("div");
      card.className = "lab-scene-card";
      card.setAttribute("data-lab", `scene-${element.key}-${index}`);
      cards.appendChild(card);
    }
    mount.append(eyebrow, title, cards);
  } else if (element.kind === "text") {
    mount.className = "lab-scene-text";
    mount.textContent = element.text ?? "Waves Motion";
  } else if (element.kind === "title") {
    mount.className = "lab-scene-titlewrap";
    const eyebrow = document.createElement("div");
    eyebrow.className = "lab-scene-eyebrow";
    eyebrow.textContent = element.eyebrow ?? "WAVES";
    const title = document.createElement("div");
    title.className = element.large ? "lab-scene-title lab-scene-title-xl" : "lab-scene-title";
    title.textContent = element.text ?? "";
    mount.append(eyebrow, title);
    const sub = caption(element.sub, "lab-scene-sub");
    if (sub) mount.appendChild(sub);
  } else if (element.kind === "flow") {
    mount.className = "lab-scene-film";
    const card = document.createElement("div");
    card.className = "lab-context-card";
    card.textContent = element.text ?? "YOUR CONTEXT";
    mount.appendChild(card);
    if (element.items) mount.appendChild(stageRow(element.items, true));
    const cap = caption(element.caption);
    if (cap) mount.appendChild(cap);
  } else if (element.kind === "network") {
    mount.className = "lab-scene-film";
    const net = document.createElement("div");
    net.className = "lab-net";
    const count = Math.max(1, Math.min(400, element.count ?? 120));
    const highlighted = new Set(element.highlight ?? []);
    for (let index = 0; index < count; index++) {
      const dot = document.createElement("span");
      dot.className = highlighted.has(index) ? "lab-net-dot lab-net-dot-hl" : "lab-net-dot";
      hideInitially(dot);
      net.appendChild(dot);
    }
    mount.appendChild(net);
    const cap = caption(element.caption);
    if (cap) mount.appendChild(cap);
  } else if (element.kind === "pipeline") {
    mount.className = "lab-scene-film";
    if (element.items) mount.appendChild(stageRow(element.items, true));
    const mail = document.createElement("div");
    mail.className = "lab-mail";
    const head = document.createElement("div");
    head.className = "lab-mail-head";
    head.textContent = "OUTREACH DRAFT";
    mail.appendChild(head);
    for (let index = 0; index < 3; index++) {
      const line = document.createElement("div");
      line.className = "lab-mail-line";
      mail.appendChild(line);
    }
    const foot = document.createElement("div");
    foot.className = "lab-mail-foot";
    foot.textContent = "AI PREPARED";
    mail.appendChild(foot);
    hideInitially(mail);
    mount.appendChild(mail);
    const badge = document.createElement("div");
    badge.className = "lab-badge";
    badge.textContent = "APPROVED ✓";
    hideInitially(badge);
    mount.appendChild(badge);
    const cap = caption(element.caption);
    if (cap) mount.appendChild(cap);
    const cap2 = caption(element.caption2);
    if (cap2) mount.appendChild(cap2);
  } else if (element.kind === "stages") {
    mount.className = "lab-scene-film";
    if (element.items) mount.appendChild(stageRow(element.items, true));
    const replies = document.createElement("div");
    replies.className = "lab-replies";
    for (let index = 0; index < 6; index++) {
      const dot = document.createElement("span");
      dot.className = "lab-rep-dot";
      hideInitially(dot);
      replies.appendChild(dot);
    }
    mount.appendChild(replies);
    const follow = document.createElement("div");
    follow.className = "lab-follow";
    for (let index = 0; index < 3; index++) {
      const card = document.createElement("div");
      card.className = "lab-follow-card";
      card.textContent = `FOLLOW-UP 0${index + 1}`;
      hideInitially(card);
      follow.appendChild(card);
    }
    mount.appendChild(follow);
    const cap = caption(element.caption);
    if (cap) mount.appendChild(cap);
  } else if (element.kind === "orb") {
    // The base visual state: deterministic golden-angle spiral, center core.
    // Same dot atoms as every other state — morphs read as reorganization.
    mount.className = "lab-scene-orb";
    mount.setAttribute("aria-label", "WAVES orb");
    const count = Math.max(1, Math.min(400, element.count ?? 72));
    for (let index = 0; index < count; index++) {
      const fraction = (index + 0.5) / count;
      const radius = 46 * Math.sqrt(fraction);
      const angle = index * 2.399963;
      const dot = document.createElement("span");
      dot.className = index === 0 ? "lab-orb-dot lab-orb-core" : "lab-orb-dot";
      dot.style.left = `${50 + radius * Math.cos(angle)}%`;
      dot.style.top = `${50 + radius * Math.sin(angle)}%`;
      mount.appendChild(dot);
    }
  } else if (element.kind === "crm") {
    // LEADS table — narration rows when the planner provides them, else the
    // house default. Header plus minimal rows, no dashboard chrome.
    mount.className = "lab-scene-film";
    const head = document.createElement("div");
    head.className = "lab-crm-head";
    head.textContent = "LEADS";
    mount.appendChild(head);
    const provided = Array.isArray(element.rows)
      ? element.rows.filter((row): row is [string, string, string, string] => Array.isArray(row) && row.length >= 4 && row.every((cell) => typeof cell === "string")).slice(0, 4)
      : [];
    const rows: Array<[string, string, string, string]> =
      provided.length > 0
        ? provided
        : [
            ["Acme Corp", "J. Doe", "NEW", "2d"],
            ["Globex", "A. Smith", "REPLIED", "1d"],
            ["Initech", "B. Jones", "FOLLOW-UP", "3h"]
          ];
    for (const [company, contact, status, touch] of rows) {
      const row = document.createElement("div");
      row.className = "lab-crm-row";
      for (const cell of [company, contact, status, touch]) {
        const span = document.createElement("span");
        span.className = "lab-crm-cell";
        span.textContent = cell;
        row.appendChild(span);
      }
      hideInitially(row);
      mount.appendChild(row);
    }
    const cap = caption(element.caption);
    if (cap) mount.appendChild(cap);
  } else if (element.kind === "notebook") {
    // Research surface — labeled context lines, minimal typography.
    mount.className = "lab-scene-film";
    const head = document.createElement("div");
    head.className = "lab-crm-head";
    head.textContent = element.text ?? "CONTEXT";
    mount.appendChild(head);
    const signal = typeof element.signal === "string" && element.signal.trim() ? element.signal.slice(0, 40) : "Intent data";
    const lines: Array<[string, string]> = [
      ["OBJECTIVE", "Convert pilots"],
      ["AUDIENCE", "Operators"],
      ["CONSTRAINTS", "No spam"],
      ["SIGNALS", signal]
    ];
    for (const [label, value] of lines) {
      const row = document.createElement("div");
      row.className = "lab-nb-line";
      const name = document.createElement("span");
      name.className = "lab-nb-label";
      name.textContent = label;
      const val = document.createElement("span");
      val.className = "lab-nb-value";
      val.textContent = value;
      row.append(name, document.createTextNode("  "), val);
      hideInitially(row);
      mount.appendChild(row);
    }
    const cap = caption(element.caption);
    if (cap) mount.appendChild(cap);
  } else if (element.kind === "workflow") {
    // Vertical acquisition chain — nodes plus connectors, alive but restrained.
    mount.className = "lab-scene-film";
    const chain = element.items ?? ["CONTEXT", "LEADS", "OUTREACH", "REPLIES", "FOLLOW-UP", "REPORT"];
    chain.forEach((item, index) => {
      if (index > 0) {
        const conn = document.createElement("div");
        conn.className = "lab-wf-conn";
        conn.textContent = "↓";
        mount.appendChild(conn);
      }
      const node = document.createElement("div");
      node.className = "lab-wf-node";
      node.textContent = item;
      hideInitially(node);
      mount.appendChild(node);
    });
    const cap = caption(element.caption);
    if (cap) mount.appendChild(cap);
  } else if (element.kind === "particle-orb") {
    // Dense orb: the canvas rasterizes; the ENGINE animates --orb-* params.
    mount.className = "lab-particle-orb";
    mount.setAttribute("aria-label", "WAVES particle orb");
    const canvas = document.createElement("canvas");
    canvas.className = "lab-particle-canvas";
    const resolution = 600;
    canvas.width = resolution;
    canvas.height = resolution;
    mount.appendChild(canvas);
  } else if (element.kind === "milestones") {
    mount.className = "lab-scene-film";
    const list = document.createElement("div");
    list.className = "lab-ms";
    const count = Math.max(1, Math.min(9, element.count ?? 3));
    for (let index = 0; index < count; index++) {
      const row = document.createElement("div");
      row.className = "lab-ms-row";
      row.textContent = `MILESTONE 0${index + 1}`;
      hideInitially(row);
      list.appendChild(row);
    }
    mount.appendChild(list);
    const bar = document.createElement("div");
    bar.className = "lab-bar-track";
    const fill = document.createElement("div");
    fill.className = "lab-bar-fill";
    fill.style.transform = "scaleX(0)";
    bar.appendChild(fill);
    mount.appendChild(bar);
    const report = document.createElement("div");
    report.className = "lab-report";
    report.textContent = "CYCLE 1 REPORT";
    hideInitially(report);
    mount.appendChild(report);
  } else {
    mount.className = "lab-scene-box";
  }
  stage.appendChild(mount);
}

/** Multi-act convention: mounts carrying data-act start hidden except act 1. */
function applyActConvention(stage: HTMLElement): void {
  const mounts = [...stage.querySelectorAll<HTMLElement>("[data-act]")];
  if (mounts.length === 0) return;
  const acts = mounts.map((mount) => Number(mount.getAttribute("data-act")) || 1);
  const first = Math.min(...acts);
  for (const mount of mounts) {
    if (Number(mount.getAttribute("data-act")) !== first) mount.style.opacity = "0";
  }
}

function splitChars(target: Element): HTMLElement[] {
  if (target.querySelectorAll(":scope > .lab-char").length > 0) {
    return [...target.querySelectorAll<HTMLElement>(":scope > .lab-char")];
  }
  const text = target.textContent ?? "";
  target.textContent = "";
  const chars: HTMLElement[] = [];
  for (const char of text) {
    const span = document.createElement("span");
    span.className = "lab-char";
    span.textContent = char === " " ? " " : char;
    target.appendChild(span);
    chars.push(span);
  }
  target.setAttribute("data-split", "chars");
  return chars;
}

function formatMs(value: number): string {
  const seconds = value / 1000;
  return `${seconds.toFixed(1)}s`;
}

function opTiming(op: MotionOp): string {
  if (op.kind === "animate" || op.kind === "preset") {
    const options = op.options ?? {};
    const parts: string[] = [];
    if (typeof options.duration === "number") parts.push(`${options.duration}ms`);
    if (typeof options.delay === "number" && options.delay > 0) parts.push(`+${options.delay}ms`);
    if (typeof options.stagger === "number") parts.push(`±${options.stagger}ms`);
    if (typeof options.easing === "string") parts.push(String(options.easing));
    return parts.join(" · ") || "house defaults";
  }
  if (op.kind === "timeline") return `${op.nodes.length} nodes`;
  if (op.kind === "text") return `stagger ${op.stagger ?? 40}ms`;
  if (op.kind === "scroll") return "scrubbed";
  if (op.kind === "scene") return `${op.scene.elements.length} element(s)`;
  return op.kind;
}

/** Scene cycle for energy-detected beats (no transcript semantics available). */
const ENERGY_SCENES = ["orb pulse", "crm entrance", "notebook reveal", "workflow sequence", "hero finale", "orb disperse"];

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const appliedRevision = useRef(-1);
  const scrollers = useRef<ScrollController[]>([]);
  const lastOps = useRef<MotionOp[]>([]);
  const statusTimer = useRef<number | null>(null);
  const handlesRef = useRef<Pausable[]>([]);
  const playStartRef = useRef(0);
  const pauseBeginRef = useRef(0);
  const playingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Generation ownership: which audio op (if any) owns the pipeline right now. */
  const genOwnerRef = useRef<number | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [hasScene, setHasScene] = useState(false);
  /** Explicit operation lifecycle: every audio/media path ends in complete or error. */
  const [lifecycle, setLifecycle] = useState<LifecycleStage>("idle");
  const lifecycleRef = useRef<LifecycleStage>("idle");
  const setStage = useCallback((stage: LifecycleStage) => {
    lifecycleRef.current = stage;
    setLifecycle(stage);
  }, []);
  const [animName, setAnimName] = useState("premium-hero");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [beats, setBeats] = useState<BeatSpan[]>([]);
  const [listening, setListening] = useState(false);
  const [voiceSupported] = useState(() => getSpeechRecognition() !== null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [voiceover, setVoiceover] = useState<Voiceover | null>(null);
  const [voiceoverOpen, setVoiceoverOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [genPhase, setGenPhase] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.8);
  const recognizer = useRef<SpeechRecognitionLike | null>(null);
  const [view, setView] = useState<"lab" | "ai" | "gsap">(initialView);
  const voiceoverRef = useRef<Voiceover | null>(null);
  voiceoverRef.current = voiceover;
  /** Single-active-operation ownership: next() cancels every in-flight continuation. */
  const opTokenRef = useRef(createOpToken());
  const hasSceneRef = useRef(false);
  const totalMsRef = useRef(0);

  const flash = useCallback((message: string) => {
    setStatus(message);
    if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), 6000);
  }, []);

  /**
   * Terminal playback state: the voiceover finished (or the horizon passed),
   * so the clock stops here instead of running past the end forever.
   */
  const finishPlayback = useCallback(() => {
    const audio = audioRef.current;
    const vo = voiceoverRef.current;
    if (!vo) return;
    if (audio && audio.src && !audio.src.includes(vo.file)) return; // stale element audio
    if (!playingRef.current && lifecycleRef.current === "complete") return;
    playingRef.current = false;
    setPlaying(false);
    const horizon = Math.max(totalMsRef.current, vo.durationMs, 0);
    if (horizon > 0) setPositionMs(horizon);
    setStage("complete");
    flash("Playback complete");
  }, [flash, setStage]);

  const finishPlaybackRef = useRef(() => {});
  finishPlaybackRef.current = finishPlayback;

  const applyOp = useCallback((op: MotionOp, sink?: Pausable[]) => {
    const engine = getLabEngine();
    const stage = stageRef.current;
    const collect = (handle: unknown) => {
      const candidate = handle as { pause?: unknown; resume?: unknown } | null;
      if (candidate && typeof candidate.pause === "function" && typeof candidate.resume === "function") {
        sink?.push(candidate as Pausable);
      }
    };
    switch (op.kind) {
      case "reset":
        for (const controller of scrollers.current) {
          try {
            controller.destroy();
          } catch {
            /* already torn down */
          }
        }
        scrollers.current = [];
        engine.reset();
        if (stage) stage.innerHTML = "";
        break;
      case "scene":
        if (!stage) break;
        stage.innerHTML = "";
        for (const element of op.scene.elements) buildSceneElement(stage, element);
        applyActConvention(stage);
        if (op.scene.elements.some((element) => element.layout === "reel")) stage.classList.add("lab-reel");
        else stage.classList.remove("lab-reel");
        break;
      case "animate":
        collect(engine.animate(op.target as never, op.properties as never, (op.options ?? {}) as never));
        break;
      case "preset":
        collect(runPreset(op.preset, op.target as never, op.params ?? {}, engine, ((op.options ?? {}) as never) ?? {}));
        break;
      case "timeline": {
        const timeline = createTimeline(engine, { label: op.label ?? "lab" });
        for (const node of op.nodes) {
          const base = {
            target: node.target,
            ...(node.properties ? { properties: node.properties } : {}),
            ...(node.label ? { label: node.label } : {})
          };
          const built = node.preset
            ? runPresetSpec(node.preset, node.target as never, (node.params ?? {}) as never, {
                ...(node.stagger !== undefined ? { stagger: node.stagger } : {})
              } as never)
            : node.stagger !== undefined
              ? new MotionNode({ spec: base as never, stagger: node.stagger })
              : motion(base as never);
          if (node.at !== undefined) built.at(node.at);
          else if (node.after) built.after(node.after);
          timeline.add(built);
        }
        timeline.play();
        collect(timeline);
        break;
      }
      case "scroll": {
        const controller = createScroll(
          engine,
          op.target as never,
          (op.properties ?? { y: [40, 0], opacity: [0.2, 1] }) as never,
          { start: "enter", end: "end", easing: "waves-smooth", ...(op.options ?? {}) } as never
        ).play();
        scrollers.current.push(controller);
        collect(controller);
        break;
      }
      case "text": {
        const root = document.querySelector(op.target);
        if (!root) break;
        const chars = splitChars(root);
        chars.forEach((char) => {
          char.style.transform = "";
          char.style.opacity = "";
        });
        collect(
          engine.animate(chars as never, { y: [12, 0], opacity: [0, 1] } as never, {
            duration: op.duration ?? 350,
            easing: (op.easing ?? "waves-entrance") as never,
            stagger: op.stagger ?? 40,
            staggerFrom: "first",
            ...(op.delay !== undefined ? { delay: op.delay } : {})
          } as never)
        );
        break;
      }
    }
  }, []);

  /** Restart the live composition from t=0 on a fresh engine. Deterministic. */
  const playFromZero = useCallback(() => {
    for (const controller of scrollers.current) {
      try {
        controller.destroy();
      } catch {
        /* already torn down */
      }
    }
    scrollers.current = [];
    const engine = renewLabEngine();
    handlesRef.current = [];
    if (stageRef.current) stageRef.current.innerHTML = "";
    for (const op of lastOps.current) {
      try {
        applyOp(op, handlesRef.current);
      } catch {
        /* one bad op never kills the surface */
      }
    }
    ensureParticles();
    playStartRef.current = engine.now();
    playingRef.current = lastOps.current.length > 0;
    setPlaying(playingRef.current);
    // Replay from a terminal state re-enters playback.
    if (playingRef.current) setStage("playing");
    setPositionMs(0);
    const audio = audioRef.current;
    const vo = voiceoverRef.current;
    if (audio && vo) {
      try {
        audio.currentTime = 0;
        void audio.play().catch(() => {});
      } catch {
        /* autoplay policy — canvas still plays */
      }
    }
  }, [applyOp, setStage]);

  const pauseAll = useCallback(() => {
    if (!playingRef.current) return;
    for (const handle of handlesRef.current) {
      try {
        handle.pause();
      } catch {
        /* already finished */
      }
    }
    try {
      audioRef.current?.pause();
    } catch {
      /* no audio */
    }
    pauseBeginRef.current = getLabEngine().now();
    playingRef.current = false;
    setPlaying(false);
  }, []);

  const resumeAll = useCallback(() => {
    if (playingRef.current || handlesRef.current.length === 0) return;
    for (const handle of handlesRef.current) {
      try {
        handle.resume();
      } catch {
        /* already finished */
      }
    }
    playStartRef.current += getLabEngine().now() - pauseBeginRef.current;
    playingRef.current = true;
    setPlaying(true);
    const audio = audioRef.current;
    if (audio && voiceoverRef.current) {
      try {
        void audio.play().catch(() => {});
      } catch {
        /* autoplay policy */
      }
    }
  }, []);

  /** Read-only beat strip, simulated by the real MCP test path. */
  const refreshBeats = useCallback(async () => {
    try {
      const result = (await bridge("test_animation", {})) as { spans?: BeatSpan[] };
      if (Array.isArray(result.spans)) {
        setBeats(
          result.spans
            .filter((span) => span.kind === "animate" || span.kind === "preset" || span.kind === "timeline")
            .map((span) => ({ opId: span.opId, kind: span.kind, target: span.target, start: span.start, duration: span.duration, end: span.end }))
        );
      }
    } catch {
      /* static preview without the bridge — no beat strip */
    }
  }, []);

  const totalMs = beats.reduce((max, span) => Math.max(max, span.end), 0);
  totalMsRef.current = totalMs;

  useEffect(() => {
    let stopped = false;

    const teardown = () => {
      const engine = getLabEngine();
      for (const controller of scrollers.current) {
        try {
          controller.destroy();
        } catch {
          /* already torn down */
        }
      }
      scrollers.current = [];
      handlesRef.current = [];
      playingRef.current = false;
      setPlaying(false);
      try {
        audioRef.current?.pause();
      } catch {
        /* no audio */
      }
      engine.reset();
    };

    const applyState = (state: MotionState) => {
      appliedRevision.current = state.revision;
      setRevision(state.revision);
      // Empty state and live scene are mutually exclusive: with no voiceover
      // there is no world to show, so the stage stays clear and the empty
      // composition owns the canvas. This is what keeps the headline and the
      // dropzone from ever sharing space with scene content.
      // Export frames (?export=1) are the exception: headless capture has no
      // voiceover by design and must render the published scene.
      if (!voiceoverRef.current && !EXPORT_CLEAN) {
        lastOps.current = [];
        handlesRef.current = [];
        playingRef.current = false;
        setPlaying(false);
        setPositionMs(0);
        setBeats([]);
        totalMsRef.current = 0;
        if (stageRef.current) stageRef.current.innerHTML = "";
        hasSceneRef.current = false;
        setHasScene(false);
        return;
      }
      lastOps.current = state.ops;
      const scenic = state.ops.some((op) => op.kind === "scene");
      hasSceneRef.current = scenic;
      setHasScene(scenic);
      playFromZero();
      void refreshBeats();
    };

    const poll = async () => {
      if (stopped) return;
      try {
        const state = await fetchJson<MotionState>("motion-state.json", 10_000, "state poll");
        if (typeof state.revision !== "number" || !Array.isArray(state.ops)) return;
        if (state.revision === appliedRevision.current) return;
        applyState(state);
      } catch {
        /* dev server hiccup or slow poll — next tick retries */
      }
    };

    const loadLibrary = async () => {
      // The MCP transport only exists on the dev server; a built preview
      // has no bridge, so don't ask (avoids a pointless 404 on load).
      if (!import.meta.env.DEV) return;
      try {
        const result = (await bridge("inspect_animation", {})) as {
          ops?: Array<{ id?: string }>;
          savedAnimations?: SavedEntry[];
        };
        if (Array.isArray(result.savedAnimations) && result.savedAnimations.length > 0) {
          const liveIds = new Set((result.ops ?? []).map((op) => op.id));
          const match = result.savedAnimations.find(
            (entry) => entry.opIds.length > 0 && entry.opIds.every((id) => liveIds.has(id))
          );
          if (match) setAnimName(match.name);
        }
      } catch {
        /* static preview without the bridge */
      }
    };

    void loadLibrary();
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const positionTimer = window.setInterval(() => {
      if (playingRef.current && !stopped) {
        try {
          setPositionMs(Math.max(0, getLabEngine().now() - playStartRef.current));
        } catch {
          /* engine gone */
        }
        // Completion watchdog: the audio element is the timebase. Its ended
        // event is primary (see listeners below); this covers a missed event
        // or an element that never starts (autoplay block, unloadable file)
        // by resolving against the same horizon. Playback always terminates.
        try {
          const audio = audioRef.current;
          const vo = voiceoverRef.current;
          if (audio && vo && audio.src.includes(vo.file) && !audio.error) {
            const durMs = pickDuration([audio.duration * 1000, vo.durationMs]);
            const horizon = Math.max(totalMsRef.current, durMs ?? 0);
            if (audio.ended || (durMs !== null && audio.currentTime >= Math.max(0, durMs / 1000 - 0.25))) {
              finishPlaybackRef.current();
            } else if (horizon > 0 && getLabEngine().now() - playStartRef.current > horizon + 2000) {
              finishPlaybackRef.current();
            }
          }
        } catch {
          /* the watchdog never kills the surface */
        }
      }
    }, 200);
    // Voiceover element lifecycle: finish when the audio finishes, surface a
    // visible error when it fails. Both are terminal for the playback op.
    const audioEl = audioRef.current;
    const onAudioEnded = () => {
      finishPlaybackRef.current();
    };
    const onAudioError = () => {
      if (!voiceoverRef.current) return;
      playingRef.current = false;
      setPlaying(false);
      setStage("error");
      flash("Voiceover audio failed — remove it and try another file");
    };
    audioEl?.addEventListener("ended", onAudioEnded);
    audioEl?.addEventListener("error", onAudioError);
    // Inspector: clicking a stage element reports the ops driving it.
    const stage = stageRef.current;
    const onInspect = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("[data-lab]") as HTMLElement | null;
      if (!anchor) {
        setSelection(null);
        return;
      }
      const key = anchor.id || anchor.getAttribute("data-lab") || anchor.className;
      const hits = lastOps.current.filter((op) => {
        const selector = (op as { target?: string }).target ?? "";
        const first = selector.split(/[\s,>+[~:]/)[0].replace(/^[#.]/, "");
        return first.length > 0 && (anchor.id.includes(first) || anchor.className.includes(first));
      });
      setSelection({ kind: "target", label: key, opIds: hits.map((op) => op.id) });
    };
    stage?.addEventListener("click", onInspect);
    const onVisibility = () => {
      if (document.hidden) {
        try {
          pauseAllRef.current();
        } catch {
          /* nothing playing */
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(positionTimer);
      stage?.removeEventListener("click", onInspect);
      audioEl?.removeEventListener("ended", onAudioEnded);
      audioEl?.removeEventListener("error", onAudioError);
      document.removeEventListener("visibilitychange", onVisibility);
      teardown();
      // Remounts (including StrictMode dev double-mount) replay from initial state.
      appliedRevision.current = -1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pauseAllRef = useRef(pauseAll);
  pauseAllRef.current = pauseAll;

  useEffect(
    () => () => {
      // Invalidate every in-flight audio op: no late continuation may write
      // state after this surface is gone.
      opTokenRef.current.next();
      genOwnerRef.current = null;
      if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
      try {
        recognizer.current?.abort();
      } catch {
        /* recognizer already stopped */
      }
      recognizer.current = null;
    },
    []
  );

  const stopListening = useCallback(() => {
    try {
      recognizer.current?.abort();
    } catch {
      /* recognizer already stopped */
    }
    recognizer.current = null;
    setListening(false);
  }, []);

  /** Spoken instructions take the same plan→publish path as text. */
  const runBrief = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      try {
        const plan = (await bridge("plan_animation", { brief: trimmed, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL })) as {
          ok?: boolean;
          id?: string;
        };
        if (!plan.ok || typeof plan.id !== "string") {
          flash("Plan rejected by validation");
          return;
        }
        const published = (await bridge("publish_plan", { id: plan.id })) as { ok?: boolean; revision?: number };
        flash(published.ok ? `Published · REV ${published.revision ?? "?"}` : "Plan rejected by validation");
      } catch {
        flash("MCP unavailable in static preview");
      } finally {
        setBusy(false);
      }
    },
    [busy, flash]
  );

  useEffect(() => {
    runInstructionRef.current = (text: string) => runBrief(text);
  }, [runBrief]);

  const toggleListening = useCallback(() => {
    if (listening) {
      stopListening();
      return;
    }
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      flash("Voice input needs a browser with SpeechRecognition");
      return;
    }
    try {
      const active = new Ctor();
      active.lang = "en-US";
      active.interimResults = true;
      recognizer.current = active;
      active.onresult = (event) => {
        let settled = "";
        for (let index = 0; index < event.results.length; index++) {
          const alternative = event.results[index][0];
          if (!alternative) continue;
          if (event.results[index].isFinal) settled += alternative.transcript;
        }
        if (settled.trim()) {
          stopListening();
          void runInstructionRef.current(settled.trim());
        }
      };
      active.onerror = (event) => {
        stopListening();
        if (event.error !== "aborted") flash("Voice capture failed");
      };
      active.onend = () => {
        recognizer.current = null;
        setListening(false);
      };
      active.start();
      setListening(true);
    } catch {
      flash("Voice capture failed");
    }
  }, [listening, stopListening, flash]);

  const runInstructionRef = useRef<(text: string) => Promise<void>>(async () => {});
  // Assigned above via effect; declared here to keep hook order stable.

  const decodePeaks = useCallback(async (bytes: ArrayBuffer): Promise<{ durationMs: number; peaks: number[] }> => {
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Audio decoding unavailable.");
    const context = new Ctor();
    try {
      // Bounded: a corrupt or pathological file cannot hold the upload forever.
      const decoded = await withTimeout(context.decodeAudioData(bytes.slice(0)), DECODE_TIMEOUT_MS, "audio decode");
      const channel = decoded.getChannelData(0);
      const buckets = 64;
      const peaks: number[] = [];
      for (let index = 0; index < buckets; index++) {
        const start = Math.floor((channel.length * index) / buckets);
        const end = Math.floor((channel.length * (index + 1)) / buckets);
        let peak = 0;
        for (let sample = start; sample < end; sample += 7) {
          const value = Math.abs(channel[sample] ?? 0);
          if (value > peak) peak = value;
        }
        peaks.push(Math.min(1, peak * 1.4));
      }
      return { durationMs: Math.round((decoded.length / decoded.sampleRate) * 1000), peaks };
    } finally {
      try {
        await context.close();
      } catch {
        /* already closed */
      }
    }
  }, []);

  const uploadVoiceover = useCallback(
    async (file: File) => {
      // Exactly one active audio operation: reloading audio cancels whatever
      // the previous upload/generation was still doing.
      const op = opTokenRef.current.next();
      genOwnerRef.current = null;
      setGenPhase(null);
      setStage("loading");
      setBusy(true);
      const alive = () => opTokenRef.current.alive(op);
      let handedOff = false;
      try {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
        if (!VOICEOVER_EXTENSIONS.includes(ext)) {
          throw new Error("Voiceover must be MP3, WAV, M4A, or AAC.");
        }
        if (file.size === 0 || file.size > VOICEOVER_BYTES_MAX) {
          throw new Error("Voiceover must be non-empty and under 50MB.");
        }
        const bytes = await withTimeout(file.arrayBuffer(), 15_000, "audio read");
        if (!alive()) return;
        // Duration from actual media, two independent witnesses raced: the
        // decoded buffer and the container metadata. First usable value wins.
        const [decodedOutcome, probedOutcome] = await Promise.all([
          decodePeaks(bytes).then(
            (value) => ({ ok: true as const, value }),
            () => ({ ok: false as const })
          ),
          probeFileDuration(file).then(
            (value) => ({ ok: true as const, value }),
            () => ({ ok: false as const })
          )
        ]);
        if (!alive()) return;
        const durationMs = pickDuration([
          decodedOutcome.ok ? decodedOutcome.value.durationMs : null,
          probedOutcome.ok ? probedOutcome.value : null
        ]);
        if (durationMs === null) {
          throw new Error("Could not read this file's audio duration — try another file.");
        }
        const peaks = decodedOutcome.ok ? decodedOutcome.value.peaks : [];
        let binary = "";
        const view = new Uint8Array(bytes);
        const chunk = 8192;
        for (let offset = 0; offset < view.length; offset += chunk) {
          binary += String.fromCharCode(...view.subarray(offset, offset + chunk));
        }
        const uploadedBody = await fetchJson<{ ok: boolean; id?: string; file?: string; durationMs?: number; error?: string }>(
          "/__lab/voiceover",
          30_000,
          "voiceover upload",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: file.name, dataUrl: `data:audio/mpeg;base64,${btoa(binary)}`, durationMs })
          }
        );
        if (!alive()) return;
        if (!uploadedBody.ok || !uploadedBody.id) throw new Error(uploadedBody.error ?? "Voiceover upload failed.");
        const uploaded: Voiceover = { id: uploadedBody.id, file: uploadedBody.file ?? file.name, durationMs: uploadedBody.durationMs ?? durationMs, peaks };
        setVoiceover(uploaded);
        setVoiceoverOpen(false);
        setStage("processing");
        handedOff = true;
        flash(`Voiceover ready · ${formatClock(uploaded.durationMs)}`);
        void generateFromVoiceover(uploaded, op);
      } catch (error) {
        if (!alive()) return; // superseded — the newer op owns the surface now
        flash(error instanceof Error ? error.message : "Voiceover upload failed");
        setStage("error");
      } finally {
        // A handed-off upload leaves busy to its generation; a superseded or
        // failed one always releases it. Nothing stays busy forever.
        if (alive() && !handedOff) setBusy(false);
      }
    },
    [decodePeaks, flash, setStage]
  );

  const removeVoiceover = useCallback(() => {
    // Cancelling invalidates every in-flight upload/generation continuation.
    opTokenRef.current.next();
    genOwnerRef.current = null;
    setGenPhase(null);
    setBusy(false);
    try {
      audioRef.current?.pause();
    } catch {
      /* no audio */
    }
    // Clearing the voiceover returns to the empty state: the stage goes with
    // it so the empty composition never overlaps a leftover scene.
    lastOps.current = [];
    handlesRef.current = [];
    playingRef.current = false;
    setPlaying(false);
    setPositionMs(0);
    setBeats([]);
    totalMsRef.current = 0;
    if (stageRef.current) stageRef.current.innerHTML = "";
    hasSceneRef.current = false;
    setHasScene(false);
    setStage("idle");
    setVoiceover(null);
    setVoiceoverOpen(false);
  }, [setStage]);

  /** Voiceover → MCP pipeline: transcribe (or detect) → beats → plan → publish. */
  const generateFromVoiceover = useCallback(
    async (vo: Voiceover, op?: number) => {
      // Ownership, not a boolean latch: a newer audio op has already
      // invalidated any predecessor, so nothing here can wedge reloads.
      const owned = op ?? opTokenRef.current.next();
      if (!opTokenRef.current.alive(owned)) return;
      genOwnerRef.current = owned;
      const alive = () => opTokenRef.current.alive(owned) && genOwnerRef.current === owned;
      setBusy(true);
      setStage("processing");
      const readLiveRev = async (): Promise<number> => {
        try {
          const state = await fetchJson<{ revision?: unknown }>("motion-state.json", 15_000, "state read");
          return typeof state.revision === "number" ? state.revision : -1;
        } catch {
          return -1;
        }
      };
      const startRev = await readLiveRev();
      if (!alive()) return;
      try {
        setGenPhase("UNDERSTANDING");
        let brief = "";
        let beats: Array<{ startMs: number; endMs: number; text: string }> = [];
        try {
          const transcribed = (await bridge("transcribe_voiceover", { id: vo.id })) as {
            ok?: boolean;
            segments?: Array<{ startMs: number; endMs: number; text: string }>;
          };
          if (transcribed.ok && Array.isArray(transcribed.segments) && transcribed.segments.length > 0) {
            beats = transcribed.segments;
            brief = transcribed.segments.map((segment) => segment.text).join(". ");
          }
        } catch {
          /* gated or unreachable — fall through to structural beats */
        }
        if (!alive()) return;
      if (beats.length === 0) {
        const detected = (await bridge("detect_beats", { id: vo.id, beats: 6 })) as {
            ok?: boolean;
            segments?: Array<{ startMs: number; endMs: number }>;
          };
          if (!detected.ok || !Array.isArray(detected.segments) || detected.segments.length === 0) {
            throw new Error("Beat detection failed.");
          }
          const cycle = ["orb pulse", "crm entrance", "notebook reveal", "workflow sequence", "hero finale", "orb disperse"];
          brief = detected.segments.map((segment, index) => `${cycle[index % cycle.length]} (${Math.round(segment.startMs / 1000)}s)`).join(". ");
          beats = detected.segments.map((segment) => ({ ...segment, text: "" }));
        }
        if (!alive()) return;
        setGenPhase("BUILDING THE STORY");
        // Absolute voiceover timing wins: pin beats to their segment starts.
        const analyzed = (await bridge("analyze_narration", {
          transcript: brief,
          durationMs: vo.durationMs,
          segments: beats.map((beat) => ({ startMs: beat.startMs, endMs: beat.endMs, text: beat.text ?? "" }))
        })) as { ok?: boolean; beats?: Array<{ startMs: number; text: string; label: string }> };
        if (!alive()) return;
        const pins = Array.isArray(analyzed.beats) && analyzed.beats.length > 0 ? analyzed.beats : undefined;
        setGenPhase("DESIGNING THE MOTION");
        const plan = (await bridge("plan_animation", {
          brief,
          durationMs: vo.durationMs,
          provider: DEFAULT_PROVIDER,
          model: DEFAULT_MODEL,
          ...(pins ? { segments: pins.map((beat) => ({ startMs: beat.startMs, text: beat.text, label: beat.label })) } : {})
        })) as {
          ok?: boolean;
          id?: string;
        };
        if (!alive()) return;
        if (!plan.ok || typeof plan.id !== "string") throw new Error("Plan rejected by validation.");
        setGenPhase("COMPOSING");
        // Publish only onto the state this run started from — a newer
        // revision means fresher work landed first, so yield to it.
        if ((await readLiveRev()) !== startRev) {
          if (!alive()) return;
          flash("Superseded by newer work — keeping the latest");
          setStage(hasSceneRef.current ? "playing" : "idle");
          return;
        }
        if (!alive()) return;
        const published = (await bridge("publish_plan", { id: plan.id })) as { ok?: boolean; revision?: number };
        if (!published.ok) throw new Error("Plan rejected by validation.");
        if (!alive()) return;
        setAnimName(`voiceover-${vo.id}`);
        setStage("playing");
        flash(`Created from voiceover · REV ${published.revision ?? "?"}`);
      } catch (error) {
        if (!alive()) return; // superseded — the newer op owns the surface now
        flash(error instanceof Error ? error.message : "Generation failed");
        setStage("error");
      } finally {
        // Only the current owner releases shared flags; a superseded run
        // must not clear its successor's busy/phase.
        if (opTokenRef.current.alive(owned) && genOwnerRef.current === owned) {
          genOwnerRef.current = null;
          setGenPhase(null);
          setBusy(false);
        }
      }
    },
    [flash, setStage]
  );

  const downloadVideo = useCallback(
    async (orientation: "landscape" | "vertical") => {
      if (busy) return;
      setBusy(true);
      const previous = lifecycleRef.current;
      setStage("exporting");
      flash("EXPORTING VIDEO...");
      try {
        // Bounded: capture + transcode is minutes of server work, never infinite.
        // The voiceover travels with the export so the MP4 is never silent.
        const body = await fetchJson<{ ok: boolean; file?: string; filename?: string; error?: string }>(
          "/__lab/export-video",
          EXPORT_TIMEOUT_MS,
          "video export",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ format: "mp4", orientation, narration: voiceoverRef.current?.id ?? null })
          }
        );
        if (!body.ok || !body.file) throw new Error(body.error ?? "Video export failed.");
        const anchor = document.createElement("a");
        anchor.href = body.file;
        anchor.download = body.filename ?? "motion-lab.webm";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setExportOpen(false);
        if (lifecycleRef.current === "exporting") setStage(previous === "exporting" ? "idle" : previous);
        flash("VIDEO READY");
      } catch (error) {
        if (lifecycleRef.current === "exporting") setStage("error");
        flash(error instanceof TimeoutError ? error.message : error instanceof Error ? error.message : "Video export needs the dev server");
      } finally {
        setBusy(false);
      }
    },
    [busy, flash, setStage]
  );

  // Waveform paints from decoded peaks whenever the panel opens.
  useEffect(() => {
    if (!voiceoverOpen || !voiceover) return;
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const peaks = voiceover.peaks.length > 0 ? voiceover.peaks : [0.2];
    const barWidth = width / peaks.length;
    context.fillStyle = "#8e8e96";
    peaks.forEach((peak, index) => {
      const barHeight = Math.max(1, peak * height);
      context.fillRect(index * barWidth, (height - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
    });
  }, [voiceoverOpen, voiceover]);

  if (EXPORT_CLEAN) {
    return (
      <div className="lab-void">
        <div id="lab-stage" ref={stageRef} aria-hidden="true" />
      </div>
    );
  }

  if (view === "ai") {
    // AI Motion is an additional capability: the Lab surface below is
    // untouched — this branch only swaps which workspace owns the viewport.
    return (
      <div className="lab-void">
        <div className="lab-mark">WAVES MOTION LAB</div>
        <nav className="lab-viewswitch" aria-label="Workspace">
          <button type="button" onClick={() => setView("lab")}>LAB</button>
          <button type="button" className="active" aria-current="page">AI MOTION</button>
          <button type="button" onClick={() => setView("gsap")}>GSAP</button>
        </nav>
        <AiMotion />
      </div>
    );
  }

  if (view === "gsap") {
    // GSAP workspace: deterministic browser animation track, same pattern —
    // only the viewport owner changes.
    return (
      <div className="lab-void">
        <div className="lab-mark">WAVES MOTION LAB</div>
        <nav className="lab-viewswitch" aria-label="Workspace">
          <button type="button" onClick={() => setView("lab")}>LAB</button>
          <button type="button" onClick={() => setView("ai")}>AI MOTION</button>
          <button type="button" className="active" aria-current="page">GSAP</button>
        </nav>
        <GsapLab />
      </div>
    );
  }

  const selectedOp = selection?.kind === "op" ? lastOps.current.find((op) => op.id === selection.opIds[0]) ?? null : null;
  const selectedTargetOps = selection?.kind === "target" ? lastOps.current.filter((op) => selection.opIds.includes(op.id)) : [];

  return (
    <div className="lab-void" data-lifecycle={lifecycle}>
      <div className="lab-mark">WAVES MOTION LAB</div>
      <nav className="lab-viewswitch" aria-label="Workspace">
        <button type="button" className="active" aria-current="page">LAB</button>
        <button type="button" onClick={() => setView("ai")}>AI MOTION</button>
        <button type="button" onClick={() => setView("gsap")}>GSAP</button>
      </nav>
      <div id="lab-stage" ref={stageRef} aria-hidden="true" />
      <audio ref={audioRef} src={voiceover ? `/__lab/voiceovers/${voiceover.file}` : undefined} preload="auto" />

      {!voiceover && !hasScene && !busy && !genPhase ? (
        <div className="lab-empty" aria-label="Create from voice">
          <div className="lab-empty-inner">
            <div className="lab-empty-eyebrow">
              <div className="lab-empty-mark">WAVES</div>
              <div className="lab-empty-lab">MOTION LAB</div>
            </div>
            <h1 className="lab-empty-headline">Motion, engineered.</h1>
            <p className="lab-empty-sub">Create from your voiceover.</p>
            <button
              type="button"
              className="lab-dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files?.[0];
                if (file) void uploadVoiceover(file);
              }}
            >
              <div className="lab-dropzone-title">VOICEOVER</div>
              <div className="lab-dropzone-sub">Drop your voiceover here</div>
              <div className="lab-dropzone-or">or</div>
              <div className="lab-dropzone-choose">Choose audio file</div>
              <div className="lab-dropzone-formats">MP3 · WAV · M4A · AAC</div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp3,.wav,.m4a,.aac,audio/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadVoiceover(file);
              }}
            />
          </div>
        </div>
      ) : null}

      {genPhase ? (
        <div className="lab-generating" aria-live="polite">
          <div className="lab-generating-phase">{genPhase}</div>
        </div>
      ) : null}

      {voiceover ? (
        <div className="lab-hoverzone" aria-label="Playback controls">
          <div className="lab-float">
            <button type="button" className="lab-tbtn" onClick={() => (playing ? pauseAll() : lifecycle === "complete" ? playFromZero() : resumeAll())} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❚❚" : "▶"}
            </button>
            <button type="button" className="lab-tbtn" onClick={playFromZero} aria-label="Replay from start">
              ⟲
            </button>
            <button
              type="button"
              className={`lab-mic${listening ? " lab-mic-live" : ""}`}
              onClick={toggleListening}
              disabled={!voiceSupported || busy}
              title={voiceSupported ? "Speak an instruction" : "Voice input needs a browser with SpeechRecognition"}
              aria-label="Speak an instruction"
              aria-pressed={listening}
            >
              <span className="lab-mic-dot" aria-hidden="true" />
            </button>
            <button type="button" className="lab-micro" onClick={() => setVoiceoverOpen((open) => !open)} aria-label="Voiceover panel">
              Voiceover
            </button>
            <button type="button" className="lab-micro" onClick={() => setExportOpen((open) => !open)} aria-label="Export">
              Export
            </button>
            <span className="lab-time">
              {formatClock(positionMs)} / {formatClock(totalMs)}
            </span>
          </div>
          {exportOpen ? (
            <div className="lab-export-menu" role="menu" aria-label="Export format">
              <button type="button" className="lab-micro" role="menuitem" onClick={() => void downloadVideo("vertical")} disabled={busy}>
                9:16 Reel · 1080 × 1920 · 60 FPS
              </button>
              <button type="button" className="lab-micro" role="menuitem" onClick={() => void downloadVideo("landscape")} disabled={busy}>
                16:9 · 1920 × 1080 · 60 FPS
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {voiceover ? (
        <button type="button" className="lab-vo-indicator" onClick={() => setVoiceoverOpen((open) => !open)} aria-label="Voiceover details">
          <span className="lab-vo-dot" aria-hidden="true">◉</span> VOICEOVER&nbsp;&nbsp;{voiceover.file}
        </button>
      ) : null}

      {voiceover && voiceoverOpen ? (
        <div className="lab-vo-panel" role="dialog" aria-label="Voiceover">
          <canvas ref={waveCanvasRef} width={280} height={56} className="lab-wave" aria-label="Voiceover waveform" />
          <div className="lab-vo-row">
            <span>{formatClock(voiceover.durationMs)}</span>
            <label className="lab-vo-volume">
              Volume
              <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(event) => {
                const next = Number(event.target.value);
                setVolume(next);
                if (audioRef.current) audioRef.current.volume = next;
              }} />
            </label>
          </div>
          <div className="lab-vo-row">
            <button type="button" className="lab-micro" onClick={() => fileInputRef.current?.click()}>
              Replace audio
            </button>
            <button type="button" className="lab-micro" onClick={removeVoiceover}>
              Remove audio
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,.wav,.m4a,.aac,audio/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadVoiceover(file);
            }}
          />
        </div>
      ) : null}

      {selection ? (
        <div className="lab-overlay-inspector" role="dialog" aria-label="Selection">
          <div className="lab-inspector-title">{selection.kind === "op" ? "OPERATION" : "OBJECT"}</div>
          <div className="lab-inspector-target">{selection.label}</div>
          {selection.kind === "op" && selectedOp ? (
            <div className="lab-op-row">
              <div className="lab-op-id">{selectedOp.id}</div>
              <div className="lab-op-timing">{opTiming(selectedOp)}</div>
            </div>
          ) : null}
          {selection.kind === "target"
            ? selectedTargetOps.slice(0, 4).map((op) => (
                <div key={op.id} className="lab-op-row">
                  <div className="lab-op-id">{op.id}</div>
                  <div className="lab-op-timing">{opTiming(op)}</div>
                </div>
              ))
            : null}
          <button type="button" className="lab-micro" onClick={() => setSelection(null)}>
            Close
          </button>
        </div>
      ) : null}

      {status ? <div className="lab-status">{status}</div> : null}
    </div>
  );
}
