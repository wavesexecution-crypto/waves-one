/**
 * WAVES brand film — the 19-second flagship GSAP scene.
 *
 * Authored here (not hand-written JSON) because the film is choreography:
 * ~170 ops across eight labelled scenes that must land on exact beats. The
 * helpers below keep the op list readable while `saveGsapSpec` still runs the
 * real validator, so a bad beat can never reach `.motion/gsap/`.
 *
 * Design contract, enforced by `packages/motion-lab-mcp/src/brand-film.test.ts`:
 *   - one deterministic master timeline, total exactly 19000ms
 *   - every scene carries a label; labels sit on the real scene start
 *   - no `ambient` ops — the film is finite so it completes, holds, and reverses
 *   - no ScrollTrigger: scroll/parallax/scrub are expressed as timeline tweens
 *     (linear `ease: "none"` = a scrub, layered offsets = real parallax) so the
 *     19s timing is reproducible and scrub-safe inside a paused timeline
 *   - the final frame is a clean lockup, which is also the reduced-motion frame
 */

import type { GsapOp, GsapSceneSpec, GsapVars } from "./spec";

export const BRAND_FILM_NAME = "waves-brand-film-19s";
export const BRAND_FILM_MS = 19000;

interface Cue {
  /** Seconds from t=0. */
  at: number;
  d?: number;
  ease?: string;
  from: GsapVars;
  to: GsapVars;
  label?: string;
}

interface StaggerCue extends Cue {
  each: number;
  /** Stagger origin; distinct from the `from` property bag. */
  origin?: "first" | "last" | "center" | "edges" | "random";
}

const ops: GsapOp[] = [];
const push = (op: GsapOp): void => {
  ops.push(op);
};

/** Initial state. `at` defaults to 0 so nothing is ever visible pre-build. */
function set(id: string, target: string, to: GsapVars, at = 0): void {
  push({ id, type: "set", target, to, position: at });
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
    position: cue.at,
    ...(cue.label ? { label: cue.label } : {})
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
    position: cue.at,
    ...(cue.label ? { label: cue.label } : {})
  });
}

interface TextCue extends Cue {
  split: "chars" | "words";
  each: number;
}

function text(id: string, target: string, cue: TextCue): void {
  push({
    id,
    type: "text",
    target,
    split: cue.split,
    from: cue.from,
    to: cue.to,
    duration: cue.d ?? 0.5,
    ease: cue.ease ?? "expo.out",
    stagger: cue.each,
    position: cue.at,
    ...(cue.label ? { label: cue.label } : {})
  });
}

interface SpringCue extends Cue {
  preset: "gentle" | "snappy" | "deliberate" | "signature";
}

function spring(id: string, target: string, cue: SpringCue): void {
  push({
    id,
    type: "spring",
    target,
    from: cue.from,
    to: cue.to,
    duration: cue.d ?? 0.9,
    spring: cue.preset,
    position: cue.at,
    ...(cue.label ? { label: cue.label } : {})
  });
}

/** A motion-path op travels waypoints; it has no from/to property bag. */
interface PathCue {
  at: number;
  d?: number;
  ease?: string;
  points: Array<{ x: number; y: number }>;
  curviness?: number;
  label?: string;
}

function path(id: string, target: string, cue: PathCue): void {
  push({
    id,
    type: "motion-path",
    target,
    path: cue.points,
    duration: cue.d ?? 0.9,
    ease: cue.ease ?? "power2.inOut",
    curviness: cue.curviness ?? 1.2,
    position: cue.at,
    ...(cue.label ? { label: cue.label } : {})
  });
}

/* ── initial state ───────────────────────────────────────────────────────
   Every animated node is parked before the first frame so nothing leaks in
   un-animated, and so `restart()` has a known state to return to. */

set("init-vignette", ".bf-vignette", { opacity: 0 });
set("init-halo", ".bf-halo", { opacity: 0, scale: 0.86 });
set("init-corner", ".bf-corner", { opacity: 0, scale: 0.7 });
/* Text-reveal targets (.bf-wordmark, .bf-statement, .bf-motion-title,
   .bf-d2-word, .bf-tagline) get no parked container state: a `text` op splits
   the element and animates the .waves-gsap-char spans, so the container's own
   transform/opacity would fight the chars. The char-level `from` is the
   initial state, and GSAP renders it immediately. */
