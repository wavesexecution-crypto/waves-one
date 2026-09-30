/**
 * SEAI launch reel — the 15-second vertical GSAP scene.
 *
 * Authored here (not hand-written JSON) because this is choreography: one
 * deterministic master timeline across six labelled scenes that must land on
 * exact beats. The helpers keep the op list readable while `saveGsapSpec` still
 * runs the real validator, so a bad beat can never reach `.motion/gsap/`.
 *
 * Design contract, enforced by `packages/motion/test/seai-launch-reel.test.ts`:
 *   - one deterministic master timeline, total exactly 15000ms
 *   - six scenes, each carrying a label
 *   - labels mark each scene's COMPOSED read-beat, not its first moving frame
 *   - no `ambient` ops — the reel is finite so it completes, holds, and reverses
 *   - no ScrollTrigger: every parallax is a timeline tween. The conveyor and the
 *     counter-drift use `ease: "none"` (a scrub) at different rates, which is
 *     what real parallax is, and it keeps 15s reproducible inside a paused
 *     timeline. This is why `test_animation` can assert the whole reel without
 *     a browser.
 *   - the final frame is a clean lockup: wordmark, tagline, CTA, and a full
 *     progress rail — which is also the reduced-motion frame
 *
 * Story map (seconds):
 *   01 HOOK      0.00 – 2.00   black, the statement slams in
 *   02 CLAIM     2.00 – 4.00   statement breaks apart, two answers
 *   03 WORK      4.00 – 7.00   four built sites on a masked conveyor
 *   04 SYSTEM    7.00 – 10.00  four pillars collapse into one
 *   05 RESULT   10.00 – 12.50  one finished site, full bleed
 *   06 LOCKUP   12.50 – 15.00  wordmark, positioning, CTA, hold
 */

import type { GsapOp, GsapSceneSpec, GsapVars } from "./spec";

export const SEAI_REEL_NAME = "seai-launch-reel";
export const SEAI_REEL_MS = 15000;
export const SEAI_REEL_W = 1080;
export const SEAI_REEL_H = 1920;

/** The reel's only real width/height reference. `GsapSceneSpec` deliberately has
 *  no geometry — the artboard owns it — so the exporter and the stage read this. */
export const SEAI_REEL_ORIENTATION = "vertical" as const;

/** Scene labels double as the reduced-motion stepper's scene list. */
export const SEAI_REEL_SCENES = [
  { label: "01 HOOK", at: 1.5 },
  { label: "02 CLAIM", at: 3.9 },
  { label: "03 WORK", at: 5.3 },
  { label: "04 SYSTEM", at: 8.15 },
  { label: "05 RESULT", at: 11.75 },
  { label: "06 LOCKUP", at: 13.85 }
] as const;

/** Every split line in the stage markup is addressed by its data-split key, so
 *  a copy edit that reorders the markup cannot silently re-target an op. */
const split = (key: string): string => `[data-split="${key}"]`;
const card = (index: number): string => `.sr-card:nth-child(${index})`;
const depth = (level: number): string => `[data-depth="${level}"]`;

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
  /** Defaults to "chars"; the tagline splits on words. */
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
 * A beat marker. Carries a scene label and writes one inert custom property, so
 * a reduced-motion step lands on a finished frame instead of a half-played
 * transition — without inventing motion that the choreography does not have.
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
// Persistent chrome
// ---------------------------------------------------------------------------

/**
 * The progress rail is a real read of the master timeline: a 15.000s linear
 * tween from scaleX 0 to 1. It is also what pins `planTimeline().totalMs` to
 * exactly 15000 — the last frame of the reel is the bar arriving at full.
 */
tween("progress-rail", ".sr-progress", { at: 0, d: SEAI_REEL_MS / 1000, ease: "none", from: { scaleX: 0 }, to: { scaleX: 1 } });

// ---------------------------------------------------------------------------
// 01 HOOK — 0.00 / 2.00
// ---------------------------------------------------------------------------

set("s1-on", ".sr-s1", { opacity: 1 });
set("s1-kicker", ".sr-kicker", { opacity: 0, y: 40 });
set("s1-rule", ".sr-underline", { scaleX: 0 });

tween("s1-kicker-in", ".sr-kicker", { at: 0.1, d: 0.5, ease: "power2.out", from: { opacity: 0, y: 40 }, to: { opacity: 1, y: 0 } });

