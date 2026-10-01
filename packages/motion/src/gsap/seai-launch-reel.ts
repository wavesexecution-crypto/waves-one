/**
 * SEAI launch reel — the 15-second vertical GSAP scene.
 *
 * Authored here rather than as hand-written JSON because this is choreography:
 * one deterministic master timeline, five labelled scenes, exact beats. The
 * helpers keep the op list readable while `saveGsapSpec` still runs the real
 * validator, so a bad beat can never reach `.motion/gsap/`.
 *
 * Design contract, enforced by `packages/motion/test/seai-launch-reel.test.ts`:
 *   - one master timeline, total exactly 15000ms
 *   - the five required scene labels: intro, ai-build, showcase, capabilities,
 *     final
 *   - a label sits on its scene's COMPOSED read-beat, so a reduced-motion step
 *     lands on a finished frame rather than a half-played transition
 *   - no `ambient` ops — the reel is finite, so it completes, holds and reverses
 *   - no ScrollTrigger: every parallax is a timeline tween at `ease: "none"`
 *     (a scrub) so 15s is reproducible inside a paused timeline and assertable
 *     without a browser
 *   - the final frame is a clean lockup: mark, positioning, CTA
 *
 * The progress rail is a single 15.000s linear tween. It is the reel's structural
 * scrub and it is also what pins `planTimeline().totalMs` to exactly 15000.
 *
 * Story map (seconds):
 *   intro        0.00 –  2.00   mark, then the problem, stated
 *   ai-build     2.00 –  4.00   the answer, as one continuous transition
 *   showcase     4.00 –  7.00   seven real SEAI demo sites on a masked rail
 *   capabilities 7.00 – 10.00   four pillars collapse into one
 *   final       10.00 – 15.00   a real finished site, then the lockup and CTA
 */

import type { GsapOp, GsapSceneSpec, GsapVars } from "./spec";

export const SEAI_REEL_NAME = "seai-launch-reel";
export const SEAI_REEL_MS = 15000;

/** Authoring geometry. The artboard owns it in the stage component; the spec
 *  carries no width/height because `GsapSceneSpec` deliberately has no
 *  geometry field. The exporter reads the same table. */
export const SEAI_REEL_W = 1080;
export const SEAI_REEL_H = 1920;

/** The five scene labels the reel is specified around. */
export const SEAI_REEL_SCENES = [
  { label: "intro", at: 1.55 },
  { label: "ai-build", at: 3.92 },
  { label: "showcase", at: 5.35 },
  { label: "capabilities", at: 8.16 },
  { label: "final", at: 13.9 }
] as const;

/** The seven SEAI demo verticals, in reel order. */
export const SEAI_REEL_DEMOS = [
  "restaurant",
  "gym",
  "salon",
  "clinic",
  "real-estate",
  "cafe",
  "business"
] as const;

const split = (key: string): string => `[data-split="${key}"]`;
const shot = (index: number): string => `.sr-shot:nth-child(${index})`;

interface Cue {
  at: number;
  d?: number;
  ease?: string;
  from: GsapVars;
  to: GsapVars;
}

interface StaggerCue extends Cue {
  each: number;
  origin?: "first" | "last" | "center" | "edges" | "random";
}

interface TextCue extends Cue {
  /** Defaults to "chars". */
  split?: "chars" | "words";
  each: number;
}

const ops: GsapOp[] = [];
const push = (op: GsapOp): void => {
  ops.push(op);
};

function set(id: string, target: string, to: GsapVars, at = 0): void {
  push({ id, type: "set", target, to, position: at });
}

/**
 * Scene marker. Carries the label and writes one inert custom property, so a
 * reduced-motion step lands on a composed frame without inventing motion.
 */
