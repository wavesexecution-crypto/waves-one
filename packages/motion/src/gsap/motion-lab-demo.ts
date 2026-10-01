/**
 * WAVES Motion Lab — Product Demo Reel.
 *
 * BRIEF → MOTION → RENDER workflow demonstration.
 *
 * 12 seconds exactly, 5 labelled scenes, master timeline.
 *
 * Design contract:
 *   - one master timeline, total exactly 12000ms
 *   - five required scene labels: brief, transition, motion, render, final
 *   - labels land on composed read-beats for reduced-motion stepping
 *   - no ambient ops — finite, completes, holds, reverses
 *   - no ScrollTrigger; parallax via timeline tweens at ease "none"
 *   - progress rail is a 12.000s linear tween anchoring totalMs
 *
 * Real assets only: the MOTION scene shows actual SEAI demo pages captured
 * from the real SEAI project at this artboard size, and the BRIEF scene shows
 * the real MCP tool call and spec shape.
 */

import type { GsapOp, GsapSceneSpec, GsapVars } from "./spec";

export const MOTION_LAB_DEMO_NAME = "motion-lab-demo";
export const MOTION_LAB_DEMO_MS = 12000;
export const MOTION_LAB_DEMO_W = 1080;
export const MOTION_LAB_DEMO_H = 1920;
export const MOTION_LAB_DEMO_STAGE_VERSION = 1;

export const MOTION_LAB_DEMO_SCENES = [
  { label: "brief", at: 1.2 },
  { label: "transition", at: 2.6 },
  { label: "motion", at: 5.4 },
  { label: "render", at: 9.2 },
  { label: "final", at: 11.4 }
] as const;

const split = (key: string): string => `[data-split="${key}"]`;
const shot = (index: number): string => `.mld-shot:nth-child(${index})`;

interface Cue {
  /** Seconds from t=0. */
  at: number;
  d?: number;
  ease?: string;
  from: GsapVars;
  to: GsapVars;
}

interface StaggerCue extends Cue {
  each: number;
  /** Stagger origin; distinct from the `from` property bag. */
  origin?: "first" | "last" | "center" | "edges" | "random";
}

interface TextCue extends Cue {
  split?: "chars" | "words";
  each: number;
}

const ops: GsapOp[] = [];
const push = (op: GsapOp): void => {
  ops.push(op);
};

/** Initial state. `at` defaults to 0 so nothing is ever visible pre-build. */
function set(id: string, target: string, to: GsapVars, at = 0): void {
  push({ id, type: "set", target, to, position: at });
}

/**
 * A beat marker. Carries a scene label and writes one inert custom property, so
 * a reduced-motion step lands on a finished frame instead of a half-played
 * transition — without inventing motion that the choreography does not have.
 */
function mark(id: string, target: string, at: number, label: string): void {
  push({ id, type: "set", target, to: { "--mld-beat": 1 }, position: at, label });
}

function tween(id: string, target: string, cue: Cue): void {
  push({
    id,
    type: "tween",
    target,
    from: cue.from,
    to: cue.to,
    duration: cue.d ?? 0.6,
    ease: cue.ease ?? "power3.out",
    position: cue.at
  });
}

function stagger(id: string, target: string, cue: StaggerCue): void {
  push({
    id,
    type: "stagger",
    target,
    from: cue.from,
    to: cue.to,
    duration: cue.d ?? 0.5,
    ease: cue.ease ?? "power3.out",
    stagger: { each: cue.each, from: cue.origin ?? "first" },
    position: cue.at
  });
}

function text(id: string, target: string, cue: TextCue): void {
  push({
    id,
    type: "text",
    target,
    split: cue.split ?? "chars",
    from: cue.from,
    to: cue.to,
    duration: cue.d ?? 0.5,
    ease: cue.ease ?? "expo.out",
    stagger: cue.each,
    position: cue.at
  });
}

// ---------------------------------------------------------------------------
// Persistent progress rail — anchors totalMs to exactly 12000ms
// ---------------------------------------------------------------------------

tween("progress-rail", ".mld-progress", {
  at: 0,
  d: MOTION_LAB_DEMO_MS / 1000,
  ease: "none",
  from: { scaleX: 0 },
  to: { scaleX: 1 }
});

// ---------------------------------------------------------------------------
// 01 BRIEF — 0.00 / 1.50
// ---------------------------------------------------------------------------

set("brief-on", ".mld-s-brief", { opacity: 1 });
set("brief-term", ".mld-terminal", { opacity: 0, y: 30 });
set("brief-term-chrome", ".mld-term-chrome", { opacity: 0 });
set("brief-prompt", ".mld-prompt", { opacity: 0, x: -20 });
set("brief-output", ".mld-output", { opacity: 0 });
set("brief-label", ".mld-s-brief .mld-label", { opacity: 0 });

tween("brief-term-in", ".mld-terminal", { at: 0.12, d: 0.6, ease: "power3.out", from: { opacity: 0, y: 30 }, to: { opacity: 1, y: 0 } });
tween("brief-chrome-in", ".mld-term-chrome", { at: 0.2, d: 0.4, ease: "power2.out", from: { opacity: 0 }, to: { opacity: 1 } });
tween("brief-prompt-in", ".mld-prompt", { at: 0.28, d: 0.4, ease: "power2.out", from: { opacity: 0, x: -20 }, to: { opacity: 1, x: 0 } });