// A slam, not a fade: the line drops from above on a 3D plane, overshoots its
// final scaleY, and settles. rotateX needs the parent's perspective to read.
text("s1-hook-a", split("sr-hook-a"), {
  at: 0.16,
  d: 0.62,
  each: 0.026,
  from: { yPercent: -130, opacity: 0, rotateX: 82, scaleY: 1.4 },
  to: { yPercent: 0, opacity: 1, rotateX: 0, scaleY: 1 }
});

text("s1-hook-b", split("sr-hook-b"), {
  at: 0.52,
  d: 0.58,
  each: 0.022,
  from: { yPercent: -110, opacity: 0, rotateX: 70, xPercent: -12 },
  to: { yPercent: 0, opacity: 1, rotateX: 0, xPercent: 0 }
});

tween("s1-rule-in", ".sr-underline", { at: 0.86, d: 0.5, ease: "power3.out", from: { scaleX: 0 }, to: { scaleX: 1 } });

mark("s1-beat", ".sr-s1", 1.5, "01 HOOK");

// ---------------------------------------------------------------------------
// 02 CLAIM — 2.00 / 4.00
// ---------------------------------------------------------------------------

set("s2-on", ".sr-s2", { opacity: 1 }, 1.98);
set("s2-rule", ".sr-underline-wide", { scaleX: 0 }, 1.98);

// The statement breaks apart: both lines leave on the same beat, on different
// axes, so the two answers that follow read as one continuous motion rather
// than three separate events.
text("s1-break-a", split("sr-hook-a"), {
  at: 2.0,
  d: 0.3,
  each: 0.01,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, rotateX: 0, scaleY: 1 },
  to: { yPercent: -80, opacity: 0, rotateX: -55, scaleY: 0.82 }
});

text("s1-break-b", split("sr-hook-b"), {
  at: 2.06,
  d: 0.3,
  each: 0.01,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, rotateX: 0, xPercent: 0 },
  to: { xPercent: 95, opacity: 0, rotateY: -60 }
});

tween("s1-rule-out", ".sr-underline", { at: 2.0, d: 0.28, ease: "power2.in", from: { scaleX: 1 }, to: { scaleX: 0 } });
tween("s1-kicker-out", ".sr-kicker", { at: 2.02, d: 0.26, ease: "power2.in", from: { opacity: 1, y: 0 }, to: { opacity: 0, y: -30 } });

text("s2-claim-a", split("sr-claim-a"), {
  at: 2.52,
  d: 0.56,
  each: 0.03,
  from: { yPercent: 115, opacity: 0, rotateX: -74, scaleY: 1.24 },
  to: { yPercent: 0, opacity: 1, rotateX: 0, scaleY: 1 }
});

text("s2-claim-out", split("sr-claim-a"), {
  at: 3.1,
  d: 0.24,
  each: 0.008,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, xPercent: 0 },
  to: { xPercent: 78, opacity: 0, rotateY: 52 }
});

text("s2-claim-b", split("sr-claim-b"), {
  at: 3.22,
  d: 0.46,
  each: 0.03,
  from: { yPercent: 120, opacity: 0, rotateZ: -8, scale: 0.82 },
  to: { yPercent: 0, opacity: 1, rotateZ: 0, scale: 1 }
});

tween("s2-rule-in", ".sr-underline-wide", { at: 3.42, d: 0.4, ease: "power3.out", from: { scaleX: 0 }, to: { scaleX: 1 } });

mark("s2-beat", ".sr-s2", 3.9, "02 CLAIM");

// ---------------------------------------------------------------------------
// 03 WORK — 4.00 / 7.00
// ---------------------------------------------------------------------------

set("s3-on", ".sr-s3", { opacity: 1 }, 4.14);
set("s3-tag", ".sr-scene-tag", { opacity: 0, x: -40 }, 4.14);

text("s2-out-a", split("sr-claim-a"), {
  at: 3.98,
  d: 0.26,
  each: 0.008,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, xPercent: 0 },
  to: { xPercent: 80, opacity: 0, rotateY: 50 }
});

text("s2-out-b", split("sr-claim-b"), {
  at: 3.98,
  d: 0.24,
  each: 0.008,
  ease: "power3.in",
  from: { yPercent: 0, opacity: 1, rotateZ: 0, scale: 1 },
  to: { yPercent: 64, opacity: 0, scale: 0.9 }
});

tween("s2-rule-out", ".sr-underline-wide", { at: 3.98, d: 0.24, ease: "power2.in", from: { scaleX: 1 }, to: { scaleX: 0 } });