function mark(id: string, target: string, at: number, label: string): void {
  push({ id, type: "set", target, to: { "--sr-beat": 1 }, position: at, label });
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
// Persistent chrome — the reel's one structural scrub, and the total's anchor.
// ---------------------------------------------------------------------------

tween("progress-rail", ".sr-progress", {
  at: 0,
  d: SEAI_REEL_MS / 1000,
  ease: "none",
  from: { scaleX: 0 },
  to: { scaleX: 1 }
});

tween("corner-in", ".sr-corner", { at: 0.2, d: 0.5, ease: "power2.out", from: { opacity: 0 }, to: { opacity: 1 } });
tween("corner-out", ".sr-corner", { at: 14.2, d: 0.4, ease: "power2.in", from: { opacity: 1 }, to: { opacity: 0 } });

// ---------------------------------------------------------------------------
// intro — 0.00 / 2.00
// ---------------------------------------------------------------------------

set("intro-on", ".sr-s-intro", { opacity: 1 });
set("intro-logo", split("sr-logo"), { opacity: 0, scale: 0.7, y: -30 });
set("intro-statement", split("sr-statement-a"), { opacity: 0 });
set("intro-rule", ".sr-scene .sr-rule", { scaleX: 0 });
set("intro-eyebrow", ".sr-eyebrow-center", { opacity: 0, y: 24 });

// The mark lands first, then the statement drops onto a 3D plane. rotateX needs
// the parent perspective to read as a slam rather than a scale.
tween("intro-logo-in", split("sr-logo"), {
  at: 0.1,
  d: 0.5,
  ease: "expo.out",
  from: { opacity: 0, scale: 0.7, y: -30 },
  to: { opacity: 1, scale: 1, y: 0 }
});

text("intro-a", split("sr-statement-a"), {
  at: 0.42,
  d: 0.6,
  each: 0.024,
  from: { yPercent: -128, opacity: 0, rotateX: 80, scaleY: 1.36 },
  to: { yPercent: 0, opacity: 1, rotateX: 0, scaleY: 1 }
});

text("intro-b", split("sr-statement-b"), {
  at: 0.76,
  d: 0.56,
  each: 0.021,
  from: { yPercent: -108, opacity: 0, rotateX: 68, xPercent: -10 },
  to: { yPercent: 0, opacity: 1, rotateX: 0, xPercent: 0 }
});

tween("intro-rule-in", ".sr-scene .sr-rule", { at: 1.0, d: 0.44, ease: "power3.out", from: { scaleX: 0 }, to: { scaleX: 1 } });
tween("intro-eyebrow-in", ".sr-eyebrow-center", { at: 1.02, d: 0.44, ease: "power2.out", from: { opacity: 0, y: 24 }, to: { opacity: 1, y: 0 } });

mark("intro-beat", ".sr-s-intro", 1.55, "intro");

// ---------------------------------------------------------------------------
// ai-build — 2.00 / 4.00
// ---------------------------------------------------------------------------

set("ai-on", ".sr-s-ai", { opacity: 1 }, 1.99);
set("ai-wide-rule", ".sr-rule-wide", { scaleX: 0 }, 1.99);

// The statement breaks on one beat, on two different axes, so the answer that
// follows reads as a continuation rather than three separate events.
text("intro-break-a", split("sr-statement-a"), {
  at: 2.0,
  d: 0.28,
  each: 0.01,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, rotateX: 0, scaleY: 1 },
  to: { yPercent: -78, opacity: 0, rotateX: -54, scaleY: 0.84 }
});

text("intro-break-b", split("sr-statement-b"), {
  at: 2.06,
  d: 0.28,
  each: 0.01,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, rotateX: 0, xPercent: 0 },
  to: { xPercent: 94, opacity: 0, rotateY: -58 }
});

tween("intro-rule-out", ".sr-scene .sr-rule", { at: 2.0, d: 0.24, ease: "power2.in", from: { scaleX: 1 }, to: { scaleX: 0 } });
tween("intro-eyebrow-out", ".sr-eyebrow-center", { at: 2.02, d: 0.22, ease: "power2.in", from: { opacity: 1, y: 0 }, to: { opacity: 0, y: -22 } });
tween("intro-logo-out", split("sr-logo"), { at: 2.0, d: 0.26, ease: "power2.in", from: { opacity: 1, scale: 1, y: 0 }, to: { opacity: 0, scale: 0.8, y: -26 } });

text("ai-claim-a", split("sr-claim-a"), {
  at: 2.48,
  d: 0.54,
  each: 0.028,
  from: { yPercent: 118, opacity: 0, rotateX: -72, scaleY: 1.22 },
  to: { yPercent: 0, opacity: 1, rotateX: 0, scaleY: 1 }
});

text("ai-claim-out", split("sr-claim-a"), {
  at: 3.06,
  d: 0.22,
  each: 0.008,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, xPercent: 0 },
  to: { xPercent: 76, opacity: 0, rotateY: 50 }
});

text("ai-claim-b", split("sr-claim-b"), {
  at: 3.18,
  d: 0.46,
  each: 0.03,
  from: { yPercent: 122, opacity: 0, rotateZ: -7, scale: 0.84 },
  to: { yPercent: 0, opacity: 1, rotateZ: 0, scale: 1 }
});

tween("ai-rule-in", ".sr-rule-wide", { at: 3.5, d: 0.38, ease: "power3.out", from: { scaleX: 0 }, to: { scaleX: 1 } });

mark("ai-beat", ".sr-s-ai", 3.92, "ai-build");

// ---------------------------------------------------------------------------
// showcase — 4.00 / 7.00 : the real SEAI demo sites
// ---------------------------------------------------------------------------

set("show-on", ".sr-s-showcase", { opacity: 1 }, 4.12);
set("show-tag", ".sr-scene-tag", { opacity: 0, x: -40 }, 4.12);