set("init-rule-1", ".bf-rule-1", { opacity: 0, scaleX: 0 });
set("init-s1-sub", ".bf-s1-sub", { opacity: 0, y: 14 });
set("init-scene-1", ".bf-scene-1", { opacity: 0 });
set("init-num-1", ".bf-num-1", { opacity: 0 });
set("init-s2-label", ".bf-s2-label", { opacity: 0, x: -16 });
set("init-rule-2", ".bf-rule-2", { opacity: 0, scaleX: 0 });
set("init-scene-2", ".bf-scene-2", { opacity: 0 });
set("init-num-2", ".bf-num-2", { opacity: 0 });
set("init-scene-3", ".bf-scene-3", { opacity: 0 });
set("init-eco-label", ".bf-eco-label", { opacity: 0, x: -16 });
set("init-hub", ".bf-hub", { opacity: 0, scale: 0.6 });
set("init-spine", ".bf-spine", { opacity: 0, scaleX: 0 });
set("init-bus", ".bf-bus", { opacity: 0, scaleY: 0 });
set("init-tap", ".bf-tap", { opacity: 0, scaleX: 0 });
set("init-node", ".bf-node", { opacity: 0, y: 18, scale: 0.96 });
set("init-node-name", ".bf-node-name", { opacity: 0, y: 8 });
set("init-node-role", ".bf-node-role", { opacity: 0, y: 8 });
set("init-pulse", ".bf-pulse", { opacity: 0 });
set("init-num-3", ".bf-num-3", { opacity: 0 });
set("init-scene-4", ".bf-scene-4", { opacity: 0 });
set("init-one-label", ".bf-one-label", { opacity: 0, x: -16 });
set("init-one-panel", ".bf-one-panel", { opacity: 0, y: 24, scale: 0.985 });
set("init-one-line", ".bf-one-line", { opacity: 0, x: -26 });
set("init-console", ".bf-console", { opacity: 0, y: 20, scale: 0.97 });
set("init-caret", ".bf-caret", { opacity: 0 });
set("init-scan", ".bf-scan", { opacity: 0, y: 0 });
set("init-num-4", ".bf-num-4", { opacity: 0 });
set("init-scene-5", ".bf-scene-5", { opacity: 0 });
set("init-seai-label", ".bf-seai-label", { opacity: 0, x: -16 });
set("init-web", ".bf-web", { opacity: 0, y: 42, scale: 0.97 });
set("init-web-dot", ".bf-web-dot", { opacity: 0, scale: 0.5 });
set("init-web-url", ".bf-web-url", { opacity: 0, scaleX: 0.5 });
set("init-web-nav", ".bf-web-nav", { opacity: 0, y: -8 });
set("init-web-hero", ".bf-web-hero", { opacity: 0, y: 18, scaleX: 0.9 });
set("init-web-card", ".bf-web-card", { opacity: 0, y: 24 });
set("init-web-prog", ".bf-web-prog", { opacity: 0, scaleX: 0 });
set("init-seai-line", ".bf-seai-line", { opacity: 0, y: 22 });
set("init-num-5", ".bf-num-5", { opacity: 0 });
set("init-scene-6", ".bf-scene-6", { opacity: 0 });
set("init-motion-label", ".bf-motion-label", { opacity: 0, x: -16 });
set("init-d-label", ".bf-d-label", { opacity: 0, y: 10 });
set("init-d1-track", ".bf-d1-track", { opacity: 0, scaleX: 0 });
set("init-d1-tick", ".bf-d1-tick", { opacity: 0, scaleY: 0.2 });
set("init-d1-head", ".bf-d1-head", { opacity: 0, x: 0 });
set("init-d3-bar", ".bf-d3-bar", { opacity: 0, scaleY: 0.1 });
set("init-d4-layer", ".bf-d4-layer", { opacity: 0, x: 0 });
set("init-d5-dot", ".bf-d5-dot", { opacity: 0, scale: 0.2 });
set("init-d6-inner", ".bf-d6-inner", { y: 0 });
set("init-num-6", ".bf-num-6", { opacity: 0 });
set("init-scene-7", ".bf-scene-7", { opacity: 0 });
set("init-con-label", ".bf-con-label", { opacity: 0, x: -16 });
set("init-con", ".bf-con", { opacity: 0, y: 16, scale: 0.9 });
set("init-plus", ".bf-plus", { opacity: 0, scale: 0.6 });
set("init-con-core", ".bf-con-core", { opacity: 0, scale: 0.5 });
set("init-num-7", ".bf-num-7", { opacity: 0 });
set("init-scene-8", ".bf-scene-8", { opacity: 0 });
set("init-rule-3", ".bf-rule-3", { opacity: 0, scaleX: 0 });
set("init-meta", ".bf-meta", { opacity: 0, y: 10 });
set("init-num-8", ".bf-num-8", { opacity: 0 });
set("init-progress", ".bf-progress", { scaleX: 0 });