// Four cards, each masked by the rail's overflow and revealed by clipPath. The
// clip is what sells it as a viewport the sites are riding through.
for (let i = 1; i <= 4; i += 1) {
  set(`s3-card-set-${i}`, card(i), { opacity: 0, clipPath: "inset(100% 0% 0% 0%)", y: 90, scale: 0.94 }, 4.14);
}

stagger("s3-cards-in", ".sr-card", {
  at: 4.2,
  d: 0.62,
  each: 0.13,
  ease: "expo.out",
  from: { opacity: 0, clipPath: "inset(100% 0% 0% 0%)", y: 90, scale: 0.94 },
  to: { opacity: 1, clipPath: "inset(0% 0% 0% 0%)", y: 0, scale: 1 }
});

tween("s3-tag-in", ".sr-scene-tag", { at: 4.2, d: 0.5, ease: "power3.out", from: { opacity: 0, x: -40 }, to: { opacity: 1, x: 0 } });

// The conveyor: one linear travel of the whole rail. Ease "none" is a scrub —
// this is the reel's structural motion, and it is what the four counter-drifts
// below are measured against.
tween("s3-conveyor", ".sr-rail", { at: 4.25, d: 2.3, ease: "none", from: { y: 0 }, to: { y: -1560 } });

// Real parallax = the same travel, different rates, per layer. Four cards on
// four drift rates is what gives the stack depth instead of a flat scroll.
const DRIFT = [34, -26, 18, -40];
for (let i = 1; i <= 4; i += 1) {
  tween(`s3-drift-${i}`, card(i), {
    at: 4.25,
    d: 2.3,
    ease: "none",
    from: { x: 0 },
    to: { x: DRIFT[i - 1] }
  });
}

mark("s3-beat", ".sr-s3", 5.3, "03 WORK");

tween("s3-out", ".sr-rail", { at: 6.55, d: 0.4, ease: "power2.in", from: { y: -1560 }, to: { y: -2020, opacity: 0 } });
tween("s3-tag-out", ".sr-scene-tag", { at: 6.5, d: 0.3, ease: "power2.in", from: { opacity: 1, x: 0 }, to: { opacity: 0, x: -30 } });

// ---------------------------------------------------------------------------
// 04 SYSTEM — 7.00 / 10.00
// ---------------------------------------------------------------------------

set("s4-on", ".sr-s4", { opacity: 1 }, 6.94);

// Four pillars arrive fast and precise, alternating entry axis so the block
// reads as a list being dealt rather than four separate events.
const PILLARS = ["sr-p1", "sr-p2", "sr-p3", "sr-p4"] as const;
PILLARS.forEach((key, index) => {
  const fromLeft = index % 2 === 0;
  text(`s4-${key}`, split(key), {
    at: 7.0 + index * 0.26,
    d: 0.3,
    each: 0.022,
    ease: "power4.out",
    from: fromLeft ? { xPercent: -70, opacity: 0, skewX: 16 } : { xPercent: 70, opacity: 0, skewX: -16 },
    to: { xPercent: 0, opacity: 1, skewX: 0 }
  });
});

mark("s4-beat", ".sr-s4", 8.15, "04 SYSTEM");

// A single precise pulse on the last word — the only flourish in the scene.
tween("s4-seo-pulse", split("sr-p4"), { at: 8.2, d: 0.18, ease: "power2.out", from: { scale: 1 }, to: { scale: 1.05 } });
tween("s4-seo-settle", split("sr-p4"), { at: 8.42, d: 0.22, ease: "power2.inOut", from: { scale: 1.05 }, to: { scale: 1 } });

// The collapse. Scaling the pillars alone would leave them spread down the
// frame, so each is pulled to the centre as well — that is what makes the four
// read as collapsing INTO one thing rather than just shrinking.
stagger("s4-collapse", ".sr-pillar", {
  at: 8.9,
  d: 0.5,
  each: 0.035,
  origin: "center",
  ease: "power3.inOut",
  from: { scale: 1, opacity: 1 },
  to: { scale: 0.14, opacity: 0 }
});

const PULL = [223, 74, -74, -223];
PILLARS.forEach((key, index) => {
  tween(`s4-pull-${index + 1}`, split(key), {
    at: 8.9,
    d: 0.5,
    ease: "power3.inOut",
    from: { y: 0 },
    to: { y: PULL[index] }
  });
});

text("s4-one", split("sr-one"), {
  at: 9.0,
  d: 0.62,
  each: 0.03,
  from: { scale: 0.18, opacity: 0, letterSpacing: "0.24em", rotateX: -50 },
  to: { scale: 1, opacity: 1, letterSpacing: "-0.035em", rotateX: 0 }
});