text("ai-out-a", split("sr-claim-a"), {
  at: 3.98,
  d: 0.24,
  each: 0.008,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, xPercent: 0 },
  to: { xPercent: 78, opacity: 0, rotateY: 48 }
});

text("ai-out-b", split("sr-claim-b"), {
  at: 3.98,
  d: 0.24,
  each: 0.008,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, rotateZ: 0, scale: 1 },
  to: { yPercent: 62, opacity: 0, scale: 0.9 }
});

tween("ai-wide-rule-out", ".sr-rule-wide", { at: 3.98, d: 0.22, ease: "power2.in", from: { scaleX: 1 }, to: { scaleX: 0 } });

// Seven real captures, revealed by clip rather than faded: the mask is what
// makes them read as sites passing through a viewport.
for (let i = 1; i <= SEAI_REEL_DEMOS.length; i += 1) {
  set(`show-set-${i}`, shot(i), { opacity: 0, clipPath: "inset(100% 0% 0% 0%)", scale: 0.95, x: 46 }, 4.12);
}

stagger("show-in", ".sr-shot", {
  at: 4.2,
  d: 0.58,
  each: 0.1,
  ease: "expo.out",
  from: { opacity: 0, clipPath: "inset(100% 0% 0% 0%)", scale: 0.95, x: 46 },
  to: { opacity: 1, clipPath: "inset(0% 0% 0% 0%)", scale: 1, x: 0 }
});

tween("show-tag-in", ".sr-scene-tag", { at: 4.2, d: 0.46, ease: "power3.out", from: { opacity: 0, x: -40 }, to: { opacity: 1, x: 0 } });

// The conveyor: one linear travel of the rail, ease "none" = a scrub. The
// counter-drifts below are measured against it, which is what makes the stack
// read as depth instead of a flat scroll.
tween("show-conveyor", ".sr-rail", { at: 4.28, d: 2.4, ease: "none", from: { y: 0 }, to: { y: -1720 } });

const DRIFT = [30, -24, 34, -18, 26, -32, 20];
for (let i = 1; i <= SEAI_REEL_DEMOS.length; i += 1) {
  tween(`show-drift-${i}`, shot(i), {
    at: 4.28,
    d: 2.4,
    ease: "none",
    from: { x: 0 },
    to: { x: DRIFT[i - 1] }
  });
}

mark("show-beat", ".sr-s-showcase", 5.35, "showcase");

tween("show-out", ".sr-rail", { at: 6.6, d: 0.38, ease: "power2.in", from: { y: -1720 }, to: { y: -2140, opacity: 0 } });
tween("show-tag-out", ".sr-scene-tag", { at: 6.55, d: 0.28, ease: "power2.in", from: { opacity: 1, x: 0 }, to: { opacity: 0, x: -30 } });

// ---------------------------------------------------------------------------
// capabilities — 7.00 / 10.00
// ---------------------------------------------------------------------------

set("caps-on", ".sr-s-caps", { opacity: 1 }, 6.94);

const PILLARS = ["sr-cap-design", "sr-cap-code", "sr-cap-content", "sr-cap-seo"] as const;
PILLARS.forEach((key, index) => {
  const fromLeft = index % 2 === 0;
  text(`caps-${index + 1}`, split(key), {
    at: 7.0 + index * 0.24,
    d: 0.3,
    each: 0.021,
    ease: "power4.out",
    from: fromLeft ? { xPercent: -68, opacity: 0, skewX: 15 } : { xPercent: 68, opacity: 0, skewX: -15 },
    to: { xPercent: 0, opacity: 1, skewX: 0 }
  });
});

mark("caps-beat", ".sr-s-caps", 8.16, "capabilities");

// One precise accent, the only flourish in the scene.
tween("caps-seo-pulse", split("sr-cap-seo"), { at: 8.22, d: 0.18, ease: "power2.out", from: { scale: 1 }, to: { scale: 1.045 } });
tween("caps-seo-settle", split("sr-cap-seo"), { at: 8.44, d: 0.22, ease: "power2.inOut", from: { scale: 1.045 }, to: { scale: 1 } });

// The collapse. Scaling alone would leave the four words spread down the frame,
// so each is pulled to the centre line as well — that is what makes them read
// as collapsing INTO one thing rather than merely shrinking.
stagger("caps-collapse", ".sr-pillar", {
  at: 8.86,
  d: 0.5,
  each: 0.035,
  origin: "center",
  ease: "power3.inOut",
  from: { scale: 1, opacity: 1 },
  to: { scale: 0.14, opacity: 0 }
});

const PULL = [228, 76, -76, -228];
PILLARS.forEach((key, index) => {
  tween(`caps-pull-${index + 1}`, split(key), {
    at: 8.86,
    d: 0.5,
    ease: "power3.inOut",
    from: { y: 0 },
    to: { y: PULL[index] }
  });
});