/* ── scene 1 · 0.0–2.0s — wordmark out of darkness ──────────────────────── */

tween("s1-vignette-in", ".bf-vignette", { at: 0, d: 0.9, ease: "power1.out", from: {}, to: { opacity: 1 } });
tween("s1-halo", ".bf-halo", { at: 0, d: 1.8, ease: "power2.out", from: {}, to: { opacity: 0.5, scale: 1 } });
stagger("s1-corners", ".bf-corner", { at: 0.05, d: 0.9, ease: "power3.out", each: 0.07, origin: "edges", from: { opacity: 0, scale: 0.7 }, to: { opacity: 1, scale: 1 } });
text("s1-wordmark", ".bf-wordmark", {
  at: 0.15,
  d: 0.85,
  each: 0.08,
  ease: "expo.out",
  label: "s1-wordmark",
  from: { opacity: 0, y: 46 },
  to: { opacity: 1, y: 0 },
  split: "chars"
});
tween("s1-num", ".bf-num-1", { at: 0.2, d: 0.4, from: {}, to: { opacity: 1 } });
tween("s1-scene-in", ".bf-scene-1", { at: 0.1, d: 0.5, from: {}, to: { opacity: 1 } });
tween("s1-rule", ".bf-rule-1", { at: 0.85, d: 0.9, ease: "expo.inOut", from: {}, to: { opacity: 1, scaleX: 1 } });
tween("s1-sub", ".bf-s1-sub", { at: 1.3, d: 0.6, from: {}, to: { opacity: 1, y: 0 } });
tween("s1-exit", ".bf-scene-1", { at: 1.8, d: 0.55, ease: "power2.in", from: {}, to: { opacity: 0, y: -24 } });

/* ── scene 2 · 2.0–4.5s — the company in one line ────────────────────────── */

tween("s2-wordmark-recede", ".bf-wordmark", {
  at: 1.95,
  d: 1.05,
  ease: "power3.inOut",
  label: "s2-company",
  from: {},
  to: { x: -618, y: -300, scale: 0.3, opacity: 0.9 }
});
tween("s2-num", ".bf-num-2", { at: 2, d: 0.4, from: {}, to: { opacity: 1 } });
tween("s2-scene-in", ".bf-scene-2", { at: 1.95, d: 0.5, from: {}, to: { opacity: 1 } });
tween("s2-label", ".bf-s2-label", { at: 2.05, d: 0.55, from: {}, to: { opacity: 1, x: 0 } });
text("s2-statement", ".bf-statement", {
  at: 2.15,
  d: 0.7,
  each: 0.055,
  ease: "expo.out",
  from: { opacity: 0, y: 28 },
  to: { opacity: 1, y: 0 },
  split: "words"
});
tween("s2-rule", ".bf-rule-2", { at: 2.85, d: 0.8, ease: "expo.out", from: {}, to: { opacity: 1, scaleX: 1 } });
tween("s2-wordmark-dim", ".bf-wordmark", { at: 2.4, d: 0.6, from: {}, to: { opacity: 0.42 } });
tween("s2-exit", ".bf-scene-2", { at: 4, d: 0.5, ease: "power2.in", from: {}, to: { opacity: 0, y: -22 } });