text("brief-cmd", split("mld-cmd-a"), {
  at: 0.38, d: 0.5, each: 0.018,
  from: { opacity: 0, y: 18 },
  to: { opacity: 1, y: 0 }
});

text("brief-name", split("mld-brief-name"), {
  at: 0.45, d: 0.45, each: 0.014,
  from: { opacity: 0, x: 24 },
  to: { opacity: 1, x: 0 }
});

text("brief-desc", split("mld-brief-desc"), {
  at: 0.55, d: 0.45, each: 0.014,
  from: { opacity: 0, x: 24 },
  to: { opacity: 1, x: 0 }
});

text("brief-format", split("mld-brief-format"), {
  at: 0.65, d: 0.45, each: 0.014,
  from: { opacity: 0, x: 24 },
  to: { opacity: 1, x: 0 }
});

text("brief-orient", split("mld-brief-orient"), {
  at: 0.75, d: 0.45, each: 0.014,
  from: { opacity: 0, x: 24 },
  to: { opacity: 1, x: 0 }
});

tween("brief-label-in", ".mld-s-brief .mld-label", { at: 0.85, d: 0.25, ease: "power2.out", from: { opacity: 0, y: 16 }, to: { opacity: 1, y: 0 } });

mark("brief-beat", ".mld-s-brief", 1.2, "brief");

// The scene's work is done; its container leaves before the next scene's
// content arrives. A `set` is seek-safe (seeking back reverts it), so reduced
// motion and reverse keep working. Without these, finished scenes stack up
// and the final lockup plays over the render card.
set("brief-off", ".mld-s-brief", { opacity: 0 }, 1.46);

// ---------------------------------------------------------------------------
// 02 TRANSITION — 1.50 / 3.00
// ---------------------------------------------------------------------------

set("trans-on", ".mld-s-transition", { opacity: 1 }, 1.48);
set("trans-brief-side", ".mld-side-left", { opacity: 0, x: -30 }, 1.48);
set("trans-motion-side", ".mld-side-right", { opacity: 0, x: 30 }, 1.48);
set("trans-arrow", ".mld-arrow", { opacity: 0, scale: 0.6 }, 1.48);

tween("trans-brief-in", ".mld-side-left", { at: 1.5, d: 0.48, ease: "expo.out", from: { opacity: 0, x: -30 }, to: { opacity: 1, x: 0 } });
tween("trans-arrow-in", ".mld-arrow", { at: 1.55, d: 0.4, ease: "back.out(1.4)", from: { opacity: 0, scale: 0.6 }, to: { opacity: 1, scale: 1 } });
tween("trans-motion-in", ".mld-side-right", { at: 1.6, d: 0.48, ease: "expo.out", from: { opacity: 0, x: 30 }, to: { opacity: 1, x: 0 } });

text("trans-word-brief", split("mld-word-brief"), {
  at: 1.58, d: 0.5, each: 0.022,
  from: { yPercent: 110, opacity: 0, rotateX: -65 },
  to: { yPercent: 0, opacity: 1, rotateX: 0 }
});

text("trans-word-motion", split("mld-word-motion"), {
  at: 1.68, d: 0.5, each: 0.022,
  from: { yPercent: 110, opacity: 0, rotateX: -65 },
  to: { yPercent: 0, opacity: 1, rotateX: 0 }
});

tween("trans-tag-brief-in", ".mld-side-left .mld-tag", { at: 1.6, d: 0.3, ease: "power2.out", from: { opacity: 0, y: 12 }, to: { opacity: 1, y: 0 } });
tween("trans-tag-motion-in", ".mld-side-right .mld-tag", { at: 1.7, d: 0.3, ease: "power2.out", from: { opacity: 0, y: 12 }, to: { opacity: 1, y: 0 } });

mark("trans-beat", ".mld-s-transition", 2.6, "transition");

set("trans-off", ".mld-s-transition", { opacity: 0 }, 2.96);

// ---------------------------------------------------------------------------
// 03 MOTION — 3.00 / 7.50 : the real SEAI demo captures
// ---------------------------------------------------------------------------

set("mot-on", ".mld-s-motion", { opacity: 1 }, 2.98);
set("mot-tag", ".mld-s-motion .mld-tag", { opacity: 0, x: -30 }, 2.98);
set("mot-carousel", ".mld-carousel", { opacity: 0 }, 2.98);

tween("mot-tag-in", ".mld-s-motion .mld-tag", { at: 3.0, d: 0.4, ease: "power3.out", from: { opacity: 0, x: -30 }, to: { opacity: 1, x: 0 } });

// Four real captures, revealed by clip rather than faded: the mask is what
// makes them read as sites passing through a viewport.
for (let i = 1; i <= 4; i += 1) {
  set(`mot-shot-set-${i}`, shot(i), { opacity: 0, clipPath: "inset(100% 0% 0% 0%)", scale: 0.96 }, 3.1);
}