text("caps-one", split("sr-one"), {
  at: 8.98,
  d: 0.62,
  each: 0.029,
  from: { scale: 0.18, opacity: 0, letterSpacing: "0.22em", rotateX: -48 },
  to: { scale: 1, opacity: 1, letterSpacing: "-0.035em", rotateX: 0 }
});

tween("caps-one-out", split("sr-one"), {
  at: 9.84,
  d: 0.28,
  ease: "power2.in",
  from: { yPercent: 0, opacity: 1, scale: 1 },
  to: { yPercent: -48, opacity: 0, scale: 0.94 }
});

// ---------------------------------------------------------------------------
// final — 10.00 / 15.00
// ---------------------------------------------------------------------------

set("final-on", ".sr-s-final", { opacity: 1 }, 9.94);
set("final-plate", ".sr-plate", { clipPath: "inset(100% 0% 0% 0%)", scale: 1.05, y: 36 }, 9.94);
set("final-built", split("sr-built-a"), { opacity: 0 });
set("final-lockup", ".sr-lockup", { opacity: 0 });

tween("final-plate-in", ".sr-plate", {
  at: 10.0,
  d: 0.8,
  ease: "expo.out",
  from: { clipPath: "inset(100% 0% 0% 0%)", scale: 1.05, y: 36 },
  to: { clipPath: "inset(0% 0% 0% 0%)", scale: 1, y: 0 }
});

// Two restrained layers at different rates: the page is held in space while the
// scrim breathes across it. `ease: "none"` at different durations = parallax.
tween("final-depth-1", ".sr-plate-img", { at: 10.0, d: 2.3, ease: "none", from: { y: 0, scale: 1 }, to: { y: -26, scale: 1.04 } });
tween("final-depth-2", ".sr-plate-depth", { at: 10.0, d: 2.3, ease: "none", from: { opacity: 0.9 }, to: { opacity: 0.28 } });

text("final-built-a", split("sr-built-a"), {
  at: 10.48,
  d: 0.5,
  each: 0.027,
  from: { yPercent: 82, opacity: 0, rotateX: -58 },
  to: { yPercent: 0, opacity: 1, rotateX: 0 }
});

text("final-built-b", split("sr-built-b"), {
  at: 10.84,
  d: 0.5,
  each: 0.025,
  from: { yPercent: 82, opacity: 0, rotateX: -58 },
  to: { yPercent: 0, opacity: 1, rotateX: 0 }
});

mark("final-beat", ".sr-s-final", 13.9, "final");

// The site recedes, the lockup takes the frame.
tween("final-plate-out", ".sr-plate", { at: 12.38, d: 0.46, ease: "power3.in", from: { scale: 1, y: 0, opacity: 1 }, to: { scale: 0.95, y: -220, opacity: 0 } });
text("final-built-a-out", split("sr-built-a"), { at: 12.4, d: 0.26, each: 0.01, ease: "power2.in", from: { yPercent: 0, opacity: 1 }, to: { yPercent: -44, opacity: 0 } });
text("final-built-b-out", split("sr-built-b"), { at: 12.4, d: 0.26, each: 0.01, ease: "power2.in", from: { yPercent: 0, opacity: 1 }, to: { yPercent: -44, opacity: 0 } });

tween("final-lock-in", ".sr-lockup", { at: 12.54, d: 0.5, ease: "power3.out", from: { opacity: 0 }, to: { opacity: 1 } });

text("final-logo", split("sr-lock-logo"), {
  at: 12.62,
  d: 0.66,
  each: 0.05,
  from: { yPercent: 118, opacity: 0, scale: 1.28 },
  to: { yPercent: 0, opacity: 1, scale: 1 }
});

text("final-tag", split("sr-lock-tag"), {
  at: 12.9,
  d: 0.42,
  split: "words",
  each: 0.05,
  from: { yPercent: 68, opacity: 0 },
  to: { yPercent: 0, opacity: 1 }
});

// The CTA keeps its arrow as real markup, so it animates as one object rather
// than being flattened by the text splitter.
tween("final-cta-in", ".sr-cta", {
  at: 13.28,
  d: 0.5,
  ease: "back.out(1.5)",
  from: { opacity: 0, xPercent: -24, scale: 0.94 },
  to: { opacity: 1, xPercent: 0, scale: 1 }
});

/** The published, validated spec. `saveGsapSpec` re-validates it. */
export function buildSeaiLaunchReel(): GsapSceneSpec {
  return {
    version: 1,
    name: SEAI_REEL_NAME,
    description:
      "SEAI launch reel - 9:16 1080x1920, 15s. Intro, AI build, seven real SEAI demo sites, four pillars into one, finished site, lockup.",
    defaults: { duration: 0.5, ease: "power3.out" },
    ops
  };
}