/* ── scene 3 · 4.5–7.0s — one connected ecosystem ────────────────────────── */

tween("s3-scene-in", ".bf-scene-3", { at: 4.45, d: 0.45, from: {}, to: { opacity: 1 } });
tween("s3-num", ".bf-num-3", { at: 4.55, d: 0.4, from: {}, to: { opacity: 1 } });
tween("s3-label", ".bf-eco-label", { at: 4.6, d: 0.55, from: {}, to: { opacity: 1, x: 0 } });
tween("s3-hub", ".bf-hub", { at: 4.55, d: 0.7, ease: "back.out(1.4)", label: "s3-ecosystem", from: {}, to: { opacity: 1, scale: 1 } });
tween("s3-spine", ".bf-spine", { at: 4.95, d: 0.55, ease: "power2.inOut", from: {}, to: { opacity: 1, scaleX: 1 } });
tween("s3-bus", ".bf-bus", { at: 5.15, d: 0.7, ease: "power2.inOut", from: {}, to: { opacity: 1, scaleY: 1 } });
stagger("s3-nodes", ".bf-node", { at: 5.55, d: 0.55, each: 0.11, from: { opacity: 0, y: 18, scale: 0.96 }, to: { opacity: 1, y: 0, scale: 1 } });
stagger("s3-taps", ".bf-tap", { at: 5.65, d: 0.45, ease: "power2.inOut", each: 0.09, from: { opacity: 0, scaleX: 0 }, to: { opacity: 1, scaleX: 1 } });
stagger("s3-node-names", ".bf-node-name", { at: 5.75, d: 0.4, each: 0.11, from: { opacity: 0, y: 8 }, to: { opacity: 1, y: 0 } });
stagger("s3-node-roles", ".bf-node-role", { at: 5.85, d: 0.4, each: 0.11, from: { opacity: 0, y: 8 }, to: { opacity: 1, y: 0 } });
stagger("s3-pulses-on", ".bf-pulse", { at: 5.5, d: 0.3, each: 0.08, from: { opacity: 0 }, to: { opacity: 1 } });
path("s3-pulse-1", ".bf-pulse-1", { at: 5.6, d: 0.95, ease: "power1.inOut", curviness: 1.3, points: [{ x: 0, y: 0 }, { x: 267, y: -130 }, { x: 534, y: -260 }] });
path("s3-pulse-2", ".bf-pulse-2", { at: 5.72, d: 0.95, ease: "power1.inOut", curviness: 1.3, points: [{ x: 0, y: 0 }, { x: 267, y: 0 }, { x: 534, y: 0 }] });
path("s3-pulse-3", ".bf-pulse-3", { at: 5.84, d: 0.95, ease: "power1.inOut", curviness: 1.3, points: [{ x: 0, y: 0 }, { x: 267, y: 130 }, { x: 534, y: 260 }] });
tween("s3-pulses-off", ".bf-pulse", { at: 6.45, d: 0.4, from: {}, to: { opacity: 0 } });
tween("s3-exit", ".bf-scene-3", { at: 6.5, d: 0.5, ease: "power2.in", from: {}, to: { opacity: 0, scale: 0.985 } });

/* ── scene 4 · 7.0–10.0s — WAVES ONE: think, command, execute ──────────── */