stagger("mot-shots-in", ".mld-shot", {
  at: 3.2,
  d: 0.55,
  each: 0.11,
  ease: "expo.out",
  from: { opacity: 0, clipPath: "inset(100% 0% 0% 0%)", scale: 0.96 },
  to: { opacity: 1, clipPath: "inset(0% 0% 0% 0%)", scale: 1 }
});

tween("mot-carousel-in", ".mld-carousel", { at: 3.2, d: 0.5, ease: "power3.out", from: { opacity: 0 }, to: { opacity: 1 } });

mark("mot-beat", ".mld-s-motion", 5.4, "motion");

tween("mot-carousel-out", ".mld-carousel", { at: 6.8, d: 0.4, ease: "power2.in", from: { opacity: 1 }, to: { opacity: 0, y: -40 } });
tween("mot-tag-out", ".mld-s-motion .mld-tag", { at: 6.9, d: 0.25, ease: "power2.in", from: { opacity: 1 }, to: { opacity: 0 } });

set("mot-off", ".mld-s-motion", { opacity: 0 }, 7.46);

// ---------------------------------------------------------------------------
// 04 RENDER — 7.50 / 9.50
// ---------------------------------------------------------------------------

set("ren-on", ".mld-s-render", { opacity: 1 }, 7.48);
set("ren-card", ".mld-render-card", { opacity: 0, y: 40, scale: 0.96 }, 7.48);
set("ren-header", ".mld-render-header", { opacity: 0 }, 7.48);
set("ren-btn", ".mld-download-btn", { opacity: 0, y: 24 }, 7.48);
set("ren-tag", ".mld-s-render .mld-tag", { opacity: 0, y: 24 }, 7.48);

tween("ren-card-in", ".mld-render-card", { at: 7.5, d: 0.6, ease: "expo.out", from: { opacity: 0, y: 40, scale: 0.96 }, to: { opacity: 1, y: 0, scale: 1 } });
tween("ren-header-in", ".mld-render-header", { at: 7.6, d: 0.45, ease: "power3.out", from: { opacity: 0, y: -20 }, to: { opacity: 1, y: 0 } });

stagger("ren-specs-in", ".mld-spec", {
  at: 7.7,
  d: 0.4,
  each: 0.04,
  origin: "first",
  ease: "power3.out",
  from: { opacity: 0, x: -20 },
  to: { opacity: 1, x: 0 }
});

tween("ren-btn-in", ".mld-download-btn", { at: 8.1, d: 0.45, ease: "back.out(1.4)", from: { opacity: 0, y: 24 }, to: { opacity: 1, y: 0 } });
tween("ren-tag-in", ".mld-s-render .mld-tag", { at: 8.2, d: 0.3, ease: "power2.out", from: { opacity: 0, y: 24 }, to: { opacity: 1, y: 0 } });

mark("ren-beat", ".mld-s-render", 9.2, "render");

tween("ren-card-drift", ".mld-render-card", { at: 7.5, d: 2.5, ease: "none", from: { y: 0 }, to: { y: -8 } });

set("ren-off", ".mld-s-render", { opacity: 0 }, 9.46);

// ---------------------------------------------------------------------------
// 05 FINAL — 9.50 / 12.00
// ---------------------------------------------------------------------------

set("fin-on", ".mld-s-final", { opacity: 1 }, 9.48);
set("fin-mark", ".mld-mark", { opacity: 0, scale: 0.7, y: -40 }, 9.48);
set("fin-sub", ".mld-subtitle", { opacity: 0, y: 40 }, 9.48);
set("fin-footer", ".mld-footer", { opacity: 0, y: 40 }, 9.48);

tween("fin-mark-in", ".mld-mark", { at: 9.5, d: 0.6, ease: "expo.out", from: { opacity: 0, scale: 0.7, y: -40 }, to: { opacity: 1, scale: 1, y: 0 } });

text("fin-title", split("mld-title"), {
  at: 9.7, d: 0.62, each: 0.018,
  from: { yPercent: 90, opacity: 0, rotateX: -55 },
  to: { yPercent: 0, opacity: 1, rotateX: 0 }
});

tween("fin-sub-in", ".mld-subtitle", { at: 9.9, d: 0.5, ease: "power2.out", from: { opacity: 0, y: 40 }, to: { opacity: 1, y: 0 } });
tween("fin-footer-in", ".mld-footer", { at: 10.2, d: 0.45, ease: "power2.out", from: { opacity: 0, y: 40 }, to: { opacity: 1, y: 0 } });

mark("fin-beat", ".mld-s-final", 11.4, "final");

/** The published, validated spec. `saveGsapSpec` still re-validates it. */
export function buildMotionLabDemo(): GsapSceneSpec {
  return {
    version: 1,
    name: MOTION_LAB_DEMO_NAME,
    description:
      "WAVES Motion Lab product demo — BRIEF → MOTION → RENDER. 12s vertical reel demonstrating the actual product workflow.",
    defaults: { duration: 0.5, ease: "power3.out" },
    ops
  };
}