tween("s4-one-out", split("sr-one"), { at: 9.85, d: 0.28, ease: "power2.in", from: { yPercent: 0, opacity: 1, scale: 1 }, to: { yPercent: -50, opacity: 0, scale: 0.94 } });

// ---------------------------------------------------------------------------
// 05 RESULT — 10.00 / 12.50
// ---------------------------------------------------------------------------

set("s5-on", ".sr-s5", { opacity: 1 }, 9.94);
set("s5-site", ".sr-site", { clipPath: "inset(100% 0% 0% 0%)", scale: 1.06, y: 40 }, 9.94);

tween("s5-site-in", ".sr-site", {
  at: 10.0,
  d: 0.8,
  ease: "expo.out",
  from: { clipPath: "inset(100% 0% 0% 0%)", scale: 1.06, y: 40 },
  to: { clipPath: "inset(0% 0% 0% 0%)", scale: 1, y: 0 }
});

// Four layers inside the finished site, four different drift rates over the
// scene's own length. This is the reel's subtler parallax: the page feels held
// in space while the copy breathes across it.
const DEPTH_DRIFT: Array<[number, string, number]> = [
  [1, "y", -20],
  [2, "y", 16],
  [3, "y", -11],
  [4, "x", 44]
];
for (const [level, axis, amount] of DEPTH_DRIFT) {
  tween(`s5-depth-${level}`, depth(level), {
    at: 10.0,
    d: 2.3,
    ease: "none",
    from: { [axis]: 0 },
    to: { [axis]: amount }
  });
}

text("s5-built-a", split("sr-built-a"), {
  at: 10.5,
  d: 0.5,
  each: 0.028,
  from: { yPercent: 80, opacity: 0, rotateX: -60 },
  to: { yPercent: 0, opacity: 1, rotateX: 0 }
});

text("s5-built-b", split("sr-built-b"), {
  at: 10.86,
  d: 0.5,
  each: 0.026,
  from: { yPercent: 80, opacity: 0, rotateX: -60 },
  to: { yPercent: 0, opacity: 1, rotateX: 0 }
});

mark("s5-beat", ".sr-s5", 11.75, "05 RESULT");

// ---------------------------------------------------------------------------
// 06 LOCKUP — 12.50 / 15.00
// ---------------------------------------------------------------------------

set("s6-on", ".sr-s6", { opacity: 1 }, 12.54);
set("s6-cta", ".sr-cta", { opacity: 0, xPercent: -26, scale: 0.92 }, 12.54);

tween("s5-site-out", ".sr-site", { at: 12.4, d: 0.45, ease: "power3.in", from: { scale: 1, y: 0, opacity: 1 }, to: { scale: 0.94, y: -240, opacity: 0 } });
text("s5-built-a-out", split("sr-built-a"), { at: 12.42, d: 0.28, each: 0.01, ease: "power2.in", from: { yPercent: 0, opacity: 1 }, to: { yPercent: -46, opacity: 0 } });
text("s5-built-b-out", split("sr-built-b"), { at: 12.42, d: 0.28, each: 0.01, ease: "power2.in", from: { yPercent: 0, opacity: 1 }, to: { yPercent: -46, opacity: 0 } });

text("s6-logo", split("sr-logo"), {
  at: 12.6,
  d: 0.7,
  each: 0.05,
  from: { yPercent: 115, opacity: 0, scale: 1.35 },
  to: { yPercent: 0, opacity: 1, scale: 1 }
});

text("s6-tag", split("sr-tag"), {
  at: 12.9,
  d: 0.42,
  split: "words",
  each: 0.05,
  from: { yPercent: 70, opacity: 0 },
  to: { yPercent: 0, opacity: 1 }
});

// The CTA keeps its arrow as real markup, so it animates as one object rather
// than being flattened by the text splitter.
tween("s6-cta-in", ".sr-cta", { at: 13.3, d: 0.5, ease: "back.out(1.6)", from: { opacity: 0, xPercent: -26, scale: 0.92 }, to: { opacity: 1, xPercent: 0, scale: 1 } });

mark("s6-beat", ".sr-s6", 13.85, "06 LOCKUP");

/** The published, validated spec. `saveGsapSpec` still re-validates it. */
export function buildSeaiLaunchReel(): GsapSceneSpec {
  return {
    version: 1,
    name: SEAI_REEL_NAME,
    description:
      "SEAI launch reel — 9:16 1080x1920, 15s. Hook, claim, four built sites, four pillars collapsing into one, one finished site, lockup.",
    defaults: { duration: 0.5, ease: "power3.out" },
    ops
  };
}