tween("s4-scene-in", ".bf-scene-4", { at: 6.9, d: 0.45, from: {}, to: { opacity: 1 } });
tween("s4-num", ".bf-num-4", { at: 7, d: 0.4, from: {}, to: { opacity: 1 } });
tween("s4-label", ".bf-one-label", { at: 7, d: 0.5, from: {}, to: { opacity: 1, x: 0 } });
tween("s4-panel", ".bf-one-panel", { at: 7.05, d: 0.7, ease: "expo.out", label: "s4-waves-one", from: {}, to: { opacity: 1, y: 0, scale: 1 } });
stagger("s4-lines", ".bf-one-line", { at: 7.45, d: 0.55, ease: "power3.out", each: 0.24, from: { opacity: 0, x: -26 }, to: { opacity: 1, x: 0 } });
tween("s4-console", ".bf-console", { at: 8.3, d: 0.6, from: {}, to: { opacity: 1, y: 0, scale: 1 } });
tween("s4-scan", ".bf-scan", { at: 8.55, d: 0.9, ease: "power1.inOut", from: { opacity: 0.9, y: 0 }, to: { opacity: 0, y: 150 } });
tween("s4-caret-1", ".bf-caret", { at: 8.4, d: 0.1, from: { opacity: 0 }, to: { opacity: 1 } });
tween("s4-caret-2", ".bf-caret", { at: 8.7, d: 0.1, from: { opacity: 1 }, to: { opacity: 0 } });
tween("s4-caret-3", ".bf-caret", { at: 9, d: 0.1, from: { opacity: 0 }, to: { opacity: 1 } });
tween("s4-caret-4", ".bf-caret", { at: 9.3, d: 0.1, from: { opacity: 1 }, to: { opacity: 0 } });
tween("s4-exit", ".bf-scene-4", { at: 9.5, d: 0.5, ease: "power2.in", from: {}, to: { opacity: 0, y: -22 } });

/* ── scene 5 · 10.0–13.0s — SEAI: a site that builds itself ──────────────── */

tween("s5-scene-in", ".bf-scene-5", { at: 9.9, d: 0.45, from: {}, to: { opacity: 1 } });
tween("s5-num", ".bf-num-5", { at: 10, d: 0.4, from: {}, to: { opacity: 1 } });
tween("s5-label", ".bf-seai-label", { at: 10, d: 0.5, from: {}, to: { opacity: 1, x: 0 } });
tween("s5-web", ".bf-web", { at: 10.05, d: 0.75, ease: "expo.out", label: "s5-seai", from: {}, to: { opacity: 1, y: 0, scale: 1 } });
stagger("s5-dots", ".bf-web-dot", { at: 10.3, d: 0.3, each: 0.06, from: { opacity: 0, scale: 0.5 }, to: { opacity: 1, scale: 1 } });
tween("s5-url", ".bf-web-url", { at: 10.35, d: 0.5, from: {}, to: { opacity: 1, scaleX: 1 } });
stagger("s5-nav", ".bf-web-nav", { at: 10.5, d: 0.4, each: 0.06, from: { opacity: 0, y: -8 }, to: { opacity: 1, y: 0 } });
stagger("s5-hero", ".bf-web-hero", { at: 10.75, d: 0.55, ease: "power3.out", each: 0.09, from: { opacity: 0, y: 18, scaleX: 0.9 }, to: { opacity: 1, y: 0, scaleX: 1 } });
stagger("s5-cards", ".bf-web-card", { at: 11.1, d: 0.55, ease: "power3.out", each: 0.1, from: { opacity: 0, y: 24 }, to: { opacity: 1, y: 0 } });
tween("s5-progress", ".bf-web-prog", { at: 11.4, d: 1.2, ease: "power2.inOut", from: {}, to: { opacity: 1, scaleX: 1 } });
stagger("s5-lines", ".bf-seai-line", { at: 11.55, d: 0.55, ease: "expo.out", each: 0.28, from: { opacity: 0, y: 22 }, to: { opacity: 1, y: 0 } });
tween("s5-exit", ".bf-scene-5", { at: 12.5, d: 0.5, ease: "power2.in", from: {}, to: { opacity: 0, y: -22, scale: 0.99 } });

/* ── scene 6 · 13.0–16.0s — WAVES Motion, demonstrated not listed ────────── */

tween("s6-scene-in", ".bf-scene-6", { at: 12.9, d: 0.45, from: {}, to: { opacity: 1 } });
tween("s6-num", ".bf-num-6", { at: 13, d: 0.4, from: {}, to: { opacity: 1 } });
tween("s6-label", ".bf-motion-label", { at: 13, d: 0.5, from: {}, to: { opacity: 1, x: 0 } });
text("s6-title", ".bf-motion-title", {
  at: 13.1,
  d: 0.65,
  each: 0.035,
  ease: "expo.out",
  label: "s6-waves-motion",
  from: { opacity: 0, y: 32 },
  to: { opacity: 1, y: 0 },
  split: "chars"
});
stagger("s6-demo-labels", ".bf-d-label", { at: 13.4, d: 0.4, each: 0.08, from: { opacity: 0, y: 10 }, to: { opacity: 1, y: 0 } });
tween("d1-track", ".bf-d1-track", { at: 13.55, d: 0.6, ease: "power2.inOut", from: {}, to: { opacity: 1, scaleX: 1 } });
stagger("d1-ticks", ".bf-d1-tick", { at: 13.65, d: 0.3, each: 0.07, from: { opacity: 0, scaleY: 0.2 }, to: { opacity: 1, scaleY: 1 } });
tween("d1-playhead", ".bf-d1-head", { at: 13.7, d: 1.1, ease: "none", from: { opacity: 0, x: 0 }, to: { opacity: 1, x: 330 } });
text("d2-reveal", ".bf-d2-word", { at: 13.9, d: 0.35, each: 0.04, ease: "expo.out", from: { opacity: 0, y: 16 }, to: { opacity: 1, y: 0 }, split: "chars" });
stagger("d3-bars", ".bf-d3-bar", { at: 14.2, d: 0.35, ease: "back.out(2)", each: 0.07, from: { opacity: 0, scaleY: 0.1 }, to: { opacity: 1, scaleY: 1 } });
tween("d4-layer-1", ".bf-d4-layer-1", { at: 14.5, d: 0.9, ease: "sine.inOut", from: { opacity: 0, x: 0 }, to: { opacity: 1, x: 26 } });
tween("d4-layer-2", ".bf-d4-layer-2", { at: 14.5, d: 0.9, ease: "sine.inOut", from: { opacity: 0, x: 0 }, to: { opacity: 1, x: 52 } });
tween("d4-layer-3", ".bf-d4-layer-3", { at: 14.5, d: 0.9, ease: "sine.inOut", from: { opacity: 0, x: 0 }, to: { opacity: 1, x: 88 } });
spring("d5-spring", ".bf-d5-dot", { at: 14.95, d: 1, preset: "signature", from: { opacity: 0, scale: 0.2 }, to: { opacity: 1, scale: 1 } });
tween("d6-scrub", ".bf-d6-inner", { at: 15.15, d: 1.2, ease: "none", from: { y: 0 }, to: { y: -96 } });
tween("s6-exit", ".bf-scene-6", { at: 15.5, d: 0.5, ease: "power2.in", from: {}, to: { opacity: 0, y: -22 } });

/* ── scene 7 · 16.0–18.0s — the ecosystem converges ──────────────────────── */

tween("s7-scene-in", ".bf-scene-7", { at: 15.9, d: 0.4, label: "s7-converge", from: {}, to: { opacity: 1 } });
tween("s7-num", ".bf-num-7", { at: 16, d: 0.4, from: {}, to: { opacity: 1 } });
tween("s7-label", ".bf-con-label", { at: 15.95, d: 0.45, from: {}, to: { opacity: 1, x: 0 } });
stagger("s7-cons", ".bf-con", { at: 16, d: 0.5, ease: "power3.out", each: 0.1, from: { opacity: 0, y: 16, scale: 0.9 }, to: { opacity: 1, y: 0, scale: 1 } });
stagger("s7-pluses", ".bf-plus", { at: 16.1, d: 0.4, ease: "back.out(2)", each: 0.1, from: { opacity: 0, scale: 0.6 }, to: { opacity: 1, scale: 1 } });
tween("s7-core", ".bf-con-core", { at: 16.3, d: 0.6, ease: "expo.out", from: {}, to: { opacity: 1, scale: 1 } });
tween("s7-wordmark-return", ".bf-wordmark", { at: 16.95, d: 0.95, ease: "power3.inOut", from: {}, to: { x: 0, y: 0, scale: 1, opacity: 1 } });
path("s7-converge-1", ".bf-con-1", { at: 16.75, d: 0.85, ease: "power2.in", curviness: 1.4, points: [{ x: 0, y: 0 }, { x: 90, y: 45 }, { x: 180, y: 90 }] });
path("s7-converge-2", ".bf-con-2", { at: 16.8, d: 0.85, ease: "power2.in", curviness: 1.4, points: [{ x: 0, y: 0 }, { x: 0, y: 75 }, { x: 0, y: 150 }] });
path("s7-converge-3", ".bf-con-3", { at: 16.85, d: 0.85, ease: "power2.in", curviness: 1.4, points: [{ x: 0, y: 0 }, { x: -90, y: 45 }, { x: -180, y: 90 }] });
tween("s7-core-out", ".bf-con-core", { at: 17.2, d: 0.55, ease: "power2.out", from: {}, to: { opacity: 0, scale: 1.8 } });
tween("s7-plus-out", ".bf-plus", { at: 17.25, d: 0.45, ease: "power2.in", from: {}, to: { opacity: 0, scale: 1.6 } });
tween("s7-cons-out", ".bf-con", { at: 17.3, d: 0.5, ease: "power2.in", from: {}, to: { opacity: 0, scale: 0.86 } });
tween("s7-exit", ".bf-scene-7", { at: 17.45, d: 0.4, ease: "power2.in", from: {}, to: { opacity: 0 } });
tween("s7-num-out", ".bf-num-7", { at: 17.45, d: 0.3, from: {}, to: { opacity: 0 } });

/* ── scene 8 · 18.0–19.0s — final lockup, held ──────────────────────────── */

/* Everything here lands by ~18.6s so the lockup holds cleanly for the last
   third of a second — the final frame is the film's last impression. */

tween("s8-scene-in", ".bf-scene-8", { at: 17.9, d: 0.4, from: {}, to: { opacity: 1 } });
tween("s8-num", ".bf-num-8", { at: 17.95, d: 0.35, from: {}, to: { opacity: 1 } });
tween("s8-wordmark-settle", ".bf-wordmark", { at: 18, d: 0.6, ease: "power2.out", from: {}, to: { scale: 0.92, y: -8 } });
text("s8-tagline", ".bf-tagline", {
  at: 18.02,
  d: 0.45,
  each: 0.018,
  ease: "expo.out",
  label: "s8-lockup",
  from: { opacity: 0, y: 24 },
  to: { opacity: 1, y: 0 },
  split: "chars"
});
tween("s8-rule", ".bf-rule-3", { at: 18.1, d: 0.5, ease: "expo.inOut", from: {}, to: { opacity: 1, scaleX: 1 } });
stagger("s8-meta", ".bf-meta", { at: 18.2, d: 0.35, each: 0.07, from: { opacity: 0, y: 10 }, to: { opacity: 1, y: 0 } });

/* ── the film clock ──────────────────────────────────────────────────────
   One linear 19s tween: the progress hairline is the timeline itself, and it
   is what pins `planTimeline().totalMs` to exactly 19000. */

tween("film-progress", ".bf-progress", { at: 0, d: 19, ease: "none", from: {}, to: { scaleX: 1 } });

/** Scene labels, in order, with their exact beat in seconds. */
export const BRAND_FILM_SCENES: ReadonlyArray<{ label: string; at: number }> = [
  { label: "s1-wordmark", at: 0.15 },
  { label: "s2-company", at: 1.95 },
  { label: "s3-ecosystem", at: 4.55 },
  { label: "s4-waves-one", at: 7.05 },
  { label: "s5-seai", at: 10.05 },
  { label: "s6-waves-motion", at: 13.1 },
  { label: "s7-converge", at: 15.9 },
  { label: "s8-lockup", at: 18.02 }
];

export function buildWavesBrandFilm(): GsapSceneSpec {
  return {
    version: 1,
    name: BRAND_FILM_NAME,
    description:
      "WAVES brand film — 19s single master timeline. Wordmark from darkness, the company in one line, a connected ecosystem, then WAVES ONE, SEAI and WAVES Motion each demonstrated, convergence, and the final lockup.",
    ops: ops.map((op) => ({ ...op }))
  };
}
